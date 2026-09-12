/**
 * Interview guide content, as plain TypeScript (not a DB table) -- matches
 * the Python project's precedent (common/guides/*.py) and keeps guides
 * versioned with the code rather than requiring a migration to add one.
 * Only one guide exists for now (the bare-minimum vertical slice); adding
 * more later is just adding another export and a lookup key, same pattern
 * as INTERVIEW_GUIDE in the Python project.
 *
 * Deliberately given real texture (a forced-choice, a rating-then-why, an
 * open question designed to surface an unplanned thread) rather than three
 * generic questions -- a thin guide makes every architecture look shallow
 * regardless of how well it actually reasons, since there's nothing worth
 * probing into. Still a ~10-minute conversation, not an elaborate one.
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

export const BASELINE_GUIDE: Guide = {
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
