"use client";

/**
 * A single simulation run's full transcript, addressable either by its own
 * id or by its conversationFingerprint (see the API route's docstring) --
 * so a link from Operations (which only knows the fingerprint) reaches this
 * directly, the same way Evaluations and Operations already address every
 * other conversation by fingerprint rather than an internal table id.
 */
import { use, useEffect, useState } from "react";

type Run = {
  id: string;
  batchId: string;
  architecture: string;
  guide: string;
  personaId: string;
  repeatIndex: number;
  conversationFingerprint: string;
  status: string;
  turnCount: number;
  endReason: string | null;
  transcript: { role: string; content: unknown }[];
};

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

export default function RunTranscriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [run, setRun] = useState<Run | "loading" | "not-found">("loading");

  useEffect(() => {
    fetch(`/api/simulations/runs/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setRun(d.run))
      .catch(() => setRun("not-found"));
  }, [id]);

  if (run === "loading") return <div style={{ fontSize: 13, color: "var(--muted)", maxWidth: 900, margin: "0 auto" }}>loading…</div>;
  if (run === "not-found")
    return <div style={{ fontSize: 13, color: "var(--muted)", maxWidth: 900, margin: "0 auto" }}>Run not found.</div>;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>
        {run.architecture} transcript{" "}
        <a href={`/simulations/${run.batchId}`} style={{ fontSize: 12, color: "var(--muted)" }}>
          ← back to batch
        </a>
      </h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
        guide: {run.guide} · repeat {run.repeatIndex} · {run.status} · {run.turnCount} turns · {run.endReason ?? "in progress"} ·{" "}
        <span style={{ fontFamily: "monospace" }}>{run.conversationFingerprint}</span>
      </p>

      <div
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {run.transcript.map((m, i) => (
          <div key={i} style={{ fontSize: 14 }}>
            <strong>{m.role === "assistant" ? "moderator" : "respondent"}:</strong> {extractText(m.content)}
          </div>
        ))}
      </div>
    </div>
  );
}
