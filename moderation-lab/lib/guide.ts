/**
 * Interview guide content, as plain TypeScript (not a DB table) -- matches
 * the Python project's precedent (common/guides/*.py) and keeps guides
 * versioned with the code rather than requiring a migration to add one.
 * Two guides exist: `everyday` (default) is a simple, personal topic
 * (grocery shopping / meal planning) anyone can be genuinely interviewed on
 * on the spot -- for testing whether the moderator *feels* good without a
 * tester having to act out a persona, which is its own confound.
 * `biopharma` is the real target-domain topic, for testing against actual
 * personas later. Select via the GUIDE env var (GUIDE=biopharma to switch);
 * same pattern as INTERVIEW_GUIDE in the Python project. Adding a third
 * guide is just adding another export and a case in ACTIVE_GUIDE below.
 *
 * Both are deliberately given real texture (a forced-choice, a
 * rating-then-why, an open question designed to surface an unplanned
 * thread) rather than generic questions -- a thin guide makes every
 * architecture look shallow regardless of how well it actually reasons,
 * since there's nothing worth probing into. Still a ~10-minute
 * conversation, not an elaborate one.
 */
export type GuideQuestion = {
  topic: string;
  ask: string;
  targetMinutes: number;
  probes?: string[];
  /** Ask them to state a number verbally (no tap UI in a voice call), then
   * immediately probe why -- rating-then-why sequencing, not rating alone. */
  rating?: { prompt: string; scale: string };
  /** Guidance for the moderator on what this question is really testing --
   * not read aloud, just steering. */
  note?: string;
};

export type Guide = {
  studyTopic: string;
  targetDurationMinutes: number;
  openingScript: string;
  closingScript: string;
  questions: GuideQuestion[];
};

export const BIOPHARMA_GUIDE: Guide = {
  studyTopic:
    "How biopharma market-research teams currently run qualitative interviews, and where AI could help.",
  targetDurationMinutes: 10,
  openingScript:
    "Hi, thanks so much for joining today. I'd love to hear about how your team runs market research " +
    "and thinks about AI's role in it — there are no wrong answers here, I'm just trying to understand " +
    "how this actually works day to day. Ready to dive in?",
  closingScript:
    "This has been genuinely useful, thank you for being so candid. That's everything I wanted to cover " +
    "— have a great rest of your day.",
  questions: [
    {
      topic: "warm-up / role",
      ask: "To start, tell me a bit about your role and the kind of research your team runs most often.",
      targetMinutes: 1.5,
      probes: ["What's a project you worked on recently?", "Who do you usually do this for internally?"],
      note: "Quick warm-up -- get a concrete, specific example on the table early so later questions have something real to anchor to.",
    },
    {
      topic: "current process",
      ask: "Walk me through how a typical qualitative study actually gets commissioned and run, start to finish.",
      targetMinutes: 2,
      probes: [
        "Where does the business question first come from?",
        "Who's involved at each step, and where does the most time actually go?",
        "How much of that is genuinely necessary vs. just how it's always been done?",
      ],
    },
    {
      topic: "biggest friction point (forced choice)",
      ask:
        "If you had to pick just one — is the bigger problem with your current process the speed it takes, " +
        "the cost, or the depth of insight you actually get out of it? Pick one.",
      targetMinutes: 2,
      probes: [
        "Why that one over the other two?",
        "Tell me about a specific time that actually bit you.",
        "What would 'fixed' even look like for that?",
      ],
      note: "Forced-choice framing on purpose -- a vague 'all three are frustrating' answer isn't a real answer to this question, it's worth pushing past.",
    },
    {
      topic: "process health (rating + why)",
      ask:
        "On a scale of 1 to 10, how well is your current research process keeping up with how fast the " +
        "business actually needs answers?",
      targetMinutes: 1.5,
      rating: {
        prompt: "How well is your current research process keeping up with how fast the business needs answers?",
        scale: "1 (not at all) to 10 (perfectly)",
      },
      probes: ["Why that number and not two points higher?", "What would move it up by even one point?"],
      note: "Get the number, then immediately probe the 'why' behind it -- the number alone is not the data point that matters.",
    },
    {
      topic: "unplanned thread (open-ended)",
      ask: "Tell me about a research project in the last year that didn't go the way you expected.",
      targetMinutes: 1.5,
      probes: ["What actually happened?", "What did you do differently afterward, if anything?"],
      note:
        "Deliberately open-ended and off-guide -- whatever they bring up here (a vendor issue, a bad " +
        "respondent sample, a stakeholder fight, something else entirely) is worth actually pulling on for " +
        "a turn or two before moving to the next topic, even though it isn't itself a scripted question.",
    },
    {
      topic: "AI attitudes",
      ask: "Where, if anywhere, do you see AI actually being useful in this process today, versus where you're skeptical?",
      targetMinutes: 1.5,
      probes: [
        "What would it take for you to actually trust an AI-moderated interview?",
        "What's a claim you've heard from a vendor that you didn't buy?",
      ],
    },
  ],
};

export const EVERYDAY_GUIDE: Guide = {
  studyTopic: "How people decide what to eat day-to-day — grocery shopping, meal planning, and cooking habits.",
  targetDurationMinutes: 10,
  openingScript:
    "Hi, thanks for chatting with me today. I want to understand how you actually handle food and " +
    "groceries in a normal week — no wrong answers, I'm just curious how it really works for you. " +
    "Ready to dive in?",
  closingScript:
    "This was genuinely interesting, thank you for walking me through all of that. That's everything " +
    "I wanted to cover — have a great rest of your day.",
  questions: [
    {
      topic: "warm-up",
      ask: "Tell me about your week so far from a food standpoint — mostly cooking, ordering in, a mix?",
      targetMinutes: 1.5,
      probes: ["What did you actually eat yesterday?", "Is that a pretty typical day for you?"],
      note: "Quick warm-up -- get something concrete and specific on the table early.",
    },
    {
      topic: "current process",
      ask: "Walk me through how you actually decide what to buy or make in a typical week.",
      targetMinutes: 2,
      probes: [
        "Do you plan ahead or figure it out day to day?",
        "Where does most of the effort or time actually go?",
        "How much of that is a real decision each time vs. just habit?",
      ],
    },
    {
      topic: "biggest friction point (forced choice)",
      ask:
        "If you had to pick just one — is the bigger friction point for you the cost, the time it takes, " +
        "or just not knowing what you want? Pick one.",
      targetMinutes: 2,
      probes: [
        "Why that one over the other two?",
        "Tell me about a specific time that was actually annoying.",
        "What would 'fixed' look like for you?",
      ],
      note: "Forced-choice on purpose -- a vague 'a bit of everything' answer isn't a real answer, worth pushing past.",
    },
    {
      topic: "satisfaction (rating + why)",
      ask: "On a scale of 1 to 10, how satisfied are you with how you currently handle food and groceries?",
      targetMinutes: 1.5,
      rating: {
        prompt: "How satisfied are you with how you currently handle food and groceries?",
        scale: "1 (not at all) to 10 (couldn't be better)",
      },
      probes: ["Why that number and not two points higher?", "What would move it up by even one point?"],
      note: "Get the number, then immediately probe the 'why' -- the number alone isn't the data point that matters.",
    },
    {
      topic: "unplanned thread (open-ended)",
      ask: "Tell me about a specific time your food plan for the week completely fell apart, or a meal that really surprised you.",
      targetMinutes: 1.5,
      probes: ["What actually happened?", "Did it change how you do things afterward?"],
      note:
        "Deliberately open-ended -- whatever story comes up here is worth actually pulling on for a turn " +
        "or two before moving on, even though it isn't itself a scripted question.",
    },
    {
      topic: "forward-looking",
      ask: "If you could wave a magic wand and fix one part of how you handle food and groceries, what would it be?",
      targetMinutes: 1.5,
      probes: ["Why that, specifically?", "Have you actually tried anything to fix it already?"],
    },
  ],
};

const GUIDES: Record<string, Guide> = {
  everyday: EVERYDAY_GUIDE,
  biopharma: BIOPHARMA_GUIDE,
};

/** Which guide the app actually uses -- GUIDE=biopharma to switch, defaults
 * to the simple, personal topic anyone can be genuinely interviewed on. */
export const ACTIVE_GUIDE: Guide = GUIDES[process.env.GUIDE ?? "everyday"] ?? EVERYDAY_GUIDE;

export function formatGuideForPrompt(guide: Guide): string {
  return guide.questions
    .map((q, i) => {
      const parts = [`${i + 1}. [${q.topic}, ~${q.targetMinutes} min]`, q.ask];
      if (q.rating) {
        parts.push(`Also ask them to rate it verbally — "${q.rating.prompt}" — ${q.rating.scale} — and get the number.`);
      }
      if (q.probes?.length) parts.push(`(probes if needed: ${q.probes.join("; ")})`);
      if (q.note) parts.push(`[${q.note}]`);
      return parts.join(" ");
    })
    .join("\n");
}
