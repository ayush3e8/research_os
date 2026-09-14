// Deliberately on an older, pinned @anthropic-ai/sdk (aliased as
// anthropic-sdk-realtime in package.json) instead of the same version the
// rest of the app uses. >=0.66 statically imports node:fs/node:path (new
// local credential-file support), which the edge bundler can't resolve —
// this route needs edge runtime for latency, and doesn't need the
// structured-outputs features that motivated the upgrade elsewhere (see
// inngest/functions.ts), so it stays on the last edge-compatible version
// instead of dragging the whole app back. If a future feature here needs
// something from the newer SDK, that's the point to revisit this split.
import Anthropic from "anthropic-sdk-realtime";
import { after } from "next/server";
import { db } from "@/db";
import { llmTurnLogs } from "@/db/schema";
import {
  computeFingerprint,
  readCachedDirective,
  refreshCachedDirective,
  truncateMessagesSafely,
  TRUNCATE_THRESHOLD,
  KEEP_RECENT_MESSAGES,
  type LiveDirective,
} from "@/lib/live-directive-agent";
import { computeTurnFingerprint, claimTurn, recordTurnResult, waitForTurnResult, type TurnResult } from "@/lib/turn-dedup";

// ElevenLabs' Custom LLM integration calls this endpoint exactly like an
// OpenAI-compatible /chat/completions server (Bearer auth, same request/
// response and SSE chunk shape). This route is the seam described in
// Section 6: ElevenLabs is the voice/orchestration shell, Claude is the
// actual reasoning layer. Everything Claude-specific lives here, not in
// ElevenLabs agent settings.
//
// This file must live at .../custom-llm/chat/completions — ElevenLabs treats
// the configured custom_llm.url as a base and appends /chat/completions
// itself (verified against the live API; the base-path route 404'd on every
// real call). lib/elevenlabs-agent-provisioning.ts (every agent's creation
// path, per-study or shared) sets url to the base on purpose.

// Edge runtime: no Node cold-start tax, and Vercel serves it from the region
// nearest the caller — both matter for a real-time voice turn.
export const runtime = "edge";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Day 1 placeholder only — Day 2-3 replaces this with the Study config's
// discussion_guide + guardrail_prompt, looked up per-call (see db/schema.ts
// `studies` table). Do not hardcode real guardrails/discussion guides here
// beyond today's smoke test, per Section 6.
const DAY_ONE_SYSTEM_PROMPT = `You are an AI research interviewer conducting a short voice
interview for a pharma market research pilot. Today is a Day 1 wiring test: greet the caller,
confirm you can hear them, ask one open-ended question about their work, and let them know this
is a test of the voice pipeline, not a real study interview yet.`;

// Jul 26 real crash, root-caused from llm_turn_logs on a live test call: two
// consecutive moderator turns (near-duplicate requests, ~3s apart, from
// ElevenLabs re-sending as ASR finalized a growing utterance) both came back
// from Claude with stop_reason "end_turn" and zero content — no text, no
// tool_use. A real, successful API call that simply produced nothing. This
// wasn't a truncation or message-shape bug (both requests were clean); it's
// rare, stochastic empty-completion behavior. ElevenLabs has no tolerance
// for it: a stream with zero content deltas is reported back as
// "LLM Cascade Error: Brain returned no response" and kills the call. Never
// let that reach ElevenLabs — retry once server-side (see
// MAX_MODERATOR_ATTEMPTS below), and if every attempt still comes back
// empty, send this rather than nothing at all.
const FALLBACK_MODERATOR_TEXT = "Sorry, could you say that again?";
const MAX_MODERATOR_ATTEMPTS = 2;

type OpenAIToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type OpenAITool = { type: "function"; function: { name: string; description?: string; parameters?: object } };

function isAuthorized(req: Request): boolean {
  const expected = process.env.CUSTOM_LLM_WEBHOOK_SECRET;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

// ElevenLabs exposes agent tools (end_call, show_stimulus, ...) to us via
// the standard OpenAI function-calling wire format. Missing this originally
// meant Claude never actually saw the tools existed — it could only talk
// about ending the call or showing an image, never really do either.
function toAnthropicTools(tools: OpenAITool[] | undefined): Anthropic.Tool[] {
  if (!tools) return [];
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: (t.function.parameters as Anthropic.Tool["input_schema"]) ?? {
      type: "object",
      properties: {},
    },
  }));
}

function toAnthropicMessages(messages: OpenAIMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const rest: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      rest.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
      rest.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      rest.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      });
    }
  }

  // Real incident, Jul 10: a live call dropped mid-interview with a real
  // prospect after two consecutive 400s — "This model does not support
  // assistant message prefill. The conversation must end with a user
  // message." Sonnet 5 hard-rejects any request whose message list ends in
  // an assistant turn (no prefill support on this model family). ElevenLabs'
  // Custom LLM protocol can re-send history ending in its own prior
  // assistant turn — observed right around a reconnect — which is valid for
  // OpenAI-style providers but not Anthropic's. Strip trailing assistant
  // turns defensively so a malformed request from ElevenLabs can never reach
  // Anthropic this way again, regardless of why ElevenLabs sent it. Guard
  // against stripping everything (an empty array would just trade this 400
  // for a different one) — fall back to the original, untouched array in
  // that edge case rather than sending nothing.
  let trimmed = rest.length;
  while (trimmed > 0 && rest[trimmed - 1].role === "assistant") {
    trimmed -= 1;
  }
  const safeMessages = trimmed > 0 ? rest.slice(0, trimmed) : rest;

  return { system: system || DAY_ONE_SYSTEM_PROMPT, messages: safeMessages };
}

// Jul 15: first-party word-for-word record of every live-call exchange with
// Claude — until now, root-causing a live bug (the repetition-loop
// incident) meant leaning on ElevenLabs' own transcript reconstruction
// instead of the actual request we sent. Fire-and-forget via Next's
// after(), which runs once the response has already been sent, so it can
// never add latency to a real call, and wrapped so a logging failure can
// never break one either. conversationId is opportunistic (ElevenLabs'
// custom-LLM body doesn't reliably carry one) — rawRequestBody is kept
// verbatim specifically so nothing is lost if it doesn't resolve.
function logTurn(input: {
  callType?: "moderator" | "strategist";
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  rawBody: unknown;
  responseText: string;
  responseToolCalls: { id: string; name: string; input: unknown }[];
  stopReason: string | null;
  latencyMs: number;
}) {
  after(async () => {
    try {
      const raw = input.rawBody as Record<string, unknown> | null;
      const conversationId =
        typeof raw?.conversation_id === "string"
          ? raw.conversation_id
          : typeof raw?.user === "string"
            ? raw.user
            : null;

      await db.insert(llmTurnLogs).values({
        conversationId,
        callType: input.callType ?? "moderator",
        model: "claude-sonnet-5",
        requestSystem: input.system,
        requestMessages: input.messages,
        requestTools: input.tools,
        rawRequestBody: input.rawBody ?? {},
        responseText: input.responseText || null,
        responseToolCalls: input.responseToolCalls,
        stopReason: input.stopReason,
        latencyMs: input.latencyMs,
      });
    } catch (err) {
      console.error("llm_turn_logs write failed:", err);
    }
  });
}

// Jul 15 two-persona split, v2 (pipelined — v1 ran the strategist
// synchronously in-request and crashed two real test calls on latency, see
// CLAUDE.md). Below TRUNCATE_THRESHOLD messages, skip this entirely and
// behave exactly as before — zero added cost, not even a DB read, for the
// opening portion of every call. Past that, this is a fast DB lookup only
// (readCachedDirective) — never a Claude call — for whatever the
// background pass computed one turn ago. If nothing's cached yet
// (bootstrap turn) or the lookup fails, falls back to full history with no
// directive, same as before.
async function buildModeratorRequest(
  system: string,
  messages: Anthropic.MessageParam[],
  fingerprint: string | null
): Promise<{
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  directive: LiveDirective | null;
}> {
  const baseSystem: Anthropic.TextBlockParam[] = [
    { type: "text", text: system, cache_control: { type: "ephemeral" } },
  ];

  if (messages.length <= TRUNCATE_THRESHOLD || !fingerprint) {
    return { system: baseSystem, messages, directive: null };
  }

  const directive = await readCachedDirective(fingerprint);
  if (!directive) {
    return { system: baseSystem, messages, directive: null };
  }

  const truncatedMessages = truncateMessagesSafely(messages, KEEP_RECENT_MESSAGES);
  const augmentedSystem: Anthropic.TextBlockParam[] = [
    ...baseSystem,
    {
      type: "text",
      text: `\n\nStrategist summary of everything covered so far in this interview (rely on this instead of the full history for anything before your recent turns below):\n${directive.recentSummary}\n\nStrategist directive for your NEXT turn only: ${directive.directive}\nDo only this one thing in your response, then stop — do not also do whatever would naturally come after it (a wrap-up, a further question, anything else). That comes later, in a future turn, once the respondent has actually replied. CRITICAL — this directive (including any reasoning in it, like "given the time constraint") is a private instruction to you, never something to say or paraphrase out loud. Never open your response by reporting your own plan or reasoning ("I need to wrap up...", "I'll ask one more thing...", "Given the time constraint, I..."). Instead: (1) always acknowledge what the respondent just said FIRST, before anything else — that is your actual next line, not an afterthought tacked on after a meta-comment; (2) if you genuinely need to tell the respondent time is short, that's fine to say, but weave it naturally into the same breath as the acknowledgment and the question, the way a real interviewer would ("...that makes sense. We're almost out of time, so let me ask one last thing — ...") — never as a standalone sentence before the acknowledgment. Exception: this directive was computed one turn behind, so events can occasionally outrun it — if the recent messages below already show this exact action has happened (e.g. it told you to ask why they gave a rating, and you already asked and they already answered), don't just stop with nothing left to say. Use your own judgment to move the conversation forward naturally instead — a brief acknowledgment and a transition to whatever's next — the same way you would before any strategist guidance existed, rather than leaving the conversation waiting on nothing until an unrelated system event (a pacing update, a timeout) eventually breaks the silence. The end_call tool is only available to you this turn if this directive explicitly told you to end the call — if it didn't, do not attempt to end the call on your own judgment, even if the interview feels complete; that decision belongs to the strategist.`,
    },
  ];

  return { system: augmentedSystem, messages: truncatedMessages, directive };
}

// Jul 15: end_call is ElevenLabs' own built-in system tool — once Claude
// calls it, ElevenLabs acts on it immediately, with no interception point
// on our side (unlike show_question/show_stimulus, there's no client-side
// handler to validate its arguments first). Real bug: the moderator called
// it once with the interview clearly incomplete and literal "placeholder"
// arguments, directly against a strategist directive that said to keep
// probing — root cause was a *soft* standing instruction in the static
// system prompt ("you own ending the call") with nothing structurally
// enforcing it. Ayush's fix: once strategist guidance is active, only the
// strategist may approve ending — enforced here by removing end_call from
// what's even offered to the moderator unless its current directive
// explicitly says to end. Before any directive exists yet (early in the
// call), the moderator keeps its own judgment, unchanged.
// Jul 17 real crash, root-caused precisely from llm_turn_logs: this turn's
// message count (14) was already past TRUNCATE_THRESHOLD (12), but no
// strategist directive had been cached yet — the bootstrap gap between
// "long enough that the strategist should be governing" and "the strategist
// has actually run once." The original `if (!directive) return tools`
// treated that gap identically to genuinely early in the call (the
// documented, intended exemption), so end_call stayed fully available with
// nothing constraining it — and the moderator called it with literal
// placeholder arguments right after being interrupted mid-question, ending
// a 25-minute study at the 2-minute mark. Fixed by keying the exemption on
// the real signal (are we past the threshold at all) rather than on
// whether a directive happens to exist yet — a directive-less turn past
// the threshold is now treated the same as an explicit non-ending
// directive (end_call stripped), not the same as a pre-threshold turn.
function filterModeratorTools(
  tools: Anthropic.Tool[],
  directive: LiveDirective | null,
  pastTruncateThreshold: boolean
): Anthropic.Tool[] {
  if (!pastTruncateThreshold) return tools;
  const directiveSaysEnd = directive ? /\bend\b[^.]*\bcall\b/i.test(directive.directive) : false;
  if (directiveSaysEnd) return tools;
  return tools.filter((t) => t.name !== "end_call");
}

// Background half of the pipeline: runs AFTER a turn's response has
// already been sent (via after(), same non-blocking pattern as logTurn),
// using the CURRENT full history — including what the respondent just
// said this turn — to compute the directive the NEXT turn will read.
// Never on the critical path; a failure here just means next turn falls
// back to no directive, same fail-safe posture as everything else.
function scheduleDirectiveRefresh(fingerprint: string | null, system: string, messages: Anthropic.MessageParam[], rawBody: unknown) {
  if (!fingerprint || messages.length <= TRUNCATE_THRESHOLD) return;
  after(async () => {
    const startedAt = Date.now();
    const directive = await refreshCachedDirective(fingerprint, system, messages);
    logTurn({
      callType: "strategist",
      system,
      messages,
      tools: [],
      rawBody,
      responseText: directive ? `${directive.recentSummary}\n\n${directive.directive}` : "",
      responseToolCalls: [],
      stopReason: directive ? "tool_use" : "failed",
      latencyMs: Date.now() - startedAt,
    });
  });
}

// Non-streaming counterpart to the retry loop in the SSE path below — see
// the Jul 26 comment on FALLBACK_MODERATOR_TEXT for why this exists. Safe to
// simply call again on an empty result: nothing has been returned to
// ElevenLabs yet on this path either way, since a non-streaming response
// can't be sent until it's fully built.
async function callModeratorWithRetry(
  moderatorSystem: Anthropic.TextBlockParam[],
  moderatorMessages: Anthropic.MessageParam[],
  moderatorTools: Anthropic.Tool[]
): Promise<Anthropic.Message> {
  let completion: Anthropic.Message | null = null;
  for (let attempt = 1; attempt <= MAX_MODERATOR_ATTEMPTS; attempt++) {
    completion = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system: moderatorSystem,
      messages: moderatorMessages,
      tools: moderatorTools.length ? moderatorTools : undefined,
    });
    const hasContent = completion.content.some((b) => b.type === "text" || b.type === "tool_use");
    if (hasContent) return completion;
    console.error(`Moderator returned empty completion (attempt ${attempt}/${MAX_MODERATOR_ATTEMPTS})`, {
      stopReason: completion.stop_reason,
    });
  }
  return completion!; // exhausted retries — caller falls back to FALLBACK_MODERATOR_TEXT
}

// Jul 15 real-turn dedup: a losing duplicate never calls Claude at all — it
// waits for the winner's already-in-flight result (lib/turn-dedup.ts) and
// replays it in the same wire shape a fresh generation would have produced,
// so ElevenLabs can't tell the difference. Mirrors openAiChatCompletion's
// shape for the non-streaming path.
function mirroredJsonResponse(result: TurnResult) {
  return Response.json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "claude-sonnet-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.responseText || null,
          ...(result.responseToolCalls.length
            ? {
                tool_calls: result.responseToolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function" as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.input) },
                })),
              }
            : {}),
        },
        finish_reason: result.responseToolCalls.length ? "tool_calls" : "stop",
      },
    ],
  });
}

// Streaming equivalent — replays the winner's already-complete text/tool
// calls as a single set of deltas rather than the token-by-token deltas a
// fresh generation would have produced. ElevenLabs' client only cares about
// the accumulated result, not the delta granularity.
function mirroredStreamResponse(result: TurnResult) {
  const sseStream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const id = `chatcmpl-${crypto.randomUUID()}`;
      const send = (chunk: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

      if (result.responseText) {
        send(openAiChunk(id, { content: result.responseText }));
      }
      result.responseToolCalls.forEach((tc, index) => {
        send(
          openAiChunk(id, {
            tool_calls: [
              { index, id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) } },
            ],
          })
        );
      });
      send(openAiChunk(id, {}, result.responseToolCalls.length ? "tool_calls" : "stop"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await req.json();
  const { system, messages } = toAnthropicMessages(body.messages ?? []);
  const tools = toAnthropicTools(body.tools);
  const stream = body.stream ?? true;
  const requestStartedAt = Date.now();

  // Jul 15 real-turn dedup: a real burst on a real call showed ElevenLabs
  // sending the exact same finalized message array to us three separate
  // times in ~6 seconds (plus, separately, dispatching early on an interim
  // ASR fragment) — 7 near-simultaneous Claude API calls for what a
  // respondent experienced as answering one question, a likely contributor
  // to a genuine "Overloaded" 529 crash the same day. Deliberately scoped to
  // EXACT duplicate requests only (see lib/turn-dedup.ts) — never a
  // prefix/near-match, since a near-match could mean the respondent's
  // answer actually changed between two requests, and answering that with a
  // stale cached response would be worse than the duplicate-call cost this
  // fixes. Computed on the untouched incoming system/messages, before any
  // truncation or strategist-directive augmentation, so it reflects exactly
  // what ElevenLabs sent, independent of our own downstream processing.
  const turnFingerprint = await computeTurnFingerprint(system, messages);
  const wonClaim = await claimTurn(turnFingerprint);

  if (!wonClaim) {
    const winnerResult = await waitForTurnResult(turnFingerprint, 20_000);
    if (winnerResult) {
      return stream ? mirroredStreamResponse(winnerResult) : mirroredJsonResponse(winnerResult);
    }
    // Winner never recorded a result (crashed, or genuinely still running
    // past the wait) — fail safe by generating fresh rather than leaving
    // the respondent's turn unanswered. Falls through to the normal path
    // below exactly as if this request had won the claim.
  }

  // Real latency complaint, Jul 10: turns felt slower than they should,
  // especially the first one after the opener. The system prompt (full
  // discussion guide + conversation-skills instructions + any background
  // knowledge) is thousands of tokens and byte-identical across every turn
  // of a given call, but nothing was ever caching it — Anthropic reprocessed
  // it from scratch on every single turn. A cache_control breakpoint on the
  // last (only) system block also caches the tools array ahead of it (same
  // request, rendered tools -> system -> messages) — one marker covers both.
  // This doesn't help the very first turn of a call (that one pays the
  // cache-write premium), but every turn after it should read from cache
  // instead of reprocessing the full prompt, which is exactly where the
  // "still awkward pauses mid-call" complaint points.
  // Fingerprint computation is pure hashing (Web Crypto), not a Claude call
  // or DB round trip — cheap enough to always compute, gated the same as
  // everything else by TRUNCATE_THRESHOLD inside the two functions below.
  const fingerprint = messages.length > TRUNCATE_THRESHOLD ? await computeFingerprint(system, messages) : null;

  // Schedules the background half of the pipeline (fire-and-forget, never
  // awaited) — computes and caches the directive the NEXT turn will read,
  // using this turn's full history. Deliberately called with the
  // pre-truncation `messages`/`system`, not moderatorMessages/moderatorSystem.
  scheduleDirectiveRefresh(fingerprint, system, messages, body);

  if (!stream) {
    // Non-streaming path: ElevenLabs sends stream:true on every real request
    // observed so far, so this is a fallback, not the hot path the TTFB fix
    // below targets. A non-streaming response can't be returned before its
    // body is fully ready anyway, so there's no equivalent reorder to make
    // here — buildModeratorRequest stays inline.
    const {
      system: moderatorSystem,
      messages: moderatorMessages,
      directive,
    } = await buildModeratorRequest(system, messages, fingerprint);
    const moderatorTools = filterModeratorTools(tools, directive, messages.length > TRUNCATE_THRESHOLD);
    // Sonnet 5 runs adaptive thinking by default when omitted from the
    // request — an extra reasoning pass before any visible text, which is
    // the wrong tradeoff for a real-time conversational voice turn. Off for
    // now; revisit if guardrail enforcement needs deeper reasoning later.
    // (Retry-on-empty-completion happens inside callModeratorWithRetry.)
    const completion = await callModeratorWithRetry(moderatorSystem, moderatorMessages, moderatorTools);
    let responseText = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const responseToolCalls = completion.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    if (!responseText && responseToolCalls.length === 0) {
      console.error("Moderator exhausted retries with empty completion — using fallback text", {
        stopReason: completion.stop_reason,
      });
      responseText = FALLBACK_MODERATOR_TEXT;
    }
    const nonStreamResult: TurnResult = {
      responseText,
      responseToolCalls,
      stopReason: completion.stop_reason,
    };
    logTurn({
      system: moderatorSystem.map((b) => b.text).join(""),
      messages: moderatorMessages,
      tools: moderatorTools,
      rawBody: body,
      ...nonStreamResult,
      latencyMs: Date.now() - requestStartedAt,
    });
    await recordTurnResult(turnFingerprint, nonStreamResult);
    return Response.json(openAiChatCompletion(responseText, responseToolCalls));
  }

  const sseStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const id = `chatcmpl-${crypto.randomUUID()}`;
      const send = (chunk: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

      try {
        // Jul 15 TTFB fix: this DB-dependent lookup used to run before the
        // Response (and its SSE headers/connection) was ever returned to
        // ElevenLabs, adding a real Neon round-trip to the wait before it
        // saw byte one of anything back from us. ElevenLabs' own docs
        // describe exactly this condition ("if a success response isn't
        // returned promptly") as the trigger for it retrying the whole
        // request — matching two real duplicate-request incidents traced
        // from a live call today (repeated question, a leaked "Given the
        // time constraint..." sentence). Moving this lookup here means
        // POST() already returned the Response below before this ever
        // starts running.
        const {
          system: moderatorSystem,
          messages: moderatorMessages,
          directive,
        } = await buildModeratorRequest(system, messages, fingerprint);
        const moderatorTools = filterModeratorTools(tools, directive, messages.length > TRUNCATE_THRESHOLD);

        // Jul 26: retry loop around the stream, not just a single attempt.
        // Nothing is ever enqueued to the client except from inside the
        // event loop below, driven by actual content events — so an attempt
        // that produces zero content sends zero bytes, and it's safe to
        // throw it away and try again. Only once every attempt comes back
        // empty do we fall back to FALLBACK_MODERATOR_TEXT rather than ever
        // closing the stream with nothing in it (see the comment on
        // FALLBACK_MODERATOR_TEXT for the real incident this fixes).
        let sawToolUse = false;
        let sawContent = false;
        let finalMessage: Anthropic.Message | null = null;

        for (let attempt = 1; attempt <= MAX_MODERATOR_ATTEMPTS && !sawContent; attempt++) {
          const anthropicStream = anthropic.messages.stream({
            model: "claude-sonnet-5",
            max_tokens: 1024,
            thinking: { type: "disabled" },
            system: moderatorSystem,
            messages: moderatorMessages,
            tools: moderatorTools.length ? moderatorTools : undefined,
          });

          let toolCallIndex = -1;
          const blockIndexToToolCallIndex = new Map<number, number>();

          for await (const event of anthropicStream) {
            if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
              sawToolUse = true;
              sawContent = true;
              toolCallIndex += 1;
              blockIndexToToolCallIndex.set(event.index, toolCallIndex);
              send(
                openAiChunk(id, {
                  tool_calls: [
                    {
                      index: toolCallIndex,
                      id: event.content_block.id,
                      type: "function",
                      function: { name: event.content_block.name, arguments: "" },
                    },
                  ],
                })
              );
            } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              sawContent = true;
              send(openAiChunk(id, { content: event.delta.text }));
            } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
              const tcIndex = blockIndexToToolCallIndex.get(event.index);
              if (tcIndex !== undefined) {
                send(
                  openAiChunk(id, {
                    tool_calls: [{ index: tcIndex, function: { arguments: event.delta.partial_json } }],
                  })
                );
              }
            }
          }

          finalMessage = await anthropicStream.finalMessage();
          if (!sawContent) {
            console.error(`Moderator returned empty completion (attempt ${attempt}/${MAX_MODERATOR_ATTEMPTS})`, {
              stopReason: finalMessage.stop_reason,
            });
          }
        }

        if (!sawContent) {
          send(openAiChunk(id, { content: FALLBACK_MODERATOR_TEXT }));
        }

        send(openAiChunk(id, {}, sawToolUse ? "tool_calls" : "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();

        const streamResult: TurnResult = {
          responseText: sawContent
            ? finalMessage!.content
                .filter((b): b is Anthropic.TextBlock => b.type === "text")
                .map((b) => b.text)
                .join("")
            : FALLBACK_MODERATOR_TEXT,
          responseToolCalls: sawContent
            ? finalMessage!.content
                .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
                .map((b) => ({ id: b.id, name: b.name, input: b.input }))
            : [],
          stopReason: finalMessage!.stop_reason,
        };
        logTurn({
          system: moderatorSystem.map((b) => b.text).join(""),
          messages: moderatorMessages,
          tools: moderatorTools,
          rawBody: body,
          ...streamResult,
          latencyMs: Date.now() - requestStartedAt,
        });
        await recordTurnResult(turnFingerprint, streamResult);
      } catch (err) {
        // Jul 15 real gap found investigating a real crash: this catch had
        // no logging at all — a mid-stream failure (e.g. Anthropic
        // returning a transient 529 on the live moderator call, not just
        // the background strategist) was completely invisible to us,
        // versus ElevenLabs' own record showing "custom_llm generation
        // failed" / "LLM Cascade Error" with nothing on our side to
        // corroborate it. Logging here doesn't fix the underlying
        // transient-error case, but the next one won't be a total mystery.
        console.error("Moderator stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function openAiChatCompletion(text: string, toolCallBlocks: { id: string; name: string; input: unknown }[]) {
  const toolCalls = toolCallBlocks.map((b) => ({
    id: b.id,
    type: "function" as const,
    function: { name: b.name, arguments: JSON.stringify(b.input) },
  }));

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "claude-sonnet-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
  };
}

function openAiChunk(id: string, delta: object, finishReason: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "claude-sonnet-5",
    choices: [
      {
        index: 0,
        delta: finishReason ? {} : delta,
        finish_reason: finishReason,
      },
    ],
  };
}
