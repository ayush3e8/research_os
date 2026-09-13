/**
 * Follow-up to eval-reliability-experiment: that one showed a single call
 * asked for ONE holistic score (test A) drifted and sometimes failed to
 * parse at all. The real framework's Group 1 has 7 weighted dimensions
 * (listening, probing, neutrality, rapport, research judgment, coverage,
 * clarity) -- the naive way to score them is one call returning all 7 at
 * once, which risks the same failure mode as test A, plus correlated
 * scores (one call's overall impression can bleed into every dimension
 * together). This route heads that off before it's built into production:
 * per iteration, the SAME transcript/guide context is scored two ways --
 * as 7 independent calls (one dimension each) vs. as 1 call returning all
 * 7 -- so the only variable that differs is whether the judgment is split
 * or bundled. Both structures get reduced to the same weighted-average
 * formula in code (never by the model), and every call is written to
 * eval_reliability_runs as it completes so a request timeout can't lose
 * finished work.
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

// --- Same real transcript and research context as the first experiment ---
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

const STUDY_TOPIC = "How people decide what to eat day-to-day — grocery shopping, meal planning, and cooking habits.";
const RESEARCH_OBJECTIVE =
  "You're being interviewed on behalf of Homeplate, a meal-kit and grocery-delivery subscription company, " +
  "deciding whether to build a lower-cost AI-assisted 'Quick Plan' tier for people who don't currently use " +
  "any meal-kit/grocery-delivery service. Key questions: is the current process habit or genuine choice; " +
  "is the real barrier cost, time, or decision fatigue; how much appetite exists for something new; would " +
  "this person actually try the Quick Plan concept.";

type Dimension = { key: string; label: string; weight: number; definition: string };

const DIMENSIONS: Dimension[] = [
  {
    key: "listening",
    label: "Listening & responsiveness",
    weight: 0.2,
    definition:
      "Does the moderator show it's actually tracking what the respondent said -- building follow-ups on " +
      "specific things the respondent mentioned, rather than reciting the next guide question regardless of " +
      "the answer just given?",
  },
  {
    key: "probing",
    label: "Probing quality",
    weight: 0.25,
    definition:
      "When the respondent gives a vague, surface-level, or one-word answer, how well does the moderator dig " +
      "past it? A generic probe repeats the question or moves on; an excellent probe catches a specific word " +
      "or implication (e.g. noticing 'anymore' implies something changed) and asks about that.",
  },
  {
    key: "neutrality",
    label: "Neutrality / non-leading",
    weight: 0.15,
    definition:
      "Are the moderator's questions free of leading phrasing or built-in assumptions that suggest the " +
      "'right' answer, rather than genuinely open-ended?",
  },
  {
    key: "rapport",
    label: "Conversational naturalness & rapport",
    weight: 0.1,
    definition:
      "Does this read as a natural, warm conversation rather than a scripted interrogation -- acknowledging " +
      "answers, varying tone and pacing, sounding human?",
  },
  {
    key: "judgment",
    label: "Research judgment",
    weight: 0.15,
    definition:
      "Given the private research objective below, does the moderator make good real-time calls about what's " +
      "worth pursuing deeper vs. what's fine to move past?",
  },
  {
    key: "coverage",
    label: "Coverage & time management",
    weight: 0.1,
    definition:
      "Did the moderator cover the topics that actually matter for the research objective, without leaving " +
      "obvious gaps or spending too long on low-value tangents?",
  },
  {
    key: "clarity",
    label: "Clarity of questioning",
    weight: 0.05,
    definition:
      "Are the moderator's questions clear and single-part, rather than compound/stacked questions that ask " +
      "two things at once and confuse the respondent?",
  },
];

function dimensionTool(dim: Dimension): Anthropic.Tool {
  return {
    name: `score_${dim.key}`,
    description: `Score the moderator's "${dim.label}" across this interview, 1-5.`,
    input_schema: {
      type: "object",
      required: ["score", "quote", "reasoning"],
      properties: {
        score: { type: "integer", minimum: 1, maximum: 5 },
        quote: { type: "string", description: "The single best or worst example supporting this score." },
        reasoning: { type: "string", description: "One to two sentences justifying the score." },
      },
      additionalProperties: false,
    },
  };
}

function dimensionSystem(dim: Dimension): string {
  return (
    `You are an expert qualitative-research evaluator.\n\nStudy: ${STUDY_TOPIC}\n\n` +
    `Research objective (private -- the moderator never said this to the respondent): ${RESEARCH_OBJECTIVE}\n\n` +
    `Score ONLY this one dimension: "${dim.label}".\nWhat this dimension means: ${dim.definition}\n\n` +
    `Ground your score in a specific quote from the transcript -- never score without one.`
  );
}

const USER_MESSAGE = `Full transcript:\n${FULL_TRANSCRIPT_TEXT}`;

const ONE_CALL_TOOL: Anthropic.Tool = {
  name: "score_all_dimensions",
  description: "Score the moderator across all 7 rubric dimensions for this interview.",
  input_schema: {
    type: "object",
    required: DIMENSIONS.map((d) => d.key),
    properties: Object.fromEntries(
      DIMENSIONS.map((d) => [
        d.key,
        {
          type: "object",
          required: ["score", "quote", "reasoning"],
          properties: {
            score: { type: "integer", minimum: 1, maximum: 5 },
            quote: { type: "string", description: "The single best or worst example supporting this score." },
            reasoning: { type: "string", description: "One to two sentences justifying the score." },
          },
          additionalProperties: false,
        },
      ])
    ),
    additionalProperties: false,
  },
};

const ONE_CALL_SYSTEM =
  `You are an expert qualitative-research evaluator.\n\nStudy: ${STUDY_TOPIC}\n\n` +
  `Research objective (private -- the moderator never said this to the respondent): ${RESEARCH_OBJECTIVE}\n\n` +
  `Score the moderator on all 7 dimensions below, 1-5 each, grounding every score in a specific quote:\n` +
  DIMENSIONS.map((d) => `- ${d.label}: ${d.definition}`).join("\n");

type DimResult = { score: number; quote: string; reasoning: string } | null;

async function callDimension(dim: Dimension): Promise<DimResult> {
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 400,
    system: dimensionSystem(dim),
    messages: [{ role: "user", content: USER_MESSAGE }],
    tools: [dimensionTool(dim)],
    tool_choice: { type: "tool", name: dimensionTool(dim).name },
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return (block?.input as DimResult) ?? null;
}

async function callBundled(): Promise<Record<string, DimResult> | null> {
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: ONE_CALL_SYSTEM,
    messages: [{ role: "user", content: USER_MESSAGE }],
    tools: [ONE_CALL_TOOL],
    tool_choice: { type: "tool", name: ONE_CALL_TOOL.name },
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return (block?.input as Record<string, DimResult>) ?? null;
}

function weighted(scores: Record<string, number | undefined>): number | null {
  let sum = 0;
  let weightSeen = 0;
  for (const dim of DIMENSIONS) {
    const s = scores[dim.key];
    if (typeof s !== "number") return null;
    sum += s * dim.weight;
    weightSeen += dim.weight;
  }
  return weightSeen > 0.999 ? sum : null;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });

  const summary: Record<string, unknown> = { seven_calls: [], one_call_7dim: [] };

  try {
    for (let i = 0; i < N_RUNS; i++) {
      const [dimResults, bundled] = await Promise.all([
        Promise.all(
          DIMENSIONS.map(async (dim) => {
            const result = await callDimension(dim);
            await db.insert(evalReliabilityRuns).values({
              testName: `dim_${dim.key}`,
              runIndex: i,
              result: result ?? {},
            });
            return [dim.key, result] as const;
          })
        ),
        callBundled(),
      ]);

      const dimScores = Object.fromEntries(dimResults.map(([k, r]) => [k, r?.score]));
      const sevenCallsWeighted = weighted(dimScores);
      await db.insert(evalReliabilityRuns).values({
        testName: "seven_calls_weighted",
        runIndex: i,
        result: { weightedScore: sevenCallsWeighted, perDimension: Object.fromEntries(dimResults) },
      });
      (summary.seven_calls as unknown[]).push({ runIndex: i, weightedScore: sevenCallsWeighted });

      const bundledScores = bundled
        ? Object.fromEntries(DIMENSIONS.map((d) => [d.key, bundled[d.key]?.score]))
        : {};
      const oneCallWeighted = bundled ? weighted(bundledScores) : null;
      const missing = bundled ? DIMENSIONS.filter((d) => typeof bundled[d.key]?.score !== "number").map((d) => d.key) : DIMENSIONS.map((d) => d.key);
      await db.insert(evalReliabilityRuns).values({
        testName: "one_call_7dim",
        runIndex: i,
        result: { weightedScore: oneCallWeighted, perDimension: bundled ?? {}, missing },
      });
      (summary.one_call_7dim as unknown[]).push({ runIndex: i, weightedScore: oneCallWeighted, missing });
    }
  } catch (err) {
    console.error("eval-reliability-experiment-2 failed:", err);
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        partialSummary: summary,
      },
      { status: 500 }
    );
  }

  return Response.json(summary);
}
