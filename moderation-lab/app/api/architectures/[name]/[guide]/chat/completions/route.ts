/**
 * The endpoint ElevenLabs calls once per conversational turn for any
 * custom-LLM architecture. Must live at exactly this path (down to
 * /chat/completions) -- ElevenLabs treats the configured custom_llm.url as
 * a base and appends /chat/completions itself. The [guide] segment is
 * baked into that url at provision time (app/api/agents/provision) and
 * read fresh on every turn here -- see lib/guide.ts's module docstring for
 * why guide is a per-call choice rather than a fixed deploy-time constant,
 * and architecture_agents' docstring in db/schema.ts for why each
 * (architecture, guide) pair gets its own ElevenLabs agent.
 *
 * Everything else architecture-agnostic (auth, wire-format translation,
 * turn dedup, cross-turn state bootstrap, logging) lives here. What
 * actually gets said is entirely delegated to the named architecture's
 * `run()`.
 */
import { getArchitecture } from "@/lib/architectures/registry";
import { computeConversationFingerprint } from "@/lib/conversation-state";
import { logCallHealthEvent } from "@/lib/call-health";
import { getGuide } from "@/lib/guide";
import { MODEL } from "@/lib/anthropic";
import { singleChunkSseResponse, toAnthropicMessages, toAnthropicTools } from "@/lib/openai-translate";
import { claimTurn, computeTurnFingerprint, recordTurnResult, waitForTurnResult } from "@/lib/turn-dedup";
import { runArchitectureTurn } from "@/lib/turn-runner";
import type { OpenAIMessage, OpenAITool } from "@/lib/openai-translate";

// Architectures that schedule background work via next/server's after()
// (strategist, fanout) share this same invocation's time budget for that
// work -- waitUntil()/after() promises get the SAME timeout as the request
// itself, not an extended one. Without an explicit override this route
// used Vercel's plan default, which is short enough that a real background
// reasoning call (a full extra Claude round-trip on top of the moderator's
// own) could get silently killed before finishing -- no error, no logged
// row, exactly the failure mode a real strategist test call hit.
//
// That maxDuration bump alone did NOT fix it: querying call_health_events
// after real strategist test calls shows zero background_reasoning_started
// rows across ~80 real moderator turns -- runStrategistCall's after()
// callback is not merely failing, it never starts at all. The one concrete
// difference from the old, reportedly-reliable moderator+strategist repo
// (archive/old-code-agentic-mr-pharma) this route doesn't share: that
// repo's equivalent endpoint ran on `export const runtime = "edge"`; this
// route had no runtime declared, defaulting to Vercel's Node.js serverless
// runtime, which has different rules for whether work scheduled via
// after()/waitUntil actually keeps running once the response is sent.
// Switching to edge to match it -- verified first that every lib this
// route touches (Anthropic SDK, Neon's serverless driver, turn-dedup's
// Web Crypto hashing) is fetch/Web-Crypto-based with no Node-only APIs, so
// nothing else here needs to change for edge compatibility.
//
// livefanout doesn't schedule anything via after() at all -- its three
// advisors run synchronously, in parallel, before the moderator call, all
// within this same invocation -- but it still benefits from the same
// generous maxDuration: up to four sequential Claude round trips (three
// concurrent advisors, then the moderator) need real time to complete
// before this route's own response goes out.
export const runtime = "edge";
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const expected = process.env.CUSTOM_LLM_WEBHOOK_SECRET;
  if (!expected) return false;
  return req.headers.get("authorization") === `Bearer ${expected}`;
}

export async function POST(req: Request, { params }: { params: Promise<{ name: string; guide: string }> }) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { name, guide: guideName } = await params;
  const architecture = getArchitecture(name);
  if (!architecture || architecture.kind !== "custom" || !architecture.run) {
    return new Response(`Unknown or non-custom architecture: ${name}`, { status: 404 });
  }
  const guide = getGuide(guideName);
  if (!guide) {
    return new Response(`Unknown guide: ${guideName}`, { status: 404 });
  }

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

  // Delegates the actual run+persist+log sequence to lib/turn-runner.ts,
  // shared with lib/simulation's text-only driver -- see that module's
  // docstring for why. This route still owns everything about receiving a
  // turn from ElevenLabs specifically: the dedup claim above, the wire
  // translation already done, and recording the result for dedup below.
  const result = await runArchitectureTurn({
    architectureName: name,
    guideName,
    conversationFingerprint,
    system,
    messages,
    tools,
    rawRequestBody: body,
  });

  await recordTurnResult(turnFingerprint, {
    responseText: result.responseText,
    responseToolCalls: result.responseToolCalls,
    stopReason: result.stopReason,
  });

  return singleChunkSseResponse(id, MODEL, result.responseText, result.responseToolCalls);
}

// So a health-check GET doesn't 405 confusingly during setup.
export async function GET() {
  return Response.json({ ok: true, message: "POST-only endpoint; this is just a liveness check." });
}
