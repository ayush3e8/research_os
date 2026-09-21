"use client";

import { useEffect, useRef, useState } from "react";
import { Conversation } from "@elevenlabs/client";
import { TIH_STIMULUS_DOCUMENT, TIH_SCALE_1, TIH_SCALE_2 } from "@/lib/guide";

type ArchitectureInfo = { name: string; kind: "native" | "custom" };
type Persona = { id: string; name: string; generatedProfile: string; axisValues: Record<string, unknown> };
type TranscriptLine = { role: string; text: string };
type GuideInfo = {
  name: string;
  studyTopic: string;
  statedPurpose: string;
  researchObjective: string;
  targetDurationMinutes: number;
};

export default function Home() {
  const [architectures, setArchitectures] = useState<ArchitectureInfo[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [guides, setGuides] = useState<GuideInfo[]>([]);
  const [callEnded, setCallEnded] = useState(false);
  const [selectedArchitecture, setSelectedArchitecture] = useState<string>("");
  const [selectedGuide, setSelectedGuide] = useState<string>("");
  const [selectedPersona, setSelectedPersona] = useState<string>("");
  const [status, setStatus] = useState<string>("idle");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [generatingPersona, setGeneratingPersona] = useState(false);
  // lib/architectures/blindmod.ts's show_stimulus/show_scale_1/show_scale_2
  // client tools -- only that architecture ever calls these, everything
  // else leaves this state untouched. scaleResolverRef holds the promise
  // resolver ElevenLabs' clientTools handler is blocked on until the tester
  // taps a number, per @elevenlabs/client's ClientToolsConfig contract.
  const [stimulusOpen, setStimulusOpen] = useState(false);
  const [pendingScale, setPendingScale] = useState<{ prompt: string; scale: string } | null>(null);
  const scaleResolverRef = useRef<((value: number) => void) | null>(null);

  const guide = guides.find((g) => g.name === selectedGuide) ?? null;

  function submitScale(value: number) {
    scaleResolverRef.current?.(value);
    scaleResolverRef.current = null;
    setPendingScale(null);
  }

  useEffect(() => {
    fetch("/api/architectures")
      .then((r) => r.json())
      .then((d) => {
        setArchitectures(d.architectures);
        if (d.architectures[0]) setSelectedArchitecture(d.architectures[0].name);
      });
    // Picked per call, not fixed -- once you've heard a guide's questions
    // once, a repeat call on the same one stops being a fair test (answers
    // stop being spontaneous), so pick whichever one you haven't used yet.
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
    if (!selectedArchitecture || !selectedGuide) return;
    setStatus("provisioning...");
    setTranscript([]);
    setCallEnded(false);
    setStimulusOpen(false);
    setPendingScale(null);
    scaleResolverRef.current = null;

    await fetch("/api/agents/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ architecture: selectedArchitecture, guide: selectedGuide }),
    });

    setStatus("connecting...");
    const sessionRes = await fetch("/api/agents/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ architecture: selectedArchitecture, guide: selectedGuide }),
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
        setStimulusOpen(false);
        setPendingScale(null);
        scaleResolverRef.current = null;
        // Fire-and-forget: evaluation runs automatically after every call,
        // no separate step. The UI doesn't wait on it -- check the
        // /evaluations page once it's done.
        fetch("/api/evaluations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ architecture: selectedArchitecture }),
        }).catch(() => {});
      },
      onMessage: (message: { source: string; message: string }) => {
        setTranscript((prev) => [...prev, { role: message.source, text: message.message }]);
      },
      onError: (message: string) => setStatus(`error: ${message}`),
      clientTools: {
        show_stimulus: async () => {
          setStimulusOpen(true);
          return "shown";
        },
        show_scale_1: () =>
          new Promise<number>((resolve) => {
            scaleResolverRef.current = resolve;
            setPendingScale({ prompt: TIH_SCALE_1.prompt, scale: TIH_SCALE_1.scale });
          }),
        show_scale_2: () =>
          new Promise<number>((resolve) => {
            scaleResolverRef.current = resolve;
            setPendingScale({ prompt: TIH_SCALE_2.prompt, scale: TIH_SCALE_2.scale });
          }),
      },
    });
    setConversation(convo);
  }

  async function endCall() {
    // endSession() triggers onDisconnect below, which is where evaluation
    // gets triggered -- not duplicated here.
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
          Guide (pick a fresh one each time — repeats aren't a fair test)
          <select value={selectedGuide} onChange={(e) => setSelectedGuide(e.target.value)}>
            {guides.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name}
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
          <button onClick={startCall} disabled={!!conversation || !selectedGuide}>
            Start call
          </button>
          <button onClick={endCall} disabled={!conversation}>
            End call
          </button>
        </div>
      </div>

      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>status: {status}</div>

      {stimulusOpen && (
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--accent)",
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <strong>Treatment profile</strong>
          <p style={{ margin: "8px 0", whiteSpace: "pre-wrap", color: "var(--text)" }}>{TIH_STIMULUS_DOCUMENT}</p>
          <button onClick={() => setStimulusOpen(false)}>I&apos;ve read this</button>
        </div>
      )}

      {pendingScale && (
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--accent)",
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <p style={{ margin: "0 0 4px", color: "var(--text)" }}>{pendingScale.prompt}</p>
          <p style={{ margin: "0 0 8px", color: "var(--muted)", fontSize: 12 }}>{pendingScale.scale}</p>
          <div style={{ display: "flex", gap: 8 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} onClick={() => submitScale(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

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
