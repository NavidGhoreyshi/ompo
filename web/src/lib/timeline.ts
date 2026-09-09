import type { RunEvent } from "../api.ts";

/**
 * Timeline model: temporal execution history derived from the run event log.
 *
 * One segment per observed slice execution (a `slice_claimed` opens a new
 * segment; `slice_handoff` marks a generation boundary *inside* the open
 * segment; a terminal slice event closes it). Everything here is observed —
 * segment ends come from real events, never interpolated progress. An
 * attempt with no closing event stays `open` and renders bounded by the
 * last observed event, not by "now".
 */

/** Event types that close one attempt segment (observed boundary). */
const CLOSE_TYPES: ReadonlySet<string> = new Set([
  "slice_done",
  "slice_failed_terminal",
  "slice_retried",
  "slice_blocked_env",
  "slice_killed",
  "slice_skipped",
]);

/** One observed execution of a slice: claim → (handoffs…) → close. */
export interface TimelineAttempt {
  sliceId: string;
  /** Attempt number from the event stream; null on pre-enrichment runs. */
  attempt: number | null;
  startSeq: number;
  endSeq: number;
  startAt: string;
  endAt: string;
  startMs: number | null;
  endMs: number | null;
  /** Wall-clock end − start; null when either timestamp is unparseable. */
  durationMs: number | null;
  /** Last `worker_finished` durationMs inside this attempt, when reported. */
  workerMs: number | null;
  /** Sum of `worker_finished` stats.tokens.total inside this attempt. */
  tokens: number | null;
  /** 1 + number of `slice_handoff` events inside this attempt. */
  generations: number;
  /** Millis of each generation boundary (null entries = unparseable time). */
  handoffMs: (number | null)[];
  /** Closing event type; null while the attempt is still open. */
  outcome: string | null;
  /** Last event type seen inside this attempt (context for open segments). */
  lastType: string;
  /** True when no closing boundary was observed. */
  open: boolean;
}

export interface TimelineRow {
  sliceId: string;
  title?: string;
  attempts: TimelineAttempt[];
  /** Sum of known attempt durations; null when none is known. */
  totalMs: number | null;
  /** Re-executions observed (segments beyond the first). */
  retries: number;
}

export interface TimelineModel {
  rows: TimelineRow[];
  /** ISO of the earliest / latest parseable event time. */
  t0: string | null;
  t1: string | null;
  t0Ms: number | null;
  t1Ms: number | null;
  spanMs: number | null;
  /** Largest row totalMs; null when no durations are known. */
  maxTotalMs: number | null;
  /** Rows dominating wall-clock vs peers (≥2× the median of other totals, top 3). */
  longTailIds: string[];
}

function msOf(at: string): number | null {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

function tokenTotal(e: RunEvent): number | null {
  const t = e.stats?.tokens?.total;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : null;
}

function startAttempt(sliceId: string, e: RunEvent): TimelineAttempt {
  const ms = msOf(e.at);
  return {
    sliceId,
    attempt: typeof e.attempt === "number" ? e.attempt : null,
    startSeq: e.seq,
    endSeq: e.seq,
    startAt: e.at,
    endAt: e.at,
    startMs: ms,
    endMs: ms,
    durationMs: ms === null ? null : 0,
    workerMs: null,
    tokens: null,
    generations: 1,
    handoffMs: [],
    outcome: null,
    lastType: e.type,
    open: true,
  };
}

/** Fold one slice event into the open attempt (caller opens/closes). */
function touch(a: TimelineAttempt, e: RunEvent): void {
  a.endSeq = e.seq;
  a.endAt = e.at;
  const ms = msOf(e.at);
  a.endMs = ms;
  a.lastType = e.type;
  a.durationMs = a.startMs === null || ms === null ? null : Math.max(0, ms - a.startMs);
  if (e.type === "worker_finished") {
    if (typeof e.durationMs === "number" && Number.isFinite(e.durationMs) && e.durationMs >= 0) {
      a.workerMs = e.durationMs;
    }
    const t = tokenTotal(e);
    if (t !== null) a.tokens = (a.tokens ?? 0) + t;
  }
}

/**
 * Build the timeline model from an event log. Never throws on malformed
 * input: unparseable timestamps yield null durations, events without a
 * sliceId only widen the time domain, unknown types fold as context.
 */
export function buildTimeline(
  events: readonly RunEvent[],
  slices?: readonly { id: string; title?: string }[],
): TimelineModel {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  let t0Ms: number | null = null;
  let t1Ms: number | null = null;
  let t0: string | null = null;
  let t1: string | null = null;
  for (const e of ordered) {
    const ms = msOf(e.at);
    if (ms === null) continue;
    if (t0Ms === null || ms < t0Ms) {
      t0Ms = ms;
      t0 = e.at;
    }
    if (t1Ms === null || ms >= t1Ms) {
      t1Ms = ms;
      t1 = e.at;
    }
  }

  const bySlice = new Map<string, TimelineAttempt[]>();
  const openBySlice = new Map<string, TimelineAttempt>();

  const current = (sliceId: string): TimelineAttempt | undefined => openBySlice.get(sliceId);

  for (const e of ordered) {
    if (!e.sliceId) continue;
    const sliceId = e.sliceId;
    let list = bySlice.get(sliceId);
    if (!list) {
      list = [];
      bySlice.set(sliceId, list);
    }

    if (e.type === "slice_claimed") {
      // A new claim opens a fresh segment; the prior one (if any) ends at
      // its own last observed event — the claim belongs to the new attempt.
      openBySlice.delete(sliceId);
      const a = startAttempt(sliceId, e);
      list.push(a);
      openBySlice.set(sliceId, a);
      continue;
    }

    let a = current(sliceId);
    if (!a) {
      // Terminal-first (or mid-stream) history, e.g. old runs or a log
      // tailed from mid-run: synthesize a segment starting here so the
      // slice still appears instead of vanishing.
      a = startAttempt(sliceId, e);
      list.push(a);
      openBySlice.set(sliceId, a);
      if (e.type === "slice_handoff") {
        a.generations = 2;
        a.handoffMs.push(a.startMs);
      } else {
        touch(a, e);
      }
    } else if (e.type === "slice_handoff") {
      touch(a, e);
      a.generations += 1;
      a.handoffMs.push(msOf(e.at));
      continue;
    } else {
      touch(a, e);
    }

    if (CLOSE_TYPES.has(e.type)) {
      a.outcome = e.type;
      a.open = false;
      openBySlice.delete(sliceId);
    }
  }

  const titleById = new Map<string, string>();
  if (slices) {
    for (const s of slices) {
      if (s.title) titleById.set(s.id, s.title);
    }
  }

  const rows: TimelineRow[] = [];
  const pushRow = (sliceId: string) => {
    const attempts = bySlice.get(sliceId) ?? [];
    let total: number | null = null;
    for (const a of attempts) {
      if (a.durationMs !== null) total = (total ?? 0) + a.durationMs;
    }
    rows.push({
      sliceId,
      title: titleById.get(sliceId),
      attempts,
      totalMs: total,
      retries: Math.max(0, attempts.length - 1),
    });
  };
  if (slices) {
    for (const s of slices) pushRow(s.id);
  }
  for (const sliceId of bySlice.keys()) {
    if (slices?.some((s) => s.id === sliceId)) continue;
    pushRow(sliceId);
  }

  let maxTotalMs: number | null = null;
  for (const r of rows) {
    if (r.totalMs !== null && (maxTotalMs === null || r.totalMs > maxTotalMs)) maxTotalMs = r.totalMs;
  }

  // Long tail: rows whose wall-clock dominates their peers — at least twice
  // the median of the *other* positive totals (top 3). Uniform runs flag
  // nothing; a lone row has no peers to dominate.
  let longTailIds: string[] = [];
  const positives = rows.filter((r) => r.totalMs !== null && r.totalMs > 0);
  if (positives.length >= 2) {
    const byDesc = [...positives].sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0));
    const flagged: string[] = [];
    for (const cand of byDesc) {
      if (flagged.length >= 3) break;
      const others = positives
        .filter((r) => r !== cand)
        .map((r) => r.totalMs ?? 0)
        .sort((a, b) => a - b);
      if (others.length === 0) continue;
      const mid = Math.floor(others.length / 2);
      const median =
        others.length % 2 === 1 ? others[mid]! : (others[mid - 1]! + others[mid]!) / 2;
      if (median > 0 && (cand.totalMs ?? 0) >= 2 * median) flagged.push(cand.sliceId);
    }
    longTailIds = flagged;
  }

  return {
    rows,
    t0,
    t1,
    t0Ms,
    t1Ms,
    spanMs: t0Ms === null || t1Ms === null ? null : Math.max(0, t1Ms - t0Ms),
    maxTotalMs,
    longTailIds,
  };
}
