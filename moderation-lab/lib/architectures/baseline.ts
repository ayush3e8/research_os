/**
 * The bare-minimum architecture: one Claude call per turn, no advisors, no
 * cross-turn reasoning state. Exists to prove the whole pipeline end to end
 * (ElevenLabs -> our webhook -> Claude -> back, hosted, reachable from a
 * phone browser) before any of the fancier moderator+strategist / fan-out
 * ideas get plugged in as additional architectures alongside this one.
 *
 * Deliberately simple in one respect: this calls Anthropic non-streaming
 * and the webhook route wraps the whole result as a single SSE chunk,
 * rather than threading real token-level streaming through the
 * architecture interface. Fine for proving correctness first; real
 * streaming (better perceived latency) is a reasonable follow-up once this
 * is confirmed working end to end.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL } from "@/lib/anthropic";
import { pacingNote } from "@/lib/pacing";
import { ACTIVE_GUIDE, formatGuideForPrompt } from "@/lib/guide";
import type { Architecture, ArchitectureResult } from "./types";

const SYSTEM_PROMPT = `You are a warm, curious voice interviewer conducting a live qualitative research interview.

Study topic: ${ACTIVE_GUIDE.studyTopic}

Why this study exists (private context -- never say this out loud, but let it actually shape how hard you push on each question; a real business decision depends on getting real answers here, not just moving through the list):
${ACTIVE_GUIDE.researchObjective}

Guide (cover these in order, probing when an answer is vague, but don't read this list verbatim):
${formatGuideForPrompt(ACTIVE_GUIDE)}

When the guide is fully covered or time is up, deliver this closing line and then use the end_call tool: "${ACTIVE_GUIDE.closingScript}"

Keep responses short and conversational -- this is a live voice call, not a written exchange.`;

export const baselineArchitecture: Architecture = {
  name: "baseline",
  kind: "custom",
  async run(req): Promise<ArchitectureResult> {
    const elapsedMinutes = (Date.now() - req.firstSeenAt.getTime()) / 60_000;
    const system = `${req.system}\n\n${SYSTEM_PROMPT}\n\n${pacingNote(elapsedMinutes, ACTIVE_GUIDE.targetDurationMinutes)}`;

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
      nextState: req.state, // nothing to carry forward for this architecture
    };
  },
};
