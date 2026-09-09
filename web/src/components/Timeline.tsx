import { useMemo } from "react";
import type { RunEvent, SliceSummary } from "../api.ts";
import { formatDurationMs, formatSpan, formatTokens } from "../lib/format.ts";
import { buildTimeline, type TimelineAttempt } from "../lib/timeline.ts";

type Tone = "cyan" | "green" | "amber" | "red" | "muted";

function toneForOutcome(a: TimelineAttempt): Tone {
  if (a.open) return "cyan";
  switch (a.outcome) {
    case "slice_done":
      return "green";
    case "slice_failed_terminal":
      return "red";
    case "slice_blocked_env":
    case "slice_killed":
    case "slice_retried":
      return "amber";
    default:
      return "muted";
  }
}
/** Left offset of a generation tick as a % of its bar's own span. */
function tickPct(a: TimelineAttempt, h: number | null, t1Ms: number | null): number {
  if (h === null || a.startMs === null) return 50;
  const barStart = a.startMs;
  const barEnd = a.open ? (t1Ms ?? h) : (a.endMs ?? h);
  const span = Math.max(1, barEnd - barStart);
  return Math.min(100, Math.max(0, ((h - barStart) / span) * 100));
}

/** Hover/click detail: attempt, generation, tokens, duration — observed only. */
function attemptTitle(a: TimelineAttempt): string {
  const parts: string[] = [a.attempt === null ? "attempt ?" : `attempt ${a.attempt}`];
  parts.push(a.generations <= 1 ? "gen 0" : `gen 0–${a.generations - 1} (${a.handoffMs.length} handoff${a.handoffMs.length === 1 ? "" : "s"})`);
  parts.push(a.durationMs === null ? "wall —" : `wall ${formatSpan(a.durationMs)}`);
  if (a.workerMs !== null && a.workerMs !== undefined) parts.push(`worker ${formatDurationMs(a.workerMs)}`);
  parts.push(a.tokens === null ? "tokens —" : `${formatTokens(a.tokens)} tok`);
  parts.push(a.open ? `open (last: ${a.lastType})` : (a.outcome ?? a.lastType));
  return parts.join(" · ");
}

/**
 * Execution-history strip: one row per slice, one bar per observed attempt
 * on a shared wall-clock axis, so attempt boundaries, retries, generation
 * ticks (◆), concurrent overlap, and long-tail slices read at a glance.
 * Bars are observational — open attempts end at the last observed event
 * (dashed), never at an extrapolated "now"; there are no progress fills.
 */
export default function Timeline({
  events,
  slices = [],
  selected,
  onSelect,
}: {
  events: RunEvent[];
  slices?: Pick<SliceSummary, "id" | "title">[];
  selected?: string | null;
  onSelect?: (sliceId: string) => void;
}) {
  const model = useMemo(() => buildTimeline(events, slices), [events, slices]);
  const longTail = useMemo(() => new Set(model.longTailIds), [model]);

  if (model.rows.length === 0 || model.t0Ms === null || model.t1Ms === null) {
    return (
      <section className="omp-panel" aria-label="Timeline">
        <h2>Timeline</h2>
        <p className="omp-hint">No execution history yet — bars appear once slices are claimed.</p>
      </section>
    );
  }

  const t0 = model.t0Ms;
  const span = Math.max(1, (model.t1Ms ?? t0) - t0);
  const pct = (ms: number | null, fallback: number): number =>
    ms === null ? fallback : Math.min(100, Math.max(0, ((ms - t0) / span) * 100));

  const attemptCount = model.rows.reduce((n, r) => n + r.attempts.length, 0);

  return (
    <section className="omp-panel" aria-label="Timeline">
      <h2>
        Timeline — {attemptCount} attempt{attemptCount === 1 ? "" : "s"} across {model.rows.length} slice
        {model.rows.length === 1 ? "" : "s"}{" "}
        <span className="omp-hint">
          · {model.t0 && model.t1 ? `${new Date(model.t0).toLocaleTimeString()} → ${new Date(model.t1).toLocaleTimeString()} ` : ""}
          ({model.spanMs === null ? "—" : formatSpan(model.spanMs)})
        </span>
      </h2>
      <div className="omp-timeline-rows">
        {model.rows.map((row) => {
          const isSel = selected === row.sliceId;
          return (
            <div
              key={row.sliceId}
              className="omp-timeline-row"
              data-selected={isSel ? "true" : "false"}
              aria-label={`${row.sliceId}: ${row.attempts.length} attempts${row.totalMs === null ? "" : `, ${formatSpan(row.totalMs)} total`}`}
            >
              <div className="omp-timeline-label">
                <code>{row.sliceId}</code>
                {row.title && (
                  <span className="omp-ellipsis omp-sub" title={row.title}>
                    {row.title}
                  </span>
                )}
              </div>
              <div className="omp-timeline-track">
                {row.attempts.length === 0 ? (
                  <span className="omp-hint omp-timeline-empty">not started</span>
                ) : (
                  row.attempts.map((a) => {
                    const left = pct(a.startMs, 0);
                    // Open attempts render to the last observed event (t1):
                    // bounded by evidence, never extrapolated to now.
                    const endPct = a.open ? 100 : pct(a.endMs, left);
                    const width = Math.max(a.startMs !== null && a.endMs !== null && a.endMs > a.startMs ? endPct - left : 0, 0.6);
                    const title = `${row.sliceId} — ${attemptTitle(a)}`;
                    return (
                      <button
                        key={a.startSeq}
                        type="button"
                        className="omp-timeline-bar"
                        data-tone={toneForOutcome(a)}
                        data-open={a.open ? "true" : "false"}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={title}
                        aria-label={title}
                        onClick={() => onSelect?.(row.sliceId)}
                      >
                        {a.handoffMs.map((h, i) => (
                          <span
                            key={i}
                            className="omp-timeline-tick"
                            style={{ left: `${tickPct(a, h, model.t1Ms)}%` }}
                            title={`${row.sliceId} generation boundary g${i} → g${i + 1}`}
                          >
                            ◆
                          </span>
                        ))}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="omp-timeline-meta">
                {row.attempts.length > 0 && (
                  <span className="omp-hint" title={row.attempts.map(attemptTitle).join("\n")}>
                    {row.attempts.length}× · {row.totalMs === null ? "—" : formatSpan(row.totalMs)}
                  </span>
                )}
                {longTail.has(row.sliceId) && (
                  <span className="omp-badge" data-tone="amber" title="Disproportionate wall-clock share (≥2× the median slice total)">
                    <span aria-hidden="true" className="omp-badge-sym">▲</span>long-tail
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="omp-hint omp-timeline-legend">
        <span><i className="omp-timeline-swatch" data-tone="green" /> done</span>
        <span><i className="omp-timeline-swatch" data-tone="cyan" /> open</span>
        <span><i className="omp-timeline-swatch" data-tone="amber" /> retried / blocked / killed</span>
        <span><i className="omp-timeline-swatch" data-tone="red" /> failed</span>
        <span>◆ generation boundary</span>
        <span>dashed = still open at the last observed event</span>
        <span>hover or click a bar for attempt · generation · tokens · duration</span>
      </p>
    </section>
  );
}
