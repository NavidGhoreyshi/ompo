import type { RunDetail, RunEvent } from "../api.ts";
import { formatElapsed, formatTokens } from "../lib/format.ts";
import StatusBadge from "./StatusBadge.tsx";

/**
 * Run header: real observed values only — totals derived from the run
 * cursor, elapsed from created/updated timestamps, token spend summed
 * from finished-worker event stats where the backend reports them.
 * No forecasts, ETAs, or cost estimates (no authoritative source).
 */
export default function RunHeader({
  detail,
  events,
}: {
  detail: RunDetail;
  events: RunEvent[];
}) {
  // Server-authoritative board counts (same shape the TUI renders:
  // done · active · failed · blockedEnv · skipped · pending, where pending
  // counts every non-done/non-failed/non-skipped slice, so it includes the
  // active ones). Never recomputed locally — a local recount silently drops
  // blocked-env/skipped slices from the header.
  const counts = detail.counts;

  // Authoritative token spend: every finished worker attempt reports
  // stats.tokens; each attempt spent real budget, so sum all of them.
  let tokens: number | null = null;
  for (const e of events) {
    const t = e.stats?.tokens?.total;
    if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
      tokens = (tokens ?? 0) + t;
    }
  }
  return (
    <section className="omp-panel" aria-label="Run header">
      <span className="omp-eyebrow">Run</span>
      <h2>
        {detail.runId}{" "}
        <StatusBadge status={detail.status} />{" "}
        <span className="omp-hint">
          · {detail.live ? "live" : "quiescent"} · updated{" "}
          {new Date(detail.updatedAt).toLocaleString()}
        </span>
      </h2>
      <div className="omp-cards" role="list">
        <div className="omp-stat-card" role="listitem">
          <div className="omp-stat-num">{detail.total}</div>
          <div className="omp-stat-label">total slices</div>
        </div>
        <div className="omp-stat-card" data-tone="green" role="listitem">
          <div className="omp-stat-num">{counts.done}</div>
          <div className="omp-stat-label">done</div>
        </div>
        <div className="omp-stat-card" data-tone="cyan" role="listitem">
          <div className="omp-stat-num">{counts.active}</div>
          <div className="omp-stat-label">running</div>
        </div>
        <div className="omp-stat-card" data-tone="red" role="listitem">
          <div className="omp-stat-num">{counts.failed}</div>
          <div className="omp-stat-label">failed</div>
        </div>
        <div className="omp-stat-card" data-tone="amber" role="listitem" title="slices parked on environment failures (operator must fix the environment)">
          <div className="omp-stat-num">{counts.blockedEnv}</div>
          <div className="omp-stat-label">blocked-env</div>
        </div>
        <div className="omp-stat-card" role="listitem">
          <div className="omp-stat-num">{counts.skipped}</div>
          <div className="omp-stat-label">skipped</div>
        </div>
        <div
          className="omp-stat-card"
          role="listitem"
          title="non-done/non-failed/non-skipped slices (includes the running ones — TUI parity)"
        >
          <div className="omp-stat-num">{counts.pending}</div>
          <div className="omp-stat-label">pending</div>
        </div>
        <div className="omp-stat-card" data-tone="cyan" role="listitem">
          <div className="omp-stat-num">{detail.workers}</div>
          <div className="omp-stat-label">active workers</div>
        </div>
        <div
          className="omp-stat-card"
          role="listitem"
          title={`created ${detail.createdAt} · updated ${detail.updatedAt}`}
        >
          <div className="omp-stat-num">{formatElapsed(detail.createdAt, detail.updatedAt)}</div>
          <div className="omp-stat-label">elapsed</div>
        </div>
        <div
          className="omp-stat-card"
          role="listitem"
          title={
            tokens === null
              ? "no finished worker has reported token usage yet"
              : "sum of stats.tokens.total over finished worker events"
          }
        >
          <div className="omp-stat-num">{tokens === null ? "—" : formatTokens(tokens)}</div>
          <div className="omp-stat-label">tokens</div>
        </div>
      </div>
    </section>
  );
}
