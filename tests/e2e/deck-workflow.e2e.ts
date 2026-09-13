import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spec owns its own server: every step has to mutate the run (claim a
// slice, fail a gate, post control) *while* the page is open, which the shared
// `webServer` fixture cannot do. The server runs in a bun child process
// (`tests/e2e/deck-workflow-harness.ts`) because `src/server.ts` imports
// `../package.json`, which the spec's Node loader refuses; the run itself is
// still driven in-process through `storeApi`. Readiness probes must reach
// loopback directly; a proxy in the environment turns them into a 502.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { formatProgressLine } from "../../src/attempt.ts";
import { parseRoadmap } from "../../src/parse.ts";
import { createRun, sliceDir, storeApi } from "../../src/store.ts";

/**
 * Deck workflow e2e (roadmap slice `d03`): the active worker as the primary
 * object, a bounded live window that reuses `LiveFeed`, and the event→visible
 * pipeline measured end to end.
 *
 * This is a product test, not a unit test's long arm: a real run is created in
 * a throwaway project, driven through the real store (`storeApi.*`), served by
 * the real dashboard server, and observed in a real browser at `?surface=deck`.
 * Every number in `captures/deck-validation/d03-workflow.json` comes from the
 * page's own instruments (`window.__ompoDeck`, `instrument.snapshot()`), never
 * from a faked event or a look-at-it assertion.
 *
 * The steps are named `1`…`8` after the workflow they exercise, and they run in
 * one `test()` body with per-step error capture: the point is the raw numbers
 * for *every* step, so a contract that has not landed shows up as one precise
 * per-step failure instead of skipping the remainder. Step 5's quiescent half
 * runs after step 7 by design — step 6 needs a live worker to retain focus
 * against, so `beta` is only completed once the focus, churn and latency
 * evidence is in.
 */

const PORT = 4471;
const RUN_ID = "d03-workflow";
const SLICE_A = "alpha";
const SLICE_B = "beta";
/** Stays pending: the only slice a real `skip` control can legally target. */
const SLICE_C = "gamma";
const SLICE_D = "delta";
const ARTIFACT = join("captures", "deck-validation", "d03-workflow.json");
const SCREENSHOT = join("captures", "deck-d03-workflow.png");
/** The 60 s log-volume window (M6) writes its own artifact. */
const TEXT_ARTIFACT = join("captures", "deck-validation", "d03-text-window.json");

const REASON = "gate bun test failed — 2 tests";

const ROADMAP = `# Deck d03 workflow fixture

## [alpha] Alpha — the first live worker
Effort: lo
Verify: bun test
The station the deck must frame while its worker is in flight.

## [beta] Beta — one dependency downstream
Effort: lo
Depends: alpha
Verify: bun test
The second live worker; focus has to move here once alpha is terminal.

## [gamma] Gamma — queued control target
Effort: lo
Verify: bun test
Stays pending so a real control intent has something legal to act on.

## [delta] Delta — the tail
Effort: lo
`;

/** The worker's own progress grammar, as `progressLineForEvent` emits it. */
const OPENING_LINES = [
  "turn 1…",
  "tool bash: bun test",
  "tool read: src/a.ts",
  "says: the store mutation landed; checking the deck projection now",
  "turn 1 done (2 tool results)",
  "exit=0 timedOut=false durationMs=1234",
];

/** Transcript lines `from`..`from+count`: the real grammar, varying tool args. */
function transcriptLines(from: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = from + i;
    if (n < OPENING_LINES.length) {
      out.push(OPENING_LINES[n]!);
      continue;
    }
    switch (n % 6) {
      case 0:
        out.push(`turn ${1 + Math.floor(n / 6)}…`);
        break;
      case 1:
        out.push(`tool bash: bun test --filter case-${n}`);
        break;
      case 2:
        out.push("tool read: src/a.ts");
        break;
      case 3:
        out.push(`says: pass ${n} — the transcript line is what moves`);
        break;
      case 4:
        out.push(`turn ${1 + Math.floor(n / 6)} done (2 tool results)`);
        break;
      default:
        out.push(`exit=0 timedOut=false durationMs=${1200 + n}`);
        break;
    }
  }
  return out;
}

/** A gate transcript, in the `verify` lane's grammar (`semanticLine`). */
const VERIFY_LINES = ["$ bun test", "3 tests passed", "(exit=1 timedOut=false 2100ms)"];

/** One worker-log append, through the same formatter the worker writes with. */
function progress(lines: string[], sliceId: string, tag: string | undefined): string {
  return lines.map((line) => formatProgressLine(sliceId, tag, line)).join("\n") + "\n";
}

interface Camera {
  target: { x: number; y: number; z: number };
  distance: number;
  azimuth: number;
  elevation: number;
}

interface LatencyView {
  p50: number;
  p95: number;
  worst: number;
  samples: number;
}

/** The `d03` debug-hook fields. Optional: the contract may not have landed. */
interface HookView {
  tier: string | null;
  frames: number | null;
  digest: string | null;
  selected: string | null;
  hover: string | null;
  focused?: string | null;
  pinned?: string | null;
  frozen?: string | null;
  liveCount?: number | null;
  camera?: Camera | null;
  stationSegments?: number | null;
  liveRows?: number | null;
  logLines?: number | null;
  /** Hook fields the deck does not install (yet) — the contract gap. */
  missing: string[];
}

interface DomView {
  hasLive: boolean;
  hasLanes: boolean;
  /** Rows the window currently shows (leaving ghosts are not shown rows). */
  rows: number;
  ghostRows: number;
  keyedRows: number;
  keys: string[];
  text: string[];
  dataLive: string | null;
  expanded: string | null;
  follow: string | null;
  scrollTop: number | null;
  distanceFromBottom: number | null;
  logName: string | null;
  lanes: { focused: boolean; id: string; status: string; meta: string; text: string }[];
  lineText: string;
  laneText: string;
  hudText: string;
}

interface SampleView {
  frames: number | null;
  commits: number | null;
  commitsPerSec: number | null;
  mutations: number | null;
  mutationsPerSec: number | null;
  longTasks: { count: number; worstMs: number } | null;
  latencyMs: LatencyView | null;
  latencyStages: unknown;
  domElements: number | null;
  markedEvents: number | null;
}

/** One captured step observation: hook + windowed sample + DOM, in one object. */
interface Capture {
  frames: number | null;
  commits: number | null;
  mutations: number | null;
  longTasks: { count: number; worstMs: number } | null;
  latencyMs: LatencyView | null;
  latencyStages: unknown;
  domElements: number | null;
  markedEvents: number | null;
  liveCount: number | null;
  focused: string | null;
  pinned: string | null;
  frozen: string | null;
  camera: Camera | null;
  stationSegments: number | null;
  liveRows: number | null;
  logLines: number | null;
  dataLive: string | null;
  domRows: number;
}

interface StepRecord {
  step: string;
  name: string;
  ok: boolean;
  errors: string[];
  numbers: Record<string, unknown>;
}

const CONTRACT_FIELDS: string[] = [
  "focused",
  "pinned",
  "frozen",
  "liveCount",
  "camera",
  "stationSegments",
  "liveRows",
  "logLines",
];

async function readHook(page: Page): Promise<HookView | null> {
  return page.evaluate((fields) => {
    const pageGlobal = window as unknown as { __ompoDeck?: Record<string, unknown> };
    const hook = pageGlobal.__ompoDeck;
    if (!hook) return null;
    const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
    const asNumber = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    let camera: Camera | null = null;
    if (typeof hook.camera === "object" && hook.camera !== null) camera = hook.camera as Camera;
    const missing = fields.filter((field) => hook[field] === undefined);
    if (typeof hook.screenPosition !== "function") missing.push("screenPosition");
    return {
      tier: asString(hook.tier),
      frames: asNumber(hook.frames),
      digest: asString(hook.digest),
      selected: asString(hook.selected),
      hover: asString(hook.hover),
      focused: asString(hook.focused),
      pinned: asString(hook.pinned),
      frozen: asString(hook.frozen),
      liveCount: asNumber(hook.liveCount),
      camera,
      stationSegments: asNumber(hook.stationSegments),
      liveRows: asNumber(hook.liveRows),
      logLines: asNumber(hook.logLines),
      missing,
    };
  }, CONTRACT_FIELDS);
}

async function readDom(page: Page): Promise<DomView> {
  return page.evaluate(() => {
    const text = (el: Element | null): string => el?.textContent ?? "";
    const rows = Array.from(document.querySelectorAll(".omp-deck-live .omp-live-row")).map((el) => {
      // DOM node by construction: the live window puts data-* on each row div.
      const html = el as HTMLElement;
      return { motion: html.dataset.motion ?? "steady", key: html.dataset.key ?? "", text: html.textContent ?? "" };
    });
    const feed = document.querySelector(".omp-deck-live .omp-livefeed") as HTMLElement | null;
    const log = document.querySelector(".omp-deck-live .omp-livefeed-log") as HTMLElement | null;
    const lanes = Array.from(document.querySelectorAll(".omp-deck-lane")).map((el) => {
      const html = el as HTMLElement;
      return {
        focused: html.dataset.focused === "true",
        id: text(el.querySelector(".omp-deck-lane-id")),
        status: text(el.querySelector(".omp-deck-lane-status")),
        meta: text(el.querySelector(".omp-deck-lane-meta")),
        text: html.textContent ?? "",
      };
    });
    const live = rows.filter((row) => row.motion !== "leave");
    return {
      hasLive: document.querySelector(".omp-deck-live") !== null,
      hasLanes: document.querySelector(".omp-deck-lane") !== null,
      rows: live.length,
      ghostRows: rows.length - live.length,
      keyedRows: rows.filter((row) => row.key.length > 0).length,
      keys: live.map((row) => row.key).filter((key) => key.length > 0),
      text: live.map((row) => row.text),
      dataLive: feed?.getAttribute("data-live") ?? null,
      expanded: feed?.getAttribute("data-expanded") ?? null,
      follow: log?.getAttribute("data-follow") ?? null,
      scrollTop: log ? Math.round(log.scrollTop) : null,
      distanceFromBottom: log ? Math.round(log.scrollHeight - log.clientHeight - log.scrollTop) : null,
      logName: text(document.querySelector(".omp-deck-live .omp-livefeed-log-name")),
      lanes,
      lineText: text(document.querySelector(".omp-deck-line")),
      laneText: text(document.querySelector(".omp-deck-lanes")),
      hudText: text(document.querySelector(".omp-deck-hud")),
    };
  });
}

/** One instrument sample; `snapshot` consumes the window, `latest` does not. */
async function readSample(page: Page, which: "snapshot" | "latest"): Promise<SampleView | null> {
  return page.evaluate((mode) => {
    const pageGlobal = window as unknown as { __ompoDeck?: { instrument?: Record<string, unknown> } };
    const instrument = pageGlobal.__ompoDeck?.instrument;
    const reader = instrument?.[mode];
    if (typeof reader !== "function") return null;
    // The instrument's methods close over their own state; `this` is unused.
    const raw: unknown = reader();
    const sample: Record<string, unknown> = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const record = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const asNumber = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const longTasks = record(sample.longTasks);
    const stats = record(sample.latencyMs);
    const events = record(sample.events);
    return {
      frames: asNumber(sample.frames),
      commits: asNumber(sample.commits),
      commitsPerSec: asNumber(sample.commitsPerSec),
      mutations: asNumber(sample.mutations),
      mutationsPerSec: asNumber(sample.mutationsPerSec),
      longTasks:
        Object.keys(longTasks).length > 0
          ? { count: asNumber(longTasks.count) ?? 0, worstMs: asNumber(longTasks.worstMs) ?? 0 }
          : null,
      latencyMs:
        Object.keys(stats).length > 0
          ? {
              p50: asNumber(stats.p50) ?? 0,
              p95: asNumber(stats.p95) ?? 0,
              worst: asNumber(stats.worst) ?? 0,
              samples: asNumber(stats.samples) ?? 0,
            }
          : null,
      latencyStages: sample.latencyStages ?? null,
      domElements: asNumber(sample.domElements),
      markedEvents: asNumber(events.applied),
    };
  }, which);
}

async function screenPosition(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((sliceId) => {
    const pageGlobal = window as unknown as {
      __ompoDeck?: { screenPosition?: (s: string) => { x: number; y: number } | null };
    };
    return pageGlobal.__ompoDeck?.screenPosition?.(sliceId) ?? null;
  }, id);
}

/** Select a pad through the deck's own select path; the canvas raycast first. */
async function selectPad(page: Page, id: string): Promise<"canvas" | "mirror"> {
  const point = await screenPosition(page, id);
  if (point) {
    const box = await page.locator(".omp-deck").boundingBox();
    if (box) {
      await page.mouse.click(box.x + point.x, box.y + point.y);
      return "canvas";
    }
  }
  // Off screen under the `command` framing: the DOM mirror is the same
  // `onSelect` path, and it is the accessible route the deck promises.
  const row = page.locator(".omp-deck-mirror button").filter({ hasText: id }).first();
  await row.focus();
  await row.press("Enter");
  return "mirror";
}

async function hoverPad(page: Page, id: string): Promise<boolean> {
  const point = await screenPosition(page, id);
  if (!point) return false;
  const box = await page.locator(".omp-deck").boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + point.x, box.y + point.y);
  return true;
}

/** Wait for the 240 ms enter/leave motion to clear, so row counts are real. */
async function settleMotion(page: Page): Promise<void> {
  await expect.poll(async () => (await readDom(page)).ghostRows, { timeout: 8_000 }).toBe(0);
}

/** Real control intents from the page's own origin, so SSE delivers them here. */
async function postControls(page: Page, runId: string, sliceId: string, count: number): Promise<number[]> {
  return page.evaluate(
    async ({ run, slice, n }) => {
      const statuses: number[] = [];
      for (let i = 0; i < n; i++) {
        const res = await fetch(`/api/runs/${run}/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "skip", sliceId: slice }),
        });
        statuses.push(res.status);
        await res.json().catch(() => undefined);
      }
      return statuses;
    },
    { run: runId, slice: sliceId, n: count },
  );
}

function missingDom(dom: DomView): string[] {
  const out: string[] = [];
  if (!dom.hasLive) out.push("dom:.omp-deck-live");
  if (!dom.hasLanes) out.push("dom:.omp-deck-lane");
  if (dom.rows > 0 && dom.keyedRows === 0) out.push("dom:.omp-live-row[data-key]");
  return out;
}

/**
 * Fail a step immediately when the piece of the contract it needs is absent:
 * the alternative is a 15 s poll timeout whose message says nothing about
 * which field never landed.
 */
function requireContract(missing: string[], needs: string[]): void {
  const hit = missing.filter((item) => needs.some((need) => item.includes(need)));
  if (hit.length > 0) throw new Error(`deck d03 contract missing: ${hit.join(", ")}`);
}

interface HarnessInfo {
  projectDir: string;
  url: string;
  port: number;
  assetMode: string;
}

/** Spawn the fixture host and wait for the port to answer `/api/health`. */
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
      // The port is bound synchronously, so this normally succeeds at once.
      const res = await fetch(`${info.url}/api/health`);
      if (res.ok) return { proc, info };
    } catch {
      // Not bound yet: poll again below.
    }
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 250);
    await pause.promise;
  }
  proc.kill("SIGTERM");
  throw new Error(`dashboard server at ${info.url} never became healthy`);
}

test.describe("deck d03 workflow", () => {
  test.use({ baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } });
  test.describe.configure({ mode: "serial", timeout: 90_000 });

  let projectDir = "";
  let harness: ChildProcess | null = null;
  let serverInfo: HarnessInfo | null = null;

  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "ompo-deck-d03-"));
    createRun(projectDir, parseRoadmap(ROADMAP), RUN_ID);
    const started = await startHarness(projectDir);
    harness = started.proc;
    serverInfo = started.info;
  });

  test.afterAll(() => {
    harness?.kill("SIGTERM");
    harness = null;
  });

  test("focus, the bounded live window and the event→visible pipeline", async ({ page }) => {
    const steps: StepRecord[] = [];
    const churn: Record<string, unknown> = {};
    const begin = (step: string, name: string): StepRecord => {
      const record: StepRecord = { step, name, ok: true, errors: [], numbers: {} };
      steps.push(record);
      return record;
    };
    const attempt = async (record: StepRecord, body: () => Promise<void>): Promise<void> => {
      try {
        await body();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record.ok = false;
        record.errors.push(message.split("\n")[0] ?? message);
      }
    };
    // Numbers first, assertions second: a step that fails its contract still
    // contributes whatever the page could measure.
    const capture = async (record: StepRecord, label: string): Promise<Capture> => {
      const [hook, sample, dom] = await Promise.all([readHook(page), readSample(page, "snapshot"), readDom(page)]);
      const captured: Capture = {
        frames: hook?.frames ?? null,
        commits: sample?.commits ?? null,
        mutations: sample?.mutations ?? null,
        longTasks: sample?.longTasks ?? null,
        latencyMs: sample?.latencyMs ?? null,
        latencyStages: sample?.latencyStages ?? null,
        domElements: sample?.domElements ?? null,
        markedEvents: sample?.markedEvents ?? null,
        liveCount: hook?.liveCount ?? null,
        focused: hook?.focused ?? null,
        pinned: hook?.pinned ?? null,
        frozen: hook?.frozen ?? null,
        camera: hook?.camera ?? null,
        stationSegments: hook?.stationSegments ?? null,
        liveRows: hook?.liveRows ?? null,
        logLines: hook?.logLines ?? null,
        dataLive: dom.dataLive,
        domRows: dom.rows,
      };
      record.numbers[label] = captured;
      return captured;
    };

    const alphaDir = sliceDir(projectDir, RUN_ID, SLICE_A);
    const betaDir = sliceDir(projectDir, RUN_ID, SLICE_B);
    mkdirSync(alphaDir, { recursive: true });
    mkdirSync(betaDir, { recursive: true });
    const alphaLog = join(alphaDir, "worker-1-g0.log");
    const betaLog = join(betaDir, "worker-1-g0.log");

    await page.goto("/?surface=deck");
    await page.locator(".omp-deck-canvas").waitFor({ timeout: 30_000 });
    await page.locator(".omp-deck-hud").waitFor();
    await page.waitForTimeout(1_000); // intro fade + first poll

    const initial = await readHook(page);
    const contractMissing = initial?.missing ?? ["window.__ompoDeck"];
    let tier: string | null = initial?.tier ?? null;
    let alphaCapture: Capture | null = null;
    let capture1: Capture | null = null;
    let capture3: Capture | null = null;
    let capture4: Capture | null = null;

    // ---- 1. the worker starts and becomes the primary object ---------------
    const s1 = begin("1", "claim → the deck frames the active worker");
    await attempt(s1, async () => {
      storeApi.claimSlice(projectDir, RUN_ID, SLICE_A);
      await page.waitForTimeout(2_000); // SSE, then the deck's own projection
      const dom = await readDom(page);
      const captured = await capture(s1, "at");
      alphaCapture = captured;
      capture1 = captured;
      const hook = await readHook(page);
      tier = hook?.tier ?? tier;
      s1.numbers.lanes = dom.lanes;
      s1.numbers.stationOnScreen = await screenPosition(page, SLICE_A);
      requireContract([...contractMissing, ...missingDom(dom)], [
        "focused",
        "liveCount",
        "stationSegments",
        "dom:.omp-deck-live",
        "dom:.omp-deck-lane",
      ]);

      await expect.poll(async () => (await readHook(page))?.focused, { timeout: 15_000 }).toBe(SLICE_A);
      await expect
        .poll(async () => (await readDom(page)).lanes.find((lane) => lane.focused)?.id ?? null, { timeout: 15_000 })
        .toBe(SLICE_A);
      await expect.poll(async () => (await readHook(page))?.liveCount ?? -1, { timeout: 15_000 }).toBe(1);

      const point = await screenPosition(page, SLICE_A);
      expect(point, `station ${SLICE_A} is not on screen`).not.toBeNull();
      const box = await page.locator(".omp-deck").boundingBox();
      const width = box?.width ?? 0;
      const height = box?.height ?? 0;
      expect(width).toBeGreaterThan(0);
      expect(point?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect(point?.x ?? -1).toBeLessThanOrEqual(width);
      expect(point?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect(point?.y ?? -1).toBeLessThanOrEqual(height);
      expect((await readHook(page))?.stationSegments ?? -1).toBeGreaterThan(0);
    });

    // ---- 2. events and live output churn; text never drives the loop -------
    const s2 = begin("2", "transcript churn plus a handoff, loop stays idle");
    await attempt(s2, async () => {
      writeFileSync(alphaLog, progress(transcriptLines(0, 8), SLICE_A, undefined));
      storeApi.recordHandoff(projectDir, RUN_ID, SLICE_A, "context cap 94000/96000 — handoff to g1");
      await page.waitForTimeout(2_600); // one tail poll
      await settleMotion(page);
      const before = await readDom(page);
      const framesBefore = (await readHook(page))?.frames ?? -1;
      s2.numbers.framesBefore = framesBefore;
      s2.numbers.rowsBefore = before.rows;

      // Three bursts over ~3 s: the window must move, the renderer must not.
      for (let burst = 0; burst < 3; burst++) {
        appendFileSync(alphaLog, progress(transcriptLines(10 + burst * 10, 10), SLICE_A, undefined));
        await page.waitForTimeout(1_000);
      }
      await settleMotion(page);
      const after = await readDom(page);
      const framesAfter = (await readHook(page))?.frames ?? -1;
      s2.numbers.framesAfter = framesAfter;
      s2.numbers.rowsAfter = after.rows;
      s2.numbers.logLines = (await readHook(page))?.logLines ?? null;
      s2.numbers.rowsChanged =
        after.keys.join("|") !== before.keys.join("|") || after.text.join("|") !== before.text.join("|");
      s2.numbers.handoffVisible = before.text.concat(after.text).some((line) => line.includes("handoff"));
      await capture(s2, "at");

      requireContract([...contractMissing, ...missingDom(after)], [
        "focused",
        "liveRows",
        "logLines",
        "dom:.omp-deck-live",
        "dom:.omp-live-row[data-key]",
      ]);
      expect(after.rows).toBeLessThanOrEqual(5);
      expect(after.rows).toBeGreaterThan(0);
      expect(s2.numbers.rowsChanged).toBe(true);
      // Acceptance #5 of the slice: 3 s of transcript growth buys no frame.
      expect(framesAfter).toBe(framesBefore);
    });

    // ---- 3. the status change, and the window's source follows it ----------
    const s3 = begin("3", "worker_finished → verifying, gate transcript becomes the source");
    await attempt(s3, async () => {
      const logNameBefore = (await readDom(page)).logName;
      storeApi.workerFinished(projectDir, RUN_ID, SLICE_A, `slices/${SLICE_A}/report.json`, {
        exit: 0,
        durationMs: 4_200,
      });
      const logs = join(alphaDir, "logs");
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, "verify-1.log"), progress(VERIFY_LINES, SLICE_A, "verify"));
      await page.waitForTimeout(2_600);
      const dom = await readDom(page);
      s3.numbers.logNameBefore = logNameBefore;
      s3.numbers.lanes = dom.lanes;
      capture3 = await capture(s3, "at");
      requireContract([...contractMissing, ...missingDom(dom)], [
        "stationSegments",
        "liveCount",
        "dom:.omp-deck-live",
        "dom:.omp-deck-lane",
      ]);

      const segmentsBefore = alphaCapture?.stationSegments ?? 0;
      await expect
        .poll(
          async () =>
            (await readDom(page)).lanes.some(
              (lane) => lane.id === SLICE_A && lane.status.includes("verifying"),
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect.poll(async () => (await readDom(page)).logName, { timeout: 15_000 }).toContain("verify-1.log");
      await expect
        .poll(async () => (await readHook(page))?.stationSegments ?? -1, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(segmentsBefore);
    });

    // ---- 4. the failure is legible, reason included ------------------------
    const s4 = begin("4", "verify_failed → the deck says failed, with the reason");
    await attempt(s4, async () => {
      storeApi.verifyFailed(projectDir, RUN_ID, SLICE_A, `slices/${SLICE_A}/verdict.json`, REASON);
      writeFileSync(
        join(alphaDir, "verdict.json"),
        JSON.stringify(
          { pass: false, steps: [{ name: "bun test", exit: 1, timedOut: false, outputTail: "2 tests failed" }] },
          null,
          2,
        ),
      );
      await page.waitForTimeout(2_600);
      const dom = await readDom(page);
      const deckText = `${dom.lineText} ${dom.laneText} ${dom.hudText}`;
      s4.numbers.lineText = dom.lineText;
      s4.numbers.lanes = dom.lanes;
      s4.numbers.reasonInDeck = deckText.includes(REASON);
      capture4 = await capture(s4, "at");

      expect(deckText).toContain("failed");
      expect(deckText).toContain(REASON);
    });

    // ---- 5a. another worker becomes active ---------------------------------
    const s5 = begin("5", "claim B → focus moves; B completes → the run quiesces");
    await attempt(s5, async () => {
      writeFileSync(betaLog, progress(transcriptLines(0, 6), SLICE_B, undefined));
      storeApi.claimSlice(projectDir, RUN_ID, SLICE_B);
      await page.waitForTimeout(2_600);
      const dom = await readDom(page);
      s5.numbers.lanes = dom.lanes;
      await capture(s5, "claim");
      requireContract([...contractMissing, ...missingDom(dom)], [
        "focused",
        "liveCount",
        "dom:.omp-deck-live",
        "dom:.omp-deck-lane",
      ]);

      // A is terminal, B is live: focus must have moved without a pin.
      await expect.poll(async () => (await readHook(page))?.pinned ?? null, { timeout: 15_000 }).toBeNull();
      await expect.poll(async () => (await readHook(page))?.focused, { timeout: 15_000 }).toBe(SLICE_B);
      await expect.poll(async () => (await readHook(page))?.liveCount ?? -1, { timeout: 15_000 }).toBe(1);
      await expect
        .poll(async () => (await readDom(page)).lanes.find((lane) => lane.focused)?.id ?? null, { timeout: 15_000 })
        .toBe(SLICE_B);
    });

    // ---- 6. focus retention: selection, hover, camera, scroll --------------
    const s6 = begin("6", "focus survives selection, hover, output growth and scroll-back");
    await attempt(s6, async () => {
      requireContract([...contractMissing, ...missingDom(await readDom(page))], [
        "focused",
        "camera",
        "dom:.omp-deck-live",
        "dom:.omp-live-row[data-key]",
      ]);

      // (a) select another pad: the live window is keyed to focus, not selection.
      const before = await readDom(page);
      const selectedBefore = (await readHook(page))?.selected ?? null;
      const route = await selectPad(page, SLICE_D);
      await page.waitForTimeout(1_500);
      await settleMotion(page);
      const afterSelect = await readDom(page);
      s6.numbers.selection = {
        route,
        selectedBefore,
        selectedAfter: (await readHook(page))?.selected ?? null,
        rowsBefore: before.keys,
        rowsAfter: afterSelect.keys,
        scrollBefore: before.scrollTop,
        scrollAfter: afterSelect.scrollTop,
      };
      expect(afterSelect.keys).toEqual(before.keys);
      expect(afterSelect.scrollTop).toBe(before.scrollTop);

      // (b) hover a neighbour: hover is feedback, focus is not hover.
      const focusBefore = (await readHook(page))?.focused ?? null;
      let hoverTarget: string | null = null;
      for (const candidate of [SLICE_A, SLICE_D, SLICE_C]) {
        if (await hoverPad(page, candidate)) {
          hoverTarget = candidate;
          break;
        }
      }
      await page.waitForTimeout(600);
      const hookHover = await readHook(page);
      s6.numbers.hover = {
        hoverTarget,
        hover: hookHover?.hover ?? null,
        focusedBefore: focusBefore,
        focusedAfter: hookHover?.focused ?? null,
      };
      expect(hoverTarget, "no neighbouring pad is on screen to hover").not.toBeNull();
      expect(hookHover?.hover ?? null).toBe(hoverTarget);
      expect(hookHover?.focused ?? null).toBe(focusBefore);

      // (c) output growth must not yank the camera.
      const cameraBefore = JSON.stringify((await readHook(page))?.camera ?? null);
      appendFileSync(betaLog, progress(transcriptLines(20, 20), SLICE_B, undefined));
      await page.waitForTimeout(2_800);
      const cameraAfter = JSON.stringify((await readHook(page))?.camera ?? null);
      const rowsAfterGrowth = await readDom(page);
      s6.numbers.camera = { before: cameraBefore, after: cameraAfter };
      s6.numbers.rowsAfterGrowth = rowsAfterGrowth.keys;
      expect(cameraAfter).toBe(cameraBefore);
      expect(rowsAfterGrowth.keys.join("|")).not.toBe(before.keys.join("|"));

      // (d) expand, scroll away from live, keep the position under new output.
      await page.locator(".omp-deck").press("e");
      await expect.poll(async () => (await readDom(page)).expanded, { timeout: 8_000 }).toBe("true");
      await page.waitForTimeout(800);
      const scrolled = await page.evaluate(() => {
        const log = document.querySelector(".omp-deck-live .omp-livefeed-log") as HTMLElement | null;
        if (!log) return null;
        log.scrollTop = Math.max(0, Math.round((log.scrollHeight - log.clientHeight) * 0.4));
        return Math.round(log.scrollTop);
      });
      await expect.poll(async () => (await readDom(page)).follow, { timeout: 8_000 }).toBe("false");
      appendFileSync(betaLog, progress(transcriptLines(60, 20), SLICE_B, undefined));
      await page.waitForTimeout(2_800);
      const parked = await readDom(page);
      s6.numbers.scroll = {
        scrolled,
        scrollTop: parked.scrollTop,
        distanceFromBottom: parked.distanceFromBottom,
        follow: parked.follow,
        rows: parked.rows,
      };
      expect(parked.follow).toBe("false");
      expect(parked.distanceFromBottom ?? 0).toBeGreaterThan(50);

      await page.locator(".omp-deck-live .omp-livefeed-jump").first().click();
      await expect.poll(async () => (await readDom(page)).follow, { timeout: 8_000 }).toBe("true");
      const resumed = await readDom(page);
      s6.numbers.followResumed = { follow: resumed.follow, distanceFromBottom: resumed.distanceFromBottom };
      expect(resumed.distanceFromBottom ?? 999).toBeLessThanOrEqual(24);
    });

    // ---- 7. the window stays bounded under transcript + control churn ------
    const s7 = begin("7", "420 transcript lines and 50 real control intents, bounded DOM");
    await attempt(s7, async () => {
      if ((await readDom(page)).expanded === "true") await page.locator(".omp-deck").press("e");
      await page.waitForTimeout(600);
      const latestBefore = await readSample(page, "latest");
      s7.numbers.domBefore = (await readDom(page)).rows;

      const statuses: number[] = [];
      for (let burst = 0; burst < 6; burst++) {
        appendFileSync(betaLog, progress(transcriptLines(100 + burst * 70, 70), SLICE_B, undefined));
        statuses.push(...(await postControls(page, RUN_ID, SLICE_C, burst === 5 ? 5 : 9)));
        await page.waitForTimeout(700);
      }
      await page.waitForTimeout(2_600); // one more tail poll, then settle
      await settleMotion(page);
      const compact = await readDom(page);
      const latestAfter = await readSample(page, "latest");
      const controlStatuses = statuses.reduce<Record<string, number>>((acc, code) => {
        acc[String(code)] = (acc[String(code)] ?? 0) + 1;
        return acc;
      }, {});
      s7.numbers.domAfter = compact.rows;
      s7.numbers.controlPosts = statuses.length;
      s7.numbers.controlStatuses = controlStatuses;
      churn.transcriptLines = 420;
      churn.controlPosts = statuses.length;
      churn.controlStatuses = controlStatuses;
      churn.rowsCompact = compact.rows;
      churn.domElements = [latestBefore?.domElements ?? null, latestAfter?.domElements ?? null];
      const beforeElements = latestBefore?.domElements ?? 0;
      const afterElements = latestAfter?.domElements ?? 0;
      churn.domGrowthRatio = beforeElements > 0 ? Math.round((afterElements / beforeElements) * 1000) / 1000 : null;

      requireContract([...contractMissing, ...missingDom(compact)], ["dom:.omp-deck-live"]);
      expect(compact.rows).toBeLessThanOrEqual(5);
      expect(compact.rows).toBeGreaterThan(0);
      // The deck's DOM is bounded, not monotonically growing, under churn.
      expect(beforeElements).toBeGreaterThan(0);
      expect(afterElements).toBeLessThanOrEqual(Math.round(beforeElements * 1.3));

      await page.locator(".omp-deck").press("e");
      await expect.poll(async () => (await readDom(page)).expanded, { timeout: 8_000 }).toBe("true");
      await page.waitForTimeout(1_200);
      await settleMotion(page);
      const expanded = await readDom(page);
      s7.numbers.expandedRows = expanded.rows;
      churn.rowsExpanded = expanded.rows;
      expect(expanded.rows).toBeLessThanOrEqual(400);

      await capture(s7, "at");
    });

    // ---- 5b. B completes; the run is quiescent, the window still reads -----
    await attempt(s5, async () => {
      writeFileSync(
        join(betaDir, "verdict.json"),
        JSON.stringify({ pass: true, steps: [{ name: "bun test", exit: 0, timedOut: false, outputTail: "ok" }] }, null, 2),
      );
      storeApi.verifyPassed(projectDir, RUN_ID, SLICE_B, `slices/${SLICE_B}/verdict.json`);
      await page.waitForTimeout(2_600);
      const dom = await readDom(page);
      s5.numbers.quiescentDom = { rows: dom.rows, dataLive: dom.dataLive, logName: dom.logName, lanes: dom.lanes };
      await capture(s5, "quiescent");

      requireContract([...contractMissing, ...missingDom(dom)], ["liveCount", "dom:.omp-deck-live"]);
      await expect.poll(async () => (await readHook(page))?.liveCount ?? -1, { timeout: 15_000 }).toBe(0);
      await expect.poll(async () => (await readDom(page)).dataLive, { timeout: 15_000 }).toBe("false");
      expect(dom.rows).toBeGreaterThan(0);
    });

    // ---- 8. the event→visible pipeline, from the page's own instrument -----
    const s8 = begin("8", "latency samples carried by the step 1/3/4 windows");
    await attempt(s8, async () => {
      const windows = [
        { step: "1", capture: capture1 },
        { step: "3", capture: capture3 },
        { step: "4", capture: capture4 },
      ].map(({ step, capture: captured }) => ({
        step,
        latencyMs: captured?.latencyMs ?? null,
        markedEvents: captured?.markedEvents ?? null,
        latencyStages: captured?.latencyStages ?? null,
      }));
      const latencySamples = windows.reduce((sum, window) => sum + (window.latencyMs?.samples ?? 0), 0);
      s8.numbers.windows = windows;
      s8.numbers.latencySamples = latencySamples;
      s8.numbers.latencyStagesPresent = windows.some((window) => window.latencyStages !== null);
      s8.numbers.final = await readSample(page, "snapshot");
      // `latencyStages` is optional by contract; `latencyMs` is not.
      expect(latencySamples).toBeGreaterThan(0);
    });

    const failed = steps.filter((record) => !record.ok);
    mkdirSync(join(process.cwd(), "captures", "deck-validation"), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      runId: RUN_ID,
      projectDir,
      tier,
      port: PORT,
      url: serverInfo?.url ?? null,
      assetMode: serverInfo?.assetMode ?? null,
      contractMissing,
      steps,
      churn,
      failures: failed.map((record) => `${record.step}: ${record.errors.join("; ")}`),
    };
    writeFileSync(join(process.cwd(), ARTIFACT), JSON.stringify(payload, null, 2) + "\n");
    await page.screenshot({ path: join(process.cwd(), SCREENSHOT), fullPage: true });
    for (const record of steps) {
      console.log(`deck-d03 step ${record.step} ${record.ok ? "ok" : "FAIL"} ${JSON.stringify(record.numbers)}`);
    }

    if (failed.length > 0) {
      throw new Error(
        `${failed.length}/${steps.length} deck workflow steps failed: ` +
          failed.map((record) => `${record.step} [${record.errors[0] ?? "unknown"}]`).join("; "),
      );
    }
  });

  /**
   * M6 (roadmap §0.4), the slice's central performance claim at full scale: a
   * worker writing 2 000 transcript lines in 60 s must buy **zero** frames, and
   * the window must stay a window while it happens. Run against the same run as
   * the workflow test — `delta` is still pending after it, so this is a real
   * claim, a real worker log growing on disk, and the real tail poll reading it.
   */
  test("M6: 2 000 transcript lines over 60 s render no frames", async ({ page }) => {
    test.setTimeout(240_000);
    const deltaDir = sliceDir(projectDir, RUN_ID, SLICE_D);
    mkdirSync(deltaDir, { recursive: true });
    const log = join(deltaDir, "worker-1-g0.log");

    await page.goto("/?surface=deck");
    await page.locator(".omp-deck-canvas").waitFor({ timeout: 30_000 });
    await page.locator(".omp-deck-hud").waitFor();
    await page.waitForTimeout(800);

    storeApi.claimSlice(projectDir, RUN_ID, SLICE_D);
    await expect.poll(async () => (await readHook(page))?.focused, { timeout: 20_000 }).toBe(SLICE_D);
    await page.waitForTimeout(600);

    writeFileSync(log, progress(transcriptLines(0, 100), SLICE_D, undefined), "utf8");
    await page.waitForTimeout(2_600); // one tail poll, so the window is populated

    // What the window is actually following, from the server's own answer and
    // from the page: a window with no source would make "no frames" vacuous.
    const tail = await page.request.get(`/api/runs/${RUN_ID}/slices/${SLICE_D}/log?tail=5`);
    const tailBody = (await tail.json()) as { name: string | null; lines: string[] };
    const framesBefore = (await readHook(page))?.frames ?? -1;
    const digestBefore = (await readHook(page))?.digest ?? null;
    const focusedBefore = (await readHook(page))?.focused ?? null;
    const linesBefore = (await readHook(page))?.logLines ?? -1;
    await readSample(page, "snapshot"); // start the measured window
    const started = Date.now();
    let linesWritten = 100;
    while (Date.now() - started < 60_000) {
      appendFileSync(log, progress(transcriptLines(linesWritten, 34), SLICE_D, undefined), "utf8");
      linesWritten += 34;
      await page.waitForTimeout(1_000);
    }
    await page.waitForTimeout(2_600); // let the final poll land

    const after = await readSample(page, "snapshot");
    const hook = await readHook(page);
    const dom = await readDom(page);
    const numbers = {
      linesWritten,
      windowMs: Date.now() - started,
      source: { name: tailBody.name, tailLines: tailBody.lines.length, linesBefore, focusedBefore, digestBefore },
      frames: { before: framesBefore, after: hook?.frames ?? null, delta: (hook?.frames ?? 0) - framesBefore },
      after: { focused: hook?.focused ?? null, digest: hook?.digest ?? null, liveCount: hook?.liveCount ?? null },
      window: {
        frames: after?.frames ?? null,
        commits: after?.commits ?? null,
        commitsPerSec: after?.commitsPerSec ?? null,
        mutations: after?.mutations ?? null,
        mutationsPerSec: after?.mutationsPerSec ?? null,
        longTasks: after?.longTasks ?? null,
        domElements: after?.domElements ?? null,
      },
      bounded: { rows: dom.rows, logLines: hook?.logLines ?? null, expanded: dom.expanded },
    };
    writeFileSync(join(process.cwd(), TEXT_ARTIFACT), JSON.stringify({ generatedAt: new Date().toISOString(), runId: RUN_ID, sliceId: SLICE_D, ...numbers }, null, 2) + "\n");
    console.log(`deck-text-window ${JSON.stringify(numbers)}`);

    // The claim: text growth cannot change the model, so it buys no frames.
    // The digest is the exact form of that claim (identical before and after);
    // the frame count allows a single frame for the machine's own resize path
    // (the `d02` finding: growing the viewport reallocates the backing store),
    // which is not a reaction to the transcript. Measured: 0 in the instrumented
    // runs, 1 once in a run without diagnostics.
    expect(hook?.digest ?? "?").toBe(digestBefore);
    expect((hook?.frames ?? -1) - framesBefore).toBeLessThanOrEqual(1);
    // And the window stays bounded while 2 000 lines go by.
    expect(dom.rows).toBeLessThanOrEqual(5);
    expect(hook?.logLines ?? 0).toBeGreaterThan(0);
    expect(hook?.logLines ?? 0).toBeLessThanOrEqual(400);
    expect(after?.commitsPerSec ?? 0).toBeLessThanOrEqual(4);
    expect(after?.mutationsPerSec ?? 0).toBeLessThanOrEqual(60);
  });
});
