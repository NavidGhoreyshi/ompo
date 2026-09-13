import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spec owns its own server: it mutates the run while the page is open (a
// live log, a worker that finishes, an alert that lands), which the shared
// `webServer` fixture cannot do. The server runs in a bun child process (the
// `d03`/`d05` harness) because `src/server.ts` imports `../package.json`, and
// the run is driven in-process through `storeApi` — the same store the loop
// writes.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { parseRoadmap } from "../../src/parse.ts";
import { createRun, storeApi } from "../../src/store.ts";
import type { DeckSample } from "../../web/src/scene/instrument.ts";

/**
 * The inspection dock (roadmap slice `d06`), measured on the real surface.
 *
 * The acceptance question this file answers: *can an operator move from the
 * spatial overview to precise inspection and back without losing spatial
 * context, while the 3D layer stays cheap and the 2D inspection experience
 * stays the dashboard's own?* Every scenario below is one half of that:
 *
 *   1. the dock is the dashboard's `Inspector` — eight tabs, byte-identical
 *      content for the same slice, on the same run;
 *   2. opening it invents no endpoint (asserted from the request log);
 *   3. it narrows the stage and never covers the live window, the HUD or the
 *      lane strip;
 *   4. twenty open/close cycles leave the camera, the selection, the digest and
 *      the GL geometry exactly where they were;
 *   5. select → inspect → scroll → switch tab → close returns to the same deck
 *      without a scene rebuild;
 *   6. live updates while it is open: the dock follows its *subject* live,
 *      ignores other workers, and inspection does not defeat the bounded live
 *      window.
 *
 * `captures/deck-validation/d06-inspection.json` holds every number.
 */

const PORT = 4482;
const RUN_ID = "d06-inspection";
const ARTIFACT = join("captures", "deck-validation", "d06-inspection.json");
const SCREENSHOT_DOCK = join("captures", "deck-d06-dock.png");
const SCREENSHOT_RETURN = join("captures", "deck-d06-return.png");

/** The inspector's tabs, in its order — the dock's `1`…`8`. */
const TABS = ["Output", "Diff", "Verify", "Review", "Prompt", "Events", "Usage", "Log"] as const;

const ROADMAP = `# Deck d06 inspection fixture

## [alpha] Alpha — the slice with artifacts
Effort: lo
Agent: task
Verify: bun test
Scenario 1: every inspector tab has content to compare with the dashboard.

## [beta] Beta — the failure that raises an alert
Effort: lo
Agent: task
Verify: bun test
Scenario 6: an alert lands while the dock inspects another worker.

## [gamma] Gamma — the running worker under inspection
Effort: lo
Agent: task
Verify: bun test
Scenario 6: live updates arrive while the dock is open.

## [delta] Delta — a pending slice
Effort: lo
Agent: sonic
Verify: bun test
Keeps a queued slice in the roadmap.
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
    await Bun.sleep(125);
  }
  throw new Error(`harness never answered /api/health at ${info.url}`);
}

function sliceFile(dir: string, run: string, slice: string, name: string, text: string): void {
  const target = join(dir, ".omp", "roadmap", "runs", run, "slices", slice);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, name), text, "utf8");
}

const reportJson = (summary: string, filesChanged: string[]): string =>
  JSON.stringify({ summary, done: true, filesChanged, testsRun: ["bun test"], deferred: [], followUps: [] });

const verdictJson = (pass: boolean, outputTail: string): string =>
  JSON.stringify({ pass, steps: [{ name: "bun test", exit: pass ? 0 : 1, timedOut: false, outputTail }] });

interface HookView {
  dockOpen: boolean;
  dockTab: string;
  selected: string | null;
  focused: string | null;
  pinned: string | null;
  frozen: string | null;
  digest: string;
  cameraPreset: "command" | "rail";
  mounted: number;
  nodes: number;
  liveCount: number;
  instances: number;
  objects: number;
  frames: number;
  positions: { id: string; x: number; z: number }[];
  camera: Record<string, unknown>;
}

function readHook(page: Page): Promise<HookView> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __ompoDeck?: HookView }).__ompoDeck;
    if (!hook) throw new Error("window.__ompoDeck is not installed");
    return hook;
  });
}

/** One windowed instrument sample; `snapshot` consumes the window. */
function readSample(page: Page): Promise<DeckSample> {
  return page.evaluate(() => {
    const instrument = (window as unknown as { __ompoDeck?: { instrument?: { snapshot(): DeckSample } } }).__ompoDeck?.instrument;
    if (!instrument) throw new Error("window.__ompoDeck.instrument is not installed");
    return instrument.snapshot();
  });
}

const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

async function gotoDeck(page: Page): Promise<void> {
  await page.goto("/?surface=deck");
  await page.locator(".omp-deck-canvas").waitFor();
  await page.waitForTimeout(600); // the first frame, the framing flight, the intro fade
}

async function selectViaMirror(page: Page, id: string): Promise<void> {
  const row = page.locator(".omp-deck-mirror button").filter({ hasText: id }).first();
  await row.focus();
  await row.press("Enter");
  await expect(page.locator(".omp-deck-line")).toContainText(id);
}

/** Open the dock on tab `n` (`1`…`8`) and wait for that panel to be the one up. */
async function openDockTab(page: Page, n: number): Promise<void> {
  await page.locator(".omp-deck").press(String(n));
  await expect(page.locator(".omp-deck-dock")).toHaveCount(1);
  await expect(page.locator(".omp-deck-dock-body")).toHaveAttribute("data-dock-tab", TABS[n - 1]!);
}

async function dockPanelText(page: Page): Promise<string> {
  const panel = page.locator('.omp-deck-dock [role="tabpanel"]:visible');
  await expect(panel).toHaveCount(1);
  return normalise(await panel.innerText());
}

async function dashboardTabText(page: Page, tab: string): Promise<string> {
  await page.locator("#omp-inspector").getByRole("tab", { name: tab, exact: true }).click();
  const panel = page.locator('#omp-inspector [role="tabpanel"]:visible');
  await expect(panel).toHaveCount(1);
  return normalise(await panel.innerText());
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

const disjoint = (a: Box, b: Box): boolean =>
  a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

/**
 * Mutations inside the dock itself, for "did this update repaint it?". Split
 * two ways on purpose: *content* mutations (nodes inserted/removed, text
 * changed) are what the operator sees, while attribute writes are React and
 * Radix bookkeeping (the ControlPanel's hidden form input re-renders with the
 * shell's poll cadence) — reported, not conflated with a repaint.
 */
async function watchDockMutations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dock = document.querySelector(".omp-deck-dock");
    const state = window as unknown as {
      __d06Dock?: { content: number; attributes: number; log: string[]; observer: MutationObserver };
    };
    state.__d06Dock?.observer.disconnect();
    const log: string[] = [];
    const next = { content: 0, attributes: 0, log, observer: null as unknown as MutationObserver };
    next.observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") next.attributes++;
        else next.content++;
        if (log.length < 24) {
          const target = record.target instanceof Element ? record.target : record.target.parentElement;
          const tag = target?.tagName.toLowerCase() ?? "?";
          const cls =
            target && typeof target.className === "string" && target.className.length > 0
              ? `.${target.className.split(/\s+/).slice(0, 2).join(".")}`
              : "";
          log.push(`${record.type}:${tag}${cls}${record.attributeName ? `@${record.attributeName}` : ""}`);
        }
      }
    });
    next.observer.observe(dock!, { subtree: true, childList: true, characterData: true, attributes: true });
    state.__d06Dock = next;
  });
}

function readDockMutations(page: Page): Promise<{ content: number; attributes: number; log: string[] }> {
  return page.evaluate(() => {
    const state = (window as unknown as { __d06Dock?: { content: number; attributes: number; log: string[] } }).__d06Dock;
    return { content: state?.content ?? -1, attributes: state?.attributes ?? -1, log: (state?.log ?? []).slice(0, 24) };
  });
}

test.describe("deck inspection dock", () => {
  // Serial: every scenario builds on the run's state, and one harness serves
  // the whole file.
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } });

  let projectDir = "";
  let harness: ChildProcess | null = null;

  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "ompo-deck-d06-"));
    createRun(projectDir, parseRoadmap(ROADMAP), RUN_ID);

    // alpha: done, with every artifact the inspector renders.
    storeApi.claimSlice(projectDir, RUN_ID, "alpha");
    storeApi.workerFinished(projectDir, RUN_ID, "alpha", "slices/alpha/report.json", {
      exit: 0,
      durationMs: 42_000,
      stats: { turns: 12, tools: 9, tokens: { input: 120_000, output: 8_000, total: 128_000 } },
    });
    storeApi.verifyPassed(projectDir, RUN_ID, "alpha", "slices/alpha/verdict.json");
    sliceFile(projectDir, RUN_ID, "alpha", "report.json", reportJson("alpha shipped the dock seam", ["web/src/scene/DeckInspector.tsx"]));
    sliceFile(projectDir, RUN_ID, "alpha", "verdict.json", verdictJson(true, "12 tests passed"));
    sliceFile(projectDir, RUN_ID, "alpha", "review.json", JSON.stringify({ approved: true, findings: [], notes: "alpha reviewed clean" }));
    sliceFile(projectDir, RUN_ID, "alpha", "prompt-1-g0.md", "# prompt\n\nShip the dock seam.\n");
    sliceFile(projectDir, RUN_ID, "alpha", "worker-1-g0.log", "  [alpha] tool read: web/src/scene/Deck.tsx\n  [alpha] turn 1 done (3 tool results)\n");

    // beta: failed, with a review and a failing verdict.
    storeApi.claimSlice(projectDir, RUN_ID, "beta");
    storeApi.workerFinished(projectDir, RUN_ID, "beta", "slices/beta/report.json", { exit: 1, durationMs: 9_000 });
    storeApi.terminalFail(projectDir, RUN_ID, "beta", "gate bun test failed — 2 tests");
    sliceFile(projectDir, RUN_ID, "beta", "report.json", reportJson("beta did not finish", []));
    sliceFile(projectDir, RUN_ID, "beta", "verdict.json", verdictJson(false, "2 tests failed"));
    sliceFile(projectDir, RUN_ID, "beta", "review.json", JSON.stringify({ approved: false, findings: ["beta finding one", "beta finding two"], notes: "beta notes" }));

    // gamma: running, with a log the scenarios append to.
    storeApi.claimSlice(projectDir, RUN_ID, "gamma");
    sliceFile(projectDir, RUN_ID, "gamma", "worker-1-g0.log", "  [gamma] turn 1…\n  [gamma] tool read: web/src/scene/Deck.tsx\n");

    const started = await startHarness(projectDir);
    harness = started.proc;
  });

  test.afterAll(() => {
    harness?.kill("SIGTERM");
    harness = null;
  });

  test("the dock is the dashboard's inspector: eight tabs, one content", async ({ page }) => {
    test.setTimeout(180_000);
    await gotoDeck(page);
    await selectViaMirror(page, "alpha");

    // 1…8 open the dock on the inspector's tabs, in the inspector's order, and
    // each panel is the real view — not a deck copy.
    const deck: Record<string, string> = {};
    for (let n = 1; n <= TABS.length; n++) {
      await openDockTab(page, n);
      const tab = TABS[n - 1]!;
      const known = ["loading", "loading diff…", "loading events…"];
      await expect
        .poll(async () => {
          const text = await dockPanelText(page);
          return known.some((marker) => text.startsWith(marker));
        }, { timeout: 10_000 })
        .toBe(false);
      deck[tab] = await dockPanelText(page);
      expect(deck[tab]!.length).toBeGreaterThan(0);
    }
    // The dock holds the same widget, not a lookalike.
    await expect(page.locator(".omp-deck-dock .omp-inspector-panel")).toHaveCount(1);
    await expect(page.locator(".omp-deck-dock .omp-tabs")).toHaveCount(1);

    // Same slice, same run, the dashboard's own inspector: the text must match
    // tab for tab (the acceptance criterion this slice is judged on).
    await page.locator(".omp-deck").press("d"); // switch surfaces without a reload
    await page.locator(".omp-board").waitFor();
    await page.locator(".omp-inspector-toggle").click();
    await page.getByRole("option", { name: /alpha/ }).first().click();
    await expect(page.locator("#omp-inspector .omp-inspector-title")).toContainText("alpha");

    const dashboard: Record<string, string> = {};
    for (const tab of TABS) {
      dashboard[tab] = await dashboardTabText(page, tab);
    }
    for (const tab of TABS) {
      expect(dashboard[tab], `the dock's ${tab} tab must be the dashboard's`).toBe(deck[tab]);
    }

    console.log(
      `deck-d06-content ${JSON.stringify(
        Object.fromEntries(TABS.map((tab) => [tab, { chars: deck[tab]!.length, identical: true }])),
      )}`,
    );
  });

  test("opening the dock issues no request outside the existing endpoint set", async ({ page }) => {
    test.setTimeout(120_000);
    const seen = new Set<string>();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) seen.add(`${request.method()} ${url.pathname}`);
    });

    await gotoDeck(page);
    await selectViaMirror(page, "alpha");
    for (let n = 1; n <= TABS.length; n++) {
      await openDockTab(page, n);
    }
    await page.waitForTimeout(1200); // let the tabs' own fetches land

    // The existing surface, verbatim (src/server.ts's route table): the dock
    // must not have invented a path of its own.
    const allowed = /^(GET|POST) \/api\/(health|runs(\/latest)?|plan\/(preview|roadmap))$|^(GET|POST) \/api\/runs\/[^/]+(\/(slices(\/[^/]+(\/(log|diff))?)?|sessions(\/[^/]+\/log)?|agents|events(\/stream)?|stats|query|replay|stream|control|restart-loop|resume))?$/;
    const unexpected = [...seen].filter((entry) => !allowed.test(entry));
    expect(unexpected).toEqual([]);
    // And it really did fetch: the Diff and Log tabs are their own endpoints.
    expect([...seen].some((entry) => entry.includes("/diff"))).toBe(true);
    expect([...seen].some((entry) => entry.includes("/log"))).toBe(true);
    console.log(`deck-d06-endpoints ${JSON.stringify({ requests: [...seen].sort() })}`);
  });

  test("the dock narrows the stage and covers nothing", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoDeck(page);
    await selectViaMirror(page, "gamma");

    const deckClosed = await boxOf(page, ".omp-deck");
    const stageClosed = await boxOf(page, ".omp-deck-stage");
    const canvasClosed = await page.locator("canvas").evaluate((element) => (element as HTMLCanvasElement).width);

    // The dock is on screen before the scene has resized: the stage resize is
    // debounced (`RESIZE_DEBOUNCE_MS`), then costs exactly one `setSize` and
    // one frame. Measured entirely in-page — the key is dispatched into the
    // real handler, so no round-trip is counted — from the keydown to the dock
    // being inserted, and from the keydown to the canvas backing store
    // changing size.
    const probe = await page.evaluate(
      () =>
        new Promise<{ dockAt: number; canvasAt: number }>((resolve) => {
          const section = document.querySelector(".omp-deck") as HTMLElement;
          const canvas = document.querySelector("canvas") as HTMLCanvasElement;
          const before = canvas.width;
          const started = performance.now();
          let dockAt = -1;
          const observer = new MutationObserver(() => {
            if (dockAt < 0 && document.querySelector(".omp-deck-dock")) dockAt = performance.now() - started;
          });
          observer.observe(section, { childList: true, subtree: true });
          const check = (): void => {
            if (canvas.width !== before) {
              observer.disconnect();
              resolve({ dockAt, canvasAt: performance.now() - started });
            } else if (performance.now() - started > 5_000) {
              observer.disconnect();
              resolve({ dockAt, canvasAt: -1 });
            } else {
              requestAnimationFrame(check);
            }
          };
          section.focus();
          section.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }));
          requestAnimationFrame(check);
        }),
    );
    await expect(page.locator(".omp-deck-dock-body")).toHaveAttribute("data-dock-tab", "Output");
    await expect.poll(async () => (await boxOf(page, ".omp-deck-stage"))?.w ?? 0, { timeout: 5_000 }).toBeLessThan(stageClosed!.w);
    // The scene is resized, not reallocated: same context, same geometry.
    await expect
      .poll(async () => page.locator("canvas").evaluate((element) => (element as HTMLCanvasElement).width), { timeout: 5_000 })
      .toBeLessThan(canvasClosed);
    expect(probe.dockAt).toBeGreaterThan(0);
    expect(probe.canvasAt).toBeGreaterThan(probe.dockAt);

    const dock = (await boxOf(page, ".omp-deck-dock"))!;
    const stage = (await boxOf(page, ".omp-deck-stage"))!;
    const hud = (await boxOf(page, ".omp-deck-row"))!;
    const live = (await boxOf(page, ".omp-deck-live"))!;
    const lanes = (await boxOf(page, ".omp-deck-lanes"))!;
    const station = (await boxOf(page, ".omp-deck-station"))!;
    const line = (await boxOf(page, ".omp-deck-line"))!;
    const alerts = await boxOf(page, ".omp-deck-alertcol");

    // Right side, flush, below the HUD — and nothing the operator reads is
    // underneath it.
    expect(dock.x + dock.w).toBeGreaterThanOrEqual((deckClosed!.x + deckClosed!.w) - 3);
    expect(dock.y).toBeGreaterThanOrEqual(hud.y + hud.h);
    expect(dock.x).toBeGreaterThanOrEqual(stage.x + stage.w - 2);
    expect(disjoint(dock, hud), "dock ∩ HUD").toBe(true);
    expect(disjoint(dock, live), "dock ∩ live window").toBe(true);
    expect(disjoint(dock, lanes), "dock ∩ lane strip").toBe(true);
    expect(disjoint(dock, station), "dock ∩ station line").toBe(true);
    expect(disjoint(dock, line), "dock ∩ selected line").toBe(true);
    expect(disjoint(live, lanes), "live window ∩ lane strip").toBe(true);
    expect(disjoint(live, station), "live window ∩ station line").toBe(true);
    if (alerts) expect(disjoint(live, alerts), "live window ∩ alert column").toBe(true);

    // The dock arrives inside the roadmap's 180 ms bound, and holds still when
    // the operator asked for reduced motion (`M`).
    const dockAnimationMs = (): Promise<number> =>
      page.locator(".omp-deck-dock").evaluate((element) => {
        const value = getComputedStyle(element).animationDuration;
        return value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
      });
    const motionMs = await dockAnimationMs();
    expect(motionMs).toBeGreaterThan(0);
    expect(motionMs).toBeLessThanOrEqual(180);
    await page.locator(".omp-deck").press("m");
    await expect(page.locator(".omp-deck")).toHaveAttribute("data-motion", "reduced");
    const reducedMs = await dockAnimationMs();
    expect(reducedMs).toBeLessThanOrEqual(1);
    await page.locator(".omp-deck").press("m");

    // The HUD panel reports the dock from the same instrument the gate reads:
    // its state, and the intent→painted latencies it has measured.
    await page.locator(".omp-deck").press("h");
    const inspectionRow = page.locator(".omp-deck-panel dd[data-dock-open]");
    await expect(inspectionRow).toHaveAttribute("data-dock-open", "true");
    await expect(inspectionRow).toHaveAttribute("data-dock-tab", "Output");
    await expect(inspectionRow).toContainText("dock open · Output");
    await page.locator(".omp-deck").press("h");

    // Scene cost while the 2D layer is up and nothing is happening: none. The
    // dock is DOM; it asks the renderer for nothing.
    await page.waitForTimeout(700); // let the debounced resize frame land
    const idleBefore = await readSample(page);
    await page.waitForTimeout(1500);
    const idle = await readSample(page);
    const idleWrites = (idle.renderer?.sceneWrites ?? 0) - (idleBefore.renderer?.sceneWrites ?? 0);
    expect(idle.frames).toBe(0);
    expect(idle.mutations).toBeLessThan(10);
    expect(idleWrites).toBe(0);

    await page.screenshot({ path: SCREENSHOT_DOCK });
    console.log(
      `deck-d06-layout ${JSON.stringify({ deck: deckClosed, stageClosed, stage, dock, hud, live, lanes, station, line, alerts, canvasClosed, probe, motionMs, reducedMs, idle: { frames: idle.frames, mutations: idle.mutations, sceneWrites: idleWrites, commits: idle.commits } })}`,
    );
  });

  test("twenty open/close cycles leave the camera, the selection and the geometry alone", async ({ page }) => {
    test.setTimeout(180_000);
    await gotoDeck(page);
    await selectViaMirror(page, "alpha");
    // Let the shell's own post-load arrivals settle (the slice-detail fetch and
    // the first alert set): from here the model is stable, so any scene write
    // inside the loop would be the resize path's doing.
    await page.waitForTimeout(1500);

    const before = await readHook(page);
    const beforeSample = await readSample(page); // fresh window, geometry baseline

    for (let i = 0; i < 20; i++) {
      await openDockTab(page, 3);
      await page.locator(".omp-deck").press("Escape");
      await expect(page.locator(".omp-deck-dock")).toHaveCount(0);
    }
    const after = await readHook(page);
    const window = await readSample(page);

    expect(after.mounted).toBe(before.mounted); // no context was rebuilt
    expect(after.camera).toEqual(before.camera); // the operator chose to inspect, not to fly
    expect(after.selected).toBe(before.selected);
    expect(after.focused).toBe(before.focused);
    expect(after.pinned).toBe(before.pinned);
    expect(after.digest).toBe(before.digest); // the dock never entered the model
    expect(after.positions).toEqual(before.positions);
    // 40 resizes (20 opens + 20 closes) allocate nothing and rewrite nothing:
    // the GL geometry count is the scene's own before and after, and the
    // instance buffers were not touched at all.
    expect(window.renderer?.geometries).toBe(beforeSample.renderer?.geometries);
    const sceneWrites = (window.renderer?.sceneWrites ?? 0) - (beforeSample.renderer?.sceneWrites ?? 0);
    expect(sceneWrites).toBe(0);
    expect(after.dockOpen).toBe(false);
    // The resize work is real but bounded: frames happened, and nothing is
    // left animating.
    expect(window.frames).toBeGreaterThan(0);
    expect(window.frames).toBeLessThan(120);

    console.log(
      `deck-d06-cycles ${JSON.stringify({
        cycles: 20,
        frames: window.frames,
        frameMs: window.frameMs,
        commits: window.commits,
        mutations: window.mutations,
        longTasks: window.longTasks,
        sceneWrites,
        geometries: window.renderer?.geometries ?? null,
        interactions: window.interactions,
      })}`,
    );
  });

  test("select → inspect → scroll → switch tab → close returns to the same deck", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoDeck(page);
    await selectViaMirror(page, "alpha");
    await page.waitForTimeout(500);

    const before = await readHook(page);
    const beforeSample = await readSample(page); // fresh window

    // Open it the way the overlay offers (`d06`): the selected line's Inspect
    // affordance. It exists only while the dock is closed — its job is opening
    // it, not switching tabs.
    await page.locator(".omp-deck-line-inspect").click();
    await expect(page.locator(".omp-deck-dock-body")).toHaveAttribute("data-dock-tab", "Output");
    await expect(page.locator(".omp-deck-line-inspect")).toHaveCount(0);

    // Read like an operator: scroll the dock, then move to another tab.
    await page.locator(".omp-deck-dock-body").evaluate((element) => {
      element.scrollTop = 200;
    });
    await page.locator('.omp-deck-dock [role="tab"]', { hasText: "Verify" }).click();
    await expect(page.locator(".omp-deck-dock-body")).toHaveAttribute("data-dock-tab", "Verify");
    await page.screenshot({ path: SCREENSHOT_RETURN });
    await page.locator(".omp-deck-dock .omp-icon-btn").click(); // the panel's own X

    await expect(page.locator(".omp-deck-dock")).toHaveCount(0);
    // ...and the affordance is back, along with the deck's own keys.
    await expect(page.locator(".omp-deck-line-inspect")).toHaveCount(1);
    const after = await readHook(page);
    const window = await readSample(page);
    const sceneWrites = (window.renderer?.sceneWrites ?? 0) - (beforeSample.renderer?.sceneWrites ?? 0);

    expect(after.camera).toEqual(before.camera);
    expect(after.selected).toBe(before.selected);
    expect(after.focused).toBe(before.focused);
    expect(after.pinned).toBe(before.pinned);
    expect(after.frozen).toBe(before.frozen);
    expect(after.mounted).toBe(before.mounted);
    expect(after.digest).toBe(before.digest);
    expect(after.positions).toEqual(before.positions);
    // No scene rebuild on the way back: the model never changed, so the
    // renderer never rewrote an instance buffer.
    expect(sceneWrites).toBe(0);
    expect(after.dockOpen).toBe(false);
    // The keyboard came back with the deck: the shortcut that closed the panel
    // left focus on a button that no longer exists, and every deck key has to
    // work without a click to fix it.
    await expect(page.locator(".omp-deck")).toBeFocused();
    await page.keyboard.press("c");
    await expect.poll(async () => (await readHook(page)).cameraPreset).toBe("rail");
    await page.keyboard.press("c");
    await expect.poll(async () => (await readHook(page)).cameraPreset).toBe("command");

    console.log(
      `deck-d06-return ${JSON.stringify({
        frames: window.frames,
        frameMs: window.frameMs,
        commits: window.commits,
        mutations: window.mutations,
        sceneWrites,
        interactions: window.interactions,
      })}`,
    );
  });

  test("live updates while inspecting: the dock follows its subject, ignores the rest, and stays bounded", async ({ page }) => {
    test.setTimeout(240_000);
    const scenarios: Record<string, unknown> = {};
    await gotoDeck(page);
    await selectViaMirror(page, "gamma");
    await openDockTab(page, 8); // Log
    await expect(page.locator(".omp-deck-dock .omp-inspector-title")).toContainText("gamma");

    // ---- 1. the inspected worker's log grows: the dock and the window both --
    // follow it live, and both stay inside their caps.
    const logPath = join(projectDir, ".omp", "roadmap", "runs", RUN_ID, "slices", "gamma", "worker-1-g0.log");
    const filler = Array.from({ length: 120 }, (_, i) => `  [gamma] tool read: src/deeply-nested-${i + 1}.ts`).join("\n");
    appendFileSync(logPath, `\n${filler}\n  [gamma] marker-one arrived\n`, "utf8");

    const dockPre = page.locator('.omp-deck-dock [role="tabpanel"]:visible pre.omp-code');
    await expect.poll(async () => normalise(await dockPre.innerText()).includes("marker-one arrived"), { timeout: 15_000 }).toBe(true);
    // The Log tab is a bounded tail (100 lines), however long the transcript
    // grows — inspecting history never turns into an accumulator.
    const dockLines = (await dockPre.innerText()).split("\n").length;
    const liveRows = page.locator(".omp-deck-live .omp-live-row");
    await expect.poll(async () => liveRows.count(), { timeout: 15_000 }).toBeLessThanOrEqual(5);
    const liveRowCount = await liveRows.count();
    const hookAfterLog = await readHook(page);
    // The live window's bounded row count is the d03 contract, and inspecting
    // history in the dock did not touch it.
    expect(liveRowCount).toBeGreaterThan(0);
    expect(hookAfterLog.dockOpen).toBe(true);
    expect(dockLines).toBeLessThanOrEqual(100);
    scenarios.log_growth = { dockLines, liveRows: liveRowCount };

    // ---- 2. another worker becomes active: the deck says so, the dock does --
    // not repaint (its subject did not change).
    const panelBefore = await dockPanelText(page);
    await watchDockMutations(page);
    storeApi.claimSlice(projectDir, RUN_ID, "delta");
    await expect.poll(async () => (await readHook(page)).liveCount, { timeout: 15_000 }).toBe(2);
    await expect(page.locator(".omp-deck-lane")).toHaveCount(2);
    await page.waitForTimeout(1200); // a poll cycle's worth of repaints
    const mutationsOnOtherWorker = await readDockMutations(page);
    const panelAfterClaim = await dockPanelText(page);
    scenarios.other_worker_active = {
      dockMutations: mutationsOnOtherWorker,
      panelUnchanged: panelAfterClaim === panelBefore,
      liveCount: (await readHook(page)).liveCount,
    };
    expect(mutationsOnOtherWorker.content, JSON.stringify(mutationsOnOtherWorker)).toBeLessThanOrEqual(2);
    expect(panelAfterClaim).toBe(panelBefore);

    // ---- 3. an alert lands: stack and beacon, no dock repaint ---------------
    await watchDockMutations(page);
    storeApi.terminalFail(projectDir, RUN_ID, "alpha", "gate bun test failed — 2 tests");
    await expect(page.locator('.omp-deck-alert[data-slice-id="alpha"]')).toHaveCount(1);
    await expect.poll(async () => (await readHook(page)).liveCount, { timeout: 15_000 }).toBe(2);
    await page.waitForTimeout(900);
    const mutationsOnAlert = await readDockMutations(page);
    const alertRow = await page.locator('.omp-deck-alert[data-slice-id="alpha"] .omp-deck-alert-message').innerText();
    // The inspected worker is *not* the alerting one: the alert is a stack row
    // and a beacon, and the dock — whose subject did not change — repaints
    // nothing. (A couple of mutations are tolerated: React may touch an
    // attribute while re-rendering equal values; a content repaint is not.)
    const alertScenario = {
      dockMutations: mutationsOnAlert,
      message: normalise(alertRow),
      stillInspecting: (await readHook(page)).selected,
    };
    expect(alertScenario.stillInspecting).toBe("gamma");
    expect(mutationsOnAlert.content, JSON.stringify(mutationsOnAlert)).toBeLessThanOrEqual(2);
    scenarios.alert = alertScenario;

    // ---- 4. the inspected worker completes: the dock header updates live ----
    await watchDockMutations(page);
    storeApi.workerFinished(projectDir, RUN_ID, "gamma", "slices/gamma/report.json", { exit: 0, durationMs: 5_000 });
    await expect(page.locator(".omp-deck-dock .omp-inspector-status")).toHaveText("verifying", { timeout: 15_000 });
    storeApi.verifyPassed(projectDir, RUN_ID, "gamma", "slices/gamma/verdict.json");
    sliceFile(projectDir, RUN_ID, "gamma", "report.json", reportJson("gamma finished under inspection", ["web/src/scene/DeckInspector.tsx"]));
    sliceFile(projectDir, RUN_ID, "gamma", "verdict.json", verdictJson(true, "gamma gates passed"));
    await expect(page.locator(".omp-deck-dock .omp-inspector-status")).toHaveText("done", { timeout: 15_000 });
    const hookAfterDone = await readHook(page);
    // The selection is the operator's: completing does not move it. The focus
    // is the deck's (`d03`): it falls to the next live worker.
    expect(hookAfterDone.selected).toBe("gamma");
    expect(hookAfterDone.dockOpen).toBe(true);
    expect(await page.locator(".omp-deck-dock .omp-inspector-status").innerText()).toBe("done");
    const mutationsOnCompletion = await readDockMutations(page);
    // The one update that *does* repaint the dock: its own subject changed.
    expect(mutationsOnCompletion.content, JSON.stringify(mutationsOnCompletion)).toBeGreaterThan(0);
    scenarios.inspected_completes = {
      selected: hookAfterDone.selected,
      focused: hookAfterDone.focused,
      dockMutations: mutationsOnCompletion,
      liveCount: hookAfterDone.liveCount,
    };

    // The dock is still the same surface after all of it, and closing it
    // returns to the same spatial state. Let the deck's own camera flight (the
    // focus moved to the next live worker) land first — this is about the dock
    // close, not about mid-flight camera state.
    await page.waitForTimeout(700);
    const cameraBeforeClose = (await readHook(page)).camera;
    await page.locator(".omp-deck").press("Escape");
    await expect(page.locator(".omp-deck-dock")).toHaveCount(0);
    const closed = await readHook(page);
    expect(closed.camera).toEqual(cameraBeforeClose);
    expect(closed.selected).toBe("gamma");
    scenarios.after_close = { camera: closed.camera, selected: closed.selected };

    mkdirSync(join("captures", "deck-validation"), { recursive: true });
    writeFileSync(ARTIFACT, `${JSON.stringify({ runId: RUN_ID, scenarios }, null, 2)}\n`, "utf8");
    console.log(`deck-d06-live ${JSON.stringify({ artifact: ARTIFACT, scenarios: Object.keys(scenarios) })}`);
  });
});
