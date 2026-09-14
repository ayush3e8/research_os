import { computeCallHealthSummary } from "@/lib/call-health-summary";

export async function GET() {
  const summary = await computeCallHealthSummary();
  return Response.json(summary);
}
