import { computeCallLatency } from "@/lib/latency";

export async function GET(_req: Request, { params }: { params: Promise<{ fingerprint: string }> }) {
  const { fingerprint } = await params;
  const summary = await computeCallLatency(fingerprint);
  if (!summary) {
    return Response.json({ error: "No post-call webhook data for this conversation yet" }, { status: 404 });
  }
  return Response.json(summary);
}
