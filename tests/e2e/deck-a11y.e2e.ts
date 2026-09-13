import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spec owns its server (the `d06`–`d08` harness): it holds the run's lock
// and writes store transitions directly, which the shared `webServer` fixture
// cannot do.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { parseRoadmap } from "../../src/parse.ts";
import { appendEvent, createRun, runDir, storeApi } from "../../src/store.ts";
import { INSPECTOR_TABS } from "../../web/src/components/Inspector.tsx";
import type { DeckSample } from "../../web/src/scene/instrument.ts";
import { DECK_KEYS } from "../../web/src/scene/types.ts";

/**
 * Fallback, keyboard and no-WebGL operation (roadmap slice `d09`).
 *
 * The acceptance questions this file answers, each on a real surface:
 *
 *   1. with WebGL2 unavailable, `?surface=deck` is a usable flat workspace —
 *      slices, pads, workers, the live window, alerts, history, the dock and
 *      control — with a one-sentence explanation and no thrown error;
 *   2. keyboard-only operation reaches selection, every dock tab, the freeze,
 *      worker focus, history, control and the surface switch, with no mouse
 *      event anywhere;
 *   3. the `aria-live` mirror follows focus and status and is *not* rewritten
 *      by log lines (asserted with a MutationObserver, not by text equality);
 *   4. every status-bearing element says its state in words/glyphs, not colour;
 *   5. `prefers-reduced-motion` is honoured on mount and `M` can turn motion
 *      back on;
 *   6. a synthetic `webglcontextlost` switches to flat with state preserved
 *      and a working "Retry 3D";
 *   7. `T` includes flat on a machine that has WebGL.
 *
 * `captures/deck-validation/d09-a11y.json` holds the recorded evidence.
 */

const PORT = 4485;
const RUN_ID = "d09-a11y";
const ARTIFACT = join("captures", "deck-validation", "d09-a11y.json");
const FLAT_SHOT = join("captures", "deck-d09-flat.png");
const HELP_SHOT = join("captures", "deck-d09-help.png");

const report: Record<string, unknown> = { runId: RUN_ID, port: PORT };

const ROADMAP = `# Deck d09 fixture

## [alpha] Alpha — the finished slice
Effort: lo
Agent: task
Verify: bun test
Scenario: a terminal state, so the board has more than live rows.

## [beta] Beta — the first running worker
Effort: lo
Agent: task
Verify: bun test
Scenario: one of two live workers, so worker switching has a target.

## [gamma] Gamma — the second running worker
Effort: lo
Agent: task
Verify: bun test
Scenario: the other live worker; its status changes during the mirror spec.

## [delta] Delta — the failed slice
Effort: lo
Agent: sonic
Verify: bun test
Scenario: the alert and the control-bar target.

## [envblock] Env — the blocked-env slice
Effort: lo
Agent: sonic
Verify: bun test
Scenario: a second alert kind.

## [spare] Spare — still pending
Effort: lo
Agent: sonic
Verify: bun test
Scenario: claimable, for the reduced-motion status change.
`;

interface DeckHook {
  availability: "3d" | "flat";
  flatReason: "no-webgl2" | "context-lost" | "create-failed" | "forced" | null;
  contextLost: number;
  motion: "full" | "reduced";
  focused: string | null;
  frozen: string | null;
  selected: string | null;
  dockOpen: boolean;
  dockTab: string;
  liveCount: number;
  logLines: number;
  ribbon: number;
  tier: string;
  mounted: number;
  disposed: number;
}

function readHook(page: Page): Promise<DeckHook> {
  return page.evaluate(() => {
    const pageGlobal = window as unknown as { __ompoDeck?: DeckHook };
    const state = pageGlobal.__ompoDeck;
    if (!state) throw new Error("window.__ompoDeck is not installed");
    return state;
  });
}

/** One windowed instrument sample — counters since the previous call. */
function readSample(page: Page): Promise<DeckSample> {
  return page.evaluate(() => {
    // Installed by Deck.tsx; the shell never defines it.
    const pageGlobal = window as unknown as { __ompoDeck?: { instrument?: { snapshot(): DeckSample } } };
    const instrument = pageGlobal.__ompoDeck?.instrument;
    if (!instrument) throw new Error("window.__ompoDeck.instrument is not installed");
    return instrument.snapshot();
  });
}

function lockFile(projectDir: string): string {
  return `${runDir(projectDir, RUN_ID)}.lock`;
}

function startHarness(projectDir: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["tests/e2e/deck-workflow-harness.ts", "--project-dir", projectDir, "--port", String(PORT)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers<{ url: string }>();
  let output = "";
  const timer = setTimeout(() => ready.reject(new Error(`harness never reported readiness: ${output}`)), 20_000);
  proc.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const line = output.split("\n").find((entry) => entry.startsWith("deck-workflow-harness "));
    if (!line) return;
    clearTimeout(timer);
    ready.resolve(JSON.parse(line.slice("deck-workflow-harness ".length)) as { url: string });
  });
  proc.on("error", (error) => {
    clearTimeout(timer);
    ready.reject(error);
  });
  proc.on("exit", (code) => {
    clearTimeout(timer);
    ready.reject(new Error(`harness exited with code ${code}: ${output}`));
  });
  return ready.promise.then((info) => ({ proc, url: info.url }));
}

/** Wait for the server to answer health, then return the spawned process. */
async function waitForServer(proc: ChildProcess, url: string): Promise<ChildProcess> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return proc;
    } catch {
      // not bound yet
    }
    await Bun.sleep(125);
  }
  throw new Error(`harness never answered /api/health at ${url}`);
}

/** No WebGL2 at all: the probe and the renderer both see `null`. */
async function disableWebgl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
      if (String(args[0]).startsWith("webgl")) return null;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

async function gotoDeck(page: Page): Promise<void> {
  await page.goto("/?surface=deck");
  await page.locator(".omp-deck").waitFor();
  // The temporal window is a second fetch (`d07`): the surface is not settled
  // until its ribbon exists, the same rule as `deck.e2e.ts`'s `gotoDeck`.
  await expect.poll(async () => (await readHook(page)).ribbon, { timeout: 10_000 }).toBeGreaterThan(0);
  const state = await readHook(page);
  if (state.availability === "3d") {
    await page.locator(".omp-deck-canvas").waitFor();
  }
  await expect.poll(async () => (await readHook(page)).liveCount, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
}

/** Select a pad through the mirror's keyboard path: focus + Enter. */
async function selectViaMirror(page: Page, id: string): Promise<void> {
  const row = page.locator(`.omp-deck-mirror button:has(.omp-deck-mirror-id:text-is("${id}"))`);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".omp-deck-line")).toContainText(id);
}

/**
 * Every element matching the selector must carry its state as a word or a
 * glyph — the structural form of "no status by colour alone" (`d09`).
 */
function assertStatusText(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluateAll((elements) => {
    const words = /(pending|running|verifying|done|failed|blocked-env|blocked|skipped|aborted|unknown|live|stalled|quiescent)/;
    const glyphs = /[✓●✕▲○–•]/;
    let seen = 0;
    for (const element of elements) {
      const text = element.textContent ?? "";
      if (text.trim().length === 0) throw new Error(`${element.className} has no text`);
      if (!words.test(text) && !glyphs.test(text)) {
        throw new Error(`${element.className} carries no status word or glyph: ${text.trim().slice(0, 80)}`);
      }
      seen += 1;
    }
    return seen;
  });
}

test.describe("deck fallback and accessibility", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } });

  let projectDir = "";
  let harness: ChildProcess | null = null;

  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "ompo-deck-d09-"));
    const sliceFile = (slice: string, name: string, text: string): void => {
      const target = join(projectDir, ".omp", "roadmap", "runs", RUN_ID, "slices", slice);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, name), text, "utf8");
    };
    const reportJson = (summary: string): string =>
      JSON.stringify({ summary, done: true, filesChanged: [], testsRun: ["bun test"], deferred: [], followUps: [] });

    createRun(projectDir, parseRoadmap(ROADMAP), RUN_ID);

    storeApi.claimSlice(projectDir, RUN_ID, "alpha");
    storeApi.workerFinished(projectDir, RUN_ID, "alpha", "slices/alpha/report.json", { exit: 0, durationMs: 42_000 });
    storeApi.verifyPassed(projectDir, RUN_ID, "alpha", "slices/alpha/verdict.json");
    sliceFile("alpha", "report.json", reportJson("alpha done"));

    storeApi.claimSlice(projectDir, RUN_ID, "beta");
    sliceFile("beta", "worker-1-g0.log", "  [beta] turn 1…\n  [beta] tool read: web/src/scene/Deck.tsx\n");
    storeApi.claimSlice(projectDir, RUN_ID, "gamma");
    sliceFile("gamma", "worker-1-g0.log", "  [gamma] turn 1…\n  [gamma] tool edit: web/src/scene/FlatDeck.tsx\n");

    storeApi.claimSlice(projectDir, RUN_ID, "delta");
    storeApi.workerFinished(projectDir, RUN_ID, "delta", "slices/delta/report.json", { exit: 1, durationMs: 9_000 });
    storeApi.terminalFail(projectDir, RUN_ID, "delta", "gate bun test failed — 2 tests");

    storeApi.parkSlice(projectDir, RUN_ID, "envblock", "worker exited 1 mid-generation");

    // The run reads live for every spec: the lock owner is this process.
    writeFileSync(lockFile(projectDir), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");

    const started = await startHarness(projectDir);
    harness = await waitForServer(started.proc, started.url);
  });

  test.afterAll(() => {
    harness?.kill("SIGTERM");
    harness = null;
    mkdirSync(join("captures", "deck-validation"), { recursive: true });
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  });

  test("keyboard-only operation reaches every deck function, in flat mode with no WebGL2", async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await disableWebgl(page);
    await page.goto("/?surface=deck");
    await page.locator(".omp-deck-flat").waitFor();
    await expect(page.locator(".omp-deck")).toHaveAttribute("data-availability", "flat");
    await expect(page.locator(".omp-deck")).toHaveAttribute("data-flat-reason", "no-webgl2");
    await expect(page.locator(".omp-deck-notice")).toContainText("3D unavailable");
    await expect(page.locator("canvas")).toHaveCount(0);

    // The flat workspace: board, pad list, worker lanes, live window, alerts,
    // history and the station line all present without a scene.
    await expect(page.locator(".omp-deck-flatboard .omp-board-row")).toHaveCount(6);
    await expect(page.locator(".omp-deck-pads .omp-deck-padrow")).toHaveCount(6);
    await expect(page.locator(".omp-deck-flatworkers .omp-lane")).toHaveCount(2);
    await expect(page.locator(".omp-deck-live .omp-livefeed")).toBeVisible();
    await expect(page.locator(".omp-deck-alerts")).toHaveCount(1);
    await expect(page.locator(".omp-deck-time")).toBeVisible();

    // --- keyboard walkthrough: no mouse event below this line -----------------
    // The pad mirror is one tab stop with roving focus (`d09`): ArrowDown moves
    // the stop and the focus together, and the row under it is Enter-activatable.
    const mirrorButtons = page.locator(".omp-deck-mirror button");
    await mirrorButtons.first().focus();
    await expect.poll(async () => mirrorButtons.first().getAttribute("tabindex")).toBe("0");
    await page.keyboard.press("ArrowDown");
    const activeLabel = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
    expect(activeLabel).toBe(await mirrorButtons.nth(1).getAttribute("aria-label"));
    await expect.poll(async () => mirrorButtons.nth(1).getAttribute("tabindex")).toBe("0");
    await expect.poll(async () => mirrorButtons.first().getAttribute("tabindex")).toBe("-1");

    await selectViaMirror(page, "beta");
    expect((await readHook(page)).selected).toBe("beta");

    // All eight dock tabs, by their position keys.
    const tabs: string[] = [];
    for (const [index, tab] of INSPECTOR_TABS.entries()) {
      await page.locator(".omp-deck").press(String(index + 1));
      await expect(page.locator(".omp-deck-dock")).toBeVisible();
      await expect.poll(async () => (await readHook(page)).dockTab).toBe(tab.id);
      tabs.push(tab.id);
    }
    await page.locator(".omp-deck").press("Escape");
    await expect(page.locator(".omp-deck-dock")).toHaveCount(0);

    // Freeze / resume the live window.
    const focused = (await readHook(page)).focused;
    expect(focused).not.toBeNull();
    await page.locator(".omp-deck").press("Space");
    await expect.poll(async () => (await readHook(page)).frozen).toBe(focused);
    await page.locator(".omp-deck").press("Space");
    await expect.poll(async () => (await readHook(page)).frozen).toBeNull();

    // Worker focus cycling, and the expand toggle.
    await page.locator(".omp-deck").press("]");
    await expect.poll(async () => (await readHook(page)).focused).not.toBe(focused);
    await page.locator(".omp-deck").press("e");
    await expect(page.locator(".omp-deck-live .omp-livefeed")).toHaveAttribute("data-expanded", "true");
    await page.locator(".omp-deck").press("e");
    await expect(page.locator(".omp-deck-live .omp-livefeed")).toHaveAttribute("data-expanded", "false");

    // History: back to a recorded moment, then live again.
    await page.locator(".omp-deck").press(",");
    await expect(page.locator(".omp-deck-time")).toHaveAttribute("data-history", "past");
    await expect(page.locator(".omp-deck-live-note")).toContainText("live window is paused");
    await page.locator(".omp-deck").press("l");
    await expect(page.locator(".omp-deck-time")).toHaveAttribute("data-history", "live");

    // Control from the keyboard: the failed slice, the deck's own retry, with
    // the endpoint stubbed so nothing is really queued.
    const posted: string[] = [];
    await page.route("**/api/runs/*/control", async (route) => {
      posted.push(route.request().postData() ?? "");
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ seq: 700, kind: "retry", applied: "queued" }),
      });
    });
    await selectViaMirror(page, "delta");
    const retry = page.locator('.omp-deck-control [data-action="retry"]');
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => posted.length).toBe(1);
    expect(JSON.parse(posted[0]!)).toMatchObject({ kind: "retry", sliceId: "delta" });
    await expect(page.locator(".omp-deck-control")).toContainText(/queued/i);

    // The keyboard help panel lists every binding (H on either surface).
    await page.locator(".omp-deck").press("h");
    await expect(page.locator(".omp-deck-help")).toBeVisible();
    await expect(page.locator(".omp-deck-help .omp-deck-keys li")).toHaveCount(DECK_KEYS.length);
    await page.screenshot({ path: HELP_SHOT });
    await page.locator(".omp-deck").press("h");
    await expect(page.locator(".omp-deck-help")).toHaveCount(0);

    // Surface switch out and back, keyboard only.
    await page.locator(".omp-deck").press("d");
    await expect(page.locator(".omp-livefeed-log")).toBeVisible();
    await page.getByRole("button", { name: "Switch to the deck surface" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".omp-deck-flat")).toBeVisible();
    await expect(page.locator(".omp-deck")).toHaveAttribute("data-availability", "flat");

    // Structure, not a screenshot: every status-bearing row says its state.
    const counted = {
      board: await assertStatusText(page, ".omp-deck-flatboard .omp-board-row"),
      pads: await assertStatusText(page, ".omp-deck-pads .omp-deck-padrow"),
      lanes: await assertStatusText(page, ".omp-deck-flatworkers .omp-lane"),
      line: await assertStatusText(page, ".omp-deck-line"),
      station: await assertStatusText(page, ".omp-deck-station"),
      mirror: await assertStatusText(page, ".omp-deck-mirror button"),
    };

    // The live window is wired to the same tail the 3D surface uses.
    await expect(page.locator(".omp-deck-live .omp-livefeed")).toHaveAttribute("data-lines", /[1-9]/);

    // A document does not overlap itself: the flat panels are siblings in one
    // flow, and the deck keeps its own box inside the shell.
    const overlaps = await page.evaluate(() => {
      const selectors = [
        ".omp-deck-time",
        ".omp-deck-station",
        ".omp-deck-flatgrid",
        ".omp-deck-live",
        ".omp-deck-linewrap",
      ];
      const rects = selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`${selector} is missing in flat mode`);
        const rect = element.getBoundingClientRect();
        return { selector, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      const collisions: string[] = [];
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]!;
          const b = rects[j]!;
          const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (width > 1 && height > 1) collisions.push(`${a.selector} ∩ ${b.selector}`);
        }
      }
      const deck = document.querySelector(".omp-deck");
      const footer = document.querySelector("footer.omp-activity");
      if (deck && footer) {
        const a = deck.getBoundingClientRect();
        const b = footer.getBoundingClientRect();
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (width > 1 && height > 1) collisions.push(".omp-deck ∩ footer.omp-activity");
      }
      return collisions;
    });
    expect(overlaps).toEqual([]);

    await page.screenshot({ path: FLAT_SHOT });
    expect(errors).toEqual([]);
    report.flat = {
      reason: "no-webgl2",
      counts: { slices: 6, workers: 2 },
      tabs,
      statusBearing: counted,
      controlBody: posted[0] ?? null,
    };
  });

  test("the focus mirror follows focus and status, and ignores log growth", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoDeck(page);
    await selectViaMirror(page, "gamma");
    await page.locator(".omp-deck").press("f"); // frame the selection = pin the focus
    await expect.poll(async () => (await readHook(page)).focused).toBe("gamma");

    const mirror = page.locator("[data-focus-mirror]");
    await expect(mirror).toContainText("Focused gamma");
    await expect(mirror).toContainText("running");

    // Count every write to the live region from here on.
    await page.evaluate(() => {
      const node = document.querySelector("[data-focus-mirror]");
      if (!node) throw new Error("focus mirror is not mounted");
      const pageGlobal = window as unknown as { __mirrorWrites?: number };
      pageGlobal.__mirrorWrites = 0;
      new MutationObserver(() => {
        pageGlobal.__mirrorWrites = (pageGlobal.__mirrorWrites ?? 0) + 1;
      }).observe(node, { childList: true, characterData: true, subtree: true });
    });

    // A worker handoff event and more transcript: neither changes status,
    // stage, alerts or the live count, so the region must not be touched.
    const handoff = appendEvent(projectDir, RUN_ID, "slice_handoff", "gamma", "turn budget handed over");
    appendFileSync(
      join(projectDir, ".omp", "roadmap", "runs", RUN_ID, "slices", "gamma", "worker-1-g0.log"),
      "  [gamma] turn 2…\n  [gamma] tool read: web/src/scene/roster.ts\n",
      "utf8",
    );
    await expect(page.locator(".omp-deck-event")).toContainText(`seq ${handoff.seq}`);
    await page.waitForTimeout(600);
    const writesAfterLog = await page.evaluate(() => {
      const pageGlobal: { __mirrorWrites?: number } = window as unknown as { __mirrorWrites?: number };
      return pageGlobal.__mirrorWrites ?? -1;
    });
    expect(await mirror.textContent()).toContain("Focused gamma");

    // A real status change is announced once (a write, not a new node).
    storeApi.workerFinished(projectDir, RUN_ID, "gamma", "slices/gamma/report.json", { exit: 0, durationMs: 12_000 });
    await expect(mirror).toContainText("verifying");
    storeApi.verifyPassed(projectDir, RUN_ID, "gamma", "slices/gamma/verdict.json");
    await expect(mirror).toContainText("done");
    const writesAfterStatus = await page.evaluate(() => {
      const pageGlobal: { __mirrorWrites?: number } = window as unknown as { __mirrorWrites?: number };
      return pageGlobal.__mirrorWrites ?? -1;
    });
    expect(writesAfterLog).toBe(0);
    expect(writesAfterStatus).toBeGreaterThanOrEqual(1);

    report.mirror = {
      afterLogWrites: writesAfterLog,
      afterStatusWrites: writesAfterStatus,
      text: await mirror.textContent(),
    };
  });

  test("prefers-reduced-motion is honoured on mount, and M turns motion back on", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoDeck(page);
    await expect(page.locator(".omp-deck")).toHaveAttribute("data-motion", "reduced");
    expect((await readHook(page)).motion).toBe("reduced");

    // A status change under reduced motion introduces no transition cues.
    const before = (await readHook(page)).liveCount;
    await readSample(page);
    storeApi.claimSlice(projectDir, RUN_ID, "spare");
    await expect.poll(async () => (await readHook(page)).liveCount, { timeout: 10_000 }).toBe(before + 1);
    await page.waitForTimeout(500);
    expect((await readHook(page)).motion).toBe("reduced");
    const sample = await readSample(page);
    expect(sample.renderer?.tweens ?? 0).toBe(0);

    // `M` flips the effective state and persists the explicit choice.
    await page.locator(".omp-deck").press("m");
    await expect.poll(async () => (await readHook(page)).motion).toBe("full");
    await expect(page.locator(".omp-deck")).toHaveAttribute("data-motion", "full");
    await page.locator(".omp-deck").press("m");
    await expect.poll(async () => (await readHook(page)).motion).toBe("reduced");
    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("ompo.deck.prefs") ?? "{}") as { motion?: string });
    expect(stored.motion).toBe("reduced");

    report.motion = { onMount: "reduced", afterM: "full", stored: stored.motion, cuesAfterChange: sample.renderer?.tweens ?? 0 };
  });

  test("a lost context switches to flat, keeps the place, and retry rebuilds 3D", async ({ page }) => {
    await gotoDeck(page);
    await selectViaMirror(page, "beta");
    await page.locator(".omp-deck").press("Space");
    const before = await readHook(page);
    expect(before.frozen).not.toBeNull();

    await page.locator("canvas").dispatchEvent("webglcontextlost");
    await expect(page.locator(".omp-deck-flat")).toBeVisible();
    await expect(page.locator(".omp-deck")).toHaveAttribute("data-flat-reason", "context-lost");
    await expect(page.locator(".omp-deck-notice")).toContainText("context was lost");
    await expect(page.locator("canvas")).toHaveCount(0);
    const afterLoss = await readHook(page);
    expect(afterLoss.availability).toBe("flat");
    expect(afterLoss.contextLost).toBe(1);
    // State preserved: selection, freeze, and the flat workspace showing them.
    expect(afterLoss.selected).toBe("beta");
    expect(afterLoss.frozen).toBe(before.frozen);
    await expect(page.locator(".omp-deck-line")).toContainText("beta");

    await page.getByRole("button", { name: "Retry 3D" }).click();
    await expect(page.locator(".omp-deck-canvas")).toHaveCount(1);
    await expect.poll(async () => (await readHook(page)).availability).toBe("3d");
    const afterRetry = await readHook(page);
    expect(afterRetry.selected).toBe("beta");
    expect(afterRetry.frozen).toBe(before.frozen);

    report.contextLoss = { contextLost: afterLoss.contextLost, retryMounted: afterRetry.mounted - afterLoss.mounted };
  });

  test("T includes flat on a machine that has WebGL, and returning restores the scene", async ({ page }) => {
    await gotoDeck(page);
    expect((await readHook(page)).availability).toBe("3d");

    for (let press = 0; press < 4; press++) await page.locator(".omp-deck").press("t");
    await expect(page.locator(".omp-deck")).toHaveAttribute("data-flat-reason", "forced");
    await expect(page.locator(".omp-deck-notice")).toContainText("Flat mode is on");
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.locator(".omp-deck-flatboard .omp-board-row")).toHaveCount(6);

    await page.locator(".omp-deck").press("t");
    await expect(page.locator(".omp-deck-canvas")).toHaveCount(1);
    await expect.poll(async () => (await readHook(page)).availability).toBe("3d");

    report.forcedFlat = { entered: true, returned: true };
  });

  test("status-bearing elements on the 3D surface carry words, not only colour", async ({ page }) => {
    await gotoDeck(page);
    const counted = {
      lanes: await assertStatusText(page, ".omp-deck-lane"),
      line: await assertStatusText(page, ".omp-deck-line"),
      station: await assertStatusText(page, ".omp-deck-station"),
      mirror: await assertStatusText(page, ".omp-deck-mirror button"),
    };
    await expect(page.locator("canvas")).toHaveAttribute("aria-hidden", "true");
    expect(await page.locator("canvas").getAttribute("tabindex")).toBeNull();
    report.statusBearing3d = counted;
  });
});
