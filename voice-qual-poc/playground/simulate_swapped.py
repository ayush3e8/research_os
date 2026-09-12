"""Role-swapped two-bot simulation: an ElevenLabs Conversational AI Agent
plays the *moderator* (same guide-driven setup as
pipelines/elevenlabs_claude/run.py -- Claude as its natively-selected LLM,
reuses that same cached "moderator_v1" agent) and GPT-Live plays the
*respondent* (voiced via client delegation to common/respondent_brain.py,
Claude answering in character as whichever persona common/respondent.py
loads).

This is the mirror image of playground/simulate.py (GPT-Live as moderator,
ElevenLabs Agent as respondent) -- see that module's docstring for the
audio-bridging design this shares. The main differences, beyond which side
is which:
- The moderator agent speaks first via its own `first_message` (same as
  Pipeline A) -- GPT-Live has no proactive opening here, it just waits for
  the moderator's audio to arrive.
- The closing line comes from the moderator agent's agent_response text,
  not from GPT-Live's own speech -- so closing detection watches that
  instead, and waits for the agent's audio `is_final` flag before closing
  GPT-Live's session.
- handle_delegation() calls respondent_brain.next_response() (no
  guide/pacing logic) instead of moderator.next_utterance().

Usage:
    python -m playground.simulate_swapped
    python -m playground.simulate_swapped --n 5
    python -m playground.simulate_swapped --minutes 3
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
    MODEL,
    RESPONDENT_INSTRUCTIONS_TEMPLATE,
    SAMPLE_RATE,
    VOICE,
    WS_URL,
    TranscriptBuffer,
    delegation_stall_watchdog,
    log_raw_event,
)
from common.interview_guide import CLOSING_SCRIPT, OPENING_SCRIPT, STUDY_TOPIC
from common.moderator import SYSTEM_PROMPT as MODERATOR_SYSTEM_PROMPT
from common.respondent_brain import next_response
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
    """See playground/simulate.py -- identical mixing logic."""
    total_samples = int(duration_s * SAMPLE_RATE) + SAMPLE_RATE
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
    log = SessionLog(
        pipeline="gpt_live_simulated_swapped",
        meta={"model": os.environ.get("RESPONDENT_MODEL", "claude-sonnet-5"), "voice": VOICE},
    )
    clock = Clock()
    transcript: list[dict] = []  # fed to respondent_brain; "moderator"/"participant" roles
    pending_moderator_utterances: list[str] = []  # ElevenLabs agent's agent_response text
    buf = TranscriptBuffer()
    moderator_chunks: list[tuple[float, bytes]] = []  # (t_offset, pcm16 bytes)
    respondent_chunks: list[tuple[float, bytes]] = []

    debug_log = PLAYGROUND_DIR / f"sim_swapped_debug_{int(log.started_at)}.jsonl"
    transcript_path = PLAYGROUND_DIR / f"sim_swapped_{int(log.started_at)}.json"

    headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}
    state = {
        "last_audio_time": clock.now(),
        "last_transcript_time": clock.now(),
        "last_delegation_time": clock.now(),
        "closing": False,
        "moderator_speaking": False,
    }
    stop_event = asyncio.Event()
    delegation_count = 0
    ended_reason = "unknown"

    await emit({"type": "info", "text": "creating/connecting ElevenLabs moderator agent..."})
    agent_id = get_or_create_agent(
        cache_key="moderator_v1",  # same cache key as pipelines/elevenlabs_claude/run.py --
        # reuses that agent if it already exists, rather than creating a duplicate.
        name="Voice Qual Moderator",
        system_prompt=MODERATOR_SYSTEM_PROMPT,
        first_message=OPENING_SCRIPT,
        voice_id=os.environ["ELEVENLABS_VOICE_ID"],
        llm_model=os.environ.get("MODERATOR_MODEL", "claude-sonnet-5"),
        tts_model_id=os.environ.get("ELEVENLABS_TTS_MODEL_ID", "eleven_v3_conversational"),
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
                "instructions": RESPONDENT_INSTRUCTIONS_TEMPLATE.substitute(study_topic=STUDY_TOPIC),
                "audio": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    "output": {"voice": VOICE},
                },
                "delegation": {"type": "client"},
            },
        }
        await ws.send(json.dumps(session_start))
        log_raw_event(debug_log, "send", session_start)

        async def speak(content: str, delegation_id: str | None, t_ref: float) -> None:
            """Push the respondent's line to GPT-Live. delegation_id=None
            would speak proactively -- unused here since the moderator
            agent always speaks first (its own first_message), so GPT-Live
            never needs an opening line of its own."""
            t_reply = clock.now()
            transcript.append({"role": "participant", "text": content})
            append_event = {
                "type": "session.commentary.append",
                "event_id": f"reply_{int(t_reply * 1000)}",
                "delegation_id": delegation_id,
                "content": content,
            }
            await ws.send(json.dumps(append_event))
            log_raw_event(debug_log, "send", append_event)
            log.add_turn(Turn("participant", content, t_ref, t_reply, latency_ms=(t_reply - t_ref) * 1000))
            await emit({"type": "turn", "role": "participant", "text": content, "t": t_reply})

        async def handle_delegation(delegation_id: str, t_delegated: float) -> None:
            nonlocal delegation_count
            delegation_count += 1

            own_speech = buf.pending_moderator_text()
            if own_speech:
                note = f"[spoken by the voice layer on its own, not authored by you]: {own_speech}"
                transcript.append({"role": "participant", "text": note})
                log.add_turn(Turn("participant", note, t_delegated, t_delegated))
                buf.mark_moderator_consumed()

            if pending_moderator_utterances:
                pending_text = " ".join(pending_moderator_utterances)
                pending_moderator_utterances.clear()
                transcript.append({"role": "moderator", "text": pending_text})
                log.add_turn(Turn("moderator", pending_text, t_delegated, t_delegated))

            try:
                reply = await asyncio.to_thread(next_response, transcript)
                if not reply.strip():
                    reply = await asyncio.to_thread(next_response, transcript)
            except Exception as e:
                await emit({"type": "error", "text": f"respondent brain error: {e!r}"})
                reply = ""
            if not reply.strip():
                reply = "Sorry, could you say that again?"
            await speak(reply, delegation_id, t_delegated)

        async def close_after_moderator_speaks() -> None:
            await asyncio.sleep(1.0)
            close_event = {"type": "session.close"}
            await ws.send(json.dumps(close_event))
            log_raw_event(debug_log, "send", close_event)

        async def agent_bridge_loop() -> None:
            """Consumes the ElevenLabs moderator agent's events. Its audio
            gets resampled and forwarded to GPT-Live as "mic" input; its
            agent_response text is the moderator's ground-truth question,
            handed to Claude (playing the respondent) via
            pending_moderator_utterances."""
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
                            moderator_chunks.append((clock.now(), resampled))
                            state["moderator_speaking"] = True
                            try:
                                await _stream_audio(ws, resampled)
                            finally:
                                state["moderator_speaking"] = False
                            if state["closing"] and event["audio_event"].get("is_final"):
                                asyncio.create_task(close_after_moderator_speaks())

                        elif etype == "agent_response":
                            reply_text = event["agent_response_event"]["agent_response"]
                            pending_moderator_utterances.append(reply_text)
                            t = clock.now()
                            log.add_turn(Turn("moderator", reply_text, t, t))
                            await emit({"type": "turn", "role": "moderator", "text": reply_text, "t": t})
                            if reply_text.strip() == CLOSING_SCRIPT.strip():
                                state["closing"] = True

                        elif etype == "user_transcript":
                            # What the agent's own ASR heard from GPT-Live's
                            # (respondent) audio -- kept for comparison, not
                            # fed to Claude.
                            heard = event["user_transcription_event"]["user_transcript"]
                            buf.add_input_delta(" " + heard)

                    return  # agent_session.events() ended -> connection closed
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    await emit({"type": "error", "text": f"agent_bridge_loop error: {e!r}"})
                    await asyncio.sleep(1.0)

        async def idle_mic_feed() -> None:
            """Stream continuous silent audio when the moderator isn't
            talking -- see playground/simulate.py's version for the
            rationale (unconfirmed hypothesis, kept as a precaution)."""
            silent_chunk = b"\x00" * CHUNK_BYTES
            while not stop_event.is_set():
                if not state["moderator_speaking"]:
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
                    await emit({"type": "info", "text": "session started, waiting for moderator to open"})

                elif etype == "session.input_transcript.delta":
                    buf.add_input_delta(event.get("delta", ""))

                elif etype == "session.output_transcript.delta":
                    buf.add_output_delta(event.get("delta", ""))
                    state["last_transcript_time"] = clock.now()

                elif etype == "session.output_audio.delta":
                    state["last_audio_time"] = clock.now()
                    raw = base64.b64decode(event["delta"])
                    respondent_chunks.append((clock.now(), raw))
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
            conversation_wav = PLAYGROUND_DIR / f"sim_swapped_{int(log.started_at)}_conversation.wav"
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
        print(f"\n=== Simulation {i + 1}/{n} (roles swapped) ===")
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
