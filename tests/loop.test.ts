import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { runRoadmapLoop } from "../src/loop.ts";
import { createRun, loadRun, sliceDir, storeApi } from "../src/store.ts";
import { HARNESS_CLOSE, HARNESS_OPEN, REPORT_CLOSE, REPORT_OPEN } from "../src/report.ts";
import { loadPlaceholders } from "../src/placeholders.ts";
import { REVIEW_CLOSE, REVIEW_OPEN } from "../src/review.ts";
import type { WorkerCall, WorkerContext, WorkerResult, WorkerRunner } from "../src/worker.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-loop-"));
}

function reportFor(sliceId: string, summary = `did ${sliceId}`, deferred: string[] = []): string {
  return `note\n${REPORT_OPEN}\n${JSON.stringify({
    sliceId,
    summary,
    filesChanged: [],
    testsRun: [],
    testsPassed: true,
    verificationNotes: "ok",
    followUps: [],
    deferred,
    done: true,
  })}\n${REPORT_CLOSE}`;
}

function harnessFixBlock(sliceId: string, filesPatched: string[], diff: string, summary: string): string {
  return `${HARNESS_OPEN}\n${JSON.stringify({ sliceId, filesPatched, diff, summary })}\n${HARNESS_CLOSE}`;
}

function verdictFor(sliceId: string, approved = true, findings: string[] = []): string {
  return `${REVIEW_OPEN}\n${JSON.stringify({
    sliceId,
    approved,
    findings,
    notes: approved ? "audited ok" : findings.join("; "),
  })}\n${REVIEW_CLOSE}`;
}

/**
 * Every slice pipeline now pays for a post-merge review session (worker calls
 * carry a `label`). Fakes answer review-labeled calls with an approved verdict
 * and delegate worker calls to the given responder.
 */
function reviewAware(worker: (call: WorkerCall, ctx: WorkerContext) => WorkerResult | Promise<WorkerResult>): WorkerRunner {
  return async (call, ctx) => {
    if (call.label?.endsWith(" review")) {
      return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
    }
    return worker(call, ctx);
  };
}

const okRunner: WorkerRunner = reviewAware(async (call) => ({
  exit: 0,
  timedOut: false,
  stdout: reportFor(call.sliceId),
  stderr: "",
  durationMs: 1,
}));

const MD3 = `## [a] A\nDo A.\n## [b] B\nDepends: a\nDo B.\n## [c] C\nDepends: b\nDo C.\n`;

describe("loop", () => {
  test("happy path: 3 slices all done, exit 0", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD3), "r");
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(3);
    const c = loadRun(dir, "r");
    expect(c.doc.slices.every((s) => s.status === "done")).toBe(true);
  });
  test("deferred live items aggregate into deferred.md, run still exits 0", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    const events: string[] = [];
    const deferring = reviewAware(async (call) => ({
      exit: 0,
      timedOut: false,
      stdout: reportFor(call.sliceId, "did a with placeholders", [
        "Real KEY — needs owner key; manual check: one live call",
      ]),
      stderr: "",
      durationMs: 1,
    }));
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: deferring, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(1);
    const md = readFileSync(join(dir, ".omp", "roadmap", "runs", "r", "deferred.md"), "utf8");
    expect(md).toContain("## a — A");
    expect(md).toContain("Real KEY");
    expect(events.some((m) => m.includes("deferred: 1 live check(s)"))).toBe(true);
  });


  test("worker onProgress surfaces as prefixed log lines", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    const events: string[] = [];
    const streaming = reviewAware(async (_call, ctx) => {
      ctx.onProgress?.("turn 1…");
      ctx.onProgress?.("tool bash: bun test");
      return { exit: 0, timedOut: false, stdout: reportFor("a"), stderr: "", durationMs: 5 };
    });
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: streaming, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(events.some((m) => m.includes("[a] turn 1…"))).toBe(true);
    expect(events.some((m) => m.includes("[a] tool bash: bun test"))).toBe(true);
    expect(events.some((m) => m.includes("model:"))).toBe(true);
  });

  test("verify steps log start/finish live", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\nVerify: echo hi\n"), "r");
    const events: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(events.some((m) => m.includes("verify: $ echo hi"))).toBe(true);
    expect(events.some((m) => m.includes("verify ok:"))).toBe(true);
  });

  test("verify failure prints the failing step's output tail", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\nVerify: echo trouble-marker && exit 1\nRetries: 0\n"), "r");
    const events: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(1);
    expect(events.some((m) => m.includes("verify output tail"))).toBe(true);
    expect(events.some((m) => m.includes("trouble-marker"))).toBe(true);
  });

  test("yml maxRetries applies when the slice sets no Retries trailer", async () => {
    const dir = tmpProject();
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(join(dir, ".omp", "roadmap.yml"), "maxRetries: 0\n", "utf8");
    createRun(dir, parseRoadmap("## [a] A\nDo A.\nVerify: exit 1\n"), "r");
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, noDebug: true, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.attempts).toBe(1);
  });

  test("explicit Retries trailer beats the yml default", async () => {
    const dir = tmpProject();
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(join(dir, ".omp", "roadmap.yml"), "maxRetries: 0\n", "utf8");
    createRun(dir, parseRoadmap("## [a] A\nDo A.\nVerify: exit 1\nRetries: 1\n"), "r");
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, noDebug: true, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.attempts).toBe(2);
  });

  test("verify EADDRINUSE parks the slice as blocked-env, no retry consumed", async () => {
    const dir = tmpProject();
    createRun(
      dir,
      parseRoadmap("## [a] A\nDo A.\nVerify: node -e \"console.error('listen EADDRINUSE: address already in use 0.0.0.0:3000'); process.exit(1)\"\nRetries: 0\n"),
      "r",
    );
    const events: string[] = [];
    let debugCalls = 0;
    const runner = reviewAware(async (call, ctx) => {
      if (call.label?.endsWith("debug")) debugCalls++;
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    });
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(1);
    expect(res.blockedEnv).toBe(1);
    expect(debugCalls).toBe(0); // env triage runs before the debugger
    const a = loadRun(dir, "r").doc.slices[0]!;
    expect(a.status).toBe("blocked-env");
    expect(a.attempts).toBe(1);
    expect(events.some((m) => m.includes("environment blocked: port 3000 already in use"))).toBe(true);
    expect(events.some((m) => m.includes("ompo resume"))).toBe(true);
    // Resume re-queues the slice once the operator fixes the environment.
    storeApi.resumeRun(dir, "r");
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("pending");
  });

  test("missing named cred heals with a dev-only placeholder, no retry consumed", async () => {
    const dir = tmpProject();
    const varName = "OMPO_TEST_PH_HEAL";
    delete process.env[varName];
    createRun(
      dir,
      parseRoadmap(`## [a] A\nDo A.\nVerify: node -e "if (!process.env.${varName}) { console.error('${varName} must be set'); process.exit(1) }"\nRetries: 0\n`),
      "r",
    );
    const events: string[] = [];
    try {
      const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: (m) => events.push(m) });
      expect(res.exitCode).toBe(0);
      expect(res.done).toBe(1);
      expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
      expect(events.some((m) => m.includes(`placeholder: ${varName} unset`))).toBe(true);
      expect(loadPlaceholders(dir, "r")[varName]?.firstSeenSlice).toBe("a");
    } finally {
      delete process.env[varName];
    }
  });

  test("deploy slices heal with placeholders like any other slice", async () => {
    const dir = tmpProject();
    const varName = "OMPO_TEST_PH_DEPLOY";
    delete process.env[varName];
    createRun(
      dir,
      parseRoadmap(`## [deploy] Deploy\nShip it.\nVerify: node -e "if (!process.env.${varName}) { console.error('${varName} must be set'); process.exit(1) }"\nRetries: 0\n`),
      "r",
    );
    const events: string[] = [];
    try {
      const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: (m) => events.push(m) });
      expect(res.exitCode).toBe(0);
      expect(res.done).toBe(1);
      expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
      expect(events.some((m) => m.includes(`placeholder: ${varName} unset`))).toBe(true);
      expect(loadPlaceholders(dir, "r")[varName]?.firstSeenSlice).toBe("deploy");
    } finally {
      delete process.env[varName];
    }
  });

  test("placeholders: false parks missing creds as blocked-env", async () => {
    const dir = tmpProject();
    const varName = "OMPO_TEST_PH_OFF";
    delete process.env[varName];
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(join(dir, ".omp", "roadmap.yml"), "placeholders: false\n", "utf8");
    createRun(
      dir,
      parseRoadmap(`## [a] A\nDo A.\nVerify: node -e "if (!process.env.${varName}) { console.error('${varName} must be set'); process.exit(1) }"\nRetries: 0\n`),
      "r",
    );
    const events: string[] = [];
    try {
      const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: (m) => events.push(m) });
      expect(res.blockedEnv).toBe(1);
      expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("blocked-env");
      expect(loadPlaceholders(dir, "r")[varName]).toBeUndefined();
    } finally {
      delete process.env[varName];
    }
  });

  test("debugger fixes a genuine failure and the gate re-runs green", async () => {
    const dir = tmpProject();
    createRun(
      dir,
      parseRoadmap("## [a] A\nDo A.\nVerify: bash -lc 'if [ -f fixed-by-debug ]; then exit 0; else echo AssertionError; exit 1; fi'\n"),
      "r",
    );
    const events: string[] = [];
    let debugCalls = 0;
    const runner: WorkerRunner = async (call, ctx) => {
      if (call.label?.endsWith(" review")) {
        return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
      }
      if (call.label?.endsWith("debug")) {
        debugCalls++;
        writeFileSync(join(ctx.projectDir, "fixed-by-debug"), "ok", "utf8");
        return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId, "fixed the total"), stderr: "", durationMs: 1 };
      }
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(1);
    expect(debugCalls).toBe(1);
    const a = loadRun(dir, "r").doc.slices[0]!;
    expect(a.status).toBe("done");
    expect(a.attempts).toBe(1); // debugger never consumes the retry budget
    expect(events.some((m) => m.includes("debugger fixed"))).toBe(true);
    expect(existsSync(join(sliceDir(dir, "r", "a"), "debug-1.log"))).toBe(true);
  });

  test("inconclusive debug falls back to the retry budget, never recurses", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\nVerify: echo still-broken && exit 1\nRetries: 0\n"), "r");
    let debugCalls = 0;
    const runner: WorkerRunner = async (call) => {
      if (call.label?.endsWith(" review")) {
        return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
      }
      if (call.label?.endsWith("debug")) {
        debugCalls++;
        // done=false: debugger gives up.
        return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId, "gave up").replace('"done":true', '"done":false'), stderr: "", durationMs: 1 };
      }
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    expect(debugCalls).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("failed");
  });

  test("noDebug skips the debugger entirely", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\nVerify: echo nope && exit 1\nRetries: 0\n"), "r");
    let debugCalls = 0;
    const runner: WorkerRunner = async (call) => {
      if (call.label?.endsWith("debug")) debugCalls++;
      if (call.label?.endsWith(" review")) {
        return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
      }
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, noDebug: true, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    expect(debugCalls).toBe(0);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("failed");
  });

  test("verify-fail → debugger recovers without a retry", async () => {
    const dir = tmpProject();
    // Slice a has a verifier that fails on first attempt via a stateful command.
    const md2 = `## [a] A\nDo A.\nVerify: bash -lc 'if [ -f flag ]; then exit 0; else touch flag; exit 1; fi'\n`;
    createRun(dir, parseRoadmap(md2), "r");
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    const a = loadRun(dir, "r").doc.slices[0]!;
    expect(a.status).toBe("done");
    expect(a.attempts).toBe(1); // debugger (fake: done report) + re-verify, no retry consumed
  });

  test("verify-fail → retry → pass with noDebug", async () => {
    const dir = tmpProject();
    const md2 = `## [a] A\nDo A.\nVerify: bash -lc 'if [ -f flag ]; then exit 0; else touch flag; exit 1; fi'\n`;
    createRun(dir, parseRoadmap(md2), "r");
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, noDebug: true, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    const a = loadRun(dir, "r").doc.slices[0]!;
    expect(a.status).toBe("done");
    expect(a.attempts).toBe(2);
  });

  test("exhausted-fail continues to next slice, exit 1", async () => {
    const dir = tmpProject();
    const md = `## [a] A\nDo A.\nVerify: exit 1\nRetries: 1\n## [b] B\nDo B.\n`;
    createRun(dir, parseRoadmap(md), "r");
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    const c = loadRun(dir, "r");
    expect(c.doc.slices.find((s) => s.id === "a")!.status).toBe("failed");
    expect(c.doc.slices.find((s) => s.id === "b")!.status).toBe("done");
  });

  test("strict-invalid report → worker failure → terminal with retries=0", async () => {
    const dir = tmpProject();
    const md = `## [a] A\nDo A.\nRetries: 0\n`;
    createRun(dir, parseRoadmap(md), "r");
    const bad: WorkerRunner = async () => ({
      exit: 0,
      timedOut: false,
      stdout: "i did stuff but no report block",
      stderr: "",
      durationMs: 1,
    });
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: bad, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("failed");
  });

  test("abort mid-slice → resume re-runs slice", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD3), "r");
    const ctrl = new AbortController();
    const blocking: WorkerRunner = async () => {
      ctrl.abort();
      return { exit: 0, timedOut: false, stdout: reportFor("a"), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: blocking,
      signal: ctrl.signal,
      onEvent: () => {},
    });
    expect(res.exitCode).toBe(2);
    // Slice a was claimed then aborted → demote via resume, re-run completes.
    storeApi.resumeRun(dir, "r");
    const res2 = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: () => {} });
    expect(res2.exitCode).toBe(0);
    expect(res2.done).toBe(3);
  });
});

describe("loop parallel", () => {
  const MD_PAR = `## [a] A\nDo A.\n## [b] B\nDo B.\n## [c] C\nDepends: a, b\nDo C.\n`;

  test("jobs=2 runs independent slices concurrently", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD_PAR), "r");
    let active = 0;
    let maxActive = 0;
    let entered = 0;
    // Rendezvous: the first pipeline waits until the second arrives,
    // proving overlap with zero wall-clock sleeps. Reviews are intercepted
    // by reviewAware, so only worker calls touch the counters.
    const gate = Promise.withResolvers<void>();
    const tracking = reviewAware(async (call) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      entered += 1;
      if (entered === 2) gate.resolve();
      else await gate.promise;
      active -= 1;
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    });
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: tracking,
      jobs: 2,
      onEvent: () => {},
    });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(3);
    expect(maxActive).toBe(2);
  });

  test("jobs=1 keeps independent slices sequential", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD_PAR), "r");
    let active = 0;
    let maxActive = 0;
    const tracking = reviewAware(async (call) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve(); // yield: any overlap would surface here
      active -= 1;
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    });
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: tracking,
      onEvent: () => {},
    });
    expect(res.exitCode).toBe(0);
    expect(maxActive).toBe(1);
  });

  test("onlySlice runs past a skipped dep", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nSkip: true\n## [b] B\nDepends: a\nDo B.\n"), "r");
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: okRunner,
      onlySlice: "b",
      onEvent: () => {},
    });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(1);
  });

  test("abort during worker run marks aborted, consumes no retry", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD3), "r");
    const ctrl = new AbortController();
    const dying: WorkerRunner = async () => {
      ctrl.abort();
      throw new Error("worker exited 130 with no report");
    };
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: dying,
      signal: ctrl.signal,
      onEvent: () => {},
    });
    expect(res.exitCode).toBe(2);
    const c = loadRun(dir, "r");
    expect(c.doc.slices.find((s) => s.id === "a")!.status).toBe("aborted");
    expect(c.doc.slices.find((s) => s.id === "a")!.attempts).toBe(1);
  });

  test("heartbeat reports elapsed in-flight slices", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    const gate = Promise.withResolvers<void>();
    const events: string[] = [];
    let beats = 0;
    const waiting = reviewAware(async (call) => {
      await gate.promise;
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    });
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: waiting,
      heartbeatMs: 5,
      onEvent: (m) => {
        events.push(m);
        if (m.includes("still running") && ++beats === 2) gate.resolve();
      },
    });
    expect(res.exitCode).toBe(0);
    expect(events.filter((m) => m.includes("… a still running")).length).toBeGreaterThanOrEqual(2);
  });
  test("unexpected pipeline throw fails the run, never strands the loop", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    // Sabotage: read-only slice dir makes the unguarded report.json write
    // throw outside all attempt try/catch regions.
    const sabotage: WorkerRunner = async (call) => {
      chmodSync(sliceDir(dir, "r", call.sliceId), 0o555);
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: sabotage,
      onEvent: () => {},
    });
    // Completing the finish cycle (exit 1) instead of hanging on Promise.race
    // is the assertion; the slice keeps its last committed status.
    expect(res.exitCode).toBe(1);
  });
});

describe("loop review gate", () => {
  test("review rejection retries with findings, approval then completes", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    let workerCalls = 0;
    const scripted: WorkerRunner = async (call) => {
      if (call.label) {
        const stdout =
          call.attempt === 1
            ? verdictFor("a", false, ["src/a.ts misses the spec body"])
            : verdictFor("a", true);
        return { exit: 0, timedOut: false, stdout, stderr: "", durationMs: 1 };
      }
      workerCalls += 1;
      return { exit: 0, timedOut: false, stdout: reportFor("a"), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: scripted, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    const a = loadRun(dir, "r").doc.slices[0]!;
    expect(a.status).toBe("done");
    expect(a.attempts).toBe(2);
    expect(workerCalls).toBe(2);
    // Findings were persisted and fed the retry's spec.
    const sliceFiles = sliceDir(dir, "r", "a");
    const notes = readFileSync(join(sliceFiles, "review-notes.md"), "utf8");
    expect(notes).toContain("src/a.ts misses the spec body");
    const prompt2 = readFileSync(join(sliceFiles, "prompt-2.md"), "utf8");
    expect(prompt2).toContain("PRIOR REVIEW REJECTION");
    expect(prompt2).toContain("src/a.ts misses the spec body");
    // Verdict artifact persisted.
    expect(existsSync(join(sliceFiles, "review.json"))).toBe(true);
    const verdict = JSON.parse(readFileSync(join(sliceFiles, "review.json"), "utf8")) as {
      approved: boolean;
    };
    expect(verdict.approved).toBe(true);
  });

  test("persistent review rejection exhausts retries → failed", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\nRetries: 1\n"), "r");
    const rejecting: WorkerRunner = async (call) => {
      if (call.label) {
        return {
          exit: 0,
          timedOut: false,
          stdout: verdictFor("a", false, ["still broken"]),
          stderr: "",
          durationMs: 1,
        };
      }
      return { exit: 0, timedOut: false, stdout: reportFor("a"), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: rejecting, onEvent: () => {} });
    expect(res.exitCode).toBe(1);
    const a = loadRun(dir, "r").doc.slices[0]!;
    expect(a.status).toBe("failed");
    expect(a.attempts).toBe(2);
  });

  test("noReview skips the review session entirely", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    let labeled = 0;
    const runner: WorkerRunner = async (call) => {
      if (call.label) labeled += 1;
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner,
      noReview: true,
      onEvent: () => {},
    });
    expect(res.exitCode).toBe(0);
    expect(labeled).toBe(0);
    expect(existsSync(join(sliceDir(dir, "r", "a"), "review.json"))).toBe(false);
  });

  test("garbage review output → invalid verdict → retry, then approval", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    const runner: WorkerRunner = async (call) => {
      if (call.label) {
        const stdout = call.attempt === 1 ? "no verdict block, just prose" : verdictFor("a", true);
        return { exit: 0, timedOut: false, stdout, stderr: "", durationMs: 1 };
      }
      return { exit: 0, timedOut: false, stdout: reportFor("a"), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    const a = loadRun(dir, "r").doc.slices[0]!;
    expect(a.status).toBe("done");
    expect(a.attempts).toBe(2);
    expect(existsSync(join(sliceDir(dir, "r", "a"), "review-1.invalid.json"))).toBe(true);
  });

  test("review runs on its own runner and model, session isolated in slice dir", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap("## [a] A\nDo A.\n"), "r");
    const reviewCalls: Array<{ model?: string; sessionDir?: string }> = [];
    const workerRunner: WorkerRunner = async (call) => ({
      exit: 0,
      timedOut: false,
      stdout: reportFor(call.sliceId),
      stderr: "",
      durationMs: 1,
    });
    const reviewRunner: WorkerRunner = async (call, rctx) => {
      reviewCalls.push({ model: rctx.workerModel, sessionDir: rctx.sessionDir });
      return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: workerRunner,
      reviewer: reviewRunner,
      reviewModel: "zen-1.3-free",
      onEvent: () => {},
    });
    expect(res.exitCode).toBe(0);
    expect(reviewCalls.length).toBe(1);
    expect(reviewCalls[0]!.model).toBe("zen-1.3-free");
    expect(reviewCalls[0]!.sessionDir).toBe(sliceDir(dir, "r", "a"));
  });
});

describe("loop harness fix", () => {
  const CFG = "e2e/playwright.config.ts";
  const ORIG = `module.exports = { use: { baseURL: "http://localhost:3100" } };\n`;
  const FIXED = `process.env.NO_PROXY = "localhost,127.0.0.1";\n${ORIG}`;

  // Gate fails until e2e/playwright.config.ts carries the NO_PROXY fix. The
  // failure text stays clear of env-triage signatures so the debugger runs.
  const MD = `## [a] A\nDo A.\nVerify: node -e "const fs=require('fs');const c=fs.readFileSync('e2e/playwright.config.ts','utf8');if(c.includes('NO_PROXY')){process.exit(0)}else{console.error('gate: webServer never became ready (proxy 502)');process.exit(1)}"\n`;

  test("rail-valid harness fix is applied to the worktree and lands on base via the merge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-hf-"));
    const git = (...args: string[]): void => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      expect(r.status).toBe(0);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(dir, ".gitignore"), ".omp/\n", "utf8");
    mkdirSync(join(dir, "e2e"), { recursive: true });
    writeFileSync(join(dir, CFG), ORIG, "utf8");
    git("add", "-A");
    git("commit", "-qm", "base");
    // Produce a real unified diff of the harness fix against HEAD.
    writeFileSync(join(dir, CFG), FIXED, "utf8");
    const diff = spawnSync("git", ["diff"], { cwd: dir, encoding: "utf8" }).stdout;
    expect(diff).toContain(CFG);
    writeFileSync(join(dir, CFG), ORIG, "utf8"); // restore: base stays clean

    createRun(dir, parseRoadmap(MD), "r");
    const events: string[] = [];
    let debugCalls = 0;
    const runner: WorkerRunner = async (call) => {
      if (call.label?.endsWith(" review")) {
        return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
      }
      if (call.label?.endsWith("debug")) {
        debugCalls += 1;
        return {
          exit: 0,
          timedOut: false,
          stdout: reportFor("a") + "\n" + harnessFixBlock("a", [CFG], diff, "proxy not bypassed in the gate"),
          stderr: "",
          durationMs: 1,
        };
      }
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(1);
    expect(debugCalls).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.attempts).toBe(1); // no retry consumed
    // Harness fix was applied to the worktree, the gate re-ran green, and the
    // slice branch merge landed the fix on the base checkout.
    expect(readFileSync(join(dir, CFG), "utf8")).toBe(FIXED);
    expect(events.some((m) => m.includes("harness fix applied"))).toBe(true);
    expect(events.some((m) => m.includes("debugger claims a fix — re-running the gate"))).toBe(true);
    const slice = sliceDir(dir, "r", "a");
    expect(existsSync(join(slice, "debug-1.harness-fix.json"))).toBe(true);
    expect(existsSync(join(slice, "debug-1.patch-applied"))).toBe(true);
    expect(existsSync(join(slice, "debug-1.harness-fix-rejected.json"))).toBe(false);
  });

  test("rail-violating harness fix is rejected, never applied, slice goes terminal", async () => {
    const dir = tmpProject(); // non-git: no HEAD file set → rails reject
    createRun(
      dir,
      parseRoadmap("## [a] A\nDo A.\nVerify: node -e \"console.error('AssertionError: boom');process.exit(1)\"\nRetries: 0\n"),
      "r",
    );
    const events: string[] = [];
    let debugCalls = 0;
    const runner: WorkerRunner = async (call) => {
      if (call.label?.endsWith(" review")) {
        return { exit: 0, timedOut: false, stdout: verdictFor(call.sliceId), stderr: "", durationMs: 1 };
      }
      if (call.label?.endsWith("debug")) {
        debugCalls += 1;
        return {
          exit: 0,
          timedOut: false,
          stdout:
            reportFor("a") +
            "\n" +
            harnessFixBlock("a", [CFG], "diff --git a/e2e/playwright.config.ts b/e2e/playwright.config.ts\n", "proxy"),
          stderr: "",
          durationMs: 1,
        };
      }
      return { exit: 0, timedOut: false, stdout: reportFor(call.sliceId), stderr: "", durationMs: 1 };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(1);
    expect(debugCalls).toBe(1);
    const slice = sliceDir(dir, "r", "a");
    expect(existsSync(join(slice, "debug-1.harness-fix.json"))).toBe(true);
    expect(existsSync(join(slice, "debug-1.harness-fix-rejected.json"))).toBe(true);
    expect(existsSync(join(slice, "debug-1.patch-applied"))).toBe(false);
    expect(events.some((m) => m.includes("harness-fix rejected — file not at HEAD"))).toBe(true);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("failed");
  });
});
