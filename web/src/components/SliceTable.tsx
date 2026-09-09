import type { RunEvent, SliceSummary } from "../api.ts";
import { formatDurationMs } from "../lib/format.ts";
import { symbolForStatus, toneForStatus } from "./StatusBadge.tsx";

/** Last observed worker duration per slice (worker_finished durationMs). */
function durationBySlice(events: RunEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) {
    if (e.sliceId && e.type === "worker_finished" && typeof e.durationMs === "number") {
      m.set(e.sliceId, e.durationMs);
    }
  }
  return m;
}

/**
 * Execution board: dense rows that read as workflow, not a database table.
 * Each row carries state (symbol + word, never color alone), slice id and
 * title, and one meta line — effort, attempt, generation, agent lane,
 * dependency needs, duration or failure reason. Rows stay compact; the full
 * story lives in the Inspector. Board order is preserved; selecting a row
 * drives the Inspector.
 */
export default function SliceTable({
  slices,
  selected,
  onSelect,
  events = [],
}: {
  slices: SliceSummary[];
  selected?: string | null;
  onSelect: (sliceId: string) => void;
  events?: RunEvent[];
}) {
  if (slices.length === 0) {
    return (
      <section className="omp-board" aria-label="Slice board">
        <h2 className="omp-board-title">Execution board</h2>
        <p className="omp-hint">No slices yet.</p>
      </section>
    );
  }

  const durations = durationBySlice(events);

  return (
    <section className="omp-board" aria-label="Slice board">
      <ul className="omp-board-list" role="listbox" aria-label={`${slices.length} slices`}>
        {slices.map((s) => {
          const isSel = selected === s.id;
          const dur = durations.get(s.id);
          const tone = toneForStatus(s.status);
          const live = s.status === "running" || s.status === "verifying";
          return (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected={isSel}
                className="omp-board-row"
                data-selected={isSel ? "true" : "false"}
                data-tone={tone}
                data-live={live ? "true" : "false"}
                onClick={() => onSelect(s.id)}
              >
                <span aria-hidden="true" className="omp-status-sym" data-tone={tone}>
                  {symbolForStatus(s.status)}
                </span>
                <span className="omp-board-main">
                  <span className="omp-board-top">
                    <code className="omp-board-id">{s.id}</code>
                    <span className="omp-board-title-text" title={s.title}>
                      {s.title}
                    </span>
                    <span className="omp-board-state" data-tone={tone}>
                      {s.status}
                    </span>
                  </span>
                  <span className="omp-board-meta">
                    {s.effort ? `${s.effort} · ` : ""}attempt {s.attempts} · gen {s.generation}
                    {s.agent ? ` · ${s.agent}` : ""}
                    {s.deps.length > 0 ? ` · needs ${s.deps.join(", ")}` : ""}
                    {typeof dur === "number" ? ` · ${formatDurationMs(dur)}` : live ? " · working…" : ""}
                  </span>
                  {s.reason && (s.status === "failed" || s.status === "blocked-env") && (
                    <span className="omp-board-reason" title={s.reason}>
                      {s.reason}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
