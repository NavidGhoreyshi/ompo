import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmapYml } from "../src/config.ts";
import { parseRoadmap } from "../src/parse.ts";
import { buildWorkerSpec } from "../src/spec.ts";
import { runRoadmapLoop } from "../src/loop.ts";
import { createRun, loadRun } from "../src/store.ts";
import { REPORT_CLOSE, REPORT_OPEN } from "../src/report.ts";
import { REVIEW_CLOSE, REVIEW_OPEN } from "../src/review.ts";
import type { WorkerCall, WorkerContext, WorkerResult, WorkerRunner } from "../src/worker.ts";
import {
  hasServices,
  healServices,
  isHealableBlock,
  serviceEnvOf,
  serviceTimeoutMs,
} from "../src/services.ts";

function reportFor(sliceId: string): string {
  return `note\n${REPORT_OPEN}\n${JSON.stringify({
    sliceId,
    summary: `did ${sliceId}`,
    filesChanged: [],
    testsRun: [],
    testsPassed: true,
    verificationNotes: "ok",
    followUps: [],
    deferred: [],
    done: true,
  })}\n${REPORT_CLOSE}`;
}

function verdictFor(sliceId: string): string {
  return `${REVIEW_OPEN}\n${JSON.stringify({ sliceId, approved: true, findings: [], notes: "audited ok" })}\n${REVIEW_CLOSE}`;
}

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

describe("services config", () => {
  test("parses serviceUp/serviceReady lists, serviceEnv map, timeout", () => {
    const cfg = parseRoadmapYml(
      `maxRetries: 1\nserviceUp:\n  - docker compose up -d db\nserviceReady:\n  - pg_isready -h localhost -p 5432\nserviceEnv:\n  DATABASE_URL: postgresql://localhost:5432/ompo_dev\nserviceTimeoutSec: 60\n`,
    );
    expect(cfg.serviceUp).toEqual(["docker compose up -d db"]);
    expect(cfg.serviceReady).toEqual(["pg_isready -h localhost -p 5432"]);
    expect(cfg.serviceEnv).toEqual({ DATABASE_URL: "postgresql://localhost:5432/ompo_dev" });
    expect(cfg.serviceTimeoutSec).toBe(60);
  });

  test("absent services leave nothing configured", () => {
    const cfg = parseRoadmapYml(`maxRetries: 1\n`);
    expect(hasServices(cfg)).toBe(false);
    expect(serviceEnvOf(cfg)).toEqual({});
    expect(serviceTimeoutMs(cfg)).toBe(120_000);
  });
});

describe("isHealableBlock", () => {
  test("heals database / port / host blocks", () => {
    expect(isHealableBlock("database unreachable")).toBe(true);
    expect(isHealableBlock('database "general_wms" missing')).toBe(true);
    expect(isHealableBlock('database role "app" missing')).toBe(true);
    expect(isHealableBlock("port 5433 already in use")).toBe(true);
    expect(isHealableBlock("host unresolvable")).toBe(true);
  });

  test("never heals creds / disk / genuine failures", () => {
    expect(isHealableBlock("disk full")).toBe(false);
    expect(isHealableBlock('missing env var "SEED_ADMIN_PASSWORD"')).toBe(false);
    expect(isHealableBlock("verify failed")).toBe(false);
  });
});

describe("healServices", () => {
  test("bring-up runs and readiness passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-svc-"));
    const events: string[] = [];
    const res = await healServices({
      projectDir: dir,
      cfg: { serviceUp: ["echo up"], serviceReady: ["exit 0"], serviceEnv: { SVC_DB: "up" } },
      onEvent: (m) => events.push(m),
    });
    expect(res.ok).toBe(true);
    expect(res.env).toEqual({ SVC_DB: "up" });
    expect(events.some((m) => m.includes("services ready"))).toBe(true);
  });

  test("failed bring-up short-circuits red", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-svc-"));
    const res = await healServices({
      projectDir: dir,
      cfg: { serviceUp: ["exit 1"], serviceReady: ["exit 0"] },
      onEvent: () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/serviceUp failed/);
  });

  test("red readiness exhausts the poll budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-svc-"));
    const res = await healServices({
      projectDir: dir,
      cfg: { serviceReady: ["exit 1"], serviceTimeoutSec: 1 },
      onEvent: () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/readiness timeout/);
  });
});

describe("worker spec", () => {
  test("contract points workers at the shared service", () => {
    const doc = parseRoadmap("## [a] A\nDo A.\n");
    const spec = buildWorkerSpec(doc.slices[0]!, doc, 1, {});
    expect(spec.prompt).toContain("Shared services");
    expect(spec.prompt).toContain("never start your own");
  });
});

describe("gate-phase heal", () => {
  test("infra block heals and the gate re-runs green in the same attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-svcheal-"));
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(
      join(dir, ".omp", "roadmap.yml"),
      `serviceUp:\n  - echo up\nserviceEnv:\n  OMPO_TEST_SVC_DB: up\n`,
      "utf8",
    );
    createRun(
      dir,
      parseRoadmap(
        `## [a] A\nDo A.\nVerify: node -e "if (process.env.OMPO_TEST_SVC_DB !== 'up') { console.error('connect ECONNREFUSED localhost:5432'); process.exit(1) }"\nRetries: 0\n`,
      ),
      "r",
    );
    const events: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner: okRunner, onEvent: (m) => events.push(m) });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(1);
    expect(res.blockedEnv).toBe(0);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("done");
    expect(loadRun(dir, "r").doc.slices[0]!.attempts).toBe(1);
    expect(events.some((m) => m.includes("services healed"))).toBe(true);
  });

  test("failed heal still parks as blocked-env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-svcpark-"));
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(join(dir, ".omp", "roadmap.yml"), `serviceUp:\n  - exit 1\n`, "utf8");
    createRun(
      dir,
      parseRoadmap(
        `## [a] A\nDo A.\nVerify: node -e "console.error('connect ECONNREFUSED localhost:5432'); process.exit(1)"\nRetries: 0\n`,
      ),
      "r",
    );
    const events: string[] = [];
    const res = await runRoadmapLoop({
      projectDir: dir,
      runId: "r",
      runner: okRunner,
      noDebug: true,
      onEvent: (m) => events.push(m),
    });
    expect(res.blockedEnv).toBe(1);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("blocked-env");
    expect(events.some((m) => m.includes("services heal failed"))).toBe(true);
  });
});
