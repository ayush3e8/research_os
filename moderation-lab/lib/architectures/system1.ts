/**
 * Baseline's fully guide-visible moderator, prefixed each turn with a short,
 * blunt directive from a fast "System 1" pre-pass -- named after the
 * fast/intuitive vs. slow/deliberate framing: a cheap, quick-judgment call
 * decides "probe further" or "move on" before the real (slower, more
 * capable) moderator call ever runs.
 *
 * Three things distinguish this from lib/architectures/strategist.ts on
 * purpose, all direct responses to problems that architecture actually hit
 * in testing:
 *
 * 1. Synchronous, not backgrounded. strategist.ts's guidance is always one
 *    turn stale (computed via after(), only ready in time for the *next*
 *    turn) -- a deliberate latency trade there. Here the System 1 call is
 *    awaited inline, before the moderator call, so its directive reflects
 *    the respondent's answer that JUST happened, at the cost of one extra
 *    sequential round-trip per turn (same latency trade livefanout.ts
 *    already makes for its synchronous advisors).
 * 2. Not even a chat model. The pre-pass runs on TypeSafe AI's "jev"
 *    model (lib/typesafe.ts) via its system_one classification endpoint,
 *    not Claude -- a structured PROBE-vs-MOVE_ON choice with a confidence
 *    score, not free-text generation. lib/architectures/blindmod.ts's JSON
 *    verdict schema repeatedly broke in testing (truncated by max_tokens,
 *    objective_id losing continuity) precisely because it asked a chat
 *    model to both classify AND compose prose in one shot. Splitting those
 *    apart -- jev classifies, this file composes the actual directive text
 *    in plain TypeScript from that classification -- means there is
 *    nothing to parse or lose: the classification is a validated enum.
 * 3. The moderator here still sees the WHOLE guide (unlike blindmod) --
 *    that's the other half of the bet this architecture is testing: that a
 *    fresh, forceful "next you must..." directive placed at the very start
 *    of an otherwise-normal baseline prompt is enough to keep a
 *    guide-visible moderator from over-probing, without needing to hide
 *    the guide from it at all.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL } from "@/lib/anthropic";
import { pacingNote } from "@/lib/pacing";
import { formatGuideForPrompt, type Guide } from "@/lib/guide";
import { logTurn } from "@/lib/logging";
import { systemOne } from "@/lib/typesafe";
import type { Architecture, ArchitectureRequest, ArchitectureResult } from "./types";

function moderatorSystemPrompt(guide: Guide): string {
  return `You are a warm, curious voice interviewer conducting a live qualitative research interview.

Study topic: ${guide.studyTopic}

Why this study exists (private context -- never say this out loud, but let it actually shape how hard you push on each question; a real business decision depends on getting real answers here, not just moving through the list):
${guide.researchObjective}

Guide (cover these in order, probing when an answer is vague, but don't read this list verbatim):
${formatGuideForPrompt(guide)}

When the guide is fully covered or time is up, deliver this closing line and then use the end_call tool: "${guide.closingScript}"

Keep responses short and conversational -- this is a live voice call, not a written exchange.`;
}

function extractPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type: string; text?: string; content?: unknown }) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "tool_result") return typeof block.content === "string" ? block.content : "";
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

/** jev's system_one has no notion of a chat transcript -- it takes one
 * plain-text `state` describing the whole situation. Folds in the guide
 * (so it knows what "the current guide question" even means) and the
 * pacing note (so a timing gate can factor into the classification),
 * exactly like the moderator's own prompt does, just serialized flat. */
function buildState(guide: Guide, elapsedMinutes: number, messages: ArchitectureRequest["messages"]): string {
  const transcript = messages
    .map((m) => ({ role: m.role, text: extractPlainText(m.content).trim() }))
    .filter((m) => m.text !== "")
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");
  return `Study topic: ${guide.studyTopic}

Guide, in order:
${formatGuideForPrompt(guide)}

${pacingNote(elapsedMinutes, guide.targetDurationMinutes)}

Transcript so far (interviewer is "assistant", respondent is "user"):
${transcript}`;
}

const DIRECTIVES: Record<string, string> = {
  probe: "PROBE: there's something specific in their last answer still worth digging into before moving on.",
  move_on: "MOVE ON: the current guide question has a real, substantive answer -- proceed to the next one.",
};
const FALLBACK_DIRECTIVE = DIRECTIVES.probe;

async function runSystem1Call(req: ArchitectureRequest, elapsedMinutes: number): Promise<string> {
  const startedAt = Date.now();
  const state = buildState(req.guide, elapsedMinutes, req.messages);
  try {
    const result = await systemOne({
      state,
      questions: {
        action: {
          type: "choice",
          instructions:
            "Whether the moderator's very next turn should keep probing the CURRENT guide question, or move on to the next one.",
          criteria: {
            probe:
              "The respondent's last answer left something specific and unresolved on the CURRENT guide question that's worth one more question.",
            move_on:
              "The current guide question already has a real, substantive answer -- time to proceed to the next guide question.",
          },
        },
      },
    });
    const answer = result.answers.action;
    const choice = answer?.type === "choice" ? answer.choice : "probe";
    const directive = DIRECTIVES[choice] ?? FALLBACK_DIRECTIVE;

    await logTurn({
      architecture: "system1",
      callType: "system1",
      conversationFingerprint: req.fingerprint,
      model: result.model,
      requestSystem: state,
      requestMessages: req.messages,
      rawRequestBody: { state, questions: { action: choice } },
      responseText: `${choice} (confidence ${answer?.type === "choice" ? answer.confidence : "?"}) -> ${directive}`,
      stopReason: null,
      latencyMs: Date.now() - startedAt,
    });

    return directive;
  } catch (err) {
    // Synchronous and on the critical path -- unlike blindmod's backgrounded
    // strategist call, a failure here must not take the whole turn down
    // with it (route.ts's outer catch would replace the entire response
    // with a generic fallback line otherwise). Degrade to a sane default
    // directive instead and let the moderator call proceed normally.
    console.error("system1 (jev) pre-pass failed:", err);
    return FALLBACK_DIRECTIVE;
  }
}

export const system1Architecture: Architecture = {
  name: "system1",
  kind: "custom",
  async run(req): Promise<ArchitectureResult> {
    const elapsedMinutes = (Date.now() - req.firstSeenAt.getTime()) / 60_000;
    const directive = await runSystem1Call(req, elapsedMinutes);

    const system =
      `NEXT, you must: ${directive}\n\n` +
      `${req.system}\n\n${moderatorSystemPrompt(req.guide)}\n\n${pacingNote(elapsedMinutes, req.guide.targetDurationMinutes)}`;

    const completion = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system,
      messages: req.messages,
      tools: req.tools.length ? req.tools : undefined,
    });

    const responseText = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const responseToolCalls = completion.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      responseText,
      responseToolCalls,
      stopReason: completion.stop_reason,
      nextState: req.state, // nothing carried forward -- the system1 call is stateless, fresh off the live transcript every turn
    };
  },
};
