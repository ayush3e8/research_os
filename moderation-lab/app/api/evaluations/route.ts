/**
 * POST triggers a full moderation-quality evaluation for a completed call
 * (see app/page.tsx's onDisconnect -- evaluation runs automatically after
 * every call, no separate admin step). GET lists past evaluations for the
 * results page. Unauthenticated like the other browser-facing routes
 * (agents/session, personas, guide) -- nothing secret changes hands here.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversationState, evaluations } from "@/db/schema";
import { runEvaluation } from "@/lib/evaluation/run";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { conversationFingerprint, architecture } = await req.json();

  // The manual-test UI (app/page.tsx) only knows which architecture it was
  // talking to, not the server-computed fingerprint -- resolve to that
  // architecture's most recently started conversation. Fine for the
  // single-tester manual flow this triggers from today; pass
  // conversationFingerprint directly for anything that already has it.
  let fingerprint = conversationFingerprint;
  if (!fingerprint && architecture) {
    const [row] = await db
      .select({ fingerprint: conversationState.fingerprint })
      .from(conversationState)
      .where(eq(conversationState.architecture, architecture))
      .orderBy(desc(conversationState.firstSeenAt))
      .limit(1);
    fingerprint = row?.fingerprint;
  }
  if (!fingerprint) {
    return Response.json({ error: "conversationFingerprint or architecture is required" }, { status: 400 });
  }

  const id = await runEvaluation(fingerprint);
  if (!id) {
    return Response.json({ error: "No transcript found for this conversation" }, { status: 404 });
  }
  return Response.json({ id });
}

export async function GET() {
  const rows = await db
    .select({
      id: evaluations.id,
      conversationFingerprint: evaluations.conversationFingerprint,
      architecture: evaluations.architecture,
      status: evaluations.status,
      overallScore: evaluations.overallScore,
      dimensionScores: evaluations.dimensionScores,
      createdAt: evaluations.createdAt,
      completedAt: evaluations.completedAt,
    })
    .from(evaluations)
    .orderBy(desc(evaluations.createdAt))
    .limit(50);
  return Response.json({ evaluations: rows });
}
