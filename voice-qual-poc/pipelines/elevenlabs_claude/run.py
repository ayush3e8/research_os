"""Pipeline A: push-to-talk moderator using Whisper (STT) + Claude (brain)
+ ElevenLabs (TTS).

Turn-taking is manual (press Enter to talk, Enter again to stop) since this
stack has no built-in duplex/VAD layer — that gap is itself one of the things
worth comparing against GPT-Live-1's full-duplex handling.

Usage:
    python -m pipelines.elevenlabs_claude.run
"""
import io
import os
import sys
import wave
from pathlib import Path

import numpy as np
import requests
import sounddevice as sd
from dotenv import load_dotenv
from openai import OpenAI

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from common.moderator import next_utterance
from common.transcript_log import Clock, SessionLog, Turn

load_dotenv()

SAMPLE_RATE = 16000
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
STT_MODEL = os.environ.get("STT_MODEL", "whisper-1")

openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def record_until_enter() -> np.ndarray:
    print("  [recording... press Enter to stop]")
    frames: list[np.ndarray] = []

    def callback(indata, _frame_count, _time_info, _status):
        frames.append(indata.copy())

    with sd.InputStream(
        samplerate=SAMPLE_RATE, channels=1, dtype="int16", callback=callback
    ):
        input()

    if not frames:
        return np.zeros((0,), dtype="int16")
    return np.concatenate(frames).flatten()


def transcribe(audio: np.ndarray) -> str:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio.tobytes())
    buf.seek(0)
    buf.name = "speech.wav"
    result = openai_client.audio.transcriptions.create(model=STT_MODEL, file=buf)
    return result.text.strip()


def speak(text: str) -> bytes:
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream",
        headers={
            "xi-api-key": os.environ["ELEVENLABS_API_KEY"],
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        json={"text": text, "model_id": "eleven_turbo_v2_5"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.content


def play_mp3_bytes(mp3_bytes: bytes) -> None:
    # Requires ffmpeg-backed decoding; simplest dependency-light path is to
    # shell out to `ffplay` (part of ffmpeg) which most dev machines already have.
    import subprocess
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(mp3_bytes)
        path = f.name
    subprocess.run(
        ["ffplay", "-autoexit", "-nodisp", "-loglevel", "quiet", path],
        check=True,
    )
    os.unlink(path)


def main() -> None:
    log = SessionLog(pipeline="elevenlabs_claude")
    clock = Clock()
    transcript: list[dict] = []

    print("=== Pipeline A: ElevenLabs + Claude (push-to-talk) ===")
    print("Press Enter to begin the interview.\n")
    input()

    opening = next_utterance(transcript)
    t0 = clock.now()
    audio = speak(opening)
    t_audio = clock.now()
    print(f"MODERATOR: {opening}")
    play_mp3_bytes(audio)
    transcript.append({"role": "moderator", "text": opening})
    log.add_turn(Turn("moderator", opening, t0, clock.now(), latency_ms=(t_audio - t0) * 1000))

    while True:
        print("\nParticipant, press Enter then speak.")
        input()
        t_stop = clock.now()
        rec = record_until_enter()
        if rec.size == 0:
            continue
        text = transcribe(rec)
        print(f"PARTICIPANT: {text}")
        transcript.append({"role": "participant", "text": text})
        log.add_turn(Turn("participant", text, t_stop, clock.now()))

        if text.strip().lower() in {"stop", "end interview", "quit"}:
            break

        t_req = clock.now()
        reply = next_utterance(transcript)
        t_reply = clock.now()
        audio = speak(reply)
        t_audio = clock.now()
        print(f"MODERATOR: {reply}")
        play_mp3_bytes(audio)
        transcript.append({"role": "moderator", "text": reply})
        log.add_turn(
            Turn(
                "moderator",
                reply,
                t_req,
                t_audio,
                latency_ms=(t_audio - t_stop) * 1000,  # end-of-speech -> audio played
            )
        )

    path = log.save()
    print(f"\nSession saved to {path}")


if __name__ == "__main__":
    main()
