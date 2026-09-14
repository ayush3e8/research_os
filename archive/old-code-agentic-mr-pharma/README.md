# Archived reference: old-code-agentic-mr-pharma moderator+strategist implementation

Copied from `ayush3e8/old-code-agentic-mr-pharma`, branch `claude/eager-einstein-v5sc16`,
commit `579d979d4ffadcdea2ab8b44ab2488d89b7d9012` (2026-09-08, "Build written quant survey
+ voice follow-on for physician participation study").

This directory is a **reference-only copy** of the source files that implement that repo's
live voice-interview "moderator + strategist" (two-persona) architecture, preserved under
their original relative paths (prefixed with `archive/old-code-agentic-mr-pharma/`) so they
can be diffed and read alongside the new implementation being built in this repo. Nothing
here has been modified, refactored, or ported — it is copied verbatim for comparison. Do not
import or build against these files.

Note: this repo's own history briefly had a *different* strategist design (a `topic_covered`
ElevenLabs client tool + `lib/interview-strategist-agent.ts`, built Jul 7) that crashed live
calls and was pulled off the agent the same day, then fully deleted on Jul 20 once superseded.
It is not included here since it no longer exists in the source tree at the copied commit —
only the design that replaced it (the pipelined "live directive" strategist below) is live
and copied.

## Files

- `app/api/webhooks/elevenlabs/custom-llm/chat/completions/route.ts` — the moderator itself:
  the custom-LLM webhook ElevenLabs calls on every conversational turn. This is also where the
  strategist is invoked and its output consumed.
- `lib/live-directive-agent.ts` — the strategist: `generateLiveDirective()` and its system/task
  prompts (`STRATEGIST_TASK_PROMPT`), which produce a one-line "directive" (what the moderator
  should do next) plus a compact running summary, given the full conversation so far.
- `lib/turn-dedup.ts` — `claimTurn()` / `waitForTurnResult()` / `recordTurnResult()`: exact-match
  request deduplication so ElevenLabs' duplicate/overlapping webhook calls for one human turn
  don't each trigger an independent (and possibly divergent) moderator + strategist run.
- `lib/system-prompt.ts` — the moderator's static system prompt (`buildSystemPrompt`,
  `buildResumeSystemPrompt`, pacing/conversation-skills instructions, etc.) that the webhook
  sends to Claude alongside the per-turn injected directive.
- `db/schema.ts` — full Drizzle schema, included for the three tables that carry state between
  the moderator and strategist: `llmTurnLogs` (per-turn request/response audit log, tagged
  `call_type: "moderator" | "strategist"`), `liveDirectiveCache` (the strategist's cached
  directive, keyed by a conversation fingerprint), and `liveTurnClaims` (the turn-dedup claim
  table).
- `db/migrations/0016_add_llm_turn_logs.sql`, `0017_add_llm_turn_logs_call_type.sql`,
  `0018_add_live_directive_cache.sql`, `0020_fuzzy_pete_wisdom.sql` — the migrations that
  created/extended the three tables above.
- `db/simulate-two-persona.ts`, `db/simulate-alt-moderator.ts` — offline replay harnesses used
  to test the moderator+strategist pipeline against real historical transcripts before deploying
  changes to the live webhook.

## Where the trigger logic actually lives

The moderator+strategist handoff is **pipelined, not blocking**: on turn N the moderator
(inside `route.ts`'s `POST()`) reads whatever directive the strategist cached during turn N-1
(a fast `live_directive_cache` DB lookup, never a live Claude call) and responds immediately —
so the critical path is a single Claude call. Only once the moderator's response has already
been sent does the webhook fire off a background strategist call (`generateLiveDirective()` in
`lib/live-directive-agent.ts`, via Next's `after()`) against the now-current full history, which
writes a fresh directive to `live_directive_cache` for turn N+1 to read. The strategist only
starts running at all once the translated message count exceeds `TRUNCATE_THRESHOLD` (12); below
that, the webhook behaves as a single-persona moderator with zero added latency or strategist
calls. `route.ts`'s `filterModeratorTools()` uses the current directive text (or its absence past
the threshold) to decide whether `end_call` is even offered to the moderator that turn — the
strategist, not the moderator, holds authority over ending the call once it's active. All of this
sits behind `lib/turn-dedup.ts`'s claim/wait/mirror logic, which runs first in `POST()` so that
ElevenLabs' duplicate requests for one human turn share a single moderator+strategist run instead
of each triggering their own.
