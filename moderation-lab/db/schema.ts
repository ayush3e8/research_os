/**
 * Generalized from the moderator+strategist app this project is descended
 * from: same shape (turn logs, dedup claims, per-conversation cross-turn
 * state), but deliberately NOT tied to that one architecture's fields.
 * `conversationState.state` is an untyped JSON blob so any architecture
 * (baseline, strategist, fan-out, whatever comes next) can stash whatever
 * cross-turn data it needs without the schema assuming its shape.
 */
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
  // Set once, on the first turn seen for this conversation -- lets any
  // architecture compute real elapsed wall-clock time (e.g. for pacing)
  // without ElevenLabs' wire format reliably giving us one.
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  // Untyped on purpose -- see module docstring.
  state: jsonb("state").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

export const architectureAgents = pgTable("architecture_agents", {
  // e.g. "baseline" -- matches the [name] segment in the API route and the
  // key in lib/architectures/registry.ts.
  architecture: text("architecture").primaryKey(),
  elevenlabsAgentId: text("elevenlabs_agent_id").notNull(),
  isCustomLlm: boolean("is_custom_llm").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
