"""Synthetic respondent persona text.

The respondent's LLM is now the ElevenLabs Agent's own natively-selected
model (see common/elevenlabs_agent.py), not called directly by us the way
common/moderator.py calls Claude for GPT-Live's client delegation -- this
module just holds the persona prompt text.
"""
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"
SYSTEM_PROMPT = Path(PROMPTS_DIR / "respondent_persona.txt").read_text()
