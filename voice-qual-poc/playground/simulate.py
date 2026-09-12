"""Two-bot simulation: GPT-Live (interviewer, same real pipeline as
pipelines/gpt_live/run.py) talks to an ElevenLabs Conversational AI Agent
(the respondent persona, with Claude as its natively-selected LLM) instead
of a human on a microphone. Both sides are real voice agents bridged by
forwarding each one's audio output to the other's audio input in real
time -- neither side needs our own "has it stopped talking" heuristics,
since each agent does its own turn-detection on the (resampled) audio it
actually hears from the other.

Deliberately duplicates pipelines/gpt_live/run.py's session/delegation
logic rather than sharing it -- the two scripts' audio I/O differs enough
that a shared abstraction wasn't worth the risk while this is still being
actively tuned. If that settles down, factoring the common event-loop
pattern into common/ would be a reasonable follow-up.

Design choice worth knowing: Claude (the moderator brain) is fed the
respondent's *ground-truth* text from the agent's own agent_response
events, not GPT-Live's ASR reconstruction of it -- this isolates "how
does GPT-Live behave" from "how good is its ASR," which are different
questions. GPT-Live's own ASR output is still captured in the debug log /
raw transcript for comparison if you want to check transcription
accuracy separately.

Usage:
    python -m playground.simulate                 # one run, prints to console
    python -m playground.simulate --n 5           # 5 runs back to back
    python -m playground.simulate --minutes 3     # override the time cap
"""
import argparse
import asyncio
import base64
import json
import os
import wave
from pathlib import Path

import numpy as np
import websockets
from dotenv import load_dotenv

from common.elevenlabs_agent import AgentSession, get_or_create_agent, resample_pcm16
from common.gpt_live_protocol import (
    CHUNK_MS,
    CHUNK_SAMPLES,
    INSTRUCTIONS_TEMPLATE,
    MODEL,
    SAMPLE_RATE,
    VOICE,
    WS_URL,
    TranscriptBuffer,
    delegation_stall_watchdog,
    log_raw_event,
)
from common.interview_guide import CLOSING_SCRIPT, STUDY_TOPIC
from common.moderator import next_utterance
from common.respondent import SYSTEM_PROMPT as RESPONDENT_SYSTEM_PROMPT
from common.transcript_log import TRANSCRIPTS_DIR, Clock, SessionLog, Turn

load_dotenv()

PLAYGROUND_DIR = TRANSCRIPTS_DIR / "playground"
DEFAULT_MAX_MINUTES = 5.0

CHUNK_BYTES = CHUNK_SAMPLES * 2  # int16 -> 2 bytes/sample


async def _default_emit(event: dict) -> None:
    if event["type"] == "turn":
        print(f"{event['role'].upper()}: {event['text']}")
    elif event["type"] in ("info", "error"):
        print(f"[{event['type']}] {event['text']}")


async def _stream_audio(ws, pcm_bytes: bytes) -> None:
    for i in range(0, len(pcm_bytes), CHUNK_BYTES):
        chunk = pcm_bytes[i : i + CHUNK_BYTES]
        await ws.send(
            json.dumps(
                {
                    "type": "session.input_audio.append",
                    "audio": base64.b64encode(chunk).decode("ascii"),
                }
            )
        )
        await asyncio.sleep(CHUNK_MS / 1000)


def _save_wav(path: Path, pcm_bytes: bytes) -> None:
    if not pcm_bytes:
        return
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)


def _mix_chunks(duration_s: float, *chunk_lists: list[tuple[float, bytes]]) -> bytes:
    """Lays each (t_offset, pcm16_bytes) chunk into one shared timeline at
    its real capture time and sums overlapping samples (clipped) -- a
    proper single-track "call recording" rather than one file per speaker
    concatenated with no regard for timing or overlap. Overlaps (e.g. a
    real interruption) are audible as such, which is useful in its own right."""
    total_samples = int(duration_s * SAMPLE_RATE) + SAMPLE_RATE  # pad a bit
    mix = np.zeros(total_samples, dtype=np.int32)
    for chunks in chunk_lists:
        for t_offset, raw in chunks:
            start = max(int(t_offset * SAMPLE_RATE), 0)
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.int32)
            end = start + len(samples)
            if end > len(mix):
                mix = np.concatenate([mix, np.zeros(end - len(mix), dtype=np.int32)])
            mix[start:end] += samples
    return np.clip(mix, -32768, 32767).astype(np.int16).tobytes()


async def run_session(max_minutes: float = DEFAULT_MAX_MINUTES, on_event=None) -> dict:
    emit = on_event or _default_emit

    PLAYGROUND_DIR.mkdir(parents=True, exist_ok=True)
    log = SessionLog(pipeline="gpt_live_simulated", meta={"model": MODEL, "voice": VOICE})
    clock = Clock()
    transcript: list[dict] = []  # fed to Claude, same shape as the human pipeline
    pending_respondent_utterances: list[str] = []
    buf = TranscriptBuffer()
    moderator_chunks: list[tuple[float, bytes]] = []  # (t_offset, pcm16 bytes)
    respondent_chunks: list[tuple[float, bytes]] = []

    debug_log = PLAYGROUND_DIR / f"sim_debug_{int(log.started_at)}.jsonl"
    transcript_path = PLAYGROUND_DIR / f"sim_{int(log.started_at)}.json"

    headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}
    state = {
        "last_audio_time": clock.now(),
        "last_transcript_time": clock.now(),
        "last_delegation_time": clock.now(),
        "closing": False,
        "respondent_speaking": False,
    }
    stop_event = asyncio.Event()
    delegation_count = 0
    ended_reason = "unknown"

    await emit({"type": "info", "text": "creating/connecting ElevenLabs respondent agent..."})
    agent_id = get_or_create_agent(
        cache_key="respondent_v1",
        name="Synthetic Respondent",
        system_prompt=RESPONDENT_SYSTEM_PROMPT,
        first_message="",  # waits for the moderator to speak first
        voice_id=os.environ["ELEVENLABS_RESPONDENT_VOICE_ID"],
        llm_model=os.environ.get("RESPONDENT_MODEL", "claude-sonnet-5"),
        tts_model_id=os.environ.get("ELEVENLABS_TTS_MODEL_ID", "eleven_flash_v2"),
    )
    agent_session = AgentSession(agent_id)
    await agent_session.connect()

    await emit({"type": "info", "text": "connecting to GPT-Live..."})

    async with websockets.connect(WS_URL, additional_headers=headers) as ws:
        session_start = {
            "type": "session.start",
            "event_id": "event_start",
            "session": {
                "model": MODEL,
                "instructions": INSTRUCTIONS_TEMPLATE.substitute(study_topic=STUDY_TOPIC),
                "audio": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    "output": {"voice": VOICE},
                },
                "delegation": {"type": "client"},
            },
        }
        await ws.send(json.dumps(session_start))
        log_raw_event(debug_log, "send", session_start)

        async def speak(content: str, delegation_id, t_ref: float) -> None:
            t_reply = clock.now()
            transcript.append({"role": "moderator", "text": content})
            append_event = {
                "type": "session.commentary.append",
                "event_id": f"reply_{int(t_reply * 1000)}",
                "delegation_id": delegation_id,
                "content": content,
            }
            await ws.send(json.dumps(append_event))
            log_raw_event(debug_log, "send", append_event)
            log.add_turn(Turn("moderator", content, t_ref, t_reply, latency_ms=(t_reply - t_ref) * 1000))
            await emit({"type": "turn", "role": "moderator", "text": content, "t": t_reply})

            if content.strip() == CLOSING_SCRIPT.strip():
                state["closing"] = True
                asyncio.create_task(close_after_speaking())

        async def send_opening() -> None:
            t0 = clock.now()
            opening = await asyncio.to_thread(next_utterance, [])
            await speak(opening, None, t0)

        async def handle_delegation(delegation_id: str, t_delegated: float) -> None:
            nonlocal delegation_count
            delegation_count += 1

            own_speech = buf.pending_moderator_text()
            if own_speech:
                note = f"[spoken by the voice layer on its own, not authored by you]: {own_speech}"
                transcript.append({"role": "moderator", "text": note})
                log.add_turn(Turn("moderator", note, t_delegated, t_delegated))
                buf.mark_moderator_consumed()

            if pending_respondent_utterances:
                pending_text = " ".join(pending_respondent_utterances)
                pending_respondent_utterances.clear()
                transcript.append({"role": "participant", "text": pending_text})
                log.add_turn(Turn("participant", pending_text, t_delegated, t_delegated))

            try:
                reply = await asyncio.to_thread(next_utterance, transcript, elapsed_seconds=t_delegated)
                if not reply.strip():
                    reply = await asyncio.to_thread(next_utterance, transcript, elapsed_seconds=t_delegated)
            except Exception as e:
                await emit({"type": "error", "text": f"moderator brain error: {e!r}"})
                reply = ""
            if not reply.strip():
                reply = "Sorry, could you say that again?"
            await speak(reply, delegation_id, t_delegated)

        async def close_after_speaking() -> None:
            await asyncio.sleep(1.0)
            while clock.now() - state["last_transcript_time"] < 1.2:
                await asyncio.sleep(0.3)
            close_event = {"type": "session.close"}
            await ws.send(json.dumps(close_event))
            log_raw_event(debug_log, "send", close_event)

        async def agent_bridge_loop() -> None:
            """Consumes the ElevenLabs agent's events. Its audio gets
            resampled and forwarded to GPT-Live as "mic" input; its
            agent_response text is the respondent's ground-truth reply,
            handed to Claude via pending_respondent_utterances. The agent
            does its own turn-detection on the (resampled) GPT-Live audio
            it's receiving -- no quiet-threshold guessing needed here."""
            while not stop_event.is_set():
                try:
                    async for event in agent_session.events():
                        etype = event.get("type")

                        if etype == "audio":
                            b64 = event["audio_event"]["audio_base_64"]
                            raw = base64.b64decode(b64)
                            resampled = resample_pcm16(
                                raw, agent_session.output_sample_rate or SAMPLE_RATE, SAMPLE_RATE
                            )
                            respondent_chunks.append((clock.now(), resampled))
                            state["respondent_speaking"] = True
                            try:
                                await _stream_audio(ws, resampled)
                            finally:
                                state["respondent_speaking"] = False

                        elif etype == "agent_response":
                            reply_text = event["agent_response_event"]["agent_response"]
                            pending_respondent_utterances.append(reply_text)
                            t = clock.now()
                            log.add_turn(Turn("participant", reply_text, t, t))
                            await emit({"type": "turn", "role": "participant", "text": reply_text, "t": t})

                        elif etype == "user_transcript":
                            # What the agent's own ASR heard from GPT-Live's
                            # audio -- kept for comparison, not fed to Claude.
                            heard = event["user_transcription_event"]["user_transcript"]
                            buf.add_input_delta(" " + heard)

                    return  # agent_session.events() ended -> connection closed
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    await emit({"type": "error", "text": f"agent_bridge_loop error: {e!r}"})
                    await asyncio.sleep(1.0)

        async def idle_mic_feed() -> None:
            """Stream continuous silent audio when the respondent isn't
            talking -- a stand-in for how a real mic constantly provides
            (near-)silent input even between turns. GPT-Live's own
            turn-detection/audio pipeline is undocumented and reverse-
            engineered throughout this project; this is a hypothesis that
            it expects a continuous input stream to behave normally, not a
            confirmed requirement."""
            silent_chunk = b"\x00" * CHUNK_BYTES
            while not stop_event.is_set():
                if not state["respondent_speaking"]:
                    try:
                        await ws.send(
                            json.dumps(
                                {
                                    "type": "session.input_audio.append",
                                    "audio": base64.b64encode(silent_chunk).decode("ascii"),
                                }
                            )
                        )
                    except Exception:
                        pass
                await asyncio.sleep(CHUNK_MS / 1000)

        async def watchdog() -> None:
            nonlocal ended_reason
            while not stop_event.is_set():
                await asyncio.sleep(1.0)
                if clock.now() >= max_minutes * 60:
                    ended_reason = "max_minutes"
                    await emit({"type": "info", "text": f"{max_minutes} min cap reached, ending session"})
                    close_event = {"type": "session.close"}
                    await ws.send(json.dumps(close_event))
                    log_raw_event(debug_log, "send", close_event)
                    return

        agent_bridge_task = asyncio.create_task(agent_bridge_loop())
        watchdog_task = asyncio.create_task(watchdog())
        idle_mic_task = asyncio.create_task(idle_mic_feed())
        stall_watchdog_task = asyncio.create_task(delegation_stall_watchdog(ws, buf, clock, state, debug_log))

        try:
            async for raw in ws:
                event = json.loads(raw)
                log_raw_event(debug_log, "recv", event)
                etype = event.get("type")

                if etype == "session.started":
                    await emit({"type": "info", "text": "session started"})
                    asyncio.create_task(send_opening())

                elif etype == "session.input_transcript.delta":
                    buf.add_input_delta(event.get("delta", ""))

                elif etype == "session.output_transcript.delta":
                    buf.add_output_delta(event.get("delta", ""))
                    state["last_transcript_time"] = clock.now()

                elif etype == "session.output_audio.delta":
                    state["last_audio_time"] = clock.now()
                    raw = base64.b64decode(event["delta"])
                    moderator_chunks.append((clock.now(), raw))
                    if agent_session.input_sample_rate is not None:
                        forwarded = resample_pcm16(raw, SAMPLE_RATE, agent_session.input_sample_rate)
                        await agent_session.send_audio_chunk(forwarded)

                elif etype == "session.delegation.created":
                    state["last_delegation_time"] = clock.now()
                    asyncio.create_task(handle_delegation(event["delegation"]["id"], clock.now()))

                elif etype == "session.closed":
                    if ended_reason == "unknown":
                        ended_reason = "closing_line" if state["closing"] else "server_closed"
                    await emit({"type": "info", "text": f"session closed, usage={event.get('usage')}"})
                    break

                elif etype == "error":
                    await emit({"type": "error", "text": str(event)})

        finally:
            stop_event.set()
            agent_bridge_task.cancel()
            watchdog_task.cancel()
            idle_mic_task.cancel()
            stall_watchdog_task.cancel()
            await agent_session.close()
            log.meta["raw_participant_transcript"] = buf.participant_text
            log.meta["raw_moderator_transcript"] = buf.moderator_text
            log.meta["delegation_count"] = delegation_count
            log.meta["ended_reason"] = ended_reason
            path = log.save()
            conversation_wav = PLAYGROUND_DIR / f"sim_{int(log.started_at)}_conversation.wav"
            has_audio = bool(moderator_chunks or respondent_chunks)
            if has_audio:
                mixed = _mix_chunks(clock.now(), moderator_chunks, respondent_chunks)
                _save_wav(conversation_wav, mixed)

    summary = {
        "transcript_path": str(path),
        "debug_log_path": str(debug_log),
        "conversation_wav": str(conversation_wav) if has_audio else None,
        "delegation_count": delegation_count,
        "duration_seconds": clock.now(),
        "ended_reason": ended_reason,
    }
    await emit({"type": "session_ended", "summary": summary})
    return summary


async def _run_batch(n: int, max_minutes: float) -> None:
    for i in range(n):
        print(f"\n=== Simulation {i + 1}/{n} ===")
        summary = await run_session(max_minutes=max_minutes)
        print(f"--- summary: {summary}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=1, help="number of simulations to run back to back")
    parser.add_argument("--minutes", type=float, default=DEFAULT_MAX_MINUTES, help="max session length")
    args = parser.parse_args()
    asyncio.run(_run_batch(args.n, args.minutes))


if __name__ == "__main__":
    main()
