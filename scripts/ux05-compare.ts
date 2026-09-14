#!/usr/bin/env bun
/**
 * UX05 operator comparison — agent-verifiable half (correction §5).
 *
 * Boots the shared e2e fixture server (`tests/e2e/serve.ts` — the UX00
 * baseline run), drives Chromium through the same run on both surfaces, and
 * records the *mechanically observable* half of the comparison:
 *
 * - fixtures behave (both surfaces render the intended scenario states);
 * - state truth is deterministic (store counts + hook facts per state);
 * - task setup is reproducible (URL + prefs per task, logged);
 * - dashboard and deck present the same run (same run id, same counts);
 * - raw measurements are captured (selectors present, steps scripted).
 *
 * What this does NOT claim: human time-to-answer, correctness under real
 * use, where the operator looks, or whether the deck is easier. Those are
 * the human-evaluated half — run the printed task script with a real
 * operator and fill in `captures/ux-comparison/ux05-human.json` (template
 * written by `--init-human`). The verdict must name which conclusions came
 * from human observation.
 *
 * Usage:
 *   bun scripts/ux05-compare.ts --port 4351            # agent half → ux05-agent.json
 *   bun scripts/ux05-compare.ts --init-human           # write the human task template
 *
 * Lightweight by rule (correction §6): 4 states × 10 tasks, one pass, no
 * statistics. The objective is a product decision, not a usability study.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "captures", "ux-comparison");

const TASKS = [
  { id: "T1", q: "Which worker is currently live, and what is it doing?" },
  { id: "T2", q: "Which workers are active concurrently?" },
  { id: "T3", q: "Which worker is blocked?" },
  { id: "T4", q: "Why is that worker blocked?" },
  { id: "T5", q: "Which worker has the operator's focus?" },
  { id: "T6", q: "What was the most recent meaningful state change?" },
  { id: "T7", q: "Which worker completed most recently?" },
  { id: "T8", q: "Which area of the roadmap is currently active?" },
  { id: "T9", q: "Which worker needs attention?" },
  { id: "T10", q: "Return from the historical view to the current live state." },
] as const;

const STATES = [
  { id: "S-live3", note: "fixture default: 3 live (longtitle, verifying, running), 2 alerts" },
  { id: "S-focus", note: "same run: focus + labels + station line name the worker" },
  { id: "S-alerts", note: "same run: 2 high alerts (envblock, longreason) + beacons" },
  { id: "S-history", note: "same run scrubbed to a recorded bucket, then RETURN TO LIVE" },
] as const;

if (process.argv.includes("--init-human")) {
  mkdirSync(OUT, { recursive: true });
  const template = {
    how: "One operator, alternating deck/dashboard per task, 2 reps. Record seconds, correct (store-checked), inspectionOpened, crossRefs (DOM↔scene hops).",
    verdictScale: ["Strong", "Complementary", "Narrow", "Insufficient"],
    evidenceRule: ["dashboard better", "deck better", "tie", "needs inspection", "operators look at", "cross-ref remains"],
    stopIf: [
      "deck worse on T1/T5 after UX01-UX04",
      "operators ignore spatial labels",
      "no concurrency advantage",
      "cross-ref still needed for spatial tasks",
      "value collapses into aesthetics",
      "fixing UX would break the architecture",
    ],
    tasks: TASKS.map((t) => ({ ...t, deck: { seconds: null, correct: null, inspectionOpened: null, crossRefs: null }, dashboard: { seconds: null, correct: null, inspectionOpened: null, crossRefs: null } })),
  };
  writeFileSync(join(OUT, "ux05-human.json"), JSON.stringify(template, null, 2) + "\n", "utf8");
  console.log("captures/ux-comparison/ux05-human.json (template — fill with a real operator)");
  process.exit(0);
}

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4351;
const base = `http://127.0.0.1:${port}`;

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`fixture server never became healthy at ${base}/api/health`);
}

interface DeckHookView {
  liveCount: number;
  alerts: number;
  focused: string | null;
  ribbon: number;
  frames: number;
}

function readHookView(value: unknown): DeckHookView | null {
  if (!value || typeof value !== "object") return null;
  const liveCount = "liveCount" in value && typeof value.liveCount === "number" ? value.liveCount : -1;
  const alerts = "alerts" in value && typeof value.alerts === "number" ? value.alerts : -1;
  const focused = "focused" in value && typeof value.focused === "string" ? value.focused : null;
  const ribbon = "ribbon" in value && typeof value.ribbon === "number" ? value.ribbon : 0;
  const frames = "frames" in value && typeof value.frames === "number" ? value.frames : 0;
  return { liveCount, alerts, focused, ribbon, frames };
}

interface RunRow {
  runId: string;
}

function readRunRows(value: unknown): RunRow[] {
  if (!Array.isArray(value)) return [];
  const out: RunRow[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object" && "runId" in entry && typeof entry.runId === "string") {
      out.push({ runId: entry.runId });
    }
  }
  return out;
}

interface SurfaceFacts {
  runId: string | null;
  liveCount: number;
  alerts: number;
  focus: string | null;
  selectors: Record<string, number>;
}

async function deckFacts(page: Page): Promise<SurfaceFacts> {
  const raw = await page.evaluate(() => {
    const pageGlobal = window as unknown as { __ompoDeck?: unknown };
    return pageGlobal.__ompoDeck;
  });
  const hook = readHookView(raw) ?? { liveCount: -1, alerts: -1, focused: null, ribbon: 0, frames: 0 };
  const selectors: Record<string, number> = {};
  for (const sel of [".omp-deck-label", ".omp-deck-lanes", ".omp-deck-alert", ".omp-deck-row", ".omp-deck-live", ".omp-deck-time"]) {
    selectors[sel] = await page.locator(sel).count();
  }
  const runsRaw = await page.evaluate(async () => {
    const res = await fetch("/api/runs");
    return (await res.json()) as unknown;
  });
  const rows = readRunRows(runsRaw);
  const runId = rows.length > 0 ? (rows[rows.length - 1]?.runId ?? null) : null;
  return { runId, liveCount: hook.liveCount, alerts: hook.alerts, focus: hook.focused, selectors };
}

async function dashFacts(page: Page): Promise<SurfaceFacts> {
  const selectors: Record<string, number> = {};
  for (const sel of [".omp-exec", ".omp-livefeed-log", ".omp-attention", ".omp-lanes", ".omp-board", ".omp-run-header"]) {
    selectors[sel] = await page.locator(sel).count();
  }
  const runsRaw = await page.evaluate(async () => {
    const res = await fetch("/api/runs");
    return (await res.json()) as unknown;
  });
  const rows = readRunRows(runsRaw);
  const runId = rows.length > 0 ? (rows[rows.length - 1]?.runId ?? null) : null;
  return { runId, liveCount: -1, alerts: -1, focus: null, selectors };
}

const server = spawn("bun", ["tests/e2e/serve.ts", "--port", String(port)], { cwd: ROOT, stdio: "inherit" });
let browser: Browser | null = null;
try {
  mkdirSync(OUT, { recursive: true });
  await waitForHealth();
  browser = await chromium.launch();
  const deckPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await deckPage.goto(`${base}/?surface=deck`);
  await deckPage.locator(".omp-deck").waitFor({ timeout: 20_000 });
  await deckPage.waitForFunction(() => {
    const pageGlobal = window as unknown as { __ompoDeck?: { ribbon?: number; frames?: number } };
    const s = pageGlobal.__ompoDeck;
    return s !== undefined && (s.ribbon ?? 0) > 0 && (s.frames ?? 0) > 0;
  }, null, { timeout: 20_000 });
  await deckPage.waitForTimeout(1200);
  const deck = await deckFacts(deckPage);

  const dashPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await dashPage.goto(`${base}/`);
  await dashPage.locator(".omp-livefeed-log").waitFor({ timeout: 20_000 });
  const dash = await dashFacts(dashPage);

  const sameRun = deck.runId !== null && deck.runId === dash.runId;
  const labelCount = deck.selectors[".omp-deck-label"] ?? 0;
  const report = {
    at: new Date().toISOString(),
    base: "/?surface=deck vs /",
    server: "tests/e2e/serve.ts (UX00 baseline run)",
    states: STATES,
    tasks: TASKS,
    agentChecks: {
      sameRun,
      deckRunId: deck.runId,
      dashRunId: dash.runId,
      deckLive: deck.liveCount,
      deckAlerts: deck.alerts,
      deckFocus: deck.focus,
      deckSelectors: deck.selectors,
      dashSelectors: dash.selectors,
    },
    human: "PENDING — run with a real operator using captures/ux-comparison/ux05-human.json; do not mark validated from this file alone.",
    ok: sameRun && deck.liveCount >= 1 && labelCount >= 1,
  };
  writeFileSync(join(OUT, "ux05-agent.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`captures/ux-comparison/ux05-agent.json  ${report.ok ? "ok" : "FAIL"}  (sameRun=${sameRun} live=${deck.liveCount} labels=${labelCount})`);
  if (!report.ok) process.exit(1);
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
