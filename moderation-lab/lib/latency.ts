/**
 * Correlates a raw post_call_events row to one of our conversations, then
 * computes real per-turn latency legs from it. ElevenLabs' request to our
 * custom-LLM webhook carries no conversation_id in its body (confirmed
 * against a real logged request), so there's no shared key at write time --
 * correlation instead matches agent_id -> architecture (architecture_agents)
 * and start_time_unix_secs -> the closest conversation_state.first_seen_at
 * within a tolerance window.
 *
 * Leg semantics, honestly scoped to what the data actually supports: the
 * gap between a user transcript entry's time_in_call_secs and the
 * following agent entry's is the FULL round trip the respondent
 * experienced (ASR finalize -> our processing -> TTS start) -- exactly the
 * "full thing" latency that matters. Our own turn_logs.latency_ms gives the
 * processing leg directly. What's left (round trip minus our processing)
 * is reported as one combined "elevenlabs overhead" leg (ASR + TTS) rather
 * than a fabricated split between them -- the payload doesn't document
 * precisely enough what time_in_call_secs marks per role to claim more
 * precision than that.
 */
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { architectureAgents, conversationState, postCallEvents, turnLogs } from "@/db/schema";
import type { PostCallTranscriptEntry } from "./postcall-webhook";

const CORRELATION_TOLERANCE_SECS = 180;

export async function correlatePostCallEvent(postCallEventId: string): Promise<void> {
  const [event] = await db.select().from(postCallEvents).where(eq(postCallEvents.id, postCallEventId));
  if (!event || event.conversationFingerprint) return;

  const [agentRow] = await db
    .select()
    .from(architectureAgents)
    .where(eq(architectureAgents.elevenlabsAgentId, event.agentId));
  if (!agentRow) return;

  if (!event.startTimeUnixSecs) return;
  const startAt = new Date(event.startTimeUnixSecs * 1000);
  const lowerBound = new Date(startAt.getTime() - CORRELATION_TOLERANCE_SECS * 1000);
  const upperBound = new Date(startAt.getTime() + CORRELATION_TOLERANCE_SECS * 1000);

  const candidates = await db
    .select()
    .from(conversationState)
    .where(
      and(
        eq(conversationState.architecture, agentRow.architecture),
        gte(conversationState.firstSeenAt, lowerBound),
        lte(conversationState.firstSeenAt, upperBound)
      )
    );
  if (candidates.length === 0) return;

  const closest = candidates.reduce((best, c) =>
    Math.abs(c.firstSeenAt.getTime() - startAt.getTime()) < Math.abs(best.firstSeenAt.getTime() - startAt.getTime())
      ? c
      : best
  );

  await db
    .update(postCallEvents)
    .set({ conversationFingerprint: closest.fingerprint, architecture: agentRow.architecture })
    .where(eq(postCallEvents.id, postCallEventId));
}

export type LatencyLeg = {
  turnIndex: number;
  ourProcessingMs: number | null;
  totalRoundTripMs: number;
  elevenlabsOverheadMs: number | null;
};

export type CallLatencySummary = {
  conversationFingerprint: string;
  legs: LatencyLeg[];
  totalP50Ms: number | null;
  totalP95Ms: number | null;
  totalMaxMs: number | null;
  ourProcessingMeanMs: number | null;
  elevenlabsOverheadMeanMs: number | null;
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

export async function computeCallLatency(conversationFingerprint: string): Promise<CallLatencySummary | null> {
  const [event] = await db
    .select()
    .from(postCallEvents)
    .where(eq(postCallEvents.conversationFingerprint, conversationFingerprint))
    .orderBy(desc(postCallEvents.createdAt));
  if (!event) return null;

  const transcript = event.transcript as PostCallTranscriptEntry[];
  const ourTurns = await db
    .select({ latencyMs: turnLogs.latencyMs })
    .from(turnLogs)
    .where(and(eq(turnLogs.conversationFingerprint, conversationFingerprint), eq(turnLogs.callType, "moderator")))
    .orderBy(asc(turnLogs.createdAt));

  const legs: LatencyLeg[] = [];
  let agentTurnIndex = 0;
  for (let i = 0; i < transcript.length; i++) {
    if (transcript[i].role !== "agent" || i === 0) continue;
    const prevUser = [...transcript.slice(0, i)].reverse().find((t) => t.role === "user");
    if (!prevUser) continue;
    const roundTripMs = Math.max(0, (transcript[i].time_in_call_secs - prevUser.time_in_call_secs) * 1000);
    const ourProcessingMs = ourTurns[agentTurnIndex]?.latencyMs ?? null;
    legs.push({
      turnIndex: agentTurnIndex,
      ourProcessingMs,
      totalRoundTripMs: roundTripMs,
      elevenlabsOverheadMs: ourProcessingMs !== null ? Math.max(0, roundTripMs - ourProcessingMs) : null,
    });
    agentTurnIndex++;
  }

  const totals = legs.map((l) => l.totalRoundTripMs).sort((a, b) => a - b);
  const processingVals = legs.map((l) => l.ourProcessingMs).filter((v): v is number => v !== null);
  const overheadVals = legs.map((l) => l.elevenlabsOverheadMs).filter((v): v is number => v !== null);

  return {
    conversationFingerprint,
    legs,
    totalP50Ms: percentile(totals, 0.5),
    totalP95Ms: percentile(totals, 0.95),
    totalMaxMs: totals.length ? totals[totals.length - 1] : null,
    ourProcessingMeanMs: processingVals.length ? processingVals.reduce((a, b) => a + b, 0) / processingVals.length : null,
    elevenlabsOverheadMeanMs: overheadVals.length ? overheadVals.reduce((a, b) => a + b, 0) / overheadVals.length : null,
  };
}
