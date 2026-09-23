/**
 * A real call never lacks a client to actually execute a client tool
 * (show_stimulus/show_scale_*, see lib/architectures/blindmod.ts) -- the
 * browser is right there. A simulation has no browser, so when the
 * moderator calls one of these, something still has to play "the client"
 * and hand back a plausible tool_result, or the transcript just dead-ends.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Architecture } from "@/lib/architectures/types";
import { END_CALL_TOOL } from "./constants";

/** Every custom-LLM architecture gets end_call (lib/elevenlabs.ts's
 * built_in_tools, always included) plus whatever client tools it declares
 * -- exactly what a real ElevenLabs agent would relay, built directly from
 * the same architecture.clientTools config createAgent uses rather than
 * going through ElevenLabs at all. */
export function buildToolsForArchitecture(architecture: Architecture): Anthropic.Tool[] {
  const clientTools: Anthropic.Tool[] = (architecture.clientTools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.parameters as Anthropic.Tool["input_schema"]) ?? { type: "object", properties: {} },
  }));
  return [END_CALL_TOOL, ...clientTools];
}

/** Stands in for "the client" responding to a non-end_call tool call.
 * end_call is handled separately by the driver (it ends the run, no
 * fabricated result needed). Kept simple and clearly synthetic on purpose
 * -- these values are for exercising the architecture's own logic after a
 * tool call, not for simulating a specific respondent's rating choice. */
export function fabricateToolResult(toolName: string): string {
  if (toolName === "show_stimulus") return "shown";
  if (toolName.startsWith("show_scale")) {
    const rating = 1 + Math.floor(Math.random() * 5);
    return JSON.stringify({ rating });
  }
  return "acknowledged";
}
