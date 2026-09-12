# Moderation Lab

Hosted testbed for comparing voice moderator architectures. Everything
runs on Vercel + Postgres + ElevenLabs + Anthropic — nothing local, so it
works from a phone browser and you can hand the URL to anyone to try.

This is the bare-minimum scaffold: one architecture (`baseline`, a single
Claude call per turn, no advisors) proves the whole pipeline end to end.
Fancier architectures (moderator+strategist, fan-out specialists, etc.)
plug into `lib/architectures/registry.ts` later without touching anything
else — the webhook, dedup, logging, and state plumbing are already
architecture-agnostic.

## What's built

- `app/api/architectures/[name]/chat/completions/route.ts` — the custom-LLM
  webhook ElevenLabs calls per turn. Handles auth, OpenAI↔Anthropic wire
  translation, duplicate-request dedup, cross-turn state, and full turn
  logging — architecture-agnostic; delegates to whichever module `[name]`
  resolves to in the registry.
- `lib/architectures/baseline.ts` — the one architecture that exists so
  far: single call, deterministic pacing (plain arithmetic against real
  elapsed time, not an LLM call), no cross-turn reasoning.
- `lib/persona-generator.ts` + `app/api/personas/*` — generate a synthetic
  respondent profile from continuous axis values (chatty, fraud-like,
  background-match, ...), saved once as a fixture. **Not yet wired to an
  actual voice** — right now this is reference text shown next to the
  manual-test call, not a synthetic respondent agent. Turning a persona
  into an actual agent-vs-agent call is a next step, not part of this
  scaffold.
- `app/page.tsx` — the manual-test page: pick an architecture, click "Start
  call," talk to it via your phone's mic/speaker (ElevenLabs' browser SDK
  handles audio directly — no app install, just a browser tab).

## Deploy checklist (from your phone, via vercel.com)

1. **Import the project.** vercel.com → Add New → Project → import this
   GitHub repo → set the **root directory** to `moderation-lab` (not the
   repo root, since `voice-qual-poc/` is a separate Python project).
2. **Add Postgres.** In the new project → Storage tab → Create Database →
   Postgres. This auto-injects `POSTGRES_URL` — no manual connection
   string needed.
3. **Add environment variables** (Settings → Environment Variables):
   - `ANTHROPIC_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `CUSTOM_LLM_WEBHOOK_SECRET` — any random string (e.g. generate one
     with a password generator app); this is the bearer token ElevenLabs
     sends back to prove a request is really from them.
4. **Deploy.** Vercel builds and gives you a `https://<something>.vercel.app`
   URL immediately — that's enough to test from your phone; a custom
   domain can be attached later (Settings → Domains) whenever convenient.
5. **Push the DB schema.** Either run `npx drizzle-kit push` once locally
   with `POSTGRES_URL` set to what Vercel gave you, or (simplest from a
   phone with no terminal) ask me to do it once you've shared that
   connection string — either way, this only needs to happen once.
6. **Open the deployed URL**, pick "baseline," hit Start call, allow mic
   access, talk. First call also auto-provisions the ElevenLabs agent
   (creates a workspace secret + the agent itself) — that happens
   automatically on the first "Start call" click, nothing extra to do.

## Local dev (optional, not required for phone testing)

```bash
cd moderation-lab
npm install
cp .env.example .env.local   # fill in the same values as above
npx drizzle-kit push          # creates the tables
npm run dev
```

## Adding a new architecture later

1. Add a module under `lib/architectures/` implementing the `Architecture`
   type from `lib/architectures/types.ts` — `kind: "custom"` with a
   `run()` if it needs per-turn control (most of the fancier ones will),
   or `kind: "native"` with just a system prompt if it doesn't.
2. Register it in `lib/architectures/registry.ts`.
3. It shows up in the manual-test page's architecture dropdown
   automatically — no UI changes needed.
