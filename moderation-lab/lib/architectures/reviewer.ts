/**
 * Baseline moderator, unchanged, plus one more thing: before the drafted
 * reply goes back to ElevenLabs, a second, fast pass reviews just the
 * question itself -- not the whole transcript, not tactical strategy, just
 * "is this short and conversational" -- and trims it if not.
 *
 * Built as a direct, evidence-based response to a real finding: isolating
 * the eval framework's compound-question flag on real calls showed a
 * systemic ~60% compound-question rate even on baseline (no advisors at
 * all) -- and telling the moderator about the problem via an advisory
 * nudge (livefanout's question-framing advisor) made it WORSE (78%), not
 * better, apparently because juggling multiple pieces of guidance pushed
 * the moderator to try to address them all in one utterance. This
 * architecture skips advising entirely and just edits the output directly
 * instead, so there's nothing for the moderator to "listen to" or ignore.
 *
 * Runs on Haiku, the fastest available model, since there's nothing to
 * reason about beyond "is this short and conversational" -- deliberately a
 * narrow, mechanical, low-latency pass, not another strategy call. Still a
 * second sequential call on the live turn's critical path (draft, then
 * review), so still real added latency versus baseline alone -- just one
 * call, not livefanout's four-call chain.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL, FAST_MODEL } from "@/lib/anthropic";
import { pacingNote } from "@/lib/pacing";
import { formatGuideForPrompt, type Guide } from "@/lib/guide";
import { logCallHealthEvent } from "@/lib/call-health";
import { logTurn } from "@/lib/logging";
import type { Architecture, ArchitectureRequest, ArchitectureResult, AnthropicMessage } from "./types";

function messageText(message: AnthropicMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

function moderatorSystemPrompt(guide: Guide): string {
  return `You are a warm, curious voice interviewer conducting a live qualitative research interview.

Study topic: ${guide.studyTopic}

Why this study exists (private context -- never say this out loud, but let it actually shape how hard you push on each question; a real business decision depends on getting real answers here, not just moving through the list):
${guide.researchObjective}

Guide (cover these in order, probing when an answer is vague, but don't read this list verbatim):
${formatGuideForPrompt(guide)}

When the guide is fully covered or time is up, deliver this closing line and then use the end_call tool: "${guide.closingScript}"

Keep responses short and conversational -- this is a live voice call, not a written exchange.`;
}

const REVIEW_SYSTEM_PROMPT = `You are a quick editor sitting between a voice interview moderator and the respondent. You'll be given what the respondent just said and the question the moderator drafted in reply. At your discretion, tighten the question to be shorter and more conversational -- trim a wordy or redundant acknowledgment, and collapse multiple bundled asks into the single most important one where that keeps the same intent.

For example, instead of "Interesting, why would you say that you did X, Y, and Z and not A, B, and C?" prefer something like "Why is that?"

If the draft is already short and conversational, leave it as is. This is a live voice call -- the result should sound like something a person would actually say out loud, not a written edit.`;

const REVIEW_TOOL: Anthropic.Tool = {
  name: "submit_review",
  description: "Return the final version of the moderator's question, edited or not.",
  input_schema: {
    type: "object",
    required: ["needsEdit", "revisedText"],
    properties: {
      needsEdit: { type: "boolean", description: "Whether the draft needed tightening at all." },
      revisedText: {
        type: "string",
        description:
          "The final text to actually speak -- the tightened version if needsEdit is true, or the original draft unchanged if false. Never include commentary, only the question/response itself.",
      },
    },
    additionalProperties: false,
  },
};

/** Reviews the moderator's own drafted reply and returns the final text to
 * actually speak. Falls back to the unedited draft on any failure -- a dead
 * review pass should never block the live turn, same resilience convention
 * as every other sub-call in this codebase. */
async function reviewDraft(req: ArchitectureRequest, draftText: string): Promise<string> {
  const lastRespondentMessage = req.messages[req.messages.length - 1]; // guaranteed user role
  const user = `Respondent just said: "${messageText(lastRespondentMessage)}"\n\nModerator drafted this reply: "${draftText}"`;
  const startedAt = Date.now();

  try {
    const completion = await anthropic().messages.create({
      model: FAST_MODEL,
      max_tokens: 300,
      thinking: { type: "disabled" },
      system: REVIEW_SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
      tools: [REVIEW_TOOL],
      tool_choice: { type: "tool", name: REVIEW_TOOL.name },
    });
    const block = completion.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const result = block?.input as { needsEdit?: boolean; revisedText?: string } | undefined;

    await logTurn({
      architecture: "reviewer",
      callType: "review",
      conversationFingerprint: req.fingerprint,
      model: FAST_MODEL,
      requestSystem: REVIEW_SYSTEM_PROMPT,
      requestMessages: [{ role: "user", content: user }],
      rawRequestBody: { system: REVIEW_SYSTEM_PROMPT, user },
      responseText: result?.revisedText ?? "",
      stopReason: completion.stop_reason,
      latencyMs: Date.now() - startedAt,
    });

    return result?.revisedText || draftText;
  } catch (err) {
    console.error("reviewer review call failed:", err);
    await logCallHealthEvent({
      eventType: "live_reasoning_failed",
      conversationFingerprint: req.fingerprint,
      architecture: "reviewer",
      detail: { callType: "review", error: err instanceof Error ? err.message : String(err) },
    });
    return draftText;
  }
}

export const reviewerArchitecture: Architecture = {
  name: "reviewer",
  kind: "custom",
  async run(req): Promise<ArchitectureResult> {
    const elapsedMinutes = (Date.now() - req.firstSeenAt.getTime()) / 60_000;
    const system = `${req.system}\n\n${moderatorSystemPrompt(req.guide)}\n\n${pacingNote(elapsedMinutes, req.guide.targetDurationMinutes)}`;

    const completion = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system,
      messages: req.messages,
      tools: req.tools.length ? req.tools : undefined,
    });

    const draftText = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const responseToolCalls = completion.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    // Nothing to review if the draft is pure tool use (e.g. closing the
    // call) with no spoken text.
    const responseText = draftText ? await reviewDraft(req, draftText) : draftText;

    return {
      responseText,
      responseToolCalls,
      stopReason: completion.stop_reason,
      nextState: req.state, // nothing to carry forward -- review is a per-turn, stateless edit pass
    };
  },
};
