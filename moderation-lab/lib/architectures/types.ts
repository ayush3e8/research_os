/**
 * The contract every architecture implements. This is the actual
 * scaffolding: a "handler" receives the translated request plus whatever
 * cross-turn state exists for this conversation, and returns what the
 * moderator says (text and/or tool calls) -- however many internal calls
 * (0, 1, or N, sync or lagged) it takes to get there is entirely up to the
 * architecture. The webhook route (route.ts) doesn't know or care.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type AnthropicMessage = Anthropic.MessageParam;

export type ArchitectureRequest = {
  fingerprint: string;
  system: string;
  messages: AnthropicMessage[];
  tools: Anthropic.Tool[];
  firstSeenAt: Date;
  state: Record<string, unknown>;
};

export type ArchitectureResult = {
  responseText: string;
  responseToolCalls: { id: string; name: string; input: unknown }[];
  stopReason: string | null;
  /** Merged into conversation_state.state after the response is sent --
   * an architecture with no cross-turn state (like baseline) just returns
   * the state unchanged. */
  nextState: Record<string, unknown>;
};

export type Architecture = {
  name: string;
  /** Whether this architecture needs ElevenLabs' custom-LLM integration
   * (per-turn control) or can run as a native-LLM agent with no webhook at
   * all. Only custom architectures have a `run()` -- native ones are
   * configured entirely at agent-creation time. */
  kind: "custom" | "native";
  systemPromptForNativeAgent?: () => string; // required if kind === "native"
  run?: (req: ArchitectureRequest) => Promise<ArchitectureResult>; // required if kind === "custom"
};
