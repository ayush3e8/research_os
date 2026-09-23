/**
 * Advances one simulation run by one respondent-visible turn. Called
 * repeatedly by the client (a step loop, same pattern app/page.tsx already
 * uses to drive a real call) until it reports "done" or "failed" -- never
 * in one long-running request, since a full simulated interview is 30-80+
 * sequential Claude calls and a batch's worth of them would blow well past
 * a serverless function's timeout if driven server-side in a single shot.
 * Idempotent-safe to call again on an already-finished run (see
 * advanceSimulationRun's early return).
 */
import { advanceSimulationRun } from "@/lib/simulation/driver";

export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await advanceSimulationRun(id);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 400 });
  }
}
