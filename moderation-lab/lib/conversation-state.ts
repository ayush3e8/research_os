/**
 * Generic per-conversation state, keyed by a content-derived fingerprint
 * (system prompt + first two messages -- stable across a whole call,
 * independent of ElevenLabs' custom-LLM wire format ever reliably carrying
 * a conversation id). Any architecture can stash whatever it needs in
 * `state` (untyped JSON); this module also bootstraps `firstSeenAt` so
 * pacing (see pacing.ts) can compute real elapsed wall-clock time.
 *
 * Because the fingerprint is content-derived rather than a real ElevenLabs
 * conversation id, two DIFFERENT calls can collide on the same key -- same
 * guide/architecture with an identical opening exchange (no persona
 * variation yet) hashes identically every time. Confirmed as a real bug:
 * a fresh call landed on a dormant row from an earlier, already-finished
 * call, inherited its old `firstSeenAt`, and pacing computed hours of
 * elapsed time on turn one -- panicking straight into "wrap up now."
 * getOrInitConversation guards against this with a staleness check below.
 */
import { and, eq, lt, sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db";
import { conversationState } from "@/db/schema";

function extractPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type: string; text?: string; name?: string; tool_use_id?: string }) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "tool_use") return `tool_use:${block.name}`;
      if (block.type === "tool_result") return `tool_result:${block.tool_use_id}`;
      return "";
    })
    .join(" ");
}

export async function computeConversationFingerprint(
  system: string,
  messages: { role: string; content: unknown }[]
): Promise<string> {
  const signature = messages
    .slice(0, 2)
    .map((m) => `${m.role}:${extractPlainText(m.content)}`)
    .join("|");
  const data = new TextEncoder().encode(system + signature);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type ConversationRow = {
  firstSeenAt: Date;
  state: Record<string, unknown>;
};

// Longer than any realistic gap between two turns of the same live call
// (even a slow, thoughtful respondent) -- ElevenLabs itself hangs up on
// silence well before this -- but short enough to catch a fresh call that
// lands on a dormant row's fingerprint (same guide/architecture + identical
// opening exchange) within the same sitting, which is the collision this
// guards against. See module docstring for the real incident this fixes.
const STALE_AFTER_MS = 20 * 60 * 1000;

/** Reads existing state, or bootstraps a fresh row (firstSeenAt = now) if
 * this is the first turn seen for this conversation. `guide` is only used
 * on the bootstrap insert -- it's the guide baked into this agent's
 * webhook URL (see the [guide] route segment), stored once so later
 * evaluation of this conversation knows which guide it was actually
 * run against, per lib/guide.ts's module docstring. `isSimulation` is also
 * bootstrap-only, for lib/turn-runner.ts's simulation callers (see
 * simulationRuns' docstring in db/schema.ts). */
export async function getOrInitConversation(
  fingerprint: string,
  architecture: string,
  guide: string,
  isSimulation = false
): Promise<ConversationRow> {
  const [existing] = await db
    .select()
    .from(conversationState)
    .where(eq(conversationState.fingerprint, fingerprint));
  if (existing) {
    // Staleness protection exists for the real problem this module's
    // docstring describes: a content-derived fingerprint colliding across
    // two genuinely different real calls. A simulation's fingerprint is a
    // fresh random id (simulationRuns.conversationFingerprint) that can
    // never collide with anything -- applying the same 20-minute reset
    // here would just silently wipe a simulation's state if its step loop
    // (a browser tab, see lib/simulation's docstring) happens to pause for
    // a while, which is a real risk for something driven by repeated
    // client-side fetches rather than a live phone call.
    const idleMs = existing.isSimulation ? 0 : Date.now() - existing.updatedAt.getTime();
    if (idleMs < STALE_AFTER_MS) {
      return { firstSeenAt: existing.firstSeenAt, state: (existing.state as Record<string, unknown>) ?? {} };
    }
    // Stale -- this row belongs to a call that's long over, not the one
    // that just started. Reset it in place as a fresh conversation rather
    // than resuming a dead call's clock and leftover state. Guarded on
    // updatedAt so a concurrent in-progress turn (which just bumped it)
    // can't be reset out from under itself.
    const [reset] = await db
      .update(conversationState)
      .set({ architecture, guide, firstSeenAt: drizzleSql`now()`, state: {}, updatedAt: drizzleSql`now()` })
      .where(
        and(eq(conversationState.fingerprint, fingerprint), lt(conversationState.updatedAt, new Date(Date.now() - STALE_AFTER_MS)))
      )
      .returning();
    if (reset) {
      return { firstSeenAt: reset.firstSeenAt, state: {} };
    }
    // Lost a race -- a concurrent turn touched it between the read above
    // and this update, so it's no longer stale. Use what it has now.
    const [row] = await db.select().from(conversationState).where(eq(conversationState.fingerprint, fingerprint));
    return { firstSeenAt: row.firstSeenAt, state: (row.state as Record<string, unknown>) ?? {} };
  }
  const [inserted] = await db
    .insert(conversationState)
    .values({ fingerprint, architecture, guide, state: {}, isSimulation })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    return { firstSeenAt: inserted.firstSeenAt, state: {} };
  }
  // Lost a race with a concurrent request for the same conversation -- read
  // what the winner just wrote instead.
  const [row] = await db.select().from(conversationState).where(eq(conversationState.fingerprint, fingerprint));
  return { firstSeenAt: row.firstSeenAt, state: (row.state as Record<string, unknown>) ?? {} };
}

export async function updateConversationState(fingerprint: string, state: Record<string, unknown>): Promise<void> {
  await db
    .update(conversationState)
    .set({ state, updatedAt: drizzleSql`now()` })
    .where(eq(conversationState.fingerprint, fingerprint));
}
