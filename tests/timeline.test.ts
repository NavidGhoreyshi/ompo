import { describe, expect, test } from "bun:test";
import { buildTimeline } from "../web/src/lib/timeline.ts";
import type { RunEvent } from "../web/src/api.ts";

function ev(partial: Partial<RunEvent> & { seq: number; at: string; type: string }): RunEvent {
  return partial as RunEvent;
}

// Attempt boundaries, retries, generations, tokens, duration — all observed.
const EVENTS: RunEvent[] = [
  ev({ seq: 0, at: "2026-09-09T10:00:00.000Z", type: "run_started" }),
  ev({ seq: 1, at: "2026-09-09T10:00:01.000Z", type: "slice_claimed", sliceId: "w1a", attempt: 1 }),
  ev({ seq: 2, at: "2026-09-09T10:00:02.000Z", type: "slice_claimed", sliceId: "w1b", attempt: 1 }),
  ev({ seq: 3, at: "2026-09-09T10:00:30.000Z", type: "slice_handoff", sliceId: "w1a", attempt: 1 }),
  ev({
    seq: 4,
    at: "2026-09-09T10:01:01.000Z",
    type: "worker_finished",
    sliceId: "w1a",
    attempt: 1,
    durationMs: 60_000,
    stats: { turns: 9, tools: 21, tokens: { input: 8000, output: 2000, total: 10_000 } },
  }),
  ev({ seq: 5, at: "2026-09-09T10:01:02.000Z", type: "slice_done", sliceId: "w1a", attempt: 1 }),
  ev({
    seq: 6,
    at: "2026-09-09T10:02:02.000Z",
    type: "worker_finished",
    sliceId: "w1b",
    attempt: 1,
    durationMs: 120_000,
    stats: { turns: 4, tools: 6, tokens: { input: 3000, output: 1000, total: 4000 } },
  }),
  ev({ seq: 7, at: "2026-09-09T10:02:03.000Z", type: "verify_failed", sliceId: "w1b", attempt: 1 }),
  ev({ seq: 8, at: "2026-09-09T10:02:04.000Z", type: "slice_retried", sliceId: "w1b", attempt: 1 }),
  ev({ seq: 9, at: "2026-09-09T10:02:05.000Z", type: "slice_claimed", sliceId: "w1b", attempt: 2 }),
  // w1b attempt 2 never closes: still open at the last observed event.
  ev({ seq: 10, at: "2026-09-09T10:03:05.000Z", type: "worker_finished", sliceId: "w1b", attempt: 2 }),
];

describe("buildTimeline", () => {
  test("attempt boundaries, generations, tokens, durations, retries", () => {
    const m = buildTimeline(EVENTS, [
      { id: "w1a", title: "First" },
      { id: "w1b", title: "Second" },
    ]);
    expect(m.rows.map((r) => r.sliceId)).toEqual(["w1a", "w1b"]);
    expect(m.spanMs).toBe(185_000);

    const a = m.rows[0]!.attempts[0]!;
    expect(a.open).toBe(false);
    expect(a.outcome).toBe("slice_done");
    expect(a.generations).toBe(2);
    expect(a.handoffMs).toHaveLength(1);
    expect(a.tokens).toBe(10_000);
    expect(a.workerMs).toBe(60_000);
    expect(a.durationMs).toBe(61_000);

    const b = m.rows[1]!;
    expect(b.attempts).toHaveLength(2);
    expect(b.retries).toBe(1);
    expect(b.attempts[0]!.outcome).toBe("slice_retried");
    expect(b.attempts[0]!.tokens).toBe(4000);
    // Open attempt: bounded by its own last event, never extrapolated.
    expect(b.attempts[1]!.open).toBe(true);
    expect(b.attempts[1]!.outcome).toBeNull();
    expect(b.attempts[1]!.endSeq).toBe(10);
    expect(b.attempts[1]!.lastType).toBe("worker_finished");
  });

  test("long tail flags only a dominant slice", () => {
    const m = buildTimeline(EVENTS, [
      { id: "w1a", title: "First" },
      { id: "w1b", title: "Second" },
    ]);
    // w1b total (123s + 60s) dominates w1a (61s) by ≥2× median.
    expect(m.longTailIds).toEqual(["w1b"]);
    expect(m.maxTotalMs).toBe(m.rows[1]!.totalMs);
  });

  test("empty log and terminal-first history never throw", () => {
    const empty = buildTimeline([], []);
    expect(empty.rows).toEqual([]);
    expect(empty.spanMs).toBeNull();

    // No claim observed (tailed mid-run): the slice still appears.
    const mid = buildTimeline(
      [ev({ seq: 8, at: "2026-09-09T10:02:04.000Z", type: "slice_done", sliceId: "w9z" })],
      [],
    );
    expect(mid.rows).toHaveLength(1);
    expect(mid.rows[0]!.attempts[0]!.outcome).toBe("slice_done");
  });

  test("uniform runs flag no long tail", () => {
    const evs: RunEvent[] = [
      ev({ seq: 0, at: "2026-09-09T10:00:00.000Z", type: "run_started" }),
      ev({ seq: 1, at: "2026-09-09T10:00:01.000Z", type: "slice_claimed", sliceId: "a", attempt: 1 }),
      ev({ seq: 2, at: "2026-09-09T10:01:01.000Z", type: "slice_done", sliceId: "a", attempt: 1 }),
      ev({ seq: 3, at: "2026-09-09T10:00:01.000Z", type: "slice_claimed", sliceId: "b", attempt: 1 }),
      ev({ seq: 4, at: "2026-09-09T10:01:01.000Z", type: "slice_done", sliceId: "b", attempt: 1 }),
    ];
    expect(buildTimeline(evs).longTailIds).toEqual([]);
  });
});
