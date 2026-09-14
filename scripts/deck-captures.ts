#!/usr/bin/env bun
/**
 * Deck evidence captures (roadmap slice `d14`).
 *
 * Regenerates the release evidence on demand: boots the e2e fixture server
 * (`tests/e2e/serve.ts` — a deterministic run with done/failed/blocked-env/
 * verifying/running/pending slices), drives Chromium through `?surface=deck`,
 * seeds `ompo.deck.prefs` per shot, and writes `captures/deck-*.png` plus a
 * `captures/deck-qa.json` summary of the assertions it checked.
 *
 * Run after `bun run web:build` — the fixture server serves the embedded
 * bundle, so captures otherwise show the previous UI.
 *
 * Usage: bun scripts/deck-captures.ts [--port 4322] [--headed]
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// The health poll must reach loopback directly; a proxy in the environment
// turns it into a 502 (same guard as scripts/web-qa.ts).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "captures");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: bun scripts/deck-captures.ts [--port 4322] [--headed]");
  process.exit(0);
}

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

interface DeckHook {
  tier: "minimal" | "standard" | "high";
  availability: "3d" | "flat";
  flatReason: "no-webgl2" | "context-lost" | "create-failed" | "forced" | null;
  motion: "full" | "reduced";
  ambient: string[];
  ribbon: number;
  alerts: number;
  dockOpen: boolean;
  dockTab: string;
}

interface ShotAssert {
  file: string;
  ok: boolean;
  detail: string;
}

const asserts: ShotAssert[] = [];
function check(file: string, ok: boolean, detail: string): void {
  asserts.push({ file, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${file}  ${detail}`);
}

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`fixture server never became healthy at ${base}/api/health`);
}

function readHook(page: Page): Promise<DeckHook> {
  return page.evaluate(() => {
    const pageGlobal = window as unknown as { __ompoDeck?: DeckHook };
    const state = pageGlobal.__ompoDeck;
    if (!state) throw new Error("window.__ompoDeck is not installed");
    return state;
  });
}

/** The 3D surface is settled once its temporal window exists and frames drew. */
async function awaitDeck3d(page: Page): Promise<DeckHook> {
  await page.locator(".omp-deck").waitFor({ timeout: 20_000 });
  await page.locator(".omp-deck-canvas").waitFor({ timeout: 20_000 });
  await page.locator(".omp-deck-hud").waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const pageGlobal = window as unknown as { __ompoDeck?: { ribbon?: number; frames?: number } };
      const state = pageGlobal.__ompoDeck;
      return state !== undefined && (state.ribbon ?? 0) > 0 && (state.frames ?? 0) > 0;
    },
    null,
    { timeout: 20_000 },
  );
  return readHook(page);
}

async function newDeckPage(browser: Browser, prefs: Record<string, unknown> | null): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (prefs !== null) {
    await context.addInitScript((seed) => {
      window.localStorage.setItem("ompo.deck.prefs", JSON.stringify(seed));
    }, prefs);
  }
  const page = await context.newPage();
  await page.goto(`${base}/?surface=deck`);
  return { context, page };
}

async function shot(page: Page, name: string): Promise<string> {
  const file = `deck-${name}.png`;
  await page.screenshot({ path: join(OUT, file) });
  return file;
}

const server = spawn("bun", ["tests/e2e/serve.ts", "--port", String(port)], { cwd: ROOT, stdio: "inherit" });
let browser: Browser | null = null;
try {
  await waitForHealth();
  browser = await chromium.launch({ headless: !headed });

  // 1. Auto tier on this box (SwiftShader → minimal), the operator's default view.
  {
    const { context, page } = await newDeckPage(browser, null);
    try {
      const hook = await awaitDeck3d(page);
      check("deck-tier-minimal.png", hook.tier === "minimal" && hook.availability === "3d", `tier ${hook.tier} (${hook.availability})`);
      // The fixture carries a failed and a blocked-env slice: the alert stack
      // is part of this shot, not a separate fixture.
      check("deck-alerts.png", hook.alerts >= 2, `${hook.alerts} alerts active`);
      await shot(page, "tier-minimal");
      await shot(page, "alerts");
    } finally {
      await context.close();
    }
  }

  // 2–3. Pinned tiers: the same world at the other two budgets.
  for (const tier of ["standard", "high"] as const) {
    const { context, page } = await newDeckPage(browser, { tier, motion: "on", forced: null });
    try {
      const hook = await awaitDeck3d(page);
      check(`deck-tier-${tier}.png`, hook.tier === tier, `tier ${hook.tier}`);
      await shot(page, `tier-${tier}`);
    } finally {
      await context.close();
    }
  }

  // 4. Every effect off is still a working deck (d13 acceptance, re-captured).
  {
    const { context, page } = await newDeckPage(browser, {
      tier: "auto",
      motion: "on",
      forced: null,
      effects: { floor: false, fog: false, parallax: false, settle: false, drift: false },
    });
    try {
      const hook = await awaitDeck3d(page);
      check("deck-effects-off.png", hook.ambient.length === 0, `ambient [${hook.ambient.join(", ")}]`);
      await shot(page, "effects-off");
    } finally {
      await context.close();
    }
  }

  // 5. Flat projection: no canvas, same slices/workers/window/controls in DOM.
  {
    const { context, page } = await newDeckPage(browser, { tier: "auto", motion: "system", forced: "flat" });
    try {
      await page.locator(".omp-deck").waitFor({ timeout: 20_000 });
      await page.locator(".omp-deck-flatboard").waitFor({ timeout: 20_000 });
      const hook = await readHook(page);
      const canvases = await page.locator("canvas").count();
      check("deck-flat.png", hook.availability === "flat" && hook.flatReason === "forced" && canvases === 0, `${hook.availability} (${hook.flatReason}), ${canvases} canvases`);
      await shot(page, "flat");
    } finally {
      await context.close();
    }
  }

  // 6. Reduced motion: static effects stay, animated ones gate off.
  {
    const { context, page } = await newDeckPage(browser, { tier: "auto", motion: "reduced", forced: null });
    try {
      const hook = await awaitDeck3d(page);
      check(
        "deck-motion-reduced.png",
        hook.motion === "reduced" && hook.ambient.join(",") === "floor,fog",
        `motion ${hook.motion}, ambient [${hook.ambient.join(", ")}]`,
      );
      await shot(page, "motion-reduced");
    } finally {
      await context.close();
    }
  }

  // 7. Inspection dock open on the first tab (the dashboard's own Inspector).
  {
    const { context, page } = await newDeckPage(browser, null);
    try {
      await awaitDeck3d(page);
      await page.locator(".omp-deck").click();
      await page.locator(".omp-deck").press("1");
      await page.locator(".omp-deck-dock").waitFor({ timeout: 20_000 });
      const hook = await readHook(page);
      check("deck-inspector.png", hook.dockOpen === true && hook.dockTab === "Output", `dock ${hook.dockOpen ? "open" : "closed"} · ${hook.dockTab}`);
      await shot(page, "inspector");
    } finally {
      await context.close();
    }
  }

  // 8. History wall: the run list (read-only, switches the whole surface).
  {
    const { context, page } = await newDeckPage(browser, null);
    try {
      await awaitDeck3d(page);
      await page.locator(".omp-deck-time-wall").click();
      await page.locator(".omp-deck-wall").waitFor({ timeout: 20_000 });
      const rows = await page.locator(".omp-deck-wall-row").count();
      check("deck-wall.png", rows >= 2, `${rows} run rows`);
      await shot(page, "wall");
    } finally {
      await context.close();
    }
  }

  const ok = asserts.every((a) => a.ok);
  writeFileSync(
    join(OUT, "deck-qa.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        base: "/?surface=deck",
        viewport: { width: 1440, height: 900 },
        server: "tests/e2e/serve.ts",
        bundle: "embedded (bun run web:build first)",
        shots: asserts,
        ok,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`captures/deck-qa.json  ${ok ? "ok" : "FAIL"}`);
  if (!ok) process.exit(1);
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
