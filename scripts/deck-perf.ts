#!/usr/bin/env bun
/**
 * Deck frame-budget harness (roadmap slice `d10`).
 *
 * Loads the built dashboard at `?surface=deck` against a fixture run and
 * measures the deck the way the budget names it: per tier, the median/p95
 * frame cost over `--frames` frames while the four kinds of activity the
 * roadmap names are driven — status churn (through the real store API),
 * transcript growth, worker focus switching and camera moves — plus the
 * renderer's own counters (`renderer.info`: draw calls, instances, geometries,
 * textures, programs) and the idle window that must render nothing.
 *
 * "Frame cost" is the number the deck's instrument records around `render()`
 * — the same number the HUD shows and the tier controller (`d10`) reads, and
 * the same one `tests/e2e/deck.e2e.ts` gates. It is a *work* budget: the
 * tier's `maxFps` caps scheduling, and a frame may spend its whole slot.
 *
 * The numbers are checked against `TIER_BUDGETS` — the one table the scene,
 * the controller, the HUD and this harness share. Exit 1 when a tier misses
 * its budget, when the window could not reach `--frames`, or when the deck
 * demoted itself mid-window (the measurement then describes two tiers). The
 * recorded per-tier numbers live in `docs/deck-performance-budget.md`.
 *
 * Usage:
 *   bun scripts/deck-perf.ts                     # the page's own auto tier
 *   bun scripts/deck-perf.ts --tier standard     # pin a tier (repeatable)
 *   bun scripts/deck-perf.ts --json              # machine output (stdout only)
 *   bun scripts/deck-perf.ts --headed            # real WSLg window
 *   bun scripts/deck-perf.ts --frames 60         # a quick pass
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cpus, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { parseRoadmap } from "../src/parse.ts";
import { startDashboardServer } from "../src/server.ts";
import { createRun, runDir, storeApi } from "../src/store.ts";
import { TIER_BUDGETS, type QualityTier } from "../web/src/scene/tier.ts";

const RUN_ID = "deck-perf";
const DEFAULT_PORT = 4490;
const TERMINATE_MS = 5_000;

const MD = `# Deck d10 fixture

## [live-a] Live A — the first running worker
Effort: lo
Agent: task
Verify: bun test
Scenario: a running worker with a growing transcript; the deck's focus target.

## [live-b] Live B — the second running worker
Effort: lo
Agent: task
Verify: bun test
Scenario: the other live worker, so focus switching has a target.

## [gate] Gate — a slice in verify
Effort: lo
Agent: task
Verify: bun test
Scenario: one slice in the verifying state.

## [done-a] Done A — a finished slice
Effort: lo
Agent: sonic
Verify: bun test
Scenario: a terminal state for the board.

## [done-b] Done B — another finished slice
Effort: lo
Agent: sonic
Verify: bun test
Scenario: a second terminal state.

## [fail-a] Fail A — a failed slice
Effort: lo
Agent: sonic
Verify: bun test
Scenario: an alert for the beacon pool.

## [park-a] Park A — awaiting the environment
Effort: lo
Agent: sonic
Verify: bun test
Scenario: the second alert kind.

## [q1] Queue 1 — pending churn target
Effort: lo
Agent: sonic
Verify: bun test
Scenario: one of six slices the driver cycles through claim/verify/retry.

## [q2] Queue 2 — pending churn target
Effort: lo
Agent: sonic
Verify: bun test
Scenario: churn target.

## [q3] Queue 3 — pending churn target
Depends: q1
Effort: lo
Agent: sonic
Verify: bun test
Scenario: churn target with a dependency edge.

## [q4] Queue 4 — pending churn target
Depends: q1
Effort: lo
Agent: sonic
Verify: bun test
Scenario: churn target with a dependency edge.

## [q5] Queue 5 — pending churn target
Depends: q2
Effort: lo
Agent: sonic
Verify: bun test
Scenario: churn target.

## [q6] Queue 6 — pending churn target
Depends: q3, q4
Effort: lo
Agent: sonic
Verify: bun test
Scenario: churn target.
`;

const CHURN_IDS = ["q1", "q2", "q3", "q4", "q5", "q6"];

interface Options {
  tiers: QualityTier[];
  frames: number;
  idleMs: number;
  port: number;
  json: boolean;
  headed: boolean;
  timeoutMs: number;
}

const HELP = `deck-perf — deck frame-budget harness (roadmap d10)

Usage: bun scripts/deck-perf.ts [options]

  --tier T          measure tier T (minimal|standard|high); repeatable;
                    default: the tier the page classifies for itself
  --frames N        frames per measurement window (default 300)
  --idle-ms N       settled window that must render zero frames (default 2000)
  --port N          fixture server port (default ${DEFAULT_PORT})
  --headless        run headless (default)
  --headed          run in a real window; falls back to headless when there
                    is no display
  --json            print the JSON report on stdout (nothing else on stdout)
  --timeout-ms N    per-tier measurement cap (default: frames × 60 ms + 20 s)
  --help            this text
`;

function readNumber(argv: string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = argv[index + 1];
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} expects a positive number, got ${raw ?? "(nothing)"}`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const tiers: QualityTier[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--tier") continue;
    const value = argv[i + 1];
    if (value !== "minimal" && value !== "standard" && value !== "high") {
      throw new Error(`--tier expects minimal, standard or high, got ${value ?? "(nothing)"}`);
    }
    tiers.push(value);
  }
  const frames = readNumber(argv, "--frames", 300);
  return {
    tiers,
    frames,
    idleMs: readNumber(argv, "--idle-ms", 2_000),
    port: readNumber(argv, "--port", DEFAULT_PORT),
    json: argv.includes("--json"),
    headed: argv.includes("--headed"),
    timeoutMs: readNumber(argv, "--timeout-ms", Math.round(frames * 60 + 20_000)),
  };
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The debug hook (`window.__ompoDeck`), reduced to the fields this harness
 * asserts on. Same contract the e2e suite reads; not public API.
 */
interface PerfHook {
  tier: QualityTier;
  tierSource: "auto" | "pinned";
  autoTier: QualityTier | null;
  downgrades: number;
  downgradeMedianMs: number;
  availability: "3d" | "flat";
  flatReason: string | null;
  frames: number;
  drawCalls: number;
  objects: number;
  instances: number;
  stations: number;
  stationMarks: number;
  markers: number;
  beacons: number;
  geometries: number;
  textures: number;
  programs: number;
  nodes: number;
  edges: number;
  liveCount: number;
  stationOverflow: number;
  alerts: number;
}

/** One windowed instrument sample (`instrument.snapshot()`), as JSON. */
interface PerfSample {
  frames: number;
  framesPerSec: number;
  frameMs: { p50: number; p95: number; worst: number; samples: number };
  renderer: {
    drawCalls: number;
    objects: number;
    triangles: number;
    instances: number;
    pixels: number;
    fullScreenLayers: number;
    shadedPixels: number;
    geometries: number;
    textures: number;
    programs: number;
    fps: number;
    tweens: number;
  } | null;
  loop: { frames: number; deferred: number; idleStops: number; hiddenDrops: number; maxFps: number };
  windowMs: number;
  commits: number;
  mutations: number;
  events: { applied: number; perSec: number; markMisses: number };
  domElements: number;
  longTasks: { count: number; worstMs: number };
}

interface TierRun {
  requested: "auto" | QualityTier;
  tier: QualityTier;
  tierSource: "auto" | "pinned";
  frames: number;
  frameMs: { p50: number; p95: number; worst: number };
  budget: { frameBudgetMs: number; frameP95Ms: number; maxDrawCalls: number; maxFps: number };
  renderer: PerfSample["renderer"];
  hook: PerfHook;
  loop: PerfSample["loop"];
  fps: number;
  memoryBefore: { geometries: number; textures: number; programs: number };
  memoryAfter: { geometries: number; textures: number; programs: number };
  idle: { windowMs: number; frames: number; events: number; mutations: number; commits: number };
  downgrade: { to: QualityTier; medianMs: number } | null;
  checks: Check[];
  ok: boolean;
  elapsedMs: number;
}

const round = (x: number): number => Math.round(x * 100) / 100;

function sliceFile(dir: string, slice: string, name: string, text: string): void {
  const target = join(runDir(dir, RUN_ID), "slices", slice);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, name), text, "utf8");
}

function workerLog(lines: number, prefix: string): string {
  return Array.from({ length: lines }, (_, i) => `  [${prefix}] line ${i + 1}`).join("\n") + "\n";
}

/**
 * A run with everything the deck projects: two live workers (one transcript
 * growing during the measurement), a slice in verify, terminal states, both
 * alert kinds, and six pending slices the driver cycles through
 * claim → finish → fail → retry. Built with the same store calls the product
 * uses — this is a real run, not a mocked DTO.
 */
function buildFixture(dir: string): void {
  createRun(dir, parseRoadmap(MD), RUN_ID);
  for (const id of ["live-a", "live-b", "gate"]) storeApi.claimSlice(dir, RUN_ID, id);
  storeApi.workerFinished(dir, RUN_ID, "gate", `slices/gate/report.json`, { exit: 0, durationMs: 900 });
  for (const id of ["done-a", "done-b"]) {
    storeApi.claimSlice(dir, RUN_ID, id);
    storeApi.workerFinished(dir, RUN_ID, id, `slices/${id}/report.json`, { exit: 0, durationMs: 1_200 });
    storeApi.verifyPassed(dir, RUN_ID, id, `slices/${id}/verdict.json`);
  }
  storeApi.claimSlice(dir, RUN_ID, "fail-a");
  storeApi.workerFinished(dir, RUN_ID, "fail-a", "slices/fail-a/report.json", { exit: 1, durationMs: 4_000 });
  storeApi.terminalFail(dir, RUN_ID, "fail-a", "worker exited 1 after the fixture's synthetic failure");
  storeApi.parkSlice(dir, RUN_ID, "park-a", "waiting on the fixture's synthetic environment");
  sliceFile(dir, "live-a", "worker-1-g0.log", workerLog(80, "running"));
  sliceFile(dir, "live-b", "worker-1-g0.log", workerLog(40, "running"));
  for (const id of ["done-a", "done-b"]) {
    sliceFile(dir, id, "report.json", JSON.stringify({ summary: `${id} done`, done: true, filesChanged: [], testsRun: ["bun test"], deferred: [], followUps: [] }));
    sliceFile(dir, id, "verdict.json", JSON.stringify({ pass: true, steps: [{ name: "bun test", exit: 0, timedOut: false, outputTail: "ok" }] }));
  }
}

/** The four activities the budget names, driven against the live surface. */
interface Driver {
  stop(): Promise<void>;
}

async function startDriver(page: Page, dir: string): Promise<Driver> {
  // Camera moves: one deck key per 40 ms slot. Arrow keys pan immediately and
  // request exactly one frame each (`dispatchCamera`), so this is a frame
  // source paced by the loop's own gate — not a busy loop.
  await page.evaluate(() => {
    const deck = document.querySelector(".omp-deck");
    const keys = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"];
    let i = 0;
    const target = window as unknown as { __deckPerfKeys?: number };
    target.__deckPerfKeys = window.setInterval(() => {
      deck?.dispatchEvent(new KeyboardEvent("keydown", { key: keys[i++ % keys.length]!, bubbles: true, cancelable: true }));
    }, 40);
  });

  // Transcript growth: appended through the real files the server tails.
  const logs = ["live-a", "live-b"].map((id) => join(runDir(dir, RUN_ID), "slices", id, "worker-1-g0.log"));
  let line = 0;
  const logTimer = setInterval(() => {
    line++;
    for (const path of logs) appendFileSync(path, `  [running] perf line ${line}\n`, "utf8");
  }, 300);

  // Status churn: claim → finish → fail → retry on a rolling slice, through
  // the store API the product uses. Every step is a real event: SSE → app
  // state → model → cue.
  let step = 0;
  const churnTimer = setInterval(() => {
    const id = CHURN_IDS[step % CHURN_IDS.length]!;
    const phase = Math.floor(step / CHURN_IDS.length) % 4;
    step++;
    try {
      if (phase === 0) storeApi.claimSlice(dir, RUN_ID, id);
      else if (phase === 1) storeApi.workerFinished(dir, RUN_ID, id, `slices/${id}/report.json`, { exit: 0, durationMs: 200 });
      else if (phase === 2) storeApi.verifyFailed(dir, RUN_ID, id, `slices/${id}/verdict.json`, "fixture churn");
      else storeApi.retrySlice(dir, RUN_ID, id, "fixture churn");
    } catch {
      // The slice was not in the phase's expected state (a previous cycle
      // still settling); the next tick moves on.
    }
  }, 260);

  // Worker focus switching: the deck's own `]` key, on the live set.
  const focusTimer = setInterval(() => {
    void page
      .evaluate(() => {
        document.querySelector(".omp-deck")?.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }));
      })
      .catch(() => {});
  }, 900);

  return {
    async stop(): Promise<void> {
      clearInterval(logTimer);
      clearInterval(churnTimer);
      clearInterval(focusTimer);
      await page
        .evaluate(() => {
          const target = window as unknown as { __deckPerfKeys?: number };
          if (target.__deckPerfKeys !== undefined) window.clearInterval(target.__deckPerfKeys);
        })
        .catch(() => {});
    },
  };
}

function readHook(page: Page): Promise<PerfHook> {
  return page.evaluate(() => {
    const pageGlobal = window as unknown as { __ompoDeck?: PerfHook };
    const state = pageGlobal.__ompoDeck;
    if (!state) throw new Error("window.__ompoDeck is not installed");
    return state;
  });
}

function readSample(page: Page): Promise<PerfSample> {
  return page.evaluate(() => {
    const pageGlobal = window as unknown as { __ompoDeck?: { instrument?: { snapshot(): PerfSample; latest(): PerfSample } } };
    const instrument = pageGlobal.__ompoDeck?.instrument;
    if (!instrument) throw new Error("window.__ompoDeck.instrument is not installed");
    return instrument.snapshot();
  });
}

function latestSample(page: Page): Promise<PerfSample> {
  return page.evaluate(() => {
    const pageGlobal = window as unknown as { __ompoDeck?: { instrument?: { latest(): PerfSample } } };
    const instrument = pageGlobal.__ompoDeck?.instrument;
    if (!instrument) throw new Error("window.__ompoDeck.instrument is not installed");
    return instrument.latest();
  });
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Wait until the deck stops drawing: no rendered frame and no arriving event
 * for a sustained window. A status change posted just before the driver
 * stopped takes an SSE + fetch round-trip to land, and that landing starts a
 * cue and a camera flight of its own — M3 measures a *settled* window, so the
 * settle absorbs both.
 */
async function settle(page: Page): Promise<void> {
  let lastFrames = (await readHook(page)).frames;
  let lastEvents = (await latestSample(page)).events.applied;
  let stable = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    const frames = (await readHook(page)).frames;
    const events = (await latestSample(page)).events.applied;
    if (frames === lastFrames && events === lastEvents) stable++;
    else stable = 0;
    lastFrames = frames;
    lastEvents = events;
    if (stable >= 3) return;
  }
}

async function measureTier(
  browser: Browser,
  opts: Options,
  dir: string,
  url: string,
  requested: "auto" | QualityTier,
): Promise<TierRun> {
  const started = Date.now();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const network = { total: 0, stream: 0 };
  page.on("request", (request) => {
    network.total++;
    const parsed = new URL(request.url());
    if (parsed.pathname.endsWith("/stream")) network.stream++;
  });

  try {
    if (requested !== "auto") {
      await page.addInitScript((tier) => {
        window.localStorage.setItem("ompo.deck.prefs", JSON.stringify({ tier, motion: "on", forced: null }));
      }, requested);
    }
    await page.goto(`${url}/?surface=deck`);
    await page.locator(".omp-deck").waitFor({ timeout: 20_000 });
    const loaded = await readHook(page);
    if (loaded.availability === "flat") {
      throw new Error(`the deck is flat (${loaded.flatReason ?? "unknown"}): this device has no WebGL2 to measure`);
    }
    await page.locator(".omp-deck-canvas").waitFor({ timeout: 20_000 });
    // The surface is settled once its temporal window exists and frames have
    // been drawn: the ribbon is a second fetch (`d07`), so an earlier sample
    // would compare two different worlds.
    await page.waitForFunction(
      () => {
        const pageGlobal = window as unknown as { __ompoDeck?: { ribbonBuckets?: number; frames?: number } };
        const state = pageGlobal.__ompoDeck;
        return state !== undefined && (state.ribbonBuckets ?? 0) > 0 && (state.frames ?? 0) > 0;
      },
      null,
      { timeout: 20_000 },
    );
    if ((await page.evaluate(() => document.visibilityState)) !== "visible") {
      throw new Error("the page is not visible: frame-time sampling under a hidden tab is meaningless");
    }

    // Warm-up: first paints compile programs and grow the instance pools.
    await sleep(800);
    await readSample(page); // reset: the window below is the activity only
    const before = await readHook(page);
    const driver = await startDriver(page, dir);
    let frames = 0;
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
      frames = (await latestSample(page)).frames;
      if (frames >= opts.frames) break;
      await sleep(400);
    }
    await driver.stop();
    await settle(page);
    const sample = await readSample(page);
    const hook = await readHook(page);

    // Idle: a settled camera, no state change, no pointer movement. The
    // window's other counters are recorded too: "0 frames" with 0 events is
    // the M3 answer; frames next to arriving events would be a different one.
    await readSample(page);
    await sleep(opts.idleMs);
    const idle = await readSample(page);

    const memoryBefore = { geometries: before.geometries, textures: before.textures, programs: before.programs };
    const memoryAfter = { geometries: hook.geometries, textures: hook.textures, programs: hook.programs };
    const budget = TIER_BUDGETS[hook.tier];
    const checks: Check[] = [];
    const add = (name: string, ok: boolean, detail: string): void => {
      checks.push({ name, ok, detail });
    };

    add("frames", sample.frames >= opts.frames, `${sample.frames} of ${opts.frames} requested (${round(sample.framesPerSec)}/s)`);
    add(
      "tier stable",
      hook.downgrades === 0,
      hook.downgrades === 0
        ? `${hook.tier} (${hook.tierSource})`
        : `the deck demoted itself mid-window (${hook.downgrades}×, last to ${hook.autoTier ?? "?"} at ${hook.downgradeMedianMs} ms/frame) — the window describes two tiers`,
    );
    add("frame p50", sample.frameMs.p50 <= budget.frameBudgetMs, `${round(sample.frameMs.p50)} ms ≤ ${budget.frameBudgetMs} ms`);
    add("frame p95", sample.frameMs.p95 <= budget.frameP95Ms, `${round(sample.frameMs.p95)} ms ≤ ${budget.frameP95Ms} ms`);
    add("draw calls", (sample.renderer?.drawCalls ?? 0) <= budget.maxDrawCalls, `${sample.renderer?.drawCalls ?? 0} ≤ ${budget.maxDrawCalls}`);
    add("no full-screen layers", (sample.renderer?.fullScreenLayers ?? 0) === 0, `${sample.renderer?.fullScreenLayers ?? 0} layers`);
    add("station cap", hook.stations <= budget.maxStations, `${hook.stations} ≤ ${budget.maxStations} (${hook.stationOverflow} over)`);
    add("beacon cap", hook.beacons <= budget.maxBeacons * 2, `${hook.beacons} instances ≤ 2 × ${budget.maxBeacons} rings`);
    add(
      "GPU counters constant",
      memoryBefore.geometries === memoryAfter.geometries &&
        memoryBefore.textures === memoryAfter.textures &&
        memoryBefore.programs === memoryAfter.programs,
      `geometries ${memoryBefore.geometries}→${memoryAfter.geometries}, textures ${memoryBefore.textures}→${memoryAfter.textures}, programs ${memoryBefore.programs}→${memoryAfter.programs}`,
    );
    add("idle frames", idle.frames === 0, `${idle.frames} frames over ${idle.windowMs} ms`);
    add("one stream", network.stream <= 1, `${network.stream} requests to the event stream`);

    const run: TierRun = {
      requested,
      tier: hook.tier,
      tierSource: hook.tierSource,
      frames: sample.frames,
      frameMs: { p50: round(sample.frameMs.p50), p95: round(sample.frameMs.p95), worst: round(sample.frameMs.worst) },
      budget: { frameBudgetMs: budget.frameBudgetMs, frameP95Ms: budget.frameP95Ms, maxDrawCalls: budget.maxDrawCalls, maxFps: budget.maxFps },
      renderer: sample.renderer,
      hook,
      loop: sample.loop,
      fps: sample.renderer?.fps ?? 0,
      memoryBefore,
      memoryAfter,
      idle: {
        windowMs: idle.windowMs,
        frames: idle.frames,
        events: idle.events?.applied ?? 0,
        mutations: idle.mutations,
        commits: idle.commits,
      },
      downgrade: hook.downgrades > 0 && hook.autoTier !== null ? { to: hook.autoTier, medianMs: hook.downgradeMedianMs } : null,
      checks,
      ok: checks.every((check) => check.ok),
      elapsedMs: Date.now() - started,
    };
    return run;
  } finally {
    await context.close().catch(() => {});
  }
}

async function launch(opts: Options): Promise<{ browser: Browser; mode: "headless" | "headed"; headed: string }> {
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!opts.headed) return { browser: await chromium.launch({ headless: true }), mode: "headless", headed: "headless" };
  if (!hasDisplay) return { browser: await chromium.launch({ headless: true }), mode: "headless", headed: "unavailable" };
  try {
    return { browser: await chromium.launch({ headless: false }), mode: "headed", headed: "headed" };
  } catch (err) {
    process.stderr.write(`deck-perf: headed launch failed (${err instanceof Error ? err.message.split("\n")[0] : err}); falling back to headless\n`);
    return { browser: await chromium.launch({ headless: true }), mode: "headless", headed: "unavailable" };
  }
}

function printRun(run: TierRun): void {
  const pad = (s: string, n: number): string => s.padEnd(n);
  const num = (n: number): string => n.toFixed(2).padStart(8);
  const lines: string[] = [];
  lines.push(
    `tier        ${run.tier}${run.requested === "auto" ? " (auto)" : run.tierSource === "pinned" ? " (pinned)" : ""}` +
      `  budget p50 ≤ ${run.budget.frameBudgetMs} ms  p95 ≤ ${run.budget.frameP95Ms} ms  ≤ ${run.budget.maxDrawCalls} calls  ${run.budget.maxFps} fps cap`,
  );
  lines.push(
    `frames      ${run.frames}  cost ms: p50 ${num(run.frameMs.p50)}  p95 ${num(run.frameMs.p95)}  worst ${num(run.frameMs.worst)}  fps ${run.fps}`,
  );
  const r = run.renderer;
  lines.push(
    `renderer    calls ${r?.drawCalls ?? 0}  objects ${r?.objects ?? 0}  instances ${r?.instances ?? 0}  triangles ${r?.triangles ?? 0}  px ${r?.pixels ?? 0}`,
  );
  lines.push(
    `memory      geometries ${run.memoryBefore.geometries}→${run.memoryAfter.geometries}  textures ${run.memoryBefore.textures}→${run.memoryAfter.textures}  programs ${run.memoryBefore.programs}→${run.memoryAfter.programs}`,
  );
  lines.push(
    `hook        nodes ${run.hook.nodes}  edges ${run.hook.edges}  live ${run.hook.liveCount}  stations ${run.hook.stations}  beacons ${run.hook.beacons}`,
  );
  lines.push(`loop        frames ${run.loop.frames}  deferred ${run.loop.deferred}  idle stops ${run.loop.idleStops}  hidden drops ${run.loop.hiddenDrops}`);
  lines.push(`idle        ${run.idle.frames} frames over ${run.idle.windowMs} ms`);
  for (const check of run.checks) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${pad(check.name, 22)} ${check.detail}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    process.stderr.write(
      `deck-perf: no Playwright chromium at ${executable}\n` + `deck-perf: install it with: bunx playwright install chromium\n`,
    );
    process.exit(1);
  }

  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "ompo-deck-perf-"));
  buildFixture(dir);
  const server = startDashboardServer({ projectDir: dir, port: opts.port });
  if (server.assetMode === "missing") {
    server.stop();
    process.stderr.write("deck-perf: the server has no web assets; run `bun run web:build` first\n");
    process.exit(1);
  }

  const { browser, mode, headed } = await launch(opts);
  const browserVersion = browser.version();
  const requested: ("auto" | QualityTier)[] = opts.tiers.length > 0 ? opts.tiers : ["auto"];
  const runs: TierRun[] = [];
  try {
    for (const tier of requested) {
      runs.push(await measureTier(browser, opts, dir, server.url, tier));
    }
  } finally {
    await browser.close().catch(() => {});
    server.stop();
  }

  const report = {
    harness: "deck-perf",
    roadmap: "docs/desktop-3d-roadmap.md#d10",
    at: new Date().toISOString(),
    mode,
    headed,
    browser: { name: "chromium", version: browserVersion, executablePath: executable },
    machine: {
      platform: platform(),
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? "unknown",
      cpus: cpus().length,
      memGB: Math.round((totalmem() / 1e9) * 10) / 10,
      runtime: `bun ${Bun.version}`,
    },
    fixture: { runId: RUN_ID, slices: parseRoadmap(MD).slices.length, live: 2, projectDir: dir },
    params: { frames: opts.frames, idleMs: opts.idleMs, port: opts.port },
    runs,
    ok: runs.every((run) => run.ok),
    elapsedMs: Date.now() - started,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`deck-perf  ${report.at}  ${mode}${headed === "unavailable" ? " (headed unavailable)" : ""}\n`);
    process.stdout.write(
      `machine     ${report.machine.platform}/${report.machine.arch}  ${report.machine.cpus}x ${report.machine.cpuModel}  ${report.machine.memGB} GB  ${report.machine.runtime}\n`,
    );
    process.stdout.write(`fixture     ${RUN_ID}  ${report.fixture.slices} slices  ${report.fixture.live} live workers\n\n`);
    for (const run of runs) {
      printRun(run);
      process.stdout.write("\n");
    }
    process.stdout.write(`result      ${report.ok ? "PASS" : "FAIL"}  (${(report.elapsedMs / 1000).toFixed(1)} s)\n`);
    if (!report.ok) {
      process.stdout.write(`next        per-tier numbers and deviations: docs/deck-performance-budget.md §5\n`);
    }
  }

  process.exit(report.ok ? 0 : 1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`deck-perf: ${message}\n`);
  process.exitCode = 1;
  // Playwright's browser process or the fixture server may hold the loop open;
  // exit anyway after a bounded grace period.
  setTimeout(() => process.exit(1), TERMINATE_MS);
});
