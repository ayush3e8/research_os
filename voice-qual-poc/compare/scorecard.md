# Side-by-side scorecard

Run the same interview guide (`common/interview_guide.py`) through both
pipelines with the same person playing the participant, back to back, then
fill this in immediately while it's fresh.

| Dimension | ElevenLabs + Claude | GPT-Live-1 + Claude | Notes |
|---|---|---|---|
| Perceived response latency (end of your speech → moderator starts talking) | | | pull actual ms from `transcripts/*.json` `latency_ms` field |
| Handles barge-in / interruption | | | full-duplex should win here by design |
| Voice naturalness / prosody | | | subjective 1-5 |
| Turn-taking (does it wait for you to finish, does it interrupt) | | | |
| Follow-up question quality | n/a — same Claude brain both sides | n/a | should be near-identical since reasoning is shared; flag if it *isn't* |
| Recovery from ASR mistakes | | | |
| Cost per 10-min session | $0.30/min ElevenLabs (varies by plan) + Whisper + Claude tokens | $0.05/min GPT-Live-1 + Claude tokens (delegation backend) | fill in your actual plan rates |
| Setup/integration effort | manual turn-taking, 3 services to glue | 1 voice service + delegation event loop | |
| Would you use it for a real study? | | | |

## How to run a session

```bash
cd voice-qual-poc
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in keys

python -m pipelines.elevenlabs_claude.run
python -m pipelines.gpt_live.run
```

Transcripts + latency land in `transcripts/*.json`. Raw GPT-Live wire events
land in `transcripts/gpt_live_debug.jsonl` — useful since the API shipped
2026-09-10 and field names may not exactly match this code yet.
