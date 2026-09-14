/**
 * Records call-health signals that leave no trace anywhere else -- see the
 * callHealthEvents docstring in db/schema.ts for why "fallback" and
 * "turn_conflict" were real gaps (a fallback response was never logged at
 * all; a turn-dedup conflict only ever left the winner's row, never a
 * record a conflict happened). The background_reasoning_* events serve the
 * same purpose for strategist/fanout's after()-scheduled calls -- a real
 * test call showed zero of those calls' own turn_logs rows with nothing
 * else to explain why (no Vercel log access in this environment), so
 * bracketing every attempt is the only way to tell "never started" from
 * "started and threw" from "silently hung." Written at the exact point
 * each event occurs. A logging failure here should never break a live
 * call, same convention as lib/logging.ts.
 */
import { db } from "@/db";
import { callHealthEvents } from "@/db/schema";

export async function logCallHealthEvent(input: {
  eventType:
    | "fallback"
    | "turn_conflict"
    | "background_reasoning_started"
    | "background_reasoning_failed"
    // livefanout's advisors run synchronously on the request's critical
    // path, not via after() -- kept distinct from the background_* events
    // above so a hang or failure here isn't misread as the same class of
    // problem (an after() callback never firing) those exist to diagnose.
    | "live_reasoning_started"
    | "live_reasoning_failed";
  conversationFingerprint: string | null;
  architecture: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(callHealthEvents).values({
      eventType: input.eventType,
      conversationFingerprint: input.conversationFingerprint,
      architecture: input.architecture,
      detail: input.detail ?? {},
    });
  } catch (err) {
    console.error("logCallHealthEvent failed:", err);
  }
}
