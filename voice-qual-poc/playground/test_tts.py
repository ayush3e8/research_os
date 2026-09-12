"""Standalone sanity check for common/tts.py, isolated from GPT-Live and
the rest of the playground -- run this first when TTS is suspected to be
the problem, since it rules out everything else in one shot.

Usage:
    python -m playground.test_tts
Then play the resulting playground/test_tts_output.wav.
"""
import wave
from pathlib import Path

from dotenv import load_dotenv

from common.gpt_live_protocol import SAMPLE_RATE
from common.tts import synthesize_pcm16

load_dotenv()

OUT_PATH = Path(__file__).resolve().parent / "test_tts_output.wav"


def main() -> None:
    text = "Hi, this is a test of the text to speech pipeline."
    print(f"Calling ElevenLabs with output_format=pcm_{SAMPLE_RATE} ...")
    try:
        audio = synthesize_pcm16(text, SAMPLE_RATE)
    except Exception as e:
        print(f"FAILED: {e!r}")
        resp = getattr(e, "response", None)
        if resp is not None:
            print(f"status: {resp.status_code}")
            print(f"body: {resp.text}")
        return

    print(f"Got {len(audio)} bytes of PCM audio.")
    with wave.open(str(OUT_PATH), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio)
    print(f"Saved to {OUT_PATH} -- play it to confirm it sounds right.")


if __name__ == "__main__":
    main()
