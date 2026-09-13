import type { AgentRow } from "../api.ts";
import { LockSymbol, StatusSymbol } from "./icons.tsx";
import { toneForStatus } from "../lib/status.ts";

/**
 * Worker lanes: one compact row per live agent, sorted by lane, so
 * concurrency reads at a glance (L0 working slice A, L1 verifying slice B,
 * L2 holding the commit mutex). Pure projection over the server-derived
 * AgentRow — no second agent model. Selecting a lane makes that worker the
 * subject of the live output and the Inspector. Honest about idleness: idle
 * rows are never invented, and an empty list says why it is empty.
 *
 * `dense` is the switcher form used inside the active-execution bar: same
 * rows, tighter, no heading of its own.
 */
export default function WorkerLanes({
  agents,
  live,
  selected,
  onSelect,
  dense = false,
}: {
  agents: AgentRow[];
  /** Omitted in the dense switcher, which is only rendered for live workers. */
  live?: boolean;
  selected?: string | null;
  onSelect: (sliceId: string) => void;
  dense?: boolean;
}) {
  const lanes = [...agents].sort((a, b) => a.lane - b.lane);
  const body =
    lanes.length === 0 ? (
      <p className="omp-hint">
        {live === false ? "no live workers — run is quiescent" : "waiting for workers to report…"}
      </p>
    ) : (
      <ul className="omp-lane-list">
        {lanes.map((a) => {
          const isSel = selected === a.id;
          const locked = a.status === "verifying";
          return (
            <li key={`${a.id}-${a.lane}`}>
              <button
                type="button"
                className="omp-lane"
                data-selected={isSel ? "true" : "false"}
                data-tone={toneForStatus(a.status)}
                aria-pressed={isSel}
                onClick={() => onSelect(a.id)}
                title={a.lastLine || `${a.id} ${a.status}`}
              >
                <span className="omp-lane-id">L{a.lane}</span>
                <span aria-hidden="true" className="omp-status-sym" data-tone={toneForStatus(a.status)}>
                  <StatusSymbol status={a.status} />
                </span>
                <code className="omp-lane-slice">{a.id}</code>
                <span className="omp-lane-state">{locked ? "verify" : a.status}</span>
                <span className="omp-hint">
                  gen {a.generation} · attempt {a.attempt}
                  {locked && (
                    <span className="omp-mutex">
                      {" "}
                      · <LockSymbol /> commit
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );

  if (dense) {
    return (
      <div className="omp-lanes omp-lanes--dense" role="group" aria-label="Active workers">
        {body}
      </div>
    );
  }

  return (
    <section className="omp-lanes" aria-label="Worker lanes">
      <span className="omp-section-label">Workers</span>
      {body}
    </section>
  );
}
