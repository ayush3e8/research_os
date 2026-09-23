/**
 * TypeSafe AI's "System 1" endpoint (their model: "jev") -- a structured
 * classification call, not a chat completion. You hand it a `state` (plain
 * text description of the situation) and a set of typed `questions`
 * (noul/choice/score), and it returns a categorical answer with a
 * confidence score per question -- no free-text generation at all.
 *
 * Schema drawn from https://docs.typesafe.ai/introduction/quickstart as of
 * this writing -- verify against a real response on first real use, same
 * discipline as every other third-party integration in this project
 * (see lib/elevenlabs.ts's module docstring).
 */
const API_BASE = "https://api.typesafe.ai";

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  /** option key -> description of what that option means. */
  criteria: Record<string, string>;
};
export type NoulQuestion = {
  type: "noul";
  instructions: string;
};
export type ScoreQuestion = {
  type: "score";
  instructions: string;
  /** ordered, low-to-high description of each point on the scale. */
  criteria: string[];
};
export type TypeSafeQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type NoulAnswer = { type: "noul"; noul: number };
export type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
};
export type TypeSafeAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

export async function systemOne(opts: {
  state: string;
  model?: string;
  questions: Record<string, TypeSafeQuestion>;
}): Promise<SystemOneResponse> {
  // Docs say `model` is optional server-side ("defaults to jev-latest") --
  // a real request against the live API 422'd with "Field required" when
  // omitted. Docs and reality disagreed; reality wins, so this is always
  // sent explicitly now rather than left out when undefined.
  const model = opts.model ?? "jev-latest";
  const res = await fetch(`${API_BASE}/v1/systemone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TYPESAFE_API_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state: opts.state, model, questions: opts.questions }),
  });
  if (!res.ok) {
    throw new Error(`TypeSafe system_one failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}
