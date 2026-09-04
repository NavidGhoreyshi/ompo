import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { runRoadmapLoop } from "../src/loop.ts";
import { createRun, loadRun, storeApi } from "../src/store.ts";
import { REPORT_CLOSE, REPORT_OPEN } from "../src/report.ts";
import type { WorkerRunner } from "../src/worker.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-loop-"));
}

function reportFor(sliceId: string, summary = `did ${sliceId}`): string {
  return `note\n${REPORT_OPEN}\n${JSON.stringify({
    sliceId,
    summary,
    filesChanged: [],
    testsRun: [],
    testsPassed: true,
    verificationNotes: "ok",
    followUps: [],
    done: true,
  })}\n${REPORT_CLOSE}`;
}

const okRunner: WorkerRunner = async (call) => ({
  exit: 0,
  timedOut: false,
  stdout: reportFor(call.sliceId),
  stderr: "",
  durationMs: 1,
});

const MD3 = `## [a] A\nDo A.\n## [b] B\nDepends: a\nDo B.\n## [c] C\nDepends: b\nDo C.\n`;

describe("loop", () => {
  test("happy path: 3 slices all done, exit 0", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD3), "r");
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(3);
    const c = loadRun(dir, "r");
    expect(c.doc.slices.every((s) => s.status === "done")).toBe(true);
  });

  test("verify-fail → retry → pass", async () => {
    const dir = tmpProject();
    // slice a has a verifier that fails once: use attempt-counted marker file.
    const md = `## [a] A\nDo A.\nVerify: test ! -f marker || (rm marker && exit 1)\n`;
    // Simpler: verifier fails on first attempt via stateful command.
    const md2 = `## [a] A\nDo A.\nVerify: bash -lc 'if [ -f flag ]; then exit 0; else touch flag; exit 1; fi'\n`;
    void md;
    createRun(dir, parseRoadmap(md2), "r");
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    const a = loadRun(dir, "r").doc.slices[0]!;
    expect(a.status).toBe("done");
    expect(a.attempts).toBe(2);
  });

  test("exhausted-fail continues to next slice, exit 1", async () => {
    const dir = tmpProject();
    const md = `## [a] A\nDo A.\nVerify: exit 1\nRetries: 1\n## [b] B\nDo B.\n`;
    createRun(dir, parseRoadmap(md), "r");
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    const c = loadRun(dir, "r");
    expect(c.doc.slices.find((s) => s.id === "a")!.status).toBe("failed");
    expect(c.doc.slices.find((s) => s.id === "b")!.status).toBe("done");
  });

  test("strict-invalid report → worker failure → terminal with retries=0", async () => {
    const dir = tmpProject();
    const md = `## [a] A\nDo A.\nRetries: 0\n`;
    createRun(dir, parseRoadmap(md), "r");
    const bad: WorkerRunner = async () => ({
      exit: 0,
      timedOut: false,
      stdout: "i did stuff but no report block",
      stderr: "",
      durationMs: 1,
    });
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: bad, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("failed");
  });

  test("abort mid-slice → resume re-runs slice", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD3), "r");
    const ctrl = new AbortController();
    const blocking: WorkerRunner = async () => {
      ctrl.abort();
      return { exit: 0, timedOut: false, stdout: reportFor("a"), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: blocking,
      signal: ctrl.signal,
      onEvent: () => {},
    });
    expect(res.exitCode).toBe(2);
    // Slice a was claimed then aborted → demote via resume, re-run completes.
    storeApi.resumeRun(dir, "r");
    const res2 = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: () => {} });
    expect(res2.exitCode).toBe(0);
    expect(res2.done).toBe(3);
  });
});
