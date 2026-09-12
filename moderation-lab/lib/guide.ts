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
 * Each guide carries a `researchObjective`: a real business decision this
 * study exists to inform, not just a topic to chat about. It does two
 * jobs -- (1) `lib/architectures/baseline.ts` folds a condensed version
 * into the moderator's own system prompt, so it can recognize when an
 * answer hasn't actually resolved the thing the study needs to know (not
 * just execute a question list), and (2) `app/page.tsx` shows it to the
 * human tester *before* they start the call, so they're evaluating
 * against a real target ("did it actually establish whether cost, time,
 * or decision fatigue is the real barrier?") instead of just vibes ("did
 * that feel natural?"). A real respondent in the field wouldn't
 * necessarily be told this much detail up front -- this is a deliberate
 * meta step for the tester's benefit, not something the moderator recites.
 *
 * Questions are given real texture (a forced-choice, a rating-then-why, an
 * open question designed to surface an unplanned thread, a concept
 * reaction) rather than generic ones -- a thin guide makes every
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
  /** The real business decision this study informs -- see module docstring. */
  researchObjective: string;
  openingScript: string;
  closingScript: string;
  questions: GuideQuestion[];
};

export const BIOPHARMA_GUIDE: Guide = {
  studyTopic:
    "How biopharma market-research teams currently run qualitative interviews, and where AI could help.",
  targetDurationMinutes: 10,
  researchObjective:
    "You're being interviewed on behalf of an AI-native market-research startup deciding whether " +
    "experienced biopharma insights professionals would actually trust and adopt AI-moderated " +
    "qualitative interviews as part of their real research toolkit -- not just find the idea " +
    "interesting in the abstract. The team needs real answers to: (1) is the biggest barrier in their " +
    "current process really speed, cost, or depth of insight -- because that determines whether an " +
    "AI-moderated approach even addresses their actual pain; (2) how much slack do they feel they " +
    "genuinely have today, and is there real appetite for something different; (3) what would it " +
    "concretely take for them to trust an AI moderator with a real study, not a toy pilot. As the " +
    "evaluator, watch whether the moderator actually pins down clear answers to these, not just " +
    "whether the conversation feels pleasant.",
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
      note: "This is the core of the research objective -- a vague 'all three are frustrating' answer isn't a real answer, worth pushing past.",
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
      topic: "AI trust (concept reaction)",
      ask:
        "Now imagine a service where an AI, not a human, actually moderates a live voice interview with " +
        "your target respondents -- would you seriously consider using that for a real study, or not?",
      targetMinutes: 1.5,
      probes: [
        "What would it concretely take for you to trust it with something that actually matters?",
        "What's a claim you've heard from a vendor in this space that you didn't buy?",
      ],
      note: "This is the direct payoff question -- get a real yes/no-leaning reaction and the concrete condition behind it, not just polite interest.",
    },
  ],
};

export const EVERYDAY_GUIDE: Guide = {
  studyTopic: "How people decide what to eat day-to-day — grocery shopping, meal planning, and cooking habits.",
  targetDurationMinutes: 10,
  researchObjective:
    "You're being interviewed on behalf of Homeplate, a meal-kit and grocery-delivery subscription " +
    "company. Homeplate's product team is deciding whether to build a new, lower-cost 'Quick Plan' " +
    "tier -- AI-assisted weekly meal planning and a ready-to-order grocery list, without the full " +
    "meal-kit boxes -- aimed specifically at people who currently do NOT use any meal-kit or " +
    "grocery-delivery service. Before building it, they need real answers to: (1) is this person's " +
    "current process real deliberate choice, or just habit/inertia -- inertia is much harder to " +
    "unseat than a genuine unmet need; (2) what's actually the bigger barrier -- cost, time, or just " +
    "not knowing what to make (decision fatigue) -- because the answer changes whether a cheaper tier " +
    "alone would even move anyone, versus needing to solve decision fatigue directly; (3) how much " +
    "real appetite exists for something new versus 'it's not broken, don't fix it'; (4) presented with " +
    "the actual Quick Plan concept, would *this specific person* actually try it, and if not, why not. " +
    "As the evaluator, watch whether the moderator actually pins down clear answers to these -- " +
    "especially #2 and #4 -- not just whether the conversation feels pleasant.",
  openingScript:
    "Hi, thanks for chatting with me today. I'm doing some research on behalf of a company exploring " +
    "new tools for weekly meal planning and grocery shopping, and I want to understand how you " +
    "actually handle that today — no wrong answers, I'm just curious how it really works for you. " +
    "Ready to dive in?",
  closingScript:
    "This was genuinely useful, thank you for walking me through all of that. That's everything I " +
    "wanted to cover — have a great rest of your day.",
  questions: [
    {
      topic: "warm-up",
      ask: "Tell me about your week so far from a food standpoint — mostly cooking, ordering in, a mix?",
      targetMinutes: 1,
      probes: ["What did you actually eat yesterday?", "Is that a pretty typical day for you?"],
      note: "Quick warm-up -- get something concrete and specific on the table early.",
    },
    {
      topic: "current process (habit vs. deliberate choice)",
      ask: "Walk me through how you actually decide what to buy or make in a typical week.",
      targetMinutes: 1.5,
      probes: [
        "Do you plan ahead or figure it out day to day?",
        "Where does most of the effort or time actually go?",
        "Is that a real decision you're making each week, or mostly just habit at this point?",
      ],
      note: "Trying to establish habit/inertia vs. genuine unmet need -- that distinction matters a lot for whether a new tool would actually get adopted.",
    },
    {
      topic: "core barrier (forced choice)",
      ask:
        "If you had to pick just one — is the bigger friction point for you the cost, the time it takes, " +
        "or just not knowing what you want? Pick one.",
      targetMinutes: 2,
      probes: [
        "Why that one over the other two?",
        "Tell me about a specific time that was actually annoying because of it.",
        "What would 'fixed' actually look like for you?",
      ],
      note:
        "This is the single most important question in the whole guide -- the answer decides whether a " +
        "cheaper option alone would move this person, or whether the real problem is decision fatigue " +
        "that price can't fix. A vague 'a bit of everything' answer isn't a real answer, worth pushing past.",
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
      note: "Get the number, then immediately probe the 'why' -- gauging real appetite for change vs. complacency.",
    },
    {
      topic: "unplanned thread (open-ended)",
      ask: "Tell me about a specific time your food plan for the week completely fell apart, or a meal that really surprised you.",
      targetMinutes: 1.5,
      probes: ["What actually happened?", "Did it change how you do things afterward?"],
      note:
        "Deliberately open-ended -- whatever story comes up here is worth actually pulling on for a turn " +
        "or two before moving on. A concrete failure moment here is often the real trigger that would " +
        "make someone switch to something new, worth more than a hypothetical.",
    },
    {
      topic: "Quick Plan concept reaction",
      ask:
        "Here's an idea: imagine a service that, every week, automatically builds you a meal plan and a " +
        "ready-to-order grocery list based on what you like — no full meal-kit boxes, just the planning " +
        "and the list, for a lot less than a meal-kit subscription costs. Would you actually try that, or not?",
      targetMinutes: 2,
      probes: [
        "What specifically would make you say yes, or what's holding you back?",
        "Would that actually solve the friction point you picked earlier, or not really?",
      ],
      note:
        "This is the direct payoff question the whole study exists to answer -- get a real yes/no-leaning " +
        "reaction and the concrete reason behind it, and explicitly connect it back to whichever barrier " +
        "they picked earlier (cost/time/decision fatigue) rather than treating it as a fresh question.",
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
