/**
 * Generalized from the moderator+strategist app this project is descended
 * from: same shape (turn logs, dedup claims, per-conversation cross-turn
 * state), but deliberately NOT tied to that one architecture's fields.
 * `conversationState.state` is an untyped JSON blob so any architecture
 * (baseline, strategist, fan-out, whatever comes next) can stash whatever
 * cross-turn data it needs without the schema assuming its shape.
 */
import { boolean, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const turnLogs = pgTable("turn_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  architecture: text("architecture").notNull(),
  // Free-form label for which part of an architecture produced this row --
  // "moderator" for the single call every architecture has, but a
  // multi-call architecture (strategist, fan-out advisors) can log each of
  // its own calls under its own label for post-hoc comparison.
  callType: text("call_type").notNull().default("moderator"),
  conversationFingerprint: text("conversation_fingerprint"),
  model: text("model").notNull(),
  requestSystem: text("request_system").notNull(),
  requestMessages: jsonb("request_messages").notNull(),
  requestTools: jsonb("request_tools").notNull().default([]),
  rawRequestBody: jsonb("raw_request_body").notNull(),
  responseText: text("response_text"),
  responseToolCalls: jsonb("response_tool_calls").notNull().default([]),
  stopReason: text("stop_reason"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const turnClaims = pgTable("turn_claims", {
  fingerprint: text("fingerprint").primaryKey(),
  status: text("status").notNull(), // "in_progress" | "done"
  responseText: text("response_text"),
  responseToolCalls: jsonb("response_tool_calls"),
  stopReason: text("stop_reason"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationState = pgTable("conversation_state", {
  fingerprint: text("fingerprint").primaryKey(),
  architecture: text("architecture").notNull(),
  // Which guide this specific conversation is running -- picked per call
  // from the manual-test UI (see lib/guide.ts's module docstring for why
  // guide is a per-call choice, not a fixed deploy-time constant), baked
  // into the webhook URL at provision time and read off it on the first
  // turn. Defaulted to "everyday" so historical rows from before this
  // column existed (when "everyday" was the only guide ever actually
  // running) stay valid.
  guide: text("guide").notNull().default("everyday"),
  // Set once, on the first turn seen for this conversation -- lets any
  // architecture compute real elapsed wall-clock time (e.g. for pacing)
  // without ElevenLabs' wire format reliably giving us one.
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  // Untyped on purpose -- see module docstring.
  state: jsonb("state").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // True for a conversation driven by lib/simulation (an LLM-played
  // respondent, no ElevenLabs/voice involved at all) rather than a real
  // call. The turn-logging/state/evaluation plumbing is fully shared
  // between the two on purpose (see simulationRuns' docstring) -- this is
  // the one flag that keeps synthetic test data out of real-call reporting
  // without needing a second copy of any of that plumbing.
  isSimulation: boolean("is_simulation").notNull().default(false),
});

export const personas = pgTable("personas", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Continuous axis values, e.g. {"chatty": 0.8, "fraudLike": 0.1,
  // "backgroundMatch": 0.6, "backgroundNoise": 0.0, "accent": "none"}.
  // Untyped so new axes can be added without a migration.
  axisValues: jsonb("axis_values").notNull().default({}),
  // The LLM-generated base profile (bio, background, speaking style) --
  // generated once and never regenerated, so every architecture this
  // persona is tested against faces the identical instance.
  generatedProfile: text("generated_profile").notNull(),
  // Final assembled system-prompt text (profile + axis-driven personality
  // instructions), cached here so agent creation doesn't regenerate it.
  systemPrompt: text("system_prompt").notNull(),
  elevenlabsVoiceId: text("elevenlabs_voice_id"),
  elevenlabsAgentId: text("elevenlabs_agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A configured, launchable set of text-only simulated interviews --
// lib/simulation/* runs each architecture in `architectures` against each
// persona in `personaIds`, `repeatsPerCombo` times, producing one
// simulationRuns row per (architecture, persona, repeat). Not a live call
// at all: no ElevenLabs, no audio -- an LLM plays the respondent using the
// persona's prompt, and the architecture under test runs through the exact
// same runArchitectureTurn() the real webhook uses (see that function's
// docstring), so a simulated interview is identical to a real one except
// for the spoken components. Timing/pacing fidelity is deliberately out of
// scope for now -- elapsed time during a run is real wall-clock (which
// runs far faster than a real call would take to speak aloud); a
// retroactive words-per-minute + latency estimate is the intended way to
// reconstruct "how long would this actually have taken," not a live fake
// clock fed into generation.
export const simulationBatches = pgTable("simulation_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  guide: text("guide").notNull(),
  architectures: jsonb("architectures").notNull(), // string[]
  personaIds: jsonb("persona_ids").notNull(), // uuid[] (as strings)
  repeatsPerCombo: integer("repeats_per_combo").notNull().default(1),
  // Hard safety cap, turn count not simulated minutes (see module
  // docstring) -- end_call gating has broken silently more than once in
  // real testing (see lib/architectures/blindmod.ts's WRAP history), and
  // an ungated batch run burns real API spend across every combination in
  // the batch, not just one call, if an architecture never signals done.
  maxTurns: integer("max_turns").notNull().default(60),
  status: text("status").notNull().default("pending"), // "pending" | "running" | "done" | "failed"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const simulationRuns = pgTable("simulation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").notNull(),
  architecture: text("architecture").notNull(),
  guide: text("guide").notNull(),
  personaId: uuid("persona_id").notNull(),
  repeatIndex: integer("repeat_index").notNull(),
  // The conversationState/turnLogs/evaluations key this run writes under --
  // synthetic (no real ElevenLabs conversation behind it), but otherwise
  // used exactly like a real one so the existing evaluation pipeline and
  // /evaluations UI work on simulation data with no changes.
  conversationFingerprint: text("conversation_fingerprint").notNull().unique(),
  status: text("status").notNull().default("pending"), // "pending" | "running" | "done" | "failed"
  turnCount: integer("turn_count").notNull().default(0),
  endReason: text("end_reason"), // "end_call" | "max_turns" | "error" -- null while still running
  // The running Anthropic.MessageParam[] transcript -- authoritative state
  // the step driver reads and appends to each call. A real call gets this
  // resent by ElevenLabs every turn; nothing plays that role here, so this
  // run owns it directly instead of re-deriving it from turn_logs.
  transcript: jsonb("transcript").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const architectureAgents = pgTable(
  "architecture_agents",
  {
    // e.g. "baseline" -- matches the [name] segment in the API route and
    // the key in lib/architectures/registry.ts.
    architecture: text("architecture").notNull(),
    // Each (architecture, guide) pair gets its own ElevenLabs agent, baked
    // with that guide's opening line and the guide name in its webhook URL
    // -- see lib/guide.ts's module docstring for why guide is picked per
    // call rather than fixed. Defaulted for the same historical reason as
    // conversation_state.guide.
    guide: text("guide").notNull().default("everyday"),
    elevenlabsAgentId: text("elevenlabs_agent_id").notNull(),
    isCustomLlm: boolean("is_custom_llm").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.architecture, table.guide] })]
);

// Call-health signals that can't be derived after the fact from turn_logs
// alone -- genuine gaps found while designing this: a fallback response
// (architecture.run() threw) was never logged at all before this; a
// turn-dedup conflict (ElevenLabs sending >1 request for one respondent
// turn) only ever left a trace as the *winner's* row in turn_claims, with
// no record a conflict happened at all; and strategist/fanout's after()-
// scheduled background reasoning calls had no observable trace when they
// silently didn't run (found on a real test call -- zero of their own
// turn_logs rows, no error anywhere reachable from this environment).
// This table is that missing record, written at the point each event
// actually occurs (the webhook route for fallback/turn_conflict, each
// architecture's background-call functions for background_reasoning_*).
export const callHealthEvents = pgTable("call_health_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  // "fallback" | "turn_conflict" | "background_reasoning_started" | "background_reasoning_failed"
  // | "live_reasoning_started" | "live_reasoning_failed" (livefanout's synchronous advisors)
  eventType: text("event_type").notNull(),
  conversationFingerprint: text("conversation_fingerprint"),
  architecture: text("architecture").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Raw ElevenLabs post_call_transcription webhook deliveries (see
// app/api/webhooks/elevenlabs-post-call/route.ts). This is the only source
// of real ASR + TTS timing -- our own turn_logs.latency_ms only ever
// measured our webhook's own processing slice, never the silence the
// respondent actually experienced before/after it. conversationFingerprint
// is resolved after the fact (ElevenLabs' request to our custom-LLM
// webhook carries no conversation_id in its body -- confirmed against a
// real logged request -- so there's no shared key at write time) by
// matching this event's agent_id to architecture_agents and its
// start_time_unix_secs to the closest conversation_state.first_seen_at;
// null until that match succeeds.
export const postCallEvents = pgTable("post_call_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Signature verification failing (or the payload not parsing) is logged
  // as its own row with verified=false rather than a bare 401 -- this
  // session has no Vercel log access, so without this a signature failure
  // and "ElevenLabs never called at all" are indistinguishable from the DB
  // alone. elevenlabsConversationId/agentId are nullable for exactly that
  // case: a rejected or unparseable request may not have gotten far enough
  // to know either.
  verified: boolean("verified").notNull(),
  elevenlabsConversationId: text("elevenlabs_conversation_id"),
  agentId: text("agent_id"),
  architecture: text("architecture"),
  conversationFingerprint: text("conversation_fingerprint"),
  startTimeUnixSecs: integer("start_time_unix_secs"),
  callDurationSecs: integer("call_duration_secs"),
  // The transcript array from the payload (role, message, time_in_call_secs,
  // conversation_turn_metrics per turn) -- kept separately from the full
  // raw payload for cheap querying without the audio/analysis blobs.
  transcript: jsonb("transcript").notNull().default([]),
  rawPayload: jsonb("raw_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Production moderation-quality evaluation for a completed call. Built after
// three reliability experiments (see the eval-reliability-experiment* routes)
// found: (1) atomic/boolean judgments are far more reproducible than
// holistic scores, (2) bundling a *few* booleans for one dimension is safe
// but bundling many unrelated dimension scores into one call is not, (3)
// scoring must never be all-or-nothing -- one failed per-turn check should
// shrink that dimension's sample, not null the whole evaluation. `turnChecks`
// keeps every individual per-turn LLM call's raw result (flags + quote +
// reasoning) so a score is always traceable back to its evidence, the same
// standard the reliability artifact held judge output to.
export const evaluations = pgTable("evaluations", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationFingerprint: text("conversation_fingerprint").notNull(),
  architecture: text("architecture").notNull(),
  status: text("status").notNull().default("running"), // "running" | "complete" | "failed"
  // Per-dimension {score, ...supporting counts} -- see lib/evaluation/aggregate.ts
  // for the exact deterministic formula behind each one.
  dimensionScores: jsonb("dimension_scores").notNull().default({}),
  overallScore: real("overall_score"),
  // Every individual per-turn check's raw result, kept even when malformed
  // (malformed: true) so the eval is auditable turn-by-turn, not just as an
  // aggregate number.
  turnChecks: jsonb("turn_checks").notNull().default([]),
  deterministicMetrics: jsonb("deterministic_metrics").notNull().default({}),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// One-off table for the LLM-judge reliability experiment
// (scripts/eval-reliability-experiment.js / app/api/admin/eval-reliability-experiment) --
// NOT part of the real evaluations schema (that comes after this experiment
// informs the design). Safe to drop once the experiment's done informing
// the real framework.
export const evalReliabilityRuns = pgTable("eval_reliability_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  testName: text("test_name").notNull(),
  runIndex: integer("run_index").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
