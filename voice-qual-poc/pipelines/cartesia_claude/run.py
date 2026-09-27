"""Pipeline B: full-duplex moderator using a Cartesia Managed Agent, with a
Claude model from Cartesia's LLM catalog.

The Cartesia counterpart of pipelines/elevenlabs_claude/run.py: Cartesia's
hosted runtime handles ASR (Ink-2), turn-taking, calling the LLM, and TTS
(Sonic) as one loop -- we just bridge real mic/speaker audio to it and log
the resulting transcript in the same schema as Pipeline A. Nothing here
needs a public endpoint; we connect out to Cartesia like an ordinary
client.

Differences from Pipeline A worth knowing when comparing the two:

- Cartesia hosts the LLM itself (no Anthropic key involved), so the model
  has to be one Cartesia offers -- `python -m pipelines.cartesia_claude.run
  --list-models` prints the catalog. If it doesn't include the Claude model
  Pipeline A uses, pick the same model on both sides (e.g. switch
  MODERATOR_MODEL to Haiku for the ElevenLabs run) or the comparison
  measures the LLM as well as the voice layer.
- Pacing: Cartesia has no mid-call "contextual_update" message. Instead the
  pacing rules are baked into the agent's instructions against two dynamic
  variables -- {{interview_started_utc}} (sent by us in session_create) and
  {{system__time_utc}} (filled in by Cartesia, re-rendered before every
  reply) -- so the model gets a fresh time check each turn, the same way
  common/moderator.py's _pacing_note() works. Unverified against a live
  agent as of this writing.
- Ending: the agent has Cartesia's end_call system tool and hangs up by
  itself after the closing line; the server closing the socket ends the run.

Usage:
    python -m pipelines.cartesia_claude.run
    python -m pipelines.cartesia_claude.run --list-models
"""
import asyncio
import base64
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import sounddevice as sd
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
load_dotenv()

from common.cartesia_agent import AgentSession, get_or_create_agent, list_models
from common.interview_guide import OPENING_SCRIPT, TARGET_DURATION_MINUTES
from common.moderator import SYSTEM_PROMPT as MODERATOR_SYSTEM_PROMPT
from common.transcript_log import Clock, SessionLog, Turn

CHUNK_MS = 50  # Cartesia recommends 20-100ms input chunks
SAMPLE_RATE = 16000
DEFAULT_LLM = "claude-haiku-4.5"
# One of the voice IDs used in Cartesia's own agent docs; browse
# https://play.cartesia.ai/voices and set CARTESIA_VOICE_ID to change it.
DEFAULT_VOICE_ID = "e07c00bc-4134-4eae-9ea4-1a55fb45746b"

PACING_BLOCK = f"""

TIME CHECK (never read aloud): the interview started at {{{{interview_started_utc}}}} and it is now {{{{system__time_utc}}}}. The target length is {TARGET_DURATION_MINUTES} minutes. Before each reply, work out how many minutes remain:
- 2 or fewer: time is essentially up. Skip remaining probes and deliver the closing line now, even if the guide isn't fully covered.
- 6 or fewer: time is running short. Prioritize topics not yet touched over further probing on ones already covered.
- otherwise: no pacing concern yet, proceed normally.
After you have spoken the closing line, end the call."""


class Player:
    """Callback-driven speaker output with a clearable buffer, so barge-in
    (audio_output_clear) can drop queued agent audio immediately instead of
    waiting for a blocking write to drain."""

    def __init__(self, sample_rate: int):
        self._buf = bytearray()
        self._lock = threading.Lock()
        self.stream = sd.OutputStream(
            samplerate=sample_rate, channels=1, dtype="int16", callback=self._callback
        )

    def _callback(self, outdata, frames, _time_info, _status):
        needed = frames * 2
        with self._lock:
            chunk = bytes(self._buf[:needed])
            del self._buf[:needed]
        chunk += b"\x00" * (needed - len(chunk))
        outdata[:, 0] = np.frombuffer(chunk, dtype=np.int16)

    def write(self, pcm: bytes) -> None:
        with self._lock:
            self._buf.extend(pcm)

    def clear(self) -> None:
        with self._lock:
            self._buf.clear()


async def run() -> None:
    llm_model = os.environ.get("CARTESIA_LLM_MODEL", DEFAULT_LLM)
    print("=== Pipeline B: Cartesia Managed Agent (Claude via Cartesia) ===")
    log = SessionLog(pipeline="cartesia_claude", meta={"model": llm_model})
    clock = Clock()

    print("Creating/connecting to your Cartesia moderator agent...")
    agent_id = get_or_create_agent(
        cache_key=f"moderator_v1:{llm_model}",
        name="Voice Qual Moderator",
        instructions=MODERATOR_SYSTEM_PROMPT + PACING_BLOCK,
        initial_message=OPENING_SCRIPT,
        voice_id=os.environ.get("CARTESIA_VOICE_ID", DEFAULT_VOICE_ID),
        llm_model=llm_model,
        # Only used by Playground test calls; real sessions send the actual value.
        dynamic_variable_placeholders={"interview_started_utc": "2026-01-01T00:00:00Z"},
    )
    agent = AgentSession(agent_id, sample_rate=SAMPLE_RATE)
    started_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    await agent.connect(dynamic_variables={"interview_started_utc": started_utc})

    loop = asyncio.get_running_loop()
    mic_stream = None
    player = None
    # For latency_ms: local time the participant's finalized turn arrived,
    # cleared once the first agent audio after it plays. This excludes
    # Cartesia's endpointing delay (time between you stopping and it deciding
    # your turn is over), so it's a lower bound on perceived latency.
    awaiting_reply_since: float | None = None
    pending_latency_ms: float | None = None

    try:
        async for event in agent.events():
            etype = event.get("type")

            if etype == "session_ready":
                log.meta.update(call_id=agent.call_id, agent_id=agent_id,
                                agent_version_id=event.get("agent_version_id"))
                print(f"[connected] call_id={agent.call_id} audio=pcm_{SAMPLE_RATE}")
                print("Speak whenever you're ready — press Ctrl+C to end.\n")

                def mic_callback(indata, _frames, _time_info, _status):
                    asyncio.run_coroutine_threadsafe(agent.send_audio_chunk(indata.tobytes()), loop)

                mic_stream = sd.InputStream(
                    samplerate=SAMPLE_RATE,
                    channels=1,
                    dtype="int16",
                    blocksize=int(SAMPLE_RATE * CHUNK_MS / 1000),
                    callback=mic_callback,
                )
                player = Player(SAMPLE_RATE)
                mic_stream.start()
                player.stream.start()

            elif etype == "audio_output" and player is not None:
                if awaiting_reply_since is not None:
                    pending_latency_ms = (clock.now() - awaiting_reply_since) * 1000
                    awaiting_reply_since = None
                player.write(base64.b64decode(event["audio"]))

            elif etype == "audio_output_clear":
                if player is not None:
                    player.clear()

            elif etype == "turn_ended":
                text = event.get("text", "")
                # Cartesia's own session-relative timestamps, not our clock.
                t_start, t_end = event.get("start_time", 0.0), event.get("end_time", 0.0)
                if event.get("role") == "user":
                    print(f"PARTICIPANT: {text}")
                    log.add_turn(Turn("participant", text, t_start, t_end))
                    awaiting_reply_since = clock.now()
                else:
                    suffix = " [interrupted]" if event.get("interrupted") else ""
                    print(f"MODERATOR: {text}{suffix}")
                    log.add_turn(Turn("moderator", text, t_start, t_end, latency_ms=pending_latency_ms))
                    pending_latency_ms = None

            elif etype == "client_tool_call":
                print(f"[unexpected client tool call: {event.get('tool_name')}]")

            elif etype == "error":
                print(f"[cartesia error] {event.get('code')}: {event.get('message')} (fatal={event.get('fatal')})")

        print("\n[call ended by agent]")

    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        if mic_stream is not None:
            mic_stream.stop()
            mic_stream.close()
        if player is not None:
            # Let the tail of the closing line finish playing.
            await asyncio.sleep(1.0)
            player.stream.stop()
            player.stream.close()
        await agent.close()
        path = log.save()
        print(f"\nSession saved to {path}")
        if agent.call_id:
            print(f"Cartesia call record (transcript + audio): Playground -> Agents -> Calls -> {agent.call_id}")


def print_models() -> None:
    for m in sorted(list_models(), key=lambda m: (m["provider"], m["id"])):
        latency = m.get("average_latency_ms")
        pricing = m.get("pricing") or {}
        print(
            f"{m['id']:<32} {m['provider']:<12} "
            f"{(str(latency) + 'ms') if latency is not None else '?':>8}  "
            f"in ${pricing.get('input_per_million_tokens', '?')}/M  out ${pricing.get('output_per_million_tokens', '?')}/M"
        )


def main() -> None:
    if "--list-models" in sys.argv:
        print_models()
        return
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
