import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spec owns its own server: every scenario has to mutate the run *while*
// the page is open, which the shared `webServer` fixture cannot do. The server
// runs in a bun child process (the same harness `d03` uses) because
// `src/server.ts` imports `../package.json`, and the run itself is driven
// in-process through `storeApi` — the same store the loop writes.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { parseRoadmap } from "../../src/parse.ts";
import { createRun, storeApi } from "../../src/store.ts";

/**
 * Transition comprehension (roadmap slice `d05`): four scripted transition
 * bursts, measured on the real surface, in the real store, at the real poll
 * cadence.
 *
 * The acceptance question this file answers is not "does it look good" but
 * "can the operator tell what changed" — so every scenario records both halves:
 * the deck's own delta record (what it saw change, for which worker, to what)
 * and the numbers the change cost (frames, long tasks, DOM mutations, scene
 * writes, animated entities, event→visible latency).
 *
 * The four scenarios are the roadmap's, in its order:
 *
 *   A. one worker transitions (Work → Verify)
 *   B. three workers transition in one burst (Work → Verify, Work → Blocked,
 *      Verify → Complete) — the case that decides whether transitions are
 *      independent or serialised
 *   C. an alert arrives while a different worker is focused
 *   D. the focused worker completes (pinned, then released)
 *
 * `captures/deck-validation/d05-transitions.json` holds every number.
 */

const PORT = 4481;
const RUN_ID = "d05-transitions";
const ARTIFACT = join("captures", "deck-validation", "d05-transitions.json");
const SCREENSHOT = join("captures", "deck-d05-transitions.png");
const SCREENSHOT_REDUCED = join("captures", "deck-d05-transitions-reduced.png");

/** The failure the alert scenarios raise, in the store's own words. */
const FAIL_REASON = "gate bun test failed — 2 tests";
const BLOCK_REASON = "port 5432 refused — the environment is not up";

const ROADMAP = `# Deck d05 transitions fixture

## [alpha] Alpha — one worker, one transition
Effort: lo
Verify: bun test
Scenario A: running → verifying.

## [beta] Beta — the environment blocks it
Effort: lo
Verify: bun test
Scenario B: running → blocked-env.

## [gamma] Gamma — the one that completes
Effort: lo
Verify: bun test
Scenario B: verifying → done.

## [zeta] Zeta — the second Work → Verify in the burst
Effort: lo
Verify: bun test
Scenario B: running → verifying.

## [delta] Delta — the worker under focus
Effort: lo
Verify: bun test
Scenario C: an alert about another slice while this one is focused.

## [epsilon] Epsilon — the focused worker that completes
Effort: lo
Verify: bun test
Scenario D: the focus policy when the focused worker finishes.

## [eta] Eta — never claimed
Effort: lo
Verify: bun test
Keeps a pending slice in the roadmap.
`;

interface HarnessInfo {
  projectDir: string;
  url: string;
  port: number;
  assetMode: string;
}

async function startHarness(projectDir: string): Promise<{ proc: ChildProcess; info: HarnessInfo }> {
  const proc = spawn("bun", [join("tests", "e2e", "deck-workflow-harness.ts"), "--project-dir", projectDir, "--port", String(PORT)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 125);
    await promise;
  }
  throw new Error(`harness never answered /api/health at ${info.url}`);
}

interface HookView {
  focused: string | null;
  pinned: string | null;
  liveCount: number;
  digest: string;
  /** The deltas of the last applied model: what the deck saw change, in one batch. */
  deltas: { kind: string; id: string | null; from?: string; to?: string }[];
  tweens: number;
  animatedEntities: number;
  beacons: number;
  alerts: number;
  alertsOverflow: number;
  instances: number;
  stations: number;
  stationMarks: number;
  markers: number;
  objects: number;
  drawCalls: number;
  vertices: number;
  camera: unknown;
  motion: string;
  positions: { id: string; x: number; z: number }[];
}

async function readHook(page: Page): Promise<HookView> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __ompoDeck?: HookView }).__ompoDeck;
    if (!hook) throw new Error("window.__ompoDeck is not installed");
    return hook;
  });
}

interface WindowView {
  frames: number;
  commits: number;
  mutations: number;
  longTasks: { count: number; worstMs: number };
  latencyMs: { p50: number; p95: number; worst: number; samples: number };
  latencyStages: unknown;
  renderer: {
    drawCalls: number;
    objects: number;
    instances: number;
    stations: number;
    stationMarks: number;
    markers: number;
    beacons: number;
    tweens: number;
    animatedEntities: number;
    sceneWrites: number;
    geometries: number;
    vertices: number;
  } | null;
  frameMs: { p50: number; p95: number; worst: number };
}

/** One windowed instrument sample; `snapshot` consumes the window. */
async function readSample(page: Page): Promise<WindowView> {
  return page.evaluate(() => {
    const instrument = (window as unknown as { __ompoDeck?: { instrument?: { snapshot(): WindowView } } }).__ompoDeck?.instrument;
    if (!instrument) throw new Error("window.__ompoDeck.instrument is not installed");
    return instrument.snapshot();
  });
}

/** Cue and beacon peaks at rAF cadence, for the window the transition lands in. */
interface CuePeaks {
  maxTweens: number;
  maxAnimated: number;
  peakBeacons: number;
}

async function watchCues(page: Page, windowMs: number): Promise<CuePeaks> {
  return page.evaluate(async (ms) => {
    const hook = (window as unknown as { __ompoDeck?: { tweens?: number; animatedEntities?: number; beacons?: number } }).__ompoDeck;
    let maxTweens = 0;
    let maxAnimated = 0;
    let peakBeacons = 0;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      maxTweens = Math.max(maxTweens, hook?.tweens ?? 0);
      maxAnimated = Math.max(maxAnimated, hook?.animatedEntities ?? 0);
      peakBeacons = Math.max(peakBeacons, hook?.beacons ?? 0);
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => resolve());
      await promise;
    }
    return { maxTweens, maxAnimated, peakBeacons };
  }, windowMs);
}

async function readLanes(page: Page): Promise<{ id: string; status: string; stage: string; focused: boolean }[]> {
  return page.$$eval(".omp-deck-lane", (rows) =>
    rows.map((row) => {
      const element = row as HTMLElement;
      return {
        id: element.querySelector(".omp-deck-lane-id")?.textContent ?? "",
        status: element.querySelector(".omp-deck-lane-status")?.textContent ?? "",
        stage: element.querySelector(".omp-deck-lane-stage")?.textContent ?? "",
        focused: element.dataset.focused === "true",
      };
    }),
  );
}

async function readAlerts(page: Page): Promise<{ id: string; severity: string; kind: string; message: string }[]> {
  return page.$$eval(".omp-deck-alert", (rows) =>
    rows.map((row) => {
      const element = row as HTMLElement;
      return {
        id: element.dataset.sliceId ?? "",
        severity: element.dataset.severity ?? "",
        kind: element.dataset.kind ?? "",
        message: element.querySelector(".omp-deck-alert-message")?.textContent ?? "",
      };
    }),
  );
}

async function readMirrorStatus(page: Page, id: string): Promise<string> {
  return page.$$eval(
    ".omp-deck-mirror button",
    (rows, sliceId) => {
      const row = rows.find((candidate) => candidate.querySelector(".omp-deck-mirror-id")?.textContent === sliceId);
      return row?.querySelector(".omp-deck-mirror-status")?.textContent ?? "";
    },
    id,
  );
}

const positionKey = (hook: HookView): string => hook.positions.map((entry) => `${entry.id}@${entry.x},${entry.z}`).join("|");

async function selectViaMirror(page: Page, id: string): Promise<void> {
  const row = page.locator(".omp-deck-mirror button").filter({ hasText: id }).first();
  await row.focus();
  await row.press("Enter");
}

/** Wait for a delta batch that contains the expected change for a worker. */
async function awaitDelta(
  page: Page,
  id: string,
  to: string,
): Promise<{ kind: string; id: string | null; from?: string; to?: string }[]> {
  await expect
    .poll(
      async () => {
        const deltas = (await readHook(page)).deltas;
        return deltas.some((delta) => delta.kind === "status" && delta.id === id && delta.to === to);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return (await readHook(page)).deltas;
}

test.describe("deck transitions", () => {
  // The spec's own harness, not the shared fixture: this run is driven, and the
  // deck must be pointed at the same server the store writes to.
  test.use({ baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } });

  let projectDir = "";
  let harness: ChildProcess | null = null;

  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "ompo-deck-d05-"));
    createRun(projectDir, parseRoadmap(ROADMAP), RUN_ID);
    const started = await startHarness(projectDir);
    harness = started.proc;
  });

  test.afterAll(() => {
    harness?.kill("SIGTERM");
    harness = null;
  });

  test("four transition bursts, measured on the real surface", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const report: Record<string, unknown> = { runId: RUN_ID, scenarios: {} as Record<string, unknown> };
    const scenarios = report.scenarios as Record<string, unknown>;

    // Setup: five live workers, one of them already verifying, one pending
    // control target. Every scenario below moves this run for real.
    storeApi.claimSlice(projectDir, RUN_ID, "alpha");
    storeApi.claimSlice(projectDir, RUN_ID, "beta");
    storeApi.claimSlice(projectDir, RUN_ID, "gamma");
    storeApi.workerFinished(projectDir, RUN_ID, "gamma", "slices/gamma/report.json");
    storeApi.claimSlice(projectDir, RUN_ID, "zeta");
    storeApi.claimSlice(projectDir, RUN_ID, "delta");
    storeApi.claimSlice(projectDir, RUN_ID, "epsilon");

    await page.goto("/?surface=deck");
    await page.locator(".omp-deck-canvas").waitFor();
    await expect.poll(async () => (await readHook(page)).liveCount, { timeout: 20_000 }).toBe(6);
    await page.waitForTimeout(900);
    await readSample(page); // start from a clean window

    // ---- A: one worker transitions (Work → Verify) -------------------------
    {
      const baseline = await readSample(page); // resets the window
      const before = await readHook(page);
      const watching = watchCues(page, 4000);
      storeApi.workerFinished(projectDir, RUN_ID, "alpha", "slices/alpha/report.json");
      const deltas = await awaitDelta(page, "alpha", "verifying");
      const peaks = await watching;
      const after = await readHook(page);
      const sample = await readSample(page);
      const lanes = await readLanes(page);
      const alphaLane = lanes.find((lane) => lane.id === "alpha") ?? null;

      // The transition is *this one*, reported by the deck itself.
      expect(deltas).toEqual([{ kind: "status", id: "alpha", from: "running", to: "verifying" }]);
      expect(alphaLane?.status).toBe("verifying");
      // The station keeps its identity: same pad coordinates, same pool
      // membership, same geometry. The column grew a mark — that is the state
      // change, visible without the cue.
      expect(positionKey(after)).toBe(positionKey(before));
      expect(after.stations).toBe(before.stations);
      expect(after.markers).toBe(before.markers);
      expect(after.stationMarks).toBe(before.stationMarks + 1);
      expect(sample.renderer?.geometries).toBe(baseline.renderer?.geometries);
      // The change was visible while it happened, and nothing is left queued.
      expect(peaks.maxTweens).toBeGreaterThan(0);
      expect(peaks.maxAnimated).toBeGreaterThanOrEqual(1);
      expect(after.tweens).toBe(0);

      scenarios.A_one_worker = {
        deltas,
        peaks,
        before: {
          instances: before.instances,
          objects: before.objects,
          stationMarks: before.stationMarks,
          geometries: baseline.renderer?.geometries ?? null,
          digest: before.digest,
        },
        after: {
          instances: after.instances,
          objects: after.objects,
          stationMarks: after.stationMarks,
          geometries: sample.renderer?.geometries ?? null,
          digest: after.digest,
        },
        lane: alphaLane,
        window: sample,
        padMoved: positionKey(after) !== positionKey(before),
      };
    }

    // ---- B: three workers transition in one burst --------------------------
    {
      const before = await readHook(page);
      await readSample(page);
      const watching = watchCues(page, 6000);
      storeApi.workerFinished(projectDir, RUN_ID, "zeta", "slices/zeta/report.json"); // Work → Verify
      storeApi.blockEnv(projectDir, RUN_ID, "beta", "slices/beta/verdict.json", BLOCK_REASON); // Work → Blocked
      storeApi.verifyPassed(projectDir, RUN_ID, "gamma", "slices/gamma/verdict.json"); // Verify → Complete
      const deltas = await awaitDelta(page, "gamma", "done");
      // The three changes must arrive as *one* batch: a deck that saw them one
      // at a time produced three applications, and the deltas recorded here are
      // only the last one's.
      const batch = (await readHook(page)).deltas;
      const peaks = await watching;
      const after = await readHook(page);
      const sample = await readSample(page);
      const lanes = await readLanes(page);
      const alerts = await readAlerts(page);
      const gammaMirror = await readMirrorStatus(page, "gamma");

      const statusDeltas = batch
        .filter((delta) => delta.kind === "status")
        .map((delta) => `${delta.id}:${delta.from}>${delta.to}`)
        .sort();
      // All three transitions in *one* delta batch: the deck saw them as one
      // change of the world, and each is reported separately (a serialised
      // animation would have produced three applications, three of these lists).
      expect(statusDeltas).toEqual(["beta:running>blocked-env", "gamma:verifying>done", "zeta:running>verifying"]);
      // The blocked worker also raised its alert in the same batch.
      expect(batch.some((delta) => delta.kind === "alert" && delta.id === "beta")).toBe(true);
      expect(deltas.length).toBeGreaterThan(0);
      // Every worker is identifiable after the burst: two still live, one done.
      expect(lanes.find((lane) => lane.id === "zeta")?.status).toBe("verifying");
      expect(lanes.some((lane) => lane.id === "beta")).toBe(false); // blocked is not live
      expect(lanes.some((lane) => lane.id === "gamma")).toBe(false); // done is not live
      expect(gammaMirror).toBe("done");
      // Beta's alert is in the stack, with the environment's own reason.
      const betaAlert = alerts.find((alert) => alert.id === "beta") ?? null;
      expect(betaAlert?.kind).toBe("blocked-env");
      expect(betaAlert?.severity).toBe("high");
      expect(betaAlert?.message).toContain("5432");
      expect(positionKey(after)).toBe(positionKey(before));
      expect(peaks.maxAnimated).toBeGreaterThanOrEqual(3); // three workers, not one queue
      expect(after.tweens).toBe(0);

      scenarios.B_simultaneous = {
        deltas: batch,
        peaks,
        lanesAfter: lanes,
        alerts,
        gammaMirror,
        before: { instances: before.instances, objects: before.objects, stationMarks: before.stationMarks, markers: before.markers },
        after: { instances: after.instances, objects: after.objects, stationMarks: after.stationMarks, markers: after.markers },
        window: sample,
        padMoved: positionKey(after) !== positionKey(before),
      };
      await page.screenshot({ path: SCREENSHOT });
    }

    // ---- C: an alert while a different worker is focused -------------------
    {
      await selectViaMirror(page, "delta");
      await page.locator(".omp-deck").press("f");
      await expect.poll(async () => (await readHook(page)).focused, { timeout: 10_000 }).toBe("delta");
      await page.waitForTimeout(700); // let the framing land
      const before = await readHook(page);
      await readSample(page);
      const watching = watchCues(page, 6000);
      storeApi.verifyFailed(projectDir, RUN_ID, "alpha", "slices/alpha/verdict.json", FAIL_REASON);
      storeApi.terminalFail(projectDir, RUN_ID, "alpha", FAIL_REASON);
      const deltas = await awaitDelta(page, "alpha", "failed");
      const peaks = await watching;
      const after = await readHook(page);
      const sample = await readSample(page);
      const alerts = await readAlerts(page);

      const alphaAlert = alerts.find((alert) => alert.id === "alpha") ?? null;
      expect(alphaAlert?.severity).toBe("high");
      expect(alphaAlert?.message).toContain("bun test");
      // Focus and camera are untouched by an alert about someone else.
      expect(after.focused).toBe("delta");
      expect(after.pinned).toBe("delta");
      expect(JSON.stringify(after.camera)).toBe(JSON.stringify(before.camera));
      // The beacon is drawn even though the alerted slice is not the focus.
      expect(peaks.peakBeacons).toBeGreaterThanOrEqual(2);
      expect(after.tweens).toBe(0);

      scenarios.C_alert_while_focused = {
        deltas,
        peaks,
        alerts,
        focused: after.focused,
        cameraHeld: JSON.stringify(after.camera) === JSON.stringify(before.camera),
        window: sample,
      };
    }

    // ---- D: the focused worker completes -----------------------------------
    {
      await page.locator(".omp-deck").press("Escape"); // release delta's pin
      await selectViaMirror(page, "epsilon");
      await page.locator(".omp-deck").press("f");
      await expect.poll(async () => (await readHook(page)).focused, { timeout: 10_000 }).toBe("epsilon");
      await page.waitForTimeout(700);
      const pinned = await readHook(page);
      await readSample(page);
      const watching = watchCues(page, 6000);
      storeApi.verifyPassed(projectDir, RUN_ID, "epsilon", "slices/epsilon/verdict.json");
      const pinnedDeltas = await awaitDelta(page, "epsilon", "done");
      const peaks = await watching;
      const stillPinned = await readHook(page);
      const sample = await readSample(page);

      // Policy (pinned): the operator pinned this worker, so the focus stays on
      // its slice — its station leaves the pool because it is no longer live,
      // and the pad shows `done`. The camera does not move.
      expect(stillPinned.focused).toBe("epsilon");
      expect(stillPinned.pinned).toBe("epsilon");
      expect(JSON.stringify(stillPinned.camera)).toBe(JSON.stringify(pinned.camera));
      expect(pinnedDeltas.some((delta) => delta.kind === "status" && delta.id === "epsilon" && delta.to === "done")).toBe(true);

      // Policy (unpinned): releasing the pin hands the focus to the next live
      // worker the shared ranking picks — not to whatever array order happens
      // to be — and the camera follows it because nothing is pinned.
      await page.locator(".omp-deck").press("Escape");
      await expect
        .poll(async () => (await readHook(page)).focused, { timeout: 10_000 })
        .not.toBe("epsilon");
      const handedOver = await readHook(page);
      await page.waitForTimeout(800);
      const settled = await readHook(page);
      expect(handedOver.liveCount).toBeGreaterThan(0);
      expect((await readLanes(page)).some((lane) => lane.focused && lane.id === settled.focused)).toBe(true);

      scenarios.D_focused_completes = {
        pinned: {
          deltas: pinnedDeltas,
          focusedAfter: stillPinned.focused,
          cameraHeld: JSON.stringify(stillPinned.camera) === JSON.stringify(pinned.camera),
          peaks,
          window: sample,
        },
        released: {
          focusedAfter: settled.focused,
          liveCount: settled.liveCount,
          cameraMoved: JSON.stringify(settled.camera) !== JSON.stringify(pinned.camera),
        },
      };
    }

    // ---- E: reduced motion — the same change, with no cue at all ----------
    {
      await page.locator(".omp-deck").press("m");
      await expect.poll(async () => (await readHook(page)).motion, { timeout: 10_000 }).toBe("reduced");
      await page.waitForTimeout(400);
      const before = await readHook(page);
      await readSample(page);
      const watching = watchCues(page, 5000);
      // A live worker fails its gate: status `running → failed` and a new
      // high-severity alert, in one model change.
      storeApi.verifyFailed(projectDir, RUN_ID, "delta", "slices/delta/verdict.json", FAIL_REASON);
      await awaitDelta(page, "delta", "failed");
      const peaks = await watching;
      const after = await readHook(page);
      const sample = await readSample(page);
      const alerts = await readAlerts(page);
      const deltaAlert = alerts.find((alert) => alert.id === "delta") ?? null;

      // The state changed for real (the alert is in the stack, the row left
      // the lane strip) and the scene spent nothing on it.
      expect(deltaAlert?.kind).toBe("failed");
      expect(deltaAlert?.severity).toBe("high");
      expect(deltaAlert?.message).toContain("bun test");
      expect((await readLanes(page)).some((lane) => lane.id === "delta")).toBe(false);
      expect(peaks.maxTweens).toBe(0);
      expect(peaks.maxAnimated).toBe(0);
      expect(after.tweens).toBe(0);
      // The HUD's own counter says the same thing the hook does.
      await page.locator(".omp-deck").press("h");
      await expect(page.locator(".omp-deck-panel")).toContainText("0 cues");
      await page.locator(".omp-deck").press("h");

      scenarios.E_reduced_motion = {
        peaks,
        alerts,
        motion: after.motion,
        beacons: after.beacons,
        before: { alerts: before.alerts, beacons: before.beacons, instances: before.instances },
        after: { alerts: after.alerts, beacons: after.beacons, instances: after.instances },
        window: sample,
      };
      await page.screenshot({ path: SCREENSHOT_REDUCED });
      await page.locator(".omp-deck").press("m"); // restore, for the artifact's honesty
    }

    report.notes = {
      motion: (await readHook(page)).motion,
      pollMs: 900,
      tier: testInfo.project.name,
    };
    mkdirSync(join("captures", "deck-validation"), { recursive: true });
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`deck-d05-transitions ${JSON.stringify({ artifact: ARTIFACT, scenarios: Object.keys(scenarios).length })}`);
  });
});
