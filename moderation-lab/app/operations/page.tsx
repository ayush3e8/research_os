"use client";

/**
 * Call-health + latency, deliberately separate from /evaluations
 * (moderation quality) -- these are operational signals about the
 * pipeline itself, not about how well the moderator interviewed.
 * Latency needs ElevenLabs' post_call_transcription webhook registered
 * (see app/api/webhooks/elevenlabs-post-call/route.ts's docstring) --
 * until that's set up, the latency column just won't have data to show.
 */
import { useEffect, useState } from "react";

type CallHealthRow = {
  conversationFingerprint: string;
  architecture: string;
  totalTurns: number;
  fallbackCount: number;
  conflictCount: number;
  reachedEndCall: boolean;
  startedAt: string;
  endedAt: string;
};
type CallHealthSummary = {
  totalCalls: number;
  fallbackRate: number;
  conflictRate: number;
  abruptEndingRate: number;
  calls: CallHealthRow[];
};
type LatencyLeg = { turnIndex: number; ourProcessingMs: number | null; totalRoundTripMs: number; elevenlabsOverheadMs: number | null };
type CallLatencySummary = {
  legs: LatencyLeg[];
  totalP50Ms: number | null;
  totalP95Ms: number | null;
  totalMaxMs: number | null;
  ourProcessingMeanMs: number | null;
  elevenlabsOverheadMeanMs: number | null;
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function ms(x: number | null): string {
  return x === null ? "—" : `${Math.round(x)}ms`;
}

function StatTile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, minWidth: 120 }}>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: warn ? "var(--error)" : "var(--text)" }}>{value}</div>
    </div>
  );
}

function LatencyDetail({ fingerprint }: { fingerprint: string }) {
  const [data, setData] = useState<CallLatencySummary | "loading" | "unavailable">("loading");

  useEffect(() => {
    fetch(`/api/latency/${fingerprint}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setData("unavailable"));
  }, [fingerprint]);

  if (data === "loading") return <div style={{ fontSize: 11, color: "var(--muted)" }}>loading…</div>;
  if (data === "unavailable")
    return (
      <div style={{ fontSize: 11, color: "var(--muted)" }}>
        No post-call webhook data yet for this call — register the ElevenLabs post-call webhook to get real
        ASR+processing+TTS timing.
      </div>
    );

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <StatTile label="p50 total" value={ms(data.totalP50Ms)} />
        <StatTile label="p95 total" value={ms(data.totalP95Ms)} />
        <StatTile label="max total" value={ms(data.totalMaxMs)} />
        <StatTile label="our processing (mean)" value={ms(data.ourProcessingMeanMs)} />
        <StatTile label="ElevenLabs ASR+TTS (mean)" value={ms(data.elevenlabsOverheadMeanMs)} />
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ background: "var(--bg)", textAlign: "left" }}>
            <th style={{ padding: 4 }}>turn</th>
            <th style={{ padding: 4 }}>total round trip</th>
            <th style={{ padding: 4 }}>our processing</th>
            <th style={{ padding: 4 }}>ElevenLabs ASR+TTS</th>
          </tr>
        </thead>
        <tbody>
          {data.legs.map((l) => (
            <tr key={l.turnIndex} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: 4 }}>{l.turnIndex}</td>
              <td style={{ padding: 4 }}>{ms(l.totalRoundTripMs)}</td>
              <td style={{ padding: 4 }}>{ms(l.ourProcessingMs)}</td>
              <td style={{ padding: 4 }}>{ms(l.elevenlabsOverheadMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OperationsPage() {
  const [health, setHealth] = useState<CallHealthSummary | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/call-health")
      .then((r) => r.json())
      .then(setHealth);
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Operations</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
        Call health and latency — pipeline reliability, not moderation quality (see <a href="/evaluations">/evaluations</a>{" "}
        for that).
      </p>

      {!health && <div style={{ fontSize: 13, color: "var(--muted)" }}>loading…</div>}

      {health && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
            <StatTile label="calls" value={String(health.totalCalls)} />
            <StatTile label="fallback rate" value={pct(health.fallbackRate)} warn={health.fallbackRate > 0.02} />
            <StatTile label="turn-conflict rate" value={pct(health.conflictRate)} />
            <StatTile label="abrupt-ending rate" value={pct(health.abruptEndingRate)} warn={health.abruptEndingRate > 0.1} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {health.calls.map((c) => (
              <div
                key={c.conversationFingerprint}
                style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                  <div>
                    <strong>{c.architecture}</strong>{" "}
                    <span style={{ fontFamily: "monospace", color: "var(--muted)" }}>
                      {c.conversationFingerprint.slice(0, 10)}…
                    </span>
                  </div>
                  <div style={{ color: "var(--muted)" }}>{new Date(c.endedAt).toLocaleString()}</div>
                </div>
                <div style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--muted)", marginTop: 6, flexWrap: "wrap" }}>
                  <span>{c.totalTurns} turns</span>
                  <span style={{ color: c.fallbackCount > 0 ? "var(--error)" : undefined }}>{c.fallbackCount} fallbacks</span>
                  <span>{c.conflictCount} conflicts</span>
                  <span style={{ color: c.reachedEndCall ? "var(--ok)" : "var(--error)" }}>
                    {c.reachedEndCall ? "ended cleanly" : "never reached end_call"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                  <button onClick={() => setExpanded(expanded === c.conversationFingerprint ? null : c.conversationFingerprint)} style={{ fontSize: 11 }}>
                    {expanded === c.conversationFingerprint ? "hide latency" : "see latency →"}
                  </button>
                  {c.conversationFingerprint.startsWith("sim_") && (
                    <a href={`/simulations/runs/${c.conversationFingerprint}`} style={{ fontSize: 11, color: "var(--accent)" }}>
                      view transcript →
                    </a>
                  )}
                </div>
                {expanded === c.conversationFingerprint && <LatencyDetail fingerprint={c.conversationFingerprint} />}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
