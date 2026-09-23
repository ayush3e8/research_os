/**
 * The one place "run a single architecture turn and persist everything
 * about it" lives -- extracted out of the real webhook route
 * (app/api/architectures/[name]/[guide]/chat/completions/route.ts) so
 * lib/simulation's text-only driver calls the *exact same* code a real
 * ElevenLabs call does, not a hand-maintained copy of it that can drift.
 * That parity is the whole point of the simulation harness (see
 * simulationBatches' docstring in db/schema.ts): "identical to a real call
 * except for the spoken components" is only true if this function is the
 * one thing both paths share.
 *
 * Deliberately NOT included here, on purpose: ElevenLabs' turn-dedup
 * (claimTurn/waitForTurnResult/recordTurnResult) and the OpenAI<->Anthropic
 * wire translation. Both are about receiving a turn from ElevenLabs, not
 * about running one -- the real route still owns them, calling this only
 * once it has a single, de-duplicated, already-translated turn in hand. A
 * simulation has no duplicate-delivery problem at all (it's the sole
 * source of every turn it drives) and works in Anthropic's native
 * message/tool shape directly, so neither concern applies to it.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getArchitecture } from "@/lib/architectures/registry";
import type { AnthropicMessage } from "@/lib/architectures/types";
import { getOrInitConversation, updateConversationState } from "@/lib/conversation-state";
import { logCallHealthEvent } from "@/lib/call-health";
import { logTurn } from "@/lib/logging";
import { getGuide } from "@/lib/guide";
import { MODEL } from "@/lib/anthropic";

export type TurnRunInput = {
  architectureName: string;
  guideName: string;
  conversationFingerprint: string;
  system: string;
  messages: AnthropicMessage[];
  tools: Anthropic.Tool[];
  /** Stored verbatim in turn_logs.raw_request_body -- callers pass
   * whatever's meaningful for them (the real route passes ElevenLabs' raw
   * JSON body; the simulation driver passes a small descriptive object
   * since there is no real inbound request to capture). */
  rawRequestBody: unknown;
  /** Bootstrap-only, see getOrInitConversation's docstring. Ignored once
   * the conversation's first row already exists. */
  isSimulation?: boolean;
};

export type TurnRunResult = {
  responseText: string;
  responseToolCalls: { id: string; name: string; input: unknown }[];
  stopReason: string | null;
  /** True if architecture.run() threw and this is the canned fallback
   * reply -- callers that care about run health (the simulation driver,
   * deciding whether to keep going) can check this instead of re-deriving
   * it from stopReason === "error". */
  fallback: boolean;
};

/** Throws only for genuinely unrecoverable setup problems (unknown
 * architecture/guide) -- a failure *inside* the architecture's own run()
 * is caught and turned into the same canned-fallback response the real
 * webhook has always returned, never an exception out of this function. */
export async function runArchitectureTurn(input: TurnRunInput): Promise<TurnRunResult> {
  const architecture = getArchitecture(input.architectureName);
  if (!architecture || architecture.kind !== "custom" || !architecture.run) {
    throw new Error(`Unknown or non-custom architecture: ${input.architectureName}`);
  }
  const guide = getGuide(input.guideName);
  if (!guide) {
    throw new Error(`Unknown guide: ${input.guideName}`);
  }

  const requestStartedAt = Date.now();
  const conversation = await getOrInitConversation(
    input.conversationFingerprint,
    input.architectureName,
    input.guideName,
    input.isSimulation ?? false
  );

  try {
    const result = await architecture.run({
      fingerprint: input.conversationFingerprint,
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      firstSeenAt: conversation.firstSeenAt,
      state: conversation.state,
      guide,
    });

    await updateConversationState(input.conversationFingerprint, result.nextState);
    await logTurn({
      architecture: input.architectureName,
      conversationFingerprint: input.conversationFingerprint,
      model: MODEL,
      requestSystem: input.system,
      requestMessages: input.messages,
      requestTools: input.tools,
      rawRequestBody: input.rawRequestBody,
      responseText: result.responseText,
      responseToolCalls: result.responseToolCalls,
      stopReason: result.stopReason,
      latencyMs: Date.now() - requestStartedAt,
    });

    return {
      responseText: result.responseText,
      responseToolCalls: result.responseToolCalls,
      stopReason: result.stopReason,
      fallback: false,
    };
  } catch (err) {
    console.error(`architecture "${input.architectureName}" run() failed:`, err);
    const fallbackText = "Sorry, could you say that again?";
    const errorMessage = err instanceof Error ? err.message : String(err);
    await logTurn({
      architecture: input.architectureName,
      callType: "moderator",
      conversationFingerprint: input.conversationFingerprint,
      model: MODEL,
      requestSystem: input.system,
      requestMessages: input.messages,
      requestTools: input.tools,
      rawRequestBody: input.rawRequestBody,
      responseText: fallbackText,
      responseToolCalls: [],
      stopReason: "error",
      latencyMs: Date.now() - requestStartedAt,
    });
    await logCallHealthEvent({
      eventType: "fallback",
      conversationFingerprint: input.conversationFingerprint,
      architecture: input.architectureName,
      detail: { error: errorMessage },
    });
    return { responseText: fallbackText, responseToolCalls: [], stopReason: "error", fallback: true };
  }
}
