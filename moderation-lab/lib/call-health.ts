/**
 * Records the two call-health signals that leave no trace anywhere else --
 * see the callHealthEvents docstring in db/schema.ts for why both were
 * real gaps (a fallback response was never logged at all; a turn-dedup
 * conflict only ever left the winner's row, never a record a conflict
 * happened). Written at the exact point each event occurs in the webhook
 * route. A logging failure here should never break a live call, same
 * convention as lib/logging.ts.
 */
import { db } from "@/db";
import { callHealthEvents } from "@/db/schema";

export async function logCallHealthEvent(input: {
  eventType: "fallback" | "turn_conflict";
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
