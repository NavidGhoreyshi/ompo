#!/usr/bin/env bun
/**
 * Browser captures for external visual review — the Overview states that
 * need human eyes (tests assert behavior, never aesthetics; §23 of the
 * redesign spec). Boots the e2e fixture server, drives Chromium through the
 * real dashboard, and writes `captures/web-overview-*.png`.
 *
 * Run after `bun run web:build` — the fixture server serves the embedded
 * bundle, so captures otherwise show the previous UI.
 *
 * Usage: bun scripts/web-captures.ts [--port 4321]
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

// The health poll must reach loopback directly; a proxy in the environment
// turns it into a 502 (same guard as scripts/web-qa.ts).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

const ROOT = join(import.meta.dir, "..");
const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4321;
const base = `http://127.0.0.1:${port}`;

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

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(ROOT, "captures", `web-overview-${name}.png`) });
  console.log(`captures/web-overview-${name}.png`);
}

const server = spawn("bun", ["tests/e2e/serve.ts", "--port", String(port)], { cwd: ROOT, stdio: "inherit" });
let browser: Browser | null = null;
try {
  await waitForHealth();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/`);
  await page.locator(".omp-livefeed-log").waitFor();

  await shot(page, "desktop");
  await page.getByRole("button", { name: "View full log" }).click();
  await page.locator('.omp-livefeed[data-expanded="true"]').waitFor();
  await shot(page, "live-expanded");

  await page.getByRole("button", { name: "Collapse log" }).click();
  await page.getByRole("button", { name: /Activity/ }).click();
  await page.locator('.omp-activity[data-open="true"]').waitFor();
  await shot(page, "activity-open");

  await page.getByRole("button", { name: /Activity/ }).click();
  await page.getByRole("tablist", { name: "Workspace mode" }).getByRole("tab", { name: "Agents" }).click();
  await shot(page, "agents-mode");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400); // let the stacked layout settle
  await page.locator(".omp-exec").waitFor();
  await shot(page, "narrow");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
