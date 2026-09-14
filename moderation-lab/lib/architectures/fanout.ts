/**
 * Same non-blocking background-reasoning shape as strategist.ts (see that
 * file's docstring for why guidance is a turn stale, why it writes state
 * itself from inside after() instead of returning it, etc.) but with the
 * single generalist strategist call replaced by three parallel specialist
 * advisor calls -- probing opportunities, objective-coverage, and pacing --
 * followed by a lightweight synthesis call that reconciles them into the
 * guidance actually stored for the next turn. The idea being that one
 * generalist call reasoning about three different concerns at once is
 * more likely to only really attend to one of them, where three narrow
 * calls each reliably attend to their own.
 *
 * The moderator call itself is otherwise identical to baseline/strategist:
 * one Claude call, responds to the respondent, uses whatever fan-out
 * guidance a *previous* turn already produced (or the empty default on
 * turn 1).
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

Tactical guidance synthesized by a panel of specialist advisors that reviewed the conversation so far (private, never spoken -- it's one turn behind live, so weigh it but trust your own read of what the respondent just said if the conversation has since moved on):
${guidance}

When the guide is fully covered or time is up, deliver this closing line and then use the end_call tool: "${ACTIVE_GUIDE.closingScript}"

Keep responses short and conversational -- this is a live voice call, not a written exchange.`;
}

const PROBING_SYSTEM_PROMPT = `You are a silent probing-opportunities advisor sitting in on a live qualitative interview. You never speak to the respondent.

Study topic: ${ACTIVE_GUIDE.studyTopic}

Look only at the most recent respondent answer(s) in the transcript. Flag anything vague, surprising, evasive, or interesting that's worth the moderator probing harder on next turn, quoting or referencing the specific thing that was said. If the last answer was already concrete and complete, say so plainly rather than inventing something to probe. 1-2 short sentences. Output only that, nothing else.`;

const COVERAGE_SYSTEM_PROMPT = `You are a silent objective-coverage advisor sitting in on a live qualitative interview. You never speak to the respondent.

Study topic: ${ACTIVE_GUIDE.studyTopic}

The real business decision this study exists to inform (private -- the respondent is never told this):
${ACTIVE_GUIDE.researchObjective}

Guide:
${formatGuideForPrompt(ACTIVE_GUIDE)}

Judge the transcript so far against the objective above: which of its specific questions have actually been resolved with a real answer versus just touched on or still open. 1-2 short sentences naming what's still genuinely missing, if anything. Output only that, nothing else.`;

const PACING_SYSTEM_PROMPT = `You are a silent pacing advisor sitting in on a live qualitative interview. You never speak to the respondent.

Guide, in order:
${formatGuideForPrompt(ACTIVE_GUIDE)}

You'll be given a computed, deterministic pacing note (elapsed vs. target time -- trust that arithmetic, don't recompute or second-guess it). Given where the transcript actually is in the guide and how much time is realistically left, say which of the *remaining* guide topics matter most to still hit and which are safe to compress or skip. 1-2 short sentences. Output only that, nothing else.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are a silent synthesis advisor for a live qualitative interview. You never speak to the respondent.

You'll be given three specialist advisors' notes on the same conversation: one on probing opportunities, one on objective-coverage, one on pacing. Combine them into 1-3 short sentences of concrete tactical guidance for the moderator's *next* turn -- resolve any tension between them (e.g. pacing says move on, probing says push harder) into one clear instruction rather than just listing all three. Output only the guidance itself, nothing else.`;

/** One specialist (or the synthesis) call: runs it, logs it under its own
 * callType so each is comparable in turn_logs, and swallows failures so
 * one dead advisor doesn't take the others down with it. */
async function runAdvisorCall(args: {
  callType: string;
  conversationFingerprint: string;
  system: string;
  messages: AnthropicMessage[];
}): Promise<string> {
  const startedAt = Date.now();
  try {
    const completion = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 256,
      thinking: { type: "disabled" },
      system: args.system,
      messages: args.messages,
    });
    const text = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    await logTurn({
      architecture: "fanout",
      callType: args.callType,
      conversationFingerprint: args.conversationFingerprint,
      model: MODEL,
      requestSystem: args.system,
      requestMessages: args.messages,
      rawRequestBody: { system: args.system, messages: args.messages },
      responseText: text,
      stopReason: completion.stop_reason,
      latencyMs: Date.now() - startedAt,
    });

    return text;
  } catch (err) {
    console.error(`fanout advisor call "${args.callType}" failed:`, err);
    return "";
  }
}

/** Runs after the response is already on its way out -- see the module
 * docstring (and strategist.ts's) for why this writes state itself rather
 * than returning it from run(). */
async function runFanoutReasoning(req: ArchitectureRequest, moderatorReply: string): Promise<void> {
  const transcript: AnthropicMessage[] = [...req.messages, { role: "assistant", content: moderatorReply }];
  const elapsedMinutes = (Date.now() - req.firstSeenAt.getTime()) / 60_000;

  // Independent concerns, no reason for one to wait on another.
  const [probing, coverage, pacing] = await Promise.all([
    runAdvisorCall({
      callType: "fanout-probing",
      conversationFingerprint: req.fingerprint,
      system: PROBING_SYSTEM_PROMPT,
      messages: transcript,
    }),
    runAdvisorCall({
      callType: "fanout-coverage",
      conversationFingerprint: req.fingerprint,
      system: COVERAGE_SYSTEM_PROMPT,
      messages: transcript,
    }),
    runAdvisorCall({
      callType: "fanout-pacing",
      conversationFingerprint: req.fingerprint,
      system: `${PACING_SYSTEM_PROMPT}\n\n${pacingNote(elapsedMinutes, ACTIVE_GUIDE.targetDurationMinutes)}`,
      messages: transcript,
    }),
  ]);

  // Deliberately not a raw concatenation of the three notes -- a real
  // synthesis step so contradictions (pacing says wrap up, probing says
  // push harder) get resolved into one instruction rather than left for
  // the moderator to referee live.
  const synthesisMessages: AnthropicMessage[] = [
    {
      role: "user",
      content:
        `Probing-opportunities advisor: ${probing || "(no signal)"}\n\n` +
        `Objective-coverage advisor: ${coverage || "(no signal)"}\n\n` +
        `Pacing advisor: ${pacing || "(no signal)"}`,
    },
  ];
  const guidance = await runAdvisorCall({
    callType: "fanout-synthesis",
    conversationFingerprint: req.fingerprint,
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: synthesisMessages,
  });

  if (guidance) {
    await updateConversationState(req.fingerprint, { ...req.state, fanoutGuidance: guidance });
  }
}

export const fanoutArchitecture: Architecture = {
  name: "fanout",
  kind: "custom",
  async run(req): Promise<ArchitectureResult> {
    const elapsedMinutes = (Date.now() - req.firstSeenAt.getTime()) / 60_000;
    const guidance =
      typeof req.state.fanoutGuidance === "string" && req.state.fanoutGuidance
        ? req.state.fanoutGuidance
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
    after(() => runFanoutReasoning(req, responseText));

    return {
      responseText,
      responseToolCalls,
      stopReason: completion.stop_reason,
      nextState: req.state, // unchanged here -- runFanoutReasoning above writes the real update itself, later
    };
  },
};
