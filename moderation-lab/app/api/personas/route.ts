import { desc } from "drizzle-orm";
import { db } from "@/db";
import { personas } from "@/db/schema";

export async function GET() {
  const rows = await db.select().from(personas).orderBy(desc(personas.createdAt));
  return Response.json({ personas: rows });
}
