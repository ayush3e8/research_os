/**
 * Create a simulation batch: one lib/simulation run per (architecture,
 * persona, repeat) combination requested. Runs start "pending" -- nothing
 * actually executes here, the client drives each run forward by calling
 * POST /api/simulations/runs/[id]/step repeatedly (see that route's
 * docstring for why: a full simulated interview is too many sequential
 * Claude calls to fit in one request).
 */
import { db } from "@/db";
import { personas, simulationBatches, simulationRuns } from "@/db/schema";
import { getArchitecture } from "@/lib/architectures/registry";
import { getGuide } from "@/lib/guide";
import { inArray } from "drizzle-orm";

export async function POST(req: Request) {
  const body = await req.json();
  const name: string = body.name ?? `batch-${Date.now()}`;
  const guideName: string = body.guide;
  const architectureNames: string[] = body.architectures ?? [];
  const personaIds: string[] = body.personaIds ?? [];
  const repeatsPerCombo: number = body.repeatsPerCombo ?? 1;
  const maxTurns: number = body.maxTurns ?? 60;

  if (!getGuide(guideName)) {
    return Response.json({ error: `Unknown guide: ${guideName}` }, { status: 400 });
  }
  const unknownArchitectures = architectureNames.filter((a) => {
    const arch = getArchitecture(a);
    return !arch || arch.kind !== "custom" || !arch.run;
  });
  if (unknownArchitectures.length) {
    return Response.json({ error: `Unknown or non-custom architecture(s): ${unknownArchitectures.join(", ")}` }, { status: 400 });
  }
  if (architectureNames.length === 0 || personaIds.length === 0) {
    return Response.json({ error: "architectures and personaIds must each be non-empty" }, { status: 400 });
  }
  const foundPersonas = await db.select({ id: personas.id }).from(personas).where(inArray(personas.id, personaIds));
  const foundIds = new Set(foundPersonas.map((p) => p.id));
  const missingPersonaIds = personaIds.filter((id) => !foundIds.has(id));
  if (missingPersonaIds.length) {
    return Response.json({ error: `Unknown persona id(s): ${missingPersonaIds.join(", ")}` }, { status: 400 });
  }

  const [batch] = await db
    .insert(simulationBatches)
    .values({
      name,
      guide: guideName,
      architectures: architectureNames,
      personaIds,
      repeatsPerCombo,
      maxTurns,
      status: "running",
    })
    .returning();

  const runValues = architectureNames.flatMap((architecture) =>
    personaIds.flatMap((personaId) =>
      Array.from({ length: repeatsPerCombo }, (_, repeatIndex) => ({
        batchId: batch.id,
        architecture,
        guide: guideName,
        personaId,
        repeatIndex,
        conversationFingerprint: `sim_${crypto.randomUUID()}`,
        status: "pending" as const,
      }))
    )
  );
  const runs = await db.insert(simulationRuns).values(runValues).returning();

  return Response.json({ batch, runs });
}

export async function GET() {
  const batches = await db.select().from(simulationBatches).orderBy(simulationBatches.createdAt);
  return Response.json({ batches });
}
