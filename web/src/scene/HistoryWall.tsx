/**
 * The history wall's DOM list (roadmap slice `d07`).
 *
 * The 3D wall behind the rail is inert geometry: it says *how many* runs there
 * are and which one the deck is on. This is the half that answers the rest —
 * identity, status, counts, the live marker, when it was last updated — and it
 * is where a run is actually chosen, so no DOM-to-3D hit area exists anywhere
 * (red-team #3). Row semantics are the dashboard's `RunsPage` ones, minus
 * every control: a run is opened, never resumed, parked or retried from here
 * (control stays in the inspector/dock, where the guards live — `d08`).
 *
 * Switching runs goes through the shell's existing `openRun`, the same path
 * the runs table and the header's picker use: the deck does not know what a
 * run switch does, it only asks for one.
 */

import { useState } from "react";
import type { RunSummary } from "../api.ts";
import StatusBadge from "../components/StatusBadge.tsx";
import { formatElapsed } from "../lib/format.ts";

/** Rows before the "show all" affordance — the roadmap's wall default. */
export const WALL_ROWS = 20;

export default function HistoryWall({
  runs,
  activeRunId,
  onOpenRun,
  onClose,
}: {
  /** `api.runs()` as the shell polls it — oldest first. */
  runs: RunSummary[];
  /** The run the deck is projecting (`DeckModel.runId`). */
  activeRunId: string | null;
  onOpenRun: (runId: string) => void;
  /** Close the list (`Esc` closes it too, from the deck's own keys). */
  onClose: () => void;
}) {
  const newestFirst = [...runs].reverse();
  const [all, setAll] = useState(false);
  const listed = all ? newestFirst : newestFirst.slice(0, WALL_ROWS);
  const hidden = newestFirst.length - listed.length;

  return (
    <section className="omp-deck-wall" aria-label="All runs">
      <header className="omp-deck-wall-head">
        <strong>Runs ({runs.length})</strong>
        <span className="omp-deck-wall-hint">opening a run switches the whole deck — read-only, no control</span>
        <button type="button" className="omp-deck-wall-close" aria-label="Close the runs list" onClick={onClose}>
          ✕
        </button>
      </header>
      {newestFirst.length === 0 ? (
        <p className="omp-deck-wall-empty">No runs yet.</p>
      ) : (
        <ul className="omp-deck-wall-rows">
          {listed.map((run) => {
            const current = run.runId === activeRunId;
            const total = run.total ?? run.counts.done + run.counts.active + run.counts.failed + run.counts.pending;
            return (
              <li key={run.runId}>
                <button
                  type="button"
                  className="omp-deck-wall-row"
                  aria-current={current ? "true" : undefined}
                  data-live={run.live ? "true" : "false"}
                  title={`created ${run.createdAt} · updated ${run.updatedAt}`}
                  onClick={() => onOpenRun(run.runId)}
                >
                  <code className="omp-deck-wall-id">{run.runId}</code>
                  <StatusBadge status={run.status ?? (run.live ? "running" : "pending")} />
                  <span className="omp-deck-wall-counts">
                    {run.counts.done}/{total} done · {run.counts.active} active · {run.counts.failed} failed
                  </span>
                  <span className="omp-deck-wall-ago">
                    {formatElapsed(run.createdAt, run.updatedAt)} · updated {new Date(run.updatedAt).toLocaleTimeString()}
                  </span>
                  {run.live && <span className="omp-deck-wall-live">● live</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" className="omp-deck-wall-more" onClick={() => setAll(true)}>
          show all {newestFirst.length}
        </button>
      )}
    </section>
  );
}
