import { db } from "@/db";
import { personas } from "@/db/schema";
import { getGuide } from "@/lib/guide";
import { buildPersonaSystemPrompt, DEFAULT_AXES, generateBaseProfile, type PersonaAxes } from "@/lib/persona-generator";

export async function POST(req: Request) {
  const body = await req.json();
  const axes: PersonaAxes = { ...DEFAULT_AXES, ...(body.axes ?? {}) };
  const name: string = body.name ?? `persona-${Date.now()}`;
  // Which study this persona is meant to be a respondent for -- the
  // generated bio (role/profession/setting) has to match, e.g. a study
  // about community oncologists needs an oncologist persona, not a generic
  // "biopharma market research professional" (a real bug: the prompt used
  // to hardcode that phrasing regardless of guide). Defaults to "everyday"
  // for callers that don't care, matching every other guide-optional
  // endpoint's historical default.
  const guideName: string = body.guide ?? "everyday";
  const guide = getGuide(guideName);
  if (!guide) {
    return Response.json({ error: `Unknown guide: ${guideName}` }, { status: 400 });
  }

  const profile = await generateBaseProfile(axes, guide);
  const systemPrompt = buildPersonaSystemPrompt(profile, axes);

  const [row] = await db
    .insert(personas)
    .values({
      name,
      axisValues: axes,
      generatedProfile: profile,
      systemPrompt,
    })
    .returning();

  return Response.json({ persona: row });
}
