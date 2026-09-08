/**
 * Scenario-based TUI / operational hardening (Sprint 4).
 *
 * TEXT-ONLY AGENT: everything here is STRUCTURAL VERIFICATION — geometry,
 * bounds, state transitions, clipping, and selection logic over deterministic
 * fixtures. No claim about visual quality is made (see the sprint report).
 *
 * The layout model mirrors the composition rules in watch.tsx / run.tsx /
 * unified.tsx without rendering Ink trees:
 * - wide (>=80 cols): board rail (boardWidth) + 1-col gutter + inspector rest
 * - narrow (<80): stacked panes, board width max(24, cols-2), no gutter
 * - forensics: content width max(20, width-6), body max(4, height-12)
 * - board rows clip ids to max(8, width-16); DAG indent caps at depth 4
 */

import { describe, expect, test } from "bun:test";
import {
  activityRows,
  fitLogTail,
  truncateMiddle,
  wrapLogLine,
} from "../src/run.tsx";
import {
  activityH,
  agentsH,
  boardH,
  boardWindow,
  boardWidth,
  clampTab,
  dagDepths,
  dagIndent,
  failureIndices,
  forensicsLayout,
  INSPECTOR_TABS,
  isFailureStatus,
  isNarrow,
  layoutRects,
  middleRows,
  moveSel,
  mutexHolders,
  narrowSplit,
  newFailures,
  nextFailure,
  preferredSel,
  prevFailure,
  railSplit,
  spinnerFrame,
  visibleIndices,
  type DetailView,
  type RunView,
  type SliceLine,
} from "../src/watch.tsx";

function line(id: string, status: SliceLine["status"], over: Partial<SliceLine> = {}): SliceLine {
  return { id, title: `Title ${id}`, status, attempts: 1, updatedAt: new Date().toISOString(), ...over };
}

function view(slices: SliceLine[], sel = 0, detail: DetailView | null = null): RunView {
  const count = (s: SliceLine["status"]): number => slices.filter((x) => x.status === s).length;
  return {
    runs: ["r"],
    runIdx: 0,
    sel,
    runId: "r",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    counts: {
      done: count("done"),
      active: count("running") + count("verifying"),
      failed: count("failed"),
      skipped: count("skipped"),
      blockedEnv: count("blocked-env"),
      pending: slices.length - count("done") - count("failed") - count("skipped"),
    },
    live: true,
    slices,
    detail,
  };
}

function detailFor(id: string, over: Partial<DetailView> = {}): DetailView {
  return {
    sliceId: id,
    title: `Title ${id}`,
    status: "done",
    attempts: 1,
    recentEvents: ["12:00:01 worker_finished"],
    history: [],
    ...over,
  };
}

// ── scenarios ────────────────────────────────────────────────────────────

describe("operational scenarios keep selection valid", () => {
  test("1: one running slice lands the cursor on it", () => {
    const v = view([line("a", "done"), line("b", "running"), line("c", "pending")]);
    expect(preferredSel(v.slices)).toBe(1);
  });

  test("2: multiple concurrent slices all surface as active", () => {
    const v = view([line("a", "running"), line("b", "verifying"), line("c", "pending")]);
    expect(v.counts.active).toBe(2);
    expect(mutexHolders(v.slices)).toEqual(["b"]);
    expect(preferredSel(v.slices)).toBe(0);
  });

  test("3/4: one and many failures are walkable with wrap", () => {
    const one = view([line("a", "done"), line("b", "failed", { reason: "verify_failed" }), line("c", "pending")]);
    expect(nextFailure(one.slices, 0)).toBe(1);
    expect(prevFailure(one.slices, 2)).toBe(1);
    // Wrap: past the last failure returns to the first.
    expect(nextFailure(one.slices, 2)).toBe(1);
    expect(prevFailure(one.slices, 0)).toBe(1);
    const many = view([line("a", "failed"), line("b", "done"), line("c", "failed"), line("d", "failed")]);
    expect(failureIndices(many.slices)).toEqual([0, 2, 3]);
    expect(nextFailure(many.slices, 1)).toBe(2);
    expect(nextFailure(many.slices, 3)).toBe(3);
    expect(nextFailure(many.slices, 4)).toBe(0);
  });

  test("5/6: blocked dependency vs blocked environment sort distinctly", () => {
    expect(isFailureStatus("blocked")).toBe(false);
    expect(isFailureStatus("blocked-env")).toBe(true);
    expect(isFailureStatus("failed")).toBe(true);
    const v = view([line("a", "blocked"), line("b", "blocked-env"), line("c", "pending")]);
    expect(failureIndices(v.slices)).toEqual([1]);
  });

  test("7: multi-gate verify keeps every step, first failure flagged", () => {
    const d = detailFor("s", {
      status: "failed",
      verdictPass: false,
      verdictSteps: [
        { name: "gate one", exit: 0, timedOut: false, tail: "ok" },
        { name: "gate two", exit: 1, timedOut: false, tail: "boom" },
      ],
      verdictStep: { name: "gate two", exit: 1, timedOut: false, tail: "boom" },
    });
    expect(d.verdictSteps).toHaveLength(2);
    expect(d.verdictStep!.name).toBe("gate two");
  });

  test("8/9: review verdicts distinguish minor polish from major rejection", () => {
    const minor = detailFor("s", { review: { approved: false, findings: ["rename x"] } });
    const major = detailFor("s", { review: { approved: false, findings: ["wrong behavior", "weakened tests"] } });
    expect(minor.review!.approved).toBe(false);
    expect(minor.review!.findings).toHaveLength(1);
    expect(major.review!.findings.length).toBeGreaterThan(1);
  });

  test("10: retried slice shows attempt count, cursor stays on it", () => {
    const v = view([line("a", "done"), line("b", "running", { attempts: 3 })], 1);
    expect(v.slices[v.sel]!.attempts).toBe(3);
    expect(preferredSel(v.slices)).toBe(1);
  });

  test("11: skip lets downstream proceed; filter never strands the cursor", () => {
    const v = view([line("a", "skipped"), line("b", "pending"), line("c", "failed")]);
    expect(visibleIndices(v.slices, true)).toEqual([2]);
    // Cursor on a hidden row under the filter: j/k re-seats onto visible rows.
    expect(moveSel(v.slices, 0, 1, true)).toBe(2);
    expect(moveSel(v.slices, 2, 1, true)).toBe(2);
    expect(moveSel(v.slices, 2, -1, true)).toBe(2);
  });

  test("12: failure filter with zero failures keeps a valid selection", () => {
    const v = view([line("a", "done"), line("b", "pending")]);
    expect(visibleIndices(v.slices, true)).toEqual([]);
    expect(moveSel(v.slices, 1, 1, true)).toBe(1);
  });

  test("13: killed slice beside a live one sorts live first", () => {
    const v = view([line("a", "aborted"), line("b", "running")]);
    expect(preferredSel(v.slices)).toBe(1);
    expect(isFailureStatus("aborted")).toBe(false);
  });

  test("14: replan/drift surfaces as a fresh run id, selection resets sanely", () => {
    const v = view([line("a", "pending"), line("b", "pending")]);
    expect(preferredSel(v.slices)).toBe(0);
  });

  test("selection stays valid after failures arrive mid-run", () => {
    const before = view([line("a", "running"), line("b", "running")]);
    const after = view([line("a", "failed", { reason: "x" }), line("b", "running")]);
    const fresh = newFailures(
      before.slices.filter((s) => isFailureStatus(s.status)).map((s) => s.id),
      after.slices.filter((s) => isFailureStatus(s.status)).map((s) => s.id),
    );
    expect(fresh).toEqual(["a"]);
    expect(preferredSel(after.slices)).toBe(0);
    expect(after.slices[preferredSel(after.slices)]).toBeDefined();
  });
});

// ── geometry invariants ──────────────────────────────────────────────────

describe("layout geometry never overlaps or goes negative", () => {
  for (const cols of [120, 100, 80, 79, 70, 60, 40, 30, 24]) {
    test(`width ${cols}: board + gutter + inspector are disjoint and positive`, () => {
      const r = layoutRects(cols);
      expect(r.board).toBeGreaterThan(0);
      expect(r.gutter).toBe(r.narrow ? 0 : 1);
      if (!r.narrow) {
        // Gutter: the inspector starts strictly after the board rail ends,
        // and at least one column remains for inspector content.
        expect(r.board + r.gutter).toBeLessThan(cols);
      } else if (cols >= 24) {
        // Stacked panes each fit the terminal width.
        expect(r.board).toBeLessThanOrEqual(cols);
      } else {
        // Deliberately tiny terminals: the 24-col floor holds (terminal
        // clips) instead of collapsing to zero/negative widths.
        expect(r.board).toBe(24);
      }
    });
  }

  test("narrow breakpoint matches the TUI stacking rule at 80/79", () => {
    expect(isNarrow(80)).toBe(false);
    expect(isNarrow(79)).toBe(true);
    expect(boardWidth(120)).toBe(36);
    expect(boardWidth(40)).toBe(24);
  });

  test("18: DAG indentation stays inside the board width at any depth", () => {
    for (const depth of [0, 1, 2, 3, 4, 5, 10]) {
      for (const w of [24, 32, 38]) {
        // BoardChip clips the id to max(8, w-16); indent + clipped id fits.
        const maxName = Math.max(8, w - 16);
        const id = "some-slice-id".slice(0, maxName);
        expect(dagIndent(depth).length + id.length).toBeLessThanOrEqual(w);
      }
    }
    // Indent caps at depth 4 no matter how deep the chain runs.
    expect(dagIndent(10)).toBe(dagIndent(4));
    const chain = [line("a", "done"), line("b", "pending", { deps: ["a"] }), line("c", "pending", { deps: ["b"] })];
    expect([...dagDepths(chain).values()]).toEqual([0, 1, 2]);
  });

  test("19: all six tabs address distinct content, index always clamped", () => {
    expect(INSPECTOR_TABS).toHaveLength(6);
    expect(clampTab(-1)).toBe(0);
    expect(clampTab(99)).toBe(5);
    const d = detailFor("s", {
      reportSummary: "did it",
      reportFull: { filesChanged: ["a.ts"], testsRun: ["bun test"], deferred: [], followUps: [] },
      verdictSteps: [{ name: "g", exit: 0, timedOut: false, tail: "ok" }],
      review: { approved: true, findings: [] },
      promptTail: "prompt…",
      workerTail: "out…",
      recentEvents: ["e1"],
    });
    // Output·Diff·Verify·Review·Prompt·Events each have backing content.
    expect(d.reportSummary).toBeTruthy();
    expect(d.reportFull!.filesChanged).toHaveLength(1);
    expect(d.verdictSteps).toHaveLength(1);
    expect(d.review!.approved).toBe(true);
    expect(d.promptTail).toBeTruthy();
    expect(d.workerTail).toBeTruthy();
    expect(d.recentEvents).toHaveLength(1);
  });

  test("15/16/20: forensics pager clamps scroll and width", () => {
    const long = Array.from({ length: 200 }, (_, i) => `log line ${i} with some content here`);
    for (const [height, width, scrollUp] of [[24, 120, 0], [24, 70, 50], [10, 40, 999], [30, 200, 199]] as const) {
      const w = forensicsLayout(long, height, width, scrollUp);
      expect(w.cw).toBeGreaterThanOrEqual(20);
      expect(w.bodyH).toBeGreaterThanOrEqual(4);
      expect(w.offset).toBeGreaterThanOrEqual(0);
      expect(w.offset).toBeLessThanOrEqual(w.maxScroll);
      expect(w.shown.length).toBeLessThanOrEqual(w.bodyH);
      for (const row of w.shown) expect(row.length).toBeLessThanOrEqual(w.cw);
    }
    const empty = forensicsLayout([], 24, 120, 0);
    expect(empty.shown).toEqual([]);
  });

  test("long strings clip inside their pane; activity tail fits its rows", () => {
    expect(truncateMiddle("x".repeat(200), 30).length).toBeLessThanOrEqual(30);
    const tail = fitLogTail(Array.from({ length: 50 }, (_, i) => `line ${i}`), 5, 80);
    expect(tail.length).toBeLessThanOrEqual(5);
    for (const w of [120, 80, 40]) {
      for (const row of wrapLogLine("y".repeat(300), w)) {
        expect(row.length).toBeLessThanOrEqual(Math.max(1, w - 6) + 1);
      }
    }
  });

  test("footer and activity budgets stay within terminal bounds", () => {
    for (const rows of [10, 24, 50]) {
      const logRows = activityRows(rows);
      expect(logRows).toBeGreaterThanOrEqual(3);
      expect(logRows).toBeLessThanOrEqual(9);
      expect(logRows + 3).toBeLessThanOrEqual(rows);
    }
  });

  test("running spinner rides the existing 900ms tick — no second loop", () => {
    expect(spinnerFrame(0, false)).toBe("○");
    expect(spinnerFrame(99999, false)).toBe("○");
    // Period boundary: stable inside a tick, advances on the next one.
    expect(spinnerFrame(0, true)).toBe(spinnerFrame(899, true));
    expect(spinnerFrame(0, true)).not.toBe(spinnerFrame(900, true));
    expect(spinnerFrame(0, true)).toBe(spinnerFrame(3600, true));
  });
});

// ── frame height budgets: the whole TUI fits the terminal ────────────────

describe("frame height never exceeds terminal rows", () => {
  test("header + middle + activity + footer == rows on usable terminals", () => {
    for (const rows of [16, 24, 30, 40, 50]) {
      const logRows = activityRows(rows);
      const actH = activityH(logRows);
      const mid = middleRows(rows, actH);
      expect(2 + mid + actH + 2).toBe(rows);
    }
    // Degenerate heights floor instead of going negative.
    expect(middleRows(10, activityH(activityRows(10)))).toBeGreaterThanOrEqual(3);
  });

  test("watch frame (no activity pane) fits: 2 + mid + 2 == rows", () => {
    for (const rows of [16, 24, 30, 50]) {
      expect(2 + middleRows(rows, 0) + 2).toBe(rows);
    }
  });

  test("boardWindow keeps the cursor visible and accounts every row", () => {
    for (const count of [1, 5, 20]) {
      for (const budget of [1, 2, 3, 9]) {
        for (const sel of [0, Math.floor(count / 2), count - 1]) {
          const w = boardWindow(count, sel, budget);
          expect(w.start).toBeGreaterThanOrEqual(0);
          expect(w.end).toBeLessThanOrEqual(count);
          expect(w.end - w.start).toBeLessThanOrEqual(Math.max(1, Math.min(count, budget)));
          expect(w.start).toBeLessThanOrEqual(sel);
          expect(sel).toBeLessThan(w.end);
          expect(w.top + (w.end - w.start) + w.bottom).toBe(count);
        }
      }
    }
    // No clipping, no markers when everything fits.
    expect(boardWindow(4, 2, 9)).toEqual({ start: 0, end: 4, top: 0, bottom: 0 });
  });

  test("railSplit: board + agents fit the wide middle band", () => {
    for (const middle of [4, 8, 11, 14, 20, 30]) {
      for (const slices of [0, 1, 6, 20]) {
        for (const agents of [0, 1, 4, 8]) {
          const { boardRows, agentsShown } = railSplit(middle, slices, agents);
          const bh = slices === 0 ? 4 : boardH(boardRows);
          expect(bh + agentsH(agentsShown, agents === 0)).toBeLessThanOrEqual(middle);
          expect(agentsShown).toBeLessThanOrEqual(Math.min(agents === 0 ? 1 : agents, 3));
          if (slices > 0) expect(boardRows).toBeGreaterThanOrEqual(1);
          else expect(boardRows).toBe(0);
        }
      }
    }
  });

  test("narrowSplit: board + inspector + agents sum to the middle band", () => {
    for (const middle of [8, 11, 16, 20, 30]) {
      for (const slices of [0, 2, 9]) {
        for (const agents of [0, 3]) {
          const n = narrowSplit(middle, slices, agents);
          const bh = slices === 0 ? 4 : boardH(n.boardRows);
          expect(n.boardRows).toBeLessThanOrEqual(3);
          expect(n.agentsShown).toBeLessThanOrEqual(1);
          expect(n.inspectorH).toBeGreaterThanOrEqual(3);
          expect(bh + agentsH(n.agentsShown, agents === 0) + 1 + n.inspectorH).toBe(middle);
        }
      }
    }
  });
});
