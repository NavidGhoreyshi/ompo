import type { RunEvent, SliceSummary } from "../api.ts";
import { formatDurationMs } from "../lib/format.ts";
import StatusBadge from "./StatusBadge.tsx";

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
 * Slice board: the run's primary operating table. Board order is preserved;
 * selecting a row drives the Inspector (control lives there, in context).
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
      <section className="omp-panel" aria-label="Slice board">
        <h2>Slice board</h2>
        <p className="omp-hint">No slices yet.</p>
      </section>
    );
  }

  const durations = durationBySlice(events);

  return (
    <section className="omp-panel" aria-label="Slice board">
      <h2>Slice board — {slices.length} slices</h2>
      <div className="omp-table-wrap">
        <table className="omp-table">
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Title</th>
              <th scope="col">Effort</th>
              <th scope="col">Depends</th>
              <th scope="col">Verify</th>
              <th scope="col">Status</th>
              <th scope="col">Attempt</th>
              <th scope="col">Gen</th>
              <th scope="col">Agent</th>
              <th scope="col">Duration</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => {
              const isSel = selected === s.id;
              const dur = durations.get(s.id);
              return (
                <tr
                  key={s.id}
                  data-selected={isSel ? "true" : "false"}
                  aria-selected={isSel}
                  onClick={() => onSelect(s.id)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(s.id);
                    }
                  }}
                >
                  <td>
                    <code>{s.id}</code>
                  </td>
                  <td>
                    <div className="omp-ellipsis" title={s.title}>
                      {s.title}
                    </div>
                    {s.reason && (
                      <div className="omp-sub omp-ellipsis" title={s.reason}>
                        {s.reason}
                      </div>
                    )}
                  </td>
                  <td>{s.effort ?? "—"}</td>
                  <td>
                    {s.deps.length === 0 ? (
                      "—"
                    ) : (
                      <span className="omp-ellipsis" title={s.deps.join(", ")}>
                        {s.deps.join(", ")}
                      </span>
                    )}
                  </td>
                  <td>
                    {s.verify.length === 0 ? (
                      "—"
                    ) : (
                      <span className="omp-ellipsis" title={s.verify.join("\n")}>
                        {s.verify.length} check{s.verify.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td>{s.attempts}</td>
                  <td>{s.generation}</td>
                  <td>
                    {s.agent ? (
                      <span className="omp-ellipsis" title={s.agent}>
                        {s.agent}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td title={typeof dur === "number" ? `${dur}ms (last worker_finished)` : "no finished worker yet"}>
                    {formatDurationMs(dur)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="omp-hint">Select a row to inspect it — control actions live in the inspector, in context.</p>
    </section>
  );
}
