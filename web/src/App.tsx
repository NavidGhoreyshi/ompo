import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, type ControlKind, type RunDetail, type RunEvent, type RunSummary, type SliceSummary } from "./api.ts";

const POLL_MS = 900;

const STATUS_COLOR: Record<string, string> = {
  done: "#3fb950",
  failed: "#f85149",
  running: "#58a6ff",
  verifying: "#d29922",
  "blocked-env": "#bc8cff",
  skipped: "#8b949e",
  pending: "#8b949e",
};

function useRuns() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRuns(await api.runs());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  return { runs, error, reload: load };
}

function ControlPanel({ runId, slices, onDone }: { runId: string; slices: SliceSummary[]; onDone: () => void }) {
  const [kind, setKind] = useState<ControlKind>("retry");
  const [sliceId, setSliceId] = useState("");
  const [jobs, setJobs] = useState("4");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsSlice = kind === "retry" || kind === "skip" || kind === "park" || kind === "kill";

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const body: Record<string, unknown> = { kind };
      if (needsSlice) body.sliceId = sliceId;
      if (kind === "set-jobs") body.jobs = Number(jobs);
      if (reason.trim()) body.reason = reason.trim();
      const res = await api.control(runId, body);
      setResult(JSON.stringify(res));
      onDone();
    } catch (err) {
      setResult(`error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={box}>
      <h2 style={h2}>Control</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as ControlKind)}>
          {(["retry", "skip", "park", "kill", "set-jobs", "pause", "resume"] as const).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        {needsSlice && (
          <select value={sliceId} onChange={(e) => setSliceId(e.target.value)}>
            <option value="">— slice —</option>
            {slices.map((s) => (
              <option key={s.id} value={s.id}>{s.id} [{s.status}]</option>
            ))}
          </select>
        )}
        {kind === "set-jobs" && (
          <input value={jobs} onChange={(e) => setJobs(e.target.value)} size={3} aria-label="jobs" />
        )}
        {(kind === "park" || kind === "retry" || kind === "skip" || kind === "kill") && (
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={kind === "park" ? "reason (required)" : "reason (optional)"}
            size={28}
          />
        )}
        <button disabled={busy || (needsSlice && !sliceId)} onClick={() => void send()}>
          {busy ? "sending…" : "send"}
        </button>
      </div>
      {result && <pre style={pre}>{result}</pre>}
      <p style={hint}>Queued on live runs (loop applies in ~2s, watch the event stream); applied directly when quiescent.</p>
    </section>
  );
}

export default function App() {
  const [version, setVersion] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const { runs, error: runsError } = useRuns();
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [sliceDetail, setSliceDetail] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(-1);

  useEffect(() => {
    api.health()
      .then((h) => {
        setVersion(h.version);
        const builtAgainst = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.["VITE_OMPO_VERSION"];
        setStale(!!builtAgainst && builtAgainst !== h.version);
      })
      .catch(() => setError("dashboard API unreachable — is the ompo server running?"));
  }, []);

  useEffect(() => {
    if (!runId && runs.length > 0) setRunId(runs[runs.length - 1]!.runId);
  }, [runs, runId]);

  const loadRun = useCallback(async (id: string) => {
    try {
      const [d, ev, st] = await Promise.all([api.run(id), api.events(id), api.stats(id)]);
      setDetail(d);
      setEvents(ev.events);
      seqRef.current = ev.offset;
      setStats(st);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load + SSE live stream with polling fallback.
  useEffect(() => {
    if (!runId) return;
    void loadRun(runId);
    let stop = false;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/runs/${runId}/stream?afterSeq=${seqRef.current}`);
      es.addEventListener("event", (m) => {
        try {
          const ev = JSON.parse((m as MessageEvent).data) as RunEvent;
          if (typeof ev.seq === "number" && ev.seq > seqRef.current) {
            seqRef.current = ev.seq;
            setEvents((prev) => [...prev.slice(-400), ev]);
          }
        } catch {
          /* ignore malformed frames */
        }
      });
      es.addEventListener("run", () => void loadRun(runId));
      es.onerror = () => {
        es?.close();
        es = null;
      };
    } catch {
      es = null;
    }
    const poll = setInterval(async () => {
      if (es) return; // SSE owns updates while connected
      try {
        const ev = await api.events(runId, seqRef.current);
        if (ev.events.length > 0) {
          seqRef.current = ev.offset;
          setEvents((prev) => [...prev.slice(-400), ...ev.events]);
          await loadRun(runId);
        }
      } catch {
        /* offline tick — next poll retries */
      }
    }, POLL_MS);
    return () => {
      stop = true;
      void stop;
      es?.close();
      clearInterval(poll);
    };
  }, [runId, loadRun]);

  useEffect(() => {
    if (!runId || !sel) {
      setSliceDetail(null);
      return;
    }
    api.slice(runId, sel).then(setSliceDetail).catch(() => setSliceDetail({ error: "slice not found" }));
  }, [runId, sel]);

  const selected: SliceSummary | undefined = detail?.slices.find((s) => s.id === sel);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1100, margin: "0 auto", padding: 16 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>ompo dashboard</h1>
        {version && <span style={hint}>server {version}</span>}
        <label style={{ marginLeft: "auto" }}>
          run{" "}
          <select value={runId ?? ""} onChange={(e) => { setRunId(e.target.value); setSel(null); }}>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>{r.runId}{r.live ? " ●live" : ""}</option>
            ))}
          </select>
        </label>
      </header>
      {stale && <p style={warn}>Bundle built against a different ompo version — rebuild the dashboard (`bun run web:build`).</p>}
      {(error ?? runsError) && <p style={warn}>{error ?? runsError}</p>}
      {detail && (
        <section style={box}>
          <h2 style={h2}>{detail.runId} {detail.live ? "● live" : "○ quiescent"}</h2>
          <p style={hint}>
            done {detail.counts.done} · active {detail.counts.active} · failed {detail.counts.failed} ·{" "}
            skipped {detail.counts.skipped} · env-blocked {detail.counts.blockedEnv} · pending {detail.counts.pending}
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th>slice</th><th>title</th><th>status</th><th>attempts</th><th>reason</th>
              </tr>
            </thead>
            <tbody>
              {detail.slices.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => setSel(s.id)}
                  style={{ cursor: "pointer", background: sel === s.id ? "#1f242c" : "transparent" }}
                >
                  <td><code>{s.id}</code></td>
                  <td>{s.title}</td>
                  <td style={{ color: STATUS_COLOR[s.status] ?? "#fff" }}>{s.status}</td>
                  <td>{s.attempts}</td>
                  <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>{s.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {selected && sliceDetail && (
        <section style={box}>
          <h2 style={h2}>{selected.id} — {selected.title} [{selected.status}]</h2>
          <pre style={pre}>{JSON.stringify(sliceDetail, null, 2)}</pre>
        </section>
      )}
      {runId && detail && (
        <ControlPanel runId={runId} slices={detail.slices} onDone={() => void loadRun(runId)} />
      )}
      {stats && (
        <section style={box}>
          <h2 style={h2}>Stats</h2>
          <pre style={pre}>{JSON.stringify(stats, null, 2)}</pre>
        </section>
      )}
      <section style={box}>
        <h2 style={h2}>Events ({events.length})</h2>
        <pre style={{ ...pre, maxHeight: 320, overflow: "auto" }}>
          {events.slice(-120).map((e) => `${e.seq} ${e.at} ${e.type}${e.sliceId ? ` ${e.sliceId}` : ""}${e.reason ? ` ${e.reason}` : ""}`).join("\n")}
        </pre>
      </section>
    </main>
  );
}

const box: React.CSSProperties = { border: "1px solid #30363d", borderRadius: 8, padding: 12, marginTop: 12 };
const h2: React.CSSProperties = { margin: "0 0 8px", fontSize: 16 };
const pre: React.CSSProperties = { background: "#0d1117", color: "#e6edf3", padding: 8, borderRadius: 6, overflow: "auto" };
const hint: React.CSSProperties = { color: "#8b949e", fontSize: 12 };
const warn: React.CSSProperties = { background: "#3d2e00", border: "1px solid #d29922", padding: 8, borderRadius: 6 };
