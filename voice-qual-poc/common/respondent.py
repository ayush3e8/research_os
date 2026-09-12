"""Synthetic respondent persona text.

In the default (non-swapped) playground setup, the respondent's LLM is the
ElevenLabs Agent's own natively-selected model (see common/elevenlabs_agent.py),
not called directly by us -- this module just holds the persona prompt
text. In the role-swapped setup (playground/simulate_swapped.py), the same
persona text is used as Claude's system prompt for GPT-Live's client
delegation instead (see common/respondent_brain.py).

RESPONDENT_PERSONA selects which persona file to load:
- "commercial_analytics_lead" (default) -- prompts/respondent_persona.txt,
  a generic oncology-launch persona.
- "rachel_pfizer_director" -- prompts/respondent_persona_rachel.txt, a
  detailed Pfizer market-research-director persona.
"""
import os
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"

_PERSONA_FILES = {
    "commercial_analytics_lead": "respondent_persona.txt",
    "rachel_pfizer_director": "respondent_persona_rachel.txt",
}

PERSONA = os.environ.get("RESPONDENT_PERSONA", "commercial_analytics_lead")
SYSTEM_PROMPT = Path(PROMPTS_DIR / _PERSONA_FILES[PERSONA]).read_text()
