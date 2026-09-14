/**
 * Receives ElevenLabs' post_call_transcription webhook -- register this
 * exact URL in the ElevenLabs dashboard (Settings -> Webhooks) and copy the
 * signing secret it gives you into ELEVENLABS_POST_CALL_WEBHOOK_SECRET.
 * This is the only source of real ASR+TTS timing this project has; see
 * lib/latency.ts for why and how it's used.
 */
import { db } from "@/db";
import { postCallEvents } from "@/db/schema";
import { correlatePostCallEvent } from "@/lib/latency";
import { verifyPostCallSignature, type PostCallPayload } from "@/lib/postcall-webhook";

export async function POST(req: Request) {
  const secret = process.env.ELEVENLABS_POST_CALL_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook not configured", { status: 503 });

  const rawBody = await req.text();
  const signature = req.headers.get("ElevenLabs-Signature");
  if (!verifyPostCallSignature(rawBody, signature, secret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(rawBody) as PostCallPayload;
  if (payload.type !== "post_call_transcription") {
    // We only registered for this type, but a workspace-level webhook can
    // carry others (post_call_audio, etc.) -- ack and ignore rather than error.
    return Response.json({ ok: true, ignored: payload.type });
  }

  const [row] = await db
    .insert(postCallEvents)
    .values({
      elevenlabsConversationId: payload.data.conversation_id,
      agentId: payload.data.agent_id,
      startTimeUnixSecs: payload.data.metadata?.start_time_unix_secs ?? null,
      callDurationSecs: payload.data.metadata?.call_duration_secs ?? null,
      transcript: payload.data.transcript ?? [],
      rawPayload: payload,
    })
    .returning({ id: postCallEvents.id });

  await correlatePostCallEvent(row.id);

  return Response.json({ ok: true });
}
