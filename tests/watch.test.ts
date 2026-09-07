import { describe, expect, test } from "bun:test";
import {
  agentStates,
  boardWidth,
  formatDuration,
  formatEventLine,
  sliceMetrics,
  spinnerFrame,
  summaryText,
  type RunView,
} from "../src/watch.tsx";
import type { RunEvent } from "../src/types.ts";
describe("formatDuration", () => {
  test("seconds, minutes, hours", () => {
    expect(formatDuration(45000)).toBe("45s");
    expect(formatDuration(318683)).toBe("5m");
    expect(formatDuration(7440000)).toBe("2h04m");
  });
});

function view(counts: RunView["counts"]): RunView {
  return {
    runs: ["r"],
    runIdx: 0,
    sel: 0,
    runId: "r",
    createdAt: "2026-09-07T07:00:00.000Z",
    updatedAt: "2026-09-07T08:00:00.000Z",
    counts,
    live: true,
    slices: [],
    detail: null,
  };
}

function ev(partial: Partial<RunEvent> & { type: RunEvent["type"] }): RunEvent {
  return { seq: 1, at: "2026-09-07T11:20:30.000Z", ...partial };
}

describe("summaryText", () => {
  test("leads done · active, omits zero counts", () => {
    const s = summaryText(view({ done: 1, active: 1, failed: 0, skipped: 0, blockedEnv: 0, pending: 17 }));
    expect(s).toBe("done 1 · active 1 · pend 17");
  });

  test("failure and env states stay visible", () => {
    const s = summaryText(view({ done: 2, active: 0, failed: 1, skipped: 0, blockedEnv: 1, pending: 3 }));
    expect(s).toContain("fail 1");
    expect(s).toContain("env 1");
  });
});

describe("boardWidth", () => {
  test("clamps to a usable band on narrow and wide terminals", () => {
    expect(boardWidth(40)).toBe(24);
    expect(boardWidth(80)).toBe(24);
    expect(boardWidth(200)).toBe(38);
    expect(boardWidth(120)).toBe(36);
  });
});

describe("spinnerFrame", () => {
  test("frozen when idle, advancing while live", () => {
    expect(spinnerFrame(12345, false)).toBe("○");
    expect(spinnerFrame(0, true)).toBe("◐");
    expect(spinnerFrame(900, true)).toBe("◓");
    expect(spinnerFrame(3600, true)).toBe("◐");
  });
});

describe("formatEventLine", () => {
  test("TIME → EVENT → SOURCE → DETAIL order", () => {
    const s = formatEventLine(ev({ type: "worker_finished", sliceId: "a", attempt: 1, stats: { turns: 73, tools: 47 } }));
    expect(s).toBe("11:20:30 worker_finished a #1 73t/47tl");
  });

  test("source elided for per-slice rows", () => {
    const s = formatEventLine(ev({ type: "slice_done", sliceId: "a", attempt: 1 }), { source: false });
    expect(s).toBe("11:20:30 slice_done #1");
  });
});

describe("sliceMetrics", () => {
  test("takes the last finished run counters, undefined when none", () => {
    const events = [
      ev({ seq: 1, type: "worker_finished", sliceId: "a", stats: { turns: 10, tools: 5 }, durationMs: 60000 }),
      ev({ seq: 2, type: "worker_finished", sliceId: "a", stats: { turns: 73, tools: 47 }, durationMs: 96000 }),
    ];
    expect(sliceMetrics(events, "a")).toEqual({ turns: 73, tools: 47, durationMs: 96000 });
    expect(sliceMetrics(events, "b")).toBeUndefined();
  });
});

describe("agentStates tags", () => {
  test("parses [id tag] sessions without breaking plain ids", () => {
    expect(agentStates(["[a] turn 2…"])).toEqual([{ id: "a", tag: undefined, last: "turn 2…" }]);
    expect(agentStates(["[s1-deploy-b review] turn 5…"])).toEqual([
      { id: "s1-deploy-b", tag: "review", last: "turn 5…" },
    ]);
  });
});
