/**
 * Orchestrates one full evaluation: reconstruct the transcript, fire every
 * gated per-turn check concurrently, compute the deterministic metrics,
 * aggregate, and persist. Meant to be triggered once per completed call
 * (see app/page.tsx's onDisconnect) -- not a batch/offline job.
 *
 * A real interview can have enough turns that every applicable check
 * (several per turn) doesn't finish inside one serverless invocation's time
 * budget. Rather than let that either time out ungracefully or block
 * forever, this tracks a soft deadline: checks already in flight finish,
 * but no new ones start past it, and the evaluation is saved as "complete"
 * with whatever finished (flagged as truncated) rather than stuck at
 * "running" indefinitely. This mirrors the resilience lesson from the
 * reliability experiments -- a timeout should never lose completed work.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { evaluations } from "@/db/schema";
import { ACTIVE_GUIDE } from "@/lib/guide";
import {
  checkClarity,
  checkDepthProbe,
  checkNeutrality,
  checkRedundantQuestion,
  checkThreadPull,
  checkTone,
} from "./checks";
import { computeCoverageAndTime, computeNaturalnessVariety } from "./deterministic";
import { nearVerbatimGuideQuestion } from "./guide-match";
import { loadTranscript, type ReconstructedTurn } from "./transcript";
import { aggregateEvaluation } from "./aggregate";
import type { TurnCheckRecord } from "./types";

const CONCURRENCY = 16;
const SOFT_BUDGET_MS = 50_000;

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Tasks are built in transcript order, so if the time budget runs out
 * before they all finish, an unshuffled run would always keep the call's
 * first half fully checked and drop its second half -- every long call
 * would be systematically under-evaluated toward its end. Shuffling first
 * means a truncation (if it happens at all) drops roughly evenly across
 * turns and check types instead of always the same tail. */
async function runWithBudget(tasks: (() => Promise<TurnCheckRecord | null>)[]): Promise<{
  records: TurnCheckRecord[];
  truncated: boolean;
}> {
  const ordered = shuffle(tasks);
  const deadline = Date.now() + SOFT_BUDGET_MS;
  const records: TurnCheckRecord[] = [];
  let next = 0;
  async function worker() {
    while (next < ordered.length && Date.now() < deadline) {
      const i = next++;
      const r = await ordered[i]();
      if (r) records.push(r);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { records, truncated: next < ordered.length };
}

export async function runEvaluation(conversationFingerprint: string): Promise<string | null> {
  const loaded = await loadTranscript(conversationFingerprint);
  if (!loaded || loaded.turns.length === 0) return null;

  const [row] = await db
    .insert(evaluations)
    .values({ conversationFingerprint, architecture: loaded.architecture, status: "running" })
    .returning();

  try {
    const { turns } = loaded;
    const guide = ACTIVE_GUIDE;
    const tasks: (() => Promise<TurnCheckRecord | null>)[] = [];

    // Running "everything the respondent has said so far" for the
    // redundant-question check -- bounded to respondent-only text, not the
    // full back-and-forth, per the design decision to keep this affordable.
    let priorRespondentAnswers = "";

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (turn.role === "respondent") {
        const nextModerator = turns.slice(i + 1).find((t) => t.role === "moderator");
        // Depth-probe: local exchange only.
        if (nextModerator) {
          tasks.push(async () => {
            const result = await checkDepthProbe(turn.text, nextModerator.text);
            return result
              ? { checkType: "depthProbe", turnIndex: turn.index, quote: nextModerator.text, malformed: false, result }
              : { checkType: "depthProbe", turnIndex: turn.index, quote: nextModerator.text, malformed: true, result: {} };
          });
        }
        // Thread-pull: respondent turn + next 1-2 moderator turns.
        const lookahead = turns.slice(i + 1).filter((t) => t.role === "moderator").slice(0, 2);
        if (lookahead.length > 0) {
          tasks.push(async () => {
            const result = await checkThreadPull(
              turn.text,
              lookahead.map((t) => t.text),
              guide.researchObjective
            );
            return result
              ? { checkType: "threadPull", turnIndex: turn.index, quote: turn.text, malformed: false, result }
              : { checkType: "threadPull", turnIndex: turn.index, quote: turn.text, malformed: true, result: {} };
          });
        }
        priorRespondentAnswers += (priorRespondentAnswers ? "\n" : "") + turn.text;
        continue;
      }

      // Moderator turn.
      const priorRespondent = [...turns.slice(0, i)].reverse().find((t) => t.role === "respondent")?.text ?? null;
      const isFirstTurn = i === 0;

      if (!isFirstTurn) {
        const isVerbatim = nearVerbatimGuideQuestion(turn.text, guide) !== null;
        tasks.push(async () => {
          const result = await checkNeutrality(priorRespondent, turn.text);
          const withVerbatim = result ? { ...result, isVerbatimGuideText: isVerbatim } : null;
          return withVerbatim
            ? { checkType: "neutrality", turnIndex: turn.index, quote: turn.text, malformed: false, result: withVerbatim }
            : { checkType: "neutrality", turnIndex: turn.index, quote: turn.text, malformed: true, result: {} };
        });
        tasks.push(async () => {
          const result = await checkClarity(priorRespondent, turn.text);
          return result
            ? { checkType: "clarity", turnIndex: turn.index, quote: turn.text, malformed: false, result }
            : { checkType: "clarity", turnIndex: turn.index, quote: turn.text, malformed: true, result: {} };
        });
        tasks.push(async () => {
          const result = await checkTone(priorRespondent, turn.text);
          return result
            ? { checkType: "tone", turnIndex: turn.index, quote: turn.text, malformed: false, result }
            : { checkType: "tone", turnIndex: turn.index, quote: turn.text, malformed: true, result: {} };
        });
      }

      // Redundant-question check: gated to only fire when the moderator is
      // about to ask something guide-shaped, and only once there's prior
      // respondent history to check against.
      const matchedGuideQuestion = nearVerbatimGuideQuestion(turn.text, guide);
      if (matchedGuideQuestion && priorRespondentAnswers) {
        const answersSoFar = priorRespondentAnswers;
        tasks.push(async () => {
          const result = await checkRedundantQuestion(answersSoFar, turn.text);
          return result
            ? { checkType: "redundantQuestion", turnIndex: turn.index, quote: turn.text, malformed: false, result }
            : { checkType: "redundantQuestion", turnIndex: turn.index, quote: turn.text, malformed: true, result: {} };
        });
      }
    }

    const { records, truncated } = await runWithBudget(tasks);

    const moderatorTexts = turns.filter((t) => t.role === "moderator").map((t) => t.text);
    const variety = computeNaturalnessVariety(moderatorTexts);
    const coverage = computeCoverageAndTime(turns, guide);

    const output = aggregateEvaluation(records, coverage, variety);
    if (truncated) {
      output.deterministicMetrics.truncated = true;
      output.deterministicMetrics.tasksPlanned = tasks.length;
      output.deterministicMetrics.tasksCompleted = records.length;
    }

    await db
      .update(evaluations)
      .set({
        status: "complete",
        dimensionScores: output.dimensionScores,
        overallScore: output.overallScore,
        turnChecks: output.turnChecks,
        deterministicMetrics: output.deterministicMetrics,
        completedAt: new Date(),
      })
      .where(eq(evaluations.id, row.id));

    return row.id;
  } catch (err) {
    console.error("runEvaluation failed:", err);
    await db
      .update(evaluations)
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err), completedAt: new Date() })
      .where(eq(evaluations.id, row.id));
    return row.id;
  }
}

// Re-exported so callers that only need the shape don't reach into
// transcript.ts directly.
export type { ReconstructedTurn };
