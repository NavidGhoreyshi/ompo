import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContinuationPrompt, buildHandoffBrief, runRoadmapLoop } from "../src/loop.ts";
import { loadHandoffs } from "../src/handoffs.ts";
import { parseRoadmap } from "../src/parse.ts";
import { REPORT_CLOSE, REPORT_OPEN } from "../src/report.ts";
import { REVIEW_CLOSE, REVIEW_OPEN } from "../src/review.ts";
import { createRun, loadRun, readEvents, RUNS_DIR, sliceDir } from "../src/store.ts";
import type { WorkerCall, WorkerContext, WorkerRunner } from "../src/worker.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-handoff-"));
}

function block(sliceId: string, payload: Record<string, unknown>): string {
  return `note\n${REPORT_OPEN}\n${JSON.stringify({ sliceId, ...payload })}\n${REPORT_CLOSE}`;
}

function doneBlock(sliceId: string, summary = `did ${sliceId}`): string {
  return block(sliceId, {
    summary,
    filesChanged: [],
    testsRun: [],
    testsPassed: true,
    verificationNotes: "ok",
    followUps: [],
    deferred: [],
    done: true,
  });
}

function handoffBlock(sliceId: string): string {
  return block(sliceId, {
    summary: "partial",
    filesChanged: ["src/a.ts"],
    testsRun: [],
    testsPassed: false,
    verificationNotes: "HANDOFF:\n(a) completed: scaffolding in src/a.ts\n(b) remaining: wire logic, run tests\n(c) files: src/a.ts",
    followUps: [],
    deferred: [],
    done: false,
  });
}

function verdictFor(sliceId: string): string {
  return `${REVIEW_OPEN}\n${JSON.stringify({ sliceId, approved: true, findings: [], notes: "audited ok" })}\n${REVIEW_CLOSE}`;
}

/** Review lane approves; worker calls go to the responder. */
function reviewAware(worker: (call: WorkerCall, ctx: WorkerContext) => Promise<{ exit: number; timedOut: boolean; stdout: string; stderr: string; durationMs: number }>): WorkerRunner {
  return async (call, ctx) => {
    if (call.label?.endsWith(" review")) {
      return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
    }
    return worker(call, ctx);
  };
}

describe("handoff brief + continuation prompt", () => {
  test("brief records cause, tokens, refs, and verbatim agent notes", () => {
    const brief = buildHandoffBrief({
      sliceId: "a",
      attempt: 1,
      generation: 0,
      cause: "agent-declared",
      tokens: 0,
      cap: 120000,
      preservedReason: "agent-declared handoff g0",
      logRef: join("slices", "a", "worker-1-g0.log"),
      promptRef: join("slices", "a", "prompt-1-g0.md"),
      agentNotes: "HANDOFF:\n(a) done x",
    });
    expect(brief).toContain("a attempt 1 g0 → g1");
    expect(brief).toContain("Agent-declared");
    expect(brief).toContain("agent-declared handoff g0");
    expect(brief).toContain(join("slices", "a", "worker-1-g0.log"));
    expect(brief).toContain("(a) done x");
  });

  test("cap brief states tokens vs cap; missing notes get a reconstruction pointer", () => {
    const brief = buildHandoffBrief({
      sliceId: "b",
      attempt: 2,
      generation: 3,
      cause: "context-cap",
      tokens: 120042,
      cap: 120000,
      preservedReason: "context-cap g3",
      logRef: "log",
      promptRef: "prompt",
    });
    expect(brief).toContain("120042 tokens (cap 120000)");
    expect(brief).toContain("reconstruct state");
  });

  test("continuation prompt keeps the spec and inlines the brief", () => {
    const out = buildContinuationPrompt("SPEC-BODY", "BRIEF-BODY");
    expect(out).toContain("SPEC-BODY");
    expect(out).toContain("CONTINUATION");
    expect(out).toContain("BRIEF-BODY");
  });
});

describe("context-cap handoff loop", () => {
  test("usage past the cap aborts the generation and respawns the same attempt", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    const seenGens: (number | undefined)[] = [];
    const busLines: string[] = [];
    const runner = reviewAware(async (call, ctx) => {
      seenGens.push(call.generation);
      if (call.generation === 0) {
        // Baseline below the cap, then real growth past it (and past a 1k line).
        ctx.onUsage?.({ input: 30, output: 10, total: 40 });
        ctx.onUsage?.({ input: 800, output: 300, total: 2100 });
      } else {
        // Fresh session, fresh window: its own baseline, under the cap.
        ctx.onUsage?.({ input: 25, output: 5, total: 30 });
      }
      return { exit: 0, timedOut: false, stdout: doneBlock(call.sliceId), stderr: "", durationMs: 1 };
    });
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, contextCapOverride: 100, onEvent: (m) => busLines.push(m) });
    expect(res.exitCode).toBe(0);
    // Same attempt respawned: no retry consumed, generations observed in order.
    expect(seenGens).toEqual([0, 1]);
    expect(loadRun(dir, "r").doc.slices[0]!.attempts).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
    // Per-generation artifacts for both generations.
    const sliceFiles = sliceDir(dir, "r", "a");
    expect(existsSync(join(sliceFiles, "worker-1-g0.log"))).toBe(true);
    expect(existsSync(join(sliceFiles, "worker-1-g1.log"))).toBe(true);
    expect(existsSync(join(sliceFiles, "handoff-1-g0.md"))).toBe(true);
    // Audit trail: sidecar entry + event, cause context-cap.
    const entries = loadHandoffs(dir, "r");
    expect(entries[0]).toMatchObject({ sliceId: "a", attempt: 1, generation: 0, cause: "context-cap", tokens: 2100, cap: 100 });
    expect(readEvents(dir, "r").some((e) => e.type === "slice_handoff")).toBe(true);
    // The activity bus carried throttled tok lines (TUI rows feed off these).
    expect(busLines.some((l) => l.includes("tok in=800 out=300 total=2100"))).toBe(true);
  });

  test("cap below the session baseline fails loudly instead of respawning forever", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    const runner = reviewAware(async (call, ctx) => {
      // First observation already meets the cap: no billable work under it.
      ctx.onUsage?.({ input: 4000, output: 1000, total: 5000 });
      return { exit: 0, timedOut: false, stdout: doneBlock(call.sliceId), stderr: "", durationMs: 1 };
    });
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, contextCapOverride: 100, maxRetriesOverride: 0, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("failed");
    // No handoff: the slice went through the normal (unbounded-spend-free) failure path.
    expect(loadHandoffs(dir, "r")).toEqual([]);
    expect(readEvents(dir, "r").some((e) => e.type === "slice_handoff")).toBe(false);
    const terminal = readEvents(dir, "r").find((e) => e.type === "slice_failed_terminal");
    expect(terminal?.reason).toBe("context_cap_baseline");
  });

  test("agent-declared HANDOFF report continues on a fresh generation without retry", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    const runner = reviewAware(async (call) => ({
      exit: 0,
      timedOut: false,
      stdout: call.generation === 0 ? handoffBlock(call.sliceId) : doneBlock(call.sliceId),
      stderr: "",
      durationMs: 1,
    }));
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    expect(loadRun(dir, "r").doc.slices[0]!.attempts).toBe(1);
    const sliceFiles = sliceDir(dir, "r", "a");
    const cont = readFileSync(join(sliceFiles, "prompt-1-g1.md"), "utf8");
    expect(cont).toContain("CONTINUATION");
    expect(cont).toContain("(a) completed: scaffolding in src/a.ts");
    const brief = readFileSync(join(sliceFiles, "handoff-1-g0.md"), "utf8");
    expect(brief).toContain("Agent-declared");
    const entries = loadHandoffs(dir, "r");
    expect(entries.length).toBe(1);
    expect(entries[0]!.cause).toBe("agent-declared");
  });

  test("--no-handoff routes HANDOFF reports to the normal failure path (retry consumed)", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    let calls = 0;
    const runner = reviewAware(async (call) => {
      calls += 1;
      return {
        exit: 0,
        timedOut: false,
        stdout: calls === 1 ? handoffBlock(call.sliceId) : doneBlock(call.sliceId),
        stderr: "",
        durationMs: 1,
      };
    });
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, noHandoff: true, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    // Retry budget consumed: the handoff report failed attempt 1, attempt 2 finished.
    expect(loadRun(dir, "r").doc.slices[0]!.attempts).toBe(2);
    expect(loadHandoffs(dir, "r")).toEqual([]);
    expect(readEvents(dir, "r").some((e) => e.type === "slice_handoff")).toBe(false);
  });
});
