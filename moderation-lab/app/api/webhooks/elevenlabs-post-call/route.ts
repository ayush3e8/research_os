/**
 * Receives ElevenLabs' post_call_transcription webhook -- register this
 * exact URL in the ElevenLabs dashboard (Settings -> Webhooks) and copy the
 * signing secret it gives you into ELEVENLABS_POST_CALL_WEBHOOK_SECRET.
 * This is the only source of real ASR+TTS timing this project has; see
 * lib/latency.ts for why and how it's used.
 *
 * Every request gets a row (verified true or false) -- see the verified
 * column's docstring in db/schema.ts for why: without that, a signature
 * failure and "ElevenLabs never called this at all" are indistinguishable
 * from the DB alone, and this session has no other way to inspect Vercel's
 * request logs.
 */
import { db } from "@/db";
import { postCallEvents } from "@/db/schema";
import { correlatePostCallEvent } from "@/lib/latency";
import { verifyPostCallSignature, type PostCallPayload } from "@/lib/postcall-webhook";

export async function POST(req: Request) {
  const secret = process.env.ELEVENLABS_POST_CALL_WEBHOOK_SECRET;
  if (!secret) {
    await db.insert(postCallEvents).values({ verified: false, rawPayload: { error: "webhook not configured" } });
    return new Response("Webhook not configured", { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("ElevenLabs-Signature");
  const verified = verifyPostCallSignature(rawBody, signature, secret);

  let payload: Partial<PostCallPayload> = {};
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Keep payload empty -- still log the attempt below.
  }

  if (!verified) {
    await db.insert(postCallEvents).values({
      verified: false,
      elevenlabsConversationId: payload.data?.conversation_id ?? null,
      agentId: payload.data?.agent_id ?? null,
      rawPayload: { receivedSignatureHeader: signature, bodyPreview: rawBody.slice(0, 500) },
    });
    return new Response("Invalid signature", { status: 401 });
  }

  if (payload.type !== "post_call_transcription") {
    // We only registered for this type, but a workspace-level webhook can
    // carry others (post_call_audio, etc.) -- log and ack rather than error.
    await db.insert(postCallEvents).values({
      verified: true,
      elevenlabsConversationId: payload.data?.conversation_id ?? null,
      agentId: payload.data?.agent_id ?? null,
      rawPayload: { ignoredType: payload.type },
    });
    return Response.json({ ok: true, ignored: payload.type });
  }

  const data = payload.data!;
  const [row] = await db
    .insert(postCallEvents)
    .values({
      verified: true,
      elevenlabsConversationId: data.conversation_id,
      agentId: data.agent_id,
      startTimeUnixSecs: data.metadata?.start_time_unix_secs ?? null,
      callDurationSecs: data.metadata?.call_duration_secs ?? null,
      transcript: data.transcript ?? [],
      rawPayload: payload,
    })
    .returning({ id: postCallEvents.id });

  await correlatePostCallEvent(row.id);

  return Response.json({ ok: true });
}
