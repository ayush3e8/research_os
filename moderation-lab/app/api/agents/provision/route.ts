/**
 * Get-or-create the ElevenLabs agent for a given architecture. Cached in
 * `architecture_agents` so re-provisioning doesn't spawn a duplicate agent
 * every time -- delete the row (or add a migration to bump a version) to
 * force recreation after editing an architecture's prompt/config.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { architectureAgents } from "@/db/schema";
import { createAgent, getOrCreateWebhookSecretId } from "@/lib/elevenlabs";
import { getArchitecture } from "@/lib/architectures/registry";
import { BASELINE_GUIDE } from "@/lib/guide";

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs' standard demo voice; swap once you pick one

export async function POST(req: Request) {
  const { architecture: name } = await req.json();
  const architecture = getArchitecture(name);
  if (!architecture) {
    return Response.json({ error: `Unknown architecture: ${name}` }, { status: 404 });
  }

  const [existing] = await db
    .select()
    .from(architectureAgents)
    .where(eq(architectureAgents.architecture, name));
  if (existing) {
    return Response.json({ agentId: existing.elevenlabsAgentId });
  }

  let agentId: string;
  if (architecture.kind === "native") {
    agentId = await createAgent({
      name: `moderation-lab: ${name}`,
      systemPrompt: architecture.systemPromptForNativeAgent!(),
      firstMessage: BASELINE_GUIDE.openingScript,
      voiceId: DEFAULT_VOICE_ID,
      llm: { kind: "native", model: "claude-sonnet-5" },
    });
  } else {
    // VERCEL_URL changes on every single deployment (including production
    // redeploys) -- confirmed as the real cause of a live outage: an agent
    // provisioned against it kept pointing at a now-dead URL after the next
    // deploy, so ElevenLabs' requests to it never reached this app at all.
    // VERCEL_PROJECT_PRODUCTION_URL is the stable one, exactly for URLs
    // that need to survive across deploys (like this one, baked into the
    // agent config at provision time and never updated again).
    const appUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.APP_URL;
    if (!appUrl) {
      return Response.json(
        { error: "Set APP_URL (or deploy to Vercel, which sets VERCEL_PROJECT_PRODUCTION_URL automatically) before provisioning a custom-LLM architecture." },
        { status: 500 }
      );
    }
    const secretId = await getOrCreateWebhookSecretId(
      "moderation-lab-webhook-secret",
      process.env.CUSTOM_LLM_WEBHOOK_SECRET!
    );
    agentId = await createAgent({
      name: `moderation-lab: ${name}`,
      systemPrompt: "", // the custom-LLM webhook builds its own system prompt per architecture
      firstMessage: BASELINE_GUIDE.openingScript,
      voiceId: DEFAULT_VOICE_ID,
      llm: {
        kind: "custom",
        url: `${appUrl}/api/architectures/${name}`,
        secretId,
        modelId: "claude-sonnet-5",
      },
    });
  }

  await db.insert(architectureAgents).values({
    architecture: name,
    elevenlabsAgentId: agentId,
    isCustomLlm: architecture.kind === "custom",
  });

  return Response.json({ agentId });
}
