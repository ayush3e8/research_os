/**
 * Baseline's fully guide-visible moderator, prefixed each turn with a short,
 * blunt directive from a fast "System 1" pre-pass -- named after the
 * fast/intuitive vs. slow/deliberate framing: a cheap, quick-judgment model
 * decides "probe further" or "move on" before the real (slower, more
 * capable) moderator call ever runs.
 *
 * Two things distinguish this from lib/architectures/strategist.ts on
 * purpose, both direct responses to problems that architecture actually
 * hit in testing:
 *
 * 1. Synchronous, not backgrounded. strategist.ts's guidance is always one
 *    turn stale (computed via after(), only ready in time for the *next*
 *    turn) -- a deliberate latency trade there. Here the System 1 call is
 *    awaited inline, before the moderator call, so its directive reflects
 *    the respondent's answer that JUST happened, at the cost of one extra
 *    sequential LLM round-trip per turn (same latency trade
 *    livefanout.ts already makes for its synchronous advisors).
 * 2. Plain text, not JSON. lib/architectures/blindmod.ts's strategist
 *    verdict schema repeatedly broke in testing (JSON truncated by
 *    max_tokens, objective_id losing continuity) -- real fragility for a
 *    per-turn call. This mirrors strategist.ts's own guidance call instead:
 *    a single short line of prose, nothing to parse, nothing to lose.
 *
 * The moderator here still sees the WHOLE guide (unlike blindmod) --
 * that's the other half of the bet this architecture is testing: that a
 * fresh, forceful "next you must..." directive placed at the very start of
 * an otherwise-normal baseline prompt is enough to keep a guide-visible
 * moderator from over-probing, without needing to hide the guide from it
 * at all.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, FAST_MODEL, MODEL } from "@/lib/anthropic";
import { pacingNote } from "@/lib/pacing";
import { formatGuideForPrompt, type Guide } from "@/lib/guide";
import { logTurn } from "@/lib/logging";
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

function system1SystemPrompt(guide: Guide, elapsedMinutes: number): string {
  return `You are a fast, blunt research-interview supervisor. You never speak to the
respondent -- you only decide, in one short line, what the moderator should
do on its very next turn.

Study topic: ${guide.studyTopic}

Guide, in order:
${formatGuideForPrompt(guide)}

${pacingNote(elapsedMinutes, guide.targetDurationMinutes)}

Look at the transcript so far, especially the respondent's last answer.
Decide: does the CURRENT guide question still have something specific and
unresolved worth one more probe, or has it been answered with real
substance already?

Output exactly one line, nothing else, no punctuation-free hedging:
- Something specific still worth digging into: "PROBE: " followed by the
  one specific thing to dig into, in a handful of words.
- The current question has a real answer: "MOVE ON: proceed to the next
  guide question."

Be decisive. No explanation, no reasoning, no options -- one line only.`;
}

const FALLBACK_DIRECTIVE = "PROBE: dig into anything the last answer left vague or specific, otherwise move on to the next guide question.";

async function runSystem1Call(req: ArchitectureRequest, elapsedMinutes: number): Promise<string> {
  const startedAt = Date.now();
  const system = system1SystemPrompt(req.guide, elapsedMinutes);
  try {
    const completion = await anthropic().messages.create({
      model: FAST_MODEL,
      max_tokens: 128,
      thinking: { type: "disabled" },
      system,
      messages: req.messages,
    });
    const directive = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    await logTurn({
      architecture: "system1",
      callType: "system1",
      conversationFingerprint: req.fingerprint,
      model: FAST_MODEL,
      requestSystem: system,
      requestMessages: req.messages,
      rawRequestBody: { system, messages: req.messages },
      responseText: directive,
      stopReason: completion.stop_reason,
      latencyMs: Date.now() - startedAt,
    });

    return directive || FALLBACK_DIRECTIVE;
  } catch (err) {
    // Synchronous and on the critical path -- unlike blindmod's backgrounded
    // strategist call, a failure here must not take the whole turn down
    // with it (route.ts's outer catch would replace the entire response
    // with a generic fallback line otherwise). Degrade to a sane default
    // directive instead and let the moderator call proceed normally.
    console.error("system1 pre-pass failed:", err);
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
