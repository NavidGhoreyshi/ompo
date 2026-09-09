import type { AgentRow, RunDetail, RunEvent } from "../api.ts";
import { formatElapsed, formatTokens } from "../lib/format.ts";
import { describeEvent } from "../lib/events.ts";
import { heroAction, preferredSliceId } from "../lib/selection.ts";
import { symbolForStatus, toneForStatus } from "./StatusBadge.tsx";
import { Separator } from "./ui/separator.tsx";

/**
 * Run hero, not telemetry: first glance answers "s5a is running,
 * generation 1, on worker L0, working on X — while the rest is
 * done/pending." Hierarchy: current run → what is happening (hero slice +
 * state) → which worker (lane) → what it is on (live line, else latest
 * slice event, else status fallback) → quiet telemetry (counts, elapsed,
 * tokens, workers, 12px muted). No forecasts, ETAs, or cost estimates.
 */
export default function RunHeader({
  detail,
  events,
  agents,
  activeId,
}: {
  detail: RunDetail;
  events: RunEvent[];
  agents: AgentRow[];
  activeId?: string | null;
}) {
  const counts = detail.counts;
  const hero =
    detail.slices.find((s) => s.id === activeId) ??
    detail.slices.find((s) => s.id === preferredSliceId(detail.slices)) ??
    null;
  const agent = hero ? agents.find((a) => a.id === hero.id) : undefined;
  // Latest-event fallback only where "on what?" is live information.
  // Terminal states answer with the outcome itself (done / reason).
  const liveState =
    hero !== null &&
    (hero.status === "running" ||
      hero.status === "verifying" ||
      hero.status === "pending" ||
      hero.status === "blocked" ||
      hero.status === "blocked-env");
  let lastEvent: string | null = null;
  if (hero && liveState) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.sliceId === hero.id) {
        const text = describeEvent(e).trim();
        lastEvent = text ? `${e.type} — ${text}` : e.type;
        break;
      }
    }
  }
  const action = hero
    ? heroAction({ status: hero.status, lastLine: agent?.lastLine, lastEvent, reason: hero.reason, deps: hero.deps })
    : null;

  let tokens: number | null = null;
  for (const e of events) {
    const t = e.stats?.tokens?.total;
    if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
      tokens = (tokens ?? 0) + t;
    }
  }

  return (
    <section className="omp-runline" aria-label="Run status">
      <p className="omp-runline-eyebrow">
        <span className="omp-section-label">Run</span>
        <span className="omp-runline-id">{detail.runId}</span>
        <span className="omp-hint">
          {detail.live ? "live" : "quiescent"} · updated {new Date(detail.updatedAt).toLocaleString()}
        </span>
      </p>
      {hero ? (
        <div className="omp-hero">
          <h1 className="omp-hero-title">
            <span aria-hidden="true" className="omp-status-sym" data-tone={toneForStatus(hero.status)}>
              {symbolForStatus(hero.status)}
            </span>
            <code className="omp-hero-id">{hero.id}</code>
            <span className="omp-hero-name" title={hero.title}>
              {hero.title}
            </span>
            <span className="omp-hero-status" data-tone={toneForStatus(hero.status)}>
              {hero.status}
            </span>
          </h1>
          <p className="omp-hero-sub">
            gen {hero.generation} · attempt {hero.attempts}
            {agent ? ` · L${agent.lane}` : hero.agent ? ` · ${hero.agent}` : ""}
            {action ? ` · ${action}` : ""}
          </p>
        </div>
      ) : (
        <p className="omp-hint">No slices yet.</p>
      )}
      {hero && <Separator className="my-0.5 opacity-70" />}
      <p className="omp-runline-telemetry" aria-label="Run counts">
        <span className="omp-stat">
          <strong>{counts.done}</strong> done
        </span>
        <span className="omp-stat" data-tone="cyan">
          <strong>{counts.active}</strong> active
        </span>
        <span className="omp-stat">
          <strong>{counts.pending}</strong> pending
        </span>
        <span className="omp-stat" data-tone={counts.failed > 0 ? "red" : undefined}>
          <strong>{counts.failed}</strong> failed
        </span>
        {counts.blockedEnv > 0 && (
          <span className="omp-stat" data-tone="amber" title="slices parked on environment failures (operator must fix the environment)">
            <strong>{counts.blockedEnv}</strong> blocked-env
          </span>
        )}
        {counts.skipped > 0 && (
          <span className="omp-stat">
            <strong>{counts.skipped}</strong> skipped
          </span>
        )}
        <span className="omp-stat" title={`created ${detail.createdAt} · updated ${detail.updatedAt}`}>
          {formatElapsed(detail.createdAt, detail.updatedAt)}
        </span>
        <span
          className="omp-stat"
          title={
            tokens === null
              ? "no finished worker has reported token usage yet"
              : "sum of stats.tokens.total over finished worker events"
          }
        >
          {tokens === null ? "—" : formatTokens(tokens)} tokens
        </span>
        <span className="omp-stat">
          {detail.workers} worker{detail.workers === 1 ? "" : "s"}
        </span>
      </p>
    </section>
  );
}
