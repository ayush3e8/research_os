/**
 * One-off setup route: creates the ElevenLabs workspace webhook for
 * post_call_transcription events, using ELEVENLABS_API_KEY (which already
 * lives on Vercel -- same reasoning as the eval-reliability-experiment
 * routes: run where the key already is, rather than moving it anywhere).
 * Returns the signing secret ElevenLabs generates so it can be set as
 * ELEVENLABS_POST_CALL_WEBHOOK_SECRET -- that last step still has to happen
 * in Vercel's own env var settings; this session has no Vercel API
 * credentials to do that part itself.
 *
 * Safe to call more than once if needed, but each call creates a NEW
 * webhook registration in the ElevenLabs workspace (the create endpoint
 * has no upsert-by-url behavior documented) -- check
 * https://elevenlabs.io/app/agents/settings and delete stray duplicates
 * if this gets invoked more than once.
 */
function isAuthorized(req: Request): boolean {
  const expected = process.env.CUSTOM_LLM_WEBHOOK_SECRET;
  if (!expected) return false;
  return req.headers.get("authorization") === `Bearer ${expected}`;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });

  const appUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.APP_URL;
  if (!appUrl) {
    return Response.json({ error: "VERCEL_PROJECT_PRODUCTION_URL / APP_URL not set" }, { status: 500 });
  }

  const webhookUrl = `${appUrl}/api/webhooks/elevenlabs-post-call`;

  const res = await fetch("https://api.elevenlabs.io/v1/workspace/webhooks", {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      settings: {
        auth_type: "hmac",
        name: "moderation-lab post-call",
        webhook_url: webhookUrl,
      },
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    return Response.json({ error: "ElevenLabs webhook creation failed", status: res.status, body }, { status: 502 });
  }

  return Response.json({
    webhookUrl,
    webhookId: body.webhook_id,
    webhookSecret: body.webhook_secret,
    note: "Set ELEVENLABS_POST_CALL_WEBHOOK_SECRET in Vercel to this webhookSecret value. If post-call events don't start arriving after that, check https://elevenlabs.io/app/agents/settings -- this webhook may still need to be selected there for post_call_transcription delivery.",
  });
}
