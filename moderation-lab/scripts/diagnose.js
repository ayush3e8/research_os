#!/usr/bin/env node
/**
 * Independent diagnostics -- dumps recent turn_logs, turn_claims,
 * conversation_state, and architecture_agents directly from the DB, so a
 * live-call problem can be root-caused from what actually happened
 * (every request/response Claude saw, every dedup claim, every
 * provisioned agent) without needing anyone to copy-paste anything from
 * Vercel's dashboard.
 *
 * Requires DATABASE_URL set (moderation-lab/.env.local, gitignored, or the
 * environment). Usage: `node scripts/diagnose.js` from moderation-lab/.
 */
const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

// Minimal .env.local loader -- avoids adding a dotenv dependency just for
// this script. Only sets vars that aren't already in the environment.
const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

async function main() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error("No DATABASE_URL/POSTGRES_URL set (checked .env.local and the environment).");
    process.exit(1);
  }
  const sql = neon(url);

  const limit = Number(process.argv[2] || 20);

  console.log(`\n=== architecture_agents ===`);
  const agents = await sql`select * from architecture_agents`;
  for (const r of agents) console.log(JSON.stringify(r));

  console.log(`\n=== turn_logs (last ${limit}) ===`);
  const logs = await sql`
    select id, architecture, call_type, model, stop_reason, latency_ms,
           left(response_text, 200) as response_preview, created_at
    from turn_logs order by created_at desc limit ${limit}
  `;
  for (const r of logs) console.log(JSON.stringify(r));

  console.log(`\n=== turn_claims (last ${limit}) ===`);
  const claims = await sql`
    select fingerprint, status, stop_reason, claimed_at
    from turn_claims order by claimed_at desc limit ${limit}
  `;
  for (const r of claims) console.log(JSON.stringify(r));

  console.log(`\n=== conversation_state (last ${limit}) ===`);
  const convos = await sql`
    select fingerprint, architecture, first_seen_at, updated_at, state
    from conversation_state order by updated_at desc limit ${limit}
  `;
  for (const r of convos) console.log(JSON.stringify(r));

  console.log(`\n=== personas ===`);
  const personas = await sql`select id, name, axis_values, created_at from personas order by created_at desc limit ${limit}`;
  for (const r of personas) console.log(JSON.stringify(r));
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
