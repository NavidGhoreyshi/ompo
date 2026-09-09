import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { createRun, readEvents, storeApi } from "../src/store.ts";
import { startDashboardServer } from "../src/server.ts";
// The sandbox sets HTTP(S)_PROXY without NO_PROXY; loopback test traffic
// must not go through the proxy.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

const MD = `## [a] Alpha
Effort: lo
Agent: sonic
Verify: bun test
body a
## [b] Beta
Effort: hi
Depends: a
Verify: bun lint
body b
`;

function sliceFile(dir: string, run: string, slice: string, name: string, text: string): void {
  const d = join(dir, ".omp", "roadmap", "runs", run, "slices", slice);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), text, "utf8");
}

/** a done (verdict + review + tokens) and a running slice with two worker generations. */
function richFixture(): { dir: string; run: string } {
  const dir = mkdtempSync(join(tmpdir(), "ompo-read-"));
  const run = "r1";
  createRun(dir, parseRoadmap(MD), run);

  storeApi.claimSlice(dir, run, "a");
  storeApi.workerFinished(dir, run, "a", "slices/a/report.json", {
    exit: 0,
    durationMs: 1000,
    stats: { turns: 10, tools: 4, tokens: { input: 100, output: 50, total: 150 } },
  });
  storeApi.verifyPassed(dir, run, "a", "slices/a/verdict.json");
  storeApi.claimSlice(dir, run, "b");

  sliceFile(dir, run, "a", "worker-1-g0.log", "line one\nline two\n");
  sliceFile(dir, run, "a", "prompt-1-g0.md", "# prompt a\n");
  sliceFile(
    dir,
    run,
    "a",
    "report.json",
    JSON.stringify({
      sliceId: "a",
      summary: "alpha done",
      filesChanged: ["src/a.ts"],
      testsRun: ["bun test"],
      deferred: [],
      done: true,
      verificationNotes: "all green",
      followUps: [],
    }),
  );
  sliceFile(
    dir,
    run,
    "a",
    "verdict.json",
    JSON.stringify({
      sliceId: "a",
      attempt: 1,
      pass: true,
      at: new Date().toISOString(),
      steps: [{ name: "test", command: "bun test", exit: 0, timedOut: false, outputTail: "ok", logRef: "" }],
    }),
  );
  sliceFile(dir, run, "a", "review.json", JSON.stringify({ approved: true, findings: [], notes: "lgtm" }));

  sliceFile(dir, run, "b", "worker-1-g0.log", "gen zero\n");
  sliceFile(dir, run, "b", "worker-1-g1.log", "gen one\n");
  sliceFile(dir, run, "b", "prompt-1-g0.md", "# prompt b\n");
  return { dir, run };
}

async function getJSON(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

describe("dashboard read API", () => {
  test("runs list carries status counts and worker count", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const { status, body } = await getJSON(`${server.url}/api/runs`);
      expect(status).toBe(200);
      expect(body.length).toBe(1);
      expect(body[0]).toMatchObject({
        runId: run,
        counts: { done: 1, active: 1, failed: 0, skipped: 0, blockedEnv: 0, pending: 1 },
        workers: 1,
      });
      expect(typeof body[0].createdAt).toBe("string");
      expect(typeof body[0].live).toBe("boolean");
    } finally {
      server.stop();
    }
  });

  test("run detail and slices list carry attempt, generation, effort, agent, deps, verify", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const detail = (await getJSON(`${server.url}/api/runs/${run}`)).body;
      expect(detail.slices.map((s: { id: string }) => s.id)).toEqual(["a", "b"]);
      expect(detail.slices.find((s: { id: string }) => s.id === "a")).toMatchObject({
        status: "done",
        attempts: 1,
        effort: "lo",
        agent: "sonic",
        generation: 0,
        deps: [],
        verify: ["bun test"],
      });
      expect(detail.slices.find((s: { id: string }) => s.id === "b")).toMatchObject({
        status: "running",
        attempts: 1,
        effort: "hi",
        generation: 1,
        deps: ["a"],
        verify: ["bun lint"],
      });

      const list = (await getJSON(`${server.url}/api/runs/${run}/slices`)).body;
      expect(list.map((s: { id: string }) => s.id)).toEqual(["a", "b"]);
      expect(list[1]).toMatchObject({ generation: 1, deps: ["a"] });
    } finally {
      server.stop();
    }
  });

  test("slice detail carries verify/review status, metrics with tokens, events, artifact availability", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const { status, body: a } = await getJSON(`${server.url}/api/runs/${run}/slices/a`);
      expect(status).toBe(200);
      expect(a).toMatchObject({
        sliceId: "a",
        title: "Alpha",
        status: "done",
        attempts: 1,
        effort: "lo",
        agent: "sonic",
        generation: 0,
        deps: [],
        verify: ["bun test"],
        reportSummary: "alpha done",
        verdictPass: true,
        artifacts: { report: true, verdict: true, review: true, workerLog: true, prompt: true },
      });
      expect(a.metrics).toMatchObject({
        turns: 10,
        tools: 4,
        durationMs: 1000,
        tokens: { input: 100, output: 50, total: 150 },
      });
      expect(a.review).toMatchObject({ approved: true, findings: [] });
      expect(a.verdictSteps?.length).toBe(1);
      expect(a.recentEvents.length).toBeGreaterThan(0);
      expect(a.reportFull).toMatchObject({ filesChanged: ["src/a.ts"], testsRun: ["bun test"], done: true });
      expect(a.workerTail).toContain("line two");
      expect(a.promptName).toBe("prompt-1-g0.md");

      const { body: b } = await getJSON(`${server.url}/api/runs/${run}/slices/b`);
      expect(b.workerLogName).toBe("worker-1-g1.log");
      expect(b.workerTail).toContain("gen one");
      expect(b.metrics).toBeUndefined();
      expect(b.artifacts).toMatchObject({ report: false, verdict: false, review: false, workerLog: true, prompt: true });

      expect((await getJSON(`${server.url}/api/runs/${run}/slices/zzz`)).status).toBe(404);
    } finally {
      server.stop();
    }
  });

  test("agents lists live workers with lane, attempt, generation, last line", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const { status, body } = await getJSON(`${server.url}/api/runs/${run}/agents`);
      expect(status).toBe(200);
      expect(body.length).toBe(1);
      expect(body[0]).toMatchObject({ id: "b", lane: 0, status: "running", attempt: 1, generation: 1, effort: "hi" });
      expect(typeof body[0].lastLine).toBe("string");
      expect(body[0].lastLine.length).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  });

  test("events supports types and sliceId filters against the durable log", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const all = readEvents(dir, run);
      const byType = (await getJSON(`${server.url}/api/runs/${run}/events?types=worker_finished`)).body;
      expect(byType.events.length).toBe(all.filter((e) => e.type === "worker_finished").length);
      expect(byType.events.every((e: { type: string }) => e.type === "worker_finished")).toBe(true);

      const bySlice = (await getJSON(`${server.url}/api/runs/${run}/events?sliceId=b`)).body;
      expect(bySlice.events.length).toBe(all.filter((e) => e.sliceId === "b").length);
      expect(bySlice.events.every((e: { sliceId: string }) => e.sliceId === "b")).toBe(true);

      const both = (
        await getJSON(`${server.url}/api/runs/${run}/events?types=slice_claimed&sliceId=a`)
      ).body;
      expect(both.events.length).toBe(
        all.filter((e) => e.type === "slice_claimed" && e.sliceId === "a").length,
      );
      expect(byType.offset).toBe(all.at(-1)!.seq);
    } finally {
      server.stop();
    }
  });

  test("read API never exposes internal filesystem paths", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const bodies = await Promise.all(
        [
          `/api/runs`,
          `/api/runs/${run}`,
          `/api/runs/${run}/slices`,
          `/api/runs/${run}/slices/a`,
          `/api/runs/${run}/slices/b`,
          `/api/runs/${run}/agents`,
          `/api/runs/${run}/events?afterSeq=-1&limit=200`,
        ].map(async (p) => JSON.stringify((await getJSON(`${server.url}${p}`)).body)),
      );
      for (const text of bodies) {
        expect(text).not.toContain(dir);
        expect(text).not.toContain(".omp/");
      }
    } finally {
      server.stop();
    }
  });
});
