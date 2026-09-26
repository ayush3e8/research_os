/**
 * Every architecture's respondent-facing moderator call goes through this
 * instead of a bare `anthropic().messages.create()` -- an empty completion
 * (Claude legitimately returning `stop_reason: "end_turn"` with no text and
 * no tool_use at all) is not hypothetical: the archived pharma-research
 * project this app is descended from hit it in production, and this
 * session reproduced it directly (a real simulation run went dead mid-
 * conversation on exactly this). ElevenLabs treats an empty response as a
 * dead stream and kills the call outright -- unlike a background advisor
 * call, which can safely fail open to a default guidance string, there is
 * no safe "just skip it" here.
 *
 * Retries once (a second sampling of the identical request is usually
 * enough -- this is a rare, not systematic, failure mode), then falls back
 * to a fixed, safe spoken line rather than ever returning nothing.
 * Deliberately does NOT retry an actual thrown error (network failure,
 * rate limit, etc.) -- that's each architecture's own existing concern via
 * lib/turn-runner.ts's outer catch, which already turns a thrown error into
 * the same canned fallback text. This only covers the narrower case of a
 * technically-successful call with nothing usable in it.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { logCallHealthEvent } from "./call-health";

export type ModeratorCallResult = {
  responseText: string;
  responseToolCalls: { id: string; name: string; input: unknown }[];
  stopReason: string | null;
};

const FALLBACK_TEXT = "Sorry, could you say that again?";

function extractContent(completion: Anthropic.Message) {
  const responseText = completion.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const responseToolCalls = completion.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  return { responseText, responseToolCalls };
}

function isEmpty(responseText: string, responseToolCalls: { id: string; name: string; input: unknown }[]): boolean {
  return !responseText.trim() && responseToolCalls.length === 0;
}

export async function callModeratorLLM(
  architecture: string,
  conversationFingerprint: string,
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<ModeratorCallResult> {
  let completion = await anthropic().messages.create(params);
  let extracted = extractContent(completion);

  if (isEmpty(extracted.responseText, extracted.responseToolCalls)) {
    completion = await anthropic().messages.create(params);
    extracted = extractContent(completion);
  }

  if (isEmpty(extracted.responseText, extracted.responseToolCalls)) {
    await logCallHealthEvent({
      eventType: "empty_completion_fallback",
      conversationFingerprint,
      architecture,
    });
    return { responseText: FALLBACK_TEXT, responseToolCalls: [], stopReason: "empty_completion_fallback" };
  }

  return { ...extracted, stopReason: completion.stop_reason };
}
