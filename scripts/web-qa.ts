#!/usr/bin/env bun
/**
 * Web visual-QA evidence (w5d) — objective, deterministic coverage of every
 * browser scenario in the slice goal, through the real dashboard server:
 *
 *   running / completed / failed / blocked-env runs, blocked dependency,
 *   concurrent workers, generations + handoff, multi-gate verify failure,
 *   minor-fix vs major-rejection reviews, populated diff/review/events,
 *   DAG, timeline, narrow-width CSS contract, long vs empty output tails,
 *   pause/retry/skip/kill control states.
 *
 * No product functionality: fixtures live in tmp dirs, the only repo write
 * is captures/web-qa.json (normalized numbers/booleans — no timestamps).
 * Exit non-zero on the first failed check.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { parseRoadmap } from "../src/parse.ts";
import { acquireLock, createRun, readEvents, releaseLock, storeApi } from "../src/store.ts";
import { startDashboardServer } from "../src/server.ts";
import { depSatisfied, isDagReady, layoutDag, readyDagIds } from "../web/src/lib/dag.ts";
import { buildTimeline } from "../web/src/lib/timeline.ts";
import { splitDiffFiles } from "../web/src/components/DiffView.tsx";

const ROOT = join(import.meta.dir, "..");
let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
}

function sliceFile(dir: string, run: string, slice: string, name: string, text: string): void {
  const d = join(dir, ".omp", "roadmap", "runs", run, "slices", slice);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), text, "utf8");
}
function lines(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n") + "\n";
}
async function getJSON(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

const MD = `## [ship] Ship core
Effort: lo
Agent: sonic
Verify: bun test
ship body
## [gatefail] Gate failure
Effort: med
Agent: task
Verify: bun lint
Verify: bun test --coverage
Verify: bunx tsc --noEmit
gatefail body
## [env] Env parked
Effort: lo
Agent: sonic
Verify: bun test
env body
## [dep] Blocked dep
Effort: lo
Depends: gatefail
Verify: bun test
dep body
## [w1] Worker one
Effort: lo
Agent: sonic
Verify: bun test
w1 body
## [w2] Worker two
Effort: lo
Agent: sonic
Verify: bun test
w2 body
## [gen] Handoff gen
Effort: med
Agent: task
Verify: bun test
gen body
## [empty] Empty output
Effort: lo
Agent: sonic
Verify: bun test
empty body
`;

const CTL_MD = `## [f1] Ctl failed
Effort: lo
Agent: sonic
Verify: bun test
f1 body
## [r1] Ctl running
Effort: lo
Agent: sonic
Verify: bun test
r1 body
## [p1] Ctl pending
Effort: lo
Agent: sonic
Verify: bun test
p1 body
`;

// ---- fixture: main matrix run ----
const dir = mkdtempSync(join(tmpdir(), "ompo-webqa-"));
sliceFile(dir, run, "w1", "worker-1-g0.log", "w1 working\n");
sliceFile(dir, run, "w2", "worker-1-g0.log", "w2 working\n");
// The empty-output slice exists but has produced no artifacts: the dir is
// present (so detail is non-null) with zero files in it.
mkdirSync(join(dir, ".omp", "roadmap", "runs", run, "slices", "empty"), { recursive: true });

storeApi.claimSlice(dir, run, "ship");
storeApi.workerFinished(dir, run, "ship", "slices/ship/report.json", {
  exit: 0,
  durationMs: 65_000,
  stats: { turns: 10, tools: 4, tokens: { input: 100, output: 50, total: 150 } },
});
storeApi.verifyPassed(dir, run, "ship", "slices/ship/verdict.json");

storeApi.claimSlice(dir, run, "gatefail");
storeApi.workerFinished(dir, run, "gatefail", "slices/gatefail/report.json", {
  exit: 1,
  durationMs: 5_000,
  stats: { turns: 6, tools: 3, tokens: { input: 60, output: 20, total: 80 } },
});
storeApi.verifyFailed(dir, run, "gatefail", "slices/gatefail/verdict.json", "gate bun test --coverage failed");

storeApi.parkSlice(dir, run, "env", "postgres down — fix DATABASE_URL then resume");
storeApi.claimSlice(dir, run, "w1");
storeApi.claimSlice(dir, run, "w2");
storeApi.claimSlice(dir, run, "gen");
storeApi.recordHandoff(dir, run, "gen", "context cap — continuing in g1");
storeApi.recordHandoff(dir, run, "gen", "context cap — continuing in g2");

sliceFile(dir, run, "ship", "worker-1-g0.log", lines(500, "ship"));
sliceFile(dir, run, "ship", "prompt-1-g0.md", lines(100, "ship prompt"));
sliceFile(
  dir, run, "ship", "report.json",
  JSON.stringify({ summary: "ship done", done: true, filesChanged: ["src/a.ts", "src/b.ts"], testsRun: ["bun test", "bun lint"], deferred: ["docs follow-up"], followUps: ["perf pass"], verificationNotes: "all green" }),
);
sliceFile(dir, run, "ship", "verdict.json", JSON.stringify({ pass: true, steps: [{ name: "bun test", exit: 0, timedOut: false, outputTail: "ok" }] }));
sliceFile(dir, run, "ship", "review.json", JSON.stringify({ approved: true, findings: ["nit: rename x"], notes: "minor nit only" }));

sliceFile(dir, run, "gatefail", "worker-1-g0.log", "gatefail log\n");
sliceFile(dir, run, "gatefail", "prompt-1-g0.md", "# prompt gatefail\n");
  check("failed-run status", qa.status === "failed", qa.status);
  check("failed-run counts", qa.counts?.done === 1 && qa.counts?.failed === 1 && qa.counts?.blockedEnv === 1 && qa.counts?.active === 3 && qa.counts?.pending === 6, qa.counts);
);
sliceFile(
  dir, run, "gatefail", "verdict.json",
  JSON.stringify({ pass: false, steps: [
    { name: "bun lint", exit: 0, timedOut: false, outputTail: "lint ok" },
    { name: "bun test --coverage", exit: 1, timedOut: false, outputTail: "coverage fail tail" },
  ] }),
);
sliceFile(dir, run, "gatefail", "review.json", JSON.stringify({ approved: false, findings: ["fix coverage", "add test for retry"], notes: "major: missing tests" }));
sliceFile(dir, run, "gatefail", "review-notes.md", "prior rejection: coverage below gate\n");

sliceFile(dir, run, "gen", "worker-1-g0.log", "gen zero\n");
sliceFile(dir, run, "gen", "worker-1-g1.log", "gen one\n");
sliceFile(dir, run, "gen", "worker-1-g2.log", "gen two\n");
sliceFile(dir, run, "gen", "prompt-1-g0.md", "# prompt gen g0\n");
sliceFile(dir, run, "gen", "prompt-1-g1.md", "# prompt gen g1\n");
sliceFile(dir, run, "w1", "worker-1-g0.log", "w1 working\n");
sliceFile(dir, run, "w2", "worker-1-g0.log", "w2 working\n");

// ---- fixture: single-state runs ----
createRun(dir, parseRoadmap(`## [only] Only\nEffort: lo\nAgent: sonic\nVerify: bun test\nbody\n`), "qadone");
storeApi.claimSlice(dir, "qadone", "only");
storeApi.workerFinished(dir, "qadone", "only", "slices/only/report.json", { exit: 0, durationMs: 1000 });
storeApi.verifyPassed(dir, "qadone", "only", "slices/only/verdict.json");
sliceFile(dir, "qadone", "only", "report.json", JSON.stringify({ summary: "only done", done: true, filesChanged: [], testsRun: ["bun test"], deferred: [], followUps: [] }));
sliceFile(dir, "qadone", "only", "verdict.json", JSON.stringify({ pass: true, steps: [{ name: "bun test", exit: 0, timedOut: false, outputTail: "ok" }] }));

createRun(dir, parseRoadmap(`## [e1] Env one\nEffort: lo\nAgent: sonic\nVerify: bun test\nbody\n## [e2] Env two\nEffort: lo\nVerify: bun test\nbody\n`), "qablocked");
storeApi.parkSlice(dir, "qablocked", "e1", "db down");

createRun(dir, parseRoadmap(`## [live1] Live one\nEffort: lo\nAgent: sonic\nVerify: bun test\nbody\n`), "qalive");
storeApi.claimSlice(dir, "qalive", "live1");
acquireLock(dir, "qalive");

createRun(dir, parseRoadmap(CTL_MD), "qactl");
storeApi.claimSlice(dir, "qactl", "f1");
storeApi.workerFinished(dir, "qactl", "f1", "slices/f1/report.json", { exit: 1, durationMs: 2000 });
storeApi.terminalFail(dir, "qactl", "f1", "gate failed");
storeApi.claimSlice(dir, "qactl", "r1");

const server = startDashboardServer({ projectDir: dir });
const snap: Record<string, unknown> = {};
try {
  // 1. failed run (main matrix): counts + status + failed reason.
  const qa = (await getJSON(`${server.url}/api/runs/${run}`)).body;
  check("failed-run status", qa.status === "failed", qa.status);
  check("failed-run counts", qa.counts?.done === 1 && qa.counts?.failed === 0 && qa.counts?.blockedEnv === 1 && qa.counts?.active === 3, qa.counts);
  const gatefail = qa.slices.find((s: any) => s.id === "gatefail");
  check("failed-run verify listed", Array.isArray(gatefail?.verify) && gatefail.verify.length === 3, gatefail?.verify);
  snap.failedRun = { status: qa.status, counts: qa.counts };

  // 2. completed run.
  const done = (await getJSON(`${server.url}/api/runs/qadone`)).body;
  check("completed-run status", done.status === "done", done.status);
  snap.completedRun = { status: done.status, counts: done.counts };

  // 3. blocked-environment run.
  const blocked = (await getJSON(`${server.url}/api/runs/qablocked`)).body;
  check("blocked-env-run status", blocked.status === "blocked-env", blocked.status);
  check("blocked-env-run count", blocked.counts?.blockedEnv === 1, blocked.counts);
  snap.blockedEnvRun = { status: blocked.status, counts: blocked.counts };

  // 4. running (live) run.
  const live = (await getJSON(`${server.url}/api/runs/qalive`)).body;
  check("running-run live", live.live === true, live.live);
  check("running-run status", live.status === "running", live.status);
  check("running-run workers", live.workers === 1, live.workers);
  snap.runningRun = { status: live.status, live: live.live, workers: live.workers };

  // 5. blocked dependency: dep is pending, depSatisfied false on both layers.
  const dep = qa.slices.find((s: any) => s.id === "dep");
  check("blocked-dep pending", dep?.status === "pending" && dep?.deps?.includes("gatefail"), dep);
  const dagSlices = qa.slices.map((s: any) => ({ id: s.id, title: s.title, status: s.status, deps: [...s.deps] }));
  const byId = new Map(dagSlices.map((s: any) => [s.id, s]));
  check("blocked-dep not ready", isDagReady(byId.get("dep"), byId) === false);
  check("blocked-dep unsatisfied", depSatisfied(byId.get("dep")) === false);
  check("blocked-dep excluded from ready", !readyDagIds(dagSlices).includes("dep"), readyDagIds(dagSlices));
  snap.blockedDep = { status: dep?.status, ready: false };

  // 6. multiple concurrent workers: lanes + generation/attempt parity.
  const agents = (await getJSON(`${server.url}/api/runs/${run}/agents`)).body;
  const lanes = agents.map((a: any) => a.lane).sort();
  check("concurrent-workers rows", agents.length === 3, agents.length);
  check("concurrent-workers lanes", JSON.stringify(lanes) === JSON.stringify([0, 1, 2]), lanes);
  snap.concurrentWorkers = { rows: agents.length, lanes };

  // 7. generations + context handoff.
  const gen = (await getJSON(`${server.url}/api/runs/${run}/slices/gen`)).body;
  check("generations count", gen.generation === 2, gen.generation);
  check("generations rows", JSON.stringify(gen.generations?.map((g: any) => g.generation)) === JSON.stringify([0, 1, 2]), gen.generations);
  const events = (await getJSON(`${server.url}/api/runs/${run}/events?afterSeq=-1&limit=2000`)).body;
  const handoffs = events.events.filter((e: any) => e.type === "slice_handoff" && e.sliceId === "gen");
  check("handoff events", handoffs.length === 2, handoffs.length);
  const model = buildTimeline(events.events, qa.slices.map((s: any) => ({ id: s.id, title: s.title })));
  const genRow = model.rows.find((r) => r.sliceId === "gen");
  const ticks = genRow?.attempts.reduce((n: number, a: any) => n + a.handoffMs.length, 0) ?? 0;
  check("timeline handoff ticks", ticks === 2, ticks);
  snap.generations = { generation: gen.generation, handoffs: handoffs.length, ticks };

  // 8. failed Verify with multiple gates: executed mix + pending gate.
  const gf = (await getJSON(`${server.url}/api/runs/${run}/slices/gatefail`)).body;
  check("verify multi steps", gf.verdictSteps?.length === 2 && gf.verdictPass === false, gf.verdictSteps);
  check("verify pending gate", gf.verify?.includes("bunx tsc --noEmit") && gf.verdictSteps.every((s: any) => s.name !== "bunx tsc --noEmit"), gf.verify);
  const failTail = gf.verdictSteps.find((s: any) => s.exit !== 0)?.tail ?? "";
  check("verify failure tail", failTail.includes("coverage fail tail"), failTail);
  snap.verifyMulti = { steps: gf.verdictSteps?.length, pass: gf.verdictPass, pendingGate: true };

  // 9. minor review fix vs major rejection.
  const ship = (await getJSON(`${server.url}/api/runs/${run}/slices/ship`)).body;
  check("review minor approved", ship.review?.approved === true && ship.review?.findings?.length === 1, ship.review);
  check("review major rejected", gf.review?.approved === false && gf.review?.findings?.length === 2, gf.review);
  check("review prior rejection notes", typeof gf.reviewNotes === "string" && gf.reviewNotes.includes("coverage below gate"), gf.reviewNotes);
  snap.reviews = { minor: ship.review, majorApproved: gf.review?.approved, priorNotes: true };

  // 10. populated diff: pure splitter + endpoint shape (non-git fixture → note).
  const sample = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " context",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 333..444 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -5,3 +5,4 @@",
    "+added",
    "@@ -20,2 +21,2 @@",
    "-x",
    "+y",
  ].join("\n");
  const files = splitDiffFiles(sample);
  check("diff splitter files", files.length === 2, files.length);
  check("diff splitter hunks", files[0]?.hunks.length === 1 && files[1]?.hunks.length === 2, files.map((f) => f.hunks.length));
  const diff = (await getJSON(`${server.url}/api/runs/${run}/slices/ship/diff`)).body;
  check("diff endpoint note", typeof diff?.note === "string", diff);
  check("diff report files", JSON.stringify(ship.reportFull?.filesChanged) === JSON.stringify(["src/a.ts", "src/b.ts"]), ship.reportFull?.filesChanged);
  snap.diff = { files: files.length, hunks: files.map((f) => f.hunks.length), endpointNote: typeof diff?.note === "string" };

  // 11. populated events: pagination, offset, query DSL.
  check("events offset", events.offset === events.events.at(-1)?.seq, events.offset);
  const q = (await getJSON(`${server.url}/api/runs/${run}/query?q=${encodeURIComponent("worker_finished")}`)).body;
  const rawFinished = readEvents(dir, run).filter((e) => e.type === "worker_finished").length;
  check("events query", q.events?.length === rawFinished && rawFinished === 2, q.events?.length);
  const scoped = (await getJSON(`${server.url}/api/runs/${run}/events?afterSeq=-1&limit=2000&sliceId=gen`)).body;
  check("events slice scope", scoped.events.length > 0 && scoped.events.every((e: any) => e.sliceId === "gen"), scoped.events.length);
  snap.events = { total: events.events.length, query: q.events?.length };

  // 12. DAG: unknown ghost + cycle (pure layout on declared shapes).
  const dag = layoutDag([
    { id: "a", title: "A", status: "done", deps: [] },
    { id: "b", title: "B", status: "pending", deps: ["a", "ghost"] },
    { id: "c1", title: "C1", status: "pending", deps: ["c2"] },
    { id: "c2", title: "C2", status: "pending", deps: ["c1"] },
  ]);
  check("dag unknown ghost", dag.unknownIds.includes("ghost"), dag.unknownIds);
  check("dag cycle", dag.cycleIds.includes("c1") && dag.cycleIds.includes("c2"), dag.cycleIds);
  check("dag nodes+edges", dag.nodes.length === 5 && dag.edges.length === 4, { nodes: dag.nodes.length, edges: dag.edges.length });
  snap.dag = { unknown: dag.unknownIds, cycle: dag.cycleIds, nodes: dag.nodes.length, edges: dag.edges.length };

  // 13. timeline observations: attempts, retries, token totals.
  const finishedTotals = readEvents(dir, run)
    .filter((e) => e.type === "worker_finished" && (e as any).stats?.tokens)
    .reduce((n, e) => n + (e as any).stats.tokens.total, 0);
  const timelineTokens = model.rows.flatMap((r) => r.attempts).reduce((n, a) => n + (a.tokens ?? 0), 0);
  check("timeline rows", model.rows.length > 0 && model.rows.every((r) => r.attempts.length >= 1), model.rows.length);
  check("timeline tokens", timelineTokens === finishedTotals && finishedTotals === 230, { timelineTokens, finishedTotals });
  snap.timeline = { rows: model.rows.length, tokens: timelineTokens };

  // 14. narrow-width CSS contract (static): breakpoints + no page-level overflow.
  const css = readFileSync(join(ROOT, "web", "src", "styles", "theme.css"), "utf8");
  check("narrow 760 breakpoint", css.includes("@media (max-width: 760px)"));
  check("narrow table scroll", css.includes(".omp-table-wrap") && css.includes("overflow-x: auto"));
  check("narrow shell clip", css.includes("overflow-x: clip"));
  snap.narrow = { breakpoint760: true, tableScroll: true, shellClip: true };

  // 15. long output capped; 16. empty output null-safe.
  const workerTailLines = ship.workerTail ? ship.workerTail.split("\n").length : 0;
  const promptTailLines = ship.promptTail ? ship.promptTail.split("\n").length : 0;
  check("long worker tail capped", workerTailLines <= 60 && workerTailLines > 0, workerTailLines);
  check("long prompt tail capped", promptTailLines <= 30 && promptTailLines > 0, promptTailLines);
  const empty = (await getJSON(`${server.url}/api/runs/${run}/slices/empty`)).body;
  check("empty artifacts", empty?.artifacts && Object.values(empty.artifacts).every((v) => v === false), empty?.artifacts);
  check("empty summary absent", !empty?.reportSummary && !empty?.workerTail && !empty?.promptTail, null);
  snap.longOutput = { workerTailLines, promptTailLines };
  snap.emptyOutput = { artifacts: empty?.artifacts };

  // 17. control states on the quiescent qactl run + live pause on qalive.
  const post = (kind: string, extra?: Record<string, unknown>) =>
    getJSON(`${server.url}/api/runs/qactl/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, ...extra }),
    });
  const retry = await post("retry", { sliceId: "f1" });
  check("control retry direct", retry.status === 200 && retry.body?.applied === "direct" && retry.body?.ok === true, retry.body);
  const kill = await post("kill", { sliceId: "r1" });
  check("control kill direct", kill.status === 200 && kill.body?.ok === true, kill.body);
  const skip = await post("skip", { sliceId: "p1" });
  check("control skip direct", skip.status === 200 && skip.body?.ok === true, skip.body);
  const pauseQ = await post("pause");
  check("control pause quiescent rejected", pauseQ.status === 200 && pauseQ.body?.ok === false && /live loop/.test(pauseQ.body?.message ?? ""), pauseQ.body);
  const park400 = await post("park", { sliceId: "p1" });
  check("control park needs reason", park400.status === 400, park400.status);
  const unknown404 = await post("retry", { sliceId: "zzz" });
  check("control unknown slice 404", unknown404.status === 404, unknown404.status);
  const jobs400 = await post("set-jobs", { jobs: 0 });
  check("control bad jobs 400", jobs400.status === 400, jobs400.status);
  const pauseLive = await getJSON(`${server.url}/api/runs/qalive/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "pause" }),
  });
  check("control pause live applied", pauseLive.status === 200 && pauseLive.body?.applied === "direct" && pauseLive.body?.ok === true, pauseLive.body);
  // Terminal states landed where the guards promise.
  const ctl = (await getJSON(`${server.url}/api/runs/qactl`)).body;
  const byIdCtl = new Map(ctl.slices.map((s: any) => [s.id, s.status]));
  check("control end states", byIdCtl.get("f1") === "pending" && byIdCtl.get("r1") === "aborted" && byIdCtl.get("p1") === "skipped", Object.fromEntries(byIdCtl));
  snap.control = { retry: retry.body?.ok, kill: kill.body?.ok, skip: skip.body?.ok, pauseQuiescentOk: pauseQ.body?.ok, pauseLiveOk: pauseLive.body?.ok, park400: park400.status, unknown404: unknown404.status, jobs400: jobs400.status };

  // 18. dashboard shell serves (embedded-first contract): HTML + hashed assets.
  const html = await fetch(`${server.url}/`).then((r) => r.text());
  check("shell html", html.includes('<div id="root">') && html.includes("/assets/"), html.slice(0, 120));
  snap.shell = { servesHtml: true };
} finally {
  releaseLock(dir, "qalive");
  server.stop();
}

writeFileSync(join(ROOT, "captures", "web-qa.json"), JSON.stringify({ generated: "w5d", scenarios: snap }, null, 2) + "\n");
console.log(`\nweb-qa: ${failures === 0 ? "all checks passed" : `${failures} FAILURES`} — snapshot → captures/web-qa.json`);
process.exit(failures === 0 ? 0 : 1);
