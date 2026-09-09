import type { RunSummary } from "../api.ts";

export default function RunsPage({
  runs,
  activeRunId,
  onOpen,
}: {
  runs: RunSummary[];
  activeRunId: string | null;
  onOpen: (runId: string) => void;
}) {
  return (
    <section className="omp-panel" aria-label="Runs">
      <h2>Runs ({runs.length})</h2>
      {runs.length === 0 ? (
        <p className="omp-hint">No runs yet.</p>
      ) : (
        <div className="omp-table-wrap">
          <table className="omp-table">
            <thead>
              <tr>
                <th scope="col">run</th>
                <th scope="col">state</th>
                <th scope="col">done</th>
                <th scope="col">active</th>
                <th scope="col">failed</th>
                <th scope="col">pending</th>
                <th scope="col">workers</th>
                <th scope="col">updated</th>
                <th scope="col"><span className="omp-hint">open</span></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.runId}
                  data-selected={r.runId === activeRunId ? "true" : "false"}
                  onClick={() => onOpen(r.runId)}
                >
                  <td><code>{r.runId}</code></td>
                  <td>{r.live ? "● live" : "○ quiescent"}</td>
                  <td>{r.counts.done}</td>
                  <td>{r.counts.active}</td>
                  <td>{r.counts.failed}</td>
                  <td>{r.counts.pending}</td>
                  <td>{r.workers}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(r.updatedAt).toLocaleString()}</td>
                  <td>
                    <button className="omp-btn" onClick={(e) => { e.stopPropagation(); onOpen(r.runId); }}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
