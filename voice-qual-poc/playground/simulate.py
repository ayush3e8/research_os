"""Two-bot simulation: GPT-Live (interviewer, same real pipeline as
pipelines/gpt_live/run.py) talks to a synthetic respondent (an LLM persona
+ ElevenLabs TTS) instead of a human on a microphone.

Deliberately duplicates pipelines/gpt_live/run.py's session/delegation
logic rather than sharing it -- the two scripts' audio I/O differs enough
(real mic/speaker vs. synthetic respondent + saved wav files) that a
shared abstraction wasn't worth the risk while delegation behavior is
still being actively tuned. If that settles down, factoring the common
event-loop pattern into common/ would be a reasonable follow-up.

Design choice worth knowing: Claude (the moderator brain) is fed the
respondent's *ground-truth* generated text, not GPT-Live's ASR
reconstruction of it -- this isolates "how does GPT-Live behave" from
"how good is its ASR," which are different questions. GPT-Live's own
ASR output is still captured in the debug log / raw transcript for
comparison if you want to check transcription accuracy separately.

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

import websockets
from dotenv import load_dotenv

from common.gpt_live_protocol import (
    CHUNK_MS,
    CHUNK_SAMPLES,
    INSTRUCTIONS_TEMPLATE,
    MODEL,
    SAMPLE_RATE,
    VOICE,
    WS_URL,
    TranscriptBuffer,
    log_raw_event,
)
from common.interview_guide import CLOSING_SCRIPT, STUDY_TOPIC
from common.moderator import next_utterance
from common.respondent import next_reply
from common.transcript_log import TRANSCRIPTS_DIR, Clock, SessionLog, Turn
from common.tts import synthesize_pcm16

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


async def run_session(max_minutes: float = DEFAULT_MAX_MINUTES, on_event=None) -> dict:
    emit = on_event or _default_emit

    PLAYGROUND_DIR.mkdir(parents=True, exist_ok=True)
    log = SessionLog(pipeline="gpt_live_simulated", meta={"model": MODEL, "voice": VOICE})
    clock = Clock()
    transcript: list[dict] = []  # fed to Claude, same shape as the human pipeline
    respondent_view: list[dict] = []  # fed to the respondent LLM
    pending_respondent_utterances: list[str] = []
    buf = TranscriptBuffer()
    moderator_audio = bytearray()
    respondent_audio = bytearray()

    debug_log = PLAYGROUND_DIR / f"sim_debug_{int(log.started_at)}.jsonl"
    transcript_path = PLAYGROUND_DIR / f"sim_{int(log.started_at)}.json"

    headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}
    state = {
        "last_audio_time": clock.now(),
        "last_transcript_time": clock.now(),
        "closing": False,
        "respondent_speaking": False,
    }
    stop_event = asyncio.Event()
    delegation_count = 0
    ended_reason = "unknown"

    await emit({"type": "info", "text": "connecting..."})

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

        async def respondent_loop() -> None:
            respondent_consumed_upto = 0
            while not stop_event.is_set():
                try:
                    await asyncio.sleep(0.15)
                    new_moderator_text = buf.moderator_text[respondent_consumed_upto:].strip()
                    # Use the *transcript* stream going quiet, not the audio
                    # stream: a real run showed output_audio.delta kept
                    # flowing continuously (zero gaps over 0.6s in 277
                    # seconds) long after output_transcript.delta had
                    # stopped for good after just the opening line. GPT-Live
                    # apparently keeps the audio channel open well past when
                    # it's actually said anything new, so audio timing alone
                    # can never signal "done talking" here.
                    #
                    # 0.6s was too eager once the transcript signal actually
                    # worked: a real run showed the respondent barging in
                    # during a normal mid-sentence pause, GPT-Live correctly
                    # treating that as an interruption (per its own
                    # interruption policy) and cutting itself off -- the
                    # respondent then reacted to the genuinely truncated
                    # question as "bad connection," which was a reasonable
                    # read of what was actually happening to it. Since
                    # transcript deltas really do stop for good when GPT-Live
                    # is done (unlike audio), we can afford to be patient.
                    quiet_long_enough = (clock.now() - state["last_transcript_time"]) > 1.4
                    if not (new_moderator_text and quiet_long_enough):
                        continue

                    respondent_consumed_upto = len(buf.moderator_text)
                    respondent_view.append({"role": "moderator", "text": new_moderator_text})
                    try:
                        reply_text = await asyncio.to_thread(next_reply, respondent_view)
                    except Exception as e:
                        await emit({"type": "error", "text": f"respondent brain error: {e!r}"})
                        continue
                    respondent_view.append({"role": "participant", "text": reply_text})
                    pending_respondent_utterances.append(reply_text)
                    t = clock.now()
                    log.add_turn(Turn("participant", reply_text, t, t))
                    await emit({"type": "turn", "role": "participant", "text": reply_text, "t": t})

                    try:
                        audio = await asyncio.to_thread(synthesize_pcm16, reply_text, SAMPLE_RATE)
                    except Exception as e:
                        await emit({"type": "error", "text": f"TTS error: {e!r}"})
                        continue
                    respondent_audio.extend(audio)
                    state["respondent_speaking"] = True
                    try:
                        await _stream_audio(ws, audio)
                    finally:
                        state["respondent_speaking"] = False
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    # Whatever this is, don't let it kill the loop silently --
                    # that's exactly what left a prior run stuck with no
                    # visible error at all.
                    await emit({"type": "error", "text": f"respondent_loop error: {e!r}"})
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

        respondent_task = asyncio.create_task(respondent_loop())
        watchdog_task = asyncio.create_task(watchdog())
        idle_mic_task = asyncio.create_task(idle_mic_feed())

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
                    moderator_audio.extend(base64.b64decode(event["delta"]))

                elif etype == "session.delegation.created":
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
            respondent_task.cancel()
            watchdog_task.cancel()
            idle_mic_task.cancel()
            log.meta["raw_participant_transcript"] = buf.participant_text
            log.meta["raw_moderator_transcript"] = buf.moderator_text
            log.meta["delegation_count"] = delegation_count
            log.meta["ended_reason"] = ended_reason
            path = log.save()
            moderator_wav = PLAYGROUND_DIR / f"sim_{int(log.started_at)}_moderator.wav"
            respondent_wav = PLAYGROUND_DIR / f"sim_{int(log.started_at)}_respondent.wav"
            _save_wav(moderator_wav, bytes(moderator_audio))
            _save_wav(respondent_wav, bytes(respondent_audio))

    summary = {
        "transcript_path": str(path),
        "debug_log_path": str(debug_log),
        "moderator_wav": str(moderator_wav) if moderator_audio else None,
        "respondent_wav": str(respondent_wav) if respondent_audio else None,
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
