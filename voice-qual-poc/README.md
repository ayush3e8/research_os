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
The brain also paces itself against each guide's target length (a silent
per-turn time-check nudges it to prioritize uncovered topics as time runs
low, and to wrap to the closing line with ~2 min left).

## Interview guides

Set `INTERVIEW_GUIDE` in `.env` to pick which guide runs (default:
`biopharma_v1`). Guides live in `common/guides/`:

- `sample` — throwaway note-taking-app guide, useful for quick pipeline smoke tests
- `biopharma_v1` — Market Research Practices in Biopharma (20 min, sponsor-blind, live paid pilot)
- `biopharma_v2` — AI-Native Market Research for Biopharma (25 min, concept/demand validation)

The two real guides carry per-question time budgets, guardrails (injected
into the moderator's system prompt as hard constraints), rating-scale
questions (asked verbally since there's no tap UI in a voice call), and
`verbatim` items whose exact wording must be spoken unparaphrased — notably
v1's sponsor-blind reveal. Add a new guide by copying one of these files'
structure and pointing `INTERVIEW_GUIDE` at its module name.

## Prompts

The two "meta" prompts (not guide-specific content) live as plain text
files in `prompts/`, so you can edit prompt wording without touching
Python:

- `prompts/moderator_rules.txt` — Claude's system prompt (how to behave as
  a moderator: pacing, verbatim items, rating questions, etc). Loaded by
  `common/moderator.py` and filled in with `$study_topic`,
  `$target_duration_minutes`, `$closing_script`, `$guardrails_block`,
  `$guide`, `$opening_script` — keep those placeholders if you edit it.
- `prompts/gpt_live_instructions.txt` — GPT-Live's `instructions` field
  (persona, backchannel/interruption/silence policies, the delegation
  policy). Loaded by `pipelines/gpt_live/run.py`, filled in with
  `$study_topic` only.

Edit either file and re-run — no code changes needed. Both use Python's
`string.Template` (`$name` substitution), so a literal `$` in your prompt
text needs to be written as `$$`.

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
`transcripts/gpt_live_debug_<timestamp>.jsonl` (one file per run, matching
the transcript json's timestamp) — if something doesn't fire as expected,
that log is the fastest way to see what the server actually sent and adjust
field names.

Two behaviors worth knowing about, found by actually running this against
the live API:
- GPT-Live doesn't reliably stay a passive relay even in "client
  delegation" mode — it can rephrase/pad what you send it, or occasionally
  respond on its own judgment without delegating at all. The saved JSON's
  `meta.raw_participant_transcript`/`raw_moderator_transcript` fields
  capture what was *actually* said (reconstructed from transcript deltas),
  separately from the `turns` list (which only captures Claude-authored
  content) — diff the two if a session feels off.
- There's no documented "finished speaking" event, so the auto hang-up
  (`close_after_speaking` in `run.py`) waits for output audio to go quiet
  for ~1.2s as a heuristic once Claude delivers the closing line. Tune that
  delay if it cuts off early or lingers.

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

## Playground: automated GPT-Live vs. synthetic respondent

Running this with a human on the mic every time is slow and adds its own
variability (your pacing, energy, phrasing all change run to run). The
playground replaces the human with a synthetic respondent — an LLM persona
+ ElevenLabs TTS — so you can run many sessions unattended and watch them
live.

```bash
python -m playground.server
```

Then open `playground/static/index.html` directly in a browser (double-click
it, or open its `file://` path) — it connects to `ws://localhost:8765`.
Everything runs locally; no API keys ever reach the browser, only the local
page talks to the local server. From there: set a time cap (minutes), then
"Run 1 simulation" or "Run batch of N" — the live transcript streams in as
it happens, color-coded by speaker, with a summary (delegation count,
duration, how it ended) once each run finishes.

Design notes:
- The respondent persona lives in `prompts/respondent_persona.txt` (edit
  freely, same `string.Template`-free plain text as the other prompts —
  this one has no placeholders). Currently one fixed persona: a Commercial
  Analytics lead at a pharma company, matching the kind of respondent in
  the real biopharma guides.
- Claude (the moderator brain) is fed the respondent's *ground-truth*
  generated text, not GPT-Live's ASR reconstruction of it — this isolates
  "how does GPT-Live behave" from "how good is its ASR," which are
  different questions worth testing separately. GPT-Live's actual ASR
  output is still saved (`meta.raw_participant_transcript`) if you want to
  check transcription accuracy on the side.
- Each run saves a transcript json + debug jsonl (same format as the human
  pipeline) under `transcripts/playground/`, plus two `.wav` files (GPT-Live's
  actual voice output, and the synthetic respondent's) so you can listen to
  a run afterward instead of only reading it.
- CLI-only mode also works without the browser: `python -m playground.simulate --n 5 --minutes 3`.
- This intentionally duplicates some of `pipelines/gpt_live/run.py`'s
  session/delegation logic rather than sharing it, since the two scripts'
  audio I/O differs a lot (real mic/speaker vs. synthetic respondent).
  The wire-protocol pieces with no audio-hardware dependency (constants,
  `TranscriptBuffer`, event logging) were pulled into
  `common/gpt_live_protocol.py` so both scripts import those, at least.

## Next steps once you've run both

- If GPT-Live-1 wins on latency/naturalness as expected, decide whether to
  keep Claude as the reasoning backend (via client delegation, as built
  here) or let GPT-Live delegate to a Responses-managed backend instead.
- If this graduates past a throwaway test, the push-to-talk / polling
  loops here should become a proper barge-in-aware duplex client for
  pipeline A too, or just be retired in favor of GPT-Live if it's the
  clear winner.
