import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { createRun, loadRun, readEvents, storeApi } from "../src/store.ts";
import { showSlice } from "../src/forensics.ts";
import { computeStats, queryEvents, replayRun } from "../src/stats.ts";
import { validateIntent } from "../src/control.ts";
import { startDashboardServer, formatDuration as serverFormatDuration } from "../src/server.ts";
import { viewForRun, formatDuration as tuiFormatDuration, formatEventLine as tuiFormatEventLine, dagDepths as tuiDagDepths } from "../src/watch.tsx";
import { depSatisfied as webDepSatisfied, isDagReady as webIsDagReady, readyDagIds as webReadyDagIds, dagDepths as webDagDepths } from "../web/src/lib/dag.ts";
import { buildTimeline } from "../web/src/lib/timeline.ts";
import { isReady as selectIsReady, readySlices as selectReadySlices, depSatisfied as selectDepSatisfied } from "../src/select.ts";
import type { Slice } from "../src/types.ts";
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
## [c] Gamma
Effort: med
Depends: b
Verify: bun test
body c
`;

function sliceFile(dir: string, run: string, slice: string, name: string, text: string): void {
  const d = join(dir, ".omp", "roadmap", "runs", run, "slices", slice);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), text, "utf8");
}

/** Identical fixture through every surface: a done, a failed, a running slice with generations. */
function richFixture(): { dir: string; run: string } {
  const dir = mkdtempSync(join(tmpdir(), "ompo-consistency-"));
  const run = "r1";
  createRun(dir, parseRoadmap(MD), run);

  storeApi.claimSlice(dir, run, "a");
  storeApi.workerFinished(dir, run, "a", "slices/a/report.json", {
    exit: 0,
    durationMs: 65_000,
    stats: { turns: 10, tools: 4, tokens: { input: 100, output: 50, total: 150 } },
  });
  storeApi.verifyPassed(dir, run, "a", "slices/a/verdict.json");

  storeApi.claimSlice(dir, run, "b");
  storeApi.workerFinished(dir, run, "b", "slices/b/report.json", {
    exit: 1,
    durationMs: 5_000,
    stats: { turns: 6, tools: 3, tokens: { input: 60, output: 20, total: 80 } },
  });
  storeApi.verifyFailed(dir, run, "b", "slices/b/verdict.json", "gate bun lint failed");

  storeApi.claimSlice(dir, run, "c");

  sliceFile(dir, run, "a", "worker-1-g0.log", "line one\nline two\n");
  sliceFile(dir, run, "a", "prompt-1-g0.md", "# prompt a\n");
  sliceFile(dir, run, "a", "report.json", JSON.stringify({ summary: "alpha done", done: true, filesChanged: ["src/a.ts"], testsRun: ["bun test"], deferred: [], followUps: [] }));
  sliceFile(dir, run, "a", "verdict.json", JSON.stringify({ pass: true, steps: [{ name: "bun test", exit: 0, timedOut: false, outputTail: "ok" }] }));
  sliceFile(dir, run, "a", "review.json", JSON.stringify({ approved: true, findings: [], notes: "lgtm" }));

  sliceFile(dir, run, "b", "worker-1-g0.log", "gen zero\n");
  sliceFile(dir, run, "b", "worker-1-g1.log", "gen one\n");
  sliceFile(dir, run, "b", "prompt-1-g0.md", "# prompt b\n");
  sliceFile(dir, run, "b", "report.json", JSON.stringify({ summary: "beta failed", done: false, filesChanged: [], testsRun: ["bun lint"], deferred: [], followUps: [] }));
  sliceFile(dir, run, "b", "verdict.json", JSON.stringify({ pass: false, steps: [{ name: "bun lint", exit: 1, timedOut: false, outputTail: "fail tail" }] }));
  sliceFile(dir, run, "b", "review.json", JSON.stringify({ approved: false, findings: ["fix lint"], notes: "needs work" }));

  sliceFile(dir, run, "c", "worker-1-g0.log", "c running\n");
  sliceFile(dir, run, "c", "prompt-1-g0.md", "# prompt c\n");
  return { dir, run };
}

async function getJSON(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

function expectedRunStatus(counts: { done: number; active: number; failed: number; blockedEnv: number; skipped: number; pending: number }, live: boolean, total: number): string {
  if (live) return "running";
  if (counts.failed > 0) return "failed";
  if (counts.blockedEnv > 0) return "blocked-env";
  if (counts.active > 0) return "running";
  if (total > 0 && counts.done + counts.skipped === total) return "done";
  return "pending";
}

describe("browser/TUI/CLI consistency (w5b)", () => {
  test("slice status, attempt, dependencies agree across store, TUI, web, CLI", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const cursor = loadRun(dir, run);
      const view = viewForRun(dir, run, 0)!;
      const detail = (await getJSON(`${server.url}/api/runs/${run}`)).body;
      expect(view.slices.map((s) => s.id)).toEqual(cursor.doc.slices.map((s) => s.id));
      expect(detail.slices.map((s: { id: string }) => s.id)).toEqual(cursor.doc.slices.map((s) => s.id));
      for (const s of cursor.doc.slices) {
        const tui = view.slices.find((x) => x.id === s.id)!;
        const web = detail.slices.find((x: { id: string }) => x.id === s.id)!;
        const cli = showSlice(dir, run, s.id);
        expect(tui.status).toBe(s.status);
        expect(web.status).toBe(s.status);
        expect(cli.status).toBe(s.status);
        expect(tui.attempts).toBe(s.attempts);
        expect(web.attempts).toBe(s.attempts);
        expect(cli.attempts).toBe(s.attempts);
        expect(tui.deps ?? []).toEqual([...s.deps]);
        expect(web.deps).toEqual([...s.deps]);
        expect(cli.deps).toEqual([...s.deps]);
        expect(web.verify).toEqual([...s.verify]);
        expect(cli.verify).toEqual([...s.verify]);
      }
    } finally {
      server.stop();
    }
  });

  test("generation agrees across web detail, slices list, agents, and files", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const detail = (await getJSON(`${server.url}/api/runs/${run}`)).body;
      const a = detail.slices.find((s: { id: string }) => s.id === "a");
      const b = detail.slices.find((s: { id: string }) => s.id === "b");
      // a has one generation file (g0), b has two (g0+g1).
      expect(a.generation).toBe(0);
      expect(b.generation).toBe(1);
      const da = (await getJSON(`${server.url}/api/runs/${run}/slices/a`)).body;
      const db = (await getJSON(`${server.url}/api/runs/${run}/slices/b`)).body;
      expect(da.generation).toBe(a.generation);
      expect(db.generation).toBe(b.generation);
      // c is running with one generation file; agents must report the same generation.
      const dc = (await getJSON(`${server.url}/api/runs/${run}/slices/c`)).body;
      expect(dc.generation).toBe(0);
      const agents = (await getJSON(`${server.url}/api/runs/${run}/agents`)).body;
      const cAgent = agents.find((x: { id: string }) => x.id === "c");
      expect(cAgent).toBeDefined();
      expect(cAgent.generation).toBe(dc.generation);
      expect(cAgent.attempt).toBe(dc.attempts);
      // b generations rows cover g0+g1 in order.
      expect(db.generations.map((g: { generation: number }) => g.generation)).toEqual([0, 1]);
    } finally {
      server.stop();
    }
  });

  test("verify result and review status agree across TUI, web, CLI", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const view = viewForRun(dir, run, 0)!;
      const da = (await getJSON(`${server.url}/api/runs/${run}/slices/a`)).body;
      const db = (await getJSON(`${server.url}/api/runs/${run}/slices/b`)).body;
      const showA = showSlice(dir, run, "a");
      const showB = showSlice(dir, run, "b");
      expect((showA.verdict as { pass: boolean }).pass).toBe(true);
      expect((showB.verdict as { pass: boolean }).pass).toBe(false);
      expect(da.verdictPass).toBe(true);
      expect(db.verdictPass).toBe(false);
      expect(da.review).toMatchObject({ approved: true });
      expect(db.review).toMatchObject({ approved: false });
      expect((showA.review as { approved: boolean }).approved).toBe(true);
      expect((showB.review as { approved: boolean }).approved).toBe(false);
      // TUI detail for the same slices must agree (view pins sel 0 → slice a).
      expect(view.detail?.verdictPass).toBe(true);
      expect(view.detail?.review).toMatchObject({ approved: true });
      const viewB = viewForRun(dir, run, 1)!;
      expect(viewB.detail?.verdictPass).toBe(false);
      expect(viewB.detail?.review).toMatchObject({ approved: false });
      // Caps are shared: verdict steps ≤ 6, findings ≤ 10.
      expect(da.verdictSteps.length).toBeLessThanOrEqual(6);
      expect(db.verdictSteps.length).toBeLessThanOrEqual(6);
    } finally {
      server.stop();
    }
  });

  test("run status and counts agree across TUI and web", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const view = viewForRun(dir, run, 0)!;
      const detail = (await getJSON(`${server.url}/api/runs/${run}`)).body;
      expect(detail.counts).toEqual(view.counts);
      expect(detail.live).toBe(view.live);
      expect(detail.status).toBe(expectedRunStatus(view.counts, view.live, view.slices.length));
      // CLI stats/query/replay read the same store without inventing state.
      const stats = computeStats(dir, run);
      expect(stats).toBeDefined();
      expect(queryEvents(dir, run, "worker_finished").length).toBe(readEvents(dir, run).filter((e) => e.type === "worker_finished").length);
      expect(replayRun(dir, run).events).toBe(readEvents(dir, run).length);
    } finally {
      server.stop();
    }
  });

  test("event history agrees: raw log, web events, and formatted slice history", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      const raw = readEvents(dir, run);
      const paged = (await getJSON(`${server.url}/api/runs/${run}/events?afterSeq=-1&limit=2000`)).body;
      expect(paged.events).toEqual(raw);
      expect(paged.offset).toBe(raw.at(-1)!.seq);
      const view = viewForRun(dir, run, 0)!;
      const webA = (await getJSON(`${server.url}/api/runs/${run}/slices/a`)).body;
      // Slice-scoped formatted history uses the same source:false projection on both surfaces.
      expect(webA.recentEvents).toEqual(view.detail?.recentEvents);
      expect(webA.history).toEqual(view.detail?.history);
      // Duration formatting is shared: 65s renders as the TUI compact form, never raw ms.
      const finished = raw.find((e) => e.type === "worker_finished" && e.sliceId === "a")!;
      expect(tuiFormatEventLine(finished, { source: false })).toContain("1m");
      expect(webA.recentEvents.join("\n") + webA.history.join("\n")).not.toContain("65000ms");
    } finally {
      server.stop();
    }
  });

  test("control result agrees: validation and quiescent apply match CLI semantics", async () => {
    const { dir, run } = richFixture();
    const server = startDashboardServer({ projectDir: dir });
    try {
      // Validation is the shared control.ts path: park without reason fails everywhere.
      expect(validateIntent({ kind: "park", sliceId: "b" } as never)).toContain("reason");
      const bad = await getJSON(`${server.url}/api/runs/${run}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "park", sliceId: "b" }),
      });
      expect(bad.status).toBe(400);
      // Quiescent retry on the failed slice re-queues with one more attempt via the same store guard.
      const before = loadRun(dir, run).doc.slices.find((s) => s.id === "b")!;
      expect(before.status).toBe("failed");
      const ok = await getJSON(`${server.url}/api/runs/${run}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "retry", sliceId: "b" }),
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, applied: "direct" });
      const after = loadRun(dir, run).doc.slices.find((s) => s.id === "b")!;
      expect(after.status).toBe("pending");
      const types = readEvents(dir, run).map((e) => e.type);
      expect(types).toContain("control_requested");
      expect(types).toContain("control_applied");
      // Unknown slice is 404 on the web, same unknown-slice guard as showSlice/requestControl.
      const missing = await getJSON(`${server.url}/api/runs/${run}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "retry", sliceId: "zzz" }),
      });
      expect(missing.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  test("no invented scheduler semantics: web DAG helpers match select.ts and TUI depths", () => {
    const { dir, run } = richFixture();
    const cursor = loadRun(dir, run);
    const view = viewForRun(dir, run, 0)!;
    const slices = cursor.doc.slices;
    const byId = new Map(slices.map((s) => [s.id, s]));
    // Ready sets agree: web readyDagIds == select readySlices on the same statuses.
    const dagSlices = slices.map((s) => ({ id: s.id, title: s.title, status: s.status, deps: [...s.deps] }));
    const webById = new Map(dagSlices.map((s) => [s.id, s]));
    for (const s of dagSlices) {
      expect(webDepSatisfied(webById.get(s.id))).toBe(selectDepSatisfied(byId.get(s.id) as Slice | undefined));
      expect(webIsDagReady(s, webById)).toBe(selectIsReady(byId.get(s.id) as Slice, byId as Map<string, Slice>));
    }
    expect(webReadyDagIds(dagSlices)).toEqual(selectReadySlices(cursor.doc).map((s) => s.id));
    // Depth layout agrees with the TUI helper on the same graph.
    const webDepths = webDagDepths(dagSlices);
    const tuiDepths = tuiDagDepths(view.slices);
    for (const s of slices) {
      expect(webDepths.get(s.id)).toBe(tuiDepths.get(s.id));
    }
  });

  test("no invented display semantics: shared duration formatting and timeline observations", () => {
    expect(serverFormatDuration(65_000)).toBe(tuiFormatDuration(65_000));
    expect(serverFormatDuration(5_000)).toBe(tuiFormatDuration(5_000));
    const { dir, run } = richFixture();
    const events = readEvents(dir, run);
    const cursor = loadRun(dir, run);
    const model = buildTimeline(events, cursor.doc.slices.map((s) => ({ id: s.id, title: s.title })));
    // Timeline observes the same attempts the store counts — it never invents segments.
    for (const row of model.rows) {
      const slice = cursor.doc.slices.find((s) => s.id === row.sliceId)!;
      expect(row.attempts.length).toBeGreaterThanOrEqual(1);
      expect(row.retries).toBe(row.attempts.length - 1);
      expect(slice.attempts).toBeGreaterThanOrEqual(row.attempts.length);
    }
    // Tokens are observed worker_finished totals, never estimates.
    const finishedTotals = events.filter((e) => e.type === "worker_finished" && e.stats?.tokens).reduce((n, e) => n + e.stats!.tokens!.total, 0);
    const timelineTokens = model.rows.flatMap((r) => r.attempts).reduce((n, a) => n + (a.tokens ?? 0), 0);
    expect(timelineTokens).toBe(finishedTotals);
  });
});
