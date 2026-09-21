/**
 * Get-or-create the ElevenLabs agent for a given (architecture, guide)
 * pair. Cached in `architecture_agents` so re-provisioning doesn't spawn a
 * duplicate agent every time -- delete the row (or add a migration to
 * bump a version) to force recreation after editing an architecture's
 * prompt/config. Guide is part of the cache key (not just architecture)
 * because it's picked per call from the manual-test UI -- see
 * lib/guide.ts's module docstring for why -- and each guide needs its own
 * opening line/system prompt baked in at agent-creation time.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { architectureAgents } from "@/db/schema";
import { createAgent, getOrCreateWebhookSecretId } from "@/lib/elevenlabs";
import { getArchitecture } from "@/lib/architectures/registry";
import { getGuide } from "@/lib/guide";

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs' standard demo voice; swap once you pick one

export async function POST(req: Request) {
  const { architecture: name, guide: guideName } = await req.json();
  const architecture = getArchitecture(name);
  if (!architecture) {
    return Response.json({ error: `Unknown architecture: ${name}` }, { status: 404 });
  }
  const guide = getGuide(guideName);
  if (!guide) {
    return Response.json({ error: `Unknown guide: ${guideName}` }, { status: 404 });
  }

  const [existing] = await db
    .select()
    .from(architectureAgents)
    .where(and(eq(architectureAgents.architecture, name), eq(architectureAgents.guide, guideName)));
  if (existing) {
    return Response.json({ agentId: existing.elevenlabsAgentId });
  }

  let agentId: string;
  if (architecture.kind === "native") {
    agentId = await createAgent({
      name: `moderation-lab: ${name} / ${guideName}`,
      systemPrompt: architecture.systemPromptForNativeAgent!(),
      firstMessage: guide.openingScript,
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
      name: `moderation-lab: ${name} / ${guideName}`,
      systemPrompt: "", // the custom-LLM webhook builds its own system prompt per architecture
      firstMessage: architecture.firstMessageOverride ?? guide.openingScript,
      voiceId: DEFAULT_VOICE_ID,
      llm: {
        kind: "custom",
        // Guide baked in as a path segment -- the webhook route (one level
        // further, [name]/[guide]/chat/completions) reads it off every
        // turn, so it stays consistent for this agent's whole lifetime
        // without needing to persist which guide a given ElevenLabs
        // conversation was using.
        url: `${appUrl}/api/architectures/${name}/${guideName}`,
        secretId,
        modelId: "claude-sonnet-5",
      },
      clientTools: architecture.clientTools,
      turnTimeoutSecs: architecture.turnTimeoutSecs,
    });
  }

  await db.insert(architectureAgents).values({
    architecture: name,
    guide: guideName,
    elevenlabsAgentId: agentId,
    isCustomLlm: architecture.kind === "custom",
  });

  return Response.json({ agentId });
}
