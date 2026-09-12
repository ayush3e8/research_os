"""Respondent "brain" for the role-swapped playground
(playground/simulate_swapped.py): decides what the *respondent* says next,
mirroring common/moderator.py's next_utterance() but for the other side of
the conversation.

Used when GPT-Live plays the respondent (voiced via client delegation) and
an ElevenLabs Agent plays the moderator (guide-driven, same setup as
pipelines/elevenlabs_claude/run.py). Message roles are the mirror image of
next_utterance(): the moderator's questions are "user" turns, the
respondent's own prior answers are "assistant" turns.

No pacing/guide logic here -- unlike the moderator, the respondent isn't
driving toward a target duration or a fixed question list, just answering
in character.
"""
import os

from common.respondent import SYSTEM_PROMPT

MODEL = os.environ.get("RESPONDENT_MODEL", "claude-sonnet-5")

_client = None


def _get_client():
    global _client
    if _client is None:
        from anthropic import Anthropic

        _client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


def next_response(transcript: list[dict]) -> str:
    """transcript: list of {"role": "moderator"|"participant", "text": str},
    same shape as common/moderator.py uses -- "participant" here means this
    respondent's own prior turns.

    Returns the respondent's next spoken line."""
    messages = [
        {"role": "assistant" if t["role"] == "participant" else "user", "content": t["text"]}
        for t in transcript
    ]
    response = _get_client().messages.create(
        model=MODEL,
        max_tokens=300,
        system=SYSTEM_PROMPT,
        messages=messages,
    )
    return "".join(block.text for block in response.content if block.type == "text").strip()
