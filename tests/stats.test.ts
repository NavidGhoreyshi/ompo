import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { createRun, loadRun, saveRunDoc, storeApi } from "../src/store.ts";
import { computeStats, exportHtml, queryEvents, replayRun } from "../src/stats.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-stats-"));
}

const MD = `## [a] Alpha
Effort: lo
body a
## [b] Beta
Effort: hi
Depends: a
body b
## [c] Gamma
body c
`;

function sliceFile(dir: string, run: string, slice: string, name: string, value: unknown): void {
  const d = join(dir, ".omp", "roadmap", "runs", run, "slices", slice);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

function verdict(pass: boolean, failing: string[] = []) {
  return {
    sliceId: "b",
    attempt: 1,
    pass,
    at: new Date().toISOString(),
    steps: [
      { name: "ok", command: "bun lint", exit: 0, timedOut: false, outputTail: "", logRef: "" },
      ...failing.map((command) => ({
        name: "gate",
        command,
        exit: 1,
        timedOut: false,
        outputTail: "boom",
        logRef: "",
      })),
    ],
  };
}

/** Rich fixture: a done, a failed (with verdict + models), a pending. */
function richFixture(): { dir: string; run: string } {
  const dir = tmpProject();
  const run = "r1";
  createRun(dir, parseRoadmap(MD), run);

  storeApi.claimSlice(dir, run, "a");
  storeApi.workerFinished(dir, run, "a", "slices/a/report.json", {
    exit: 0,
    durationMs: 1000,
    stats: { turns: 10, tools: 4 },
  });
  storeApi.verifyPassed(dir, run, "a", "slices/a/verdict.json");

  storeApi.claimSlice(dir, run, "b");
  storeApi.workerFinished(dir, run, "b", "slices/b/report.json", {
    exit: 0,
    durationMs: 3000,
    stats: { turns: 20, tools: 6 },
  });
  storeApi.verifyFailed(dir, run, "b", "slices/b/verdict.json", "gate red");

  sliceFile(dir, run, "a", "verdict.json", verdict(true));
  sliceFile(dir, run, "b", "verdict.json", verdict(false, ["bun test", "bun test"]));
  sliceFile(dir, run, "b", "worker-1.models.json", { chain: ["model-a", "model-b"] });
  return { dir, run };
}

describe("computeStats", () => {
  test("means, byEffort, passRate, gates, fallbacks", () => {
    const { dir, run } = richFixture();
    const s = computeStats(dir, run);
    expect(s.runId).toBe(run);
    expect(s.totals["done"]).toBe(1);
    expect(s.totals["failed"]).toBe(1);
    expect(s.totals["pending"]).toBe(1);
    expect(s.passRate).toBeCloseTo(0.5);
    expect(s.meanTurns).toBeCloseTo(15);
    expect(s.meanTools).toBeCloseTo(5);
    expect(s.meanDurationMs).toBeCloseTo(2000);
    expect(s.attempts.total).toBe(2);
    expect(s.attempts.perSlice).toEqual({ a: 1, b: 1, c: 0 });

    expect(s.byEffort.lo).toMatchObject({ count: 1, done: 1 });
    expect(s.byEffort.lo.meanTurns).toBeCloseTo(10);
    expect(s.byEffort.hi).toMatchObject({ count: 1, done: 0 });
    expect(s.byEffort.hi.meanDurationMs).toBeCloseTo(3000);
    expect(s.byEffort.none).toMatchObject({ count: 1, done: 0 });
    expect(s.byEffort.none.meanTurns).toBeNull();
    expect(s.byEffort.med).toMatchObject({ count: 0, done: 0 });

    expect(s.topFailingGates[0]).toEqual({ command: "bun test", fails: 2 });
    expect(s.modelFallbacks).toEqual({ "model-a": 1, "model-b": 1 });
  });

  test("passRate null and means null on a fresh run; never throws when artifacts missing", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "fresh");
    const s = computeStats(dir, "fresh");
    expect(s.passRate).toBeNull();
    expect(s.meanTurns).toBeNull();
    expect(s.meanTools).toBeNull();
    expect(s.meanDurationMs).toBeNull();
    expect(s.topFailingGates).toEqual([]);
    expect(s.modelFallbacks).toEqual({});
    // Entirely missing run dir also yields empty stats, not a throw.
    const missing = computeStats(dir, "nope");
    expect(missing.passRate).toBeNull();
    expect(missing.totals).toEqual({});
  });

  test("verify_failed details backstop topFailingGates when verdict files are absent", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    storeApi.workerFinished(dir, "r", "a", "rep");
    storeApi.verifyFailed(dir, "r", "a", "slices/a/verdict.json", "gate red");
    const s = computeStats(dir, "r");
    expect(s.topFailingGates.length).toBeGreaterThan(0);
    expect(s.topFailingGates[0]!.fails).toBe(1);
  });
});

describe("queryEvents", () => {
  test("type-substring selector, numeric where, contains where", () => {
    const { dir, run } = richFixture();
    const failed = queryEvents(dir, run, "failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((e) => e.type.includes("failed"))).toBe(true);

    const slow = queryEvents(dir, run, "all where durationMs > 1500");
    expect(slow.map((e) => e.sliceId)).toEqual(["b"]);

    const joined = queryEvents(dir, run, "all where attempts > 0");
    expect(joined.length).toBeGreaterThan(0);
    expect(joined.every((e) => e.sliceId === "a" || e.sliceId === "b")).toBe(true);

    const contains = queryEvents(dir, run, "all where type ~ verify");
    expect(contains.length).toBe(2); // verify_passed + verify_failed
    expect(new Set(contains.map((e) => e.type))).toEqual(new Set(["verify_passed", "verify_failed"]));

    const sliceSel = queryEvents(dir, run, "slice a");
    expect(sliceSel.length).toBeGreaterThan(0);
    expect(sliceSel.every((e) => e.sliceId === "a")).toBe(true);

    const scoped = queryEvents(dir, run, "slices");
    expect(scoped.every((e) => e.sliceId !== undefined)).toBe(true);
  });

  test("bad field and empty query throw", () => {
    const { dir, run } = richFixture();
    expect(() => queryEvents(dir, run, "all where bogus = 1")).toThrow(/unknown field "bogus".*attempts/);
    expect(() => queryEvents(dir, run, "   ")).toThrow(/empty query/);
  });
});

describe("exportHtml", () => {
  test("escapes injected markup and contains the slice table", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(`## [x] <script>alert(1)</script>\nbody\n`), "r");
    const d = join(dir, ".omp", "roadmap", "runs", "r");
    writeFileSync(join(d, "deferred.md"), "<b>deferred</b>\n", "utf8");
    const html = exportHtml(dir, "r");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<td>x</td>");
    expect(html).toContain("pending");
    expect(html).toContain("&lt;b&gt;deferred&lt;/b&gt;");
    expect(html).toContain("<style>");
  });
});

describe("replayRun", () => {
  test("zero mismatches on a clean fixture; reports an injected mismatch", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    storeApi.claimSlice(dir, "r", "a");
    storeApi.workerFinished(dir, "r", "a", "rep");
    storeApi.verifyPassed(dir, "r", "a", "ver");

    const clean = replayRun(dir, "r");
    expect(clean.mismatches).toEqual([]);
    expect(clean.expected["a"]).toBe("done");
    expect(clean.actual["a"]).toBe("done");
    expect(clean.events).toBeGreaterThan(0);

    const cursor = loadRun(dir, "r");
    cursor.doc.slices.find((s) => s.id === "a")!.status = "failed";
    saveRunDoc(dir, "r", cursor.doc);

    const dirty = replayRun(dir, "r");
    expect(dirty.mismatches).toEqual(["a: expected done got failed"]);
  });
});
