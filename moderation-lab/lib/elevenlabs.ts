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

export type ClientToolConfig = {
  name: string;
  description: string;
  expectsResponse?: boolean;
  parameters?: object;
};

export async function createAgent(opts: {
  name: string;
  systemPrompt: string;
  firstMessage: string;
  voiceId: string;
  ttsModelId?: string;
  llm: AgentLlmConfig;
  // "client" tools (schema per ElevenLabs docs as of this writing --
  // https://elevenlabs.io/docs/agents-platform/customization/tools/client-tools
  // -- verify against your account before relying on this for a real call,
  // same as every other ElevenLabs integration point here): relayed to the
  // custom LLM as a normal callable tool, then forwarded to the browser
  // client's `clientTools` handler instead of executed server-side.
  clientTools?: ClientToolConfig[];
  // conversation_config.turn.turn_timeout, seconds -- how long ElevenLabs
  // waits during respondent silence before treating their turn as over.
  turnTimeoutSecs?: number;
}): Promise<string> {
  // The End Call system tool is only added automatically to agents created
  // in the ElevenLabs dashboard -- confirmed via their docs -- agents
  // created via this API do NOT get it unless explicitly configured here.
  // Without this, every architecture's system prompt saying "use the
  // end_call tool" was telling the moderator to call a tool that was never
  // actually given to it (confirmed against a real logged request:
  // raw_request_body.tools came back undefined on every single turn of
  // every call so far) -- every call so far has had to be hung up manually
  // rather than ending itself.
  const builtInTools = {
    end_call: { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } },
  };

  // Distinct from built_in_tools above -- that map only covers ElevenLabs'
  // pre-defined system tools (end_call and the like). A genuinely custom
  // tool (one whose call should reach the browser client, not a built-in
  // ElevenLabs behavior) goes in this separate `tools` array instead.
  const clientTools = (opts.clientTools ?? []).map((t) => ({
    type: "client",
    name: t.name,
    description: t.description,
    expects_response: t.expectsResponse ?? false,
    parameters: t.parameters ?? { type: "object", properties: {} },
  }));

  const prompt: Record<string, unknown> =
    opts.llm.kind === "native"
      ? { prompt: opts.systemPrompt, llm: opts.llm.model, built_in_tools: builtInTools, tools: clientTools }
      : {
          prompt: opts.systemPrompt,
          llm: "custom-llm",
          custom_llm: {
            url: opts.llm.url,
            model_id: opts.llm.modelId ?? null,
            api_key: { secret_id: opts.llm.secretId },
          },
          built_in_tools: builtInTools,
          tools: clientTools,
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
        ...(opts.turnTimeoutSecs ? { turn: { turn_timeout: opts.turnTimeoutSecs } } : {}),
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
