"""Shared session logger: transcript + per-turn latency, one JSON file per run.

Both pipelines write the same schema so compare/scorecard.py (and manual
review) can treat a session from either pipeline identically.
"""
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

TRANSCRIPTS_DIR = Path(__file__).resolve().parent.parent / "transcripts"


@dataclass
class Turn:
    role: str  # "moderator" | "participant"
    text: str
    t_start: float  # seconds since session start
    t_end: float
    latency_ms: float | None = None  # for moderator turns: silence-end -> first audio


@dataclass
class SessionLog:
    pipeline: str  # "elevenlabs_claude" | "gpt_live"
    started_at: float = field(default_factory=time.time)
    turns: list[Turn] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    def add_turn(self, turn: Turn) -> None:
        self.turns.append(turn)

    def save(self) -> Path:
        TRANSCRIPTS_DIR.mkdir(exist_ok=True)
        path = TRANSCRIPTS_DIR / f"{self.pipeline}_{int(self.started_at)}.json"
        payload = {
            "pipeline": self.pipeline,
            "started_at": self.started_at,
            "meta": self.meta,
            "turns": [asdict(t) for t in self.turns],
        }
        path.write_text(json.dumps(payload, indent=2))
        return path


class Clock:
    """Monotonic clock relative to session start, for latency measurement."""

    def __init__(self) -> None:
        self._t0 = time.monotonic()

    def now(self) -> float:
        return time.monotonic() - self._t0
