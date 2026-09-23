import { db } from "@/db";
import { simulationBatches, simulationRuns } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [batch] = await db.select().from(simulationBatches).where(eq(simulationBatches.id, id));
  if (!batch) return Response.json({ error: "Batch not found" }, { status: 404 });

  // Summary only (no transcripts) -- GET /api/simulations/runs/[id] for a
  // single run's full transcript.
  const runs = await db
    .select({
      id: simulationRuns.id,
      architecture: simulationRuns.architecture,
      personaId: simulationRuns.personaId,
      repeatIndex: simulationRuns.repeatIndex,
      conversationFingerprint: simulationRuns.conversationFingerprint,
      status: simulationRuns.status,
      turnCount: simulationRuns.turnCount,
      endReason: simulationRuns.endReason,
      startedAt: simulationRuns.startedAt,
      endedAt: simulationRuns.endedAt,
    })
    .from(simulationRuns)
    .where(eq(simulationRuns.batchId, id));

  return Response.json({ batch, runs });
}
