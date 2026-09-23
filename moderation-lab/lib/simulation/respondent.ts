/**
 * The "other side" of a simulated call -- an LLM playing a persona,
 * answering as a real respondent would given only what they'd actually be
 * told (guide.statedPurpose), never guide.researchObjective. Mirrors
 * exactly what app/page.tsx shows a human tester before a real call, for
 * the same sponsor-blind reason lib/guide.ts's module docstring gives.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL } from "@/lib/anthropic";
import type { Guide } from "@/lib/guide";

function extractPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
    .join(" ");
}

/** Anthropic's roles are "whoever is generating right now" -- from the
 * respondent's point of view, the moderator's lines are what it's
 * *reacting to* ("user") and its own prior lines are its own ("assistant").
 * Also strips tool_use/tool_result turns down to nothing (a respondent
 * doesn't see our protocol internals, only what got said or shown) and
 * coalesces adjacent same-role text so dropping an empty tool-only turn
 * can never leave two "user" or two "assistant" messages back to back,
 * which the API rejects. */
function toRespondentView(transcript: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  for (const m of transcript) {
    const flippedRole: "user" | "assistant" = m.role === "assistant" ? "user" : "assistant";
    const text = extractPlainText(m.content).trim();
    if (!text) continue;
    if (out.length && out[out.length - 1].role === flippedRole) {
      out[out.length - 1].text += `\n${text}`;
    } else {
      out.push({ role: flippedRole, text });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.map((m) => ({ role: m.role, content: m.text }));
}

export async function generateRespondentTurn(
  personaSystemPrompt: string,
  guide: Guide,
  transcript: Anthropic.MessageParam[]
): Promise<string> {
  const system = `${personaSystemPrompt}

You are on a phone interview right now, playing this role -- this is a real call to you, not a writing exercise. The interviewer introduced the study to you as follows; this is genuinely all you know about why you're being asked these questions, nothing more:
"${guide.statedPurpose}"

Answer the way a real, busy professional being interviewed over the phone actually would -- specific, a little unpolished, in first person. Give a real answer to whatever was just asked. Don't ask the interviewer questions back unless you're genuinely confused by something they said. Output only what you'd say out loud -- no stage directions, no meta-commentary, no describing your own tone.`;

  const messages = toRespondentView(transcript);
  const completion = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 300,
    thinking: { type: "disabled" },
    system,
    messages: messages.length ? messages : [{ role: "user", content: "Hi, thanks for joining. Ready to get started?" }],
  });
  return completion.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
