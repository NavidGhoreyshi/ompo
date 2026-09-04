import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import {
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
});
