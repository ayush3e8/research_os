/**
 * system1.ts's jev pre-pass taken one step further: instead of jev only
 * ever producing a directive the full moderator LLM then acts on, jev can
 * fully author some turns itself, from a fixed bank of content-free probe
 * lines (lib/architectures/probe-bank.ts) -- the moderator LLM only runs
 * when jev decides the situation genuinely needs it. The bet: a large
 * fraction of real probing turns ("say more about that", "what makes you
 * say that") don't need to reference anything specific the respondent just
 * said, so a cheap classifier picking a pre-written line is functionally
 * indistinguishable from the LLM writing the same thing, at a fraction of
 * the cost and latency.
 *
 * One jev call answers TWO questions at once (no extra round trip over
 * system1's single-question pre-pass):
 * - `situation`: generic_probe / specific_probe / move_on / wrap_up.
 * - `category`: which bank category fits, answered unconditionally (jev has
 *   no notion of "skip this question"), only consulted when situation is
 *   generic_probe.
 *
 * Only `generic_probe`, with BOTH answers above a confidence threshold,
 * skips the moderator LLM entirely. Everything else -- specific_probe (the
 * respondent said something a generic line would feel disconnected from),
 * move_on (advancing topics, which needs either reading the next guide
 * question or judgment about a sectioned guide's flexible coverage),
 * wrap_up (closing, needs the real end_call tool call), or a
 * low-confidence generic_probe -- falls through to the exact same
 * full-guide-visible moderator call system1.ts makes, just with a
 * three-way directive instead of system1's two-way probe/move_on one.
 *
 * A low-confidence classification demoting to the LLM path rather than
 * trusting the bank anyway is the deliberate safety margin here: a
 * mismatched canned line reads as a broken non-sequitur in a way a
 * slightly-generic LLM-composed probe never does, so the failure mode of
 * being wrong has to bias toward the expensive-but-safe path, not the
 * cheap one.
 */
import { MODEL } from "@/lib/anthropic";
import { pacingNote } from "@/lib/pacing";
import { formatGuideForPrompt, type Guide } from "@/lib/guide";
import { logTurn } from "@/lib/logging";
import { systemOne } from "@/lib/typesafe";
import { callModeratorLLM } from "@/lib/moderator-call";
import type { Architecture, ArchitectureRequest, ArchitectureResult } from "./types";
import {
  PROBE_CATEGORIES,
  INITIAL_PROBE_BANK_STATE,
  isProbeCategory,
  pickProbeLine,
  type ProbeBankState,
} from "./probe-bank";

// Below this, `situation` isn't confident enough to trust generic_probe --
// see module docstring's safety-margin reasoning.
const SITUATION_CONFIDENCE_THRESHOLD = 0.65;

// `category` picks among 7 options (vs. situation's 4), which structurally
// spreads probability mass thinner even on a clear-cut case -- confirmed
// directly against jev: a hand-written, deliberately unambiguous
// generic-probe state ("yeah, I dont know, whatever.") scored category
// confidence 0.62, which the old shared 0.65 threshold would have rejected
// despite situation itself being 0.84 confident. Lower and separate from
// situation's threshold rather than assuming the two compare on the same
// scale.
const CATEGORY_CONFIDENCE_THRESHOLD = 0.5;

// Identical to system1.ts's moderatorSystemPrompt (itself baseline's own
// full guide-visible prompt) -- duplicated rather than imported, matching
// this project's existing per-architecture self-containment (system1.ts
// did the same relative to baseline.ts).
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

function buildState(
  guide: Guide,
  elapsedMinutes: number,
  messages: ArchitectureRequest["messages"],
  lastCategory: string | null
): string {
  const transcript = messages
    .map((m) => ({ role: m.role, text: extractPlainText(m.content).trim() }))
    .filter((m) => m.text !== "")
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");
  return `Study topic: ${guide.studyTopic}

Guide, in order:
${formatGuideForPrompt(guide)}

${pacingNote(elapsedMinutes, guide.targetDurationMinutes)}

${lastCategory ? `The last generic probe used was category "${lastCategory}" -- prefer a different one now unless it's clearly still the best fit.\n\n` : ""}Transcript so far (interviewer is "assistant", respondent is "user"):
${transcript}`;
}

const DIRECTIVES: Record<string, string> = {
  specific_probe:
    "PROBE: there's something specific in their last answer still worth digging into before moving on -- reference it directly, don't ask something generic.",
  move_on: "MOVE ON: the current guide question already has a real, substantive answer -- proceed to the next one.",
  wrap_up:
    "WRAP UP: the guide is substantially covered and/or time is up -- deliver the closing line and then use the end_call tool.",
};
const FALLBACK_DIRECTIVE = DIRECTIVES.specific_probe;

type JevDecision = {
  situation: string;
  situationConfidence: number;
  category: string | null;
  categoryConfidence: number;
  model: string;
};

async function classify(req: ArchitectureRequest, elapsedMinutes: number, lastCategory: string | null): Promise<JevDecision> {
  const state = buildState(req.guide, elapsedMinutes, req.messages, lastCategory);
  const result = await systemOne({
    state,
    questions: {
      situation: {
        type: "choice",
        instructions:
          "What should happen on the moderator's very next turn. Bias toward probing: a generic follow-up " +
          "is the default whenever it would plausibly work at all, since more probing (rather than moving " +
          "on early, or reaching for something narrowly specific) is what actually surfaces real insight in " +
          "a qualitative interview. Only move away from generic_probe when the criteria below clearly call for it.",
        criteria: {
          generic_probe:
            "DEFAULT CHOICE. The respondent's last answer leaves something worth deepening or clarifying, " +
            "and a generic, content-free follow-up (e.g. 'say more about that', 'what makes you say that') " +
            "would work naturally -- even if their answer contained a minor detail, as long as the follow-up " +
            "ITSELF doesn't need to name or reference that detail to make sense. Real qualitative answers " +
            "almost always contain some specific fact; that alone does not disqualify this option. When " +
            "genuinely torn between this and specific_probe, pick this one.",
          specific_probe:
            "Only when a generic line would CLEARLY be confusing or obviously disconnected from what was " +
            "just said -- not merely \"a more tailored question would be nicer.\" The follow-up must strictly " +
            "require naming or quoting back a specific detail, phrase, or fact they just gave for it to make " +
            "sense at all.",
          move_on: "The current guide question already has a real, substantive answer -- time to move to the next one.",
          wrap_up: "The guide is substantially covered and/or time is up -- time to deliver the closing and end the call.",
        },
      },
      category: {
        type: "choice",
        instructions:
          "Which single category of generic follow-up best fits what's needed right now. Only meaningful " +
          "when `situation` is generic_probe -- ignored otherwise, but always answer it.",
        criteria: PROBE_CATEGORIES,
      },
    },
  });

  const situationAnswer = result.answers.situation;
  const categoryAnswer = result.answers.category;
  return {
    situation: situationAnswer?.type === "choice" ? situationAnswer.choice : "specific_probe",
    situationConfidence: situationAnswer?.type === "choice" ? situationAnswer.confidence : 0,
    category: categoryAnswer?.type === "choice" ? categoryAnswer.choice : null,
    categoryConfidence: categoryAnswer?.type === "choice" ? categoryAnswer.confidence : 0,
    model: result.model,
  };
}

// Exported so a one-off diagnostic (comparing a canned bank line against
// what the LLM would have said if forced to probe on the exact same
// transcript prefix) can reuse the real moderator call path rather than a
// hand-maintained copy of it -- see app/api/admin/probe-comparison.
export async function callModerator(req: ArchitectureRequest, directive: string, elapsedMinutes: number): Promise<ArchitectureResult> {
  // Same privacy-instruction fix system1.ts needed -- a real test call
  // there showed the directive leaking straight into spoken output
  // ("...per my instructions").
  const system =
    `NEXT, you must: ${directive} This line is private guidance for you alone -- ` +
    `never mention it, never say "per my instructions" or "the guide says" or ` +
    `anything like it, never explain your reasoning out loud. Just ask naturally, ` +
    `as if the thought were your own.\n\n` +
    `${req.system}\n\n${moderatorSystemPrompt(req.guide)}\n\n${pacingNote(elapsedMinutes, req.guide.targetDurationMinutes)}`;

  const { responseText, responseToolCalls, stopReason } = await callModeratorLLM("cannedprobe", req.fingerprint, {
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    system,
    messages: req.messages,
    tools: req.tools.length ? req.tools : undefined,
  });

  return {
    responseText,
    responseToolCalls,
    stopReason,
    nextState: req.state, // bank state untouched -- no bank line was used this turn
  };
}

export const cannedProbeArchitecture: Architecture = {
  name: "cannedprobe",
  kind: "custom",
  async run(req): Promise<ArchitectureResult> {
    const startedAt = Date.now();
    const elapsedMinutes = (Date.now() - req.firstSeenAt.getTime()) / 60_000;
    const bankState: ProbeBankState = (req.state.probeBank as ProbeBankState | undefined) ?? INITIAL_PROBE_BANK_STATE;

    let decision: JevDecision;
    try {
      decision = await classify(req, elapsedMinutes, bankState.lastCategory);
    } catch (err) {
      // Synchronous, on the critical path -- same degrade-not-crash
      // discipline as system1.ts's jev call: fail toward the always-correct
      // (if more expensive) LLM path rather than taking the turn down.
      console.error("cannedprobe (jev) classification failed:", err);
      return callModerator(req, FALLBACK_DIRECTIVE, elapsedMinutes);
    }

    const canUseBank =
      decision.situation === "generic_probe" &&
      decision.situationConfidence >= SITUATION_CONFIDENCE_THRESHOLD &&
      decision.category !== null &&
      isProbeCategory(decision.category) &&
      decision.categoryConfidence >= CATEGORY_CONFIDENCE_THRESHOLD;

    if (canUseBank && decision.category && isProbeCategory(decision.category)) {
      const { line, nextState } = pickProbeLine(decision.category, bankState);
      await logTurn({
        architecture: "cannedprobe",
        callType: "probe_bank",
        conversationFingerprint: req.fingerprint,
        model: decision.model,
        requestSystem: "(canned -- no LLM call this turn)",
        requestMessages: req.messages,
        rawRequestBody: { decision, resolvedAs: "bank", line },
        responseText: line,
        stopReason: null,
        latencyMs: Date.now() - startedAt,
      });
      return {
        responseText: line,
        responseToolCalls: [],
        stopReason: "end_turn",
        nextState: { ...req.state, probeBank: nextState },
      };
    }

    const directive = DIRECTIVES[decision.situation] ?? FALLBACK_DIRECTIVE;
    await logTurn({
      architecture: "cannedprobe",
      callType: "probe_bank",
      conversationFingerprint: req.fingerprint,
      model: decision.model,
      requestSystem: "(fell through to moderator LLM)",
      requestMessages: req.messages,
      rawRequestBody: { decision, resolvedAs: "llm", directive },
      responseText: `${decision.situation} (confidence ${decision.situationConfidence}) -> ${directive}`,
      stopReason: null,
      latencyMs: Date.now() - startedAt,
    });
    return callModerator(req, directive, elapsedMinutes);
  },
};
