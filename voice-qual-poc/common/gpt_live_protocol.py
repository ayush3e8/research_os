"""GPT-Live wire-protocol constants and helpers shared by both
pipelines/gpt_live/run.py (real mic/speaker) and playground/simulate.py
(synthetic respondent). Deliberately has no audio-hardware dependency
(no sounddevice/numpy) so anything importing this doesn't need a real
microphone or speaker to exist on the machine.
"""
import json
import os
import time
from pathlib import Path
from string import Template

from common.transcript_log import TRANSCRIPTS_DIR

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"
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
