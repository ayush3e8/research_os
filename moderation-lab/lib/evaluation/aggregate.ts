/**
 * Turns raw per-turn check records + deterministic metrics into the final
 * dimension scores and overall score. This is the ONLY place scoring math
 * happens -- every LLM check above only ever returns booleans/categoricals,
 * never a rating, per the reliability findings this whole framework is
 * built from.
 *
 * Weights below are a first pass, explicitly not final -- flagged for a
 * quick pass together once real multi-call data exists to sanity-check
 * them against. "Listening" and "research judgment" from the original
 * 7-dimension rubric aren't separate scores here: listening folded into
 * the redundant-question check, research judgment folded into thread-pull
 * noticing (see checks.ts).
 */
import type { CoverageAndTime, NaturalnessVariety } from "./deterministic";
import type { DimensionScore, EvaluationOutput, TurnCheckRecord } from "./types";

const DIMENSION_WEIGHTS: Record<string, number> = {
  probing: 0.3,
  neutrality: 0.15,
  redundantQuestion: 0.15,
  naturalness: 0.15,
  clarity: 0.05,
  coverage: 0.1,
  timeManagement: 0.1,
};

function byType(records: TurnCheckRecord[], type: TurnCheckRecord["checkType"]) {
  return records.filter((r) => r.checkType === type && !r.malformed);
}

function dim(score: number | null, weight: number, detail: Record<string, unknown>): DimensionScore {
  return { score, weight, detail };
}

function scoreProbing(records: TurnCheckRecord[]): DimensionScore {
  const depthRecords = byType(records, "depthProbe");
  const probeWorthy = depthRecords.filter((r) => r.result.priorAnswerWasVague === true);
  const good = probeWorthy.filter((r) => r.result.moderatorFollowedUp === true && r.result.followUpTargetedSpecificDetail === true).length;
  const bad = probeWorthy.filter((r) => r.result.moderatorFollowedUp === true && r.result.followUpTargetedSpecificDetail !== true).length;
  const none = probeWorthy.filter((r) => r.result.moderatorFollowedUp !== true).length;
  const depthProbeRate = probeWorthy.length > 0 ? good / probeWorthy.length : null;

  const threadRecords = byType(records, "threadPull");
  const opportunities = threadRecords.filter(
    (r) => r.result.mentionedUnpromptedTopic === true && r.result.plausiblyRelevantToObjective === true
  );
  const pursued = opportunities.filter((r) => r.result.moderatorFollowedUpOnThread === true).length;
  const threadPullRate = opportunities.length > 0 ? pursued / opportunities.length : null;

  const rates = [depthProbeRate, threadPullRate].filter((r): r is number => r !== null);
  const score = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null;

  return dim(score, DIMENSION_WEIGHTS.probing, {
    depthProbe: { probeWorthyMoments: probeWorthy.length, good, bad, none, rate: depthProbeRate },
    threadPull: { opportunities: opportunities.length, pursued, rate: threadPullRate },
  });
}

function scoreNeutrality(records: TurnCheckRecord[]): DimensionScore {
  const all = byType(records, "neutrality");
  // Verbatim guide questions attribute any leading framing to the guide,
  // not the moderator -- score over improvised turns when we have any.
  const improvised = all.filter((r) => r.result.isVerbatimGuideText !== true);
  const pool = improvised.length > 0 ? improvised : all;
  const leading = pool.filter(
    (r) => r.result.presupposesAnAnswer === true || r.result.offersLeadingForcedChoice === true || r.result.containsLoadedFraming === true
  ).length;
  const score = pool.length > 0 ? 1 - leading / pool.length : null;
  return dim(score, DIMENSION_WEIGHTS.neutrality, {
    turnsChecked: pool.length,
    leadingCount: leading,
    verbatimTurnsExcluded: all.length - pool.length,
  });
}

function scoreClarity(records: TurnCheckRecord[]): DimensionScore {
  const all = byType(records, "clarity");
  if (all.length === 0) return dim(null, DIMENSION_WEIGHTS.clarity, {});
  let clear = 0;
  let minor = 0;
  let unclear = 0;
  let totalFlags = 0;
  for (const r of all) {
    const flags = [r.result.isCompoundQuestion, r.result.hasAmbiguousReferent, r.result.isExcessivelyLong].filter(Boolean).length;
    totalFlags += flags;
    if (flags === 0) clear++;
    else if (flags === 1) minor++;
    else unclear++;
  }
  const score = 1 - totalFlags / (all.length * 3);
  return dim(score, DIMENSION_WEIGHTS.clarity, { turnsChecked: all.length, clear, minor, unclear });
}

function scoreRedundantQuestion(records: TurnCheckRecord[]): DimensionScore {
  const all = byType(records, "redundantQuestion");
  const withPriorCoverage = all.filter((r) => r.result.priorCoverage !== "none");
  const unacknowledged = withPriorCoverage.filter((r) => r.result.acknowledgedPriorAnswer === false).length;
  const score = withPriorCoverage.length > 0 ? 1 - unacknowledged / withPriorCoverage.length : 1;
  return dim(score, DIMENSION_WEIGHTS.redundantQuestion, {
    questionsChecked: all.length,
    priorCoverageFoundIn: withPriorCoverage.length,
    unacknowledged,
  });
}

function scoreNaturalness(records: TurnCheckRecord[], variety: NaturalnessVariety): DimensionScore {
  const toneRecords = byType(records, "tone");
  const warm = toneRecords.filter((r) => r.result.feelsWarmAndAttuned === true).length;
  const toneRate = toneRecords.length > 0 ? warm / toneRecords.length : null;
  // Placeholder blend -- see module docstring. wordCountVariety is reported
  // but not yet folded into the score pending a reference scale from more
  // real calls; repeatedOpenerRate directly penalizes template-y phrasing.
  const varietyComponent = 1 - Math.min(variety.repeatedOpenerRate, 1);
  const score = toneRate !== null ? (varietyComponent + toneRate) / 2 : varietyComponent;
  return dim(score, DIMENSION_WEIGHTS.naturalness, {
    toneChecked: toneRecords.length,
    toneRate,
    wordCountVariety: variety.wordCountVariety,
    repeatedOpenerRate: variety.repeatedOpenerRate,
  });
}

function scoreCoverage(coverage: CoverageAndTime): DimensionScore {
  return dim(coverage.coverageRate, DIMENSION_WEIGHTS.coverage, {
    topicsCovered: coverage.perTopic.filter((t) => t.covered).length,
    topicsTotal: coverage.perTopic.length,
  });
}

function scoreTimeManagement(coverage: CoverageAndTime): DimensionScore {
  const covered = coverage.perTopic.filter((t) => t.covered);
  if (covered.length === 0) return dim(null, DIMENSION_WEIGHTS.timeManagement, {});
  // Symmetric ratio per topic: 1.0 = spent exactly the planned time, lower
  // the further off in either direction (rushed or over-lingered).
  const ratios = covered.map((t) => Math.min(t.actualMinutes, t.targetMinutes) / Math.max(t.actualMinutes, t.targetMinutes, 0.01));
  const score = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return dim(score, DIMENSION_WEIGHTS.timeManagement, {
    perTopic: covered.map((t) => ({ topic: t.topic, targetMinutes: t.targetMinutes, actualMinutes: +t.actualMinutes.toFixed(1) })),
  });
}

export function aggregateEvaluation(
  turnChecks: TurnCheckRecord[],
  coverage: CoverageAndTime,
  variety: NaturalnessVariety
): EvaluationOutput {
  const dimensionScores: Record<string, DimensionScore> = {
    probing: scoreProbing(turnChecks),
    neutrality: scoreNeutrality(turnChecks),
    redundantQuestion: scoreRedundantQuestion(turnChecks),
    naturalness: scoreNaturalness(turnChecks, variety),
    clarity: scoreClarity(turnChecks),
    coverage: scoreCoverage(coverage),
    timeManagement: scoreTimeManagement(coverage),
  };

  // Weighted average over whichever dimensions actually produced a score --
  // a dimension with no applicable turns (score: null) is excluded rather
  // than treated as 0, and its weight is dropped from the denominator so
  // the overall score never gets silently deflated by a dimension that
  // simply didn't apply to this particular call.
  let weightedSum = 0;
  let weightSeen = 0;
  for (const d of Object.values(dimensionScores)) {
    if (d.score === null) continue;
    weightedSum += d.score * d.weight;
    weightSeen += d.weight;
  }
  const overallScore = weightSeen > 0 ? weightedSum / weightSeen : null;

  return {
    dimensionScores,
    overallScore,
    turnChecks,
    deterministicMetrics: { coverage, variety },
  };
}
