/**
 * Advances one lib/simulation run by one respondent-visible turn. Called
 * repeatedly (see the step API route) until the run reports done -- each
 * call is a short, bounded unit of work rather than one long-running
 * request, since a full simulated interview is 30-80+ sequential Claude
 * calls and would blow well past any serverless function's timeout if run
 * in one shot.
 *
 * "One turn" absorbs any number of tool round-trips internally (a
 * moderator tool call doesn't consume a respondent turn in a real call
 * either -- ElevenLabs relays the result and calls the moderator again
 * immediately) so callers never need to understand that mechanic; a step
 * either produces exactly one new respondent line, or ends the run.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { simulationRuns, simulationBatches, personas } from "@/db/schema";
import { getArchitecture } from "@/lib/architectures/registry";
import type { AnthropicMessage } from "@/lib/architectures/types";
import { getGuide } from "@/lib/guide";
import { runArchitectureTurn } from "@/lib/turn-runner";
import { buildToolsForArchitecture, fabricateToolResult } from "./tools";
import { generateRespondentTurn } from "./respondent";
import { ELEVENLABS_BOILERPLATE_SYSTEM } from "./constants";

const MAX_TOOL_ROUNDS_PER_STEP = 5;

export type StepResult = {
  status: "running" | "done" | "failed";
  endReason: string | null;
  turnCount: number;
};

async function loadRunContext(runId: string) {
  const [run] = await db.select().from(simulationRuns).where(eq(simulationRuns.id, runId));
  if (!run) throw new Error(`simulation run not found: ${runId}`);
  const [batch] = await db.select().from(simulationBatches).where(eq(simulationBatches.id, run.batchId));
  if (!batch) throw new Error(`simulation batch not found: ${run.batchId}`);
  const [persona] = await db.select().from(personas).where(eq(personas.id, run.personaId));
  if (!persona) throw new Error(`persona not found: ${run.personaId}`);
  const architecture = getArchitecture(run.architecture);
  if (!architecture || architecture.kind !== "custom" || !architecture.run) {
    throw new Error(`Unknown or non-custom architecture: ${run.architecture}`);
  }
  const guide = getGuide(run.guide);
  if (!guide) throw new Error(`Unknown guide: ${run.guide}`);
  return { run, batch, persona, architecture, guide };
}

async function persist(runId: string, fields: Partial<typeof simulationRuns.$inferInsert>) {
  await db.update(simulationRuns).set(fields).where(eq(simulationRuns.id, runId));
}

export async function advanceSimulationRun(runId: string): Promise<StepResult> {
  const { run, batch, persona, architecture, guide } = await loadRunContext(runId);

  if (run.status === "done" || run.status === "failed") {
    return { status: run.status as "done" | "failed", endReason: run.endReason, turnCount: run.turnCount };
  }

  let transcript = (run.transcript as AnthropicMessage[]) ?? [];
  const isFirstStep = run.status === "pending";
  if (isFirstStep) {
    await persist(runId, { status: "running", startedAt: new Date() });
  }

  try {
    // Turn zero: the literal opening line, spoken before any moderator LLM
    // call ever runs in a real call too (see provision route / each
    // architecture's firstMessageOverride) -- then the respondent's first
    // reply to it, exactly mirroring how a real call's very first
    // moderator turn only fires once the respondent has already spoken.
    if (transcript.length === 0) {
      const opening = architecture.firstMessageOverride ?? guide.openingScript;
      transcript = [{ role: "assistant", content: opening }];
      const firstReply = await generateRespondentTurn(persona.systemPrompt, guide, transcript);
      transcript = [...transcript, { role: "user", content: firstReply }];
    }

    const tools = buildToolsForArchitecture(architecture);
    let toolRounds = 0;
    let sawEndCall = false;

    while (true) {
      const result = await runArchitectureTurn({
        architectureName: run.architecture,
        guideName: run.guide,
        conversationFingerprint: run.conversationFingerprint,
        system: ELEVENLABS_BOILERPLATE_SYSTEM,
        messages: transcript,
        tools,
        rawRequestBody: { simulated: true, runId, batchId: run.batchId },
        isSimulation: true,
      });

      const assistantContent: Anthropic.ContentBlockParam[] = [];
      if (result.responseText) assistantContent.push({ type: "text", text: result.responseText });
      for (const tc of result.responseToolCalls) {
        assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input as Record<string, unknown> });
      }
      transcript = [...transcript, { role: "assistant", content: assistantContent }];

      const endCallCall = result.responseToolCalls.find((tc) => tc.name === "end_call");
      if (endCallCall || result.fallback) {
        sawEndCall = !!endCallCall;
        break;
      }
      const otherToolCalls = result.responseToolCalls.filter((tc) => tc.name !== "end_call");
      if (otherToolCalls.length === 0) break;

      toolRounds++;
      if (toolRounds > MAX_TOOL_ROUNDS_PER_STEP) {
        // A real call would never loop on tool calls without ElevenLabs
        // eventually forcing a spoken turn -- this is a defensive guard
        // against a genuinely runaway architecture, not expected behavior.
        break;
      }
      const toolResultBlocks: Anthropic.ContentBlockParam[] = otherToolCalls.map((tc) => ({
        type: "tool_result",
        tool_use_id: tc.id,
        content: fabricateToolResult(tc.name),
      }));
      transcript = [...transcript, { role: "user", content: toolResultBlocks }];
      // loop: call the moderator again immediately, same as a real client
      // relaying the tool result -- no respondent turn in between.
    }

    if (sawEndCall) {
      await persist(runId, {
        transcript,
        turnCount: run.turnCount + 1,
        status: "done",
        endReason: "end_call",
        endedAt: new Date(),
      });
      return { status: "done", endReason: "end_call", turnCount: run.turnCount + 1 };
    }

    const nextTurnCount = run.turnCount + 1;
    if (nextTurnCount >= batch.maxTurns) {
      await persist(runId, { transcript, turnCount: nextTurnCount, status: "done", endReason: "max_turns", endedAt: new Date() });
      return { status: "done", endReason: "max_turns", turnCount: nextTurnCount };
    }

    const respondentReply = await generateRespondentTurn(persona.systemPrompt, guide, transcript);
    transcript = [...transcript, { role: "user", content: respondentReply }];

    await persist(runId, { transcript, turnCount: nextTurnCount, status: "running" });
    return { status: "running", endReason: null, turnCount: nextTurnCount };
  } catch (err) {
    console.error(`simulation run ${runId} failed:`, err);
    await persist(runId, {
      transcript,
      status: "failed",
      endReason: "error",
      endedAt: new Date(),
    });
    return { status: "failed", endReason: "error", turnCount: run.turnCount };
  }
}
