"use client";

import { useEffect, useState } from "react";

type ArchitectureInfo = { name: string; kind: "native" | "custom" };
type GuideInfo = { name: string; studyTopic: string; targetDurationMinutes: number };
type Persona = { id: string; name: string; generatedProfile: string; systemPrompt: string };
type RunSummary = {
  id: string;
  architecture: string;
  personaId: string;
  repeatIndex: number;
  status: "pending" | "running" | "done" | "failed";
  turnCount: number;
  endReason: string | null;
};

// Rough, clearly-labeled estimate only -- actual cost varies a lot by
// architecture (system1/blindmod make extra calls per turn beyond the
// moderator+respondent pair every architecture has at minimum) and by how
// verbose the persona and moderator turn out to be. Meant to catch "this
// batch is 10x bigger than you think," not to be a real bill forecast.
const ROUGH_COST_PER_TURN_USD = 0.03;
// At most this many runs step concurrently -- a large batch (many
// architectures x personas x repeats) firing every run's step loop fully
// concurrently would hammer the Anthropic API all at once for no benefit.
const MAX_CONCURRENT_RUNS = 4;

export default function SimulationsPage() {
  const [architectures, setArchitectures] = useState<ArchitectureInfo[]>([]);
  const [guides, setGuides] = useState<GuideInfo[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);

  const [selectedArchitectures, setSelectedArchitectures] = useState<Set<string>>(new Set());
  const [selectedPersonas, setSelectedPersonas] = useState<Set<string>>(new Set());
  const [selectedGuide, setSelectedGuide] = useState("");
  const [repeatsPerCombo, setRepeatsPerCombo] = useState(1);
  const [maxTurns, setMaxTurns] = useState(40);

  const [newPersonaName, setNewPersonaName] = useState("");
  const [newPersonaPrompt, setNewPersonaPrompt] = useState("");
  const [addingPersona, setAddingPersona] = useState(false);
  const [generatingPersona, setGeneratingPersona] = useState(false);

  const [launching, setLaunching] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    fetch("/api/architectures")
      .then((r) => r.json())
      .then((d) => setArchitectures((d.architectures as ArchitectureInfo[]).filter((a) => a.kind === "custom")));
    fetch("/api/guide")
      .then((r) => r.json())
      .then((d) => {
        setGuides(d.guides);
        if (d.guides[0]) setSelectedGuide(d.guides[0].name);
      });
    refreshPersonas();
  }, []);

  function refreshPersonas() {
    fetch("/api/personas")
      .then((r) => r.json())
      .then((d) => setPersonas(d.personas));
  }

  function toggle(set: Set<string>, setSet: (s: Set<string>) => void, value: string) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setSet(next);
  }

  async function generatePersona() {
    setGeneratingPersona(true);
    try {
      const res = await fetch("/api/personas/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `persona-${Date.now()}`, guide: selectedGuide }),
      });
      const data = await res.json();
      if (data.persona) refreshPersonas();
    } finally {
      setGeneratingPersona(false);
    }
  }

  async function addManualPersona() {
    if (!newPersonaPrompt.trim()) return;
    setAddingPersona(true);
    try {
      const res = await fetch("/api/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newPersonaName || undefined, systemPrompt: newPersonaPrompt }),
      });
      const data = await res.json();
      if (data.persona) {
        refreshPersonas();
        setNewPersonaName("");
        setNewPersonaPrompt("");
      }
    } finally {
      setAddingPersona(false);
    }
  }

  const runCount = selectedArchitectures.size * selectedPersonas.size * repeatsPerCombo;
  const roughCostEstimate = runCount * maxTurns * ROUGH_COST_PER_TURN_USD;

  async function driveRun(runId: string) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await fetch(`/api/simulations/runs/${runId}/step`, { method: "POST" });
      const result = await res.json();
      if (result.error) {
        setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, status: "failed", endReason: result.error } : r)));
        return;
      }
      setRuns((prev) =>
        prev.map((r) => (r.id === runId ? { ...r, status: result.status, turnCount: result.turnCount, endReason: result.endReason } : r))
      );
      if (result.status !== "running") return;
    }
  }

  async function driveAllRuns(runIds: string[]) {
    let cursor = 0;
    async function worker() {
      while (cursor < runIds.length) {
        const id = runIds[cursor++];
        await driveRun(id);
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_RUNS, runIds.length) }, worker));
  }

  async function launchBatch() {
    if (!selectedGuide || selectedArchitectures.size === 0 || selectedPersonas.size === 0) return;
    setLaunching(true);
    setRuns([]);
    setBatchId(null);
    try {
      const res = await fetch("/api/simulations/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `batch-${new Date().toISOString()}`,
          guide: selectedGuide,
          architectures: Array.from(selectedArchitectures),
          personaIds: Array.from(selectedPersonas),
          repeatsPerCombo,
          maxTurns,
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      setBatchId(data.batch.id);
      setRuns(
        (data.runs as { id: string; architecture: string; personaId: string; repeatIndex: number }[]).map((r) => ({
          ...r,
          status: "pending" as const,
          turnCount: 0,
          endReason: null,
        }))
      );
      // Fire-and-forget from the caller's perspective -- state updates land
      // via setRuns above as each run's step loop progresses.
      driveAllRuns(data.runs.map((r: { id: string }) => r.id));
    } finally {
      setLaunching(false);
    }
  }

  const doneCount = runs.filter((r) => r.status === "done" || r.status === "failed").length;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Simulations</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
        Text-only, no ElevenLabs involved -- an LLM plays each persona as the respondent, running through the exact
        same architecture code a real call uses.{" "}
        {batchId && (
          <>
            Results for this batch:{" "}
            <a href={`/simulations/${batchId}`} style={{ color: "var(--accent)" }}>
              view batch
            </a>
          </>
        )}
      </p>

      <section style={panelStyle}>
        <h2 style={h2Style}>Personas</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          {personas.map((p) => (
            <label
              key={p.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 8,
                fontSize: 12,
                width: 220,
              }}
            >
              <input
                type="checkbox"
                checked={selectedPersonas.has(p.id)}
                onChange={() => toggle(selectedPersonas, setSelectedPersonas, p.id)}
              />
              <span>
                <strong>{p.name}</strong>
                <br />
                <span style={{ color: "var(--muted)" }}>{p.generatedProfile.slice(0, 140)}...</span>
              </span>
            </label>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
          <button onClick={generatePersona} disabled={generatingPersona}>
            {generatingPersona ? "generating..." : "+ generate persona (default axes)"}
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 12 }}>Add a persona manually (free-text prompt, not axis-generated)</label>
          <input
            placeholder="name (optional)"
            value={newPersonaName}
            onChange={(e) => setNewPersonaName(e.target.value)}
            style={{ fontSize: 13 }}
          />
          <textarea
            placeholder="You are a synthetic respondent... (this becomes the persona's full system prompt)"
            value={newPersonaPrompt}
            onChange={(e) => setNewPersonaPrompt(e.target.value)}
            rows={3}
            style={{ fontSize: 13, fontFamily: "inherit" }}
          />
          <button onClick={addManualPersona} disabled={addingPersona || !newPersonaPrompt.trim()} style={{ alignSelf: "flex-start" }}>
            {addingPersona ? "adding..." : "+ add persona"}
          </button>
        </div>
      </section>

      <section style={panelStyle}>
        <h2 style={h2Style}>Batch configuration</h2>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, marginBottom: 10 }}>
          Guide
          <select value={selectedGuide} onChange={(e) => setSelectedGuide(e.target.value)}>
            {guides.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name} ({g.targetDurationMinutes} min)
              </option>
            ))}
          </select>
        </label>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>Architectures (custom-LLM only -- native architectures have no run() to simulate)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {architectures.map((a) => (
              <label key={a.name} style={{ fontSize: 13, display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={selectedArchitectures.has(a.name)}
                  onChange={() => toggle(selectedArchitectures, setSelectedArchitectures, a.name)}
                />
                {a.name}
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Repeats per (architecture, persona)
            <input
              type="number"
              min={1}
              value={repeatsPerCombo}
              onChange={(e) => setRepeatsPerCombo(Math.max(1, Number(e.target.value)))}
              style={{ width: 80 }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Max turns (hard safety cap)
            <input
              type="number"
              min={1}
              value={maxTurns}
              onChange={(e) => setMaxTurns(Math.max(1, Number(e.target.value)))}
              style={{ width: 80 }}
            />
          </label>
        </div>

        <div
          style={{
            fontSize: 13,
            background: "color-mix(in srgb, var(--accent) 8%, var(--panel))",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
          }}
        >
          {runCount} run{runCount === 1 ? "" : "s"} ({selectedArchitectures.size} architecture(s) x {selectedPersonas.size} persona(s) x{" "}
          {repeatsPerCombo} repeat(s)) &mdash; rough estimate, up to ~${roughCostEstimate.toFixed(2)} if every run hits the {maxTurns}-turn
          cap. Real cost is usually lower (most runs end via end_call well before the cap) and varies by architecture -- this is a ceiling,
          not a forecast.
        </div>

        <button onClick={launchBatch} disabled={launching || runCount === 0}>
          {launching ? "launching..." : `Launch batch (${runCount} run${runCount === 1 ? "" : "s"})`}
        </button>
      </section>

      {runs.length > 0 && (
        <section style={panelStyle}>
          <h2 style={h2Style}>
            Live progress ({doneCount}/{runs.length} finished)
          </h2>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                <th>Architecture</th>
                <th>Persona</th>
                <th>Repeat</th>
                <th>Status</th>
                <th>Turns</th>
                <th>End reason</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td>{r.architecture}</td>
                  <td>{personas.find((p) => p.id === r.personaId)?.name ?? r.personaId.slice(0, 8)}</td>
                  <td>{r.repeatIndex}</td>
                  <td>{r.status}</td>
                  <td>{r.turnCount}</td>
                  <td>{r.endReason ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 14,
  marginBottom: 16,
};
const h2Style: React.CSSProperties = { fontSize: 14, marginTop: 0, marginBottom: 10 };
