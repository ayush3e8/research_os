/**
 * Deterministic (no LLM) matching of a moderator utterance against guide
 * questions -- keyword overlap, not semantic embedding. This is a v1
 * heuristic, not a robust NLP match: it's good enough to (a) decide whether
 * a moderator turn is verbatim/near-verbatim guide text vs. an improvised
 * follow-up (for neutrality attribution and for gating the redundant-
 * question check) and (b) attribute a turn to "which guide topic is this,"
 * for coverage-by-time. A future architecture that tracks its own current
 * guide-question index in conversation_state.state would make this exact
 * instead of approximate -- worth doing if this heuristic misattributes
 * turns in practice.
 */
import type { Guide, GuideQuestion } from "@/lib/guide";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "and", "or", "in", "on", "for",
  "you", "your", "it", "that", "this", "do", "does", "did", "what", "how", "tell", "me",
  "about", "just", "would", "with", "if", "so", "than", "than", "be", "as", "at", "i",
]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Best-matching guide question for an utterance, above a minimum overlap
 * threshold -- used for coverage-by-time attribution (looser threshold,
 * every turn gets attributed to *something* if plausible). */
export function bestMatchingTopic(text: string, guide: Guide): { question: GuideQuestion; score: number } | null {
  const utteranceWords = keywords(text);
  let best: { question: GuideQuestion; score: number } | null = null;
  for (const q of guide.questions) {
    const score = overlapScore(utteranceWords, keywords(`${q.topic} ${q.ask}`));
    if (!best || score > best.score) best = { question: q, score };
  }
  if (!best || best.score < 0.15) return null;
  return best;
}

/** Stricter check: is this moderator utterance close enough to the guide's
 * own wording to call it verbatim/near-verbatim (vs. an improvised
 * follow-up)? Used to attribute a leading-question flag to the guide
 * rather than the moderator, and to gate the redundant-question check
 * (only fires when the moderator is about to ask something guide-shaped). */
export function nearVerbatimGuideQuestion(moderatorText: string, guide: Guide): GuideQuestion | null {
  const utteranceWords = keywords(moderatorText);
  for (const q of guide.questions) {
    const score = overlapScore(utteranceWords, keywords(q.ask));
    if (score >= 0.6) return q;
  }
  return null;
}
