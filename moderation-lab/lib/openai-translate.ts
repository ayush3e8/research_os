/**
 * ElevenLabs' Custom LLM integration speaks the OpenAI /chat/completions
 * wire format; this translates that into what the Anthropic SDK expects,
 * and back again for the SSE response.
 */
import type Anthropic from "@anthropic-ai/sdk";

type OpenAIToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type OpenAITool = { type: "function"; function: { name: string; description?: string; parameters?: object } };

export function toAnthropicTools(tools: OpenAITool[] | undefined): Anthropic.Tool[] {
  if (!tools) return [];
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: (t.function.parameters as Anthropic.Tool["input_schema"]) ?? { type: "object", properties: {} },
  }));
}

export function toAnthropicMessages(messages: OpenAIMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const rest: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      rest.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
      rest.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      rest.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      });
    }
  }

  // Anthropic hard-rejects a message list ending in an assistant turn.
  // ElevenLabs can replay history ending that way (observed around
  // reconnects) -- valid for OpenAI-style providers, not Anthropic's. Strip
  // trailing assistant turns defensively, but never down to nothing.
  let trimmed = rest.length;
  while (trimmed > 0 && rest[trimmed - 1].role === "assistant") trimmed -= 1;
  const safeMessages = trimmed > 0 ? rest.slice(0, trimmed) : rest;

  return { system, messages: safeMessages };
}

export function openAiChunk(id: string, model: string, delta: object, finishReason: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: finishReason ? {} : delta, finish_reason: finishReason }],
  };
}

/** Wraps a complete (non-streamed-from-Claude) result as a single SSE
 * chunk -- valid wire format for ElevenLabs, just without token-level
 * granularity. See lib/architectures/baseline.ts's docstring for why. */
export function singleChunkSseResponse(
  id: string,
  model: string,
  responseText: string,
  responseToolCalls: { id: string; name: string; input: unknown }[]
): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (chunk: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

      if (responseText) send(openAiChunk(id, model, { content: responseText }));
      responseToolCalls.forEach((tc, index) => {
        send(
          openAiChunk(id, model, {
            tool_calls: [
              { index, id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) } },
            ],
          })
        );
      });
      send(openAiChunk(id, model, {}, responseToolCalls.length ? "tool_calls" : "stop"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
