import { expect, test, type Page } from "@playwright/test";
import { TIER_BUDGETS } from "../../web/src/scene/tier.ts";
import type { DeckSample } from "../../web/src/scene/instrument.ts";

/**
 * The deck surface (roadmap slice `d01`): the surface selector the desktop
 * shell will load, a guarded render loop, and the instrumentation the gate
 * consumes.
 *
 * These assert behaviour, not looks: a canvas exists at the tier's backing
 * scale, the HUD agrees with the renderer's own classification, an idle deck
 * renders nothing and re-renders nothing, and a switch loop disposes every
 * renderer it creates.
 */

interface DeckHook {
  tier: "minimal" | "standard" | "high";
  tierSource: "auto" | "pinned";
  mounted: number;
  disposed: number;
  frames: number;
  drawCalls: number;
  objects: number;
  triangles: number;
  pixels: number;
}

/** Idle observation window; `DECK_IDLE_MS=20000` is how the slice review measured it. */
const IDLE_MS = Number(process.env.DECK_IDLE_MS ?? 2000);

async function gotoDeck(page: Page): Promise<void> {
  await page.goto("/?surface=deck");
  await page.locator(".omp-deck-canvas").waitFor();
  await page.locator(".omp-deck-hud").waitFor();
}

function readHook(page: Page): Promise<DeckHook> {
  return page.evaluate(() => {
    // Installed by Deck.tsx on mount; the shell never defines it.
    const state = (window as unknown as { __ompoDeck?: DeckHook }).__ompoDeck;
    if (!state) throw new Error("window.__ompoDeck is not installed");
    return state;
  });
}

function canvasSize(page: Page): Promise<{ width: number; height: number }> {
  return page.locator("canvas").evaluate((element) => {
    const el = element as HTMLCanvasElement;
    return { width: el.width, height: el.height };
  });
}

/** One windowed sample — counters since the previous call, not since page load. */
function readSample(page: Page): Promise<DeckSample> {
  return page.evaluate(() => {
    const state = (window as unknown as { __ompoDeck?: { instrument?: { snapshot(): DeckSample } } }).__ompoDeck;
    if (!state?.instrument) throw new Error("window.__ompoDeck.instrument is not installed");
    return state.instrument.snapshot();
  });
}

test.describe("deck surface", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("?surface=deck renders a WebGL2 canvas at the tier's backing scale with a HUD that agrees", async ({ page }) => {
    await gotoDeck(page);
    await expect(page.locator("canvas")).toHaveCount(1);

    const state = await readHook(page);
    const chip = await page.locator(".omp-deck-chip").innerText();
    expect(chip).toContain(state.tier);
    expect(chip).toContain(state.tierSource === "auto" ? "auto" : "pinned");
    // A software rasterizer says so in words, next to the chip.
    if (state.tier === "minimal") await expect(page.locator(".omp-deck-warn")).toHaveText(/software renderer/);

    const canvas = { ...(await canvasSize(page)), webgl2: await page.locator("canvas").evaluate((element) => (element as HTMLCanvasElement).getContext("webgl2") !== null) };
    const box = await page.locator(".omp-deck").boundingBox();
    expect(canvas.webgl2).toBe(true);
    // d00's rule: the backing store is the CSS size × the tier's scale.
    const scale = TIER_BUDGETS[state.tier].resolutionScale;
    expect(Math.abs(canvas.width - (box?.width ?? 0) * scale)).toBeLessThanOrEqual(1);
    expect(Math.abs(canvas.height - (box?.height ?? 0) * scale)).toBeLessThanOrEqual(1);
    expect(canvas.width).toBeGreaterThan(0);
  });

  test("an idle deck renders no frames and commits nothing", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(800); // the 200 ms intro fade, plus settle
    const before = await readHook(page);
    await readSample(page); // start a fresh measurement window
    await page.waitForTimeout(IDLE_MS);
    const after = await readHook(page);
    const window = await readSample(page);

    console.log(
      `deck-idle ${JSON.stringify({ idleMs: IDLE_MS, frames: window.frames, frameMs: window.frameMs, commits: window.commits, commitsPerSec: window.commitsPerSec, mutations: window.mutations, mutationsPerSec: window.mutationsPerSec, heap: window.heap, renderer: window.renderer })}`,
    );

    expect(after.frames - before.frames).toBe(0);
    expect(window.frames).toBe(0);
    expect(window.mutations).toBeLessThan(10);
    // Not zero: the shell's own 5 s/10 s polls re-render the tree around the
    // deck. The deck's HUD contributes none — it compares its readout before
    // calling setState — so the rate stays at the poll floor (M5's budget is 4/s).
    expect(window.commitsPerSec).toBeLessThanOrEqual(2);
    // A tick scheduled while the intro fade was still running can arrive after
    // it ended: that tick stops the loop (idle stop) instead of spinning. What
    // matters is that no frame followed it.
    expect(window.loop.idleStops).toBeLessThanOrEqual(2);
  });

  test("T pins the tier and the backing store follows the tier's scale — without a new context", async ({ page }) => {
    await gotoDeck(page);
    const before = await readHook(page);
    expect(before.tierSource).toBe("auto");

    await page.locator(".omp-deck").press("t");
    await expect.poll(async () => (await readHook(page)).tierSource).toBe("pinned");
    await expect(page.locator(".omp-deck-chip")).toContainText("pinned");
    const pinnedTier = (await readHook(page)).tier;

    // One more press advances the cycle: the same GL context, a new scale.
    await page.locator(".omp-deck").press("t");
    await expect.poll(async () => (await readHook(page)).tier).not.toBe(pinnedTier);
    const after = await readHook(page);
    const box = await page.locator(".omp-deck").boundingBox();
    await expect
      .poll(async () => (await canvasSize(page)).width, { timeout: 3000 })
      .toBe(Math.round((box?.width ?? 0) * TIER_BUDGETS[after.tier].resolutionScale));
    expect(after.mounted).toBe(before.mounted); // no context was rebuilt

    // The preference is view state, and it survives a reload.
    await page.reload();
    await page.locator(".omp-deck-canvas").waitFor();
    await expect(page.locator(".omp-deck-chip")).toContainText("pinned");
    await expect(page.locator(".omp-deck-chip")).toContainText((await readHook(page)).tier);
  });

  test("H opens the budget HUD: cost dimensions and the keymap", async ({ page }) => {
    await gotoDeck(page);
    await expect(page.locator(".omp-deck-panel")).toHaveCount(0);
    await page.locator(".omp-deck").press("h");
    const panel = page.locator(".omp-deck-panel");
    await expect(panel).toHaveCount(1);
    await expect(panel).toContainText("shaded pixels");
    await expect(panel).toContainText("geometry");
    await expect(panel).toContainText("react / DOM");
    await expect(panel).toContainText("events");
    await expect(panel).toContainText("long tasks");
    await expect(panel).toContainText("heap");
    await expect(panel.locator(".omp-deck-keys li")).toHaveCount(12);
  });

  test("ten surface switches leave exactly one canvas and dispose every renderer", async ({ page }) => {
    await gotoDeck(page);
    for (let i = 0; i < 10; i++) {
      await page.getByRole("button", { name: "Switch to the dashboard surface" }).click();
      await expect(page.locator(".omp-deck-canvas")).toHaveCount(0);
      await expect(page.locator(".omp-livefeed-log")).toBeVisible();
      await page.getByRole("button", { name: "Switch to the deck surface" }).click();
      await expect(page.locator(".omp-deck-canvas")).toHaveCount(1);
    }
    await page.getByRole("button", { name: "Switch to the dashboard surface" }).click();
    await expect(page.locator(".omp-deck-canvas")).toHaveCount(0);

    const state = await readHook(page);
    expect(state.mounted).toBeGreaterThanOrEqual(11);
    expect(state.disposed).toBeGreaterThanOrEqual(10);
    expect(state.mounted - state.disposed).toBeLessThanOrEqual(1);
    expect(page.url()).not.toContain("surface=deck");
    await expect(page.locator(".omp-livefeed-log")).toBeVisible();
  });

  test("a new event reaches the deck's DOM inside the poll bound", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(800);
    await readSample(page); // reset the window: only the event below is measured

    // A real event through the real path: POST /control → store → SSE poll →
    // App state → deck DOM. Nothing here is synthesised in the page.
    const posted = await page.request.post("/api/runs/e2emain/control", { data: { kind: "skip", sliceId: "p-one" } });
    expect(posted.ok()).toBe(true);
    // Each sample resets the window, so the sample that carries the mark is the
    // one to assert on.
    const seen: { window: DeckSample | null } = { window: null };
    await expect
      .poll(
        async () => {
          const window = await readSample(page);
          if (window.latencyMs.samples > 0) seen.window = window;
          return window.latencyMs.samples;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    const window = seen.window;
    if (!window) throw new Error("the event was applied but no latency sample was captured");
    console.log(`deck-latency ${JSON.stringify({ latencyMs: window.latencyMs, events: window.events, loop: window.loop })}`);
    expect(window.events.markMisses).toBe(0);
    // M4's p95 budget is 3 s; the deck must be far inside it with no live tail.
    expect(window.latencyMs.worst).toBeLessThan(3000);
  });

  test("the deck stays inside the d00 budget while the operator works it", async ({ page }) => {
    // The slice-review measurement: interaction (resize + HUD) on the minimal
    // tier, measured by the deck's own instruments, asserted against the budget
    // `d00` pinned (p50 ≤ 33 ms, p95 ≤ 45 ms at 30 fps).
    await gotoDeck(page);
    await page.waitForTimeout(800);
    await readSample(page); // reset: the window below is the interaction only

    await page.setViewportSize({ width: 1180, height: 820 });
    await page.waitForTimeout(300);
    await page.locator(".omp-deck").press("h");
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await page.locator(".omp-deck").press("h");
    await page.waitForTimeout(600);

    const window = await readSample(page);
    const state = await readHook(page);
    const canvas = await canvasSize(page);
    console.log(
      `deck-cost ${JSON.stringify({
        tier: state.tier,
        frames: window.frames,
        frameMs: window.frameMs,
        loop: window.loop,
        commits: window.commits,
        commitsPerSec: window.commitsPerSec,
        mutations: window.mutations,
        mutationsPerSec: window.mutationsPerSec,
        domElements: window.domElements,
        layoutMs: window.layoutMs,
        longTasks: window.longTasks,
        heap: window.heap.supported ? window.heap.usedBytes : window.heap.reason,
        renderer: window.renderer,
        canvas,
        estimate: window.estimate,
      })}`,
    );

    expect(window.frames).toBeGreaterThan(0);
    expect(window.frameMs.p50).toBeLessThanOrEqual(33);
    expect(window.frameMs.p95).toBeLessThanOrEqual(45);
    expect(window.commitsPerSec).toBeLessThanOrEqual(8);
    expect(window.mutationsPerSec).toBeLessThanOrEqual(60);
    expect(window.longTasks.worstMs).toBeLessThanOrEqual(50 * 2);
  });

  test("the HUD's numbers are the renderer's own", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(600);
    const state = await readHook(page);
    const window = await readSample(page);
    expect(window.renderer).not.toBeNull();
    // d01's world is one grid: one draw call, no triangles, no full-screen layer.
    expect(window.renderer?.drawCalls).toBe(1);
    expect(window.renderer?.fullScreenLayers).toBe(0);
    expect(window.renderer?.shadedPixels).toBeLessThan(state.pixels);
    expect(window.frameMs.p50).toBeGreaterThan(0);
    expect(window.frameMs.p95).toBeGreaterThanOrEqual(window.frameMs.p50);
    expect(window.estimate.basis).toContain("9 ns/px");
  });
});
