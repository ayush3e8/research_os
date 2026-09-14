// Real-transcript replay (Jul 15) — tests the two-persona architecture
// (lib/live-directive-agent.ts) against the SAME real call already used to
// document the fabrication bug (turn 16) and the repetition-loop bug
// (turns 22-26): conv_5701kxh4swx8fsf8q3gwb239mwf4, the Nikita Chaudhary
// biopharma-demo interview. At every real moderator turn where enough
// context has accumulated to trigger the two-persona path, this
// regenerates a response the same way the live webhook now would
// (buildModeratorRequest's logic, duplicated here rather than importing
// route.ts) and reports it next to what the real call actually produced.
//
// Run: NODE_USE_ENV_PROXY=1 npx tsx --env-file=.env.local db/simulate-two-persona.ts
import Anthropic from "anthropic-sdk-realtime";
import { db } from "./index";
import { studies } from "./schema";
import { eq } from "drizzle-orm";
import { buildSystemPrompt } from "../lib/system-prompt";
import {
  generateLiveDirective,
  truncateMessagesSafely,
  TRUNCATE_THRESHOLD,
  KEEP_RECENT_MESSAGES,
} from "../lib/live-directive-agent";

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
];

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
  const systemText = buildSystemPrompt(study);

  const results: {
    turnIndex: number;
    messageCount: number;
    triggeredTwoPersona: boolean;
    directive: { recentSummary: string; directive: string } | null;
    originalResponse: string;
    twoPersonaResponse: string;
  }[] = [];

  for (let i = 0; i < realTurns.length; i++) {
    if (realTurns[i].role !== "assistant") continue;
    const contextBefore = realTurns.slice(0, i);
    if (contextBefore.length === 0) continue;

    const messages: Anthropic.MessageParam[] = contextBefore.map((t) => ({ role: t.role, content: t.content }));
    const triggeredTwoPersona = messages.length > TRUNCATE_THRESHOLD;

    // Skip early turns entirely, same as the live webhook would (zero
    // wasted API calls on the part of the call that was never at risk).
    if (!triggeredTwoPersona) continue;

    console.log(`Turn ${i}: ${messages.length} messages, running two-persona flow...`);

    const directive = await generateLiveDirective(systemText, messages);
    const moderatorSystem: Anthropic.TextBlockParam[] = [
      { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
    ];
    let moderatorMessages = messages;
    if (directive) {
      moderatorMessages = truncateMessagesSafely(messages, KEEP_RECENT_MESSAGES);
      moderatorSystem.push({
        type: "text",
        text: `\n\nStrategist summary of everything covered so far in this interview (rely on this instead of the full history for anything before your recent turns below):\n${directive.recentSummary}\n\nStrategist directive for your NEXT turn only: ${directive.directive}\nDo only this one thing in your response, then stop — do not also do whatever would naturally come after it (a wrap-up, a further question, anything else). That comes later, in a future turn, once the respondent has actually replied.`,
      });
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system: moderatorSystem,
      messages: moderatorMessages,
      tools: MODERATOR_TOOLS,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolCalls = response.content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    const toolNote = toolCalls.length ? ` [called tool: ${toolCalls.map((t) => t.name).join(", ")}]` : "";

    results.push({
      turnIndex: i,
      messageCount: messages.length,
      triggeredTwoPersona,
      directive,
      originalResponse: realTurns[i].content,
      twoPersonaResponse: (text || "(no text)") + toolNote,
    });
  }

  await import("fs/promises").then((fs) =>
    fs.writeFile("db/simulate-two-persona.output.json", JSON.stringify(results, null, 2))
  );
  console.log(`\nWrote db/simulate-two-persona.output.json (${results.length} regenerated turns)`);
}

main().then(() => process.exit(0));
