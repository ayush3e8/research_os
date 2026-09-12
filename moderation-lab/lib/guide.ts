/**
 * Interview guide content, as plain TypeScript (not a DB table) -- matches
 * the Python project's precedent (common/guides/*.py) and keeps guides
 * versioned with the code rather than requiring a migration to add one.
 * Only one guide exists for now (the bare-minimum vertical slice); adding
 * more later is just adding another export and a lookup key, same pattern
 * as INTERVIEW_GUIDE in the Python project.
 */
export type GuideQuestion = {
  topic: string;
  ask: string;
  targetMinutes: number;
  probes?: string[];
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
    "Hi, thanks so much for joining. I'd love to hear about how your team runs market research today " +
    "— there are no wrong answers here. Ready to dive in?",
  closingScript:
    "This has been really helpful, thank you for your time today. That's everything I wanted to cover " +
    "— have a great rest of your day.",
  questions: [
    {
      topic: "current process",
      ask: "Walk me through how a typical qualitative study gets commissioned and run on your team today.",
      targetMinutes: 3,
      probes: ["Who's involved at each step?", "Where does the most time actually go?"],
    },
    {
      topic: "pain points",
      ask: "What's the most frustrating part of that process for you personally?",
      targetMinutes: 3,
      probes: ["Can you give a specific recent example?", "How often does that come up?"],
    },
    {
      topic: "AI attitudes",
      ask: "Where, if anywhere, do you see AI actually helping with this today?",
      targetMinutes: 4,
      probes: ["What would make you trust an AI-run interview?", "What would worry you about it?"],
    },
  ],
};

export function formatGuideForPrompt(guide: Guide): string {
  return guide.questions
    .map((q, i) => `${i + 1}. [${q.topic}, ~${q.targetMinutes} min] ${q.ask}` +
      (q.probes?.length ? ` (probes if needed: ${q.probes.join("; ")})` : ""))
    .join("\n");
}
