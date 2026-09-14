/**
 * Reconstructs a turn-by-turn transcript, with approximate per-turn
 * timestamps, from raw turn_logs rows -- needed for the coverage/time-per-
 * topic metric and for giving each per-turn check only the local context it
 * actually needs (never re-deriving it from one giant cumulative message
 * array, which is what request_messages already is).
 *
 * Each turn_logs row is one respondent turn arriving: its requestMessages
 * ends in that new respondent utterance, and its own responseText is the
 * moderator's reply to it. So row[i]'s last user message *is* respondent
 * turn i (at row[i].createdAt), and row[i].responseText *is* moderator turn
 * i (at roughly row[i].createdAt + row[i].latencyMs) -- no need to diff
 * consecutive cumulative arrays.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversationState, turnLogs } from "@/db/schema";

export type ReconstructedTurn = {
  index: number;
  role: "respondent" | "moderator";
  text: string;
  at: Date;
};

function lastUserText(requestMessages: unknown): string | null {
  if (!Array.isArray(requestMessages)) return null;
  for (let i = requestMessages.length - 1; i >= 0; i--) {
    const m = requestMessages[i] as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((b: { type?: string }) => b?.type === "text")
        .map((b: { text?: string }) => b.text ?? "")
        .join(" ")
        .trim();
      return text || null;
    }
    return null;
  }
  return null;
}

export async function loadTranscript(
  conversationFingerprint: string
): Promise<{ architecture: string; guideName: string; turns: ReconstructedTurn[] } | null> {
  const rows = await db
    .select()
    .from(turnLogs)
    .where(eq(turnLogs.conversationFingerprint, conversationFingerprint))
    .orderBy(asc(turnLogs.createdAt));

  if (rows.length === 0) return null;

  const turns: ReconstructedTurn[] = [];
  let idx = 0;
  for (const row of rows) {
    const respondentText = lastUserText(row.requestMessages);
    if (respondentText) {
      turns.push({ index: idx++, role: "respondent", text: respondentText, at: row.createdAt });
    }
    if (row.responseText) {
      const at = new Date(row.createdAt.getTime() + (row.latencyMs ?? 0));
      turns.push({ index: idx++, role: "moderator", text: row.responseText, at });
    }
  }

  // Which guide this conversation actually ran -- picked per call from the
  // manual-test UI (see lib/guide.ts's module docstring), so it has to be
  // looked up per conversation rather than assumed to be a single fixed
  // guide the whole app runs. Falls back to "everyday" for pre-existing
  // conversations logged before this column existed.
  const [stateRow] = await db
    .select({ guide: conversationState.guide })
    .from(conversationState)
    .where(eq(conversationState.fingerprint, conversationFingerprint));

  return { architecture: rows[0].architecture, guideName: stateRow?.guide ?? "everyday", turns };
}
