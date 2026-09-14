/**
 * Aggregates the call-health signals we approved: error/fallback rate,
 * turn-dedup conflict rate, abrupt-ending rate (never reached end_call),
 * and end_call correctness. All computed from turn_logs + call_health_
 * events -- no LLM calls, this is all directly observable.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { callHealthEvents, turnLogs } from "@/db/schema";

export type CallHealthRow = {
  conversationFingerprint: string;
  architecture: string;
  totalTurns: number;
  fallbackCount: number;
  conflictCount: number;
  reachedEndCall: boolean;
  startedAt: Date;
  endedAt: Date;
};

export type CallHealthSummary = {
  totalCalls: number;
  fallbackRate: number; // fraction of TURNS that fell back, across all calls
  conflictRate: number; // fraction of TURNS that hit a dedup conflict
  abruptEndingRate: number; // fraction of CALLS that never reached end_call
  calls: CallHealthRow[];
};

function hasEndCallToolUse(responseToolCalls: unknown): boolean {
  if (!Array.isArray(responseToolCalls)) return false;
  return responseToolCalls.some((tc: { name?: string }) => tc?.name === "end_call");
}

export async function computeCallHealthSummary(): Promise<CallHealthSummary> {
  const turns = await db
    .select({
      conversationFingerprint: turnLogs.conversationFingerprint,
      architecture: turnLogs.architecture,
      stopReason: turnLogs.stopReason,
      responseToolCalls: turnLogs.responseToolCalls,
      createdAt: turnLogs.createdAt,
      callType: turnLogs.callType,
    })
    .from(turnLogs)
    .where(eq(turnLogs.callType, "moderator"))
    .orderBy(asc(turnLogs.createdAt));

  const events = await db.select().from(callHealthEvents);

  const byConversation = new Map<string, typeof turns>();
  for (const t of turns) {
    if (!t.conversationFingerprint) continue;
    const list = byConversation.get(t.conversationFingerprint) ?? [];
    list.push(t);
    byConversation.set(t.conversationFingerprint, list);
  }

  const conflictsByConversation = new Map<string, number>();
  const fallbacksByConversationFromEvents = new Map<string, number>();
  for (const e of events) {
    if (!e.conversationFingerprint) continue;
    const map = e.eventType === "turn_conflict" ? conflictsByConversation : fallbacksByConversationFromEvents;
    map.set(e.conversationFingerprint, (map.get(e.conversationFingerprint) ?? 0) + 1);
  }

  const calls: CallHealthRow[] = [];
  for (const [fingerprint, callTurns] of byConversation) {
    const fallbackCount = callTurns.filter((t) => t.stopReason === "error").length;
    const reachedEndCall = callTurns.some((t) => hasEndCallToolUse(t.responseToolCalls));
    calls.push({
      conversationFingerprint: fingerprint,
      architecture: callTurns[0].architecture,
      totalTurns: callTurns.length,
      fallbackCount,
      conflictCount: conflictsByConversation.get(fingerprint) ?? 0,
      reachedEndCall,
      startedAt: callTurns[0].createdAt,
      endedAt: callTurns[callTurns.length - 1].createdAt,
    });
  }
  calls.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());

  const totalTurnCount = turns.length;
  const totalFallbacks = calls.reduce((sum, c) => sum + c.fallbackCount, 0);
  const totalConflicts = calls.reduce((sum, c) => sum + c.conflictCount, 0);
  const abruptEndings = calls.filter((c) => !c.reachedEndCall).length;

  return {
    totalCalls: calls.length,
    fallbackRate: totalTurnCount > 0 ? totalFallbacks / totalTurnCount : 0,
    conflictRate: totalTurnCount > 0 ? totalConflicts / totalTurnCount : 0,
    abruptEndingRate: calls.length > 0 ? abruptEndings / calls.length : 0,
    calls,
  };
}
