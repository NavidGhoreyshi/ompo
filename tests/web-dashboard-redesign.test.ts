/**
 * Dashboard behavior: the pure derivations the browser UI is built on
 * (auto-selection, hero action line, observed execution phases). Layout and
 * rendering are verified in the browser by `tests/e2e/*.e2e.ts` — this file
 * asserts behavior, never CSS or component source text.
 */

import { describe, expect, test } from "bun:test";
import type { SliceSummary } from "../web/src/api.ts";
import { buildPipelineStages, currentStageIndex } from "../web/src/lib/pipeline.ts";
import { heroAction, preferredSliceId } from "../web/src/lib/selection.ts";

function slice(id: string, status: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return { id, status, updatedAt };
}

function summary(status: string, attempts: number, generation: number): SliceSummary {
  return {
    id: "s",
    title: "S",
    status,
    attempts,
    generation,
    updatedAt: "2026-01-01T00:00:00.000Z",
    deps: [],
    verify: [],
  };
}

describe("preferred slice auto-selection (single selection system)", () => {
  test("empty run selects nothing", () => {
    expect(preferredSliceId([])).toBeNull();
  });

  test("running slice beats done and pending", () => {
    expect(preferredSliceId([slice("a", "done"), slice("b", "running"), slice("c", "pending")])).toBe("b");
  });

  test("verifying slice beats failed", () => {
    expect(preferredSliceId([slice("f", "failed"), slice("v", "verifying")])).toBe("v");
  });

  test("failed beats blocked-env and done when nothing runs", () => {
    expect(preferredSliceId([slice("d", "done"), slice("e", "blocked-env"), slice("f", "failed")])).toBe("f");
  });

  test("blocked-env beats done and pending when nothing runs or fails", () => {
    expect(preferredSliceId([slice("d", "done"), slice("p", "pending"), slice("e", "blocked-env")])).toBe("e");
  });

  test("most recently completed done slice wins among done", () => {
    expect(
      preferredSliceId([
        slice("old", "done", "2026-01-01T00:00:00.000Z"),
        slice("new", "done", "2026-03-01T00:00:00.000Z"),
        slice("p", "pending"),
      ]),
    ).toBe("new");
  });

  test("first slice wins when everything is pending", () => {
    expect(preferredSliceId([slice("a", "pending"), slice("b", "pending")])).toBe("a");
  });

  test("concurrent runners resolve to the first live slice, never null", () => {
    expect(preferredSliceId([slice("w1", "running"), slice("w2", "running"), slice("q", "pending")])).toBe("w1");
  });
});

describe("hero action line (what is it on?)", () => {
  test("live worker line wins", () => {
    expect(heroAction({ status: "running", lastLine: "run typecheck", lastEvent: "slice_claimed" })).toBe("run typecheck");
  });

  test("latest slice event is the fallback", () => {
    expect(heroAction({ status: "running", lastEvent: "worker_finished — ok" })).toBe("worker_finished — ok");
  });

  test("pending names its dependencies", () => {
    expect(heroAction({ status: "pending", deps: ["s4b", "s5a"] })).toBe("queued — needs s4b, s5a");
    expect(heroAction({ status: "pending", deps: [] })).toBe("queued");
  });

  test("failure and block surface their reasons", () => {
    expect(heroAction({ status: "failed", reason: "gate bun test failed" })).toBe("gate bun test failed");
    expect(heroAction({ status: "blocked-env", reason: "postgres down" })).toBe("postgres down");
    expect(heroAction({ status: "blocked-env" })).toBe("waiting on environment");
  });

  test("verifying and idle states never invent work", () => {
    expect(heroAction({ status: "verifying" })).toBe("gates running…");
    expect(heroAction({ status: "running" })).toBe("working…");
    expect(heroAction({ status: "done" })).toBe("done");
  });
});

describe("execution spine leads with the observed phase", () => {
  const currentLabel = (status: string, attempts: number, generation: number): string | null => {
    const stages = buildPipelineStages(summary(status, attempts, generation), null);
    const i = currentStageIndex(stages);
    return i >= 0 ? stages[i]!.label : null;
  };

  test("a working slice leads with Work, not the phase it entered first", () => {
    expect(currentLabel("running", 1, 0)).toBe("Work");
    expect(currentLabel("running", 2, 1)).toBe("Work");
  });

  test("a verifying slice leads with Verify", () => {
    expect(currentLabel("verifying", 1, 0)).toBe("Verify");
  });

  test("a failed slice leads with its terminal stage when no verdict detail is loaded", () => {
    expect(currentLabel("failed", 1, 0)).toBe("Done");
  });

  test("a finished slice leads with Done and shows no live phase", () => {
    const stages = buildPipelineStages(summary("done", 1, 0), null);
    expect(currentLabel("done", 1, 0)).toBe("Done");
    expect(stages.some((s) => s.state === "running")).toBe(false);
  });

  test("an unclaimed slice has no current phase", () => {
    expect(currentStageIndex(buildPipelineStages(summary("pending", 0, 0), null))).toBe(-1);
  });
});
