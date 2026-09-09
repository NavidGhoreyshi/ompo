import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentStates,
  boardWidth,
  clampTab,
  dagDepths,
  elapsedSince,
  failureIndices,
  forensicsPaths,
  formatDuration,
  formatEventLine,
  INSPECTOR_TABS,
  isFailureStatus,
  isNarrow,
  moveSel,
  mutexHolders,
  newFailures,
  nextFailure,
  prevFailure,
  sliceMetrics,
  spinnerFrame,
  summaryText,
  viewForRun,
  visibleIndices,
  type RunView,
  type SliceLine,
} from "../src/watch.tsx";
import { parseRoadmap } from "../src/parse.ts";
import { createRun } from "../src/store.ts";
import type { RunEvent } from "../src/types.ts";

function line(id: string, status: SliceLine["status"], deps: string[] = []): SliceLine {
  return { id, title: id, status, attempts: 1, updatedAt: "2026-09-07T08:00:00.000Z", deps };
}
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

describe("agentStates tokens", () => {
  test("tok lines set the session total without clobbering the last action", () => {
    expect(agentStates(["[a] turn 1…", "[a] tok in=238 out=211 total=19762"])).toEqual([
      { id: "a", tag: undefined, last: "turn 1…", tokens: "19.8k" },
    ]);
  });
  test("latest tok wins; rows without tok lines carry none", () => {
    expect(
      agentStates(["[a review] turn 5…", "[a review] tok in=100 out=50 total=1100", "[a review] tok in=200 out=60 total=2500", "[b] turn 1…"]),
    ).toEqual([
      { id: "a", tag: "review", last: "turn 5…", tokens: "2.5k" },
      { id: "b", tag: undefined, last: "turn 1…" },
    ]);
  });
  test("lines without a total fall back to the in/out pair", () => {
    expect(agentStates(["[a] tok in=18334 out=23"])).toEqual([
      { id: "a", tag: undefined, last: "", tokens: "18.3k/23" },
    ]);
  });
});

describe("inspector tabs", () => {
  test("six tabs in contract order, clamped", () => {
    expect([...INSPECTOR_TABS]).toEqual(["Output", "Diff", "Verify", "Review", "Prompt", "Events"]);
    expect(clampTab(0)).toBe(0);
    expect(clampTab(5)).toBe(5);
    expect(clampTab(99)).toBe(5);
    expect(clampTab(-3)).toBe(0);
    expect(clampTab(Number.NaN)).toBe(0);
  });
});

describe("failure navigation", () => {
  const slices = [line("a", "done"), line("b", "failed"), line("c", "running"), line("d", "blocked-env"), line("e", "failed")];

  test("only failed + blocked-env count, running does not", () => {
    expect(isFailureStatus("failed")).toBe(true);
    expect(isFailureStatus("blocked-env")).toBe(true);
    expect(isFailureStatus("running")).toBe(false);
    expect(isFailureStatus("done")).toBe(false);
    expect(failureIndices(slices)).toEqual([1, 3, 4]);
  });

  test("n walks forward wrapping, p walks back wrapping", () => {
    expect(nextFailure(slices, 0)).toBe(1);
    expect(nextFailure(slices, 2)).toBe(3);
    expect(nextFailure(slices, 5)).toBe(1);
    expect(prevFailure(slices, 4)).toBe(4);
    expect(prevFailure(slices, 3)).toBe(3);
    expect(prevFailure(slices, 2)).toBe(1);
    expect(prevFailure(slices, 0)).toBe(4);
  });

  test("-1 when no failures", () => {
    const clean = [line("a", "done"), line("b", "pending")];
    expect(nextFailure(clean, 0)).toBe(-1);
    expect(prevFailure(clean, 1)).toBe(-1);
    expect(failureIndices(clean)).toEqual([]);
  });
});

describe("failures-only filter + moveSel", () => {
  const slices = [line("a", "done"), line("b", "failed"), line("c", "pending"), line("d", "blocked-env")];

  test("visible rows shrink to failures, j/k clamp inside them", () => {
    expect(visibleIndices(slices, false)).toEqual([0, 1, 2, 3]);
    expect(visibleIndices(slices, true)).toEqual([1, 3]);
    expect(moveSel(slices, 1, 1, true)).toBe(3);
    expect(moveSel(slices, 3, 1, true)).toBe(3);
    expect(moveSel(slices, 3, -1, true)).toBe(1);
    expect(moveSel(slices, 0, 1, false)).toBe(1);
    expect(moveSel(slices, 0, -1, false)).toBe(0);
  });

  test("hidden cursor re-enters at the nearest visible edge", () => {
    expect(moveSel(slices, 0, 1, true)).toBe(1);
    expect(moveSel(slices, 2, -1, true)).toBe(3);
  });
});

describe("narrow layout + mutex + freshness", () => {
  test("isNarrow flips at 80 columns", () => {
    expect(isNarrow(79)).toBe(true);
    expect(isNarrow(80)).toBe(false);
    expect(isNarrow(120)).toBe(false);
  });

  test("mutex holders are exactly the verifying slices", () => {
    const slices = [line("a", "running"), line("b", "verifying"), line("c", "verifying"), line("d", "done")];
    expect(mutexHolders(slices)).toEqual(["b", "c"]);
    expect(mutexHolders([line("a", "done")])).toEqual([]);
  });

  test("elapsedSince renders compact age, blank when unparseable", () => {
    expect(elapsedSince("2026-09-07T08:00:00.000Z", Date.parse("2026-09-07T08:04:00.000Z"))).toBe("4m");
    expect(elapsedSince("not-a-date", Date.now())).toBe("");
  });

  test("newFailures diffs id sets", () => {
    expect(newFailures(["a"], ["a", "b"])).toEqual(["b"]);
    expect(newFailures(["a", "b"], ["a"])).toEqual([]);
    expect(newFailures([], [])).toEqual([]);
  });
});

describe("dag depths", () => {
  test("linear chain deepens, fan-in takes the max, roots stay 0", () => {
    const slices = [line("a", "pending"), line("b", "pending", ["a"]), line("c", "pending", ["b"]), line("d", "pending", ["a", "c"])];
    const depths = dagDepths(slices);
    expect(depths.get("a")).toBe(0);
    expect(depths.get("b")).toBe(1);
    expect(depths.get("c")).toBe(2);
    expect(depths.get("d")).toBe(3);
  });

  test("unknown deps and cycles stay total instead of looping", () => {
    const slices = [line("a", "pending", ["ghost"]), line("b", "pending", ["c"]), line("c", "pending", ["b"])];
    const depths = dagDepths(slices);
    expect(depths.get("a")).toBe(0);
    expect(depths.get("b")).toBeDefined();
    expect(depths.get("c")).toBeDefined();
  });
});

describe("forensics paths + view wiring", () => {
  test("branch naming matches the worktree convention", () => {
    const p = forensicsPaths("/proj", "run1", "s1");
    expect(p.branch).toBe("ompo/run1/s1");
    expect(p.dir).toBe(join("/proj", ".omp", "roadmap", "runs", "run1", "slices", "s1"));
  });

  test("viewForRun carries Depends through for DAG mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-dag-"));
    const doc = parseRoadmap("## [a] A\nDo A.\nVerify: true\n\n## [b] B\nDo B.\nDepends: a\nVerify: true\n");
    const { runId } = createRun(dir, doc);
    const v = viewForRun(dir, runId, 0);
    expect(v?.slices.map((s) => [s.id, s.deps])).toEqual([
      ["a", []],
      ["b", ["a"]],
    ]);
  });
});
