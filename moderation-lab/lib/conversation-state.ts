/**
 * Generic per-conversation state, keyed by a content-derived fingerprint
 * (system prompt + first two messages -- stable across a whole call,
 * independent of ElevenLabs' custom-LLM wire format ever reliably carrying
 * a conversation id). Any architecture can stash whatever it needs in
 * `state` (untyped JSON); this module also bootstraps `firstSeenAt` so
 * pacing (see pacing.ts) can compute real elapsed wall-clock time.
 */
import { eq, sql as drizzleSql } from "drizzle-orm";
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

/** Reads existing state, or bootstraps a fresh row (firstSeenAt = now) if
 * this is the first turn seen for this conversation. */
export async function getOrInitConversation(fingerprint: string, architecture: string): Promise<ConversationRow> {
  const [existing] = await db
    .select()
    .from(conversationState)
    .where(eq(conversationState.fingerprint, fingerprint));
  if (existing) {
    return { firstSeenAt: existing.firstSeenAt, state: (existing.state as Record<string, unknown>) ?? {} };
  }
  const [inserted] = await db
    .insert(conversationState)
    .values({ fingerprint, architecture, state: {} })
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
