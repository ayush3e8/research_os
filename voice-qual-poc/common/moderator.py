"""Shared moderator "brain": Claude decides what the moderator says next.

Both pipelines call `next_utterance()` with the same system prompt and the
same growing transcript, so any difference in the resulting session is
attributable to the voice layer (ASR/TTS/turn-taking), not the reasoning.
"""
import os

from anthropic import Anthropic

from common.interview_guide import (
    CLOSING_SCRIPT,
    OPENING_SCRIPT,
    QUESTIONS,
    STUDY_TOPIC,
    TARGET_DURATION_MINUTES,
)

MODEL = os.environ.get("MODERATOR_MODEL", "claude-sonnet-5")


def _format_guide() -> str:
    lines = []
    for i, q in enumerate(QUESTIONS, 1):
        probes = "; ".join(q["probes"])
        lines.append(f"{i}. [{q['topic']}] {q['ask']} (probes if needed: {probes})")
    return "\n".join(lines)


def _build_system_prompt() -> str:
    return f"""You are a qualitative research moderator conducting a live \
spoken interview. Study topic: {STUDY_TOPIC}. Target length: \
{TARGET_DURATION_MINUTES} minutes total.

Rules:
- You are speaking out loud. Every reply must be 1-3 short sentences, plain \
spoken language, no lists or markdown.
- Ask one question at a time. Never stack multiple questions in one turn.
- Follow up on specifics the participant mentions before moving to the next \
guide question. Prefer "tell me more about that" / "what happened next" over \
leading or yes/no questions.
- Do not suggest answers, do not evaluate the product, do not break character.
- Use the interview guide as a checklist, not a script — cover each topic at \
your own pace based on what the participant says.
- Pace yourself against the target length: roughly divide the time across \
the guide topics below, spending less time probing once a topic feels \
covered so earlier topics don't crowd out later ones. You'll get a time \
check before each reply — use it to speed up, slow down, or wrap early.
- When the guide is fully covered, or you're told time is nearly up, \
deliver this closing line verbatim: "{CLOSING_SCRIPT}"

Interview guide (topics to cover, in order, with optional probes):
{_format_guide()}

Opening line to use as your very first turn, verbatim: "{OPENING_SCRIPT}"
"""


SYSTEM_PROMPT = _build_system_prompt()


def _pacing_note(elapsed_seconds: float) -> str:
    elapsed_min = elapsed_seconds / 60
    remaining_min = TARGET_DURATION_MINUTES - elapsed_min

    if remaining_min <= 2:
        urgency = (
            "Time is essentially up. Wrap immediately: skip remaining probes "
            "and deliver the closing line now, even if the guide isn't fully covered."
        )
    elif remaining_min <= 6:
        urgency = (
            "Time is running short. Prioritize topics not yet touched over "
            "further probing on ones already covered."
        )
    else:
        urgency = "No pacing concern yet — proceed normally."

    return (
        f"\n\n[TIME CHECK — not spoken aloud: {elapsed_min:.1f} of "
        f"{TARGET_DURATION_MINUTES} minutes elapsed, about {max(remaining_min, 0):.1f} "
        f"remaining. {urgency}]"
    )

_client = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


def next_utterance(transcript: list[dict], elapsed_seconds: float = 0.0) -> str:
    """transcript: list of {"role": "moderator"|"participant", "text": str}.
    elapsed_seconds: time since the interview started, for pacing against
    TARGET_DURATION_MINUTES.

    Returns the moderator's next spoken line. If transcript is empty,
    returns the opening line without calling the model.
    """
    if not transcript:
        return OPENING_SCRIPT

    messages = [
        {"role": "assistant" if t["role"] == "moderator" else "user", "content": t["text"]}
        for t in transcript
    ]

    response = _get_client().messages.create(
        model=MODEL,
        max_tokens=200,
        system=SYSTEM_PROMPT + _pacing_note(elapsed_seconds),
        messages=messages,
    )
    return "".join(block.text for block in response.content if block.type == "text").strip()
