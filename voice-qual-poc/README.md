# Voice qual moderation: ElevenLabs+Claude vs. GPT-Live-1+Claude

A minimal side-by-side test rig for comparing two voice stacks for an AI
qualitative-research moderator:

- **Pipeline A** (`pipelines/elevenlabs_claude/`) — your existing-style
  stack: push-to-talk mic capture → Whisper STT → Claude reasoning →
  ElevenLabs TTS. Turn-taking is manual since nothing here does duplex/VAD.
- **Pipeline B** (`pipelines/gpt_live/`) — OpenAI's GPT-Live-1
  (launched in the API 2026-09-10), a full-duplex speech-to-speech model.
  It owns the mic stream, turn detection, ASR and TTS, and **delegates all
  reasoning to Claude** via its "client delegation" mode — so it's not
  GPT-Live's *language* you're evaluating, only its *voice layer*.

Both pipelines call the exact same moderator brain
(`common/moderator.py` + `common/interview_guide.py`), so any difference in
session quality is attributable to the voice/turn-taking layer, not the
reasoning — that's the controlled variable that makes the comparison fair.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in ANTHROPIC_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY
```

You'll also need `ffplay` (ships with ffmpeg) on your PATH for pipeline A's
audio playback.

## Run

```bash
python -m pipelines.elevenlabs_claude.run   # press Enter to talk, Enter again to stop
python -m pipelines.gpt_live.run            # just talk — it's full duplex
```

Each run writes a transcript with per-turn latency to `transcripts/`. Fill
in `compare/scorecard.md` after running both back to back with the same
participant script.

## On GPT-Live-1's wire format

This shipped in the API the day before this was written, so the event names
in `pipelines/gpt_live/run.py` (`session.start`, `session.input_audio.append`,
`session.delegation.created`, `session.commentary.append`, etc.) are
transcribed from OpenAI's launch docs and **may not be pixel-perfect**.
The script logs every raw inbound/outbound event to
`transcripts/gpt_live_debug.jsonl` — if something doesn't fire as expected,
that log is the fastest way to see what the server actually sent and adjust
field names.

Key design points from the docs worth knowing before you touch this code:
- `delegation.created` carries **no task text**, only an id — you reconstruct
  what the participant said from `session.input_transcript.delta` events
  (that's what `TranscriptBuffer` in `run.py` does).
- Replies go back via `session.commentary.append` (spoken),
  `session.thinking.append` (silent, for progress state), or
  `session.instructions.append` (session-wide steering) — capped at 500
  tokens per append.
- Interrupting GPT-Live's speech does **not** auto-cancel your backend work
  in client delegation mode — if you extend this to handle overlapping
  delegations, you'll need to track that yourself.
- Pricing: GPT-Live-1 is $0.05/min for the voice layer, billed separately
  from whatever backend (Claude, here) does the reasoning.

## Next steps once you've run both

- If GPT-Live-1 wins on latency/naturalness as expected, decide whether to
  keep Claude as the reasoning backend (via client delegation, as built
  here) or let GPT-Live delegate to a Responses-managed backend instead.
- Swap the sample interview guide for a real study script.
- If this graduates past a throwaway test, the push-to-talk / polling
  loops here should become a proper barge-in-aware duplex client for
  pipeline A too, or just be retired in favor of GPT-Live if it's the
  clear winner.
