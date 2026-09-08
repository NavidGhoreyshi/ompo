/**
 * ompo CI formats — machine-readable renderings of a run's event stream.
 *
 * Pure (except `jobSummaryPaths`, which only stats files): formats a single
 * event for `--format pretty|json|tap|github`, maps events to GitHub workflow
 * annotations, renders a fixed-width progress bar, lists the run docs worth
 * attaching to a job summary, and reduces status counts + events to a
 * header/progress triple. The parent wires these into `ompo ci`.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./store.ts";
import type { RunEvent } from "./types.ts";

export type CiFormat = "pretty" | "json" | "tap" | "github";

const VALID_FORMATS: readonly CiFormat[] = ["pretty", "json", "tap", "github"];

/** Parse `--format`; undefined defaults to pretty. Throws on unknown values. */
export function parseCiFormat(raw?: string): CiFormat {
  if (raw === undefined) return "pretty";
  if ((VALID_FORMATS as readonly string[]).includes(raw)) return raw as CiFormat;
  throw new Error(`unknown CI format ${JSON.stringify(raw)} (valid: ${VALID_FORMATS.join(", ")})`);
}

// ---- pretty (same shape as log.ts humanLine, without ANSI paint) ----

function hhmmss(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Compact "why" suffix from the enriched fields (all optional). */
function extraSuffix(ev: RunEvent): string {
  const parts: string[] = [];
  if (ev.reason) parts.push(`reason=${ev.reason}`);
  if (ev.exit !== undefined && ev.exit !== null) parts.push(`exit=${ev.exit}`);
  if (ev.timedOut !== undefined) parts.push(`timedOut=${ev.timedOut}`);
  if (ev.durationMs !== undefined && ev.durationMs !== null) {
    parts.push(`duration=${(ev.durationMs / 1000).toFixed(1)}s`);
  }
  if (ev.stats) {
    parts.push(`${ev.stats.turns}turns ${ev.stats.tools}tools`);
  }
  return parts.join(" ");
}

function prettyLine(ev: RunEvent): string {
  const type = ev.type.padEnd(22);
  const slice = (ev.sliceId ?? "").padEnd(26);
  const att = ev.attempt !== undefined ? `#${ev.attempt}` : "-";
  const detail = ev.detail ? ` ${ev.detail}` : "";
  const extra = extraSuffix(ev);
  return ` ${String(ev.seq).padStart(3)} ${hhmmss(ev.at)} ${type} ${slice} ${att.padStart(2)}${detail}${extra ? ` ${extra}` : ""}`;
}

// ---- tap / github classification ----

/** Event types that fail a TAP plan / an GitHub check. */
const FAIL_TYPES: ReadonlySet<RunEvent["type"]> = new Set([
  "verify_failed",
  "slice_failed_terminal",
  "run_aborted",
  "control_rejected",
]);

/** Environment blocks, skips, and kills: warnings, not check failures. */
const WARN_TYPES: ReadonlySet<RunEvent["type"]> = new Set([
  "slice_blocked_env",
  "slice_skipped",
  "slice_killed",
]);

/** Routine chatter with no annotation value. */
const QUIET_TYPES: ReadonlySet<RunEvent["type"]> = new Set([
  "run_started",
  "slice_claimed",
  "worker_finished",
]);

/**
 * Non-empty annotation body for an event: slice + detail when present,
 * reason as fallback, the bare type as the last resort (workflow commands
 * with an empty message render as nothing, so there is always a fallback).
 */
function annotationMessage(ev: RunEvent): string {
  if (ev.sliceId && ev.detail) return `${ev.sliceId}: ${ev.detail}`;
  if (ev.detail) return ev.detail;
  if (ev.sliceId && ev.reason) return `${ev.sliceId}: reason=${ev.reason}`;
  if (ev.reason) return `reason=${ev.reason}`;
  return ev.sliceId ?? ev.type;
}

/**
 * GitHub workflow annotation for an event, or null for routine chatter
 * (`run_started`, `slice_claimed`, `worker_finished`). Failures become
 * `::error`, env blocks / skips / kills become `::warning`, everything else
 * becomes `::notice`. Pure.
 */
export function ciAnnotationFor(ev: RunEvent): string | null {
  if (QUIET_TYPES.has(ev.type)) return null;
  const msg = annotationMessage(ev);
  if (FAIL_TYPES.has(ev.type)) return `::error title=ompo.${ev.type}::${msg}`;
  if (WARN_TYPES.has(ev.type)) return `::warning title=ompo.${ev.type}::${msg}`;
  return `::notice title=ompo.${ev.type}::${msg}`;
}

function tapLine(ev: RunEvent, n: number): string {
  const ok = !FAIL_TYPES.has(ev.type);
  const target = ev.sliceId ? `${ev.type} ${ev.sliceId}` : ev.type;
  const note = ev.detail ?? (ev.reason ? `reason=${ev.reason}` : "");
  return `${ok ? "ok" : "not ok"} ${n} ${target}${note ? ` # ${note}` : ""}`;
}

function githubLine(ev: RunEvent): string {
  // Full stream: even routine chatter gets a notice so `--format github`
  // stays a complete rendering; ciAnnotationFor() is the filtered view.
  const msg = annotationMessage(ev);
  if (FAIL_TYPES.has(ev.type)) return `::error title=ompo.${ev.type}::${msg}`;
  if (WARN_TYPES.has(ev.type)) return `::warning title=ompo.${ev.type}::${msg}`;
  return `::notice title=ompo.${ev.type}::${msg}`;
}

/**
 * Render one event in the given format. `index` overrides the TAP test
 * number (defaults to the event seq). Pure.
 */
export function formatCiEvent(
  ev: RunEvent,
  format: CiFormat,
  index?: { n: number; total: number },
): string {
  switch (format) {
    case "json":
      return JSON.stringify(ev);
    case "tap":
      return tapLine(ev, index?.n ?? ev.seq);
    case "github":
      return githubLine(ev);
    case "pretty":
      return prettyLine(ev);
  }
}

// ---- progress bar ----

/**
 * Fixed-width progress bar, e.g. `████░░░░░░░░ 4/12`.
 * `filled = round(done/total*width)` █ cells, the rest ░. Total 0 renders
 * an empty bar (`░░░░░░░░░░░░ 0/0`) instead of dividing by zero.
 */
export function renderProgressBar(done: number, total: number, width = 12): string {
  const filled =
    total <= 0 ? 0 : Math.min(width, Math.max(0, Math.round((done / total) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${done}/${total}`;
}

// ---- job summary docs ----

const SUMMARY_DOCS = ["deferred.md", "placeholders.md"] as const;

/**
 * Run docs worth attaching to a CI job summary: the subset of
 * `deferred.md` / `placeholders.md` under `.omp/roadmap/runs/<run>/` that
 * exists on disk. Only stats files (no writes).
 */
export function jobSummaryPaths(projectDir: string, runId: string): string[] {
  const out: string[] = [];
  for (const name of SUMMARY_DOCS) {
    const p = join(projectDir, RUNS_DIR, runId, name);
    try {
      if (existsSync(p) && statSync(p).isFile()) out.push(p);
    } catch {
      // Best-effort: unreadable entries are skipped, never fatal.
    }
  }
  return out;
}

// ---- header/progress summary ----

export interface RunSummary {
  done: number;
  total: number;
  failed: number;
}

/**
 * Minimal header/progress triple over status counts plus the event log.
 * `total` is the sum of all status counts, `done` the done count, and
 * `failed` the max of the failed-status count and the failure-event count
 * (both usually describe the same failures; max avoids double-counting).
 * Pure.
 */
export function summarizeRun(
  statuses: Record<string, number>,
  events: RunEvent[],
): RunSummary {
  const total = Object.values(statuses).reduce((a, b) => a + b, 0);
  const done = statuses["done"] ?? 0;
  const statusFailed = statuses["failed"] ?? 0;
  let eventFailed = 0;
  for (const ev of events) {
    if (FAIL_TYPES.has(ev.type)) eventFailed += 1;
  }
  return { done, total, failed: Math.max(statusFailed, eventFailed) };
}
