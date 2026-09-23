import { desc } from "drizzle-orm";
import { db } from "@/db";
import { personas } from "@/db/schema";

export async function GET() {
  const rows = await db.select().from(personas).orderBy(desc(personas.createdAt));
  return Response.json({ personas: rows });
}

/** Manual persona creation -- direct free-text authoring, as distinct from
 * POST /api/personas/generate's axis-driven LLM generation. axisValues is
 * left empty ({}) since axes don't apply to a hand-written persona;
 * generatedProfile duplicates systemPrompt (both columns are NOT NULL, and
 * there's no separate "profile" for something authored directly as its
 * own system prompt). */
export async function POST(req: Request) {
  const body = await req.json();
  const name: string = body.name ?? `persona-${Date.now()}`;
  const systemPrompt: string = body.systemPrompt;
  if (!systemPrompt || !systemPrompt.trim()) {
    return Response.json({ error: "systemPrompt is required" }, { status: 400 });
  }

  const [row] = await db
    .insert(personas)
    .values({
      name,
      axisValues: {},
      generatedProfile: systemPrompt,
      systemPrompt,
    })
    .returning();

  return Response.json({ persona: row });
}
