/**
 * Persona pipeline: continuous axis values -> an LLM-generated base profile
 * (bio, background, speaking style) -> a final assembled system prompt
 * (profile + axis-driven personality instructions). Generated ONCE and
 * saved as a fixture (see db/schema.ts's personas table) so every
 * architecture faces the identical persona instance -- fair comparison
 * requires holding the persona constant, not regenerating it per test.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL } from "@/lib/anthropic";

export type PersonaAxes = {
  chatty: number; // 0 = terse, 1 = rambling
  fraudLike: number; // 0 = genuine, engaged respondent, 1 = evasive/scripted "professional survey taker"
  backgroundMatch: number; // 0 = barely qualifies for the screener, 1 = ideal-profile match
  backgroundNoise: number; // 0 = quiet, 1 = noisy environment (voice-layer concern, not prompt-level -- see README)
  accent: string; // "none" | a region/accent descriptor -- maps to voice_id choice, not prompt content
};

export const DEFAULT_AXES: PersonaAxes = {
  chatty: 0.5,
  fraudLike: 0.0,
  backgroundMatch: 0.7,
  backgroundNoise: 0.0,
  accent: "none",
};

function axisInstructions(axes: PersonaAxes): string {
  const lines: string[] = [];
  if (axes.chatty >= 0.7) lines.push("You tend to give long, elaborative answers with tangents and examples.");
  else if (axes.chatty <= 0.3) lines.push("You tend to give short, minimal answers and rarely volunteer extra detail.");
  else lines.push("You give moderate-length answers -- not terse, not rambling.");

  if (axes.fraudLike >= 0.6)
    lines.push(
      "You are subtly evasive: you give plausible-sounding but generic, non-committal answers, deflect " +
        "specific follow-ups, and never quite pin down a concrete detail -- like someone optimizing for " +
        "completing the interview rather than genuinely engaging with it. Never announce this outright."
    );

  if (axes.backgroundMatch <= 0.4)
    lines.push(
      "Your actual background only loosely matches what this interview's screener was looking for -- " +
        "you qualify on paper but you're noticeably less deep on the subject than an ideal respondent " +
        "would be, and you're more likely to say 'I'm not totally sure' or defer to secondhand knowledge."
    );

  return lines.join(" ");
}

export async function generateBaseProfile(axes: PersonaAxes): Promise<string> {
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 600,
    system:
      "You write realistic, specific synthetic-respondent background profiles for market-research " +
      "interview simulations. Write a short bio (role, years of experience, company type, what they " +
      "actually work on) that a research interviewer would plausibly encounter -- concrete and specific, " +
      "never generic. Output only the bio, 4-6 sentences, no preamble.",
    messages: [
      {
        role: "user",
        content:
          `Generate a bio for a synthetic respondent in a biopharma market-research interview. ` +
          `Background-match to an ideal screener profile: ${axes.backgroundMatch.toFixed(2)} (0 = barely ` +
          `qualifies, 1 = ideal match). Make the specific role/seniority/company-type consistent with that score.`,
      },
    ],
  });
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export function buildPersonaSystemPrompt(profile: string, axes: PersonaAxes): string {
  return (
    `You are a synthetic respondent in a market-research interview simulation. Stay in character; never ` +
    `mention you are an AI.\n\nBackground:\n${profile}\n\nBehavior:\n${axisInstructions(axes)}`
  );
}
