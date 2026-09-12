import type { AgentRow, RunEvent, SliceSummary } from "../api.ts";
import { StatusSymbol } from "./icons.tsx";
import { toneForStatus } from "./StatusBadge.tsx";
import { formatDurationMs } from "../lib/format.ts";

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
 * Execution board: flat rows that read as workflow, not a database table.
 * A 3px left border carries status color; the selected row uses the
 * brand/selection signal instead (selected and running are different facts
 * and a row can be both). Each row: status glyph → id above title + meta
 * stacked → trailing status word + duration, right-aligned. Selecting a row
 * drives the Inspector.
 */
export default function SliceTable({
  slices,
  selected,
  onSelect,
  events = [],
  agents = [],
}: {
  slices: SliceSummary[];
  selected?: string | null;
  onSelect: (sliceId: string) => void;
  events?: RunEvent[];
  agents?: AgentRow[];
}) {
  if (slices.length === 0) {
    return (
      <section className="omp-board" aria-label="Slice board">
        <p className="omp-hint">no slices yet</p>
      </section>
    );
  }

  const durations = durationBySlice(events);
  const lanes = new Map(agents.map((a) => [a.id, a.lane]));

  return (
    <section className="omp-board" aria-label="Slice board">
      <ul className="omp-board-list" role="listbox" aria-label={`${slices.length} slices`}>
        {slices.map((s) => {
          const isSel = selected === s.id;
          const dur = durations.get(s.id);
          const tone = toneForStatus(s.status);
          const live = s.status === "running" || s.status === "verifying";
          const lane = lanes.get(s.id);
          const durText = typeof dur === "number" ? formatDurationMs(dur) : live ? "working…" : "";
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
                <span aria-hidden="true" className="omp-board-glyph" data-tone={tone}>
                  <StatusSymbol status={s.status} />
                </span>
                <span className="omp-board-main">
                  <code className="omp-board-id">{s.id}</code>
                  <span className="omp-board-title-text" title={s.title}>
                    {s.title}
                  </span>
                  <span className="omp-board-meta">
                    {s.effort ? `${s.effort} · ` : ""}attempt {s.attempts} · gen {s.generation}
                    {lane !== undefined ? ` · L${lane}` : s.agent ? ` · ${s.agent}` : ""}
                    {s.deps.length > 0 ? ` · needs ${s.deps.join(", ")}` : ""}
                  </span>
                  {s.reason && (s.status === "failed" || s.status === "blocked-env") && (
                    <span className="omp-board-reason" title={s.reason}>
                      {s.reason}
                    </span>
                  )}
                </span>
                <span className="omp-board-side">
                  <span className="omp-board-state" data-tone={tone}>
                    {s.status}
                  </span>
                  {durText && <span className="omp-board-dur">{durText}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
