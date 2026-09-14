// Real-transcript replay experiment (Jul 14) — takes the actual biopharma
// call that just happened (conv_5701kxh4swx8fsf8q3gwb239mwf4, Nikita
// Chaudhary / Pfizer) and, at every point the real moderator spoke,
// generates an ALTERNATE response instead — same real context up to that
// exact turn, but under an experimental system-prompt override: (1) a
// hard no-paraphrase rule, stricter than the current production
// instruction, and (2) an "extremely curious" persona that notices what
// wasn't said, not just what was ("you mentioned A and B, why not C?").
//
// This deliberately includes the two turns where the real call produced
// the fabricated-answer bug and the repeated-transition bug (task #118),
// so this run also shows whether the experimental prompt avoids them at
// the exact real points they happened, not just generically.
//
// Run: NODE_USE_ENV_PROXY=1 npx tsx --env-file=.env.local db/simulate-alt-moderator.ts
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./index";
import { studies } from "./schema";
import { eq } from "drizzle-orm";
import { buildSystemPrompt } from "../lib/system-prompt";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const STUDY_ID = "f24a0969-e26c-4f16-ab01-5a7c5c2d0b26";
const CONVERSATION_ID = "conv_5701kxh4swx8fsf8q3gwb239mwf4";

const MODERATOR_TOOLS: Anthropic.Tool[] = [
  { name: "end_call", description: "End the interview once wrapped up.", input_schema: { type: "object", properties: {} } },
  {
    name: "show_question",
    description: "Show a tap-to-answer question on the respondent's screen.",
    input_schema: { type: "object", required: ["question_id"], properties: { question_id: { type: "string" } } },
  },
  {
    name: "show_stimulus",
    description: "Show an image/stimulus on the respondent's screen.",
    input_schema: { type: "object", required: ["stimulus_id"], properties: { stimulus_id: { type: "string" } } },
  },
  { name: "hide_stimulus", description: "Close the currently shown stimulus.", input_schema: { type: "object", properties: {} } },
  {
    name: "topic_covered",
    description: "Call once a discussion guide topic has been adequately covered and you are moving on.",
    input_schema: {
      type: "object",
      required: ["topic_number", "topic_text", "summary_of_response"],
      properties: {
        topic_number: { type: "number" },
        topic_text: { type: "string" },
        summary_of_response: { type: "string" },
      },
    },
  },
];

const EXPERIMENTAL_OVERRIDE = `

=== EXPERIMENTAL OVERRIDE FOR THIS TEST RUN — supersedes the "Say less than they do" and
"engage with ideas" guidance above where they conflict ===

1. NO PARAPHRASING, NO EXCEPTIONS. Do not restate, summarize, or repeat back anything the
respondent just said, in any form, not even briefly, not even to "confirm you understood." Move
directly from a minimal acknowledgment (a single word or short phrase — "Got it." / "Interesting."
/ "Right.") straight into your next question or probe. Zero tolerance for this experimental run —
treat any restatement of their content as a failure.

2. BE AN EXTREMELY CURIOUS MODERATOR. Don't just collect answers — actively notice what they did
and did NOT say, and push on it. If they named two things but a third obvious one is conspicuously
missing, ask why ("You mentioned A and B — what about C?"). If their reasoning has a gap or jump,
ask why they framed it that way rather than another way. Treat every answer as something to
genuinely interrogate, not just log. Stay tightly grounded in what's actually been said in this
real conversation and this study's real objectives — never invent a fact, never guess at what they
"probably" mean, never fabricate anything they haven't actually said.`;

type Turn = { role: "agent" | "user"; message: string | null };

async function fetchRealTurns(): Promise<{ role: "assistant" | "user"; content: string }[]> {
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${CONVERSATION_ID}`, {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
  });
  const data = await res.json();
  const raw: Turn[] = (data.transcript ?? []).filter((t: Turn) => t.message && t.message.trim() !== "...");

  const merged: { role: "assistant" | "user"; content: string }[] = [];
  for (const t of raw) {
    const role: "assistant" | "user" = t.role === "agent" ? "assistant" : "user";
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content} ${t.message}`;
    } else {
      merged.push({ role, content: t.message as string });
    }
  }
  return merged;
}

async function main() {
  const [study] = await db.select().from(studies).where(eq(studies.id, STUDY_ID)).limit(1);
  if (!study) throw new Error("study not found");

  const realTurns = await fetchRealTurns();
  const baseSystemText = buildSystemPrompt(study) + EXPERIMENTAL_OVERRIDE;
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: baseSystemText, cache_control: { type: "ephemeral" } }];

  const results: {
    turnIndex: number;
    context: { role: string; content: string }[];
    originalResponse: string;
    alternateResponse: string;
  }[] = [];

  for (let i = 0; i < realTurns.length; i++) {
    if (realTurns[i].role !== "assistant") continue; // only regenerate at real moderator turns

    const contextBefore = realTurns.slice(0, i);
    if (contextBefore.length === 0) continue; // skip the very first greeting, nothing to regenerate against

    const messages: Anthropic.MessageParam[] = contextBefore.map((t) => ({ role: t.role, content: t.content }));

    console.log(`Turn ${i}: generating alternate (context: ${messages.length} messages)...`);
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system,
      messages,
      tools: MODERATOR_TOOLS,
    });

    const alternateText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolCalls = response.content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    const toolNote = toolCalls.length ? ` [called tool: ${toolCalls.map((t) => t.name).join(", ")}]` : "";

    results.push({
      turnIndex: i,
      context: contextBefore.slice(-4), // last few turns of context, for readability in the report
      originalResponse: realTurns[i].content,
      alternateResponse: (alternateText || "(no text)") + toolNote,
    });
  }

  await import("fs/promises").then((fs) =>
    fs.writeFile("db/simulate-alt-moderator.output.json", JSON.stringify(results, null, 2))
  );
  console.log(`\nWrote db/simulate-alt-moderator.output.json (${results.length} regenerated turns)`);
}

main().then(() => process.exit(0));
