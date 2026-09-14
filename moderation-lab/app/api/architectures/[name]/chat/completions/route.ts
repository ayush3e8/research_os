/**
 * The endpoint ElevenLabs calls once per conversational turn for any
 * custom-LLM architecture. Must live at exactly this path -- ElevenLabs
 * treats the configured custom_llm.url as a base and appends
 * /chat/completions itself.
 *
 * Everything architecture-agnostic (auth, wire-format translation, turn
 * dedup, cross-turn state bootstrap, logging) lives here. What actually
 * gets said is entirely delegated to the named architecture's `run()`.
 */
import { getArchitecture } from "@/lib/architectures/registry";
import { computeConversationFingerprint, getOrInitConversation, updateConversationState } from "@/lib/conversation-state";
import { logCallHealthEvent } from "@/lib/call-health";
import { logTurn } from "@/lib/logging";
import { MODEL } from "@/lib/anthropic";
import { singleChunkSseResponse, toAnthropicMessages, toAnthropicTools } from "@/lib/openai-translate";
import { claimTurn, computeTurnFingerprint, recordTurnResult, waitForTurnResult } from "@/lib/turn-dedup";
import type { OpenAIMessage, OpenAITool } from "@/lib/openai-translate";

function isAuthorized(req: Request): boolean {
  const expected = process.env.CUSTOM_LLM_WEBHOOK_SECRET;
  if (!expected) return false;
  return req.headers.get("authorization") === `Bearer ${expected}`;
}

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { name } = await params;
  const architecture = getArchitecture(name);
  if (!architecture || architecture.kind !== "custom" || !architecture.run) {
    return new Response(`Unknown or non-custom architecture: ${name}`, { status: 404 });
  }

  const requestStartedAt = Date.now();
  const body = await req.json();
  const { system, messages } = toAnthropicMessages((body.messages ?? []) as OpenAIMessage[]);
  const tools = toAnthropicTools(body.tools as OpenAITool[] | undefined);
  const id = `chatcmpl-${crypto.randomUUID()}`;

  // Computed up front (pure hashing, no side effects) so a turn-conflict
  // event below can still be tagged with which conversation it happened in.
  const conversationFingerprint = await computeConversationFingerprint(system, messages);

  // Real-world-motivated dedup: ElevenLabs can send more than one request
  // for what is really a single respondent turn.
  const turnFingerprint = await computeTurnFingerprint(system, messages);
  const wonClaim = await claimTurn(turnFingerprint);
  if (!wonClaim) {
    await logCallHealthEvent({ eventType: "turn_conflict", conversationFingerprint, architecture: name });
    const winnerResult = await waitForTurnResult(turnFingerprint, 20_000);
    if (winnerResult) {
      return singleChunkSseResponse(id, MODEL, winnerResult.responseText, winnerResult.responseToolCalls);
    }
    // Winner never recorded a result -- fall through and generate fresh
    // rather than leaving the respondent's turn unanswered.
  }

  const conversation = await getOrInitConversation(conversationFingerprint, name);

  try {
    const result = await architecture.run({
      fingerprint: conversationFingerprint,
      system,
      messages,
      tools,
      firstSeenAt: conversation.firstSeenAt,
      state: conversation.state,
    });

    await updateConversationState(conversationFingerprint, result.nextState);
    await recordTurnResult(turnFingerprint, {
      responseText: result.responseText,
      responseToolCalls: result.responseToolCalls,
      stopReason: result.stopReason,
    });
    await logTurn({
      architecture: name,
      conversationFingerprint,
      model: MODEL,
      requestSystem: system,
      requestMessages: messages,
      requestTools: tools,
      rawRequestBody: body,
      responseText: result.responseText,
      responseToolCalls: result.responseToolCalls,
      stopReason: result.stopReason,
      latencyMs: Date.now() - requestStartedAt,
    });

    return singleChunkSseResponse(id, MODEL, result.responseText, result.responseToolCalls);
  } catch (err) {
    console.error(`architecture "${name}" run() failed:`, err);
    const fallbackText = "Sorry, could you say that again?";
    const errorMessage = err instanceof Error ? err.message : String(err);
    await recordTurnResult(turnFingerprint, { responseText: fallbackText, responseToolCalls: [], stopReason: "error" });
    // Previously unlogged entirely -- a fallback turn left no trace in
    // turn_logs, so the fallback rate wasn't even measurable. Both the full
    // turn log (for the transcript/latency record) and a call-health event
    // (for the aggregate rate) are written now.
    await logTurn({
      architecture: name,
      callType: "moderator",
      conversationFingerprint,
      model: MODEL,
      requestSystem: system,
      requestMessages: messages,
      requestTools: tools,
      rawRequestBody: body,
      responseText: fallbackText,
      responseToolCalls: [],
      stopReason: "error",
      latencyMs: Date.now() - requestStartedAt,
    });
    await logCallHealthEvent({
      eventType: "fallback",
      conversationFingerprint,
      architecture: name,
      detail: { error: errorMessage },
    });
    return singleChunkSseResponse(id, MODEL, fallbackText, []);
  }
}

// So a health-check GET doesn't 405 confusingly during setup.
export async function GET() {
  return Response.json({ ok: true, message: "POST-only endpoint; this is just a liveness check." });
}
