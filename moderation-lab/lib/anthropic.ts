import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return _client;
}

export const MODEL = "claude-sonnet-5";

// For narrow, mechanical, low-reasoning calls where speed matters more than
// depth -- e.g. reviewer.ts's question-trimming pass, which runs
// synchronously on the live call's critical path and has nothing to reason
// about beyond "is this short and conversational."
export const FAST_MODEL = "claude-haiku-4-5-20251001";
