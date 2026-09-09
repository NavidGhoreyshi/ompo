import { useEffect, useState } from "react";
import { api, type ControlIntent, type ControlKind, type SliceSummary } from "../api.ts";

/**
 * Contextual control: prefilled from the current selection (inspector or
 * roadmap row), not a permanent giant menu. Same ControlIntent contract as
 * `ompo ctl` (arch §5).
 */
export default function ControlPanel({
  runId,
  slices,
  initialSliceId,
  onDone,
}: {
  runId: string;
  slices: SliceSummary[];
  initialSliceId?: string | null;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<ControlKind>("retry");
  const [sliceId, setSliceId] = useState(initialSliceId ?? "");
  const [jobs, setJobs] = useState("4");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsSlice = kind === "retry" || kind === "skip" || kind === "park" || kind === "kill";

  // Follow the inspector selection: locked when a context slice is provided.
  useEffect(() => {
    if (initialSliceId !== undefined) setSliceId(initialSliceId ?? "");
  }, [initialSliceId]);
  const locked = initialSliceId !== undefined;
  const target = locked ? (initialSliceId ?? "") : sliceId;

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const body: ControlIntent = { kind };
      if (needsSlice) body.sliceId = target;
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
    <section aria-label="Control">
      <div className="omp-controls">
        <select className="omp-select" value={kind} onChange={(e) => setKind(e.target.value as ControlKind)} aria-label="Control kind">
          {(["retry", "skip", "park", "kill", "set-jobs", "pause", "resume"] as const).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        {needsSlice && (
          locked ? (
            <code>{target || "— select a slice —"}</code>
          ) : (
            <select className="omp-select" value={sliceId} onChange={(e) => setSliceId(e.target.value)} aria-label="Target slice">
              <option value="">— slice —</option>
              {slices.map((s) => (
                <option key={s.id} value={s.id}>{s.id} [{s.status}]</option>
              ))}
            </select>
          )
        )}
        {kind === "set-jobs" && (
          <input className="omp-input" value={jobs} onChange={(e) => setJobs(e.target.value)} size={3} aria-label="jobs" />
        )}
        {(kind === "park" || kind === "retry" || kind === "skip" || kind === "kill") && (
          <input
            className="omp-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={kind === "park" ? "reason (required)" : "reason (optional)"}
            size={24}
          />
        )}
        <button className="omp-btn" data-primary="true" disabled={busy || (needsSlice && !target)} onClick={() => void send()}>
          {busy ? "sending…" : "send"}
        </button>
      </div>
      {result && <pre className="omp-code" style={{ marginTop: 8 }}>{result}</pre>}
      <p className="omp-hint">Queued on live runs (loop applies in ~2s, watch Activity); applied directly when quiescent.</p>
    </section>
  );
}
