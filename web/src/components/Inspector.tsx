import type { SliceDetail, SliceSummary } from "../api.ts";
import ControlPanel from "./ControlPanel.tsx";
import StatusBadge from "./StatusBadge.tsx";

function fmtTurns(m?: SliceDetail["metrics"]): string {
  if (!m) return "—";
  const dur = typeof m.durationMs === "number" ? ` · ${(m.durationMs / 1000).toFixed(1)}s` : "";
  return `${m.turns} turns · ${m.tools} tools${dur}`;
}

/** Right-hand inspector: selected-slice detail + contextual control. */
export default function Inspector({
  runId,
  selected,
  detail,
  onClose,
  onControlDone,
  slices,
}: {
  runId: string;
  selected: SliceSummary | undefined;
  detail: SliceDetail | Record<string, unknown> | null;
  onClose: () => void;
  onControlDone: () => void;
  slices: SliceSummary[];
}) {
  if (!selected) {
    return (
      <div className="omp-panel" aria-label="Inspector">
        <div className="omp-inspector-head">
          <h2>Inspector</h2>
        </div>
        <p className="omp-hint">Select a slice in Roadmap or Overview to inspect it. Control actions appear here, in context.</p>
      </div>
    );
  }

  const d = detail as SliceDetail | null;
  const metrics = d && typeof d === "object" && "metrics" in d ? (d as SliceDetail).metrics : undefined;

  return (
    <div className="omp-panel" aria-label="Inspector" aria-live="polite">
      <div className="omp-inspector-head">
        <h2>
          <code>{selected.id}</code> — {selected.title}
        </h2>
        <button className="omp-icon-btn" onClick={onClose} aria-label="Close inspector" style={{ marginLeft: "auto" }}>
          ✕
        </button>
      </div>
      <div style={{ marginTop: 6 }}>
        <StatusBadge status={selected.status} />
      </div>
      <dl className="omp-kv">
        <dt>attempts</dt>
        <dd>{selected.attempts}</dd>
        <dt>updated</dt>
        <dd>{selected.updatedAt}</dd>
        {selected.effort && (
          <>
            <dt>effort</dt>
            <dd>{selected.effort}</dd>
          </>
        )}
        {selected.agent && (
          <>
            <dt>agent</dt>
            <dd>{selected.agent}</dd>
          </>
        )}
        {selected.deps.length > 0 && (
          <>
            <dt>deps</dt>
            <dd>{selected.deps.join(", ")}</dd>
          </>
        )}
        {selected.reason && (
          <>
            <dt>reason</dt>
            <dd>{selected.reason}</dd>
          </>
        )}
        <dt>metrics</dt>
        <dd>{fmtTurns(metrics)}</dd>
      </dl>

      <h3>Control</h3>
      <ControlPanel runId={runId} slices={slices} initialSliceId={selected.id} onDone={onControlDone} />

      {d && (
        <>
          {d.reportSummary && (
            <details open>
              <summary>Report</summary>
              <div className="omp-detail-body">
                <pre className="omp-code" style={{ whiteSpace: "pre-wrap" }}>{d.reportSummary}</pre>
              </div>
            </details>
          )}
          {d.recentEvents.length > 0 && (
            <details open>
              <summary>Recent events</summary>
              <div className="omp-detail-body">
                <pre className="omp-code" style={{ whiteSpace: "pre-wrap" }}>{d.recentEvents.join("\n")}</pre>
              </div>
            </details>
          )}
          {d.workerTail && (
            <details>
              <summary>Worker tail{d.workerLogName ? ` (${d.workerLogName})` : ""}</summary>
              <div className="omp-detail-body">
                <pre className="omp-code">{d.workerTail}</pre>
              </div>
            </details>
          )}
          {d.promptTail && (
            <details>
              <summary>Prompt tail{d.promptName ? ` (${d.promptName})` : ""}</summary>
              <div className="omp-detail-body">
                <pre className="omp-code">{d.promptTail}</pre>
              </div>
            </details>
          )}
          <details>
            <summary>Raw detail</summary>
            <div className="omp-detail-body">
              <pre className="omp-code">{JSON.stringify(d, null, 2)}</pre>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
