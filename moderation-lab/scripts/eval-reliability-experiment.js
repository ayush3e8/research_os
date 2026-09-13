#!/usr/bin/env node
/**
 * Empirical reliability check for LLM-judge scoring, per the user's
 * explicit concern: does the same transcript get a different verdict
 * across repeated judge runs, and does trimming context down to the
 * minimum needed reduce that drift?
 *
 * Runs the SAME underlying task (classify one real probe exchange from
 * the actual food/meal-planning test transcript) at three different
 * context scopes, plus one fully-holistic baseline, N times each at
 * temperature 0, and reports agreement/variance per test. This is a
 * one-off measurement script, not production eval code -- results here
 * inform how the real judge architecture gets built next.
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";
const N_RUNS = 12;

// --- Real transcript, reconstructed from turn_logs earlier in this session ---
const transcript = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "scratch-transcript.json"), "utf8"));

function flattenText(content) {
  if (typeof content === "string") return content;
  return content.map((b) => b.text || "").join(" ");
}

const fullTranscriptText = transcript
  .map((m) => `${m.role === "assistant" ? "MODERATOR" : "RESPONDENT"}: ${flattenText(m.content)}`)
  .join("\n");

// The specific real exchange used for the context-scope comparison (test B/C):
// respondent picks "time" as the friction point, moderator asks for a specific example.
const LOCAL_EXCHANGE = {
  respondent: "I would say it's probably the time it takes.",
  moderator: "[curious] Tell me about a specific time that was actually annoying because of the time it took — what happened?",
};

// A real moderator utterance used for the near-zero-context test (test D) --
// it both reflects an interpretation back AND asks a forced-choice question
// in the same breath, a genuinely ambiguous real case for "is this leading."
const SINGLE_UTTERANCE =
  "That's really helpful, [thoughtful] sounds like it's more habit and restocking than active weekly planning. " +
  "So if you had to pick just one — is the bigger friction point for you the cost, the time it takes, or just not knowing what you want?";

const GUIDE_CONTEXT = {
  studyTopic: "How people decide what to eat day-to-day — grocery shopping, meal planning, and cooking habits.",
  researchObjective:
    "You're being interviewed on behalf of Homeplate, a meal-kit and grocery-delivery subscription company, " +
    "deciding whether to build a lower-cost AI-assisted 'Quick Plan' tier for people who don't currently use " +
    "any meal-kit/grocery-delivery service. Key questions: is the current process habit or genuine choice; " +
    "is the real barrier cost, time, or decision fatigue; how much appetite exists for something new; would " +
    "this person actually try the Quick Plan concept.",
  frictionQuestion: {
    topic: "core barrier (forced choice)",
    ask: "If you had to pick just one — is the bigger friction point for you the cost, the time it takes, or just not knowing what you want? Pick one.",
    note: "The single most important question in the guide -- the answer decides whether a cheaper option alone would help, or whether decision fatigue is the real problem. A vague answer isn't a real answer, worth pushing past.",
  },
};

const PROBE_QUALITY_TOOL = {
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

const LEADING_TOOL = {
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

const HOLISTIC_TOOL = {
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

const CALIBRATION_EXAMPLES = `
Calibration examples for probe quality:
Respondent: "Honestly, we don't use the segmentation very much anymore."
- generic: "Okay. And what other market research do you conduct?" (ignores it entirely)
- acceptable: "Why don't you use it very much?"
- strong: "That's interesting — what changed? Was it the segmentation itself, or did the team's needs change?"
- excellent: "You said 'anymore' — was there a point when it was actually being used?" (catches the implied change over time)
`;

const TESTS = [
  {
    name: "A_full_holistic",
    description: "Full transcript + full guide context, ONE holistic 1-5 probing-quality score for the whole interview.",
    system: `You are an expert qualitative-research evaluator.\n\nStudy: ${GUIDE_CONTEXT.studyTopic}\n\nResearch objective: ${GUIDE_CONTEXT.researchObjective}\n${CALIBRATION_EXAMPLES}\nScore the moderator's overall probing quality across this entire interview, 1-5.`,
    user: `Full transcript:\n${fullTranscriptText}`,
    tool: HOLISTIC_TOOL,
  },
  {
    name: "B_full_narrow_task",
    description: "Full transcript + full guide context, but asked ONLY to classify ONE specific real exchange.",
    system: `You are an expert qualitative-research evaluator.\n\nStudy: ${GUIDE_CONTEXT.studyTopic}\n\nResearch objective: ${GUIDE_CONTEXT.researchObjective}\n${CALIBRATION_EXAMPLES}\nClassify only the moderator's handling of this specific exchange (the "time it takes" friction point, quoted below), even though you have the full transcript for context:\nRespondent: "${LOCAL_EXCHANGE.respondent}"\nModerator: "${LOCAL_EXCHANGE.moderator}"`,
    user: `Full transcript (for context only):\n${fullTranscriptText}`,
    tool: PROBE_QUALITY_TOOL,
  },
  {
    name: "C_local_pair_only",
    description: "ONLY the 2-turn exchange + the relevant guide question -- same exact task as B, minimal context.",
    system: `You are an expert qualitative-research evaluator.\n${CALIBRATION_EXAMPLES}\nThe guide question being explored: "${GUIDE_CONTEXT.frictionQuestion.ask}" (${GUIDE_CONTEXT.frictionQuestion.note})\n\nClassify the moderator's follow-up.`,
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

async function runOnce(test) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    temperature: 0,
    system: test.system,
    messages: [{ role: "user", content: test.user }],
    tools: [test.tool],
    tool_choice: { type: "tool", name: test.tool.name },
  });
  const block = response.content.find((b) => b.type === "tool_use");
  return block ? block.input : null;
}

function summarizeNumeric(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean: mean.toFixed(2), stdev: Math.sqrt(variance).toFixed(2), min: Math.min(...values), max: Math.max(...values), values };
}

function summarizeCategorical(values) {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  const mode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { counts, mode: mode[0], agreementPct: ((mode[1] / values.length) * 100).toFixed(0), values };
}

async function main() {
  console.log(`Running each of ${TESTS.length} tests ${N_RUNS} times at temperature 0...\n`);

  for (const test of TESTS) {
    console.log(`\n=== ${test.name} ===`);
    console.log(test.description);
    const results = [];
    for (let i = 0; i < N_RUNS; i++) {
      const r = await runOnce(test);
      results.push(r);
      process.stdout.write(".");
    }
    console.log("");

    if (test.tool.name === "score_probing") {
      const scores = results.map((r) => r.score);
      console.log("scores:", scores);
      console.log("summary:", JSON.stringify(summarizeNumeric(scores)));
    } else if (test.tool.name === "classify_probe") {
      const qualities = results.map((r) => r.quality);
      console.log("qualities:", qualities);
      console.log("summary:", JSON.stringify(summarizeCategorical(qualities)));
    } else if (test.tool.name === "classify_leading") {
      const leadings = results.map((r) => r.isLeading);
      console.log("isLeading:", leadings);
      console.log("summary:", JSON.stringify(summarizeCategorical(leadings)));
    }
    // Show a couple of the actual reasoning strings so drift in *wording*
    // (not just the label) is visible too.
    console.log("sample reasonings:", results.slice(0, 3).map((r) => r.reasoning));
  }
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
