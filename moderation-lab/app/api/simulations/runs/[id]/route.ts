import { db } from "@/db";
import { simulationRuns } from "@/db/schema";
import { eq } from "drizzle-orm";

/** Full run detail including the transcript -- for transcript-level review. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [run] = await db.select().from(simulationRuns).where(eq(simulationRuns.id, id));
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  return Response.json({ run });
}
