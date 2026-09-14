/**
 * Everything here is plain arithmetic over the transcript -- no LLM calls.
 * Two reasons a metric ends up here rather than as a judge call: it's
 * inherently a whole-transcript statistic (repetition/variety only means
 * something relative to all the moderator's other turns, not one turn in
 * isolation), or it's directly countable (elapsed time per topic) the same
 * way pacing.ts already treats real wall-clock time as arithmetic, not a
 * model's own sense of urgency.
 */
import type { Guide } from "@/lib/guide";
import { bestMatchingTopic } from "./guide-match";
import type { ReconstructedTurn } from "./transcript";

export type NaturalnessVariety = {
  wordCountMean: number;
  wordCountStdev: number;
  /** Coefficient of variation (stdev/mean) -- a flat, robotic moderator has
   * every turn close to the same length, so this trends toward 0. */
  wordCountVariety: number;
  repeatedOpenerRate: number;
};

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** First 3 words, lowercased -- a cheap fingerprint for "does the moderator
 * open every turn the same way" (e.g. always "That's really..."). */
function openerFingerprint(text: string): string {
  return text.trim().toLowerCase().split(/\s+/).slice(0, 3).join(" ");
}

export function computeNaturalnessVariety(moderatorTurns: string[]): NaturalnessVariety {
  if (moderatorTurns.length === 0) {
    return { wordCountMean: 0, wordCountStdev: 0, wordCountVariety: 0, repeatedOpenerRate: 0 };
  }
  const counts = moderatorTurns.map(wordCount);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
  const stdev = Math.sqrt(variance);

  const openers = moderatorTurns.map(openerFingerprint);
  const openerCounts = new Map<string, number>();
  for (const o of openers) openerCounts.set(o, (openerCounts.get(o) ?? 0) + 1);
  const repeated = [...openerCounts.values()].filter((c) => c > 1).reduce((a, b) => a + b, 0);

  return {
    wordCountMean: mean,
    wordCountStdev: stdev,
    wordCountVariety: mean > 0 ? stdev / mean : 0,
    repeatedOpenerRate: repeated / moderatorTurns.length,
  };
}

export type TopicCoverage = {
  topic: string;
  targetMinutes: number;
  actualMinutes: number;
  covered: boolean;
};

export type CoverageAndTime = {
  perTopic: TopicCoverage[];
  coverageRate: number; // fraction of guide topics touched at all
  timeAllocationError: number; // mean |actual - target| minutes across covered topics
  totalElapsedMinutes: number;
};

/** Attributes each turn to its best-matching guide topic (best-effort, see
 * guide-match.ts) and sums elapsed time per topic from turn timestamps --
 * covers both "was this topic addressed" and "how long did we spend on it
 * vs. planned," per the explicit ask to not just check presence/absence. */
export function computeCoverageAndTime(turns: ReconstructedTurn[], guide: Guide): CoverageAndTime {
  const minutesByTopic = new Map<string, number>();
  for (const q of guide.questions) minutesByTopic.set(q.topic, 0);

  const moderatorTurns = turns.filter((t) => t.role === "moderator");
  for (let i = 0; i < moderatorTurns.length; i++) {
    const turn = moderatorTurns[i];
    const match = bestMatchingTopic(turn.text, guide);
    if (!match) continue;
    const next = moderatorTurns[i + 1];
    const durationMinutes = next ? (next.at.getTime() - turn.at.getTime()) / 60_000 : 0;
    minutesByTopic.set(match.question.topic, (minutesByTopic.get(match.question.topic) ?? 0) + Math.max(durationMinutes, 0));
  }

  const perTopic: TopicCoverage[] = guide.questions.map((q) => ({
    topic: q.topic,
    targetMinutes: q.targetMinutes,
    actualMinutes: minutesByTopic.get(q.topic) ?? 0,
    covered: (minutesByTopic.get(q.topic) ?? 0) > 0,
  }));

  const covered = perTopic.filter((t) => t.covered);
  const timeAllocationError =
    covered.length > 0
      ? covered.reduce((sum, t) => sum + Math.abs(t.actualMinutes - t.targetMinutes), 0) / covered.length
      : 0;

  const first = turns[0]?.at;
  const last = turns[turns.length - 1]?.at;
  const totalElapsedMinutes = first && last ? (last.getTime() - first.getTime()) / 60_000 : 0;

  return {
    perTopic,
    coverageRate: perTopic.length > 0 ? covered.length / perTopic.length : 0,
    timeAllocationError,
    totalElapsedMinutes,
  };
}
