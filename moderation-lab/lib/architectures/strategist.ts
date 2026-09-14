/**
 * Moderator + strategist: the moderator call itself is baseline's call
 * (one Claude call, responds to the respondent) plus one addition -- it
 * folds in tactical guidance for *this* turn that a second "strategist"
 * Claude call already worked out on a *previous* turn, by reasoning about
 * the transcript so far against the private researchObjective (not just
 * the guide's fixed question order).
 *
 * The critical constraint: that reasoning call must never make the
 * respondent wait. So the strategist call that produces guidance for the
 * *next* turn is kicked off with next/server's `after()` -- which Next.js
 * only actually runs once the response has been sent, not awaited inline
 * here -- right after the moderator's reply is already decided. Turn N's
 * moderator therefore always acts on guidance that's one turn stale (or
 * the empty-default below, on turn 1); that's the deliberate trade for
 * zero added latency, not an oversight.
 *
 * One consequence of that ordering worth being explicit about: route.ts
 * writes `result.nextState` to conversation_state synchronously, before
 * the response is even sent -- well before this architecture's after()
 * callback has anything new to say. So this returns `nextState` unchanged
 * from run() (nothing new to carry forward *yet*) and instead has the
 * after() callback call updateConversationState itself, directly, once
 * the strategist call actually finishes. Doing it any other way (e.g.
 * trying to hand the eventual guidance back through run()'s return value)
 * isn't possible -- run() has already returned by the time it exists.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { pacingNote } from "@/lib/pacing";
import { ACTIVE_GUIDE, formatGuideForPrompt } from "@/lib/guide";
import { updateConversationState } from "@/lib/conversation-state";
import { logTurn } from "@/lib/logging";
import type { Architecture, ArchitectureRequest, ArchitectureResult, AnthropicMessage } from "./types";

const DEFAULT_GUIDANCE =
  "No guidance yet -- this is the opening turn, just follow the guide in its natural order.";

function moderatorSystemPrompt(guidance: string): string {
  return `You are a warm, curious voice interviewer conducting a live qualitative research interview.

Study topic: ${ACTIVE_GUIDE.studyTopic}

Why this study exists (private context -- never say this out loud, but let it actually shape how hard you push on each question; a real business decision depends on getting real answers here, not just moving through the list):
${ACTIVE_GUIDE.researchObjective}

Guide (cover these in order, probing when an answer is vague, but don't read this list verbatim):
${formatGuideForPrompt(ACTIVE_GUIDE)}

Tactical guidance from a strategist call that reviewed the conversation so far against the objective above (private, never spoken -- it's one turn behind live, so weigh it but trust your own read of what the respondent just said if the conversation has since moved on):
${guidance}

When the guide is fully covered or time is up, deliver this closing line and then use the end_call tool: "${ACTIVE_GUIDE.closingScript}"

Keep responses short and conversational -- this is a live voice call, not a written exchange.`;
}

const STRATEGIST_SYSTEM_PROMPT = `You are a silent research-strategy advisor sitting in on a live qualitative interview. You never speak to the respondent -- you only brief the moderator for its *next* turn.

Study topic: ${ACTIVE_GUIDE.studyTopic}

The real business decision this study exists to inform (private -- the respondent is never told this, but it's what your guidance should actually be optimizing for):
${ACTIVE_GUIDE.researchObjective}

Guide:
${formatGuideForPrompt(ACTIVE_GUIDE)}

Read the transcript so far and write 1-3 short sentences of concrete, tactical guidance for the moderator's next turn -- what the last answer left vague relative to the objective, exactly where to push, or that it's genuinely time to move on. Reference specifics from what was actually just said; generic advice ("probe deeper") is not useful. Output only the guidance itself, nothing else.`;

/** Runs after the response is already on its way out -- see module
 * docstring for why this writes state itself instead of returning it. */
async function runStrategistCall(req: ArchitectureRequest, moderatorReply: string): Promise<void> {
  const startedAt = Date.now();
  const transcript: AnthropicMessage[] = [...req.messages, { role: "assistant", content: moderatorReply }];

  try {
    const completion = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 256,
      thinking: { type: "disabled" },
      system: STRATEGIST_SYSTEM_PROMPT,
      messages: transcript,
    });
    const guidance = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    await logTurn({
      architecture: "strategist",
      callType: "strategist",
      conversationFingerprint: req.fingerprint,
      model: MODEL,
      requestSystem: STRATEGIST_SYSTEM_PROMPT,
      requestMessages: transcript,
      rawRequestBody: { system: STRATEGIST_SYSTEM_PROMPT, messages: transcript },
      responseText: guidance,
      stopReason: completion.stop_reason,
      latencyMs: Date.now() - startedAt,
    });

    if (guidance) {
      await updateConversationState(req.fingerprint, { ...req.state, strategistGuidance: guidance });
    }
  } catch (err) {
    // A background reasoning call failing should never surface anywhere --
    // worst case the next turn just reuses whatever guidance came before.
    console.error("strategist background call failed:", err);
  }
}

export const strategistArchitecture: Architecture = {
  name: "strategist",
  kind: "custom",
  async run(req): Promise<ArchitectureResult> {
    const elapsedMinutes = (Date.now() - req.firstSeenAt.getTime()) / 60_000;
    const guidance =
      typeof req.state.strategistGuidance === "string" && req.state.strategistGuidance
        ? req.state.strategistGuidance
        : DEFAULT_GUIDANCE;
    const system = `${req.system}\n\n${moderatorSystemPrompt(guidance)}\n\n${pacingNote(elapsedMinutes, ACTIVE_GUIDE.targetDurationMinutes)}`;

    const completion = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system,
      messages: req.messages,
      tools: req.tools.length ? req.tools : undefined,
    });

    const responseText = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const responseToolCalls = completion.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    // Scheduled for after the response is sent -- never awaited on the
    // respondent's turn. See module docstring.
    after(() => runStrategistCall(req, responseText));

    return {
      responseText,
      responseToolCalls,
      stopReason: completion.stop_reason,
      nextState: req.state, // unchanged here -- runStrategistCall above writes the real update itself, later
    };
  },
};
