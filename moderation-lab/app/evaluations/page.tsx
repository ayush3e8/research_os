"use client";

/**
 * Minimal results page -- built alongside the framework itself, not
 * polished UI. Lists every evaluation (auto-triggered from app/page.tsx
 * after each call) with its dimension scores, and lets you drill into one
 * to see every underlying per-turn check -- the same evidence-first
 * standard the reliability-experiment artifact held judge output to,
 * inside the actual app now instead of a one-off page.
 */
import { useEffect, useState } from "react";

type DimensionScore = { score: number | null; weight: number; detail: Record<string, unknown> };
type EvaluationSummary = {
  id: string;
  conversationFingerprint: string;
  architecture: string;
  status: string;
  overallScore: number | null;
  dimensionScores: Record<string, DimensionScore>;
  createdAt: string;
  completedAt: string | null;
};
type TurnCheck = {
  checkType: string;
  turnIndex: number;
  quote: string;
  malformed: boolean;
  result: Record<string, unknown>;
};
type EvaluationDetail = EvaluationSummary & {
  turnChecks: TurnCheck[];
  deterministicMetrics: Record<string, unknown>;
};

const DIMENSION_LABELS: Record<string, string> = {
  probing: "Probing",
  neutrality: "Neutrality",
  redundantQuestion: "Listening (redundancy)",
  naturalness: "Naturalness",
  clarity: "Clarity",
  coverage: "Coverage",
  timeManagement: "Time management",
};

function pct(score: number | null): string {
  return score === null ? "—" : `${Math.round(score * 100)}%`;
}

function ScoreBar({ label, dim }: { label: string; dim: DimensionScore }) {
  const pctVal = dim.score === null ? 0 : Math.round(dim.score * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <div style={{ width: 130, color: "var(--muted)" }}>{label}</div>
      <div style={{ flex: 1, height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
        <div
          style={{
            width: `${pctVal}%`,
            height: "100%",
            background: dim.score === null ? "transparent" : "var(--accent)",
          }}
        />
      </div>
      <div style={{ width: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{pct(dim.score)}</div>
    </div>
  );
}

function EvaluationDetailView({ id }: { id: string }) {
  const [detail, setDetail] = useState<EvaluationDetail | null>(null);
  const [filter, setFilter] = useState<string>("");

  useEffect(() => {
    fetch(`/api/evaluations/${id}`)
      .then((r) => r.json())
      .then(setDetail);
  }, [id]);

  if (!detail) return <div style={{ fontSize: 12, color: "var(--muted)" }}>loading…</div>;

  const checkTypes = [...new Set(detail.turnChecks.map((c) => c.checkType))];
  const rows = filter ? detail.turnChecks.filter((c) => c.checkType === filter) : detail.turnChecks;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <button onClick={() => setFilter("")} style={{ fontSize: 11, fontWeight: filter === "" ? 700 : 400 }}>
          all ({detail.turnChecks.length})
        </button>
        {checkTypes.map((t) => (
          <button key={t} onClick={() => setFilter(t)} style={{ fontSize: 11, fontWeight: filter === t ? 700 : 400 }}>
            {t} ({detail.turnChecks.filter((c) => c.checkType === t).length})
          </button>
        ))}
      </div>
      <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ background: "var(--bg)", textAlign: "left" }}>
              <th style={{ padding: 6 }}>turn</th>
              <th style={{ padding: 6 }}>check</th>
              <th style={{ padding: 6 }}>quote</th>
              <th style={{ padding: 6 }}>result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--border)", background: c.malformed ? "color-mix(in srgb, var(--error) 10%, transparent)" : undefined }}>
                <td style={{ padding: 6, color: "var(--muted)" }}>{c.turnIndex}</td>
                <td style={{ padding: 6 }}>{c.checkType}</td>
                <td style={{ padding: 6, maxWidth: 220, color: "var(--muted)", fontStyle: "italic" }}>
                  {c.quote.length > 80 ? c.quote.slice(0, 80) + "…" : c.quote}
                </td>
                <td style={{ padding: 6, fontFamily: "monospace", fontSize: 10 }}>
                  {c.malformed ? "⚠ broken" : JSON.stringify(c.result)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details style={{ marginTop: 10, fontSize: 11 }}>
        <summary style={{ cursor: "pointer", color: "var(--muted)" }}>deterministic metrics (coverage, pacing, naturalness variety)</summary>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 10 }}>{JSON.stringify(detail.deterministicMetrics, null, 2)}</pre>
      </details>
    </div>
  );
}

export default function EvaluationsPage() {
  const [evals, setEvals] = useState<EvaluationSummary[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  function refresh() {
    fetch("/api/evaluations")
      .then((r) => r.json())
      .then((d) => setEvals(d.evaluations));
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Evaluations</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
        Runs automatically after every call on <a href="/">the manual test page</a>. Refreshes every 5s while any
        evaluation is running.
      </p>

      {evals.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No evaluations yet.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {evals.map((e) => (
          <div
            key={e.id}
            style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <div>
                <strong>{e.architecture}</strong>{" "}
                <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "monospace" }}>
                  {e.conversationFingerprint.slice(0, 10)}…
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                {e.status === "running" && "⏳ running"}
                {e.status === "failed" && <span style={{ color: "var(--error)" }}>failed</span>}
                {e.status === "complete" && new Date(e.createdAt).toLocaleString()}
              </div>
            </div>

            {e.status === "complete" && (
              <>
                <div style={{ fontSize: 26, fontWeight: 700, margin: "8px 0" }}>{pct(e.overallScore)}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 420 }}>
                  {Object.entries(e.dimensionScores).map(([key, dim]) => (
                    <ScoreBar key={key} label={DIMENSION_LABELS[key] ?? key} dim={dim} />
                  ))}
                </div>
                <button
                  onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  style={{ marginTop: 10, fontSize: 12 }}
                >
                  {expanded === e.id ? "hide details" : "see every check →"}
                </button>
                {expanded === e.id && <EvaluationDetailView id={e.id} />}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
