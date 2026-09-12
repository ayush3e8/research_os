"""Pipeline B: full-duplex moderator using GPT-Live-1 for voice I/O, with
Claude doing all the reasoning via "client" delegation.

GPT-Live-1 owns the mic stream, VAD/turn-taking, ASR, and TTS. Every time it
decides the participant needs a substantive reply, it fires
`session.delegation.created` with no task text attached (by design — see
OpenAI's delegation docs) and waits for us to push back spoken content via
`session.commentary.append`. We reconstruct what was said from the running
`session.input_transcript.delta` events and hand it to the *same*
common/moderator.py used by pipeline A, so the reasoning is held constant
and only the voice layer differs.

Schema note: GPT-Live-1's API shipped 2026-09-10. The event names/fields
below are transcribed from OpenAI's docs at launch and may drift — this
script logs every raw event to transcripts/gpt_live_debug_<timestamp>.jsonl
(one file per run) so you can diff against reality instead of guessing blind.

Usage:
    python -m pipelines.gpt_live.run
"""
import asyncio
import base64
import json
import os
import sys
import time
from pathlib import Path
from string import Template

import numpy as np
import sounddevice as sd
import websockets
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from common.interview_guide import CLOSING_SCRIPT, STUDY_TOPIC
from common.moderator import next_utterance
from common.transcript_log import TRANSCRIPTS_DIR, Clock, SessionLog, Turn

load_dotenv()

PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"
INSTRUCTIONS_TEMPLATE = Template(Path(PROMPTS_DIR / "gpt_live_instructions.txt").read_text())

WS_URL = "wss://api.openai.com/v1/live/sessions"
MODEL = os.environ.get("GPT_LIVE_MODEL", "gpt-live-1")
VOICE = os.environ.get("GPT_LIVE_VOICE", "marin")
SAMPLE_RATE = 24000
CHUNK_MS = 100
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS // 1000

# Diagnostic toggle: every real test past the very first one has shown
# GPT-Live delegating rarely-to-never regardless of instructions. The one
# thing that first run *didn't* have was a proactive commentary.append with
# delegation_id=null for the opening line -- set this false to isolate
# whether that's teaching the model content can appear outside delegation
# and suppressing its own inclination to hand off for the rest of the
# session. When false, the opening line is only spoken once the
# participant speaks first and a real delegation fires, same as run 1.
PROACTIVE_OPENING = os.environ.get("GPT_LIVE_PROACTIVE_OPENING", "true").lower() != "false"


def log_raw_event(debug_log: Path, direction: str, event: dict) -> None:
    TRANSCRIPTS_DIR.mkdir(exist_ok=True)
    with debug_log.open("a") as f:
        f.write(json.dumps({"t": time.time(), "dir": direction, "event": event}) + "\n")


class TranscriptBuffer:
    """Accumulates GPT-Live's own transcript events so we can reconstruct
    what the participant said when a delegation event (which carries no
    task text) arrives."""

    def __init__(self) -> None:
        self.participant_text = ""
        self.moderator_text = ""
        self.consumed_upto = 0  # index into participant_text already sent to Claude
        self.moderator_consumed_upto = 0  # index into moderator_text already sent to Claude

    def add_input_delta(self, delta: str) -> None:
        self.participant_text += delta

    def add_output_delta(self, delta: str) -> None:
        self.moderator_text += delta

    def pending_participant_text(self) -> str:
        return self.participant_text[self.consumed_upto :].strip()

    def mark_consumed(self) -> None:
        self.consumed_upto = len(self.participant_text)

    def pending_moderator_text(self) -> str:
        """GPT-Live's own improvised speech since the last delegation —
        Claude never authored this, but needs to see it happened so it
        doesn't lose track of what's already been covered."""
        return self.moderator_text[self.moderator_consumed_upto :].strip()

    def mark_moderator_consumed(self) -> None:
        self.moderator_consumed_upto = len(self.moderator_text)


async def run() -> None:
    log = SessionLog(pipeline="gpt_live", meta={"model": MODEL, "voice": VOICE})
    clock = Clock()
    transcript: list[dict] = []  # shared format for common/moderator.py
    buf = TranscriptBuffer()

    # One debug log per run (matches the transcript json's timestamp) so
    # consecutive runs never get mashed into the same file.
    debug_log = TRANSCRIPTS_DIR / f"gpt_live_debug_{int(log.started_at)}.jsonl"

    headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}

    print("=== Pipeline B: GPT-Live-1 (full duplex) ===")
    print(f"Debug event log: {debug_log}")

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

        loop = asyncio.get_event_loop()
        audio_out_queue: asyncio.Queue[bytes] = asyncio.Queue()

        # --- mic capture: push PCM16 frames to GPT-Live as they arrive ---
        def mic_callback(indata, _frames, _time_info, _status):
            pcm_bytes = indata.tobytes()
            asyncio.run_coroutine_threadsafe(
                ws.send(
                    json.dumps(
                        {
                            "type": "session.input_audio.append",
                            "audio": base64.b64encode(pcm_bytes).decode("ascii"),
                        }
                    )
                ),
                loop,
            )

        mic_stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=CHUNK_SAMPLES,
            callback=mic_callback,
        )

        # --- speaker playback: drain audio_out_queue continuously ---
        async def playback_loop():
            out_stream = sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16")
            out_stream.start()
            try:
                while True:
                    chunk = await audio_out_queue.get()
                    if chunk is None:
                        break
                    out_stream.write(np.frombuffer(chunk, dtype="int16"))
            finally:
                out_stream.stop()
                out_stream.close()

        state = {"last_audio_time": clock.now(), "closing": False}

        async def speak(content: str, delegation_id: str | None, t_ref: float) -> None:
            """Push a line to be spoken. delegation_id=None speaks proactively,
            not in response to a session.delegation.created event."""
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
            log.add_turn(
                Turn("moderator", content, t_ref, t_reply, latency_ms=(t_reply - t_ref) * 1000)
            )
            print(f"MODERATOR (via Claude): {content}")

            if content.strip() == CLOSING_SCRIPT.strip():
                state["closing"] = True
                asyncio.create_task(close_after_speaking())

        async def send_opening() -> None:
            t0 = clock.now()
            opening = await asyncio.to_thread(next_utterance, [])
            await speak(opening, delegation_id=None, t_ref=t0)

        async def handle_delegation(delegation_id: str, t_delegated: float) -> None:
            # GPT-Live may have improvised its own speech since the last
            # delegation (it doesn't reliably delegate every turn despite
            # the policy above) -- surface that to Claude so it doesn't
            # lose track of what's already been covered and re-ask it.
            # Imperfect: this can also re-include the transcription echo of
            # Claude's own last delegated line if it arrives after we mark
            # consumed, since nothing tags which spoken text came from
            # which source. Harmless redundancy, not worth the complexity
            # of event-level attribution to fully dedupe here.
            own_speech = buf.pending_moderator_text()
            if own_speech:
                note = f"[spoken by the voice layer on its own, not authored by you]: {own_speech}"
                transcript.append({"role": "moderator", "text": note})
                log.add_turn(Turn("moderator", note, t_delegated, t_delegated))
                buf.mark_moderator_consumed()

            pending = buf.pending_participant_text()
            if pending:
                transcript.append({"role": "participant", "text": pending})
                log.add_turn(Turn("participant", pending, t_delegated, t_delegated))
                buf.mark_consumed()

            try:
                reply = await asyncio.to_thread(next_utterance, transcript, elapsed_seconds=t_delegated)
                if not reply.strip():
                    # Rare, but seen in testing: retry once before falling back
                    # rather than sending an empty commentary.append.
                    reply = await asyncio.to_thread(next_utterance, transcript, elapsed_seconds=t_delegated)
            except Exception as e:
                # A crash here used to leave the participant in dead air and
                # only surface later as an unhelpful "Task exception was
                # never retrieved" -- print it immediately and keep going
                # with a safe fallback instead of losing the turn silently.
                print(f"[handle_delegation error, falling back]: {e!r}")
                reply = ""
            if not reply.strip():
                reply = "Sorry, could you say that again?"
            await speak(reply, delegation_id=delegation_id, t_ref=t_delegated)

        async def close_after_speaking() -> None:
            # No explicit "finished speaking" event is documented, so wait
            # until output audio has actually gone quiet for a beat before
            # hanging up — otherwise we'd cut the closing line off.
            await asyncio.sleep(1.0)
            while clock.now() - state["last_audio_time"] < 1.2:
                await asyncio.sleep(0.3)
            close_event = {"type": "session.close"}
            await ws.send(json.dumps(close_event))
            log_raw_event(debug_log, "send", close_event)
            print("[closing line delivered — ending session]")

        print("Connecting...\n")
        mic_stream.start()
        playback_task = asyncio.create_task(playback_loop())

        try:
            async for raw in ws:
                event = json.loads(raw)
                log_raw_event(debug_log, "recv", event)
                etype = event.get("type")

                if etype == "session.started":
                    print("[session started]")
                    if PROACTIVE_OPENING:
                        asyncio.create_task(send_opening())
                    else:
                        print("[waiting for participant to speak first — PROACTIVE_OPENING is off]")

                elif etype == "session.input_transcript.delta":
                    buf.add_input_delta(event.get("delta", ""))

                elif etype == "session.output_transcript.delta":
                    buf.add_output_delta(event.get("delta", ""))

                elif etype == "session.output_audio.delta":
                    state["last_audio_time"] = clock.now()
                    audio_bytes = base64.b64decode(event["delta"])
                    await audio_out_queue.put(audio_bytes)

                elif etype == "session.delegation.created":
                    delegation_id = event["delegation"]["id"]
                    print(f"[delegation received: {delegation_id}]")
                    asyncio.create_task(handle_delegation(delegation_id, clock.now()))

                elif etype == "session.closed":
                    print(f"[session closed] usage={event.get('usage')}")
                    break

                elif etype == "error":
                    print(f"[error event] {event}")

        except KeyboardInterrupt:
            pass
        finally:
            mic_stream.stop()
            mic_stream.close()
            await audio_out_queue.put(None)
            await playback_task
            # Ground truth of everything actually said, independent of
            # whether GPT-Live delegated it or spoke on its own judgment —
            # the structured `turns` list above only captures the former.
            log.meta["raw_participant_transcript"] = buf.participant_text
            log.meta["raw_moderator_transcript"] = buf.moderator_text
            path = log.save()
            print(f"\nSession saved to {path}")


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
