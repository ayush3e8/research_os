/**
 * Server-side handoff so the browser client can connect to a (private,
 * authenticated) ElevenLabs agent without ever seeing ELEVENLABS_API_KEY.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { architectureAgents } from "@/db/schema";
import { getSignedUrl } from "@/lib/elevenlabs";

export async function POST(req: Request) {
  const { architecture, guide } = await req.json();
  const [row] = await db
    .select()
    .from(architectureAgents)
    .where(and(eq(architectureAgents.architecture, architecture), eq(architectureAgents.guide, guide)));
  if (!row) {
    return Response.json({ error: `No agent provisioned for architecture "${architecture}" / guide "${guide}"` }, { status: 404 });
  }
  const signedUrl = await getSignedUrl(row.elevenlabsAgentId);
  return Response.json({ signedUrl });
}
