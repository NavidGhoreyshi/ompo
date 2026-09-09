import type { RunDetail, RunEvent } from "../api.ts";
import { formatElapsed, formatTokens } from "../lib/format.ts";

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
  const total = detail.slices.length;
  let done = 0;
  let running = 0;
  let failed = 0;
  let pending = 0;
  for (const s of detail.slices) {
    if (s.status === "done") done++;
    else if (s.status === "running" || s.status === "verifying") running++;
    else if (s.status === "failed") failed++;
    else if (s.status === "pending") pending++;
  }

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
      <h2>
        {detail.runId}{" "}
        <span className="omp-hint">
          · {detail.live ? "live" : "quiescent"} · updated{" "}
          {new Date(detail.updatedAt).toLocaleString()}
        </span>
      </h2>
      <div className="omp-cards" role="list">
        <div className="omp-stat-card" role="listitem">
          <div className="omp-stat-num">{total}</div>
          <div className="omp-stat-label">total slices</div>
        </div>
        <div className="omp-stat-card" data-tone="green" role="listitem">
          <div className="omp-stat-num">{done}</div>
          <div className="omp-stat-label">done</div>
        </div>
        <div className="omp-stat-card" data-tone="cyan" role="listitem">
          <div className="omp-stat-num">{running}</div>
          <div className="omp-stat-label">running</div>
        </div>
        <div className="omp-stat-card" data-tone="red" role="listitem">
          <div className="omp-stat-num">{failed}</div>
          <div className="omp-stat-label">failed</div>
        </div>
        <div className="omp-stat-card" role="listitem">
          <div className="omp-stat-num">{pending}</div>
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
