import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { runCommitPhase, runRoadmapLoop, scanRecovery } from "../src/loop.ts";
import { createRun, loadRun, sliceDir, storeApi } from "../src/store.ts";
import { REPORT_CLOSE, REPORT_OPEN } from "../src/report.ts";
import { REVIEW_CLOSE, REVIEW_OPEN } from "../src/review.ts";
import type { WorkerRunner } from "../src/worker.ts";
import { createMutex } from "../src/mutex.ts";
import { loadRoadmapConfig } from "../src/config.ts";
import { resolveRoles } from "../src/globalConfig.ts";
import { worktreeOpsFor } from "../src/worktree.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-recovery-"));
}

function writeReport(dir: string, runId: string, sliceId: string, content: string): void {
  mkdirSync(sliceDir(dir, runId, sliceId), { recursive: true });
  writeFileSync(join(sliceDir(dir, runId, sliceId), "report.json"), content, "utf8");
}

function reportJson(sliceId: string): string {
  return (
    JSON.stringify({
      sliceId,
      summary: `did ${sliceId}`,
      filesChanged: [],
      testsRun: [],
      testsPassed: true,
      verificationNotes: "ok",
      followUps: [],
      deferred: [],
      done: true,
    }) + "\n"
  );
}

function verdictStdout(sliceId: string): string {
  return `${REVIEW_OPEN}\n${JSON.stringify({ sliceId, approved: true, findings: [], notes: "audited ok" })}\n${REVIEW_CLOSE}`;
}

/** Approves reviews; explodes on any worker/debug spawn (recovery must not need one). */
function recoveryOnlyRunner(seen: string[]): WorkerRunner {
  return async (call) => {
    seen.push(`${call.label ?? "worker"}:${call.sliceId}`);
    if (call.label?.endsWith(" review")) {
      return { exit: 0, timedOut: false, stdout: verdictStdout(call.sliceId), stderr: "", durationMs: 1 };
    }
    throw new Error(`worker spawned during recovery for ${call.sliceId} (label=${call.label ?? "none"})`);
  };
}

const MD = "## [a] A\nDo A thoroughly and completely.\nVerify: echo hi\n";

describe("scanRecovery", () => {
  test("empty for unknown runs and settled slices", () => {
    expect(scanRecovery(tmpProject(), "nope")).toEqual([]);
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    expect(scanRecovery(dir, "r")).toEqual([]);
  });

  test("finds crashed slices with a valid saved report, ignores the rest", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n## [b] B\nDo B.\n"), "r");
    storeApi.claimSlice(dir, "r", "a");
    writeReport(dir, "r", "a", reportJson("a"));
    storeApi.claimSlice(dir, "r", "b");
    writeReport(dir, "r", "b", "{torn");
    const found = scanRecovery(dir, "r");
    expect(found.map((f) => f.sliceId)).toEqual(["a"]);
    expect(found[0]!.attempt).toBe(1);
    expect(found[0]!.status).toBe("running");
    expect(found[0]!.report.done).toBe(true);
  });
});

describe("crash recovery", () => {
  test("running slice with saved report replays commit with no worker spawn", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    writeReport(dir, "r", "a", reportJson("a"));
    const seen: string[] = [];
    const events: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: recoveryOnlyRunner(seen), onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
    expect(seen.every((s) => s.startsWith("a review:") || s.includes("review"))).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(events.some((m) => m.includes("crash recovery: a left a saved report"))).toBe(true);
  });

  test("aborted slice with saved report recovers through verifying", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    writeReport(dir, "r", "a", reportJson("a"));
    storeApi.abortSlice(dir, "r", "a");
    const seen: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: recoveryOnlyRunner(seen), onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
  });

  test("torn report falls through to the normal worker path", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    writeReport(dir, "r", "a", "{torn");
    storeApi.abortSlice(dir, "r", "a");
    // Torn report: recovery skips it; resume re-queues aborted → normal retry.
    storeApi.resumeRun(dir, "r");
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: (async (call) => {
        if (call.label?.endsWith(" review")) {
          return { exit: 0, timedOut: false, stdout: verdictStdout(call.sliceId), stderr: "", durationMs: 1 };
        }
        return {
          exit: 0,
          timedOut: false,
          stdout: `note\n${REPORT_OPEN}\n${JSON.stringify({ sliceId: call.sliceId, summary: "redone", filesChanged: [], testsRun: [], testsPassed: true, verificationNotes: "ok", followUps: [], deferred: [], done: true })}\n${REPORT_CLOSE}`,
          stderr: "",
          durationMs: 1,
        };
      }) satisfies WorkerRunner,
      onEvent: () => {},
    });
    expect(res.exitCode).toBe(0);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
    const report = JSON.parse(readFileSync(join(sliceDir(dir, "r", "a"), "report.json"), "utf8"));
    expect(report.summary).toBe("redone");
  });

  test("runCommitPhase is directly replayable from a saved report", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    const report = JSON.parse(reportJson("a"));
    storeApi.workerFinished(dir, "r", "a", join("slices", "a", "report.json"));
    const seen: string[] = [];
    await runCommitPhase(
      {
        projectDir: dir,
        runId: "r",
        faults: { failVerify: [], abortAttempt: 0 },
        reviewer: recoveryOnlyRunner(seen),
        cfg: loadRoadmapConfig(dir),
        roles: resolveRoles(loadRoadmapConfig(dir), {}),
        commit: createMutex(),
        wt: worktreeOpsFor(dir),
        trackers: new Map(),
        controlOffset: 0,
        controlPollMs: 2000,
        jobs: { value: 1 },
        paused: false,
        rng: () => 0,
      } as never,
      "a",
      1,
      report,
    );
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
  });
});
