import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { runRoadmapLoop, scanDoneTrust, scanSkipEvidence } from "../src/loop.ts";
import { createRun, loadRun, saveRunDoc, storeApi } from "../src/store.ts";
import { REPORT_CLOSE, REPORT_OPEN } from "../src/report.ts";
import { REVIEW_CLOSE, REVIEW_OPEN } from "../src/review.ts";
import type { WorkerRunner } from "../src/worker.ts";
function sh(dir: string, args: string[]): void {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? r.stdout ?? "").toString().slice(-500)}`);
}

function gitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ompo-trust-"));
  sh(dir, ["init", "-b", "main"]);
  sh(dir, ["-c", "user.name=ompo", "-c", "user.email=ompo@local", "commit", "--allow-empty", "-m", "base"]);
  return dir;
}

function verdictStdout(sliceId: string): string {
  return `${REVIEW_OPEN}\n${JSON.stringify({ sliceId, approved: true, findings: [], notes: "audited ok" })}\n${REVIEW_CLOSE}`;
}

function reportStdout(sliceId: string): string {
  return `note\n${REPORT_OPEN}\n${JSON.stringify({ sliceId, summary: `did ${sliceId}`, filesChanged: [], testsRun: [], testsPassed: true, verificationNotes: "ok", followUps: [], deferred: [], done: true })}\n${REPORT_CLOSE}`;
}

/** Counts worker (non-review) calls; reviews always approve. Workers touch a file so merges land. */
function countingRunner(calls: { worker: number }): WorkerRunner {
  return async (call, ctx) => {
    if (call.label?.endsWith(" review")) {
      return { exit: 0, timedOut: false, stdout: verdictStdout(call.sliceId), stderr: "", durationMs: 1 };
    }
    calls.worker += 1;
    writeFileSync(join(ctx.projectDir, `${call.sliceId}.txt`), `work attempt\n`, "utf8");
    return { exit: 0, timedOut: false, stdout: reportStdout(call.sliceId), stderr: "", durationMs: 1 };
  };
}

const MD = "## [a] A\nDo A thoroughly and completely.\nVerify: echo hi\n";

describe("scanDoneTrust", () => {
  test("empty when nothing to check (non-git, no dones)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-trust-"));
    createRun(dir, parseRoadmap(MD), "r");
    expect(scanDoneTrust(dir, "r")).toEqual([]);
    expect(scanDoneTrust(dir, "missing")).toEqual([]);
  });

  test("confirmed while the merge is in history", async () => {
    const dir = gitProject();
    createRun(dir, parseRoadmap(MD), "r");
    const calls = { worker: 0 };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: countingRunner(calls), onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    const slice = loadRun(dir, "r").doc.slices[0]!;
    expect(slice.status).toBe("done");
    expect(slice.verifiedHead).toMatch(/^[0-9a-f]{40}$/);
    const found = scanDoneTrust(dir, "r");
    expect(found.map((f) => f.outcome)).toEqual(["confirmed"]);
  });

  test("rewritten history demotes on next loop start and redoes the work", async () => {
    const dir = gitProject();
    createRun(dir, parseRoadmap(MD), "r");
    const calls = { worker: 0 };
    await runRoadmapLoop({ projectDir: dir, runId: "r", runner: countingRunner(calls), onEvent: () => {} });
    expect(calls.worker).toBe(1);
    sh(dir, ["reset", "--hard", "HEAD~1"]);
    expect(scanDoneTrust(dir, "r").map((f) => f.outcome)).toEqual(["demoted"]);
    const events: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: countingRunner(calls), onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(calls.worker).toBe(2);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
    expect(events.some((m) => m.includes("done-trust: a demoted to pending"))).toBe(true);
  });

  test("pruned branch without record warns but keeps done", async () => {
    const dir = gitProject();
    createRun(dir, parseRoadmap(MD), "r");
    const calls = { worker: 0 };
    await runRoadmapLoop({ projectDir: dir, runId: "r", runner: countingRunner(calls), onEvent: () => {} });
    sh(dir, ["branch", "-D", "ompo/r/a"]);
    // Simulate a pre-journal run: drop all records, keep the done status.
    const cursor = loadRun(dir, "r");
    delete cursor.doc.slices[0]!.verifiedHead;
    saveRunDoc(dir, "r", cursor.doc);
    rmSync(join(dir, ".omp", "roadmap", "runs", "r", "slices", "a", "merge-1.json"), { force: true });
    const found = scanDoneTrust(dir, "r");
    expect(found.map((f) => f.outcome)).toEqual(["unverifiable"]);
    const events: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: countingRunner(calls), onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(calls.worker).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
    expect(events.some((m) => m.includes("done-trust: a unverifiable"))).toBe(true);
  });
});

describe("reverify", () => {
  test("passing gates restamp verifiedHead", async () => {
    const dir = gitProject();
    createRun(dir, parseRoadmap(MD), "r");
    const calls = { worker: 0 };
    await runRoadmapLoop({ projectDir: dir, runId: "r", runner: countingRunner(calls), onEvent: () => {} });
    const events: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: countingRunner(calls), reverify: true, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(calls.worker).toBe(1);
    expect(events.some((m) => m.includes("reverify a: gates pass"))).toBe(true);
    expect(loadRun(dir, "r").doc.slices[0]!.verifiedHead).toMatch(/^[0-9a-f]{40}$/);
  });

  test("failing gates demote to pending and redo the work", async () => {
    const dir = gitProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A thoroughly and completely.\nVerify: echo hi\n"), "r");
    const calls = { worker: 0 };
    await runRoadmapLoop({ projectDir: dir, runId: "r", runner: countingRunner(calls), onEvent: () => {} });
    // Break the gate on current HEAD: append a failing command to the slice spec.
    const cursor = loadRun(dir, "r");
    cursor.doc.slices[0]!.verify.push("exit 1");
    saveRunDoc(dir, "r", cursor.doc);
    const events: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: countingRunner(calls), reverify: true, onEvent: (m) => events.push(m) });
    expect(events.some((m) => m.includes("demoted to pending"))).toBe(true);
    // The demoted slice retries with the (broken) gate and terminals on budget.
    expect(res.pending + res.failed).toBeGreaterThan(0);
  });
});

describe("scanSkipEvidence", () => {
  test("flags cited qa reports that do not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-trust-"));
    createRun(
      dir,
      parseRoadmap("## [s9] Old work\nDone — see qa/s9/report.md for evidence.\nSkip: true\n"),
      "r",
    );
    const found = scanSkipEvidence(dir, "r");
    expect(found).toEqual([{ sliceId: "s9", missing: ["qa/s9/report.md"] }]);
  });

  test("silent when evidence exists or no refs cited", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-trust-"));
    createRun(
      dir,
      parseRoadmap("## [s9] Old work\nDone — nothing cited.\nSkip: true\n\n## [s8] More\nDo it.\n"),
      "r",
    );
    expect(scanSkipEvidence(dir, "r")).toEqual([]);
  });
});
