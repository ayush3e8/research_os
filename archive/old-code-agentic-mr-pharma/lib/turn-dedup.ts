// Jul 15 real-turn dedup, built after quantifying a real crash: a single
// human turn produced 7 near-simultaneous requests to this webhook in one
// real burst (3 reacting to an interim ASR fragment ("Yeah."), 3 reacting
// to the same already-finalized sentence sent again, 1 real continuation).
// That's self-inflicted Claude API load on top of whatever real capacity
// pressure exists — confirmed as a likely contributor to a genuine
// "Overloaded" (529) crash on the same call.
//
// Scope, deliberately conservative: only dedupes EXACT duplicate requests
// (byte-identical message array) — never a prefix/near-match. A near-match
// could mean the respondent's answer actually changed between two requests
// (an interim ASR fragment finalizing into a longer sentence), and
// answering that with a stale, already-generated response would be worse
// than the duplicate-call cost this is meant to fix. Exact-duplicate
// requests carry no such risk: identical input, so an identical output is
// always correct regardless of why the duplicate arrived.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { liveTurnClaims } from "@/db/schema";
import type Anthropic from "anthropic-sdk-realtime";

// Same canonical, key-order-independent signature approach as
// lib/live-directive-agent.ts's computeFingerprint (that file's own fix,
// same day: raw JSON.stringify is sensitive to jsonb key-order variance,
// which silently produces a different hash for logically-identical
// content). Reused here rather than duplicated, extended to hash every
// message instead of just the first two.
function extractPlainText(content: string | Anthropic.ContentBlockParam[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `tool_use:${block.name}:${JSON.stringify(block.input)}`;
      if (block.type === "tool_result") return `tool_result:${block.tool_use_id}:${JSON.stringify(block.content)}`;
      return "";
    })
    .join(" ");
}

export async function computeTurnFingerprint(
  system: string,
  messages: Anthropic.MessageParam[]
): Promise<string> {
  const signature = messages.map((m) => `${m.role}:${extractPlainText(m.content)}`).join("|");
  const seed = system + "||" + signature;
  const data = new TextEncoder().encode(seed);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type TurnResult = {
  responseText: string;
  responseToolCalls: { id: string; name: string; input: unknown }[];
  stopReason: string | null;
};

// Atomic claim via INSERT ... ON CONFLICT DO NOTHING — whichever concurrent
// request's insert actually lands in Postgres is the sole "winner" that
// calls Claude; every other request for the exact same fingerprint sees a
// conflict and waits for the winner's result instead.
export async function claimTurn(fingerprint: string): Promise<boolean> {
  const inserted = await db
    .insert(liveTurnClaims)
    .values({ fingerprint, status: "in_progress" })
    .onConflictDoNothing()
    .returning({ fingerprint: liveTurnClaims.fingerprint });
  return inserted.length > 0;
}

export async function recordTurnResult(fingerprint: string, result: TurnResult): Promise<void> {
  await db
    .update(liveTurnClaims)
    .set({
      status: "done",
      responseText: result.responseText,
      responseToolCalls: result.responseToolCalls,
      stopReason: result.stopReason,
    })
    .where(eq(liveTurnClaims.fingerprint, fingerprint));
}

// Polls for the winner's result rather than blocking on any single Claude
// call — a losing request never calls Claude at all, so cost stays flat
// regardless of how many duplicates arrive for one turn. Bounded wait:
// if the winner's own call is unusually slow or fails without recording a
// result, give up and let the caller fall back to generating fresh rather
// than hanging the respondent's turn indefinitely.
export async function waitForTurnResult(
  fingerprint: string,
  timeoutMs: number,
  pollIntervalMs = 250
): Promise<TurnResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.select().from(liveTurnClaims).where(eq(liveTurnClaims.fingerprint, fingerprint));
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
