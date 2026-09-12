"""Shared ElevenLabs TTS helper. Requests raw PCM16 mono directly via the
output_format param so callers that need to feed audio straight into
another API (e.g. GPT-Live's session.input_audio.append) don't need any
local resampling/decoding step.
"""
import os

import requests

ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")


def synthesize_pcm16(text: str, sample_rate: int = 24000) -> bytes:
    """Returns raw, headerless PCM16 little-endian mono audio at
    `sample_rate` Hz. Assumes your ElevenLabs plan supports the
    pcm_<rate> output_format (available on paid tiers as of this
    writing) -- if this 400s, check your plan/API version and fall back
    to the default mp3 output plus a resampling step.
    """
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}",
        params={"output_format": f"pcm_{sample_rate}"},
        headers={
            "xi-api-key": os.environ["ELEVENLABS_API_KEY"],
            "Content-Type": "application/json",
            "Accept": "audio/pcm",
        },
        json={"text": text, "model_id": "eleven_turbo_v2_5"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.content
