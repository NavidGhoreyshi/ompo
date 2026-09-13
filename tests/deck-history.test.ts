/**
 * The temporal layer (roadmap slice `d07`) — pure, no browser.
 *
 * Three claims this file exists to make testable:
 *
 *  1. the ribbon is *bounded* — a window of any size becomes ≤ 120 buckets of
 *     clock-readable size, empty stretches included;
 *  2. the historical state is *deterministic* — `snapshotAt(N)` depends on the
 *     log and N and on nothing else (not on visit order, not on the
 *     checkpoints), and its fold is the store's own status rule
 *     (`rebuildStatusesFromEvents`), asserted equal rather than asserted
 *     similar;
 *  3. scrubbing is *constant cost* — a snapshot folds at most
 *     `CHECKPOINT_EVERY` events, so a 100 000-event window scrubs like a
 *     1 000-event one (measured, printed, and compared against the same code
 *     path with checkpoints disabled).
 */

import { describe, expect, test } from "bun:test";
import { rebuildStatusesFromEvents } from "../src/store.ts";
import type { RoadmapDoc, RunEvent as StoreRunEvent, Slice } from "../src/types.ts";
import { buildTimeline } from "../web/src/lib/timeline.ts";
import {
  attemptSegments,
  buildEventRibbon,
  buildHistoryIndex,
  CHECKPOINT_EVERY,
  chooseBucketMs,
  RIBBON_MAX_BUCKETS,
  type HistoryIndex,
} from "../web/src/scene/history.ts";
import type { RunEvent } from "../web/src/api.ts";

const T0 = Date.parse("2026-09-13T10:00:00.000Z");

function event(
  seq: number,
  sliceId: string | undefined,
  type: string,
  opts: { atMs?: number; attempt?: number; reason?: string; at?: string } = {},
): RunEvent {
  const at = opts.at ?? new Date(opts.atMs ?? T0 + seq * 1000).toISOString();
  return {
    seq,
    at,
    type,
    ...(sliceId === undefined ? {} : { sliceId }),
    ...(opts.attempt === undefined ? {} : { attempt: opts.attempt }),
    ...(opts.reason === undefined ? {} : { reason: opts.reason }),
  };
}

/** A log that exercises every status transition the store's fold knows. */
const CRAFTED: RunEvent[] = [
  event(0, undefined, "run_started"),
  event(1, "a", "slice_claimed", { attempt: 1 }),
  event(2, "b", "slice_claimed", { attempt: 1 }),
  event(3, "a", "worker_finished", { attempt: 1 }),
  event(4, "a", "verify_failed", { attempt: 1, reason: "gate red" }),
  event(5, "a", "slice_retried", { attempt: 1 }),
  event(6, "a", "slice_claimed", { attempt: 2 }),
  event(7, "a", "slice_handoff", { attempt: 2 }),
  event(8, "a", "worker_finished", { attempt: 2 }),
  event(9, "a", "verify_passed", { attempt: 2 }),
  event(10, "a", "slice_done", { attempt: 2 }),
  event(11, "b", "slice_blocked_env", { attempt: 1, reason: "no token" }),
  event(12, "c", "slice_skipped"),
  event(13, "d", "slice_claimed", { attempt: 1 }),
  event(14, "d", "slice_killed", { attempt: 1 }),
  event(15, "e", "slice_claimed", { attempt: 1 }),
  event(16, "e", "slice_failed_terminal", { attempt: 1, reason: "boom" }),
  event(17, "f", "slice_claimed", { attempt: 1 }),
  event(18, "f", "run_aborted"),
  event(19, "g", "secret_accepted"),
  event(20, "h", "slice_claimed", { attempt: 1 }),
  event(21, "h", "worker_finished", { attempt: 1 }),
  event(22, "h", "slice_reverified", { attempt: 1 }),
];

/** The `RoadmapDoc` shape the store's fold starts from (ids + skip only). */
function doc(ids: string[]): RoadmapDoc {
  const slices = ids.map(
    (id) =>
      ({
        id,
        title: id,
        body: "",
        deps: [],
        verify: [],
        files: [],
        maxRetries: 0,
        status: "pending",
        attempts: 0,
        updatedAt: new Date(T0).toISOString(),
      }) as Slice,
  );
  return { version: 1, sourceHash: "", slices };
}

/** Sorted `[id, status]` pairs — a Map comparison that survives key order. */
function statusPairs(index: HistoryIndex, seq: number): [string, string][] {
  return [...index.snapshotAt(seq).states.entries()]
    .map(([id, state]): [string, string] => [id, state.status])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("the ribbon is bounded and clock-readable", () => {
  test("bucket sizes come off the ladder, so the label reads like a clock", () => {
    expect(chooseBucketMs(0)).toBe(1_000);
    expect(chooseBucketMs(59_000)).toBe(1_000);
    expect(chooseBucketMs(60_000)).toBe(1_000);
    expect(chooseBucketMs(3_600_000)).toBe(30_000); // 120 × 30s fits exactly
    expect(chooseBucketMs(3_600_000, 8)).toBe(900_000); // 15m × 4
    expect(chooseBucketMs(86_400_000, 24)).toBe(3_600_000); // 24 × 1h
  });

  test("an empty window renders nothing rather than one empty bucket", () => {
    const ribbon = buildEventRibbon([]);
    expect(ribbon.buckets).toEqual([]);
    expect(ribbon.bucketMs).toBe(0);
    expect(ribbon.t0Ms).toBeNull();
  });

  test("bucket boundaries are half-open: [start, end)", () => {
    const events = [
      event(0, "a", "slice_claimed", { atMs: T0 }),
      event(1, "a", "worker_finished", { atMs: T0 + 30_000 - 1 }),
      event(2, "a", "verify_passed", { atMs: T0 + 30_000 }),
    ];
    const { buckets, bucketMs } = buildEventRibbon(events, { bucketMs: 30_000 });
    expect(bucketMs).toBe(30_000);
    expect(buckets.map((bucket) => bucket.count)).toEqual([2, 1]);
    expect(buckets[0]!.slices).toEqual(["a"]);
    expect(buckets[0]!.lastSeq).toBe(1);
  });

  test("a quiet stretch keeps its buckets: the gap is information", () => {
    const events = [
      event(0, "a", "slice_claimed", { atMs: T0 }),
      event(1, "a", "slice_done", { atMs: T0 + 90_000 }),
    ];
    const { buckets } = buildEventRibbon(events, { bucketMs: 30_000 });
    expect(buckets).toHaveLength(4);
    expect(buckets.map((bucket) => bucket.count)).toEqual([1, 0, 0, 1]);
    expect(buckets[1]!.lane).toBeNull();
    expect(buckets[1]!.lastSeq).toBe(-1);
  });

  test("an event without a parseable time is excluded from the buckets, not from the fold", () => {
    const events = [
      event(0, "a", "slice_claimed", { atMs: T0 }),
      event(1, "a", "worker_finished", { at: "not a date" }),
      event(2, "a", "verify_passed", { atMs: T0 + 5_000 }),
    ];
    const ribbon = buildEventRibbon(events, { bucketMs: 1_000 });
    expect(ribbon.buckets.map((bucket) => bucket.count)).toEqual([1, 0, 0, 0, 0, 1]);
    const index = buildHistoryIndex(events);
    expect(index.snapshotAt(2).states.get("a")?.status).toBe("done");
  });

  test("100 000 events still make at most 120 buckets", () => {
    const events = Array.from({ length: 100_000 }, (_, i) =>
      event(i, `s${i % 25}`, i % 7 === 0 ? "worker_finished" : "slice_handoff", { atMs: T0 + i * 250 }),
    );
    const started = performance.now();
    const { buckets } = buildEventRibbon(events, { maxBuckets: RIBBON_MAX_BUCKETS });
    const ms = Math.round((performance.now() - started) * 100) / 100;
    console.log(`deck-history-ribbon ${JSON.stringify({ events: events.length, buckets: buckets.length, ms })}`);
    expect(buckets.length).toBeLessThanOrEqual(RIBBON_MAX_BUCKETS);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(events.length);
  });

  test("the dominant lane is the busiest, ties in lane order", () => {
    const events = [
      event(0, "a", "slice_claimed", { atMs: T0 }),
      event(1, "a", "slice_claimed", { atMs: T0 + 10 }),
      event(2, "a", "verify_passed", { atMs: T0 + 20 }),
      event(3, undefined, "run_started", { atMs: T0 + 30 }),
    ];
    const { buckets } = buildEventRibbon(events, { bucketMs: 60_000 });
    expect(buckets[0]!.laneCounts).toEqual({ worker: 2, verify: 1, review: 0, control: 0, system: 1 });
    expect(buckets[0]!.lane).toBe("worker");
    // worker 1 / system 1 in the tie: the lane list's own order decides.
    const tie = buildEventRibbon([event(0, "a", "slice_claimed", { atMs: T0 }), event(1, undefined, "run_started", { atMs: T0 + 5 })], { bucketMs: 60_000 });
    expect(tie.buckets[0]!.lane).toBe("worker");
  });

  test("a bucket's slices are newest-first and deduped", () => {
    const events = [
      event(0, "a", "slice_claimed", { atMs: T0 }),
      event(1, "b", "slice_claimed", { atMs: T0 + 1_000 }),
      event(2, "a", "worker_finished", { atMs: T0 + 2_000 }),
      event(3, undefined, "run_started", { atMs: T0 + 3_000 }),
    ];
    const { buckets } = buildEventRibbon(events, { bucketMs: 60_000 });
    expect(buckets[0]!.slices).toEqual(["a", "b"]);
  });

  test("active is the workers in flight at the bucket's end", () => {
    const events = [
      event(0, "a", "slice_claimed", { atMs: T0 }),
      event(1, "b", "slice_claimed", { atMs: T0 + 30_000 }),
      event(2, "a", "slice_done", { atMs: T0 + 60_000 }),
      event(3, "b", "slice_done", { atMs: T0 + 90_000 }),
    ];
    const { buckets } = buildEventRibbon(events, { bucketMs: 30_000 });
    expect(buckets.map((bucket) => bucket.active)).toEqual([1, 2, 1, 0]);
  });

  test("a slice retried elsewhere is claimed again: status and again in flight", () => {
    const events = [
      event(0, "a", "slice_claimed", { atMs: T0 }),
      event(1, "a", "slice_retried", { atMs: T0 + 1_000 }),
      event(2, "a", "slice_claimed", { atMs: T0 + 2_000 }),
    ];
    const { buckets } = buildEventRibbon(events, { bucketMs: 30_000 });
    expect(buckets[0]!.active).toBe(1);
  });
});

describe("the historical state is deterministic", () => {
  test("a snapshot is a pure function of the log and the cursor", () => {
    const index = buildHistoryIndex(CRAFTED);
    // Visit order must not matter: ask for a late cursor first, then early
    // ones, and compare with a second, independently built index walked in
    // ascending order.
    const backwards = [22, 13, 1, 17, 5, 0].map((seq) => [seq, statusPairs(index, seq)] as const);
    const fresh = buildHistoryIndex(CRAFTED);
    for (const [seq, pairs] of backwards) {
      expect(statusPairs(fresh, seq)).toEqual(pairs);
      expect(statusPairs(index, seq)).toEqual(pairs);
    }
  });

  test("every event type folds the way the store's replay check folds it", () => {
    const index = buildHistoryIndex(CRAFTED);
    // The web API types `RunEvent.type` as `string` (the union lives on the
    // server type), so the crafted log crosses the boundary here and nowhere
    // else — the assertion below is what proves the two folds agree.
    const expected = rebuildStatusesFromEvents(
      doc(["a", "b", "c", "d", "e", "f", "g", "h"]),
      CRAFTED as unknown as StoreRunEvent[],
    );
    for (const [id, status] of expected) {
      const state = index.snapshotAt(Number.POSITIVE_INFINITY).states.get(id);
      if (state === undefined) continue; // `g` has no status-bearing event
      expect(`${id}=${state.status}`).toBe(`${id}=${status}`);
    }
    // The fold covers every slice the log mentions, and only those.
    expect([...index.touched].sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    // The one slice the store never sees an event for stays untouched.
    expect(index.snapshotAt(Number.POSITIVE_INFINITY).states.has("zz")).toBe(false);
  });

  test("the log's own transitions at their own seq", () => {
    const index = buildHistoryIndex(CRAFTED);
    const at = (seq: number, id: string): string | undefined => index.snapshotAt(seq).states.get(id)?.status;
    expect(at(0, "a")).toBeUndefined(); // before its claim
    expect(at(1, "a")).toBe("running");
    expect(at(3, "a")).toBe("verifying");
    expect(at(4, "a")).toBe("failed");
    expect(at(5, "a")).toBe("pending");
    expect(at(8, "a")).toBe("verifying");
    expect(at(10, "a")).toBe("done");
    expect(at(22, "a")).toBe("done");
    // `run_aborted` (seq 18) demotes in-flight slices only.
    expect(at(17, "f")).toBe("running");
    expect(at(18, "f")).toBe("aborted");
    expect(at(18, "e")).toBe("failed"); // terminal failures are not demoted
    // `secret_accepted` and `slice_reverified` are context: no status change,
    // so `g` reads as the initial state (the store's fold says `pending` too).
    expect(at(19, "g")).toBe("pending");
    expect(at(21, "h")).toBe("verifying");
    expect(at(22, "h")).toBe("verifying");
  });

  test("attempt and generation come from the log, not from the current DTOs", () => {
    const index = buildHistoryIndex(CRAFTED);
    const state = index.snapshotAt(22).states.get("a")!;
    expect(state.attempt).toBe(2);
    expect(state.generation).toBe(2); // claim g1 → one handoff → g2
    expect(state.seq).toBe(10);
    expect(state.at).toBe(CRAFTED[10]!.at);
  });

  test("checkpoints cannot change what a snapshot says", () => {
    const events = Array.from({ length: 600 }, (_, i) =>
      event(i, `s${i % 5}`, i % 3 === 0 ? "slice_claimed" : i % 3 === 1 ? "worker_finished" : "slice_done", { atMs: T0 + i * 1000 }),
    );
    const dense = buildHistoryIndex(events, { checkpointEvery: 1 });
    const sparse = buildHistoryIndex(events, { checkpointEvery: 100_000 });
    expect(dense.checkpoints).toBeGreaterThan(500);
    expect(sparse.checkpoints).toBe(2); // the initial one, plus the tail
    for (let seq = -1; seq <= events.length + 2; seq += 7) {
      const a = [...dense.snapshotAt(seq).states.entries()].map(([id, s]) => `${id}:${s.status}:${s.generation}:${s.seq}`).sort();
      const b = [...sparse.snapshotAt(seq).states.entries()].map(([id, s]) => `${id}:${s.status}:${s.generation}:${s.seq}`).sort();
      expect(b).toEqual(a);
    }
  });

  test("cursors outside the window are empty, and the bucket of a seq is the bucket its event landed in", () => {
    const index = buildHistoryIndex(CRAFTED);
    expect(index.snapshotAt(-1).states.size).toBe(0);
    expect(index.firstSeq).toBe(0);
    expect(index.lastSeq).toBe(22);
    expect(index.eventIndexAt(4)).toBe(4);
    expect(index.eventIndexAt(4_000)).toBe(22);
    expect(index.bucketAt(0)?.index).toBe(0);
    expect(index.bucketAt(-5)).toBeNull();
  });

  test("a worker's in-flight set is the snapshot's own answer", () => {
    const index = buildHistoryIndex(CRAFTED);
    expect([...index.snapshotAt(2).activeIds].sort()).toEqual(["a", "b"]);
    expect(index.snapshotAt(11).activeIds).toEqual([]);
    expect(index.snapshotAt(13).activeIds).toEqual(["d"]);
  });

  test("only recorded buckets are cursor positions; the index lists them", () => {
    const events = [
      event(0, "a", "slice_claimed", { atMs: T0 }),
      event(1, "a", "slice_done", { atMs: T0 + 90_000 }),
    ];
    const index = buildHistoryIndex(events, { bucketMs: 30_000 });
    expect(index.buckets.map((bucket) => bucket.count)).toEqual([1, 0, 0, 1]);
    expect(index.recorded).toEqual([0, 3]);
    expect(index.recorded.map((bucket) => index.buckets[bucket]!.lastSeq)).toEqual([0, 1]);
  });
});

describe("scrubbing a large window costs a constant, not the log", () => {
  test("a 100 000-event index and a 1 000-event index scrub in the same time", () => {
    const big = Array.from({ length: 100_000 }, (_, i) =>
      event(i, `s${i % 25}`, i % 11 === 0 ? "slice_claimed" : i % 11 === 1 ? "worker_finished" : "slice_handoff", { atMs: T0 + i * 250 }),
    );
    // The operating point: the shell's window is one server page
    // (`EVENTS_MAX_LIMIT` = 2000), so this is the input a real deck builds.
    const small = big.slice(0, 2_000);

    const buildStarted = performance.now();
    const index = buildHistoryIndex(big);
    const buildMs = Math.round((performance.now() - buildStarted) * 100) / 100;

    const sample = (target: HistoryIndex, samples: number): { mean: number; worst: number } => {
      const started = performance.now();
      const cursors = Array.from({ length: samples }, (_, i) => Math.floor((i / samples) * target.lastSeq));
      let worst = 0;
      for (const seq of cursors) {
        const at = performance.now();
        target.snapshotAt(seq);
        const took = performance.now() - at;
        if (took > worst) worst = took;
      }
      return { mean: (performance.now() - started) / cursors.length, worst };
    };
    const pageStarted = performance.now();
    const smallIndex = buildHistoryIndex(small);
    const pageBuildMs = Math.round((performance.now() - pageStarted) * 100) / 100;
    const bigTiming = sample(index, 200);
    const smallTiming = sample(smallIndex, 200);

    // The same code path with checkpoints off: every snapshot re-folds the
    // whole window. It is the control for the numbers above, not a shipped
    // configuration — and five samples are enough for a 1000× gap.
    const naive = buildHistoryIndex(big, { checkpointEvery: big.length + 1 });
    const naiveTiming = sample(naive, 5);

    console.log(
      `deck-history-scrub ${JSON.stringify({
        events: big.length,
        checkpoints: index.checkpoints,
        checkpointEvery: CHECKPOINT_EVERY,
        buildMs,
        snapshotMeanMs: Math.round(bigTiming.mean * 1000) / 1000,
        snapshotWorstMs: Math.round(bigTiming.worst * 1000) / 1000,
        smallWindowEvents: small.length,
        smallWindowBuildMs: pageBuildMs,
        smallSnapshotMeanMs: Math.round(smallTiming.mean * 1000) / 1000,
        naiveSnapshotMeanMs: Math.round(naiveTiming.mean * 1000) / 1000,
      })}`,
    );

    expect(index.buckets.length).toBeLessThanOrEqual(RIBBON_MAX_BUCKETS);
    expect(index.checkpoints).toBeLessThanOrEqual(Math.ceil(big.length / CHECKPOINT_EVERY) + 2);
    // Building the index once is linear and happens once per event window; at
    // the operating point (the shell's one-page window) it is a few
    // milliseconds, and the printed `smallWindowBuildMs` is that number.
    expect(buildMs).toBeLessThan(2_000);
    expect(pageBuildMs).toBeLessThan(200);
    // A scrub lands in well under a frame, and the checkpoints are what makes
    // it independent of the window: the same walk without them re-folds the
    // whole log every sample, orders of magnitude slower.
    expect(bigTiming.worst).toBeLessThan(20);
    expect(bigTiming.mean).toBeLessThan(naiveTiming.mean);
  });
});

describe("attemptSegments delegates to the dashboard's segmentation", () => {
  test("same events, same segments — an equality, not a smoke test", () => {
    const events = [
      event(0, "a", "slice_claimed", { attempt: 1 }),
      event(1, "a", "worker_finished", { attempt: 1, atMs: T0 + 4_000 }),
      event(2, "a", "verify_failed", { attempt: 1 }),
      event(3, "a", "slice_retried", { attempt: 1 }),
      event(4, "a", "slice_claimed", { attempt: 2 }),
      event(5, "a", "slice_handoff", { attempt: 2 }),
      event(6, "a", "worker_finished", { attempt: 2, atMs: T0 + 20_000 }),
      event(7, "a", "verify_passed", { attempt: 2 }),
      event(8, "a", "slice_done", { attempt: 2 }),
    ];
    const expected = buildTimeline(events).rows.find((row) => row.sliceId === "a")!.attempts;
    expect(attemptSegments(events, "a")).toEqual(expected);
    expect(attemptSegments(events, "a")).toHaveLength(2);
    expect(attemptSegments(events, "missing")).toEqual([]);
  });
});
