# Voice qual moderation: local ElevenLabs / Cartesia pipelines

This project started as a GPT-Live-1 vs. ElevenLabs Agents comparison.
GPT-Live turned out unreliable in testing (see `archive/gpt_live/` below),
so the voice layer moved to ElevenLabs-only, and the actual work of
testing many different moderator *architectures* (not just voice
providers) moved to a separate, hosted project: **`../moderation-lab/`**.
That's where new architecture/persona/scale work happens now — see its
own README for the current setup and deploy checklist.

What's still here, and still useful:

## Pipeline A (`pipelines/elevenlabs_claude/`)

A full-duplex ElevenLabs Conversational AI Agent, with Claude selected as
its native LLM — ElevenLabs' own hosted runtime handles ASR, turn-taking,
calling Claude, and TTS as one loop; this script just bridges real
mic/speaker audio to it. Confirmed working in real testing. Still the
simplest way to talk to a native-LLM ElevenLabs+Claude moderator locally.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in ANTHROPIC_API_KEY, ELEVENLABS_API_KEY
python -m pipelines.elevenlabs_claude.run
```

Creates (and caches, in `.elevenlabs_agents.json`) an ElevenLabs agent on
first run — check https://elevenlabs.io/app/agents to see or edit it
directly; delete its entry from `.elevenlabs_agents.json` to force
recreation after editing `prompts/moderator_rules.txt`.

## Pipeline B (`pipelines/cartesia_claude/`)

The same setup on Cartesia instead: a Cartesia Managed Agent (Ink-2 ASR +
turn detection, an LLM from Cartesia's catalog, Sonic TTS) as one hosted
loop, with the same moderator prompt, interview guide and transcript
schema as Pipeline A — so a session from either one can be compared
directly. Not yet run against a live Cartesia account.

```bash
# in .env: CARTESIA_API_KEY (and optionally CARTESIA_LLM_MODEL, CARTESIA_VOICE_ID)
python -m pipelines.cartesia_claude.run --list-models   # which LLMs Cartesia offers you
python -m pipelines.cartesia_claude.run
```

Things that differ from Pipeline A:

- **The LLM is Cartesia's, not ours.** Cartesia hosts the model and bills
  for it; no Anthropic key is involved. `CARTESIA_LLM_MODEL` defaults to
  `claude-haiku-4.5`, the Claude model Cartesia's docs name. If the catalog
  doesn't have the model Pipeline A runs (`MODERATOR_MODEL`), use the same
  model on both sides, or the comparison is measuring the LLM too.
- **Pacing is sent differently.** Cartesia has no mid-call context message.
  The pacing rules are appended to the agent's instructions and read the
  `{{interview_started_utc}}` (sent at session start) and
  `{{system__time_utc}}` (filled in by Cartesia before every reply) dynamic
  variables. So the time check refreshes on every turn, instead of every 30s
  as it does in Pipeline A.
- **The agent hangs up by itself** (Cartesia's `end_call` system tool) after
  the closing line. Inactivity check-ins are set to 20s instead of the 8s
  default, so a participant who stops to think doesn't get talked over.
- **`latency_ms` is filled in** on moderator turns: the time from the
  participant's finished transcript arriving to the first agent audio. It
  leaves out Cartesia's own end-of-turn detection, so real perceived latency
  is somewhat higher.

The agent is cached in `.cartesia_agents.json`, one per LLM model; delete
the entry to force recreation after editing the prompt. Each run also
prints the Cartesia `call_id`, which you can look up in the Playground
(Agents → Calls) for Cartesia's own transcript and recording.

## Interview guides

Set `INTERVIEW_GUIDE` in `.env` (default: `biopharma_v1`). Guides live in
`common/guides/`: `sample` (throwaway smoke-test guide), `biopharma_v1`
(Market Research Practices in Biopharma), `biopharma_v2` (AI-Native Market
Research for Biopharma). Add a new one by copying an existing file's
structure.

## Prompts

`prompts/moderator_rules.txt` is Claude's system prompt (loaded by
`common/moderator.py`, filled in via Python's `string.Template`). Edit and
re-run — no code changes needed.

## On the ElevenLabs Agents integration

Schema details in `common/elevenlabs_agent.py` and
`pipelines/elevenlabs_claude/run.py` are drawn from ElevenLabs' docs as of
this writing — check https://elevenlabs.io/docs/eleven-agents if
something doesn't fire as expected. Nothing here needs a public
endpoint/tunnel: this connects *out* to ElevenLabs like an ordinary
client. `ELEVENLABS_TTS_MODEL_ID` defaults to `eleven_v3_conversational`
(ElevenLabs' most expressive real-time model, ~280ms latency) — drop to
`eleven_flash_v2_5` (~75ms) if latency matters more than expressiveness
for what you're testing.

## `archive/gpt_live/`

Everything that depended on OpenAI's GPT-Live-1: the human-mic pipeline
(`archive/gpt_live/pipeline/run.py`), the two GPT-Live-vs-ElevenLabs
playground simulations and their local live-viewer server
(`archive/gpt_live/{simulate,simulate_swapped,server}.py` +
`archive/gpt_live/static/`), the shared wire-protocol helpers
(`gpt_live_protocol.py`), and the two respondent-persona/brain modules
those simulations used (`respondent.py`, `respondent_brain.py`). Kept
rather than deleted in case GPT-Live improves later, but not maintained —
moved here specifically so it doesn't get treated as current guidance.
The persona *prompt text* it used (`prompts/respondent_persona*.txt`) is
still at the top level, since that content is independent of GPT-Live and
worth reusing.

Real, documented findings from that work, still useful context:
GPT-Live didn't reliably stay a passive relay under OpenAI's "client
delegation" mode — it would rephrase/pad delegated content, or
occasionally improvise its own replies without delegating at all,
including a specific pause-vs-delegate failure mode that could spiral into
a repeated-question loop. See `archive/gpt_live/pipeline/run.py`'s and
`archive/gpt_live/gpt_live_protocol.py`'s docstrings/comments for the full
detail if GPT-Live is ever revisited.
