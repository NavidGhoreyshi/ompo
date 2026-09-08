import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { createRun, loadRun, saveRunDoc, sliceDir } from "../src/store.ts";
import { writeJsonAtomic } from "../src/store.ts";
import { RUNS_DIR } from "../src/store.ts";
import type { CompletionReport } from "../src/types.ts";
import type { PlaceholderEntry } from "../src/placeholders.ts";
import {
  affectedSlices,
  collectChecklist,
  fillChecklist,
  parseDeferredLine,
  renderChecklistMd,
  renderChecklistJson,
  varsForItem,
  type ChecklistItem,
} from "../src/checklist.ts";
import type { runVerifiers } from "../src/verify.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-checklist-"));
}

const MD = `## [a] Alpha
Do A.
Verify: echo ok-a
## [b] Beta
Do B.
Verify: echo ok-b
## [c] Gamma
Do C.
Verify: echo ok-c
`;

function report(sliceId: string, deferred: unknown): CompletionReport {
  return {
    sliceId,
    summary: "s",
    filesChanged: [],
    testsRun: [],
    testsPassed: true,
    verificationNotes: "",
    followUps: [],
    deferred: deferred as string[],
    done: true,
  };
}

/** Fixture: a+b done with reports, c failed (ignored); two placeholder entries. */
function fixture(): string {
  const dir = tmpProject();
  createRun(dir, parseRoadmap(MD), "r");
  const cur = loadRun(dir, "r");
  for (const s of cur.doc.slices) {
    if (s.id === "c") s.status = "failed";
    else s.status = "done";
  }
  saveRunDoc(dir, "r", cur.doc);
  mkdirSync(sliceDir(dir, "r", "a"), { recursive: true });
  mkdirSync(sliceDir(dir, "r", "b"), { recursive: true });
  mkdirSync(sliceDir(dir, "r", "c"), { recursive: true });
  writeFileSync(
    join(sliceDir(dir, "r", "a"), "report.json"),
    JSON.stringify(report("a", ["Stripe webhook \u2014 needs STRIPE_KEY; manual check: curl webhook"])),
    "utf8",
  );
  writeFileSync(
    join(sliceDir(dir, "r", "b"), "report.json"),
    JSON.stringify(report("b", ["Database \u2014 needs DB_URL; manual check: run migration"])),
    "utf8",
  );
  // Failed slice report must be ignored even when present.
  writeFileSync(
    join(sliceDir(dir, "r", "c"), "report.json"),
    JSON.stringify(report("c", ["Should not appear \u2014 needs GHOST_VAR; manual check: noop"])),
    "utf8",
  );
  const ph: Record<string, PlaceholderEntry> = {
    STRIPE_KEY: { name: "STRIPE_KEY", value: "dev-stripe", firstSeenSlice: "a", firstSeenAttempt: 1, at: new Date().toISOString() },
    DB_URL: { name: "DB_URL", value: "dev-db", firstSeenSlice: "b", firstSeenAttempt: 1, at: new Date().toISOString() },
  };
  writeJsonAtomic(join(dir, RUNS_DIR, "r", "placeholders.json"), ph);
  return dir;
}

describe("parseDeferredLine", () => {
  test("em-dash variant", () => {
    expect(parseDeferredLine("Stripe webhook \u2014 needs STRIPE_KEY; manual check: curl it")).toEqual({
      what: "Stripe webhook",
      needsValue: "STRIPE_KEY",
      check: "curl it",
    });
  });
  test("en-dash variant", () => {
    expect(parseDeferredLine("Stripe webhook \u2013 needs STRIPE_KEY; manual check: curl it")).toEqual({
      what: "Stripe webhook",
      needsValue: "STRIPE_KEY",
      check: "curl it",
    });
  });
  test("hyphen variant", () => {
    expect(parseDeferredLine("Stripe webhook - needs STRIPE_KEY; manual check: curl it")).toEqual({
      what: "Stripe webhook",
      needsValue: "STRIPE_KEY",
      check: "curl it",
    });
  });
  test("bare needs variant", () => {
    expect(parseDeferredLine("Stripe webhook needs STRIPE_KEY; manual check: curl it")).toEqual({
      what: "Stripe webhook",
      needsValue: "STRIPE_KEY",
      check: "curl it",
    });
  });
  test("missing manual check still splits needs", () => {
    expect(parseDeferredLine("Thing \u2014 needs REAL_VALUE")).toEqual({
      what: "Thing",
      needsValue: "REAL_VALUE",
      check: null,
    });
  });
  test("malformed input never throws", () => {
    expect(parseDeferredLine("just some words")).toEqual({
      what: "just some words",
      needsValue: null,
      check: null,
    });
    expect(parseDeferredLine("   ")).toEqual({ what: "", needsValue: null, check: null });
    expect(parseDeferredLine("needs")).toEqual({ what: "needs", needsValue: null, check: null });
  });
});

describe("collectChecklist", () => {
  test("done slices only, roadmap order, deferred before placeholders per slice", () => {
    const dir = fixture();
    const items = collectChecklist(dir, "r");
    // a: deferred + placeholder, b: deferred + placeholder; c ignored entirely.
    expect(items.map((i) => [i.sliceId, i.kind, i.what])).toEqual([
      ["a", "deferred", "Stripe webhook"],
      ["a", "placeholder", "STRIPE_KEY"],
      ["b", "deferred", "Database"],
      ["b", "placeholder", "DB_URL"],
    ]);
    expect(items.every((i) => i.title !== "")).toBe(true);
    expect(items.find((i) => i.kind === "placeholder")!.check).toMatch(/ompo resume/);
    expect(items.some((i) => i.sliceId === "c")).toBe(false);
  });
  test("skips unreadable reports and non-string entries", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    const cur = loadRun(dir, "r");
    cur.doc.slices[0]!.status = "done";
    saveRunDoc(dir, "r", cur.doc);
    // No report.json on disk at all → empty checklist, no throw.
    expect(collectChecklist(dir, "r")).toEqual([]);
  });
  test("renderers round-trip", () => {
    const dir = fixture();
    const items = collectChecklist(dir, "r");
    const md = renderChecklistMd(items, "r");
    expect(md).toContain("run r");
    expect(md).toContain("STRIPE_KEY");
    expect(JSON.parse(renderChecklistJson(items))).toEqual(items);
    expect(renderChecklistMd([], "r")).toContain("Nothing to fill");
  });
});

describe("varsForItem / affectedSlices", () => {
  test("extracts uppercase tokens, deduped, order-stable", () => {
    const item: ChecklistItem = {
      sliceId: "a",
      title: "Alpha",
      kind: "deferred",
      what: "Stripe webhook for STRIPE_KEY",
      needsValue: "STRIPE_KEY and API_TOKEN",
      check: null,
      raw: "raw mentions STRIPE_KEY again plus DB_URL",
    };
    expect(varsForItem(item)).toEqual(["STRIPE_KEY", "API_TOKEN", "DB_URL"]);
  });
  test("short tokens ignored", () => {
    const item: ChecklistItem = {
      sliceId: "a", title: "t", kind: "deferred",
      what: "fix the API", needsValue: null, check: null, raw: "fix the API",
    };
    expect(varsForItem(item)).toEqual([]);
  });
  test("affectedSlices intersects upper-cased var names", () => {
    const dir = fixture();
    const items = collectChecklist(dir, "r");
    const onlyA = affectedSlices(items, { stripe_key: "x" });
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyA.every((i) => i.sliceId === "a")).toBe(true);
    expect(affectedSlices(items, {})).toEqual([]);
    expect(affectedSlices(items, { UNRELATED_VAR: "x" })).toEqual([]);
  });
});

describe("fillChecklist", () => {
  test("pass + fail paths with env passthrough", async () => {
    const dir = fixture();
    const seen: { sliceId: string; env?: Record<string, string> }[] = [];
    const fake = async (
      sliceId: string,
      _attempt: number,
      _cmds: string[],
      _logDir: string,
      opts: { env?: Record<string, string> },
    ) => {
      seen.push({ sliceId, env: opts.env });
      if (sliceId === "a") {
        return { sliceId, attempt: 1, pass: true, steps: [], at: new Date().toISOString() };
      }
      return {
        sliceId,
        attempt: 1,
        pass: false,
        steps: [
          { name: "g", command: "exit 1", exit: 1, timedOut: false, outputTail: "boom-b", logRef: "x" },
        ],
        at: new Date().toISOString(),
      };
    };
    const res = await fillChecklist(dir, "r", { STRIPE_KEY: "real-s", DB_URL: "real-d" }, {
      runGates: fake as unknown as typeof runVerifiers,
    });
    expect(res.affected).toEqual(["a", "b"]);
    expect(res.passed).toEqual(["a"]);
    expect(res.failed).toEqual([{ sliceId: "b", output: "boom-b" }]);
    // Env passthrough: provided vars override, process env preserved.
    expect(seen.length).toBe(2);
    for (const s of seen) {
      expect(s.env!.STRIPE_KEY).toBe("real-s");
      expect(s.env!.DB_URL).toBe("real-d");
      expect(s.env!.PATH).toBe(process.env.PATH as string);
    }
  });
  test("empty checklist is a no-op", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    let calls = 0;
    const fake = async (sliceId: string) => {
      calls++;
      return { sliceId, attempt: 1, pass: true, steps: [], at: "" };
    };
    const res = await fillChecklist(dir, "r", { ANYTHING: "x" }, {
      runGates: fake as never,
    });
    expect(res).toEqual({ affected: [], passed: [], failed: [] });
    expect(calls).toBe(0);
  });
  test("no matching vars is a no-op", async () => {
    const dir = fixture();
    let calls = 0;
    const fake = async (sliceId: string) => {
      calls++;
      return { sliceId, attempt: 1, pass: true, steps: [], at: "" };
    };
    const res = await fillChecklist(dir, "r", { NOPE_NOTHING: "x" }, {
      runGates: fake as never,
    });
    expect(res.affected).toEqual([]);
    expect(calls).toBe(0);
  });
});
