import type { RunSummary } from "../api.ts";
import StatusBadge from "../components/StatusBadge.tsx";
import { formatCostUsd } from "../components/Usage.tsx";
import { formatElapsed, formatTokens } from "../lib/format.ts";

/**
 * Historical run browser: one row per run with the observed columns the
 * store can answer authoritatively (status, started, duration, slice
 * counts, retries, handoffs, tokens, cost). Tokens/cost sum finished-worker
 * envelopes on the server — unknown renders "—", never 0 or an estimate.
 * Selecting a row switches the entire workspace to that run via onOpen
 * (same path as the header run picker). No run comparison here.
 */
export default function RunsPage({
  runs,
  activeRunId,
  onOpen,
}: {
  runs: RunSummary[];
  activeRunId: string | null;
  onOpen: (runId: string) => void;
}) {
  const ordered = [...runs].reverse();
  return (
    <section className="omp-panel" aria-label="Runs">
      <h2>Runs ({runs.length})</h2>
      <p className="omp-hint">Selecting a run switches the entire workspace to that run.</p>
      {ordered.length === 0 ? (
        <p className="omp-hint">No runs yet.</p>
      ) : (
        <div className="omp-table-wrap">
          <table className="omp-table">
            <thead>
              <tr>
                <th scope="col">run</th>
                <th scope="col">status</th>
                <th scope="col">started</th>
                <th scope="col">duration</th>
                <th scope="col" title="slices done / total">slices</th>
                <th scope="col">active</th>
                <th scope="col">failed</th>
                <th scope="col">pending</th>
                <th scope="col" title="extra attempts beyond the first per slice">retries</th>
                <th scope="col" title="fresh-context handoffs recorded in handoffs.json">handoffs</th>
                <th scope="col" title="sum of worker_finished stats.tokens.total where reported">tokens</th>
                <th scope="col" title="sum of stats.tokens.cost.total where the envelope reported cost">cost</th>
                <th scope="col"><span className="omp-hint">open</span></th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r) => {
                const selected = r.runId === activeRunId;
                const total = r.total ?? r.counts.done + r.counts.active + r.counts.failed + r.counts.pending;
                return (
                  <tr
                    key={r.runId}
                    data-selected={selected ? "true" : "false"}
                    aria-current={selected ? "true" : undefined}
                    tabIndex={0}
                    title={`${r.runId} · ${r.live ? "live" : "quiescent"} · skipped ${r.counts.skipped} · blocked-env ${r.counts.blockedEnv}`}
                    onClick={() => onOpen(r.runId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpen(r.runId);
                      }
                    }}
                  >
                    <td>
                      <code>{r.runId}</code>
                      {r.live && <span className="omp-hint"> ●live</span>}
                    </td>
                    <td><StatusBadge status={r.status ?? (r.live ? "running" : "pending")} /></td>
                    <td style={{ whiteSpace: "nowrap" }}>{new Date(r.createdAt).toLocaleString()}</td>
                    <td
                      style={{ whiteSpace: "nowrap" }}
                      title={`created ${r.createdAt} · updated ${r.updatedAt}`}
                    >
                      {formatElapsed(r.createdAt, r.updatedAt)}
                    </td>
                    <td title={`done ${r.counts.done} · skipped ${r.counts.skipped} · blocked-env ${r.counts.blockedEnv} of ${total}`}>
                      {r.counts.done}/{total}
                    </td>
                    <td>{r.counts.active}</td>
                    <td>{r.counts.failed}</td>
                    <td>{r.counts.pending}</td>
                    <td>{r.retries ?? "—"}</td>
                    <td>{r.handoffs ?? "—"}</td>
                    <td title={r.tokens === null || r.tokens === undefined ? "no finished worker reported token usage" : `sum of worker_finished stats.tokens.total: ${r.tokens}`}>
                      {r.tokens === null || r.tokens === undefined ? "—" : formatTokens(r.tokens)}
                    </td>
                    <td title={r.cost === null || r.cost === undefined ? "no usage envelope reported cost" : `authoritative USD total: $${r.cost}`}>
                      {r.cost === null || r.cost === undefined ? "—" : formatCostUsd(r.cost)}
                    </td>
                    <td>
                      <button className="omp-btn" onClick={(e) => { e.stopPropagation(); onOpen(r.runId); }} aria-label={`Open run ${r.runId}`}>
                        Open
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
