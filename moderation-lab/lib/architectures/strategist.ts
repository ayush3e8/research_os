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
import { formatGuideForPrompt, type Guide } from "@/lib/guide";
import { updateConversationState } from "@/lib/conversation-state";
import { logCallHealthEvent } from "@/lib/call-health";
import { logTurn } from "@/lib/logging";
import type { Architecture, ArchitectureRequest, ArchitectureResult, AnthropicMessage } from "./types";

const DEFAULT_GUIDANCE =
  "No guidance yet -- this is the opening turn, just follow the guide in its natural order.";

function moderatorSystemPrompt(guide: Guide, guidance: string): string {
  return `You are a warm, curious voice interviewer conducting a live qualitative research interview.

Study topic: ${guide.studyTopic}

Why this study exists (private context -- never say this out loud, but let it actually shape how hard you push on each question; a real business decision depends on getting real answers here, not just moving through the list):
${guide.researchObjective}

Guide (cover these in order, probing when an answer is vague, but don't read this list verbatim):
${formatGuideForPrompt(guide)}

Tactical guidance from a strategist call that reviewed the conversation so far against the objective above (private analysis for your reasoning only -- it's one turn behind live, so weigh it but trust your own read of what the respondent just said if the conversation has since moved on):
${guidance}

That guidance is a note TO you, not a line FOR you -- never read it, quote it, or paraphrase its wording back to the respondent, even in part. Decide what it means for your next turn, then say something in your own natural voice as if you'd thought of it yourself. If you catch yourself about to speak a sentence that sounds like an instruction ("push for...", "confirm that...", "get them to...", "ask them..."), stop -- that's the guidance leaking through, not a real question.

When the guide is fully covered or time is up, deliver this closing line and then use the end_call tool: "${guide.closingScript}"

Keep responses short and conversational -- this is a live voice call, not a written exchange.`;
}

function strategistSystemPrompt(guide: Guide): string {
  return `You are a silent research-strategy advisor sitting in on a live qualitative interview. You never speak to the respondent -- you only brief the moderator for its *next* turn.

Study topic: ${guide.studyTopic}

The real business decision this study exists to inform (private -- the respondent is never told this, but it's what your guidance should actually be optimizing for):
${guide.researchObjective}

Guide:
${formatGuideForPrompt(guide)}

Read the transcript so far and write 1-3 short sentences of concrete analysis for the moderator's next turn -- what the last answer left vague relative to the objective, and exactly where to push, or that it's genuinely time to move on. Reference specifics from what was actually just said; generic advice ("probe deeper") is not useful.

Write it as analysis of the situation, never as a command or a line to say -- describe the gap, don't script the question. "The respondent gave a vague time estimate without a concrete example" is right; "Ask them for a specific example of when this happened" is wrong, because the moderator has been echoing instructions phrased like that almost verbatim to the respondent instead of using them silently -- confirmed against real transcripts where this is happening on nearly every turn. Never write in second person ("you should...", "push them to...", "confirm that...") and never include a suggested quote or question for the moderator to say. Output only the analysis itself, nothing else.`;
}

/** Runs after the response is already on its way out -- see module
 * docstring for why this writes state itself instead of returning it.
 * Brackets itself with call_health_events (background_reasoning_started /
 * _failed) purely for diagnosability -- a real test call showed zero
 * strategist-callType turn_logs rows with no visible error anywhere (no
 * Vercel log access in this environment), so whether after() even invokes
 * this at all was otherwise unverifiable. */
async function runStrategistCall(req: ArchitectureRequest, moderatorReply: string): Promise<void> {
  const startedAt = Date.now();
  // Trailing user turn is required, not decorative -- ending the list on the
  // appended assistant message (the moderator's own reply) gets a real 400
  // from Claude ("model does not support assistant message prefill"),
  // confirmed against every one of the first 23 real background-call
  // attempts once after() itself started actually firing.
  const transcript: AnthropicMessage[] = [
    ...req.messages,
    { role: "assistant", content: moderatorReply },
    { role: "user", content: "Respond now, per the instructions above." },
  ];
  const system = strategistSystemPrompt(req.guide);

  await logCallHealthEvent({
    eventType: "background_reasoning_started",
    conversationFingerprint: req.fingerprint,
    architecture: "strategist",
  });

  try {
    const completion = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 256,
      thinking: { type: "disabled" },
      system,
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
      requestSystem: system,
      requestMessages: transcript,
      rawRequestBody: { system, messages: transcript },
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
    // Still logged (not just console.error, which this environment can't
    // see) so a failure here is diagnosable rather than invisible.
    console.error("strategist background call failed:", err);
    await logCallHealthEvent({
      eventType: "background_reasoning_failed",
      conversationFingerprint: req.fingerprint,
      architecture: "strategist",
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
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
    const system = `${req.system}\n\n${moderatorSystemPrompt(req.guide, guidance)}\n\n${pacingNote(elapsedMinutes, req.guide.targetDurationMinutes)}`;

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
