/**
 * The run's temporal projection (roadmap slice `d07`) — pure.
 *
 * Two questions, both answered from the recorded event log and nothing else:
 *
 *  1. *what shape did the run have over time?* — `buildEventRibbon`, a
 *     time-bucketed count of activity by lane with an explicit cap, and
 *     `attemptSegments`, which delegates to `lib/timeline.ts` so the deck and
 *     the dashboard's Timeline chart never segment an attempt twice.
 *  2. *what was the state of the system at seq N?* — `snapshotAt(N)`: the same
 *     status fold the store performs for its crash-replay check
 *     (`rebuildStatusesFromEvents`, `src/store.ts:631`), stopped at N.
 *
 * The historical state is a pure function of `(events, seq)`. The same cursor
 * produces the same state however the operator arrived there — slider, bucket
 * click, playback step, a second visit after leaving live — because nothing
 * here reads the clock, the DOM, `three`, or any *current* DTO: a historical
 * view must be reproducible from the record alone. That is also why this
 * module never predicts a state: `nextStatus` only ever applies an event that
 * happened, and `snapshotAt` only ever folds events with `seq <= N`.
 *
 * Cost: one O(events) pass builds the buckets and one builds the checkpoints;
 * a snapshot then folds at most `checkpointEvery` events from the nearest
 * checkpoint, so scrubbing a 100 000-event window costs the same as scrubbing
 * a 300-event one (measured in `tests/deck-history.test.ts`). The index is
 * rebuilt only when the window itself changes — never per scrub tick, never
 * per frame.
 *
 * Known limitation, stated rather than hidden: `run_resumed` demotes
 * `running`/`verifying` to `pending` in the run *cursor*, not in the event log
 * (`src/store.ts` `resumeRun`). The log records no demotion event, so the
 * historical fold reports what the log recorded, exactly like the store's own
 * replay check.
 *
 * Pure module: no `three`, no DOM, no fetching.
 */

import type { RunEvent } from "../api.ts";
import { eventLane, type ActivityLane } from "../lib/events.ts";
import { isLiveStatus } from "../lib/selection.ts";
import { buildTimeline, type TimelineAttempt } from "../lib/timeline.ts";

/** Buckets a ribbon may draw, however long the run is. */
export const RIBBON_MAX_BUCKETS = 120;
/**
 * Events folded between two checkpoints. A snapshot walks at most this many
 * events, so scrub cost is bounded by a constant, not by the log's length.
 */
export const CHECKPOINT_EVERY = 256;

/** The lanes, in the order a tie picks its winner and the HUD lists them. */
const LANES: readonly ActivityLane[] = ["worker", "verify", "review", "control", "system"];

/** Bucket sizes a human can read off a clock, smallest first. */
const BUCKET_STEPS_MS: readonly number[] = [
  1_000,
  5_000,
  15_000,
  30_000,
  60_000,
  300_000,
  900_000,
  1_800_000,
  3_600_000,
  10_800_000,
  21_600_000,
  43_200_000,
  86_400_000,
];

function zeroLanes(): Record<ActivityLane, number> {
  return { worker: 0, verify: 0, review: 0, control: 0, system: 0 };
}

/**
 * The bucket size that keeps a run's whole span inside `maxBuckets`, chosen
 * from the clock-readable ladder above (so the label reads "30s", "5m", "1h"
 * rather than "37s"), extended past the ladder for absurd spans.
 */
export function chooseBucketMs(spanMs: number, maxBuckets = RIBBON_MAX_BUCKETS): number {
  const span = Number.isFinite(spanMs) && spanMs > 0 ? spanMs : 0;
  const cap = Math.max(1, Math.floor(maxBuckets));
  for (const step of BUCKET_STEPS_MS) {
    if (Math.ceil(span / step) <= cap) return step;
  }
  const last = BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1]!;
  return Math.max(last, Math.ceil(span / cap));
}

/**
 * One time bucket of the ribbon. Empty buckets exist too (a quiet stretch is
 * information), which is what makes the ribbon's width a function of the run's
 * span rather than of its event count.
 */
export interface RibbonBucket {
  index: number;
  /** `[startMs, endMs)` on the wall clock; ISO forms for the DOM's labels. */
  startMs: number;
  endMs: number;
  startAt: string;
  endAt: string;
  /** Events inside the bucket (events without a parseable time are excluded). */
  count: number;
  laneCounts: Record<ActivityLane, number>;
  /** The busiest lane in this bucket (`null` when the bucket is empty). */
  lane: ActivityLane | null;
  /** Slices touched inside the bucket, newest event first. */
  slices: string[];
  /** Newest event seq inside the bucket (`-1` when the bucket is empty). */
  lastSeq: number;
  /** Workers in flight at `lastSeq` — concurrency at the end of the bucket. */
  active: number;
}

/** What one slice looked like at a cursor. */
export interface HistorySliceState {
  /** The status the log implies (see `nextStatus`). */
  status: string;
  /** Attempt of the newest event that carried one (`null` when none did). */
  attempt: number | null;
  /** `1 + handoffs` since the attempt's claim. */
  generation: number;
  /** Newest event seq for this slice at the cursor. */
  seq: number;
  /** That event's timestamp. */
  at: string;
}

/** The state of the system at one sequence, derived from the log. */
export interface HistorySnapshot {
  /** The cursor: every event with `seq <= this` is in effect. */
  seq: number;
  /** Timestamp of the newest event at or before the cursor. */
  at: string | null;
  /** One entry per slice the window's log mentions. */
  states: ReadonlyMap<string, HistorySliceState>;
  /** Slices with a worker in flight at the cursor, in first-touch order. */
  activeIds: readonly string[];
}

/** The temporal projection of one event window. */
export interface HistoryIndex {
  /** The window, ordered by seq (the input array when it already was). */
  events: readonly RunEvent[];
  /** Seq bounds of the window (`0` when empty). */
  firstSeq: number;
  lastSeq: number;
  /** First / last parseable event time (`null` when no event has one). */
  t0Ms: number | null;
  t1Ms: number | null;
  /** The ribbon's bucket size in ms (`0` when nothing has a time). */
  bucketMs: number;
  /** The ribbon: the whole window, ≤ `maxBuckets` buckets, empties included. */
  buckets: readonly RibbonBucket[];
  /**
   * The buckets a cursor may occupy (those a recorded event landed in), in
   * ascending order. Empty buckets stay in `buckets` — the ribbon's shape —
   * but stepping, scrubbing and playback walk this list, because a seq no
   * event has is not a moment the log can describe.
   */
  recorded: readonly number[];
  /** Slice ids the window mentions — the only ids a snapshot has state for. */
  touched: ReadonlySet<string>;
  /** Checkpoints built (diagnostics and the unit test's O(1) claim). */
  checkpoints: number;
  /** The state at `seq`, deterministic and independent of visit order. */
  snapshotAt(seq: number): HistorySnapshot;
  /** Index of the newest event at or before `seq`, or `-1`. */
  eventIndexAt(seq: number): number;
  /** The bucket containing `seq`, or `null` (no buckets, or no event yet). */
  bucketAt(seq: number): RibbonBucket | null;
}

/** `Date.parse` without the NaN leak: unparseable stamps time nothing. */
function timeMs(at: string): number | null {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/** A window that is already seq-ordered is the common case: keep the caller's. */
function orderedBySeq(events: readonly RunEvent[]): readonly RunEvent[] {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.seq < events[i - 1]!.seq) return [...events].sort((a, b) => a.seq - b.seq);
  }
  return events;
}

/**
 * The status a slice holds after `event`, or `null` when the event leaves it
 * unchanged.
 *
 * This mirrors `rebuildStatusesFromEvents` (`src/store.ts:631`) case for case.
 * It is deliberately the *same* rule and not a second one: `tests/deck-history
 * .test.ts` asserts fold-at-∞ equals that function over a crafted log, which is
 * what makes "the history view shows the log's state" a test rather than a
 * claim. `secret_accepted` and every non-status event fall through unchanged —
 * so do `slice_handoff`, `slice_reverified` and `run_resumed`, which the store
 * treats as context, not transitions.
 */
function nextStatus(status: string, type: string): string | null {
  switch (type) {
    case "slice_claimed":
      return "running";
    case "worker_finished":
      return "verifying";
    case "verify_passed":
    case "slice_done":
      return "done";
    case "verify_failed":
    case "slice_failed_terminal":
      return "failed";
    case "slice_retried":
      return "pending";
    case "slice_blocked_env":
      return "blocked-env";
    case "slice_skipped":
      return "skipped";
    case "slice_killed":
      return "aborted";
    case "run_aborted":
      return status === "running" || status === "verifying" ? "aborted" : null;
    default:
      return null;
  }
}

/** The fold's state: one immutable value per touched slice. */
type StateMap = Map<string, HistorySliceState>;

/**
 * Fold one event into `states`, replacing the slice's value with a new object
 * (never mutating an existing one) so a checkpoint can share the values it
 * copied and remain valid as the fold walks on.
 *
 * Returns whether the slice's liveness changed, which is what the ribbon's
 * concurrency per bucket is built from.
 */
function applyEvent(states: StateMap, event: RunEvent): boolean {
  const sliceId = event.sliceId;
  if (sliceId === undefined) return false;
  const previous = states.get(sliceId);
  const status = previous?.status ?? "pending";
  const next = nextStatus(status, event.type) ?? status;
  let generation = previous?.generation ?? 0;
  if (event.type === "slice_claimed") generation = 1;
  else if (event.type === "slice_handoff") generation = Math.max(1, generation) + 1;
  const attempt = event.type === "slice_claimed" ? (event.attempt ?? null) : typeof event.attempt === "number" ? event.attempt : (previous?.attempt ?? null);
  states.set(sliceId, { status: next, attempt, generation, seq: event.seq, at: event.at });
  return previous === undefined ? isLiveStatus(next) : isLiveStatus(previous.status) !== isLiveStatus(next);
}

/** Where a bucket's slices are collected before they are ordered and deduped. */
type BucketSlices = string[][];

function bucketIndexOf(ms: number, t0Ms: number, bucketMs: number, bucketCount: number): number {
  return Math.min(bucketCount - 1, Math.max(0, Math.floor((ms - t0Ms) / bucketMs)));
}

/**
 * The ribbon over one window: bucketed counts by lane plus, per bucket, the
 * slices touched in it and the number of workers in flight at its end.
 *
 * `bucketMs: 0` (the default) chooses the size from the span. `maxBuckets`
 * bounds the result; empty buckets are kept, because a gap is where nothing
 * happened — the one thing a ribbon must not silently compress away.
 */
export function buildEventRibbon(
  events: readonly RunEvent[],
  opts: { bucketMs?: number; maxBuckets?: number } = {},
): { buckets: RibbonBucket[]; bucketMs: number; t0Ms: number | null; t1Ms: number | null } {
  const maxBuckets = Math.max(1, Math.floor(opts.maxBuckets ?? RIBBON_MAX_BUCKETS));
  const ordered = orderedBySeq(events);
  let t0Ms: number | null = null;
  let t1Ms: number | null = null;
  const times = new Array<number | null>(ordered.length);
  for (let i = 0; i < ordered.length; i++) {
    const ms = timeMs(ordered[i]!.at);
    times[i] = ms;
    if (ms === null) continue;
    if (t0Ms === null || ms < t0Ms) t0Ms = ms;
    if (t1Ms === null || ms > t1Ms) t1Ms = ms;
  }
  if (t0Ms === null || t1Ms === null) return { buckets: [], bucketMs: 0, t0Ms, t1Ms };

  const requested = Math.floor(opts.bucketMs ?? 0);
  const bucketMs = requested > 0 ? requested : chooseBucketMs(t1Ms - t0Ms, maxBuckets);
  const bucketCount = Math.min(maxBuckets, Math.max(1, Math.ceil((t1Ms - t0Ms + 1) / bucketMs)));
  const buckets: RibbonBucket[] = [];
  for (let index = 0; index < bucketCount; index++) {
    const startMs = t0Ms + index * bucketMs;
    const endMs = startMs + bucketMs;
    buckets.push({
      index,
      startMs,
      endMs,
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      count: 0,
      laneCounts: zeroLanes(),
      lane: null,
      slices: [],
      lastSeq: -1,
      active: 0,
    });
  }

  const sliceLists: BucketSlices = buckets.map(() => []);
  const states: StateMap = new Map();
  const live: { seq: number; sliceId: string; live: boolean }[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const event = ordered[i]!;
    const ms = times[i]!;
    if (ms !== null) {
      const bucket = buckets[bucketIndexOf(ms, t0Ms, bucketMs, bucketCount)]!;
      const lane = eventLane(event);
      bucket.count += 1;
      bucket.laneCounts[lane] += 1;
      if (event.seq > bucket.lastSeq) bucket.lastSeq = event.seq;
      if (event.sliceId !== undefined) sliceLists[bucket.index]!.push(event.sliceId);
    }
    if (event.sliceId !== undefined && applyEvent(states, event)) {
      live.push({ seq: event.seq, sliceId: event.sliceId, live: isLiveStatus(states.get(event.sliceId)!.status) });
    }
  }

  // Concurrency at the end of each bucket: advance a cursor over the liveness
  // changes up to the bucket's own last seq. Independent of timestamp order,
  // so a clock-skewed event cannot make "how many workers" disagree with the
  // pads' own statuses.
  let cursor = 0;
  const inFlight = new Set<string>();
  for (const bucket of buckets) {
    if (bucket.lastSeq < 0) continue;
    while (cursor < live.length && live[cursor]!.seq <= bucket.lastSeq) {
      const change = live[cursor]!;
      if (change.live) inFlight.add(change.sliceId);
      else inFlight.delete(change.sliceId);
      cursor++;
    }
    bucket.active = inFlight.size;
  }

  for (const bucket of buckets) {
    let lane: ActivityLane | null = null;
    let best = 0;
    for (const candidate of LANES) {
      const count = bucket.laneCounts[candidate];
      if (count > best) {
        best = count;
        lane = candidate;
      }
    }
    bucket.lane = lane;
    // Newest first, deduped: `slices[0]` is the slice a click on this bucket
    // means (the roadmap's "newest slice touched in that bucket").
    const seen = new Set<string>();
    const newestFirst: string[] = [];
    const list = sliceLists[bucket.index]!;
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i]!;
      if (seen.has(id)) continue;
      seen.add(id);
      newestFirst.push(id);
    }
    bucket.slices = newestFirst;
  }

  return { buckets, bucketMs, t0Ms, t1Ms };
}

/**
 * The buckets a cursor can *sit in*: the ones a recorded event landed in.
 *
 * An empty bucket is a real part of the ribbon (a quiet stretch), but it is
 * not a state — the cursor is a seq, and a seq that no event has is not a
 * moment the log can describe. Stepping, scrubbing and playback therefore walk
 * this list, which keeps "the same cursor gives the same scene" true without
 * inventing a state for a gap.
 */
export function recordedBucketIndices(buckets: readonly RibbonBucket[]): number[] {
  const indices: number[] = [];
  for (const bucket of buckets) {
    if (bucket.count > 0) indices.push(bucket.index);
  }
  return indices;
}

/**
 * Build the temporal index for one event window: the ribbon, the checkpoints,
 * and `snapshotAt` — the deterministic answer to "the state at seq N".
 */
export function buildHistoryIndex(
  events: readonly RunEvent[],
  opts: { maxBuckets?: number; checkpointEvery?: number; bucketMs?: number } = {},
): HistoryIndex {
  const every = Math.max(1, Math.floor(opts.checkpointEvery ?? CHECKPOINT_EVERY));
  const ordered = orderedBySeq(events);
  const ribbon = buildEventRibbon(ordered, { maxBuckets: opts.maxBuckets, bucketMs: opts.bucketMs });
  const recorded = recordedBucketIndices(ribbon.buckets);

  const touched = new Set<string>();
  const checkpoints: { seq: number; at: string | null; states: StateMap }[] = [{ seq: -1, at: null, states: new Map() }];
  const states: StateMap = new Map();
  for (let i = 0; i < ordered.length; i++) {
    const event = ordered[i]!;
    if (event.sliceId !== undefined) touched.add(event.sliceId);
    applyEvent(states, event);
    if ((i + 1) % every === 0) {
      // Shallow copy: the *values* are never mutated (`applyEvent` replaces
      // them), so a checkpoint's map stays exactly the state at its seq.
      checkpoints.push({ seq: event.seq, at: event.at, states: new Map(states) });
    }
  }
  if (ordered.length % every !== 0 && ordered.length > 0) {
    const last = ordered[ordered.length - 1]!;
    checkpoints.push({ seq: last.seq, at: last.at, states: new Map(states) });
  }

  const firstSeq = ordered.length > 0 ? ordered[0]!.seq : 0;
  const lastSeq = ordered.length > 0 ? ordered[ordered.length - 1]!.seq : 0;

  /** Index of the newest event with `seq <= cursor`, or `-1`. */
  const eventIndexAt = (seq: number): number => {
    let lo = 0;
    let hi = ordered.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ordered[mid]!.seq <= seq) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  const snapshotAt = (seq: number): HistorySnapshot => {
    // The nearest checkpoint at or before the cursor: binary search, because
    // checkpoints are in ascending seq order by construction.
    let lo = 0;
    let hi = checkpoints.length - 1;
    let chosen = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (checkpoints[mid]!.seq <= seq) {
        chosen = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const checkpoint = checkpoints[chosen]!;
    const next: StateMap = new Map(checkpoint.states);
    let at = checkpoint.at;
    for (let i = eventIndexAt(checkpoint.seq) + 1; i < ordered.length; i++) {
      const event = ordered[i]!;
      if (event.seq > seq) break;
      applyEvent(next, event);
      at = event.at;
    }
    const activeIds: string[] = [];
    for (const [id, state] of next) {
      if (isLiveStatus(state.status)) activeIds.push(id);
    }
    return { seq, at, states: next, activeIds };
  };

  const bucketAt = (seq: number): RibbonBucket | null => {
    if (ribbon.buckets.length === 0) return null;
    const index = eventIndexAt(seq);
    if (index < 0) return null;
    const ms = timeMs(ordered[index]!.at);
    if (ms === null || ribbon.t0Ms === null) return null;
    return ribbon.buckets[bucketIndexOf(ms, ribbon.t0Ms, ribbon.bucketMs, ribbon.buckets.length)] ?? null;
  };

  return {
    events: ordered,
    firstSeq,
    lastSeq,
    t0Ms: ribbon.t0Ms,
    t1Ms: ribbon.t1Ms,
    bucketMs: ribbon.bucketMs,
    buckets: ribbon.buckets,
    recorded,
    touched,
    checkpoints: checkpoints.length,
    snapshotAt,
    eventIndexAt,
    bucketAt,
  };
}

/**
 * The attempt segments of one slice, straight from the dashboard's own
 * segmentation (`lib/timeline.ts`) — one algorithm, so the deck's strip and
 * the Timeline chart cannot disagree about where an attempt began or ended.
 */
export function attemptSegments(
  events: readonly RunEvent[],
  sliceId: string,
  slices?: readonly { id: string; title?: string }[],
): TimelineAttempt[] {
  const model = buildTimeline(events, slices);
  return model.rows.find((row) => row.sliceId === sliceId)?.attempts ?? [];
}
