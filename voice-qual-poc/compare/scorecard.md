# Side-by-side scorecard

Run the same interview guide (`INTERVIEW_GUIDE` in `.env`) through both
pipelines, back to back, with the same person playing the participant.
Fill this in right after, while it's fresh.

| Dimension | A: ElevenLabs + Claude | B: Cartesia + Claude | Notes |
|---|---|---|---|
| Perceived response latency (end of your speech → moderator starts talking) | | | B logs `latency_ms` in `transcripts/cartesia_claude_*.json`, but it leaves out end-of-turn detection, so it reads low. A doesn't log it yet, so time both by feel or from a recording |
| Handles barge-in / interruption | | | both full-duplex; B marks cut-off moderator turns `[interrupted]` |
| Voice naturalness / prosody | | | subjective 1-5 (A: `eleven_v3_conversational`, B: Sonic) |
| Turn-taking (does it wait for you to finish, does it interrupt) | | | watch for cutting in on thinking pauses |
| ASR accuracy on domain terms (drug names, company names) | | | neither has keyterms configured yet |
| Pacing / wraps up on time | | | A: time check every 30s via `contextual_update`; B: re-rendered into the instructions every turn |
| Follow-up question quality | | | same prompt both sides. Only comparable if both run the same LLM (check `meta.model` in each transcript) |
| Cost per 10-min session | | | fill in your actual plan rates. Cartesia LLM usage is free until 2026-10-01 |
| Would you use it for a real study? | | | |

## How to run a session

```bash
cd voice-qual-poc
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in keys

python -m pipelines.elevenlabs_claude.run
python -m pipelines.cartesia_claude.run
```

Transcripts land in `transcripts/*.json`, in the same schema for both.
