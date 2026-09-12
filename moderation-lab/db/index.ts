import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Lazy on purpose: Next.js's build step ("Collecting page data") imports
 * every API route module to inspect it, even ones that are never actually
 * called during the build. Connecting to Postgres at module load time (the
 * obvious way to write this) means a missing DATABASE_URL crashes the
 * *build*, not just a real request that needed the DB -- confirmed via a
 * real failed Vercel deploy before this env var was even set yet. Doing it
 * lazily means the build always succeeds regardless of env vars; only an
 * actual DB-using request fails if the var is genuinely missing at runtime.
 */
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getDb() {
  if (!_db) {
    const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL (or POSTGRES_URL) is not set");
    _db = drizzle(neon(url), { schema });
  }
  return _db;
}

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return getDb()[prop as keyof ReturnType<typeof drizzle<typeof schema>>];
  },
});
