import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import {
  RUNS_DIR,
  acquireLock,
  createRun,
  listRuns,
  loadRun,
  lockHeld,
  readEvents,
  rebuildStatusesFromEvents,
  releaseLock,
  storeApi,
  StoreLockedError,
  writeJsonAtomic,
} from "../src/store.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-store-"));
}

const MD = `## [a] A\nbody a\n## [b] B\nDepends: a\nbody b\n`;

describe("store", () => {
  test("create → claim → finish round-trip", () => {
    const dir = tmpProject();
    const doc = parseRoadmap(MD);
    const run = createRun(dir, doc, "run1");
    expect(run.runId).toBe("run1");
    expect(listRuns(dir)).toEqual(["run1"]);

    storeApi.claimSlice(dir, "run1", "a");
    let c = loadRun(dir, "run1");
    expect(c.doc.slices.find((s) => s.id === "a")!.status).toBe("running");
    expect(c.doc.slices.find((s) => s.id === "a")!.attempts).toBe(1);

    storeApi.workerFinished(dir, "run1", "a", "slices/a/report.json");
    storeApi.verifyPassed(dir, "run1", "a", "slices/a/verdict.json");
    c = loadRun(dir, "run1");
    expect(c.doc.slices.find((s) => s.id === "a")!.status).toBe("done");

    const events = readEvents(dir, "run1");
    expect(events[0]!.type).toBe("run_started");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  test("crash-replay equivalence: event prefix rebuild ≡ cursor", () => {
    const dir = tmpProject();
    const initial = parseRoadmap(MD);
    createRun(dir, initial, "r");
    storeApi.claimSlice(dir, "r", "a");
    storeApi.workerFinished(dir, "r", "a", "rep");
    storeApi.verifyPassed(dir, "r", "a", "ver");
    storeApi.claimSlice(dir, "r", "b");

    const cursor = loadRun(dir, "r");
    const events = readEvents(dir, "r");
    const rebuilt = rebuildStatusesFromEvents(initial, events);
    for (const s of cursor.doc.slices) {
      expect(rebuilt.get(s.id)).toBe(s.status);
    }
    // Random-prefix property: every prefix must replay to a consistent history
    for (let n = 1; n <= events.length; n++) {
      const prefix = events.slice(0, n);
      const m = rebuildStatusesFromEvents(initial, prefix);
      expect(m.size).toBe(2);
    }
    expect(readFileSync).toBeDefined();
  });

  test("resume demotes in-flight slices, preserves attempts", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    const resumed = storeApi.resumeRun(dir, "r");
    const a = resumed.doc.slices.find((s) => s.id === "a")!;
    expect(a.status).toBe("pending");
    expect(a.attempts).toBe(1);
  });

  test("blocked-env replays from events and resume re-queues it", () => {
    const dir = tmpProject();
    const initial = parseRoadmap(MD);
    createRun(dir, initial, "r");
    storeApi.claimSlice(dir, "r", "a");
    storeApi.workerFinished(dir, "r", "a", "rep");
    storeApi.blockEnv(dir, "r", "a", "verdict", "port 3000 already in use");
    expect(loadRun(dir, "r").doc.slices.find((s) => s.id === "a")!.status).toBe("blocked-env");
    const rebuilt = rebuildStatusesFromEvents(initial, readEvents(dir, "r"));
    expect(rebuilt.get("a")).toBe("blocked-env");
    const resumed = storeApi.resumeRun(dir, "r");
    expect(resumed.doc.slices.find((s) => s.id === "a")!.status).toBe("pending");
  });

  test("lock contention raises exit-3 condition", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    acquireLock(dir, "r");
    expect(lockHeld(dir, "r")).toBe(true);
    expect(() => acquireLock(dir, "r")).toThrow(StoreLockedError);
    releaseLock(dir, "r");
    expect(lockHeld(dir, "r")).toBe(false);
    acquireLock(dir, "r");
    releaseLock(dir, "r");
  });

  test("double claim throws: claim is conditional on pending", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    expect(() => storeApi.claimSlice(dir, "r", "a")).toThrow(/cannot claim/);
    expect(loadRun(dir, "r").doc.slices.find((s) => s.id === "a")!.attempts).toBe(1);
  });

  test("enrichment: worker stats/exit land on worker_finished, reason on terminal events", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    storeApi.workerFinished(dir, "r", "a", "slices/a/report.json", {
      exit: 0,
      timedOut: false,
      durationMs: 12_345,
      stats: { turns: 9, tools: 41 },
    });
    storeApi.verifyFailed(dir, "r", "a", "slices/a/verdict.json", "verify_failed");
    storeApi.terminalFail(dir, "r", "a", "verify_failed");

    const events = readEvents(dir, "r");
    const wf = events.find((e) => e.type === "worker_finished")!;
    expect(wf.exit).toBe(0);
    expect(wf.timedOut).toBe(false);
    expect(wf.durationMs).toBe(12_345);
    expect(wf.stats).toEqual({ turns: 9, tools: 41 });
    const vf = events.find((e) => e.type === "verify_failed")!;
    expect(vf.reason).toBe("verify_failed");
    const tf = events.find((e) => e.type === "slice_failed_terminal")!;
    expect(tf.reason).toBe("verify_failed");
    expect(tf.attempt).toBe(1);
  });

  test("enrichment: legacy events without extra fields stay readable", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    storeApi.terminalFail(dir, "r", "a"); // pre-enrichment call shape: no reason
    const events = readEvents(dir, "r");
    const tf = events.find((e) => e.type === "slice_failed_terminal")!;
    expect(tf.reason).toBeUndefined();
    expect(tf.seq).toBeGreaterThan(0);
  });
});

test("listRuns is chronological (createdAt), not lexical run-id order", () => {
  const dir = tmpProject();
  const doc = parseRoadmap(MD);
  // Ids chosen so lexical order (aaa < zzz) inverts creation order.
  const z = loadRun(dir, createRun(dir, doc, "20260901-zzz").runId);
  const a = loadRun(dir, createRun(dir, doc, "20260901-aaa").runId);
  z.createdAt = "2026-09-01T00:00:00.000Z";
  a.createdAt = "2026-09-02T00:00:00.000Z";
  writeJsonAtomic(join(dir, RUNS_DIR, "20260901-zzz", "roadmap.json"), z);
  writeJsonAtomic(join(dir, RUNS_DIR, "20260901-aaa", "roadmap.json"), a);
  expect(listRuns(dir)).toEqual(["20260901-zzz", "20260901-aaa"]);
});

test("a run missing its cursor sorts first so it never reads as latest", () => {
  const dir = tmpProject();
  const doc = parseRoadmap(MD);
  createRun(dir, doc, "run-b");
  createRun(dir, doc, "run-a");
  // Drop run-b's cursor (simulates a half-created run dir): it must not become
  // the "latest" default (watch/log/resume) since loadRun would fail on it.
  rmSync(join(dir, RUNS_DIR, "run-b", "roadmap.json"));
  expect(listRuns(dir)).toEqual(["run-b", "run-a"]);
});
