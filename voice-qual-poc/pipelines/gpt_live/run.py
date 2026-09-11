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

import numpy as np
import sounddevice as sd
import websockets
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from common.moderator import next_utterance
from common.transcript_log import TRANSCRIPTS_DIR, Clock, SessionLog, Turn

load_dotenv()

WS_URL = "wss://api.openai.com/v1/live/sessions"
MODEL = os.environ.get("GPT_LIVE_MODEL", "gpt-live-1")
VOICE = os.environ.get("GPT_LIVE_VOICE", "marin")
SAMPLE_RATE = 24000
CHUNK_MS = 100
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS // 1000

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

    def add_input_delta(self, delta: str) -> None:
        self.participant_text += delta

    def add_output_delta(self, delta: str) -> None:
        self.moderator_text += delta

    def pending_participant_text(self) -> str:
        return self.participant_text[self.consumed_upto :].strip()

    def mark_consumed(self) -> None:
        self.consumed_upto = len(self.participant_text)


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
                "instructions": (
                    "You are a pass-through voice interface, not a conversational "
                    "participant. The backend sends you the exact words to speak "
                    "for every substantive reply. Speak that content word-for-word: "
                    "no rephrasing, no summarizing, no changing the wording, and no "
                    "additions before or after it. Specifically, never prepend "
                    "framing like 'Great', 'Got it', 'Good question, let me clarify "
                    "that', 'I'll take that forward', or similar — go straight into "
                    "the backend's exact words. Never restate or re-ask the question "
                    "a second time in your own phrasing after saying it once. If you "
                    "are waiting on the backend and the silence has already run "
                    "several seconds, you may say a single short sound like 'mm-hmm' "
                    "at most once — nothing longer, and never narrate what you or "
                    "the backend are doing. If the backend has not responded yet, "
                    "prefer silence over inventing your own question or commentary."
                ),
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

        async def handle_delegation(delegation_id: str, t_delegated: float) -> None:
            pending = buf.pending_participant_text()
            if pending:
                transcript.append({"role": "participant", "text": pending})
                log.add_turn(Turn("participant", pending, t_delegated, t_delegated))
                buf.mark_consumed()

            reply = await asyncio.to_thread(next_utterance, transcript)
            t_reply = clock.now()
            transcript.append({"role": "moderator", "text": reply})

            append_event = {
                "type": "session.commentary.append",
                "event_id": f"reply_{int(t_reply * 1000)}",
                "delegation_id": delegation_id,
                "content": reply,
            }
            await ws.send(json.dumps(append_event))
            log_raw_event(debug_log, "send", append_event)
            log.add_turn(
                Turn("moderator", reply, t_delegated, t_reply, latency_ms=(t_reply - t_delegated) * 1000)
            )
            print(f"MODERATOR (via Claude): {reply}")

        print("Connecting... say something once the session starts.\n")
        mic_stream.start()
        playback_task = asyncio.create_task(playback_loop())

        try:
            async for raw in ws:
                event = json.loads(raw)
                log_raw_event(debug_log, "recv", event)
                etype = event.get("type")

                if etype == "session.started":
                    print("[session started — speak whenever you're ready]")

                elif etype == "session.input_transcript.delta":
                    buf.add_input_delta(event.get("delta", ""))

                elif etype == "session.output_transcript.delta":
                    buf.add_output_delta(event.get("delta", ""))

                elif etype == "session.output_audio.delta":
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
            path = log.save()
            print(f"\nSession saved to {path}")


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
