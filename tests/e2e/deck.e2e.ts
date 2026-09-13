import { expect, test, type Page } from "@playwright/test";
import { TIER_BUDGETS } from "../../web/src/scene/tier.ts";
import type { DeckSample } from "../../web/src/scene/instrument.ts";

/**
 * The deck surface (roadmap slices `d01`–`d02`): the surface selector the
 * desktop shell will load, a guarded render loop, the instrumentation the gate
 * consumes, and the roadmap rail — pads and dependency edges projected from the
 * real run, with selection shared with the dashboard.
 *
 * These assert behaviour, not looks: a canvas exists at the tier's backing
 * scale, the HUD agrees with the renderer's own classification, an idle deck
 * renders nothing and re-renders nothing, a switch loop disposes every renderer
 * it creates, and a status change rewrites buffers without moving the world.
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
  vertices: number;
  pixels: number;
  /** Model counters (d02): pads, dependency edges, instanced objects. */
  nodes: number;
  edges: number;
  instances: number;
  digest: string;
  selected: string | null;
  hover: string | null;
  positions: { id: string; x: number; z: number }[];
  screenPosition: ((id: string) => { x: number; y: number } | null) | null;
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
    const pageGlobal: { __ompoDeck?: DeckHook } = window as unknown as { __ompoDeck?: DeckHook };
    const state = pageGlobal.__ompoDeck;
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
    const pageGlobal: { __ompoDeck?: { instrument?: { snapshot(): DeckSample } } } = window as unknown as {
      __ompoDeck?: { instrument?: { snapshot(): DeckSample } };
    };
    if (!pageGlobal.__ompoDeck?.instrument) throw new Error("window.__ompoDeck.instrument is not installed");
    return pageGlobal.__ompoDeck.instrument.snapshot();
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
    // Long tasks are not part of the `d00` budget (which pins frame
    // percentiles), but the window must not become a jank storm. Growing the
    // viewport costs one main-thread task on this machine — the canvas backing
    // store is reallocated inside SwiftShader (~60 ms alone, more when the box
    // is shared with other browsers) — so the guard is that it stays a single
    // task, not a rate. The count and the worst value are both printed above.
    expect(window.longTasks.count).toBeLessThanOrEqual(2);
  });

  test("the HUD's numbers are the renderer's own", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(600);
    const state = await readHook(page);
    const window = await readSample(page);
    expect(window.renderer).not.toBeNull();
    // The fixture's rail: grid + pads + markers + edges at most, one call each.
    expect(window.renderer?.drawCalls).toBeGreaterThan(1);
    expect(window.renderer?.drawCalls).toBeLessThanOrEqual(8);
    expect(window.renderer?.fullScreenLayers).toBe(0);
    expect(window.renderer?.shadedPixels).toBeLessThan(state.pixels);
    expect(state.objects).toBe(state.drawCalls + state.instances);
    expect(window.frameMs.p50).toBeGreaterThan(0);
    expect(window.frameMs.p95).toBeGreaterThanOrEqual(window.frameMs.p50);
    expect(window.estimate.basis).toContain("9 ns/px");
  });
});

/**
 * The roadmap rail (slice `d02`). These assert the model's contract in a real
 * browser against the real fixture: pads and edges come from the roadmap, a
 * click is the app's selection, and a status change rewrites buffers instead of
 * moving the world.
 */
test.describe("deck rail", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the fixture's roadmap is a rail of pads and dependency edges", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(600);
    const hook = await readHook(page);
    console.log(
      `deck-rail ${JSON.stringify({ nodes: hook.nodes, edges: hook.edges, instances: hook.instances, drawCalls: hook.drawCalls, objects: hook.objects, triangles: hook.triangles, vertices: hook.vertices, pixels: hook.pixels })}`,
    );
    // tests/e2e/serve.ts: 9 slices, 5 `Depends:` edges, 3 alert markers.
    expect(hook.nodes).toBe(9);
    expect(hook.edges).toBe(5);
    expect(hook.positions).toHaveLength(hook.nodes);
    expect(new Set(hook.positions.map((p) => `${p.x},${p.z}`)).size).toBe(hook.nodes);
    for (const position of hook.positions) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.z)).toBe(true);
    }
    expect(hook.instances).toBe(hook.nodes + 3);
    expect(hook.drawCalls).toBeLessThanOrEqual(8);
    expect(hook.selected).not.toBeNull();
    // Every pad exists as a real button for keyboard and AT users.
    await expect(page.locator(".omp-deck-mirror button")).toHaveCount(hook.nodes);
    await expect(page.locator('.omp-deck-mirror button[aria-current="true"]')).toHaveCount(1);
  });

  test("the deck and the dashboard's DAG view agree about the roadmap", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(600);
    const nodes = (await readHook(page)).nodes;

    await page.getByRole("button", { name: "Switch to the dashboard surface" }).click();
    await page.getByRole("tablist", { name: "Workspace mode" }).getByRole("tab", { name: "DAG" }).click();
    // Same graph, same count: the rail projects `layoutDag`, it does not
    // keep a second layout.
    await expect(page.locator(".omp-dag-node")).toHaveCount(nodes);
  });

  test("clicking a pad selects the slice in both surfaces", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(800);
    await clickPad(page, "s-beta");
    await expect(page.locator(".omp-deck-line")).toContainText("s-beta");
    await expect(page.locator('.omp-deck-mirror button[aria-current="true"]')).toContainText("s-beta");

    await page.getByRole("button", { name: "Switch to the dashboard surface" }).click();
    await expect(page.locator('.omp-board-row[data-selected="true"]')).toContainText("s-beta");

    // The other direction: a dashboard click moves the deck's line. (Two
    // fixture slices share the long sanitised title, so match the id column.)
    await page.getByRole("option", { name: /^longtitle / }).click();
    await page.getByRole("button", { name: "Switch to the deck surface" }).click();
    await expect(page.locator(".omp-deck-line")).toContainText("longtitle");
  });

  test("the DOM mirror is keyboard-complete: focus a pad, Enter selects it", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(600);
    const mirror = page.locator(".omp-deck-mirror");
    // Hidden until it has focus, visible once it does.
    expect((await mirror.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

    const row = page.locator(".omp-deck-mirror button").filter({ hasText: "envblock" }).first();
    await row.focus();
    await expect(row).toBeFocused();
    expect((await mirror.boundingBox())?.width ?? 0).toBeGreaterThan(100);

    await row.press("Enter");
    await expect(page.locator(".omp-deck-line")).toContainText("envblock");
    await expect(row).toHaveAttribute("aria-current", "true");
  });

  test("a status change moves no pad and rebuilds no geometry", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(800);
    const before = await readHook(page);
    const beforeSample = await readSample(page);

    // A real status change through the real control path.
    const posted = await page.request.post("/api/runs/e2emain/control", { data: { kind: "skip", sliceId: "p-two" } });
    expect(posted.ok()).toBe(true);
    await expect.poll(async () => (await readHook(page)).digest, { timeout: 15_000 }).not.toBe(before.digest);
    const after = await readHook(page);
    const afterSample = await readSample(page);

    console.log(
      `deck-status-change ${JSON.stringify({
        moved: positionsKey(after.positions) !== positionsKey(before.positions),
        instances: [before.instances, after.instances],
        geometries: [beforeSample.renderer?.geometries, afterSample.renderer?.geometries],
        drawCalls: after.drawCalls,
        window: {
          frames: afterSample.frames,
          frameMs: afterSample.frameMs,
          commits: afterSample.commits,
          mutations: afterSample.mutations,
          longTasks: afterSample.longTasks,
        },
      })}`,
    );
    expect(positionsKey(after.positions)).toBe(positionsKey(before.positions));
    expect(after.nodes).toBe(before.nodes);
    expect(after.instances).toBe(before.instances);
    expect(afterSample.renderer?.geometries).toBe(beforeSample.renderer?.geometries);
    expect(after.drawCalls).toBeLessThanOrEqual(8);
    // The whole visual cost of one status change: a frame or two, inside budget.
    expect(afterSample.frames).toBeLessThanOrEqual(4);
    expect(afterSample.frameMs.p95).toBeLessThanOrEqual(45);
    // The change is real, and the DOM says so.
    await expect(page.locator(".omp-deck-mirror button").filter({ hasText: "p-two" }).first()).toContainText("skipped");
  });

  test("selection rewrites buffers, never geometry", async ({ page }) => {
    await gotoDeck(page);
    await page.waitForTimeout(800);
    const before = await readHook(page);
    const beforeSample = await readSample(page);

    await clickPad(page, "p-one");
    await expect(page.locator(".omp-deck-line")).toContainText("p-one");
    await clickPad(page, "p-two");
    await expect(page.locator(".omp-deck-line")).toContainText("p-two");

    const after = await readHook(page);
    const afterSample = await readSample(page);
    expect(after.selected).toBe("p-two");
    expect(after.instances).toBe(before.instances);
    expect(after.nodes).toBe(before.nodes);
    expect(afterSample.renderer?.geometries).toBe(beforeSample.renderer?.geometries);
    expect(after.frames).toBeGreaterThan(before.frames);
    expect(positionsKey(after.positions)).toBe(positionsKey(before.positions));
  });
});

/** Click the pad for `id` through the real pointer path (raycast on the canvas). */
async function clickPad(page: Page, id: string): Promise<void> {
  const point = await page.evaluate((sliceId) => {
    // The deck installs this global; this is the boundary type for it.
    const pageGlobal: { __ompoDeck?: DeckHook } = window as unknown as { __ompoDeck?: DeckHook };
    const hook = pageGlobal.__ompoDeck;
    if (!hook?.screenPosition) throw new Error("window.__ompoDeck.screenPosition is not installed");
    return hook.screenPosition(sliceId);
  }, id);
  if (!point) throw new Error(`pad ${id} is not on screen`);
  const box = await page.locator(".omp-deck").boundingBox();
  if (!box) throw new Error("the deck has no box");
  await page.mouse.click(box.x + point.x, box.y + point.y);
}

/** Pad coordinates as one comparable string (positions must not move at all). */
function positionsKey(positions: { id: string; x: number; z: number }[]): string {
  return positions.map((p) => `${p.id}@${p.x},${p.z}`).join("|");
}
