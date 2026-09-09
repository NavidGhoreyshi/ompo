import type { AgentRow } from "../api.ts";
import { symbolForStatus, toneForStatus } from "./StatusBadge.tsx";

/**
 * Worker lanes: one compact row per live agent, sorted by lane, so
 * concurrency reads at a glance (L0 working slice A, L1 verifying slice B,
 * L3 holding the commit mutex). Pure projection over the server-derived
 * AgentRow — no second agent model. Selecting a lane selects its slice in
 * the Inspector. Honest about idleness: unknown total lane counts are never
 * invented, so idle rows appear only as a single quiescent/waiting note.
 */
export default function WorkerLanes({
  agents,
  live,
  selected,
  onSelect,
}: {
  agents: AgentRow[];
  live: boolean;
  selected?: string | null;
  onSelect: (sliceId: string) => void;
}) {
  const lanes = [...agents].sort((a, b) => a.lane - b.lane);
  return (
    <section className="omp-lanes" aria-label="Worker lanes">
      <span className="omp-section-label">Workers</span>
      {lanes.length === 0 ? (
        <p className="omp-hint">{live ? "live run — waiting for workers to report…" : "no live workers — run is quiescent"}</p>
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
                  onClick={() => onSelect(a.id)}
                  title={a.lastLine || `${a.id} ${a.status}`}
                >
                  <span className="omp-lane-id">L{a.lane}</span>
                  <span aria-hidden="true" className="omp-status-sym" data-tone={toneForStatus(a.status)}>
                    {symbolForStatus(a.status)}
                  </span>
                  <code className="omp-lane-slice">{a.id}</code>
                  <span className="omp-lane-state">{locked ? "VERIFY" : a.status.toUpperCase()}</span>
                  <span className="omp-hint">
                    attempt {a.attempt} · gen {a.generation}
                    {locked ? " · 🔒 commit" : ""}
                  </span>
                  <span className="omp-ellipsis omp-lane-last" title={a.lastLine || undefined}>
                    {a.lastLine || "—"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
