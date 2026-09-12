"""Local live-viewer for playground/simulate.py and its role-swapped
counterpart, playground/simulate_swapped.py -- a "mode" field on each
run/run_batch message ("normal" or "swapped", default "normal") picks
which one runs. Runs entirely on your own machine -- API keys never touch
the browser, the page only talks to this local WebSocket server.

Usage:
    python -m playground.server
Then open playground/static/index.html directly in a browser (double-click
it, or open the file:// path) -- it connects to ws://localhost:8765.
"""
import asyncio
import json
import os

import websockets
from dotenv import load_dotenv

from playground.simulate import run_session as run_session_normal
from playground.simulate_swapped import run_session as run_session_swapped

load_dotenv()

PORT = int(os.environ.get("PLAYGROUND_WS_PORT", "8765"))

_RUN_SESSION = {"normal": run_session_normal, "swapped": run_session_swapped}

_clients: set = set()
_running = False


async def _broadcast(event: dict) -> None:
    # Always print server-side, regardless of whether a browser is
    # connected -- a closed/refreshed tab used to mean anything that
    # happened afterward (including errors) vanished silently.
    if event["type"] == "turn":
        print(f"{event['role'].upper()}: {event['text']}")
    elif event["type"] in ("info", "error", "run_started", "batch_progress"):
        print(f"[{event['type']}] {event}")
    elif event["type"] == "session_ended":
        print(f"[session_ended] {event['summary']}")

    if not _clients:
        return
    payload = json.dumps(event)
    await asyncio.gather(*(c.send(payload) for c in list(_clients)), return_exceptions=True)


async def _run_one(minutes: float, mode: str) -> None:
    global _running
    if _running:
        await _broadcast({"type": "error", "text": "a simulation is already running"})
        return
    _running = True
    try:
        await _broadcast({"type": "run_started", "mode": mode})
        await _RUN_SESSION[mode](max_minutes=minutes, on_event=_broadcast)
    except Exception as e:
        await _broadcast({"type": "error", "text": f"simulation crashed: {e!r}"})
    finally:
        _running = False


async def _run_batch(n: int, minutes: float, mode: str) -> None:
    global _running
    if _running:
        await _broadcast({"type": "error", "text": "a simulation is already running"})
        return
    _running = True
    try:
        for i in range(n):
            await _broadcast({"type": "batch_progress", "current": i + 1, "total": n})
            await _RUN_SESSION[mode](max_minutes=minutes, on_event=_broadcast)
    except Exception as e:
        await _broadcast({"type": "error", "text": f"batch crashed: {e!r}"})
    finally:
        _running = False


async def _handler(ws) -> None:
    _clients.add(ws)
    try:
        async for raw in ws:
            msg = json.loads(raw)
            mode = msg.get("mode", "normal")
            if mode not in _RUN_SESSION:
                await _broadcast({"type": "error", "text": f"unknown mode: {mode!r}"})
                continue
            if msg.get("type") == "run":
                asyncio.create_task(_run_one(float(msg.get("minutes", 5.0)), mode))
            elif msg.get("type") == "run_batch":
                asyncio.create_task(_run_batch(int(msg.get("n", 5)), float(msg.get("minutes", 5.0)), mode))
    finally:
        _clients.discard(ws)


async def main() -> None:
    async with websockets.serve(_handler, "localhost", PORT):
        print(f"Playground server listening on ws://localhost:{PORT}")
        print("Open playground/static/index.html in your browser to use it.")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
