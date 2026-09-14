/**
 * Same three-advisors-plus-moderator shape as fanout.ts, but a deliberately
 * different timing model. strategist.ts and fanout.ts both schedule their
 * reasoning calls with next/server's `after()` so they never add latency to
 * the live call -- the cost is that whatever guidance the moderator uses on
 * turn N was actually computed from turn N-1's exchange, one full turn
 * stale, because that reasoning only starts once turn N-1's reply is
 * already decided.
 *
 * This architecture makes the opposite trade on purpose: all three advisors
 * run synchronously, in parallel with each other, on the respondent's
 * answer that JUST arrived -- before the moderator ever sees it -- so the
 * guidance folded into this exact turn's system prompt reflects this exact
 * turn, not the one before it. The real cost is real, per-turn latency:
 * total added time is roughly one extra Claude call's round trip (the three
 * advisors run concurrently via Promise.all, so they cost as much as the
 * slowest one, not the sum), on top of the moderator's own call, on every
 * single turn. That is exactly the failure mode the `after()` pattern in
 * the other two architectures exists to avoid -- adopted here deliberately,
 * not by oversight, to test whether same-turn freshness is worth that cost.
 *
 * No cross-turn state: unlike strategist/fanout, nothing here needs to
 * survive between turns (nextState is always req.state, unchanged) -- every
 * turn's advisors reason fresh from the live transcript, so there's no
 * "guidance" value to persist or go stale.
 *
 * The three advisors are also intentionally NOT reconciled by an extra
 * synthesis call the way fanout.ts's probing/coverage/pacing notes are.
 * Those three could genuinely conflict (pacing says wrap up, probing says
 * push harder) and needed a call to resolve the tension. Thread-worth,
 * question-framing, and redundancy are independent concerns about different
 * things -- concatenating them as three short labeled notes costs nothing
 * extra and avoids a fourth sequential latency hop.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL } from "@/lib/anthropic";
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

function moderatorSystemPrompt(
  guide: Guide,
  notes: { threadWorth: string; framing: string; redundancy: string }
): string {
  return `You are a warm, curious voice interviewer conducting a live qualitative research interview.

Study topic: ${guide.studyTopic}

Why this study exists (private context -- never say this out loud, but let it actually shape how hard you push on each question; a real business decision depends on getting real answers here, not just moving through the list):
${guide.researchObjective}

Guide (cover these in order, probing when an answer is vague, but don't read this list verbatim):
${formatGuideForPrompt(guide)}

Three specialist notes computed fresh for this exact turn, on the respondent's answer that just arrived (private, never spoken -- decide what they mean and say it in your own natural voice, never read or paraphrase their wording back to the respondent):

[Thread worth pulling] ${notes.threadWorth || "No signal."}

[Question framing] ${notes.framing || "No signal."}

[Redundancy check] ${notes.redundancy || "No signal."}

When the guide is fully covered or time is up, deliver this closing line and then use the end_call tool: "${guide.closingScript}"

Keep responses short and conversational -- this is a live voice call, not a written exchange.`;
}

function threadWorthSystemPrompt(guide: Guide): string {
  return `You are a silent advisor sitting in on a live qualitative interview, watching only the respondent's answer that just arrived. You never speak to the respondent.

The real business decision this study exists to inform (private -- the respondent is never told this):
${guide.researchObjective}

You'll be given the moderator's last question and the respondent's answer to it. Judge two things: (1) does this answer contain a specific thread worth pulling on -- something vague, surprising, or interesting relative to the objective above -- that the moderator's next turn should push on; (2) was this answer evasive or thin, not really engaging with what was asked, and needs a direct follow-up. If the answer was already concrete and complete, say so plainly rather than inventing something to probe. 1-2 short sentences. Output only that, nothing else.`;
}

function questionFramingSystemPrompt(): string {
  return `You are a silent advisor sitting in on a live qualitative interview, reviewing only the moderator's own last question -- not the respondent's answer. You never speak to the respondent.

Check the moderator's last question for: asking more than one thing at once (a compound question), leading or loaded framing that presupposes an answer or offers a forced-choice menu, and unnecessary length or a wordy acknowledgment before getting to the point. If it was already a single, open, brief question, say so plainly. Otherwise name the specific problem and what the moderator's next question should do differently instead -- e.g. ask one thing, drop the forced choice, acknowledge in a few words and move on. 1-2 short sentences. Output only that, nothing else.`;
}

function redundancySystemPrompt(guide: Guide): string {
  return `You are a silent advisor sitting in on a live qualitative interview, tracking what's actually been learned about this respondent across the whole conversation so far. You never speak to the respondent.

Guide questions still ahead may need to change based on what's already been said:
${formatGuideForPrompt(guide)}

Read the full transcript so far and check: has anything upcoming already been implicitly answered earlier in the conversation -- even in an unrelated segment -- such that asking it again verbatim would be redundant? If so, name which guide topic and what's already known, so the moderator can skip it or reference it instead of re-asking cold. If nothing upcoming is already answered, say so plainly. 1-2 short sentences. Output only that, nothing else.`;
}

/** One advisor call: runs it, logs it under its own callType so each is
 * comparable in turn_logs (and excluded from evaluation transcripts, which
 * filter to callType "moderator" -- see lib/evaluation/transcript.ts),
 * and swallows failures so one dead advisor doesn't take the others -- or
 * the live turn -- down with it. Unlike fanout.ts's identical-looking
 * helper, this runs synchronously on the request's critical path, so a
 * "started" event is logged too: a hang or failure here is directly visible
 * in the live call's own latency, but the health event still says which
 * advisor and why. */
async function runAdvisorCall(args: {
  callType: string;
  conversationFingerprint: string;
  system: string;
  messages: AnthropicMessage[];
}): Promise<string> {
  const startedAt = Date.now();
  await logCallHealthEvent({
    eventType: "live_reasoning_started",
    conversationFingerprint: args.conversationFingerprint,
    architecture: "livefanout",
    detail: { callType: args.callType },
  });

  try {
    const completion = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 200,
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
      architecture: "livefanout",
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
    console.error(`livefanout advisor call "${args.callType}" failed:`, err);
    await logCallHealthEvent({
      eventType: "live_reasoning_failed",
      conversationFingerprint: args.conversationFingerprint,
      architecture: "livefanout",
      detail: { callType: args.callType, error: err instanceof Error ? err.message : String(err) },
    });
    return "";
  }
}

async function runAdvisors(req: ArchitectureRequest): Promise<{ threadWorth: string; framing: string; redundancy: string }> {
  // req.messages is guaranteed to end in a respondent (user) turn -- see
  // openai-translate.ts's trailing-assistant trim -- so this is always the
  // answer that just arrived, never a stale one.
  const lastRespondentMessage = req.messages[req.messages.length - 1];
  const lastModeratorMessage = [...req.messages].reverse().find((m) => m.role === "assistant");
  const lastModeratorText = lastModeratorMessage ? messageText(lastModeratorMessage) : null;

  const threadWorthMessages: AnthropicMessage[] = [
    {
      role: "user",
      content:
        `Moderator's last question: ${lastModeratorText ?? "(opening turn, no prior question)"}\n\n` +
        `Respondent's answer: ${messageText(lastRespondentMessage)}`,
    },
  ];
  const framingMessages: AnthropicMessage[] = [
    {
      role: "user",
      content: lastModeratorText
        ? `Moderator's last question: ${lastModeratorText}`
        : "No prior moderator question yet -- this is the opening turn.",
    },
  ];

  const [threadWorth, framing, redundancy] = await Promise.all([
    runAdvisorCall({
      callType: "livefanout-threadworth",
      conversationFingerprint: req.fingerprint,
      system: threadWorthSystemPrompt(req.guide),
      messages: threadWorthMessages,
    }),
    runAdvisorCall({
      callType: "livefanout-framing",
      conversationFingerprint: req.fingerprint,
      system: questionFramingSystemPrompt(),
      messages: framingMessages,
    }),
    // Redundancy needs the whole transcript, not just the last exchange --
    // passed as-is (already valid, ending in a user turn; no synthetic
    // trailing message needed since nothing is appended after it).
    runAdvisorCall({
      callType: "livefanout-redundancy",
      conversationFingerprint: req.fingerprint,
      system: redundancySystemPrompt(req.guide),
      messages: req.messages,
    }),
  ]);

  return { threadWorth, framing, redundancy };
}

export const livefanoutArchitecture: Architecture = {
  name: "livefanout",
  kind: "custom",
  async run(req): Promise<ArchitectureResult> {
    const elapsedMinutes = (Date.now() - req.firstSeenAt.getTime()) / 60_000;
    const notes = await runAdvisors(req);
    const system = `${req.system}\n\n${moderatorSystemPrompt(req.guide, notes)}\n\n${pacingNote(elapsedMinutes, req.guide.targetDurationMinutes)}`;

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

    return {
      responseText,
      responseToolCalls,
      stopReason: completion.stop_reason,
      nextState: req.state, // nothing to carry forward -- every turn reasons fresh from the live transcript
    };
  },
};
