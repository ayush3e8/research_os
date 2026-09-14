export type CheckType =
  | "neutrality"
  | "clarity"
  | "tone"
  | "depthProbe"
  | "threadPull"
  | "redundantQuestion";

export type TurnCheckRecord = {
  checkType: CheckType;
  turnIndex: number;
  quote: string;
  malformed: boolean;
  result: Record<string, unknown>;
};

export type DimensionScore = {
  /** 0-1, always -- weighting and display formatting happen elsewhere. */
  score: number | null;
  weight: number;
  /** Supporting counts the score was computed from -- e.g. {good: 4, bad: 1,
   * none: 2}. Kept so a score is always traceable to its inputs. */
  detail: Record<string, unknown>;
};

export type EvaluationOutput = {
  dimensionScores: Record<string, DimensionScore>;
  overallScore: number | null;
  turnChecks: TurnCheckRecord[];
  deterministicMetrics: Record<string, unknown>;
};
