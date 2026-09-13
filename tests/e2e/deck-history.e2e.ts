import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spec owns its own server: it needs a run whose recorded events span real
// time (so the ribbon has buckets to walk) and a second run (so the wall has
// something to switch to). The fixture drives the run through `storeApi` — the
// same store the loop writes — and then rewrites the log's timestamps, which is
// the recorded fact the temporal layer projects.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { parseRoadmap } from "../../src/parse.ts";
import { createRun, runDir, storeApi } from "../../src/store.ts";
import type { DeckSample } from "../../web/src/scene/instrument.ts";

/**
 * The temporal layer (roadmap slice `d07`), on the real surface.
 *
 * The questions this file answers:
 *
 *   1. is live still the default, and is it one step away from anywhere in
 *      history?
 *   2. is a historical state a pure function of its sequence — the same seq
 *      gives the same scene by any route (step, scrubber, a second visit)?
 *   3. is exploring history inert — no request, no selection change, no camera
 *      move, no store write — while the live workflow stays one key away?
 *   4. does playback land only on recorded states, or invent intermediate ones?
 *   5. does the wall list every run and switch the whole surface without a
 *      reload?
 *
 * `captures/deck-validation/d07-history.json` holds the numbers.
 */

const PORT = 4483;
const RUN_ID = "d07-history";
const OTHER_RUN = "d07-probe";
/**
 * Every number the slice's review quotes, written where the earlier slices put
 * theirs (`captures/deck-validation/`). Filled by the specs below, flushed in
 * `afterAll` — one run, one artifact.
 */
const ARTIFACT = join("captures", "deck-validation", "d07-history.json");
const SCREENSHOT_LIVE = join("captures", "deck-d07-ribbon.png");
const SCREENSHOT_RAIL = join("captures", "deck-d07-rail.png");
const SCREENSHOT_PAST = join("captures", "deck-d07-history.png");
const SCREENSHOT_WALL = join("captures", "deck-d07-wall.png");
const report: Record<string, unknown> = { runId: RUN_ID, otherRun: OTHER_RUN, port: PORT };

const ROADMAP = `# Deck d07 history fixture

## [alpha] Alpha — the slice that finished
Effort: lo
Agent: task
Verify: bun test
Scenario 1–4: a terminal state the history walks past.

## [beta] Beta — the slice that failed
Effort: lo
Agent: task
Verify: bun test
Scenario 1–3: a failure at a known moment, for the bucket click.

## [delta] Delta — the slice that was retried
Effort: lo
Agent: task
Verify: bun test
Scenario 6: two recorded attempts.

## [gamma] Gamma — the slice still running
Effort: lo
Agent: sonic
Verify: bun test
Scenario 1: a live-looking pad the history must not confuse with "now".
`;

interface HarnessInfo {
  projectDir: string;
  url: string;
  port: number;
  assetMode: string;
}

async function startHarness(projectDir: string): Promise<{ proc: ChildProcess; info: HarnessInfo }> {
  const proc = spawn(
    "bun",
    [join("tests", "e2e", "deck-workflow-harness.ts"), "--project-dir", projectDir, "--port", String(PORT)],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = Promise.withResolvers<HarnessInfo>();
  let output = "";
  const timer = setTimeout(() => ready.reject(new Error(`harness never reported readiness: ${output}`)), 20_000);
  proc.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const line = output.split("\n").find((entry) => entry.startsWith("deck-workflow-harness "));
    if (!line) return;
    clearTimeout(timer);
    ready.resolve(JSON.parse(line.slice("deck-workflow-harness ".length)) as HarnessInfo);
  });
  proc.on("error", (error) => {
    clearTimeout(timer);
    ready.reject(error);
  });
  proc.on("exit", (code) => {
    clearTimeout(timer);
    ready.reject(new Error(`harness exited with code ${code}: ${output}`));
  });
  const info = await ready.promise;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const res = await fetch(`${info.url}/api/health`);
      if (res.ok) return { proc, info };
    } catch {
      // Not bound yet: poll again below.
    }
    await Bun.sleep(125);
  }
  throw new Error(`harness never answered /api/health at ${info.url}`);
}

interface HookView {
  mounted: number;
  digest: string;
  selected: string | null;
  focused: string | null;
  camera: Record<string, unknown>;
  dockOpen: boolean;
  dockTab: string;
  historySeq: number | null;
  historyBucket: number;
  historyActive: number;
  ribbon: number;
  tiles: number;
  playing: boolean;
  frames: number;
  sceneWrites: number;
  tweens: number;
  liveCount: number;
}

function readHook(page: Page): Promise<HookView> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __ompoDeck?: HookView }).__ompoDeck;
    if (!hook) throw new Error("window.__ompoDeck is not installed");
    return hook;
  });
}

function readSample(page: Page): Promise<DeckSample> {
  return page.evaluate(() => {
    const instrument = (window as unknown as { __ompoDeck?: { instrument?: { snapshot(): DeckSample } } }).__ompoDeck?.instrument;
    if (!instrument) throw new Error("window.__ompoDeck.instrument is not installed");
    return instrument.snapshot();
  });
}

/** The pad mirror's status column — the live projection in words, per slice. */
function mirrorStatuses(page: Page): Promise<Record<string, string>> {
  return page.locator(".omp-deck-mirror button").evaluateAll((rows) => {
    const out: Record<string, string> = {};
    for (const row of rows) {
      const id = row.querySelector(".omp-deck-mirror-id")?.textContent?.trim() ?? "";
      const status = row.querySelector(".omp-deck-mirror-status")?.textContent?.trim() ?? "";
      if (id) out[id] = status;
    }
    return out;
  });
}

/** The run's statuses as the *store* reports them, for "history changed nothing". */
async function storeStatuses(page: Page): Promise<Record<string, string>> {
  const res = await page.request.get(`/api/runs/${RUN_ID}`);
  const body = (await res.json()) as { slices: { id: string; status: string }[] };
  return Object.fromEntries(body.slices.map((slice) => [slice.id, slice.status]));
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function boxOf(page: Page, selector: string): Promise<Box | null> {
  if ((await page.locator(selector).count()) === 0) return null;
  return page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
  });
}

/** `null` boxes are skipped: "absent" is not "overlapping". */
function overlap(a: Box | null, b: Box | null): string | null {
  if (a === null || b === null) return null;
  const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
  return disjoint ? null : `${JSON.stringify(a)} ∩ ${JSON.stringify(b)}`;
}

async function gotoDeck(page: Page): Promise<void> {
  await page.goto("/?surface=deck");
  await page.locator(".omp-deck-canvas").waitFor();
  // The temporal window is fetched by the shell after the run is known: wait
  // for the ribbon to exist rather than for a timeout.
  await expect.poll(async () => (await readHook(page)).ribbon, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(700); // the framing flight and the intro fade
}

/** Step back `steps` recorded moments with the deck's own key. */
async function stepBack(page: Page, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) await page.locator(".omp-deck").press(",");
}

test.describe("deck temporal layer", () => {
  // Serial: every scenario reads the run's state and one harness serves the file.
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } });

  let projectDir = "";
  let harness: ChildProcess | null = null;

  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "ompo-deck-d07-"));
    const sliceFile = (run: string, slice: string, name: string, text: string): void => {
      const target = join(projectDir, ".omp", "roadmap", "runs", run, "slices", slice);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, name), text, "utf8");
    };
    const reportJson = (summary: string): string =>
      JSON.stringify({ summary, done: true, filesChanged: [], testsRun: ["bun test"], deferred: [], followUps: [] });

    // A second, older run so the wall has something to switch to.
    createRun(projectDir, parseRoadmap(`## [only] Only slice\nEffort: lo\nAgent: sonic\nVerify: bun test\nbody\n`), OTHER_RUN);
    storeApi.claimSlice(projectDir, OTHER_RUN, "only");
    storeApi.workerFinished(projectDir, OTHER_RUN, "only", "slices/only/report.json", { exit: 0, durationMs: 1_000 });
    storeApi.verifyPassed(projectDir, OTHER_RUN, "only", "slices/only/verdict.json");

    createRun(projectDir, parseRoadmap(ROADMAP), RUN_ID);
    storeApi.claimSlice(projectDir, RUN_ID, "alpha");
    storeApi.workerFinished(projectDir, RUN_ID, "alpha", "slices/alpha/report.json", { exit: 0, durationMs: 42_000 });
    storeApi.verifyPassed(projectDir, RUN_ID, "alpha", "slices/alpha/verdict.json");
    storeApi.claimSlice(projectDir, RUN_ID, "beta");
    storeApi.workerFinished(projectDir, RUN_ID, "beta", "slices/beta/report.json", { exit: 1, durationMs: 9_000 });
    storeApi.terminalFail(projectDir, RUN_ID, "beta", "gate bun test failed — 2 tests");
    storeApi.claimSlice(projectDir, RUN_ID, "delta");
    storeApi.workerFinished(projectDir, RUN_ID, "delta", "slices/delta/report.json", { exit: 1, durationMs: 5_000 });
    storeApi.verifyFailed(projectDir, RUN_ID, "delta", "gate red");
    storeApi.retrySlice(projectDir, RUN_ID, "delta");
    storeApi.claimSlice(projectDir, RUN_ID, "delta");
    storeApi.claimSlice(projectDir, RUN_ID, "gamma");
    sliceFile(RUN_ID, "gamma", "worker-1-g0.log", "  [gamma] turn 1…\n  [gamma] tool read: web/src/scene/history.ts\n");
    sliceFile(RUN_ID, "alpha", "report.json", reportJson("alpha done"));
    sliceFile(RUN_ID, "delta", "report.json", reportJson("delta first try"));

    // Space the recorded events 30s apart. The fixture drives transitions in a
    // burst, and a burst would collapse the ribbon to one bucket; the timestamps
    // are the recorded fact the temporal layer projects, so this is fixture
    // setup, not a stub.
    const eventsPath = join(runDir(projectDir, RUN_ID), "events.jsonl");
    const t0 = Date.parse("2026-09-13T10:00:00.000Z");
    const rewritten = readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const event = JSON.parse(line) as { seq: number; at: string };
        event.at = new Date(t0 + event.seq * 30_000).toISOString();
        return JSON.stringify(event);
      })
      .join("\n");
    writeFileSync(eventsPath, `${rewritten}\n`, "utf8");

    const started = await startHarness(projectDir);
    harness = started.proc;
  });

  test.afterAll(() => {
    harness?.kill("SIGTERM");
    harness = null;
    mkdirSync(join("captures", "deck-validation"), { recursive: true });
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  });

  test("live is the default; a historical state is a pure function of its seq", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoDeck(page);

    const live = await readHook(page);
    expect(live.historySeq).toBeNull();
    expect(live.ribbon).toBeGreaterThan(1);
    expect(live.tiles).toBe(2);
    await expect(page.locator(".omp-deck-time")).toHaveAttribute("data-history", "live");
    const liveStatuses = await mirrorStatuses(page);
    expect(liveStatuses).toEqual({ alpha: "done", beta: "failed", delta: "running", gamma: "running" });
    await page.screenshot({ path: SCREENSHOT_LIVE });
    // The ribbon and the wall live at the rail's far edge, so the `rail` preset
    // is where the whole time axis is in frame — the `command` preset looks at
    // the work, which is the point of it (review §6).
    await page.locator(".omp-deck").press("c");
    await page.waitForTimeout(700); // the 450 ms flight plus a frame
    await page.screenshot({ path: SCREENSHOT_RAIL });
    await page.locator(".omp-deck").press("c");
    await page.waitForTimeout(700);

    // Route A: walk back one recorded moment at a time, remembering what each
    // cursor looked like.
    const routeA: { seq: number; digest: string; statuses: Record<string, string> }[] = [];
    await stepBack(page, 1);
    expect((await readHook(page)).historySeq).not.toBeNull();
    await expect(page.locator(".omp-deck-time")).toHaveAttribute("data-history", "past");
    for (let steps = 1; steps <= 6; steps++) {
      const hook = await readHook(page);
      routeA.push({ seq: hook.historySeq!, digest: hook.digest, statuses: await mirrorStatuses(page) });
      if (steps < 6) await stepBack(page, 1);
    }
    // Six distinct moments, each one older than the last, and the earliest of
    // them predates the failure: history really moved.
    const seqs = routeA.map((entry) => entry.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual([...seqs].reverse());
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(routeA[0]!.statuses).not.toEqual(routeA[5]!.statuses);

    // Route B: back to live by key, then *jump* to the same moments through the
    // scrubber. Same seq → same scene, whatever the route.
    await page.locator(".omp-deck").press("l");
    expect((await readHook(page)).historySeq).toBeNull();
    const slider = page.locator(".omp-deck-time-slider");
    const max = Number(await slider.getAttribute("max"));
    expect(max).toBeGreaterThanOrEqual(routeA.length);
    for (let k = 0; k < routeA.length; k++) {
      // The scrubber's positions are the recorded moments in order; route A
      // walked them backwards from the newest, so position `max - 1 - k` is
      // the moment route A saw at step `k`.
      await slider.fill(String(max - 1 - k));
      const hook = await readHook(page);
      expect(hook.historySeq, `position ${max - 1 - k}`).toBe(routeA[k]!.seq);
      expect(hook.digest).toBe(routeA[k]!.digest);
      expect(await mirrorStatuses(page)).toEqual(routeA[k]!.statuses);
    }

    // And the way back: live is the same projection it was before the walk.
    await page.locator(".omp-deck").press("l");
    const back = await readHook(page);
    expect(back.historySeq).toBeNull();
    expect(back.digest).toBe(live.digest);
    expect(await mirrorStatuses(page)).toEqual(liveStatuses);
    await expect(page.locator(".omp-deck-time")).toHaveAttribute("data-history", "live");

    report.determinism = {
      ribbonBuckets: live.ribbon,
      walk: routeA.map((entry) => entry.seq),
      routeA: routeA.length,
      routeB: routeA.length,
    };
    console.log(`deck-d07-determinism ${JSON.stringify(report.determinism)}`);
  });

  test("exploring history issues no request and touches nothing durable", async ({ page }) => {
    test.setTimeout(120_000);
    const requests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) requests.push(`${request.method()} ${url.pathname}`);
    });

    await gotoDeck(page);
    const before = await readHook(page);
    const beforeSample = await readSample(page);
    const beforeStatuses = await storeStatuses(page);

    // A live baseline of the requests the *surface* makes while it is not doing
    // anything historical (the live window's log tail, the shell's polls).
    // History may add nothing to this set: no replay, no query, no event fetch,
    // no control.
    await page.waitForTimeout(2_500);
    const baseline = new Set(requests);
    requests.length = 0;
    await stepBack(page, 8);
    await page.locator(".omp-deck-time-slider").fill("3");
    await page.locator(".omp-deck-time-slider").fill("7");
    await page.locator(".omp-deck").press(".");
    await page.locator(".omp-deck").press(",");
    await page.locator(".omp-deck").press("l");
    await page.waitForTimeout(400);

    const after = await readHook(page);
    const afterSample = await readSample(page);
    const afterStatuses = await storeStatuses(page);

    // The world was reprojected every step (the renderer's own counter), and
    // still the store never saw it.
    const writes = (afterSample.renderer?.sceneWrites ?? 0) - (beforeSample.renderer?.sceneWrites ?? 0);
    expect(writes).toBeGreaterThanOrEqual(6);

    expect(requests.filter((entry) => !baseline.has(entry))).toEqual([]);
    expect(requests.filter((entry) => !entry.startsWith("GET "))).toEqual([]);
    expect(afterStatuses).toEqual(beforeStatuses);
    expect(after.selected).toBe(before.selected);
    expect(after.camera).toEqual(before.camera);
    expect(after.historySeq).toBeNull();
    expect(after.digest).toBe(before.digest);

    report.inert = {
      baselineRequests: [...baseline].sort(),
      during: requests.filter((entry) => !baseline.has(entry)).length,
      sceneWrites: writes,
    };
    console.log(`deck-d07-inert ${JSON.stringify(report.inert)}`);
  });

  test("a bucket click selects what happened then, and the dock inspects it", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoDeck(page);

    // The bucket that recorded the beta failure, found by the same text the
    // operator reads (the strip's title carries the slices it touched).
    const failureBar = page.locator(".omp-deck-ribbon-bar[title*='touched beta']").first();
    await expect(failureBar).toHaveCount(1);
    await failureBar.click();

    const hook = await readHook(page);
    expect(hook.historySeq).not.toBeNull();
    expect(hook.selected).toBe("beta");
    expect(hook.dockOpen).toBe(true);
    expect(hook.dockTab).toBe("Events");
    // The dock is the dashboard's inspector on the *current* record; the scene
    // is the recorded state. Both at once is the product boundary.
    await expect(page.locator(".omp-deck-dock .omp-inspector-panel")).toHaveCount(1);
    await page.screenshot({ path: SCREENSHOT_PAST });

    // One key back to the live projection.
    await page.locator(".omp-deck").press("l");
    expect((await readHook(page)).historySeq).toBeNull();
    expect(await mirrorStatuses(page)).toEqual({
      alpha: "done",
      beta: "failed",
      delta: "running",
      gamma: "running",
    });
  });

  test("playback lands on recorded states only and stops at the last one", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoDeck(page);

    // The recorded moments, walked the way the operator would: step back until
    // the cursor stops moving.
    const recorded: number[] = [];
    for (let i = 0; i < 200; i++) {
      await page.locator(".omp-deck").press(",");
      const seq = (await readHook(page)).historySeq;
      if (seq === null || seq === recorded[recorded.length - 1]) break;
      recorded.push(seq);
    }
    expect(recorded.length).toBeGreaterThan(5);
    await page.locator(".omp-deck").press("l");
    expect((await readHook(page)).historySeq).toBeNull();

    // Collect the cursor while playback runs, then press the deck's own key.
    await page.evaluate(() => {
      const state = window as unknown as { __d07Playback?: { seen: (number | null)[]; timer: number } };
      const hook = (window as unknown as { __ompoDeck?: { historySeq: number | null } }).__ompoDeck;
      state.__d07Playback = { seen: [], timer: window.setInterval(() => state.__d07Playback!.seen.push(hook?.historySeq ?? null), 20) };
    });
    await page.locator(".omp-deck").press("p");
    await expect.poll(async () => (await readHook(page)).playing, { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await readHook(page)).playing, { timeout: 30_000 }).toBe(false);
    const collected = await page.evaluate(() => {
      const state = window as unknown as { __d07Playback?: { seen: (number | null)[]; timer: number } };
      if (state.__d07Playback) window.clearInterval(state.__d07Playback.timer);
      return state.__d07Playback?.seen ?? [];
    });

    const seen = collected.filter((value): value is number => typeof value === "number");
    expect(seen.length).toBeGreaterThan(0);
    // Playback advances oldest-first and ends on the newest recorded moment.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen[seen.length - 1]).toBe(recorded[0]);
    // Every state it passed through is one the log recorded — no interpolated,
    // synthesized or repeated cursor — and it visited all of them, in order.
    const distinct = [...new Set(seen)];
    expect(distinct).toEqual([...recorded].reverse());

    // Playback ends on the run's present states (the newest recorded moment is
    // the newest event), with the cursor still historical.
    expect(await mirrorStatuses(page)).toEqual({
      alpha: "done",
      beta: "failed",
      delta: "running",
      gamma: "running",
    });
    // And live is one key away, with no animation implied on the way back.
    expect((await readHook(page)).tweens).toBe(0);
    await page.locator(".omp-deck").press("l");
    expect((await readHook(page)).historySeq).toBeNull();
    report.playback = { recorded: recorded.length, samples: seen.length, distinct: distinct.length };
    console.log(`deck-d07-playback ${JSON.stringify(report.playback)}`);
  });

  test("the wall lists every run and switches the surface without a reload", async ({ page }) => {
    test.setTimeout(120_000);
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") posts.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });

    await gotoDeck(page);
    await page.locator(".omp-deck-time-wall").click();
    const rows = page.locator(".omp-deck-wall-row");
    await expect(rows).toHaveCount(2);
    await expect(page.locator('.omp-deck-wall-row[aria-current="true"]')).toContainText(RUN_ID);
    await expect(page.locator(".omp-deck-wall-rows")).toContainText("1/1 done");

    await page.locator(".omp-deck-wall-row").filter({ hasText: OTHER_RUN }).click();
    await expect(page.locator(".omp-deck-metric").filter({ hasText: `run ${OTHER_RUN}` })).toHaveCount(1);
    await expect.poll(async () => (await readHook(page)).digest).not.toBe("");
    const hook = await readHook(page);
    expect(hook.mounted).toBe(1); // the deck was not remounted: no page reload
    expect(posts).toEqual([]); // switching runs is a read, never a write
    // Switching runs closes the wall (the new world is the answer) and returns
    // the new run's temporal layer: live, with its own ribbon.
    await expect(page.locator(".omp-deck-wall")).toHaveCount(0);
    expect(hook.historySeq).toBeNull();
    await expect.poll(async () => (await readHook(page)).ribbon, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.locator(".omp-deck-time-wall").click();
    await expect(page.locator('.omp-deck-wall-row[aria-current="true"]')).toContainText(OTHER_RUN);
    await page.screenshot({ path: SCREENSHOT_WALL });

    report.wall = { rows: 2, mounted: hook.mounted, writes: posts.length };
    console.log(`deck-d07-wall ${JSON.stringify(report.wall)}`);
  });

  test("the temporal band covers nothing and nothing covers it", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoDeck(page);

    const boxes = {
      time: await boxOf(page, ".omp-deck-time"),
      hud: await boxOf(page, ".omp-deck-hud"),
      station: await boxOf(page, ".omp-deck-station"),
      lanes: await boxOf(page, ".omp-deck-lanes"),
      live: await boxOf(page, ".omp-deck-live"),
    };
    for (const [name, box] of Object.entries(boxes)) expect(box, `${name} is on screen`).not.toBeNull();
    expect(overlap(boxes.time, boxes.hud)).toBeNull();
    expect(overlap(boxes.time, boxes.station)).toBeNull();
    expect(overlap(boxes.time, boxes.lanes)).toBeNull();
    expect(overlap(boxes.time, boxes.live)).toBeNull();
    expect(overlap(boxes.station, boxes.hud)).toBeNull();
    expect(overlap(boxes.lanes, boxes.hud)).toBeNull();

    // And at a historical cursor the paused-window note holds the same place
    // the live window did, still clear of the band above it.
    await stepBack(page, 1);
    const past = await boxOf(page, ".omp-deck-live-note");
    const time = await boxOf(page, ".omp-deck-time");
    expect(past).not.toBeNull();
    expect(overlap(time, past)).toBeNull();
    report.layout = { time: boxes.time, station: boxes.station, lanes: boxes.lanes, note: past };
    console.log(`deck-d07-layout ${JSON.stringify(report.layout)}`);
  });

  test("the selected slice's recorded attempts are on the line", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoDeck(page);

    const row = page.locator(".omp-deck-mirror button").filter({ hasText: "delta" }).first();
    await row.focus();
    await row.press("Enter");
    await expect(page.locator(".omp-deck-line")).toContainText("delta");

    const attempts = page.locator(".omp-deck-line-attempts span");
    await expect(attempts).toHaveCount(2);
    await expect(attempts.nth(0)).toContainText("#1");
    await expect(attempts.nth(1)).toContainText("#2");
    await expect(attempts.nth(1)).toHaveAttribute("data-open", "true");
    const chips = await attempts.allTextContents();
    report.attempts = { chips };
    console.log(`deck-d07-attempts ${JSON.stringify({ chips })}`);

    // The point of this slice is that temporal work did not cost the live path:
    // a windowed sample of the surface while the temporal layer renders.
    await readSample(page); // start a fresh window
    await page.waitForTimeout(1500);
    const sample = await readSample(page);
    report.idleSample = {
      frames: sample.frames,
      commits: sample.commits,
      mutations: sample.mutations,
      renderer: sample.renderer
        ? {
            drawCalls: sample.renderer.drawCalls,
            objects: sample.renderer.objects,
            ribbon: sample.renderer.ribbon,
            tiles: sample.renderer.tiles,
            vertices: sample.renderer.vertices,
            pixels: sample.renderer.pixels,
          }
        : null,
    };
    console.log(`deck-d07-sample ${JSON.stringify(report.idleSample)}`);
    expect(sample.renderer?.ribbon ?? 0).toBeGreaterThan(0);
    expect(sample.renderer?.tiles ?? 0).toBe(2);
  });
});
