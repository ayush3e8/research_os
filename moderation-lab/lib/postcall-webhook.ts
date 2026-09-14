/**
 * Verification for ElevenLabs' post_call_transcription webhook -- the only
 * source of real ASR+TTS timing (our own turn_logs.latency_ms only ever
 * measured our webhook's own processing slice). Confirmed via ElevenLabs'
 * own SDK source (not guessed): ElevenLabs-Signature is
 * "t=<unix_ts>,v0=<hex hmac-sha256 of '<unix_ts>.<raw_body>'>", 30-minute
 * replay window. Implemented directly with Node's crypto rather than
 * pulling in the elevenlabs server SDK for one function.
 */
import { createHmac, timingSafeEqual } from "crypto";

const REPLAY_WINDOW_SECS = 30 * 60;

export function verifyPostCallSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v];
    })
  );
  const timestamp = parts["t"];
  const signature = parts["v0"];
  if (!timestamp || !signature) return false;

  const ageSecs = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSecs) || ageSecs > REPLAY_WINDOW_SECS) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export type PostCallTranscriptEntry = {
  role: "agent" | "user";
  message: string | null;
  time_in_call_secs: number;
  conversation_turn_metrics?: {
    convai_llm_service_ttfb?: { elapsed_time: number };
    convai_llm_service_ttf_sentence?: { elapsed_time: number };
  } | null;
};

export type PostCallPayload = {
  type: string;
  event_timestamp: number;
  data: {
    agent_id: string;
    conversation_id: string;
    transcript: PostCallTranscriptEntry[];
    metadata: { start_time_unix_secs: number; call_duration_secs: number };
  };
};
