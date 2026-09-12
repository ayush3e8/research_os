/**
 * Full turn logging -- request, response, latency, which architecture and
 * which internal call ("moderator", or later a named advisor) produced it.
 * This is the "rich logs, no scoring yet" deliverable: comparing
 * architectures later means being able to pull up exactly what every call
 * saw and said, not just the spoken transcript ElevenLabs reconstructs.
 */
import { db } from "@/db";
import { turnLogs } from "@/db/schema";

export async function logTurn(input: {
  architecture: string;
  callType?: string;
  conversationFingerprint: string | null;
  model: string;
  requestSystem: string;
  requestMessages: unknown;
  requestTools?: unknown;
  rawRequestBody: unknown;
  responseText: string;
  responseToolCalls?: { id: string; name: string; input: unknown }[];
  stopReason: string | null;
  latencyMs: number;
}): Promise<void> {
  try {
    await db.insert(turnLogs).values({
      architecture: input.architecture,
      callType: input.callType ?? "moderator",
      conversationFingerprint: input.conversationFingerprint,
      model: input.model,
      requestSystem: input.requestSystem,
      requestMessages: input.requestMessages,
      requestTools: input.requestTools ?? [],
      rawRequestBody: input.rawRequestBody ?? {},
      responseText: input.responseText || null,
      responseToolCalls: input.responseToolCalls ?? [],
      stopReason: input.stopReason,
      latencyMs: input.latencyMs,
    });
  } catch (err) {
    // A logging failure should never break a live call.
    console.error("logTurn failed:", err);
  }
}
