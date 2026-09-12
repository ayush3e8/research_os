"""GPT-Live wire-protocol constants and helpers shared by both
pipelines/gpt_live/run.py (real mic/speaker) and playground/simulate.py
(synthetic respondent). Deliberately has no audio-hardware dependency
(no sounddevice/numpy) so anything importing this doesn't need a real
microphone or speaker to exist on the machine.
"""
import asyncio
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

# Diagnostic toggle for whether the moderator speaks first. Originally
# implemented as a proactive commentary.append with delegation_id=null --
# confirmed via a live "missing_required_parameter: delegation_id" error
# that GPT-Live's API flatly rejects that (there's no reply-without-a-
# delegation path), so send_opening() now steers GPT-Live to say the line
# itself via session.instructions.append instead. Set this false to skip
# the proactive opening and wait for the participant to speak first instead.
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


# Seen in testing: GPT-Live can go quiet on delegating for stretches even
# with the delegation policy above in its instructions -- it fills a
# participant's pause with its own backchannel/judgment instead. Left
# unchecked this spirals (participant gets no real follow-up, repeats
# themselves, notices the loop). This is a mitigation, not a fix for the
# underlying behavior -- it just nudges GPT-Live back on track once it's
# gone quiet on delegating for too long while the participant has said
# something.
STALL_SECONDS = float(os.environ.get("GPT_LIVE_STALL_SECONDS", "15"))


async def delegation_stall_watchdog(ws, buf: TranscriptBuffer, clock, state: dict, debug_log: Path) -> None:
    """Call as a background task once state["last_delegation_time"] exists
    and is kept updated (set it at session start, and again every time
    session.delegation.created fires). Sends a session.instructions.append
    reminder -- session-wide steering, per OpenAI's delegation docs -- if
    too long has passed since the last delegation while the participant has
    said something GPT-Live hasn't handed off yet."""
    nudged_since_last_delegation = False
    while True:
        await asyncio.sleep(5.0)
        stalled = clock.now() - state["last_delegation_time"] > STALL_SECONDS
        if stalled and buf.pending_participant_text() and not nudged_since_last_delegation:
            nudge = {
                "type": "session.instructions.append",
                "content": (
                    "You haven't delegated in a while even though the participant has said "
                    "something. If they've paused at all -- even mid-thought or trailing off -- "
                    "delegate now instead of backchanneling or prompting them to continue "
                    "yourself; that judgment belongs to the backend."
                ),
            }
            try:
                await ws.send(json.dumps(nudge))
                log_raw_event(debug_log, "send", nudge)
            except Exception:
                pass
            nudged_since_last_delegation = True
        elif not stalled:
            nudged_since_last_delegation = False
