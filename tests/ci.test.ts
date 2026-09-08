import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ciAnnotationFor,
  formatCiEvent,
  jobSummaryPaths,
  parseCiFormat,
  renderProgressBar,
  summarizeRun,
} from "../src/ci.ts";
import { createRun } from "../src/store.ts";
import type { RoadmapDoc, RunEvent } from "../src/types.ts";

function ev(partial: Partial<RunEvent> & { type: RunEvent["type"] }): RunEvent {
  return { seq: 1, at: new Date("2026-09-08T10:00:00.000Z").toISOString(), ...partial };
}

function doc(): RoadmapDoc {
  return {
    version: 1,
    sourceHash: "abc",
    slices: [
      {
        id: "a",
        title: "A",
        body: "",
        deps: [],
        verify: [],
        files: [],
        maxRetries: 1,
        status: "pending",
        attempts: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
}

describe("parseCiFormat", () => {
  test("undefined defaults to pretty; valid values pass through", () => {
    expect(parseCiFormat(undefined)).toBe("pretty");
    expect(parseCiFormat("pretty")).toBe("pretty");
    expect(parseCiFormat("json")).toBe("json");
    expect(parseCiFormat("tap")).toBe("tap");
    expect(parseCiFormat("github")).toBe("github");
  });

  test("unknown values throw listing the valid values", () => {
    expect(() => parseCiFormat("yaml")).toThrow(/pretty.*json.*tap.*github/);
    expect(() => parseCiFormat("")).toThrow(/pretty/);
  });
});

describe("formatCiEvent tap", () => {
  test("pass types map to ok with slice and detail", () => {
    const line = formatCiEvent(
      ev({ seq: 3, type: "slice_done", sliceId: "a", detail: "merged" }),
      "tap",
    );
    expect(line).toBe("ok 3 slice_done a # merged");
  });

  test("failing types map to not ok", () => {
    for (const type of [
      "verify_failed",
      "slice_failed_terminal",
      "run_aborted",
      "control_rejected",
    ] as const) {
      const line = formatCiEvent(ev({ seq: 7, type, sliceId: "a" }), "tap");
      expect(line.startsWith("not ok 7 ")).toBe(true);
    }
  });

  test("index overrides the test number; reason backs up missing detail", () => {
    const line = formatCiEvent(
      ev({ seq: 9, type: "verify_failed", sliceId: "a", reason: "worker_timeout" }),
      "tap",
      { n: 2, total: 5 },
    );
    expect(line).toBe("not ok 2 verify_failed a # reason=worker_timeout");
  });

  test("json round-trips; pretty keeps the log shape", () => {
    const e = ev({ seq: 12, type: "slice_claimed", sliceId: "a", attempt: 1 });
    expect(JSON.parse(formatCiEvent(e, "json"))).toEqual(e);
    const pretty = formatCiEvent(e, "pretty");
    expect(pretty).toContain("slice_claimed");
    expect(pretty).toContain("a");
    expect(pretty).toContain("#1");
  });
});

describe("ciAnnotationFor", () => {
  test("routine chatter maps to null", () => {
    for (const type of ["run_started", "slice_claimed", "worker_finished"] as const) {
      expect(ciAnnotationFor(ev({ type }))).toBeNull();
    }
  });

  test("failures become ::error with a title", () => {
    const line = ciAnnotationFor(
      ev({ type: "slice_failed_terminal", sliceId: "a", detail: "boom" }),
    );
    expect(line).toBe("::error title=ompo.slice_failed_terminal::a: boom");
  });

  test("blocks/skips/kills become ::warning; progress becomes ::notice", () => {
    expect(
      ciAnnotationFor(ev({ type: "slice_blocked_env", sliceId: "a", detail: "no creds" })),
    ).toBe("::warning title=ompo.slice_blocked_env::a: no creds");
    expect(ciAnnotationFor(ev({ type: "slice_skipped", sliceId: "a" }))).toStartWith(
      "::warning title=ompo.slice_skipped::",
    );
    expect(ciAnnotationFor(ev({ type: "slice_done", sliceId: "a" }))).toStartWith(
      "::notice title=ompo.slice_done::",
    );
  });

  test("never emits an empty body: detail-less events fall back", () => {
    for (const type of [
      "verify_failed",
      "slice_failed_terminal",
      "run_aborted",
      "slice_blocked_env",
      "run_finished",
    ] as const) {
      const line = ciAnnotationFor(ev({ type }))!;
      expect(line).not.toEndWith("::");
      expect(line.length).toBeGreaterThan(`::notice title=ompo.${type}::`.length - 2);
    }
  });

  test("github format always renders a non-empty line", () => {
    const line = formatCiEvent(ev({ type: "verify_failed" }), "github");
    expect(line).toBe("::error title=ompo.verify_failed::verify_failed");
  });
});

describe("renderProgressBar", () => {
  test("total 0 renders an empty bar without crashing", () => {
    expect(renderProgressBar(0, 0)).toBe(`${"░".repeat(12)} 0/0`);
  });

  test("partial fills round(done/total*width)", () => {
    expect(renderProgressBar(4, 12)).toBe(`${"█".repeat(4)}${"░".repeat(8)} 4/12`);
    expect(renderProgressBar(1, 2, 10)).toBe(`${"█".repeat(5)}${"░".repeat(5)} 1/2`);
  });

  test("full and custom widths", () => {
    expect(renderProgressBar(12, 12)).toBe(`${"█".repeat(12)} 12/12`);
    expect(renderProgressBar(0, 5)).toBe(`${"░".repeat(12)} 0/5`);
    expect(renderProgressBar(3, 3, 4)).toBe("████ 3/3");
  });
});

describe("jobSummaryPaths", () => {
  test("returns only the summary docs that exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-ci-"));
    const { runId } = createRun(dir, doc(), "20260908-ci0001");
    expect(jobSummaryPaths(dir, runId)).toEqual([]);
    writeFileSync(join(dir, ".omp", "roadmap", "runs", runId, "deferred.md"), "# deferred\n");
    const paths = jobSummaryPaths(dir, runId);
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith(join("runs", runId, "deferred.md"))).toBe(true);
    writeFileSync(
      join(dir, ".omp", "roadmap", "runs", runId, "placeholders.md"),
      "# placeholders\n",
    );
    expect(jobSummaryPaths(dir, runId)).toHaveLength(2);
  });
});

describe("summarizeRun", () => {
  test("counts done/total; failed is the max of status and event failures", () => {
    const events = [
      ev({ seq: 1, type: "slice_done", sliceId: "a" }),
      ev({ seq: 2, type: "slice_failed_terminal", sliceId: "b" }),
    ];
    expect(summarizeRun({ done: 3, failed: 1, pending: 2 }, events)).toEqual({
      done: 3,
      total: 6,
      failed: 1,
    });
    // Statuses lagging the log still surface the failure via events.
    expect(summarizeRun({ done: 3, pending: 3 }, events)).toEqual({
      done: 3,
      total: 6,
      failed: 1,
    });
    expect(summarizeRun({}, [])).toEqual({ done: 0, total: 0, failed: 0 });
  });
});
