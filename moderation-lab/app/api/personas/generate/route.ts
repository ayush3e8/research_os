import { db } from "@/db";
import { personas } from "@/db/schema";
import { buildPersonaSystemPrompt, DEFAULT_AXES, generateBaseProfile, type PersonaAxes } from "@/lib/persona-generator";

export async function POST(req: Request) {
  const body = await req.json();
  const axes: PersonaAxes = { ...DEFAULT_AXES, ...(body.axes ?? {}) };
  const name: string = body.name ?? `persona-${Date.now()}`;

  const profile = await generateBaseProfile(axes);
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
