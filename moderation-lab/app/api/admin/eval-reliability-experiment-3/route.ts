/**
 * Follow-up to experiment 2: that one showed bundling 7 DIFFERENT dimension
 * scores into one call created a weakest-link problem (any one dimension
 * failing killed the whole combined score). The plan going forward pushes
 * every dimension toward the LLM detecting concrete, checkable yes/no
 * features (e.g. for clarity: is this a compound question, an ambiguous
 * referent, excessively long) rather than rating anything -- with the
 * actual score computed deterministically in code from those flags.
 *
 * Open question before locking in that schema: is bundling a *few booleans
 * for one dimension* as risky as bundling 7 different holistic scores was?
 * Booleans are a much smaller ask than nested {score, quote, reasoning}
 * objects, so the hypothesis is no -- but that's a guess, not a finding
 * yet. This experiment tests it directly on the clarity dimension: the
 * same 3 clarity flags (compound question / ambiguous referent /
 * excessively long), on the same 4 real-shaped moderator utterances
 * (one clean, one for each flag), scored two ways -- 1 call returning all
 * 3 flags vs. 3 separate single-flag calls -- so the only variable is
 * bundled vs. split, same as experiment 2's structure.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL } from "@/lib/anthropic";
import { db } from "@/db";
import { evalReliabilityRuns } from "@/db/schema";

export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const expected = process.env.CUSTOM_LLM_WEBHOOK_SECRET;
  if (!expected) return false;
  return req.headers.get("authorization") === `Bearer ${expected}`;
}

const N_RUNS = 8;

type Flag = { key: string; label: string; definition: string };

const FLAGS: Flag[] = [
  {
    key: "isCompoundQuestion",
    label: "Compound question",
    definition:
      "The moderator's utterance asks two or more distinct questions at once, requiring the respondent to " +
      "answer multiple separate things in one turn.",
  },
  {
    key: "hasAmbiguousReferent",
    label: "Ambiguous referent",
    definition:
      "The utterance uses a pronoun or reference (e.g. 'that', 'it', 'this') whose antecedent is not clearly " +
      "identifiable from the context given.",
  },
  {
    key: "isExcessivelyLong",
    label: "Excessively long / buried question",
    definition:
      "The utterance contains so much preamble or tangential content that the actual question is hard to " +
      "identify or comes very late.",
  },
];

type TestUtterance = {
  key: string;
  priorRespondent: string;
  moderatorUtterance: string;
  expected: Record<string, boolean>;
};

const UTTERANCES: TestUtterance[] = [
  {
    key: "clean",
    priorRespondent:
      "Yesterday? Uh, I'm trying to remember what I ate yesterday. Yes, I had, uh, moong dal chilla for lunch, " +
      "and, uh, I had, uh, uh, for dinner, I had roti and sabzi.",
    moderatorUtterance:
      "That sounds great, and homemade too by the sound of it. Is that a pretty typical day for you, or did " +
      "something make yesterday different?",
    expected: { isCompoundQuestion: false, hasAmbiguousReferent: false, isExcessivelyLong: false },
  },
  {
    key: "compound",
    priorRespondent: "I would say it's probably the time it takes.",
    moderatorUtterance:
      "Got it — and when you say time, do you mean the actual cooking time, or the planning and " +
      "decision-making beforehand, and also, do you think a shopping list would help with that?",
    expected: { isCompoundQuestion: true, hasAmbiguousReferent: false, isExcessivelyLong: false },
  },
  {
    key: "ambiguous",
    priorRespondent:
      "I think cooking still remains a bottleneck, is what I would say. Having a plan is good, but it won't " +
      "solve everything.",
    moderatorUtterance: "How did that change things for you, compared to before?",
    expected: { isCompoundQuestion: false, hasAmbiguousReferent: true, isExcessivelyLong: false },
  },
  {
    key: "long",
    priorRespondent:
      "Um, we don't... I think we should do it more often, but we don't quite do it as often, uh, the grocery " +
      "list. But, um, you know, it's mostly just what's around.",
    moderatorUtterance:
      "Yeah, no, that totally makes sense, I think a lot of people feel that way, especially when things get " +
      "busy during the week and there's just not enough time to sit down and actually plan things out properly " +
      "in advance, so I guess what I'm curious about, going back to something you mentioned a minute ago about " +
      "parents visiting and things being different then versus a normal week, is whether you'd say the version " +
      "of you that's cooking for guests is meaningfully more organized than the version of you that's just " +
      "cooking for yourself day to day?",
    expected: { isCompoundQuestion: false, hasAmbiguousReferent: false, isExcessivelyLong: true },
  },
];

function userMessage(u: TestUtterance): string {
  return `Respondent said: "${u.priorRespondent}"\nModerator then asked: "${u.moderatorUtterance}"`;
}

const BUNDLED_TOOL: Anthropic.Tool = {
  name: "flag_clarity_issues",
  description: "Flag whether each clarity issue is present in this moderator utterance.",
  input_schema: {
    type: "object",
    required: [...FLAGS.map((f) => f.key), "reasoning"],
    properties: {
      ...Object.fromEntries(FLAGS.map((f) => [f.key, { type: "boolean" }])),
      reasoning: { type: "string", description: "One to two sentences justifying all three flags." },
    },
    additionalProperties: false,
  },
};

const BUNDLED_SYSTEM =
  "You are auditing a single moderator question from a qualitative research interview for clarity issues.\n\n" +
  "Given the moderator's utterance below (with the respondent's prior answer for context), determine whether " +
  "EACH of the following issues is present:\n" +
  FLAGS.map((f) => `- ${f.key}: ${f.definition}`).join("\n") +
  "\n\nAnswer all three, each strictly true or false, grounded in the specific utterance.";

function separateTool(flag: Flag): Anthropic.Tool {
  return {
    name: `flag_${flag.key}`,
    description: `Flag whether "${flag.label}" is present in this moderator utterance.`,
    input_schema: {
      type: "object",
      required: [flag.key, "reasoning"],
      properties: {
        [flag.key]: { type: "boolean" },
        reasoning: { type: "string", description: "One sentence justifying the flag." },
      },
      additionalProperties: false,
    },
  };
}

function separateSystem(flag: Flag): string {
  return (
    "You are auditing a single moderator question from a qualitative research interview for one specific " +
    "clarity issue.\n\nGiven the moderator's utterance below (with the respondent's prior answer for context), " +
    `determine whether this issue is present: ${flag.definition}\n\nAnswer strictly true or false.`
  );
}

async function callBundled(u: TestUtterance): Promise<Record<string, unknown> | null> {
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 300,
    system: BUNDLED_SYSTEM,
    messages: [{ role: "user", content: userMessage(u) }],
    tools: [BUNDLED_TOOL],
    tool_choice: { type: "tool", name: BUNDLED_TOOL.name },
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return (block?.input as Record<string, unknown>) ?? null;
}

async function callSeparate(u: TestUtterance, flag: Flag): Promise<Record<string, unknown> | null> {
  const tool = separateTool(flag);
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 200,
    system: separateSystem(flag),
    messages: [{ role: "user", content: userMessage(u) }],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return (block?.input as Record<string, unknown>) ?? null;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });

  const summary: Record<string, unknown> = {};

  // A single invocation can time out partway through the utterance list (the
  // function's ~55s budget doesn't cover all 4 utterances x N_RUNS). Without
  // this, every retry restarts from utterance 0 and the last utterance never
  // gets reached. ?start=<index> rotates the list so a retry can target
  // whichever utterances are still short on samples.
  const startIdx = Number(new URL(req.url).searchParams.get("start") ?? "0") % UTTERANCES.length;
  const orderedUtterances = [...UTTERANCES.slice(startIdx), ...UTTERANCES.slice(0, startIdx)];

  try {
    for (const u of orderedUtterances) {
      for (let i = 0; i < N_RUNS; i++) {
        const [bundled, ...separateResults] = await Promise.all([
          callBundled(u),
          ...FLAGS.map((f) => callSeparate(u, f)),
        ]);

        await db.insert(evalReliabilityRuns).values({
          testName: `clarity_bundled_${u.key}`,
          runIndex: i,
          result: bundled ?? {},
        });

        const separateCombined: Record<string, unknown> = {};
        await Promise.all(
          FLAGS.map((f, idx) => {
            const r = separateResults[idx];
            separateCombined[f.key] = r?.[f.key] ?? null;
            return db.insert(evalReliabilityRuns).values({
              testName: `clarity_separate_${f.key}_${u.key}`,
              runIndex: i,
              result: r ?? {},
            });
          })
        );
        await db.insert(evalReliabilityRuns).values({
          testName: `clarity_separate_combined_${u.key}`,
          runIndex: i,
          result: separateCombined,
        });
      }
    }
  } catch (err) {
    console.error("eval-reliability-experiment-3 failed:", err);
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        partialSummary: summary,
      },
      { status: 500 }
    );
  }

  return Response.json({ ok: true, utterances: UTTERANCES.map((u) => u.key), nRuns: N_RUNS });
}
