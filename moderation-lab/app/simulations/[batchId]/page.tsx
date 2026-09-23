"use client";

/**
 * A batch's results: per-architecture aggregate (once runs are evaluated
 * via the existing evaluation pipeline -- same lib/evaluation/* scoring
 * real calls get, nothing simulation-specific) plus a per-run table with
 * transcript-level drill-down. Evaluation is a deliberate per-run button,
 * not automatic -- see /api/evaluations' own docstring on when it's meant
 * to fire; a batch can have many runs and each evaluation is itself an
 * LLM-judge pass, so auto-firing all of them the moment a run finishes
 * would spend money nobody explicitly asked for yet.
 */
import { use, useEffect, useState } from "react";

type Batch = {
  id: string;
  name: string;
  guide: string;
  architectures: string[];
  personaIds: string[];
  repeatsPerCombo: number;
  maxTurns: number;
  status: string;
};
type RunSummary = {
  id: string;
  architecture: string;
  personaId: string;
  repeatIndex: number;
  conversationFingerprint: string;
  status: "pending" | "running" | "done" | "failed";
  turnCount: number;
  endReason: string | null;
};
type Persona = { id: string; name: string };
type DimensionScore = { score: number | null; weight: number; detail: Record<string, unknown> };
type EvaluationSummary = {
  id: string;
  conversationFingerprint: string;
  status: string;
  overallScore: number | null;
  dimensionScores: Record<string, DimensionScore>;
};
type TranscriptMessage = { role: string; content: unknown };

function pct(score: number | null | undefined): string {
  return score === null || score === undefined ? "—" : `${Math.round(score * 100)}%`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type: string; text?: string; name?: string; input?: unknown; content?: unknown }) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "tool_use") return `[tool call: ${block.name}(${JSON.stringify(block.input)})]`;
      if (block.type === "tool_result") return `[tool result: ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}]`;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function TranscriptView({ runId }: { runId: string }) {
  const [messages, setMessages] = useState<TranscriptMessage[] | null>(null);

  useEffect(() => {
    fetch(`/api/simulations/runs/${runId}`)
      .then((r) => r.json())
      .then((d) => setMessages(d.run?.transcript ?? []));
  }, [runId]);

  if (!messages) return <div style={{ fontSize: 12, color: "var(--muted)" }}>loading transcript…</div>;

  return (
    <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginTop: 8 }}>
      {messages.map((m, i) => (
        <div key={i} style={{ fontSize: 12, marginBottom: 6 }}>
          <strong>{m.role === "assistant" ? "moderator" : "respondent"}:</strong> {extractText(m.content)}
        </div>
      ))}
    </div>
  );
}

export default function BatchResultsPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = use(params);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [evaluations, setEvaluations] = useState<EvaluationSummary[]>([]);
  const [evaluating, setEvaluating] = useState<Set<string>>(new Set());
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  function refresh() {
    fetch(`/api/simulations/batches/${batchId}`)
      .then((r) => r.json())
      .then((d) => {
        setBatch(d.batch);
        setRuns(d.runs ?? []);
      });
    fetch("/api/evaluations")
      .then((r) => r.json())
      .then((d) => setEvaluations(d.evaluations ?? []));
  }

  useEffect(() => {
    fetch("/api/personas")
      .then((r) => r.json())
      .then((d) => setPersonas(d.personas));
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  async function evaluateRun(run: RunSummary) {
    setEvaluating((prev) => new Set(prev).add(run.id));
    try {
      await fetch("/api/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationFingerprint: run.conversationFingerprint }),
      });
      refresh();
    } finally {
      setEvaluating((prev) => {
        const next = new Set(prev);
        next.delete(run.id);
        return next;
      });
    }
  }

  const evalByFingerprint = new Map(evaluations.map((e) => [e.conversationFingerprint, e]));
  const architectures = batch ? [...new Set(runs.map((r) => r.architecture))] : [];

  return (
    <div style={{ maxWidth: 960, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>
        {batch?.name ?? "Batch"} <a href="/simulations" style={{ fontSize: 12, color: "var(--muted)" }}>← back to playground</a>
      </h1>
      {batch && (
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
          guide: {batch.guide} · {runs.length} runs · max {batch.maxTurns} turns each
        </p>
      )}

      <section style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, marginTop: 0 }}>Aggregate by architecture</h2>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th>Architecture</th>
              <th>Done / Total</th>
              <th>Avg turns</th>
              <th>Avg score</th>
              <th>End reasons</th>
            </tr>
          </thead>
          <tbody>
            {architectures.map((arch) => {
              const archRuns = runs.filter((r) => r.architecture === arch);
              const done = archRuns.filter((r) => r.status === "done");
              const avgTurns = archRuns.length ? archRuns.reduce((s, r) => s + r.turnCount, 0) / archRuns.length : 0;
              const scores = archRuns
                .map((r) => evalByFingerprint.get(r.conversationFingerprint))
                .filter((e) => e?.status === "complete" && e.overallScore !== null)
                .map((e) => e!.overallScore!);
              const avgScore = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
              const reasonCounts = archRuns.reduce<Record<string, number>>((acc, r) => {
                const key = r.endReason ?? (r.status === "running" || r.status === "pending" ? "in progress" : r.status);
                acc[key] = (acc[key] ?? 0) + 1;
                return acc;
              }, {});
              return (
                <tr key={arch} style={{ borderTop: "1px solid var(--border)" }}>
                  <td>{arch}</td>
                  <td>
                    {done.length} / {archRuns.length}
                  </td>
                  <td>{avgTurns.toFixed(1)}</td>
                  <td>{scores.length ? `${pct(avgScore)} (${scores.length} evaluated)` : "not evaluated yet"}</td>
                  <td style={{ color: "var(--muted)" }}>
                    {Object.entries(reasonCounts)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
        <h2 style={{ fontSize: 14, marginTop: 0 }}>Individual runs</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {runs.map((r) => {
            const evaluation = evalByFingerprint.get(r.conversationFingerprint);
            return (
              <div key={r.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                  <div>
                    <strong>{r.architecture}</strong> · {personas.find((p) => p.id === r.personaId)?.name ?? r.personaId.slice(0, 8)} ·
                    repeat {r.repeatIndex}
                  </div>
                  <div style={{ color: "var(--muted)" }}>
                    {r.status} · {r.turnCount} turns · {r.endReason ?? "in progress"}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                  <button onClick={() => setExpandedRun(expandedRun === r.id ? null : r.id)} style={{ fontSize: 11 }}>
                    {expandedRun === r.id ? "hide transcript" : "view transcript"}
                  </button>
                  {r.status === "done" || r.status === "failed" ? (
                    evaluation?.status === "complete" ? (
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{pct(evaluation.overallScore)}</span>
                    ) : evaluation?.status === "running" ? (
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>evaluating…</span>
                    ) : (
                      <button onClick={() => evaluateRun(r)} disabled={evaluating.has(r.id)} style={{ fontSize: 11 }}>
                        {evaluating.has(r.id) ? "starting…" : "evaluate"}
                      </button>
                    )
                  ) : null}
                </div>

                {expandedRun === r.id && <TranscriptView runId={r.id} />}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
