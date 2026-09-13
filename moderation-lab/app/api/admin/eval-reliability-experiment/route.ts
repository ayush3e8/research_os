/**
 * One-off measurement route, not production eval code -- see
 * scripts/eval-reliability-experiment.js for the original standalone
 * version (same logic; this one runs where ANTHROPIC_API_KEY already
 * lives, on Vercel, rather than needing the key copied anywhere else).
 *
 * Runs the same judge task (classify a real probe exchange from an actual
 * test transcript) at four different context scopes N times each at
 * temperature 0, to measure real run-to-run drift and whether trimming
 * context to the minimum needed reduces it. Results are written to
 * eval_reliability_runs as they complete (so a request timeout doesn't
 * lose partial results) and also returned in the response if it finishes
 * in time.
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

const N_RUNS = 12;
const CONCURRENCY = 6;

// --- The real transcript, same exchange reconstructed earlier from
// turn_logs for the actual food/meal-planning test call. ---
const FULL_TRANSCRIPT_TEXT = `MODERATOR: Hi, thanks for chatting with me today. I'm doing some research on behalf of a company exploring new tools for weekly meal planning and grocery shopping, and I want to understand how you actually handle that today — no wrong answers, I'm just curious how it really works for you. Ready to dive in?
RESPONDENT: Sure.
MODERATOR: [warm] Great, let's start easy. Tell me about your week so far from a food standpoint — mostly cooking, ordering in, or a bit of both?
RESPONDENT: Uh, I would say it's been a good mix of both. Uh, but maybe more so, uh, leaning on the cooking side.
MODERATOR: Nice, [curious] good balance there. What did you actually eat yesterday, walk me through it?
RESPONDENT: Yesterday? Uh, I'm trying to remember what I ate yesterday. Yes, I had, uh, moong dal chilla for lunch, and, uh, I had, uh, uh, for dinner, I had roti and sabzi.
MODERATOR: That sounds great, [warm] and homemade too by the sound of it. Is that a pretty typical day for you, or did something make yesterday different?
RESPONDENT: Um, it's a typical day right now because my parents are here, but, uh, usually it's not, it's not, uh, you know, this much homemade food.
MODERATOR: Oh interesting, [curious] so your parents being there is actually shifting things. What does a more typical week look like when it's just you?
RESPONDENT: Um, I would say when it's just me, it's like pretty haphazard. Um, you know, the lunch is usually just either skimp or just like all over the place.
MODERATOR: Got it. [curious] For that dinner planning, where does the effort actually go — are you deciding day-of, or do you set anything up ahead of time?
RESPONDENT: Um, we don't... I think we should do it more often, but we don't quite do it as often, uh, the grocery list. But, um, you know, it's mostly just what's around.
MODERATOR: That's really helpful, [thoughtful] sounds like it's more habit and restocking than active weekly planning. So if you had to pick just one — is the bigger friction point for you the cost, the time it takes, or just not knowing what you want?
RESPONDENT: I would say it's probably the time it takes.
MODERATOR: [curious] Tell me about a specific time that was actually annoying because of the time it took — what happened?
RESPONDENT: I think usually what's annoying in the process is we, uh, get to dinner time and we don't have a plan. That's what's usually annoying.
MODERATOR: That makes sense, [warm] so it's really that lack-of-a-plan moment that hits hardest, even more than the actual cooking time. What would fix that for you?
RESPONDENT: I think, uh, we are not very proactive when it comes to planning meals and stuff. And, uh, you know, we would absolutely appreciate eating healthy.
MODERATOR: That's a great way to put it. [curious] So on a scale of one to ten, how satisfied are you with how you currently handle food and groceries?
RESPONDENT: I would say seven, two or three.
MODERATOR: [curious] Why seven, and not, say, two points higher at nine?
RESPONDENT: Oh, I said it's a two or three. I didn't say it's a seven.
MODERATOR: Oh, got it, thanks for clarifying — so a two or three. [curious] What's making it that low, what's going wrong most?
RESPONDENT: As I said, there's, like, no plan. There's no proactive planning, so it's, uh, usually haphazard.
MODERATOR: That's really clear, thank you. [curious] Now tell me about a specific time your food plan for the week completely fell apart, or a meal that really surprised you.
RESPONDENT: Um, a food plan that completely fell apart, or a meal that... I mean, that's pretty much what happens, right? It's a weekly occurrence.
MODERATOR: That's fair, [warm] that actually makes sense given what you've told me. Let me pitch you something quickly. Imagine a service that every week automatically builds you a meal plan and grocery list...
RESPONDENT: Yeah. I think I'll try that. I'm assuming it's gonna tailor it based on my preferences and tastes.
MODERATOR: That's a fair distinction to draw. [curious] Given time was the friction you picked earlier, does having the plan and list handled actually solve it for you?
RESPONDENT: I think cooking still remains a bottleneck, is what I would say. Having a plan is good, but it won't solve everything.
MODERATOR: That's a really honest and useful distinction, thank you. [warm] This was genuinely useful, thank you for walking me through all of that.`;

const LOCAL_EXCHANGE = {
  respondent: "I would say it's probably the time it takes.",
  moderator:
    "[curious] Tell me about a specific time that was actually annoying because of the time it took — what happened?",
};

const SINGLE_UTTERANCE =
  "That's really helpful, [thoughtful] sounds like it's more habit and restocking than active weekly planning. " +
  "So if you had to pick just one — is the bigger friction point for you the cost, the time it takes, or just not knowing what you want?";

const STUDY_TOPIC = "How people decide what to eat day-to-day — grocery shopping, meal planning, and cooking habits.";
const RESEARCH_OBJECTIVE =
  "You're being interviewed on behalf of Homeplate, a meal-kit and grocery-delivery subscription company, " +
  "deciding whether to build a lower-cost AI-assisted 'Quick Plan' tier for people who don't currently use " +
  "any meal-kit/grocery-delivery service. Key questions: is the current process habit or genuine choice; " +
  "is the real barrier cost, time, or decision fatigue; how much appetite exists for something new; would " +
  "this person actually try the Quick Plan concept.";
const FRICTION_QUESTION = {
  ask: "If you had to pick just one — is the bigger friction point for you the cost, the time it takes, or just not knowing what you want? Pick one.",
  note:
    "The single most important question in the guide -- the answer decides whether a cheaper option alone " +
    "would help, or whether decision fatigue is the real problem. A vague answer isn't a real answer, worth pushing past.",
};

const CALIBRATION_EXAMPLES = `
Calibration examples for probe quality:
Respondent: "Honestly, we don't use the segmentation very much anymore."
- generic: "Okay. And what other market research do you conduct?" (ignores it entirely)
- acceptable: "Why don't you use it very much?"
- strong: "That's interesting — what changed? Was it the segmentation itself, or did the team's needs change?"
- excellent: "You said 'anymore' — was there a point when it was actually being used?" (catches the implied change over time)
`;

const PROBE_QUALITY_TOOL: Anthropic.Tool = {
  name: "classify_probe",
  description: "Classify how well the moderator's follow-up explored the respondent's answer.",
  input_schema: {
    type: "object",
    required: ["quality", "quote", "reasoning"],
    properties: {
      quality: { type: "string", enum: ["generic", "acceptable", "strong", "excellent"] },
      quote: { type: "string", description: "The exact moderator text being classified." },
      reasoning: { type: "string", description: "One sentence justifying the classification." },
    },
    additionalProperties: false,
  },
};

const LEADING_TOOL: Anthropic.Tool = {
  name: "classify_leading",
  description: "Classify whether this single utterance contains a leading question or assumption.",
  input_schema: {
    type: "object",
    required: ["isLeading", "reasoning"],
    properties: {
      isLeading: { type: "boolean" },
      reasoning: { type: "string", description: "One sentence justifying the classification." },
    },
    additionalProperties: false,
  },
};

const HOLISTIC_TOOL: Anthropic.Tool = {
  name: "score_probing",
  description: "Score the overall probing quality across the whole interview.",
  input_schema: {
    type: "object",
    required: ["score", "quote", "reasoning"],
    properties: {
      score: { type: "integer", minimum: 1, maximum: 5 },
      quote: { type: "string", description: "The single best or worst example supporting this score." },
      reasoning: { type: "string", description: "Two to three sentences justifying the score." },
    },
    additionalProperties: false,
  },
};

type Test = { name: string; description: string; system: string; user: string; tool: Anthropic.Tool };

const TESTS: Test[] = [
  {
    name: "A_full_holistic",
    description: "Full transcript + full guide context, ONE holistic 1-5 probing-quality score for the whole interview.",
    system: `You are an expert qualitative-research evaluator.\n\nStudy: ${STUDY_TOPIC}\n\nResearch objective: ${RESEARCH_OBJECTIVE}\n${CALIBRATION_EXAMPLES}\nScore the moderator's overall probing quality across this entire interview, 1-5.`,
    user: `Full transcript:\n${FULL_TRANSCRIPT_TEXT}`,
    tool: HOLISTIC_TOOL,
  },
  {
    name: "B_full_narrow_task",
    description: "Full transcript + full guide context, but asked ONLY to classify ONE specific real exchange.",
    system: `You are an expert qualitative-research evaluator.\n\nStudy: ${STUDY_TOPIC}\n\nResearch objective: ${RESEARCH_OBJECTIVE}\n${CALIBRATION_EXAMPLES}\nClassify only the moderator's handling of this specific exchange (the "time it takes" friction point, quoted below), even though you have the full transcript for context:\nRespondent: "${LOCAL_EXCHANGE.respondent}"\nModerator: "${LOCAL_EXCHANGE.moderator}"`,
    user: `Full transcript (for context only):\n${FULL_TRANSCRIPT_TEXT}`,
    tool: PROBE_QUALITY_TOOL,
  },
  {
    name: "C_local_pair_only",
    description: "ONLY the 2-turn exchange + the relevant guide question -- same exact task as B, minimal context.",
    system: `You are an expert qualitative-research evaluator.\n${CALIBRATION_EXAMPLES}\nThe guide question being explored: "${FRICTION_QUESTION.ask}" (${FRICTION_QUESTION.note})\n\nClassify the moderator's follow-up.`,
    user: `Respondent: "${LOCAL_EXCHANGE.respondent}"\nModerator: "${LOCAL_EXCHANGE.moderator}"`,
    tool: PROBE_QUALITY_TOOL,
  },
  {
    name: "D_single_utterance_zero_context",
    description: "Only one moderator utterance, no guide, no transcript, nothing else.",
    system: `You are an expert qualitative-research evaluator. Judge only the single utterance given -- no other context is available or needed.`,
    user: `Moderator utterance: "${SINGLE_UTTERANCE}"`,
    tool: LEADING_TOOL,
  },
];

async function runOnce(test: Test): Promise<Record<string, unknown> | null> {
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 500,
    temperature: 0,
    system: test.system,
    messages: [{ role: "user", content: test.user }],
    tools: [test.tool],
    tool_choice: { type: "tool", name: test.tool.name },
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return (block?.input as Record<string, unknown>) ?? null;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function summarizeNumeric(values: number[]) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean: Number(mean.toFixed(2)), stdev: Number(Math.sqrt(variance).toFixed(2)), min: Math.min(...values), max: Math.max(...values), values };
}

function summarizeCategorical(values: (string | boolean)[]) {
  const counts: Record<string, number> = {};
  for (const v of values) counts[String(v)] = (counts[String(v)] ?? 0) + 1;
  const [modeKey, modeCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { counts, mode: modeKey, agreementPct: Number(((modeCount / values.length) * 100).toFixed(0)), values };
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });

  const summary: Record<string, unknown> = {};

  for (const test of TESTS) {
    const runIndices = Array.from({ length: N_RUNS }, (_, i) => i);
    const results = await mapWithConcurrency(runIndices, CONCURRENCY, async (runIndex) => {
      const result = await runOnce(test);
      await db.insert(evalReliabilityRuns).values({ testName: test.name, runIndex, result: result ?? {} });
      return result;
    });

    if (test.tool.name === "score_probing") {
      const scores = results.map((r) => r!.score as number);
      summary[test.name] = { description: test.description, summary: summarizeNumeric(scores) };
    } else if (test.tool.name === "classify_probe") {
      const qualities = results.map((r) => r!.quality as string);
      summary[test.name] = { description: test.description, summary: summarizeCategorical(qualities) };
    } else if (test.tool.name === "classify_leading") {
      const leadings = results.map((r) => r!.isLeading as boolean);
      summary[test.name] = { description: test.description, summary: summarizeCategorical(leadings) };
    }
    (summary[test.name] as Record<string, unknown>).sampleReasonings = results.slice(0, 3).map((r) => r!.reasoning);
  }

  return Response.json(summary);
}
