import { db } from "@/db";
import { simulationRuns } from "@/db/schema";
import { eq } from "drizzle-orm";

/** Full run detail including the transcript -- for transcript-level review.
 * Accepts either the run's own id (a UUID) or its conversationFingerprint
 * (always "sim_..." -- never collides with a UUID's shape), since every
 * OTHER page in this app (Operations, Evaluations) addresses a conversation
 * by fingerprint, not by whichever table's internal id happens to own it --
 * a fingerprint-only link (e.g. from Operations) shouldn't need its own
 * extra lookup step just to reach a transcript. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // simulationRuns.id is a real Postgres uuid column -- querying it with a
  // non-UUID string (a fingerprint always looks like "sim_...") throws
  // "invalid input syntax for type uuid" rather than just finding nothing,
  // so branch on shape up front instead of relying on a failed lookup.
  const [run] = UUID_RE.test(id)
    ? await db.select().from(simulationRuns).where(eq(simulationRuns.id, id))
    : await db.select().from(simulationRuns).where(eq(simulationRuns.conversationFingerprint, id));
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  return Response.json({ run });
}
