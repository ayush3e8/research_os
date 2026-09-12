"""Synthetic respondent "brain": plays the interview participant so GPT-Live
can be tested without a human on the mic every time.

Mirrors common/moderator.py's structure (same shared transcript.py list
format, same swappable-backend pattern) but with roles reversed: here the
participant is "assistant" and the moderator is "user".
"""
import os
from pathlib import Path

BACKEND = os.environ.get("RESPONDENT_BACKEND", "anthropic").lower()
MODEL_ANTHROPIC = os.environ.get("RESPONDENT_MODEL", "claude-sonnet-5")
MODEL_OPENAI = os.environ.get("RESPONDENT_MODEL_OPENAI", "gpt-5.6-terra")

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"
SYSTEM_PROMPT = Path(PROMPTS_DIR / "respondent_persona.txt").read_text()

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


def _call_anthropic(messages: list[dict]) -> str:
    response = _get_client().messages.create(
        model=MODEL_ANTHROPIC,
        max_tokens=200,
        system=SYSTEM_PROMPT,
        messages=messages,
    )
    return "".join(block.text for block in response.content if block.type == "text").strip()


def _call_openai(messages: list[dict]) -> str:
    response = _get_client().chat.completions.create(
        model=MODEL_OPENAI,
        max_completion_tokens=200,
        messages=[{"role": "system", "content": SYSTEM_PROMPT}, *messages],
    )
    return (response.choices[0].message.content or "").strip()


def next_reply(transcript: list[dict]) -> str:
    """transcript: list of {"role": "moderator"|"participant", "text": str},
    same shared format as common/moderator.py -- roles just flip here.

    Returns the respondent's next spoken line. Requires at least one
    moderator turn to react to.
    """
    messages = [
        {"role": "assistant" if t["role"] == "participant" else "user", "content": t["text"]}
        for t in transcript
    ]

    if BACKEND == "openai":
        return _call_openai(messages)
    return _call_anthropic(messages)
