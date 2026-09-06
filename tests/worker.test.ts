import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { parseRoadmapYml } from "../src/config.ts";
import { extractReportFromOutput, REPORT_CLOSE, REPORT_OPEN, validateCompletionReport } from "../src/report.ts";
import { buildWorkerSpec } from "../src/spec.ts";
import {
  progressLineForEvent,
  relativize,
  resolveWorkerModel,
  runOmpWorker,
  summarizeToolArgs,
} from "../src/worker.ts";

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
      `workerModel: deepseek-v4-flash\nreviewModel: zen-1.3-free\nmaxRetries: 2\nagentModels:\n  task: opus\nverifyDefaults:\n  - bun test\n  - tsc --noEmit\n`,
    );
    expect(cfg.workerModel).toBe("deepseek-v4-flash");
    expect(cfg.reviewModel).toBe("zen-1.3-free");
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.agentModels).toEqual({ task: "opus" });
    expect(cfg.verifyDefaults).toEqual(["bun test", "tsc --noEmit"]);
  });
});

describe("worker json progress", () => {
  test("summarizeToolArgs picks meaningful keys", () => {
    expect(summarizeToolArgs({ command: "bun test foo.ts" })).toBe("bun test foo.ts");
    expect(summarizeToolArgs({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeToolArgs("plain string")).toBe("plain string");
    expect(summarizeToolArgs(null)).toBe("");
  });

  test("summarizeToolArgs relativizes worktree paths and edit blobs", () => {
    const cwd = "/home/navid/rata/general-wms/.omp/roadmap/worktrees/run-s1";
    expect(summarizeToolArgs({ path: `${cwd}/lib/dates.ts` }, cwd)).toBe("lib/dates.ts");
    expect(summarizeToolArgs(`${cwd}/lib/a.ts`, cwd)).toBe("lib/a.ts");
    // Edit tools carry `[path#id]` at the head of `input`.
    expect(summarizeToolArgs({ input: "[lib/dates.ts#9447]\nPUT 16.=72:\n+import x" }, cwd)).toBe("lib/dates.ts");
    expect(relativize("no prefix here", cwd)).toBe("no prefix here");
    expect(relativize("x", undefined)).toBe("x");
    expect(relativize(cwd, cwd)).toBe(".");
  });

  test("progressLineForEvent strips worker cwd from tool paths", () => {
    const cwd = "/wt/run-s1";
    const state = { turn: 0, cwd };
    expect(
      progressLineForEvent(
        { type: "tool_execution_start", toolName: "read", args: { path: `${cwd}/lib/a.ts` } },
        state,
      ),
    ).toBe("tool read: lib/a.ts");
  });

  test("progressLineForEvent translates agent steps", () => {
    const state = { turn: 0 };
    expect(progressLineForEvent({ type: "turn_start" }, state)).toBe("turn 1…");
    expect(state.turn).toBe(1);
    expect(
      progressLineForEvent(
        { type: "tool_execution_start", toolName: "bash", args: { command: "bun test" } },
        state,
      ),
    ).toBe("tool bash: bun test");
    expect(
      progressLineForEvent({ type: "tool_execution_end", toolName: "bash", isError: false }, state),
    ).toBeUndefined();
    expect(
      progressLineForEvent({ type: "tool_execution_end", toolName: "bash", isError: true }, state),
    ).toBe("tool bash FAILED");
    expect(
      progressLineForEvent(
        {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "  editing files\nnow  " }] },
        },
        state,
      ),
    ).toBe("says: editing files now");
    // Report blocks collapse to a marker, not a 500-char JSON dump.
    expect(
      progressLineForEvent(
        {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "<<<OMPO_REPORT {...} >>>" }] },
        },
        state,
      ),
    ).toBe("report block printed");
    expect(
      progressLineForEvent({ type: "auto_retry_start", errorMessage: "429 slow down" }, state),
    ).toContain("429");
    expect(progressLineForEvent({ type: "turn_end", toolResults: [{}, {}] }, state)).toContain("2 tool results");
    // Noisy / unknown events stay silent.
    expect(progressLineForEvent({ type: "message_update" }, state)).toBeUndefined();
    expect(progressLineForEvent({ type: "something_new" }, state)).toBeUndefined();
  });

  test("runOmpWorker streams json events, reconstructs text, keeps raw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-fakejson-"));
    const fake = join(dir, "omp");
    const report = JSON.stringify({
      sliceId: "x",
      summary: "did it",
      filesChanged: [],
      testsRun: [],
      testsPassed: true,
      verificationNotes: "ok",
      followUps: [],
      done: true,
    });
    const lines = [
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "bun test" } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `${REPORT_OPEN}\n${report}\n${REPORT_CLOSE}` }] },
      }),
    ];
    writeFileSync(
      fake,
      `#!/bin/bash\n${lines.map((l) => `echo '${l.replace(/'/g, "'\\''")}'`).join("\n")}\n`,
      "utf8",
    );
    chmodSync(fake, 0o755);
    const prevPath = process.env.PATH ?? "";
    process.env.PATH = `${dir}:${prevPath}`;
    try {
      const seen: string[] = [];
      const res = await runOmpWorker(
        { prompt: "hello", sliceId: "x", attempt: 1 },
        { projectDir: dir, timeoutMs: 10_000, onProgress: (l) => seen.push(l) },
      );
      expect(res.exit).toBe(0);
      // Assistant text reconstructed for the report extractor.
      expect(res.stdout).toContain("working on it");
      expect(extractReportFromOutput(res.stdout)).toMatchObject({ sliceId: "x" });
      // Raw NDJSON kept for forensics.
      expect(res.eventsJsonl).toContain("tool_execution_start");
      // Live progress fired per step.
      expect(seen).toContain("turn 1…");
      expect(seen).toContain("tool bash: bun test");
      expect(seen).toContain("says: working on it");
      expect(seen).toContain("report block printed");
    } finally {
      process.env.PATH = prevPath;
    }
  });

  test("runOmpWorker passes --mode json to omp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-argv-"));
    const fake = join(dir, "omp");
    writeFileSync(fake, `#!/bin/bash\necho "$@" > ${join(dir, "argv.txt")}\n`, "utf8");
    chmodSync(fake, 0o755);
    const prevPath = process.env.PATH ?? "";
    process.env.PATH = `${dir}:${prevPath}`;
    try {
      await runOmpWorker({ prompt: "hi", sliceId: "x", attempt: 1 }, { projectDir: dir, timeoutMs: 10_000 });
      const argv = (await import("node:fs")).readFileSync(join(dir, "argv.txt"), "utf8");
      expect(argv).toContain("--mode json");
      expect(argv).toContain("-p");
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
