/**
 * ElevenLabs Conversational AI Agents: creation (native-LLM or custom-LLM),
 * and the signed-URL handoff that lets the browser connect directly to an
 * agent without ever seeing our API key.
 *
 * Schema/endpoints here are drawn from ElevenLabs' docs as of this writing
 * -- verify against your account on first real deploy, the same way every
 * other ElevenLabs integration in this project has needed to.
 */
const API_BASE = "https://api.elevenlabs.io";

function headers(): Record<string, string> {
  return {
    "xi-api-key": process.env.ELEVENLABS_API_KEY!,
    "Content-Type": "application/json",
  };
}

/**
 * Custom-LLM agents authenticate to our webhook via a workspace "secret"
 * referenced by id, not a raw string -- ElevenLabs' agent-creation schema
 * only accepts {secret_id} or {env_var_label} for custom_llm.api_key, never
 * a literal value. This looks one up by name first (list endpoint) so
 * re-running agent creation doesn't create a duplicate secret every time.
 */
export async function getOrCreateWebhookSecretId(name: string, value: string): Promise<string> {
  const listRes = await fetch(`${API_BASE}/v1/convai/secrets`, { headers: headers() });
  if (listRes.ok) {
    const body = await listRes.json();
    const existing = (body?.secrets ?? []).find((s: { name: string; secret_id: string }) => s.name === name);
    if (existing) return existing.secret_id;
  }

  const createRes = await fetch(`${API_BASE}/v1/convai/secrets`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ type: "new", name, value }),
  });
  if (!createRes.ok) {
    throw new Error(`ElevenLabs secret creation failed (${createRes.status}): ${await createRes.text()}`);
  }
  const created = await createRes.json();
  return created.secret_id as string;
}

export type AgentLlmConfig =
  | { kind: "native"; model: string } // e.g. "claude-sonnet-5", ElevenLabs calls it directly
  | { kind: "custom"; url: string; secretId: string; modelId?: string }; // our hosted webhook

export async function createAgent(opts: {
  name: string;
  systemPrompt: string;
  firstMessage: string;
  voiceId: string;
  ttsModelId?: string;
  llm: AgentLlmConfig;
}): Promise<string> {
  const prompt: Record<string, unknown> =
    opts.llm.kind === "native"
      ? { prompt: opts.systemPrompt, llm: opts.llm.model }
      : {
          prompt: opts.systemPrompt,
          llm: "custom-llm",
          custom_llm: {
            url: opts.llm.url,
            model_id: opts.llm.modelId ?? null,
            api_key: { secret_id: opts.llm.secretId },
          },
        };

  const res = await fetch(`${API_BASE}/v1/convai/agents/create`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: opts.name,
      tags: ["moderation-lab"],
      conversation_config: {
        tts: { voice_id: opts.voiceId, model_id: opts.ttsModelId ?? "eleven_v3_conversational" },
        agent: {
          first_message: opts.firstMessage,
          language: "en",
          prompt,
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs agent creation failed (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  return body.agent_id as string;
}

/**
 * Server-side call so the browser client never sees ELEVENLABS_API_KEY --
 * it gets this signed, short-lived (~15 min) URL instead and connects
 * directly to ElevenLabs over WebSocket with it.
 */
export async function getSignedUrl(agentId: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { headers: headers() }
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs get-signed-url failed (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  return body.signed_url as string;
}
