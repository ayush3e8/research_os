/**
 * The canned-probe bank lib/architectures/cannedprobe.ts draws from --
 * pre-written, content-free follow-up lines, organized by communicative
 * intent (why the moderator is asking, not what it's asking about) rather
 * than by topic. That's what lets a line stay natural regardless of how
 * specific the respondent's last answer was: nothing in here ever
 * references what they actually said, only "that" / "it" -- a genuinely
 * content-specific follow-up is exactly the case cannedprobe.ts routes to
 * the real moderator LLM instead of this bank (see that file's
 * `specific_probe` branch).
 *
 * Deliberately narrower than the full taxonomy this was drafted from --
 * fewer, more semantically distinct categories make jev's classification
 * more reliable. Widen it later once there's real accuracy data on these.
 */

export type ProbeCategory = "deepen" | "clarify" | "example" | "process" | "why" | "impact" | "frequency";

/** category -> jev classification criterion text. */
export const PROBE_CATEGORIES: Record<ProbeCategory, string> = {
  deepen: "A generic invitation to keep going on the same thread -- no specific new angle needed, just more.",
  clarify: "Their last answer used a term or phrase that's genuinely ambiguous and worth pinning down.",
  example: "A concrete example or specific instance would ground what's so far been abstract.",
  process: "Worth understanding the mechanics or sequence of how something actually happens, step by step.",
  why: "Worth understanding the reasoning or motivation behind what they just said.",
  impact: "Worth understanding how much what they described actually matters, or what difference it makes.",
  frequency: "Worth understanding whether what they described is typical for them, or more of an exception.",
};

// "" included on purpose -- sometimes skipping the acknowledgment entirely
// reads more natural than one before every single probe.
const ACKNOWLEDGMENTS = ["Got it.", "That makes sense.", "I see.", "Makes sense.", ""];

const PROBE_BANK: Record<ProbeCategory, string[]> = {
  deepen: ["Say a little more about that.", "What else comes to mind?", "Tell me more about that."],
  clarify: ["What do you mean by that?", "Can you unpack that a little?"],
  example: [
    "Can you give me an example?",
    "What did that look like in practice?",
    "Can you think of a recent time that happened?",
  ],
  process: ["Walk me through how that works.", "And what happened next?", "How does that usually play out?"],
  why: ["What makes you say that?", "What's driving that?", "Why does that matter to you?"],
  impact: ["How does that affect what you ultimately do?", "What difference does that make for you?"],
  frequency: ["Is that pretty typical for you, or more of an exception?", "How often does that tend to happen?"],
};

export function isProbeCategory(x: string): x is ProbeCategory {
  return Object.prototype.hasOwnProperty.call(PROBE_BANK, x);
}

/** Persisted in conversation_state.state.probeBank -- see
 * ArchitectureResult.nextState's docstring for how that round-trips. */
export type ProbeBankState = {
  lastCategory: ProbeCategory | null;
  categoryCursor: Partial<Record<ProbeCategory, number>>;
  ackCursor: number;
};

export const INITIAL_PROBE_BANK_STATE: ProbeBankState = { lastCategory: null, categoryCursor: {}, ackCursor: 0 };

/** Picks the next ack + probe line for `category`, rotating independently
 * through each list (mod its length) so a category repeated later in the
 * same conversation still varies its exact wording rather than looping back
 * to the very first line every time. */
export function pickProbeLine(category: ProbeCategory, state: ProbeBankState): { line: string; nextState: ProbeBankState } {
  const probes = PROBE_BANK[category];
  const probeIndex = (state.categoryCursor[category] ?? 0) % probes.length;
  const ack = ACKNOWLEDGMENTS[state.ackCursor % ACKNOWLEDGMENTS.length];
  const probe = probes[probeIndex];
  const line = ack ? `${ack} ${probe}` : probe;

  return {
    line,
    nextState: {
      lastCategory: category,
      categoryCursor: { ...state.categoryCursor, [category]: probeIndex + 1 },
      ackCursor: state.ackCursor + 1,
    },
  };
}
