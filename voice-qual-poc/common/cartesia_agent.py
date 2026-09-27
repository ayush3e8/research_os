"""Cartesia Managed Agents: creation (cached, so repeat runs reuse one agent
instead of spawning a new one every time), the LLM catalog lookup, and the
real-time WebSocket bridge.

The Cartesia counterpart of common/elevenlabs_agent.py. A Managed Agent is
Ink-2 (ASR + turn detection) + an LLM from Cartesia's own catalog + Sonic
(TTS) as one hosted loop -- same shape as an ElevenLabs agent, so the two
pipelines compare voice layers, not architectures.

Schema/protocol details here are drawn from Cartesia's docs as of this
writing (API version 2026-08-14) -- if agent creation or the event names
below don't match, check https://docs.cartesia.ai/agents/introduction and
https://docs.cartesia.ai/line/integrations/websocket-api.
"""
import base64
import json
import os
from pathlib import Path

import requests
import websockets

CACHE_PATH = Path(__file__).resolve().parent.parent / ".cartesia_agents.json"
API_BASE = "https://api.cartesia.ai"
WS_BASE = "wss://api.cartesia.ai/v1/agents/websocket"
API_VERSION = "2026-08-14"


def _headers() -> dict:
    return {
        "X-API-Key": os.environ["CARTESIA_API_KEY"],
        "Cartesia-Version": API_VERSION,
        "Content-Type": "application/json",
    }


def _raise_for_status(response: requests.Response, what: str) -> None:
    # Surface the body explicitly -- a bare HTTPError hides the useful part.
    if not response.ok:
        raise RuntimeError(f"Cartesia {what} failed (status={response.status_code}): {response.text}")


def _load_cache() -> dict:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    return {}


def _save_cache(cache: dict) -> None:
    CACHE_PATH.write_text(json.dumps(cache, indent=2))


def list_models() -> list[dict]:
    """LLMs available to Managed Agents on this account (id, provider,
    average_latency_ms, pricing). Cartesia hosts the model itself, so which
    Claude models exist here is Cartesia's catalog, not Anthropic's."""
    models: list[dict] = []
    params: dict = {"limit": 100}
    while True:
        response = requests.get(f"{API_BASE}/v1/agents/models", headers=_headers(), params=params, timeout=30)
        _raise_for_status(response, "model listing")
        body = response.json()
        models.extend(body["data"])
        if not body.get("has_more") or not body.get("next_page"):
            return models
        params["starting_after"] = body["next_page"]


def get_or_create_agent(
    cache_key: str,
    name: str,
    instructions: str,
    initial_message: str,
    voice_id: str,
    llm_model: str,
    dynamic_variable_placeholders: dict | None = None,
) -> str:
    """Returns a cached agent id for cache_key if we've created one before,
    otherwise creates a new agent and remembers it in .cartesia_agents.json
    (gitignored). Delete that file (or the entry in it) to force recreation,
    e.g. after editing the prompt or switching models."""
    cache = _load_cache()
    if cache_key in cache:
        return cache[cache_key]

    available = {m["id"] for m in list_models()}
    if llm_model not in available:
        raise RuntimeError(
            f"Cartesia doesn't offer LLM {llm_model!r} on this account. Available: {', '.join(sorted(available))}"
        )

    config = {
        "instructions": instructions,
        "initial_message": initial_message,
        "model": {"id": llm_model},
        "language": {"primary": "en"},
        "audio": {"output": {"voice_id": voice_id}},
        # Hang up once the moderator has delivered the closing line, instead
        # of relying on the client to notice it.
        "system_tools": {
            "end_call": {
                "description": (
                    "End the interview. Use only immediately after you have spoken the "
                    "closing line verbatim, or if the participant explicitly asks to stop."
                ),
                "pre_tool_speech": "force",
            }
        },
        # A qual respondent often pauses to think; the 8s default check-in
        # would talk over them.
        "turn": {"inactivity_check_in_secs": 20},
    }
    if dynamic_variable_placeholders:
        config["dynamic_variable_placeholders"] = dynamic_variable_placeholders

    response = requests.post(
        f"{API_BASE}/v1/agents",
        headers=_headers(),
        json={"name": name, "description": "voice-qual-poc moderator", "config": config},
        timeout=30,
    )
    _raise_for_status(response, "agent creation")
    agent_id = response.json()["id"]
    cache[cache_key] = agent_id
    _save_cache(cache)
    return agent_id


class AgentSession:
    """One real-time conversation with a Cartesia Managed Agent. Connects
    like an ordinary client (we call out to Cartesia); nothing about this
    needs a public endpoint or tunnel.

    Unlike ElevenLabs, the client picks the sample rate (in session_create)
    and agent audio comes back in that same format."""

    def __init__(self, agent_id: str, sample_rate: int = 16000):
        if sample_rate not in (16000, 24000, 44100):
            raise ValueError(f"Cartesia agents accept pcm_16000/24000/44100, not {sample_rate}")
        self.agent_id = agent_id
        self.sample_rate = sample_rate
        self.ws = None
        self.call_id: str | None = None
        self.ready = False

    async def connect(self, dynamic_variables: dict | None = None) -> None:
        self.ws = await websockets.connect(
            f"{WS_BASE}/{self.agent_id}?cartesia_version={API_VERSION}",
            additional_headers={"X-API-Key": os.environ["CARTESIA_API_KEY"]},
        )
        # Must be the first message, within 10s of connecting.
        create = {
            "type": "session_create",
            "audio": {"input_format": f"pcm_{self.sample_rate}", "output_delivery": "speaking_pace"},
        }
        if dynamic_variables:
            create["dynamic_variables"] = dynamic_variables
        await self.ws.send(json.dumps(create))

    async def send_audio_chunk(self, pcm16_bytes: bytes) -> None:
        # Audio sent before session_ready is dropped server-side anyway.
        if not self.ready:
            return
        await self.ws.send(json.dumps({"type": "audio_input", "audio": base64.b64encode(pcm16_bytes).decode("ascii")}))

    async def events(self):
        async for raw in self.ws:
            event = json.loads(raw)
            if event.get("type") == "session_ready":
                self.call_id = event.get("call_id")
                self.ready = True
            yield event

    async def close(self) -> None:
        if self.ws is not None:
            await self.ws.close(1000, "session completed")
