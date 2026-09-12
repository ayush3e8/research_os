/**
 * Duplicate-request protection, generalized from a real production
 * incident (see the moderation-architecture.md this was ported from): a
 * single human turn can produce several near-simultaneous requests to a
 * custom-LLM webhook (interim ASR fragments, the finalized sentence sent
 * again, sometimes an exact repeat) -- left alone that's redundant Claude
 * calls and, at volume, a real contributor to hitting rate/overload limits.
 *
 * Deliberately exact-match only: only a byte-identical request array is
 * deduped. A near-match might mean the respondent's answer genuinely
 * changed between two requests (an ASR fragment finalizing into a longer
 * sentence) -- answering that with a stale response would be a worse bug
 * than the duplicate-call cost this solves.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { turnClaims } from "@/db/schema";

export type TurnResult = {
  responseText: string;
  responseToolCalls: { id: string; name: string; input: unknown }[];
  stopReason: string | null;
};

function extractPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type: string; text?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "tool_use") return `tool_use:${block.name}:${JSON.stringify(block.input)}`;
      if (block.type === "tool_result") return `tool_result:${block.tool_use_id}:${JSON.stringify(block.content)}`;
      return "";
    })
    .join(" ");
}

export async function computeTurnFingerprint(
  system: string,
  messages: { role: string; content: unknown }[]
): Promise<string> {
  const signature = messages.map((m) => `${m.role}:${extractPlainText(m.content)}`).join("|");
  const seed = system + "||" + signature;
  const data = new TextEncoder().encode(seed);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Atomic claim: whichever request's insert lands first is the sole
 * "winner" that calls Claude; every other request for the same fingerprint
 * sees a conflict and waits for the winner's result instead. */
export async function claimTurn(fingerprint: string): Promise<boolean> {
  const inserted = await db
    .insert(turnClaims)
    .values({ fingerprint, status: "in_progress" })
    .onConflictDoNothing()
    .returning({ fingerprint: turnClaims.fingerprint });
  return inserted.length > 0;
}

export async function recordTurnResult(fingerprint: string, result: TurnResult): Promise<void> {
  await db
    .update(turnClaims)
    .set({
      status: "done",
      responseText: result.responseText,
      responseToolCalls: result.responseToolCalls,
      stopReason: result.stopReason,
    })
    .where(eq(turnClaims.fingerprint, fingerprint));
}

/** A losing request never calls Claude -- it polls for the winner's result
 * instead. Bounded wait: if the winner never records a result (crashed, or
 * genuinely still running), give up and let the caller generate fresh
 * rather than hanging the respondent's turn indefinitely. */
export async function waitForTurnResult(
  fingerprint: string,
  timeoutMs: number,
  pollIntervalMs = 250
): Promise<TurnResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.select().from(turnClaims).where(eq(turnClaims.fingerprint, fingerprint));
    if (row?.status === "done") {
      return {
        responseText: row.responseText ?? "",
        responseToolCalls: (row.responseToolCalls as TurnResult["responseToolCalls"]) ?? [],
        stopReason: row.stopReason,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}
