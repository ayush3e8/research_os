"""Loads the active interview guide, selected via the INTERVIEW_GUIDE env
var (default: biopharma_v1). Available guides live in common/guides/:
  - sample        throwaway note-taking-app guide used for pipeline testing
  - biopharma_v1  Market Research Practices in Biopharma (live paid pilot)
  - biopharma_v2  AI-Native Market Research for Biopharma (concept validation)

Both pipelines and common/moderator.py import from this module, not from
common/guides/* directly, so swapping guides never requires touching
pipeline code.
"""
import importlib
import os

_GUIDE_NAME = os.environ.get("INTERVIEW_GUIDE", "biopharma_v1")
_guide = importlib.import_module(f"common.guides.{_GUIDE_NAME}")

STUDY_TOPIC = _guide.STUDY_TOPIC
TARGET_DURATION_MINUTES = _guide.TARGET_DURATION_MINUTES
OPENING_SCRIPT = _guide.OPENING_SCRIPT
CLOSING_SCRIPT = _guide.CLOSING_SCRIPT
GUARDRAILS = _guide.GUARDRAILS
QUESTIONS = _guide.QUESTIONS
