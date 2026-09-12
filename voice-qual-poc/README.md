# Voice qual moderation: ElevenLabs+Claude vs. GPT-Live-1+Claude

A minimal side-by-side test rig for comparing two voice stacks for an AI
qualitative-research moderator:

- **Pipeline A** (`pipelines/elevenlabs_claude/`) — a full-duplex
  ElevenLabs Conversational AI Agent, with Claude selected as its native
  LLM. ElevenLabs' own hosted runtime handles ASR, turn-taking, calling
  Claude, and TTS as one loop; we just bridge real mic/speaker audio to it.
- **Pipeline B** (`pipelines/gpt_live/`) — OpenAI's GPT-Live-1
  (launched in the API 2026-09-10), a full-duplex speech-to-speech model.
  It owns the mic stream, turn detection, ASR and TTS, and **delegates all
  reasoning to Claude** via its "client delegation" mode — so it's not
  GPT-Live's *language* you're evaluating, only its *voice layer*.

Both pipelines use the same moderator prompt content
(`common/moderator.py` + `common/interview_guide.py`) and select the same
Claude model — but *how* Claude gets called differs, which matters for
what you're actually comparing: Pipeline B calls Claude directly ourselves
(GPT-Live's "client delegation" hands us the task, we call the Anthropic
API, we relay the reply), so we control exactly what Claude sees each
turn, including a dynamic per-turn pacing note. Pipeline A's Claude calls
happen inside ElevenLabs' own hosted runtime — we give it our system
prompt once at agent-creation time, not per turn, so the same dynamic
pacing note is instead sent periodically as a `contextual_update` message
(best-effort, see `pipelines/elevenlabs_claude/run.py`). Keep this
asymmetry in mind: Pipeline B isolates "GPT-Live's voice layer vs.
GPT-Live's language" cleanly; Pipeline A is closer to "ElevenLabs' whole
hosted agent stack" than "just its voice layer with an identical brain."

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

## Run

```bash
python -m pipelines.elevenlabs_claude.run   # full duplex — just talk
python -m pipelines.gpt_live.run            # full duplex — just talk
```

Both create (and cache, in `.elevenlabs_agents.json`/`common/gpt_live_protocol.py`
constants respectively) whatever they need on first run. The ElevenLabs
agent is created once and reused on subsequent runs — check
https://elevenlabs.io/app/agents if you want to see or edit it directly;
delete its entry from `.elevenlabs_agents.json` to force recreation (e.g.
after editing `prompts/moderator_rules.txt`).

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
  - A specific failure mode of this: the participant pauses mid-thought or
    trails off (e.g. "we ended up meeting in the middle, honestly. We..."),
    and instead of delegating, GPT-Live decides on its own that they're not
    really finished and either backchannels ("Okay.", "Mm-hmm.") or
    silently waits — Claude never gets a turn, so nothing new gets asked,
    and the participant (getting no real follow-up) tends to repeat
    themselves, sometimes noticing and naming the loop out loud. The
    delegation policy in `prompts/gpt_live_instructions.txt` now says
    explicitly that a pause like that is still GPT-Live's cue to delegate,
    not to self-prompt or fill it with backchannel — and
    `common/gpt_live_protocol.delegation_stall_watchdog` is a code-level
    backstop: if `GPT_LIVE_STALL_SECONDS` (default 15) passes with no
    delegation while the participant has said something, it sends a
    one-off `session.instructions.append` reminder. This is a mitigation
    for a real, recurring pattern, not a confirmed fix — it hasn't been
    verified against a fresh live run yet, so if the loop still happens,
    the debug jsonl will show whether the nudge fired and whether GPT-Live
    still didn't delegate afterward.
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

## On the ElevenLabs Agents integration

Schema details in `common/elevenlabs_agent.py` and `pipelines/elevenlabs_claude/run.py`
(the WebSocket event names, the `conversation_config` agent-creation
fields, the `contextual_update` pacing mechanism) are drawn from
ElevenLabs' docs as of this writing and, like the GPT-Live integration,
**haven't been verified end to end against a live account** — check
https://elevenlabs.io/docs/eleven-agents if something doesn't fire as
expected. A few things worth knowing regardless:
- Nothing here needs a public endpoint or tunnel: we connect *out* to
  ElevenLabs like an ordinary client (`wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...`),
  we don't host anything ElevenLabs calls into.
- Claude is selected natively via the agent's `prompt.llm` field (e.g.
  `"claude-sonnet-5"`) — no custom-LLM bridge server needed, unlike the
  ElevenLabs custom-LLM integration pattern that requires hosting your own
  WebSocket/HTTP endpoint for them to call.
- Agents are created once and cached in `.elevenlabs_agents.json`
  (gitignored) so repeat runs reuse the same agent instead of cluttering
  your ElevenLabs dashboard with a fresh one each time. Delete an entry to
  force recreation after editing that agent's prompt **or its TTS model** —
  changing `ELEVENLABS_TTS_MODEL_ID` alone does nothing to an
  already-created agent.
- TTS model: `ELEVENLABS_TTS_MODEL_ID` defaults to `eleven_v3_conversational`
  — ElevenLabs' most expressive real-time model for Conversational AI
  agents (~280ms latency), used for both the Pipeline A moderator agent
  and the playground's respondent agent. Plain `eleven_v3` is a
  non-realtime model (Text-to-Dialogue API) and won't work over this
  WebSocket flow. Drop to `eleven_flash_v2_5` if you want to isolate voice
  quality from latency effects (~75ms) instead.

## Playground: automated GPT-Live vs. synthetic respondent

Running this with a human on the mic every time is slow and adds its own
variability (your pacing, energy, phrasing all change run to run). The
playground replaces the human with a synthetic respondent — an ElevenLabs
Conversational AI Agent (Claude as its native LLM, playing a persona) —
bridged to GPT-Live in real time, so you can run many sessions unattended
and watch them live. Both sides are real voice agents doing their own
turn-detection on the (resampled) audio they hear from each other; neither
side of this bridge needs our own "has it stopped talking" heuristics —
that whole class of bug from earlier iterations goes away.

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
  freely, plain text, no placeholders). Currently one fixed persona: a
  Commercial Analytics lead at a pharma company, matching the kind of
  respondent in the real biopharma guides. Edit it and delete the
  `respondent_v1` entry in `.elevenlabs_agents.json` to have it take effect
  (the agent is otherwise cached and reused across runs).
- Claude (the moderator brain, called via GPT-Live's client delegation) is
  fed the respondent agent's *ground-truth* `agent_response` text, not
  GPT-Live's ASR reconstruction of it — this isolates "how does GPT-Live
  behave" from "how good is its ASR," different questions worth testing
  separately. GPT-Live's actual ASR output is still saved
  (`meta.raw_participant_transcript`) for comparison, and so is the
  respondent agent's own ASR of GPT-Live (folded into the same field).
- Each run saves a transcript json + debug jsonl (same format as the human
  pipeline) under `transcripts/playground/`, plus one merged
  `sim_<timestamp>_conversation.wav` — both sides mixed onto one timeline
  at their real capture times (not just concatenated), so a real
  interruption is actually audible as overlapping audio, not silently
  dropped. Listen to a run afterward instead of only reading it.
- CLI-only mode also works without the browser: `python -m playground.simulate --n 5 --minutes 3`.
- This intentionally duplicates some of `pipelines/gpt_live/run.py`'s
  session/delegation logic rather than sharing it, since the two scripts'
  audio I/O differs a lot. The wire-protocol pieces with no audio-hardware
  dependency (constants, `TranscriptBuffer`, event logging) were pulled
  into `common/gpt_live_protocol.py` so both scripts import those, at least.
- Audio between GPT-Live (24kHz) and the ElevenLabs agent (whatever rate
  it reports in `conversation_initiation_metadata`, negotiated at connect
  time) is bridged with a simple linear-interpolation resample
  (`common/elevenlabs_agent.resample_pcm16`) — good enough for this
  purpose, not broadcast quality.

## Next steps once you've run both

- If GPT-Live-1 wins on latency/naturalness as expected, decide whether to
  keep Claude as the reasoning backend (via client delegation, as built
  here) or let GPT-Live delegate to a Responses-managed backend instead.
- If this graduates past a throwaway test, the push-to-talk / polling
  loops here should become a proper barge-in-aware duplex client for
  pipeline A too, or just be retired in favor of GPT-Live if it's the
  clear winner.
