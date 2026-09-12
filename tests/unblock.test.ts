import { describe, expect, test } from "bun:test";
 import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { runRoadmapLoop } from "../src/loop.ts";
import { createRun, loadRun } from "../src/store.ts";
import { REPORT_CLOSE, REPORT_OPEN } from "../src/report.ts";
import { REVIEW_CLOSE, REVIEW_OPEN } from "../src/review.ts";
import type { WorkerCall, WorkerContext, WorkerResult, WorkerRunner } from "../src/worker.ts";
import {
  buildUnblockPrompt,
  collectUnblockInfo,
  hasPredeployWork,
  recheckUnblockTargets,
  stallTargets,
} from "../src/unblock.ts";

function reportFor(sliceId: string, done = true, notes = "ok"): string {
  return `note\n${REPORT_OPEN}\n${JSON.stringify({
    sliceId,
    summary: `did ${sliceId}`,
    filesChanged: [],
    testsRun: [],
    testsPassed: done,
    verificationNotes: notes,
    followUps: [],
    deferred: [],
    done,
  })}\n${REPORT_CLOSE}`;
}

function verdictFor(sliceId: string): string {
  return `${REVIEW_OPEN}\n${JSON.stringify({ sliceId, approved: true, findings: [], notes: "audited ok" })}\n${REVIEW_CLOSE}`;
}

function baseRunner(
  onUnblock: (worktrees: string[]) => WorkerResult,
  calls: { unblock: number },
): WorkerRunner {
  return async (call: WorkerCall, _ctx: WorkerContext) => {
    if (call.label?.endsWith(" review")) {
      return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
    }
    if (call.label?.endsWith(" unblock")) {
      calls.unblock++;
      const wts = [...call.prompt.matchAll(/^Worktree: (\S+)/gm)].map((m) => m[1]!);
      return onUnblock(wts);
    }
    return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
  };
}

const okUnblock = (wts: string[]): WorkerResult => {
  for (const wt of wts) writeFileSync(join(wt, "unblocked"), "ok", "utf8");
  // head id is validated by the loop; tests use single-slice roadmaps ("a").
  return { exit: 0, timedOut: false, stdout: reportFor("a"), stderr: "", durationMs: 1 };
};

const DB_DOWN_GATE = `if [ -f unblocked ]; then exit 0; else echo connect ECONNREFUSED localhost:5432; exit 1; fi`;

describe("stallTargets", () => {
  test("blocked-env + failed block, done/skipped/pending/deploy do not", () => {
    const doc = parseRoadmap(
      "## [a] A\nDo A.\n## [b] B\nDo B.\n## [deploy] Deploy\nShip it.\n## [c] C\nDo C.\n",
    );
    doc.slices[0]!.status = "blocked-env";
    doc.slices[1]!.status = "failed";
    doc.slices[2]!.status = "blocked-env";
    doc.slices[3]!.status = "pending";
    expect(stallTargets(doc).map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("hasPredeployWork", () => {
  test("true with pending pre-deploy work, false when only deploy remains or all settled", () => {
    const pending = parseRoadmap("## [a] A\nDo A.\n## [deploy] Deploy\nShip it.\n");
    expect(hasPredeployWork(pending)).toBe(true);
    const deployOnly = parseRoadmap("## [deploy] Deploy\nShip it.\n");
    deployOnly.slices[0]!.status = "pending";
    expect(hasPredeployWork(deployOnly)).toBe(false);
    const settled = parseRoadmap("## [a] A\nDo A.\n");
    settled.slices[0]!.status = "done";
    expect(hasPredeployWork(settled)).toBe(false);
  });
});

describe("buildUnblockPrompt", () => {
  test("names targets, worktrees, rails, and the head report contract", () => {
    const p = buildUnblockPrompt(
      [
        { sliceId: "a", title: "A", status: "blocked-env", reason: "database unreachable", failingCommand: "pg_isready", failingTail: "refused", worktree: "/tmp/wt-a" },
        { sliceId: "b", title: "B", status: "failed", reason: "", failingCommand: undefined, failingTail: "", worktree: "" },
      ],
      1,
      2,
    );
    expect(p).toContain("round 1/2");
    expect(p).toContain("### a — A (status blocked-env)");
    expect(p).toContain("Worktree: /tmp/wt-a");
    expect(p).toContain("Failing gate: $ pg_isready");
    expect(p).toContain("Do NOT touch .omp/**");
    expect(p).toContain("FRESH shell");
    expect(p).toContain('"sliceId": "a"');
  });
});

describe("collectUnblockInfo + recheck", () => {
  test("reads verdict evidence and re-runs the failing command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-unblock-info-"));
    const wt = mkdtempSync(join(tmpdir(), "ompo-unblock-wt-"));
    const runDir = join(dir, ".omp", "roadmap", "runs", "r", "slices", "a");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "verdict.json"),
      JSON.stringify({ sliceId: "a", attempt: 1, pass: false, at: "t", steps: [{ name: "g", command: "test -f marker", exit: 1, timedOut: false, outputTail: "nope", logRef: "l" }] }) + "\n",
      "utf8",
    );
    const doc = parseRoadmap("## [a] A\nDo A.\n");
    doc.slices[0]!.status = "blocked-env";
    doc.slices[0]!.verdictRef = join("slices", "a", "verdict.json");
    const info = collectUnblockInfo(dir, "r", doc, () => wt);
    expect(info[0]!.failingCommand).toBe("test -f marker");
    expect(info[0]!.worktree).toBe(wt);
    expect(await recheckUnblockTargets({ projectDir: dir, targets: info, onEvent: () => {} })).toEqual([]);
    writeFileSync(join(wt, "marker"), "ok", "utf8");
    expect(await recheckUnblockTargets({ projectDir: dir, targets: info, onEvent: () => {} })).toEqual(["a"]);
  });
});

describe("end-of-run unblock lane", () => {
  test("blocked-env heals via agent and the run completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-unblock-e2e-"));
    createRun(dir, parseRoadmap(`## [a] A\nDo A.\nVerify: ${DB_DOWN_GATE}\nRetries: 0\n`), "r");
    const events: string[] = [];
    const calls = { unblock: 0 };
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: baseRunner(okUnblock, calls),
      noDebug: true,
      onEvent: (m) => events.push(m),
    });
    expect(calls.unblock).toBe(1);
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
    expect(events.some((m) => m.includes("unblock round 1/2"))).toBe(true);
    expect(events.some((m) => m.includes("unblocked: a"))).toBe(true);
    expect(existsSync(join(dir, ".omp", "roadmap", "runs", "r", "unblock-1.prompt.md"))).toBe(true);
  });

  test("unblock session streams its transcript and records targets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-unblock-stream-"));
    createRun(dir, parseRoadmap(`## [a] A\nDo A.\nVerify: ${DB_DOWN_GATE}\nRetries: 0\n`), "r");
    const runRoot = join(dir, ".omp", "roadmap", "runs", "r");
    // Observed synchronously inside the fake runner: the loop appends the
    // transcript line before onProgress returns, while round 1 is running.
    let streamed = false;
    const runner: WorkerRunner = async (call, ctx) => {
      if (call.label?.endsWith(" review")) {
        return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
      }
      if (call.label?.endsWith(" unblock")) {
        ctx.onProgress?.("mid-run unblock line");
        try {
          const mid = readFileSync(join(runRoot, "unblock-1.log"), "utf8");
          streamed = mid.includes("mid-run unblock line") && !mid.startsWith("exit=");
        } catch {
          streamed = false;
        }
        const wts = [...call.prompt.matchAll(/^Worktree: (\S+)/gm)].map((m) => m[1]!);
        return okUnblock(wts);
      }
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, noDebug: true, onEvent: () => {} });
    expect(res.done).toBe(1);
    expect(streamed).toBe(true);
    expect(JSON.parse(readFileSync(join(runRoot, "unblock-1.meta.json"), "utf8"))).toEqual(
      expect.objectContaining({ targets: ["a"] }),
    );
    // Completion appends the forensic footer after the live lines — the live
    // transcript must survive the footer, never be overwritten by it.
    const final = readFileSync(join(runRoot, "unblock-1.log"), "utf8");
    expect(final).toContain("mid-run unblock line");
    expect(final).toContain("exit=");
  });

  test("agent giving up ends the run blocked as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-unblock-giveup-"));
    createRun(dir, parseRoadmap(`## [a] A\nDo A.\nVerify: ${DB_DOWN_GATE}\nRetries: 0\n`), "r");
    const calls = { unblock: 0 };
    const giveUp = baseRunner((): WorkerResult => ({
      exit: 0, timedOut: false, stdout: reportFor("a", false, "needs a human: prod credentials"), stderr: "", durationMs: 1,
    }), calls);
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: giveUp, noDebug: true, onEvent: () => {} });
    expect(calls.unblock).toBe(1);
    expect(res.blockedEnv).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("blocked-env");
  });

  test("deploy-only remainder never spawns an unblock session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-unblock-deploy-"));
    createRun(dir, parseRoadmap(`## [deploy] Deploy\nShip it.\nVerify: ${DB_DOWN_GATE}\nRetries: 0\n`), "r");
    const calls = { unblock: 0 };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: baseRunner(okUnblock, calls), noDebug: true, onEvent: () => {} });
    expect(calls.unblock).toBe(0);
    expect(res.blockedEnv).toBe(1);
  });

  test("maxUnblocks: 0 disables the lane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-unblock-off-"));
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(join(dir, ".omp", "roadmap.yml"), "maxUnblocks: 0\n", "utf8");
    createRun(dir, parseRoadmap(`## [a] A\nDo A.\nVerify: ${DB_DOWN_GATE}\nRetries: 0\n`), "r");
    const calls = { unblock: 0 };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: baseRunner(okUnblock, calls), noDebug: true, onEvent: () => {} });
    expect(calls.unblock).toBe(0);
    expect(res.blockedEnv).toBe(1);
  });

  test("terminal failed slice gets one verified extra attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-unblock-failed-"));
    createRun(
      dir,
      parseRoadmap(`## [a] A\nDo A.\nVerify: if [ -f unblocked ]; then exit 0; else echo AssertionError: widget; exit 1; fi\nRetries: 0\n`),
      "r",
    );
    const events: string[] = [];
    const calls = { unblock: 0 };
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: baseRunner(okUnblock, calls),
      noDebug: true,
      onEvent: (m) => events.push(m),
    });
    expect(calls.unblock).toBe(1);
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(1);
    expect(events.some((m) => m.includes("one extra attempt"))).toBe(true);
  });
});
