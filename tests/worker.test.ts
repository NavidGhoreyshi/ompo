import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { parseRoadmapYml } from "../src/config.ts";
import { extractReportFromOutput, REPORT_CLOSE, REPORT_OPEN, validateCompletionReport } from "../src/report.ts";
import { buildWorkerSpec } from "../src/spec.ts";
import {
  buildModelChain,
  formatTokenCount,
  formatTokens,
  isModelUnavailable,
  killWorkerTree,
  progressLineForEvent,
  relativize,
  resolveWorkerModel,
  runOmpWorker,
  runWithModelFallbacks,
  summarizeToolArgs,
  usageForEvent,
  type WorkerRunner,
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
      deferred: [],
      done: true,
    };
    expect(validateCompletionReport(good, "a").summary).toBe("did it");
    expect(validateCompletionReport(good, "a").deferred).toEqual([]);
    expect(() => validateCompletionReport({ ...good, sliceId: "b" }, "a")).toThrow(/sliceId/);
    expect(() => validateCompletionReport({ ...good, done: "yes" }, "a")).toThrow(/done/);
    expect(() => validateCompletionReport(null, "a")).toThrow(/object/);
    expect(() => validateCompletionReport({ ...good, deferred: "later" }, "a")).toThrow(/deferred/);
    const { deferred: _dropped, ...noDeferred } = good;
    expect(() => validateCompletionReport(noDeferred, "a")).toThrow(/deferred/);
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
  test("never-block rule: live values defer, never done=false", () => {
    const b = doc.slices[1]!;
    const spec = buildWorkerSpec(b, doc, 1, {});
    expect(spec.prompt).toContain("NEVER-BLOCK RULE");
    expect(spec.prompt).toContain('"deferred"');
    expect(spec.prompt).toContain("done=false is ONLY for genuinely broken code");
  });

  test("drops dep summaries before body under pressure", () => {
    const b = doc.slices[1]!;
    const spec = buildWorkerSpec(b, doc, 1, {
      maxChars: 3000,
      depSummaries: new Map([["a", "s".repeat(5000)]]),
    });
    expect(spec.truncatedDeps).toBe(true);
    expect(spec.usedChars).toBeLessThanOrEqual(3000);
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
  test("parses modelFallbacks as list or inline", () => {
    const dash = parseRoadmapYml(`workerModel: m1\nmodelFallbacks:\n  - m2\n  - m3\nverifyDefaults:\n  - bun test\n`);
    expect(dash.modelFallbacks).toEqual(["m2", "m3"]);
    expect(dash.verifyDefaults).toEqual(["bun test"]);
    const inline = parseRoadmapYml(`workerModel: m1\nmodelFallbacks: [m2, m3]\n`);
    expect(inline.modelFallbacks).toEqual(["m2", "m3"]);
    expect(parseRoadmapYml(`workerModel: m1\n`).modelFallbacks).toBeUndefined();
  });
});

describe("worker json progress", () => {
  // Real child processes under test: fake timers cannot drive process exit,
  // signal delivery, or pipe EOF, so these integration tests use the platform
  // clock with generous margins.
  async function processGone(pid: number): Promise<boolean> {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      if (Date.now() > deadline) return false;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }
  }

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
      deferred: [],
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

  test("killWorkerTree falls back to direct kill when the group is gone", () => {
    let got: string | undefined;
    killWorkerTree(
      {
        pid: 2_147_483_647,
        kill: (sig) => {
          got = String(sig);
          return true;
        },
      },
      "SIGTERM",
    );
    expect(got).toBe("SIGTERM");
  });

  test("runOmpWorker resolves when an exited worker's stdio is pinned by a grandchild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-pinned-"));
    const fake = join(dir, "omp");
    const pidFile = join(dir, "holder.pid");
    // Exits at once but leaves a grandchild holding the stdout pipe: `close`
    // never arrives on its own. The loop must resolve on the close grace.
    writeFileSync(fake, `#!/bin/bash\nsleep 30 & echo $! > ${pidFile}\nexit 0\n`, "utf8");
    chmodSync(fake, 0o755);
    const prevPath = process.env.PATH ?? "";
    process.env.PATH = `${dir}:${prevPath}`;
    try {
      const started = Date.now();
      const res = await runOmpWorker({ prompt: "hi", sliceId: "x", attempt: 1 }, { projectDir: dir, timeoutMs: 60_000 });
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(res.exit).toBe(0);
      expect(res.stderr).toContain("stdio stayed open");
      // The orphaned pipe holder is reaped with the group, not left behind.
      const holder = Number(readFileSync(pidFile, "utf8").trim());
      expect(await processGone(holder)).toBe(true);
    } finally {
      process.env.PATH = prevPath;
    }
  }, 25_000);

  test("runOmpWorker timeout kills tool grandchildren, not just omp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-treekill-"));
    const fake = join(dir, "omp");
    const pidFile = join(dir, "child.pid");
    writeFileSync(fake, `#!/bin/bash\nsleep 30 & echo $! > ${pidFile}\ntrap '' TERM\nwait\n`, "utf8");
    chmodSync(fake, 0o755);
    const prevPath = process.env.PATH ?? "";
    process.env.PATH = `${dir}:${prevPath}`;
    try {
      const res = await runOmpWorker({ prompt: "hi", sliceId: "x", attempt: 1 }, { projectDir: dir, timeoutMs: 800 });
      expect(res.timedOut).toBe(true);
      const holder = Number(readFileSync(pidFile, "utf8").trim());
      expect(await processGone(holder)).toBe(true);
    } finally {
      process.env.PATH = prevPath;
    }
  }, 25_000);

  test("runOmpWorker notes a silent worker instead of going quiet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-stall-"));
    const fake = join(dir, "omp");
    writeFileSync(fake, "#!/bin/bash\nsleep 1\n", "utf8");
    chmodSync(fake, 0o755);
    const prevPath = process.env.PATH ?? "";
    process.env.PATH = `${dir}:${prevPath}`;
    try {
      const seen: string[] = [];
      await runOmpWorker(
        { prompt: "hi", sliceId: "x", attempt: 1 },
        { projectDir: dir, timeoutMs: 10_000, stallWarnMs: 300, onProgress: (l) => seen.push(l) },
      );
      expect(seen.some((l) => /no worker output/.test(l))).toBe(true);
    } finally {
      process.env.PATH = prevPath;
    }
  }, 15_000);
});

describe("model fallback chain", () => {
  test("orders primary, fallbacks, then omp default; dedupes", () => {
    expect(buildModelChain("a", ["b", "c"])).toEqual(["a", "b", "c", undefined]);
    expect(buildModelChain("a", ["a", "b"])).toEqual(["a", "b", undefined]);
    expect(buildModelChain("a", [])).toEqual(["a", undefined]);
    expect(buildModelChain(undefined, [])).toEqual([undefined]);
  });

  test("detects model outages, not work failures", () => {
    const base = { exit: 0, timedOut: false, stdout: "", stderr: "" };
    const limited429 = {
      ...base,
      eventsJsonl:
        '{"type":"message_end"}\n{"type":"auto_retry_end","success":false,"attempt":1,"finalError":"Provider requested 41722000ms wait, exceeds retry.maxDelayMs (300000ms). Original error: 429 Rate limit exceeded. retry-after-ms=41722000"}\n{"errorStatus":429,"errorMessage":"429 Rate limit exceeded (type=FreeUsageLimitError)"}',
    };
    expect(isModelUnavailable(limited429)).toBe(true);
    expect(isModelUnavailable({ ...base, stderr: "unknown model 'nope-9'" })).toBe(true);
    // Prose that merely mentions a 429 is not a provider outage.
    expect(isModelUnavailable({ ...base, stdout: "got 429 rows back from the query" })).toBe(false);
    // Genuine work failure: red exit, no provider signature.
    expect(isModelUnavailable({ ...base, exit: 1, stderr: "tests failed: 3 red" })).toBe(false);
    // Timeouts are budgets, not availability signals.
    expect(isModelUnavailable({ ...limited429, timedOut: true })).toBe(false);
  });

  test("falls back on outage, preserves partial work", async () => {
    const seen: (string | undefined)[] = [];
    let preserved = 0;
    const runner: WorkerRunner = async (_call, ctx) => {
      seen.push(ctx.workerModel);
      if (ctx.workerModel === "m1") {
        return {
          exit: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          durationMs: 9,
          eventsJsonl: '{"errorStatus":429,"errorMessage":"429 Rate limit exceeded (type=FreeUsageLimitError)"}',
        };
      }
      return { exit: 0, timedOut: false, stdout: "DONE-BLOCK", stderr: "", durationMs: 9 };
    };
    const out = await runWithModelFallbacks(
      runner,
      { prompt: "p", sliceId: "s", attempt: 1 },
      { projectDir: "/tmp" },
      ["m1", "m2"],
      { accept: (s) => s.includes("DONE-BLOCK"), preserve: () => { preserved += 1; } },
    );
    expect(out.model).toBe("m2");
    expect(out.fellBack).toBe(true);
    expect(seen).toEqual(["m1", "m2"]);
    expect(out.tried).toEqual(["m1", "m2"]);
    expect(preserved).toBe(1);
  });

  test("stops the chain on genuine work failure", async () => {
    const seen: (string | undefined)[] = [];
    let preserved = 0;
    const runner: WorkerRunner = async (_call, ctx) => {
      seen.push(ctx.workerModel);
      return { exit: 1, timedOut: false, stdout: "broken code", stderr: "tests failed", durationMs: 9 };
    };
    const out = await runWithModelFallbacks(
      runner,
      { prompt: "p", sliceId: "s", attempt: 1 },
      { projectDir: "/tmp" },
      ["m1", "m2"],
      { accept: (s) => s.includes("DONE-BLOCK"), preserve: () => { preserved += 1; } },
    );
    expect(seen).toEqual(["m1"]);
    expect(out.fellBack).toBe(false);
    expect(preserved).toBe(0);
  });

  test("exhausts the chain through the omp default last", async () => {
    const seen: (string | undefined)[] = [];
    const outage = {
      exit: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: 9,
      eventsJsonl: '{"errorStatus":429}',
    };
    const runner: WorkerRunner = async (_call, ctx) => {
      seen.push(ctx.workerModel);
      return { ...outage };
    };
    const out = await runWithModelFallbacks(
      runner,
      { prompt: "p", sliceId: "s", attempt: 1 },
      { projectDir: "/tmp" },
      buildModelChain("m1", ["m2"]),
      { accept: (s) => s.includes("DONE-BLOCK") },
    );
    expect(seen).toEqual(["m1", "m2", undefined]);
    expect(out.fellBack).toBe(true);
  });
});

describe("usageForEvent", () => {
  // Shape verified against live omp 18.1.14 `--mode json` output:
  // totalTokens = input+output+cacheRead+cacheWrite, reasoningTokens is a
  // sub-count of output, cost.total is authoritative USD.
  const usage = {
    input: 18348,
    output: 17,
    cacheRead: 241,
    cacheWrite: 0,
    totalTokens: 18606,
    reasoningTokens: 6,
    cost: { input: 0.0018348, output: 0.0000034, cacheRead: 4.82e-7, cacheWrite: 0, total: 0.001838682 },
  };
  test("reads the full envelope off assistant message_end", () => {
    expect(usageForEvent({ type: "message_end", message: { role: "assistant", usage } })).toEqual({
      input: 18348,
      output: 17,
      total: 18606,
      cacheRead: 241,
      cacheWrite: 0,
      reasoningTokens: 6,
      cost: { input: 0.0018348, output: 0.0000034, cacheRead: 4.82e-7, cacheWrite: 0, total: 0.001838682 },
    });
  });
  test("reads the same envelope off turn_end, total falls back to input+output+cache", () => {
    const { totalTokens: _drop, ...noTotal } = usage;
    expect(usageForEvent({ type: "turn_end", message: { role: "assistant", usage: noTotal } })).toEqual({
      input: 18348,
      output: 17,
      total: 18606,
      cacheRead: 241,
      cacheWrite: 0,
      reasoningTokens: 6,
      cost: { input: 0.0018348, output: 0.0000034, cacheRead: 4.82e-7, cacheWrite: 0, total: 0.001838682 },
    });
  });
  test("legacy envelopes without cache/cost stay subset-shaped (no zero-fill)", () => {
    expect(usageForEvent({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 50 } } })).toEqual({
      input: 100,
      output: 50,
      total: 150,
    });
  });
  test("drops malformed optionals but keeps the authoritative core", () => {
    expect(
      usageForEvent({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 100, output: 50, totalTokens: 150, cacheRead: -1, cacheWrite: "x", reasoningTokens: NaN, cost: { input: 1 } },
        },
      }),
    ).toEqual({ input: 100, output: 50, total: 150 });
    expect(
      usageForEvent({
        type: "message_end",
        message: { role: "assistant", usage: { input: 100, output: 50, totalTokens: 150, cost: { total: -2 } } },
      }),
    ).toEqual({ input: 100, output: 50, total: 150 });
  });
  test("ignores user messages, other event types, and malformed envelopes", () => {
    expect(usageForEvent({ type: "message_end", message: { role: "user", usage } })).toBeUndefined();
    expect(usageForEvent({ type: "message_start", message: { role: "assistant", usage } })).toBeUndefined();
    expect(usageForEvent({ type: "turn_start" })).toBeUndefined();
    expect(usageForEvent({ type: "message_end", message: { role: "assistant" } })).toBeUndefined();
    expect(usageForEvent({ type: "message_end", message: { role: "assistant", usage: { input: "x" } } })).toBeUndefined();
    expect(usageForEvent({ type: "message_end", message: { role: "assistant", usage: { input: -1, output: 5 } } })).toBeUndefined();
    expect(usageForEvent(null)).toBeUndefined();
    expect(usageForEvent("turn_end")).toBeUndefined();
  });
});
describe("formatTokens", () => {
  test("compacts thousands, leaves small counts raw", () => {
    expect(formatTokens(18334, 23)).toBe("18.3k/23");
    expect(formatTokens(999, 999)).toBe("999/999");
    expect(formatTokens(120000, 1000)).toBe("120k/1k");
    expect(formatTokens(0, 0)).toBe("0/0");
  });
  test("formatTokenCount compacts one count", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(19762)).toBe("19.8k");
    expect(formatTokenCount(120000)).toBe("120k");
  });
});
