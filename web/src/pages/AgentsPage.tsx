import type { AgentRow } from "../api.ts";
import AgentCard from "../components/AgentCard.tsx";

export default function AgentsPage({
  agents,
  live,
  selected,
  onSelect,
}: {
  agents: AgentRow[];
  live: boolean;
  selected?: string | null;
  onSelect?: (sliceId: string) => void;
}) {
  return (
    <div className="omp-page" aria-label="Agents workspace">
    <section className="omp-panel" aria-label="Agents">
      <h2>Agents ({agents.length})</h2>
      {!live && agents.length === 0 ? (
        <p className="omp-hint">No live agents — the run is quiescent. Agent rows are point-in-time derivations from worker progress lines, not persisted entities.</p>
      ) : agents.length === 0 ? (
        <p className="omp-hint">No agents reporting yet.</p>
      ) : (
        <>
        <div className="omp-table-wrap">
          <table className="omp-table" data-table="agents">
            <thead>
              <tr>
                <th scope="col">lane</th>
                <th scope="col">slice</th>
                <th scope="col">state</th>
                <th scope="col">attempt</th>
                <th scope="col">duration</th>
                <th scope="col">usage</th>
                <th scope="col" title="verify+merge commit mutex holder">mutex</th>
                <th scope="col">last line</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <AgentCard key={`${a.id}-${a.lane}`} agent={a} selected={selected === a.id} onSelect={onSelect} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="omp-hint">Select a row to inspect its slice — 🔒 holds the verify+merge commit mutex. Usage is the last finished worker where available, else turns/tools.</p>
        </>
      )}
    </section>
    </div>
  );
}
