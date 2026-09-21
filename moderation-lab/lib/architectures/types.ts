/**
 * The contract every architecture implements. This is the actual
 * scaffolding: a "handler" receives the translated request plus whatever
 * cross-turn state exists for this conversation, and returns what the
 * moderator says (text and/or tool calls) -- however many internal calls
 * (0, 1, or N, sync or lagged) it takes to get there is entirely up to the
 * architecture. The webhook route (route.ts) doesn't know or care.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Guide } from "@/lib/guide";

export type AnthropicMessage = Anthropic.MessageParam;

export type ArchitectureRequest = {
  fingerprint: string;
  system: string;
  messages: AnthropicMessage[];
  tools: Anthropic.Tool[];
  firstSeenAt: Date;
  state: Record<string, unknown>;
  /** Picked per call from the manual-test UI, not a fixed deploy-time
   * constant -- see lib/guide.ts's module docstring for why (repeat guides
   * stop being a fair test once a tester has heard the questions once). */
  guide: Guide;
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
  /** ElevenLabs "client" tools this architecture's agent should be
   * provisioned with, beyond the built-in end_call -- read generically by
   * app/api/agents/provision so adding an architecture that needs one never
   * means touching the provisioning route itself. Anthropic's tool-calling
   * side is handled entirely by the architecture's own run() (it just sees
   * these show up in req.tools like any other ElevenLabs-supplied tool);
   * this is only what has to be declared on the agent so ElevenLabs relays
   * them at all and forwards the call to the browser client. */
  clientTools?: {
    name: string;
    description: string;
    /** Whether the moderator's turn should block on a value coming back
     * from the browser client (e.g. a tapped rating) vs. fire-and-forget
     * (e.g. just displaying something). Defaults to false. */
    expectsResponse?: boolean;
    parameters?: object;
  }[];
  /** conversation_config.turn.turn_timeout override, in seconds -- how long
   * ElevenLabs waits during respondent silence before treating their turn
   * as over. Left unset means ElevenLabs' own default. */
  turnTimeoutSecs?: number;
  /** Overrides guide.openingScript as the agent's literal first_message.
   * For an architecture whose moderator prompt authors its own opening
   * rather than reading a guide-scripted line verbatim. */
  firstMessageOverride?: string;
};
