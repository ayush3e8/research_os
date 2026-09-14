/**
 * Every per-turn LLM check used by the evaluation framework. Design rules
 * these all follow, straight from three reliability experiments (see the
 * eval-reliability-experiment* routes and the reliability artifact):
 *
 * 1. Detect concrete, checkable yes/no (or small categorical) features --
 *    never ask the model to rate anything. Scoring is computed afterward,
 *    deterministically, in aggregate.ts.
 * 2. Give each check only the context it actually needs. Local-exchange
 *    checks (neutrality, clarity) proved just as reliable as full-transcript
 *    versions of the same task, and avoid the full-context version's
 *    hindsight bias.
 * 3. Bundling a *few* booleans for one dimension in one call is safe
 *    (validated); bundling many unrelated dimensions is not (also
 *    validated -- that's why each function below is its own call, not one
 *    call doing all six).
 * 4. A failed/malformed call returns null, never throws -- callers drop
 *    that single turn from the affected dimension's sample rather than
 *    failing the whole evaluation.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL } from "@/lib/anthropic";

async function callTool<T>(system: string, user: string, tool: Anthropic.Tool): Promise<T | null> {
  try {
    const response = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: user }],
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    });
    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    return (block?.input as T) ?? null;
  } catch (err) {
    console.error(`evaluation check "${tool.name}" failed:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Neutrality -- moderator utterance + the immediately preceding respondent
// turn. That prior turn matters: "what else is a problem besides time?"
// looks like it presupposes something in isolation, but is a well-grounded
// follow-up once you know the respondent just named time as a problem.
// ---------------------------------------------------------------------------

export type NeutralityResult = {
  presupposesAnAnswer: boolean;
  offersLeadingForcedChoice: boolean;
  containsLoadedFraming: boolean;
  reasoning: string;
};

const NEUTRALITY_TOOL: Anthropic.Tool = {
  name: "flag_neutrality_issues",
  description: "Flag whether this moderator question shows signs of leading the respondent.",
  input_schema: {
    type: "object",
    required: ["presupposesAnAnswer", "offersLeadingForcedChoice", "containsLoadedFraming", "reasoning"],
    properties: {
      presupposesAnAnswer: {
        type: "boolean",
        description: "Assumes something is true that the respondent hasn't actually said, ungrounded in prior context.",
      },
      offersLeadingForcedChoice: {
        type: "boolean",
        description: "Offers a forced choice among options that steers toward one, rather than a neutral menu.",
      },
      containsLoadedFraming: { type: "boolean", description: "Uses language that signals the 'right' answer." },
      reasoning: { type: "string", description: "One to two sentences justifying the flags." },
    },
    additionalProperties: false,
  },
};

export async function checkNeutrality(
  priorRespondentTurn: string | null,
  moderatorText: string
): Promise<NeutralityResult | null> {
  const system =
    "You are auditing a single moderator question from a qualitative research interview for neutrality. " +
    "A question grounded in what the respondent just said (e.g. asking about 'other' problems after they " +
    "named one) is NOT presuming anything -- only flag genuine leading/loaded framing.";
  const user = priorRespondentTurn
    ? `Respondent just said: "${priorRespondentTurn}"\nModerator then asked: "${moderatorText}"`
    : `Moderator asked (no prior respondent turn in this exchange): "${moderatorText}"`;
  return callTool<NeutralityResult>(system, user, NEUTRALITY_TOOL);
}

// ---------------------------------------------------------------------------
// Clarity -- same minimal local context as neutrality.
// ---------------------------------------------------------------------------

export type ClarityResult = {
  isCompoundQuestion: boolean;
  hasAmbiguousReferent: boolean;
  isExcessivelyLong: boolean;
  reasoning: string;
};

const CLARITY_TOOL: Anthropic.Tool = {
  name: "flag_clarity_issues",
  description: "Flag whether each clarity issue is present in this moderator utterance.",
  input_schema: {
    type: "object",
    required: ["isCompoundQuestion", "hasAmbiguousReferent", "isExcessivelyLong", "reasoning"],
    properties: {
      isCompoundQuestion: { type: "boolean", description: "Asks two or more distinct things in one turn." },
      hasAmbiguousReferent: { type: "boolean", description: "Uses 'that'/'it'/'this' without a clear antecedent." },
      isExcessivelyLong: { type: "boolean", description: "So much preamble the actual question is buried or hard to find." },
      reasoning: { type: "string", description: "One to two sentences justifying the flags." },
    },
    additionalProperties: false,
  },
};

export async function checkClarity(
  priorRespondentTurn: string | null,
  moderatorText: string
): Promise<ClarityResult | null> {
  const system = "You are auditing a single moderator question from a qualitative research interview for clarity issues.";
  const user = priorRespondentTurn
    ? `Respondent said: "${priorRespondentTurn}"\nModerator then asked: "${moderatorText}"`
    : `Moderator asked: "${moderatorText}"`;
  return callTool<ClarityResult>(system, user, CLARITY_TOOL);
}

// ---------------------------------------------------------------------------
// Tone/warmth -- the one LLM-judged half of naturalness (the countable half
// -- turn-length variety, repeated openers -- is fully deterministic, see
// deterministic.ts).
// ---------------------------------------------------------------------------

export type ToneResult = { feelsWarmAndAttuned: boolean; reasoning: string };

const TONE_TOOL: Anthropic.Tool = {
  name: "flag_tone",
  description: "Flag whether this moderator turn feels warm and attuned to what the respondent just said.",
  input_schema: {
    type: "object",
    required: ["feelsWarmAndAttuned", "reasoning"],
    properties: {
      feelsWarmAndAttuned: {
        type: "boolean",
        description: "Acknowledges or reacts to the specific content of the respondent's answer, in a natural human register -- not a flat, generic transition.",
      },
      reasoning: { type: "string", description: "One sentence justifying the flag." },
    },
    additionalProperties: false,
  },
};

export async function checkTone(priorRespondentTurn: string | null, moderatorText: string): Promise<ToneResult | null> {
  const system = "You are auditing a single moderator turn from a voice interview for conversational warmth.";
  const user = priorRespondentTurn
    ? `Respondent said: "${priorRespondentTurn}"\nModerator then said: "${moderatorText}"`
    : `Moderator said: "${moderatorText}"`;
  return callTool<ToneResult>(system, user, TONE_TOOL);
}

// ---------------------------------------------------------------------------
// Depth-probing -- local exchange only (proved as reliable as full context,
// and avoids judging technique with hindsight the moderator didn't have).
// Three outcomes, not two: a probe-worthy moment can get a good follow-up, a
// bad one, or none at all -- "none" is tracked explicitly, it doesn't fall
// out of the formula by accident.
// ---------------------------------------------------------------------------

export type DepthProbeResult = {
  priorAnswerWasVague: boolean;
  moderatorFollowedUp: boolean;
  followUpTargetedSpecificDetail: boolean;
  reasoning: string;
};

const DEPTH_PROBE_TOOL: Anthropic.Tool = {
  name: "flag_depth_probe",
  description: "Flag whether this respondent answer needed a deeper follow-up, and whether the moderator's next turn provided one.",
  input_schema: {
    type: "object",
    required: ["priorAnswerWasVague", "moderatorFollowedUp", "followUpTargetedSpecificDetail", "reasoning"],
    properties: {
      priorAnswerWasVague: {
        type: "boolean",
        description: "The respondent's answer was vague, generic, or underspecified relative to the research need.",
      },
      moderatorFollowedUp: {
        type: "boolean",
        description: "The moderator's next turn engaged with THIS specific answer, rather than moving straight to an unrelated new question.",
      },
      followUpTargetedSpecificDetail: {
        type: "boolean",
        description: "Only meaningful if moderatorFollowedUp=true: the follow-up asked about a specific word/detail the respondent used, rather than just repeating the original question.",
      },
      reasoning: { type: "string", description: "One to two sentences justifying the flags." },
    },
    additionalProperties: false,
  },
};

export async function checkDepthProbe(
  respondentText: string,
  moderatorNextText: string
): Promise<DepthProbeResult | null> {
  const system =
    "You are auditing one respondent answer and the moderator's very next turn in a qualitative research " +
    "interview, to assess probing depth.";
  const user = `Respondent said: "${respondentText}"\nModerator's next turn: "${moderatorNextText}"`;
  return callTool<DepthProbeResult>(system, user, DEPTH_PROBE_TOOL);
}

// ---------------------------------------------------------------------------
// Thread-pull -- did the respondent volunteer something unprompted but
// relevant, and did the moderator notice and chase it. Needs the private
// research objective (to judge relevance) plus a short lookahead (not the
// whole transcript) to check follow-through.
// ---------------------------------------------------------------------------

export type ThreadPullResult = {
  mentionedUnpromptedTopic: boolean;
  plausiblyRelevantToObjective: boolean;
  moderatorFollowedUpOnThread: boolean;
  reasoning: string;
};

const THREAD_PULL_TOOL: Anthropic.Tool = {
  name: "flag_thread_pull",
  description: "Flag whether the respondent volunteered an unprompted, relevant thread, and whether the moderator pursued it.",
  input_schema: {
    type: "object",
    required: ["mentionedUnpromptedTopic", "plausiblyRelevantToObjective", "moderatorFollowedUpOnThread", "reasoning"],
    properties: {
      mentionedUnpromptedTopic: {
        type: "boolean",
        description: "The respondent mentioned something specific that wasn't what the question directly asked about.",
      },
      plausiblyRelevantToObjective: {
        type: "boolean",
        description: "Only meaningful if mentionedUnpromptedTopic=true: that mention is plausibly relevant to the private research objective given below.",
      },
      moderatorFollowedUpOnThread: {
        type: "boolean",
        description: "Only meaningful if the above two are true: the moderator's following turn(s) actually pursued that specific thread.",
      },
      reasoning: { type: "string", description: "One to two sentences justifying the flags." },
    },
    additionalProperties: false,
  },
};

export async function checkThreadPull(
  respondentText: string,
  followingModeratorTurns: string[],
  researchObjective: string
): Promise<ThreadPullResult | null> {
  const system =
    `You are auditing one respondent turn in a qualitative research interview for an unprompted but ` +
    `strategically relevant mention.\n\nPrivate research objective (the moderator never says this aloud): ${researchObjective}`;
  const user =
    `Respondent said: "${respondentText}"\n` +
    `Moderator's following turn(s): ${followingModeratorTurns.map((t, i) => `[${i + 1}] "${t}"`).join(" ")}`;
  return callTool<ThreadPullResult>(system, user, THREAD_PULL_TOOL);
}

// ---------------------------------------------------------------------------
// Redundant-question check -- the one check that genuinely needs running
// history, not just the local pair. Context is bounded to respondent-only
// answers so far (not the full back-and-forth) to keep this affordable as a
// call gets long. Not binary: prior coverage is none/partial/full, and when
// partial/full the question worth asking is whether the moderator
// acknowledged it rather than asking the guide's raw wording as if nothing
// had been said (the "how much time do you spend on X" vs. "you said you
// lead X -- is that your main focus?" distinction).
// ---------------------------------------------------------------------------

export type RedundantQuestionResult = {
  priorCoverage: "none" | "partial" | "full";
  acknowledgedPriorAnswer: boolean | null;
  reasoning: string;
};

const REDUNDANT_QUESTION_TOOL: Anthropic.Tool = {
  name: "flag_redundant_question",
  description: "Assess whether this guide question's answer was already substantively covered, and whether it was asked in a way that acknowledges that.",
  input_schema: {
    type: "object",
    required: ["priorCoverage", "acknowledgedPriorAnswer", "reasoning"],
    properties: {
      priorCoverage: {
        type: "string",
        enum: ["none", "partial", "full"],
        description: "How much of this question's answer was already substantively given earlier in the interview.",
      },
      acknowledgedPriorAnswer: {
        type: ["boolean", "null"],
        description: "Only meaningful if priorCoverage is partial or full: did the moderator's question acknowledge/build on what was already said, rather than asking the raw guide wording as if nothing had been said? Use null if priorCoverage is none.",
      },
      reasoning: { type: "string", description: "One to two sentences justifying the assessment, quoting the earlier answer if relevant." },
    },
    additionalProperties: false,
  },
};

export async function checkRedundantQuestion(
  priorRespondentAnswers: string,
  moderatorQuestionText: string
): Promise<RedundantQuestionResult | null> {
  const system =
    "You are auditing whether a moderator's guide question was already substantively answered earlier in " +
    "this interview, and whether the question as asked acknowledges that.";
  const user =
    `Everything the respondent has said so far:\n${priorRespondentAnswers}\n\n` +
    `The moderator is now about to ask: "${moderatorQuestionText}"`;
  return callTool<RedundantQuestionResult>(system, user, REDUNDANT_QUESTION_TOOL);
}
