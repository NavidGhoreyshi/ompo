import type { AgentRow } from "../api.ts";
import StatusBadge from "../components/StatusBadge.tsx";

export default function AgentsPage({ agents, live }: { agents: AgentRow[]; live: boolean }) {
  return (
    <section className="omp-panel" aria-label="Agents">
      <h2>Agents ({agents.length})</h2>
      {!live && agents.length === 0 ? (
        <p className="omp-hint">No live agents — the run is quiescent. Agent rows are point-in-time derivations from worker progress lines, not persisted entities.</p>
      ) : agents.length === 0 ? (
        <p className="omp-hint">No agents reporting yet.</p>
      ) : (
        <div className="omp-table-wrap">
          <table className="omp-table">
            <thead>
              <tr>
                <th scope="col">agent</th>
                <th scope="col">state</th>
                <th scope="col">attempt</th>
                <th scope="col">effort</th>
                <th scope="col">last line</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={`${a.id}-${a.lane}`} data-selected="false" style={{ cursor: "default" }}>
                  <td><code>{a.agent ? `${a.id} (${a.agent})` : a.id}</code></td>
                  <td><StatusBadge status={a.status} /></td>
                  <td>{a.attempt}</td>
                  <td>{a.effort ?? "—"}</td>
                  <td><div className="omp-ellipsis" title={a.lastLine}>{a.lastLine}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
