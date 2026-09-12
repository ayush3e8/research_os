"""ElevenLabs Conversational AI Agents: creation (cached, so repeat runs
reuse one agent instead of spawning a new one every time) and the
real-time WebSocket bridge.

Schema/protocol details here are drawn from ElevenLabs' docs as of this
writing (Sept 2026) -- verify against your account on first run the same
way we had to for GPT-Live; if agent creation or the event names below
don't match, check https://elevenlabs.io/docs/eleven-agents.
"""
import base64
import json
import os
from pathlib import Path

import numpy as np
import websockets

CACHE_PATH = Path(__file__).resolve().parent.parent / ".elevenlabs_agents.json"
WS_BASE = "wss://api.elevenlabs.io/v1/convai/conversation"


def _load_cache() -> dict:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    return {}


def _save_cache(cache: dict) -> None:
    CACHE_PATH.write_text(json.dumps(cache, indent=2))


def get_or_create_agent(
    cache_key: str,
    name: str,
    system_prompt: str,
    first_message: str,
    voice_id: str,
    llm_model: str,
    tts_model_id: str = "eleven_flash_v2",
) -> str:
    """Returns a cached agent_id for cache_key if we've created one before,
    otherwise creates a new agent and remembers it in .elevenlabs_agents.json
    (gitignored) -- so re-running this doesn't clutter your ElevenLabs
    dashboard with a fresh duplicate agent every time. Delete that file (or
    the entry in it) to force recreation, e.g. after editing the prompt."""
    cache = _load_cache()
    if cache_key in cache:
        return cache[cache_key]

    from elevenlabs.client import ElevenLabs

    client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
    response = client.conversational_ai.agents.create(
        name=name,
        tags=["voice-qual-poc"],
        conversation_config={
            "tts": {"voice_id": voice_id, "model_id": tts_model_id},
            "agent": {
                "first_message": first_message,
                "language": "en",
                "prompt": {"prompt": system_prompt, "llm": llm_model},
            },
        },
    )
    cache[cache_key] = response.agent_id
    _save_cache(cache)
    return response.agent_id


def resample_pcm16(pcm_bytes: bytes, from_rate: int, to_rate: int) -> bytes:
    """Simple linear-interpolation resample -- good enough for bridging
    speech between two APIs with different native sample rates without
    pulling in scipy. Not broadcast-quality, but this is a test harness."""
    if from_rate == to_rate or not pcm_bytes:
        return pcm_bytes
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    duration = len(samples) / from_rate
    new_len = max(int(duration * to_rate), 1)
    old_idx = np.linspace(0, len(samples) - 1, num=len(samples))
    new_idx = np.linspace(0, len(samples) - 1, num=new_len)
    resampled = np.interp(new_idx, old_idx, samples).astype(np.int16)
    return resampled.tobytes()


class AgentSession:
    """One real-time conversation with an ElevenLabs agent. Connects like
    an ordinary client (we call out to ElevenLabs); nothing about this
    needs a public endpoint or tunnel."""

    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self.ws = None
        self.input_sample_rate: int | None = None  # what the agent expects us to send
        self.output_sample_rate: int | None = None  # what the agent's audio events are encoded at

    async def connect(self) -> None:
        headers = {"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}
        self.ws = await websockets.connect(f"{WS_BASE}?agent_id={self.agent_id}", additional_headers=headers)

    async def send_audio_chunk(self, pcm16_bytes: bytes) -> None:
        await self.ws.send(json.dumps({"user_audio_chunk": base64.b64encode(pcm16_bytes).decode("ascii")}))

    async def events(self):
        async for raw in self.ws:
            event = json.loads(raw)
            if event.get("type") == "conversation_initiation_metadata":
                meta = event["conversation_initiation_metadata_event"]
                self.input_sample_rate = _rate_from_format(meta.get("user_input_audio_format", "pcm_16000"))
                self.output_sample_rate = _rate_from_format(meta.get("agent_output_audio_format", "pcm_16000"))
            elif event.get("type") == "ping":
                # Must pong or the connection times out.
                await self.ws.send(json.dumps({"type": "pong", "event_id": event["ping_event"]["event_id"]}))
            yield event

    async def close(self) -> None:
        if self.ws is not None:
            await self.ws.close()


def _rate_from_format(fmt: str) -> int:
    # e.g. "pcm_24000" -> 24000. "ulaw_8000" isn't handled (we don't request it).
    try:
        return int(fmt.rsplit("_", 1)[1])
    except (IndexError, ValueError):
        return 16000
