"""Pipeline A: full-duplex moderator using an ElevenLabs Conversational AI
Agent, with Claude selected as its native LLM.

Replaces the earlier push-to-talk + Whisper STT + raw-TTS script.
ElevenLabs' own agent runtime now handles ASR, turn-taking, calling Claude,
and TTS as one hosted loop -- we just bridge real mic/speaker audio to it
and log the resulting transcript. Nothing here needs a public endpoint;
we connect out to ElevenLabs like an ordinary client.

Caveat: since Claude is called by ElevenLabs' own runtime (not by our code
the way GPT-Live's client delegation works), the per-turn pacing note that
common/moderator.py normally injects dynamically isn't part of the agent's
system prompt -- it's sent periodically as a "contextual_update" message
instead (see pacing_updates() below). That mechanism is unverified against
a live agent as of this writing; if pacing doesn't seem to influence
behavior, check https://elevenlabs.io/docs/eleven-agents for whatever the
current equivalent is.

Usage:
    python -m pipelines.elevenlabs_claude.run
"""
import asyncio
import base64
import json
import os
import sys
from pathlib import Path

import numpy as np
import sounddevice as sd
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from common.elevenlabs_agent import AgentSession, get_or_create_agent
from common.interview_guide import CLOSING_SCRIPT, OPENING_SCRIPT
from common.moderator import SYSTEM_PROMPT as MODERATOR_SYSTEM_PROMPT
from common.moderator import _pacing_note
from common.transcript_log import Clock, SessionLog, Turn

load_dotenv()

CHUNK_MS = 100
PACING_UPDATE_SECONDS = 30


async def run() -> None:
    print("=== Pipeline A: ElevenLabs Agent (Claude as native LLM) ===")
    log = SessionLog(
        pipeline="elevenlabs_claude", meta={"model": os.environ.get("MODERATOR_MODEL", "claude-sonnet-5")}
    )
    clock = Clock()
    stop_event = asyncio.Event()
    closing_pending = False

    print("Creating/connecting to your ElevenLabs moderator agent...")
    agent_id = get_or_create_agent(
        cache_key="moderator_v1",
        name="Voice Qual Moderator",
        system_prompt=MODERATOR_SYSTEM_PROMPT,
        first_message=OPENING_SCRIPT,
        voice_id=os.environ["ELEVENLABS_VOICE_ID"],
        llm_model=os.environ.get("MODERATOR_MODEL", "claude-sonnet-5"),
        tts_model_id=os.environ.get("ELEVENLABS_TTS_MODEL_ID", "eleven_flash_v2"),
    )
    agent = AgentSession(agent_id)
    await agent.connect()

    loop = asyncio.get_event_loop()
    mic_stream = None
    out_stream = None

    async def pacing_updates() -> None:
        while not stop_event.is_set():
            await asyncio.sleep(PACING_UPDATE_SECONDS)
            try:
                await agent.ws.send(json.dumps({"type": "contextual_update", "text": _pacing_note(clock.now())}))
            except Exception:
                pass

    async def delayed_close() -> None:
        await asyncio.sleep(1.0)
        await agent.close()

    pacing_task = asyncio.create_task(pacing_updates())

    try:
        async for event in agent.events():
            etype = event.get("type")

            if etype == "conversation_initiation_metadata":
                print(f"[connected] input={agent.input_sample_rate}Hz output={agent.output_sample_rate}Hz")
                print("Speak whenever you're ready — press Ctrl+C to end.\n")

                def mic_callback(indata, _frames, _time_info, _status):
                    asyncio.run_coroutine_threadsafe(agent.send_audio_chunk(indata.tobytes()), loop)

                mic_stream = sd.InputStream(
                    samplerate=agent.input_sample_rate,
                    channels=1,
                    dtype="int16",
                    blocksize=int(agent.input_sample_rate * CHUNK_MS / 1000),
                    callback=mic_callback,
                )
                out_stream = sd.OutputStream(samplerate=agent.output_sample_rate, channels=1, dtype="int16")
                mic_stream.start()
                out_stream.start()

            elif etype == "audio" and out_stream is not None:
                raw = base64.b64decode(event["audio_event"]["audio_base_64"])
                out_stream.write(np.frombuffer(raw, dtype="int16"))
                if closing_pending and event["audio_event"].get("is_final"):
                    asyncio.create_task(delayed_close())

            elif etype == "user_transcript":
                text = event["user_transcription_event"]["user_transcript"]
                t = clock.now()
                print(f"PARTICIPANT: {text}")
                log.add_turn(Turn("participant", text, t, t))

            elif etype == "agent_response":
                text = event["agent_response_event"]["agent_response"]
                t = clock.now()
                print(f"MODERATOR: {text}")
                log.add_turn(Turn("moderator", text, t, t))
                if text.strip() == CLOSING_SCRIPT.strip():
                    closing_pending = True

            elif etype == "interruption":
                print("[interrupted]")

    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        pacing_task.cancel()
        if mic_stream is not None:
            mic_stream.stop()
            mic_stream.close()
        if out_stream is not None:
            out_stream.stop()
            out_stream.close()
        await agent.close()
        path = log.save()
        print(f"\nSession saved to {path}")


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
