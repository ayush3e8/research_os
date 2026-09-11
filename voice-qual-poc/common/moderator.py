"""Shared moderator "brain": decides what the moderator says next.

Both pipelines call `next_utterance()` with the same system prompt and the
same growing transcript, so any difference in the resulting session is
attributable to the voice layer (ASR/TTS/turn-taking), not the reasoning.

Backend is swappable via MODERATOR_BACKEND=anthropic|openai (default
anthropic) -- e.g. to test whether GPT-Live's client delegation behaves
differently when the backend it's handing off to is also an OpenAI model.
"""
import os

from common.interview_guide import (
    CLOSING_SCRIPT,
    GUARDRAILS,
    OPENING_SCRIPT,
    QUESTIONS,
    STUDY_TOPIC,
    TARGET_DURATION_MINUTES,
)

BACKEND = os.environ.get("MODERATOR_BACKEND", "anthropic").lower()
MODEL_ANTHROPIC = os.environ.get("MODERATOR_MODEL", "claude-sonnet-5")
MODEL_OPENAI = os.environ.get("MODERATOR_MODEL_OPENAI", "gpt-5.6-terra")


def _format_guide() -> str:
    lines = []
    for i, q in enumerate(QUESTIONS, 1):
        parts = [f"{i}. [{q['topic']}, ~{q.get('target_minutes', '?')} min]"]
        if q.get("verbatim"):
            parts.append(f'Deliver verbatim, do not paraphrase: "{q["ask"]}"')
        else:
            parts.append(q["ask"])
        if q.get("probes"):
            parts.append(f"(probes if needed: {'; '.join(q['probes'])})")
        if q.get("rating"):
            r = q["rating"]
            parts.append(
                f'Also verbally ask them to rate it — "{r["prompt"]}" — {r["scale"]}, '
                f"and record the number they say."
            )
        if q.get("note"):
            parts.append(f"[{q['note']}]")
        lines.append(" ".join(parts))
    return "\n".join(lines)


def _build_system_prompt() -> str:
    guardrails_block = f"\n\nGUARDRAILS — these override every other rule if they conflict:\n{GUARDRAILS}\n" if GUARDRAILS else ""
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
- Follow the guide topics in the order listed — the order itself may be a \
deliberate bias-avoidance design, not just a checklist.
- Items marked "deliver verbatim" must be spoken exactly as written, with no \
paraphrasing — their wording may be legally or compliance reviewed.
- Items with a rating request: ask for the numeric rating out loud as part \
of the conversation (there is no on-screen scale in a voice call), then a \
short "why that number" follow-up if the guide calls for one.
- Pace yourself against the target length using each topic's minute budget \
as a rough guide, spending less time probing once a topic feels covered so \
earlier topics don't crowd out later ones. You'll get a time check before \
each reply — use it to speed up, slow down, or wrap early.
- When the guide is fully covered, or you're told time is nearly up, \
deliver this closing line verbatim: "{CLOSING_SCRIPT}"
{guardrails_block}
Interview guide (topics to cover, in order):
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


def _get_client():
    global _client
    if _client is None:
        if BACKEND == "openai":
            from openai import OpenAI

            _client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        else:
            from anthropic import Anthropic

            _client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


def _call_anthropic(system: str, messages: list[dict]) -> str:
    response = _get_client().messages.create(
        model=MODEL_ANTHROPIC,
        max_tokens=200,
        system=system,
        messages=messages,
    )
    return "".join(block.text for block in response.content if block.type == "text").strip()


def _call_openai(system: str, messages: list[dict]) -> str:
    response = _get_client().chat.completions.create(
        model=MODEL_OPENAI,
        max_tokens=200,
        messages=[{"role": "system", "content": system}, *messages],
    )
    return (response.choices[0].message.content or "").strip()


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
    system = SYSTEM_PROMPT + _pacing_note(elapsed_seconds)

    if BACKEND == "openai":
        return _call_openai(system, messages)
    return _call_anthropic(system, messages)
