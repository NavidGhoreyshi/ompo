import { describe, expect, test } from "bun:test";
import { parseRoadmap } from "../src/parse.ts";
import { parseRoadmapYml } from "../src/config.ts";
import { extractReportFromOutput, REPORT_CLOSE, REPORT_OPEN, validateCompletionReport } from "../src/report.ts";
import { buildWorkerSpec } from "../src/spec.ts";
import { resolveWorkerModel } from "../src/worker.ts";

describe("report", () => {
  test("extracts marker block", () => {
    const payload = JSON.stringify({ sliceId: "a", done: true });
    const out = `some prose\n${REPORT_OPEN}\n${payload}\n${REPORT_CLOSE}\nmore`;
    expect(extractReportFromOutput(out)).toEqual({ sliceId: "a", done: true });
  });

  test("validates good report, rejects bad", () => {
    const good = {
      sliceId: "a",
      summary: "did it",
      filesChanged: ["x.ts"],
      testsRun: ["bun test"],
      testsPassed: true,
      verificationNotes: "ran tests",
      followUps: [],
      done: true,
    };
    expect(validateCompletionReport(good, "a").summary).toBe("did it");
    expect(() => validateCompletionReport({ ...good, sliceId: "b" }, "a")).toThrow(/sliceId/);
    expect(() => validateCompletionReport({ ...good, done: "yes" }, "a")).toThrow(/done/);
    expect(() => validateCompletionReport(null, "a")).toThrow(/object/);
  });
});

describe("spec", () => {
  const doc = parseRoadmap("## [a] First\nDo X.\nDepends:\n## [b] Second\nDo Y.\nDepends: a\n");

  test("compiles prompt with contract + dep summaries", () => {
    const b = doc.slices[1]!;
    const spec = buildWorkerSpec(b, doc, 1, {
      depSummaries: new Map([["a", "did X"]]),
    });
    expect(spec.prompt).toContain("slice: b");
    expect(spec.prompt).toContain("did X");
    expect(spec.prompt).toContain(REPORT_OPEN);
    expect(spec.usedChars).toBeLessThanOrEqual(spec.budgetChars);
  });

  test("fail-closed on over-budget slice", () => {
    const big = parseRoadmap(`## [big] T\n${"x".repeat(20000)}\n`);
    expect(() =>
      buildWorkerSpec(big.slices[0]!, big, 1, { maxChars: 1000 }),
    ).toThrow(/budget/);
  });

  test("drops dep summaries before body under pressure", () => {
    const b = doc.slices[1]!;
    const spec = buildWorkerSpec(b, doc, 1, {
      maxChars: 1500,
      depSummaries: new Map([["a", "s".repeat(5000)]]),
    });
    expect(spec.truncatedDeps).toBe(true);
    expect(spec.usedChars).toBeLessThanOrEqual(1500);
  });
});

describe("worker model resolution", () => {
  test("agent map wins, model-like agent passes through, default last", () => {
    expect(
      resolveWorkerModel("task", { workerModel: "d", agentModels: { task: "m" } }),
    ).toBe("m");
    expect(resolveWorkerModel("openrouter/deepseek/x", { workerModel: "d" })).toBe(
      "openrouter/deepseek/x",
    );
    expect(resolveWorkerModel("task", { workerModel: "d" })).toBe("d");
    expect(resolveWorkerModel(undefined, {})).toBeUndefined();
  });
});

describe("config", () => {
  test("parses subset yml", () => {
    const cfg = parseRoadmapYml(
      `workerModel: deepseek-v4-flash\nmaxRetries: 2\nagentModels:\n  task: opus\nverifyDefaults:\n  - bun test\n  - tsc --noEmit\n`,
    );
    expect(cfg.workerModel).toBe("deepseek-v4-flash");
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.agentModels).toEqual({ task: "opus" });
    expect(cfg.verifyDefaults).toEqual(["bun test", "tsc --noEmit"]);
  });
});
