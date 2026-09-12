"use client";

import { useEffect, useState } from "react";
import { Conversation } from "@elevenlabs/client";

type ArchitectureInfo = { name: string; kind: "native" | "custom" };
type Persona = { id: string; name: string; generatedProfile: string; axisValues: Record<string, unknown> };
type TranscriptLine = { role: string; text: string };
type GuideInfo = {
  studyTopic: string;
  statedPurpose: string;
  researchObjective: string;
  targetDurationMinutes: number;
};

export default function Home() {
  const [architectures, setArchitectures] = useState<ArchitectureInfo[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [guide, setGuide] = useState<GuideInfo | null>(null);
  const [callEnded, setCallEnded] = useState(false);
  const [selectedArchitecture, setSelectedArchitecture] = useState<string>("");
  const [selectedPersona, setSelectedPersona] = useState<string>("");
  const [status, setStatus] = useState<string>("idle");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [generatingPersona, setGeneratingPersona] = useState(false);

  useEffect(() => {
    fetch("/api/architectures")
      .then((r) => r.json())
      .then((d) => {
        setArchitectures(d.architectures);
        if (d.architectures[0]) setSelectedArchitecture(d.architectures[0].name);
      });
    fetch("/api/guide")
      .then((r) => r.json())
      .then(setGuide);
    refreshPersonas();
  }, []);

  function refreshPersonas() {
    fetch("/api/personas")
      .then((r) => r.json())
      .then((d) => setPersonas(d.personas));
  }

  async function generatePersona() {
    setGeneratingPersona(true);
    try {
      const res = await fetch("/api/personas/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `persona-${Date.now()}` }),
      });
      const data = await res.json();
      if (data.persona) {
        refreshPersonas();
        setSelectedPersona(data.persona.id);
      }
    } finally {
      setGeneratingPersona(false);
    }
  }

  async function startCall() {
    if (!selectedArchitecture) return;
    setStatus("provisioning...");
    setTranscript([]);
    setCallEnded(false);

    await fetch("/api/agents/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ architecture: selectedArchitecture }),
    });

    setStatus("connecting...");
    const sessionRes = await fetch("/api/agents/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ architecture: selectedArchitecture }),
    });
    const { signedUrl, error } = await sessionRes.json();
    if (error) {
      setStatus(`error: ${error}`);
      return;
    }

    const convo = await Conversation.startSession({
      signedUrl,
      onConnect: () => setStatus("connected — talk whenever you're ready"),
      onDisconnect: () => {
        setStatus("call ended");
        setCallEnded(true);
      },
      onMessage: (message: { source: string; message: string }) => {
        setTranscript((prev) => [...prev, { role: message.source, text: message.message }]);
      },
      onError: (message: string) => setStatus(`error: ${message}`),
    });
    setConversation(convo);
  }

  async function endCall() {
    await conversation?.endSession();
    setConversation(null);
    setCallEnded(true);
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Moderation Lab</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
        Pick an architecture, talk to it as the respondent, listen for how it feels.
      </p>

      {guide && (
        <div
          style={{
            background: "color-mix(in srgb, var(--accent) 10%, var(--panel))",
            border: "1px solid var(--accent)",
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <strong>Before you start ({guide.targetDurationMinutes} min) — same as what a real respondent would be told:</strong>
          <p style={{ margin: "8px 0 0", color: "var(--text)" }}>{guide.statedPurpose}</p>
        </div>
      )}

      {guide && callEnded && (
        <div
          style={{
            background: "color-mix(in srgb, var(--ok) 10%, var(--panel))",
            border: "1px solid var(--ok)",
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <strong>Now that the call's over — the real objective (kept from you until now, on purpose):</strong>
          <p style={{ margin: "8px 0 4px", fontWeight: 600 }}>{guide.studyTopic}</p>
          <p style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--text)" }}>{guide.researchObjective}</p>
          <p style={{ margin: "8px 0 0", color: "var(--muted)", fontStyle: "italic" }}>
            The moderator had this the whole time (private context, never spoken) — judge whether it actually
            got a real answer to this, not just whether the conversation felt natural.
          </p>
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Architecture
          <select value={selectedArchitecture} onChange={(e) => setSelectedArchitecture(e.target.value)}>
            {architectures.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} ({a.kind})
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Persona (reference only for now — see README)
          <select value={selectedPersona} onChange={(e) => setSelectedPersona(e.target.value)}>
            <option value="">(none)</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <button onClick={generatePersona} disabled={generatingPersona}>
          {generatingPersona ? "generating..." : "+ generate persona"}
        </button>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={startCall} disabled={!!conversation}>
            Start call
          </button>
          <button onClick={endCall} disabled={!conversation}>
            End call
          </button>
        </div>
      </div>

      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>status: {status}</div>

      {selectedPersona && (
        <div
          style={{
            fontSize: 12,
            color: "var(--muted)",
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 10,
            marginBottom: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {personas.find((p) => p.id === selectedPersona)?.generatedProfile}
        </div>
      )}

      <div
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 14,
          minHeight: "40vh",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {transcript.map((line, i) => (
          <div key={i} style={{ fontSize: 14 }}>
            <strong>{line.role}:</strong> {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
