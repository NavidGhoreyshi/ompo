import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spec owns its server (the `d06`/`d07` harness): it holds the run's lock,
// synthesises the orchestrator's own outcome events, and ages a transcript to
// make a worker wedge — none of which the shared `webServer` fixture can do.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { parseRoadmap } from "../../src/parse.ts";
import { appendEvent, createRun, runDir, storeApi } from "../../src/store.ts";
import type { DeckSample } from "../../web/src/scene/instrument.ts";

/**
 * Control from the deck (roadmap slice `d08`).
 *
 * The acceptance questions this file answers, each on the real surface:
 *
 *   1. does a press in the deck send the *dashboard's* request — the same
 *      bytes, the same kinds, the same path, with the same confirmation?;
 *   2. is a queued intent never reported as success before the orchestrator's
 *      own `control_applied`, and does a `control_rejected` become a visible,
 *      dismissible alert row carrying the server's message verbatim?;
 *   3. is control live-only — a recorded cursor disables every action and says
 *      why, and a quiescent run offers the recovery command instead of
 *      loop-local buttons that would always be refused?;
 *   4. does the wedged-loop recovery appear only when the run is live *and*
 *      something is stalled, with its reason and its confirm intact?
 *
 * `captures/deck-validation/d08-control.json` holds the recorded bodies.
 */

const PORT = 4484;
const RUN_ID = "d08-control";
const OTHER_RUN = "d08-probe";
const ARTIFACT = join("captures", "deck-validation", "d08-control.json");
const SCREENSHOT = join("captures", "deck-d08-control.png");
/** The 202 the stubbed endpoint hands back; the seq proves the row echoes it. */
const STUB_SEQ = 900;

const report: Record<string, unknown> = { runId: RUN_ID, otherRun: OTHER_RUN, port: PORT };

const ROADMAP = `# Deck d08 control fixture

## [alpha] Alpha — the slice that finished
Effort: lo
Agent: task
Verify: bun test
Scenario: a terminal state, so the deck has a done slice to offer a rejected retry for.

## [beta] Beta — the slice that failed
Effort: lo
Agent: task
Verify: bun test
Scenario: the retry target — a failed slice is the one retry legitimately applies to.

## [gamma] Gamma — the running worker
Effort: lo
Agent: task
Verify: bun test
Scenario: the worker that is made stale, so the run reads live-but-stalled.

## [delta] Delta — still pending
Effort: lo
Agent: sonic
Verify: bun test
Scenario: a slice nothing has claimed.
`;

interface ControlRequest {
  path: string;
  method: string;
  body: string | null;
}

/** Every control POST the page makes, in order, with its raw body. */
function watchControl(page: Page, log: ControlRequest[]): void {
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().includes("/control")) return;
    log.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postData() });
  });
}

/** The run's lock file, held by *this* process — the fixture's "live loop". */
function lockFile(projectDir: string): string {
  return `${runDir(projectDir, RUN_ID)}.lock`;
}

function takeLock(projectDir: string): void {
  writeFileSync(lockFile(projectDir), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
}

function releaseLock(projectDir: string): void {
  rmSync(lockFile(projectDir), { force: true });
}

async function startHarness(projectDir: string): Promise<{ proc: ChildProcess; url: string }> {
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
  const info = await ready.promise;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const res = await fetch(`${info.url}/api/health`);
      if (res.ok) return { proc, url: info.url };
    } catch {
      // Not bound yet.
    }
    await Bun.sleep(125);
  }
  throw new Error(`harness never answered /api/health at ${info.url}`);
}

/** The deck's own instrument sample (`d01`): frames, commits, DOM, renderer. */
function readSample(page: Page): Promise<DeckSample> {
  return page.evaluate(() => {
    const instrument = (window as unknown as { __ompoDeck?: { instrument?: { snapshot(): DeckSample } } }).__ompoDeck?.instrument;
    if (!instrument) throw new Error("window.__ompoDeck.instrument is not installed");
    return instrument.snapshot();
  });
}

async function gotoDeck(page: Page): Promise<void> {
  await page.goto("/?surface=deck");
  await page.locator(".omp-deck-canvas").waitFor();
  // The temporal window is a second fetch; the surface is settled when its
  // ribbon exists (the `d07` trap: sampling before that compares two worlds).
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __ompoDeck?: { ribbon: number } }).__ompoDeck?.ribbon ?? 0), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(600); // the framing flight and the intro fade
}

/**
 * Select a pad through the DOM mirror (focus + Enter) — the deck's own
 * keyboard/AT path, and the only one an operator without a pointer has.
 */
async function selectSlice(page: Page, id: string): Promise<void> {
  const row = page.locator(".omp-deck-mirror button").filter({ hasText: id }).first();
  await row.focus();
  await row.press("Enter");
  await expect(page.locator(".omp-deck-line")).toContainText(id);
}

const deckButton = (page: Page, action: string) => page.locator(`.omp-deck-control [data-action="${action}"]`);

/** Press an action on the deck's bar, once for a plain one and twice for a confirmed one. */
async function deckPress(page: Page, action: string, confirms = false): Promise<void> {
  await deckButton(page, action).click();
  if (confirms) await deckButton(page, action).click();
}

/** Press an action on the dashboard's own `ControlPanel` (the inspector's copy). */
async function dashboardPress(page: Page, label: string, confirms = false): Promise<void> {
  const panel = page.locator("#omp-inspector");
  await panel.getByRole("button", { name: label, exact: true }).click();
  if (confirms) await panel.getByRole("button", { name: `Confirm ${label.toLowerCase()}`, exact: true }).click();
}

async function typeReason(page: Page, where: "dashboard" | "deck", text: string): Promise<void> {
  const input =
    where === "dashboard"
      ? page.locator('#omp-inspector input[aria-label="Control reason"]')
      : page.locator(".omp-deck-control-reason");
  await input.fill(text);
}

/** The run's statuses as the store reports them — "a press alone changes nothing". */
async function storeStatuses(page: Page): Promise<Record<string, string>> {
  const res = await page.request.get(`/api/runs/${RUN_ID}`);
  const body = (await res.json()) as { slices: { id: string; status: string }[] };
  return Object.fromEntries(body.slices.map((slice) => [slice.id, slice.status]));
}

test.describe("deck control", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 } });

  let projectDir = "";
  let harness: ChildProcess | null = null;

  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "ompo-deck-d08-"));
    const sliceFile = (run: string, slice: string, name: string, text: string): void => {
      const target = join(projectDir, ".omp", "roadmap", "runs", run, "slices", slice);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, name), text, "utf8");
    };
    const reportJson = (summary: string): string =>
      JSON.stringify({ summary, done: true, filesChanged: [], testsRun: ["bun test"], deferred: [], followUps: [] });

    // A second run so a run switch has somewhere to go.
    createRun(projectDir, parseRoadmap(`## [only] Only slice\nEffort: lo\nAgent: sonic\nVerify: bun test\nbody\n`), OTHER_RUN);
    storeApi.claimSlice(projectDir, OTHER_RUN, "only");
    storeApi.workerFinished(projectDir, OTHER_RUN, "only", "slices/only/report.json", { exit: 0, durationMs: 1_000 });
    storeApi.verifyPassed(projectDir, OTHER_RUN, "only", "slices/only/verdict.json");

    createRun(projectDir, parseRoadmap(ROADMAP), RUN_ID);
    storeApi.claimSlice(projectDir, RUN_ID, "alpha");
    storeApi.workerFinished(projectDir, RUN_ID, "alpha", "slices/alpha/report.json", { exit: 0, durationMs: 42_000 });
    storeApi.verifyPassed(projectDir, RUN_ID, "alpha", "slices/alpha/verdict.json");
    sliceFile(RUN_ID, "alpha", "report.json", reportJson("alpha done"));

    storeApi.claimSlice(projectDir, RUN_ID, "beta");
    storeApi.workerFinished(projectDir, RUN_ID, "beta", "slices/beta/report.json", { exit: 1, durationMs: 9_000 });
    storeApi.terminalFail(projectDir, RUN_ID, "beta", "gate bun test failed — 2 tests");

    storeApi.claimSlice(projectDir, RUN_ID, "gamma");
    sliceFile(RUN_ID, "gamma", "worker-1-g0.log", "  [gamma] turn 1…\n  [gamma] tool read: web/src/scene/ControlBar.tsx\n");

    // The run reads live for every spec that needs a loop: the lock owner is
    // this process, which is alive for the whole file (`lockHeld`).
    takeLock(projectDir);

    const started = await startHarness(projectDir);
    harness = started.proc;
  });

  test.afterAll(() => {
    harness?.kill("SIGTERM");
    harness = null;
    mkdirSync(join("captures", "deck-validation"), { recursive: true });
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  });

  test("a press in the deck is the dashboard's own request", async ({ page }) => {
    test.setTimeout(180_000);
    const requests: ControlRequest[] = [];
    // The control endpoint is stubbed: this spec is about the *request* the two
    // surfaces produce, and a real 202 would queue intents nothing drains.
    let seq = STUB_SEQ;
    await page.route("**/api/runs/*/control", async (route) => {
      const body = (route.request().postData() ?? "{}") as string;
      const kind = (JSON.parse(body) as { kind?: string }).kind ?? "retry";
      seq += 1;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ seq, kind, applied: "queued" }),
      });
    });
    watchControl(page, requests);

    await gotoDeck(page);
    await selectSlice(page, "beta");
    await expect(page.locator(".omp-deck-control")).toHaveAttribute("data-live", "true");
    // A healthy live run offers no recovery: that is `d08`'s gate on restart-loop.
    await expect(deckButton(page, "restart-loop")).toHaveCount(0);

    // The dashboard's ControlPanel, on the same slice: the surface toggle keeps
    // the selection, so both surfaces are locked to `beta`.
    await page.locator(".omp-surface-toggle").click();
    await page.locator(".omp-inspector-toggle").click();
    await expect(page.locator("#omp-inspector .omp-inspector-title")).toContainText("beta");

    const pairs: { action: string; dashboard: string | null; deck: string | null }[] = [];
    /**
     * The same action on both surfaces. The reason is typed on *each* surface
     * before its press — the box is view state, so the deck's is empty after a
     * surface switch — and the two bodies must be identical.
     */
    const compare = async (opts: {
      action: string;
      reason: string;
      dashboardLabel: string;
      deckAction: string;
      confirms?: boolean;
    }): Promise<void> => {
      await typeReason(page, "dashboard", opts.reason);
      const beforeDashboard = requests.length;
      await dashboardPress(page, opts.dashboardLabel, opts.confirms === true);
      const dashboardBody = requests[requests.length - 1]?.body ?? null;
      expect(requests.length).toBe(beforeDashboard + 1);

      await page.locator(".omp-surface-toggle").click();
      await typeReason(page, "deck", opts.reason);
      const beforeDeck = requests.length;
      await deckPress(page, opts.deckAction, opts.confirms === true);
      const deckBody = requests[requests.length - 1]?.body ?? null;
      expect(requests.length).toBe(beforeDeck + 1);

      pairs.push({ action: opts.action, dashboard: dashboardBody, deck: deckBody });
      expect(deckBody).toBe(dashboardBody);
      await page.locator(".omp-surface-toggle").click();
    };

    // A reason is part of the body and is trimmed on both surfaces.
    const withReason = { reason: "  waiting on CI  " };
    await compare({ ...withReason, action: "retry", dashboardLabel: "Retry", deckAction: "retry" });
    await compare({ ...withReason, action: "skip", dashboardLabel: "Skip", deckAction: "skip", confirms: true });
    await compare({ ...withReason, action: "park", dashboardLabel: "Park", deckAction: "park" });
    await compare({ ...withReason, action: "kill", dashboardLabel: "Kill", deckAction: "kill", confirms: true });
    await compare({ ...withReason, action: "pause", dashboardLabel: "Pause", deckAction: "pause" });
    await compare({ ...withReason, action: "resume", dashboardLabel: "Resume", deckAction: "resume" });
    // `set-jobs` carries no reason: neither box is filled, so the comparison is
    // of the intent rather than of leftover text.
    await compare({ action: "set-jobs", reason: "", dashboardLabel: "Set", deckAction: "jobs-set" });

    // Criterion 5: one path, the existing kinds, nothing invented.
    const kinds = requests.map((entry) => (JSON.parse(entry.body ?? "{}") as { kind: string }).kind);
    for (const request of requests) expect(request.path).toBe(`/api/runs/${RUN_ID}/control`);
    expect([...new Set(kinds)].sort()).toEqual(["kill", "park", "pause", "resume", "retry", "set-jobs", "skip"]);

    // A destructive confirm is two interactions on both surfaces: the first
    // press arms, sends nothing, and says what the second one will do.
    await page.locator(".omp-surface-toggle").click();
    await selectSlice(page, "beta");
    const beforeArm = requests.length;
    await deckButton(page, "kill").click();
    expect(requests.length).toBe(beforeArm);
    await expect(deckButton(page, "kill")).toHaveText("Confirm kill");
    await deckButton(page, "kill").click();
    expect(requests.length).toBe(beforeArm + 1);
    await expect(deckButton(page, "kill")).toHaveText("Kill");

    report.bodyEquality = pairs;
    for (const pair of pairs) console.log(`deck-d08-body ${JSON.stringify(pair)}`);
    await page.screenshot({ path: SCREENSHOT });
  });

  test("a queued intent is not success until the orchestrator says so", async ({ page }) => {
    test.setTimeout(120_000);
    const requests: ControlRequest[] = [];
    watchControl(page, requests);

    await gotoDeck(page);
    await selectSlice(page, "beta");
    const statusesBefore = await storeStatuses(page);

    await deckPress(page, "retry");
    const queued = page.locator('.omp-deck-control-status [data-outcome="queued"]');
    await expect(queued).toHaveAttribute("data-awaiting", "true");
    await expect(queued).toContainText("waiting for the loop");
    await expect(deckButton(page, "retry")).toBeEnabled();
    const queuedText = (await queued.innerText()).replace(/\s+/g, " ");
    console.log(`deck-d08-queued ${JSON.stringify({ text: queuedText, body: requests[0]?.body ?? null })}`);

    // The press itself changed nothing durable: the store's own statuses are
    // untouched until an orchestrator event arrives.
    expect(await storeStatuses(page)).toEqual(statusesBefore);

    // The orchestrator's own outcome, appended where the loop appends it (the
    // fixture has no loop to drain the queue, so the spec plays its part).
    appendEvent(projectDir, RUN_ID, "control_applied", "beta", "retry: re-queued by the loop");
    await expect(page.locator('.omp-deck-control-status [data-outcome="applied"]')).toContainText("retry: re-queued by the loop", {
      timeout: 15_000,
    });
    await expect(page.locator('.omp-deck-control-status [data-outcome="queued"]')).toHaveCount(0);

    // A rejection is the operator's business: the row says so, and the alert
    // stack keeps the server's own message where it can be dismissed.
    await deckPress(page, "skip", true);
    const skipBody = requests[requests.length - 1]?.body ?? null;
    appendEvent(projectDir, RUN_ID, "control_rejected", "beta", "skip: slice is running — nothing to skip");
    await expect(page.locator('.omp-deck-control-status [data-outcome="rejected"]')).toContainText("skip: slice is running", {
      timeout: 15_000,
    });
    const alertRow = page.locator('.omp-deck-alerts-list [data-kind="control-rejected"]');
    await expect(alertRow).toHaveCount(1, { timeout: 15_000 });
    await expect(alertRow.locator(".omp-deck-alert-message")).toHaveText("skip: slice is running — nothing to skip");
    await alertRow.locator(".omp-deck-alert-dismiss").click();
    await expect(alertRow).toHaveCount(0);

    // Control is live-only: at a recorded cursor every action is disabled and
    // the bar says why.
    await page.locator(".omp-deck").press(",");
    await expect(page.locator('.omp-deck-control-note[data-mode="past"]')).toBeVisible();
    for (const action of ["retry", "skip", "park", "kill", "pause", "resume", "jobs-set"]) {
      await expect(deckButton(page, action)).toBeDisabled();
    }
    const beforePast = requests.length;
    expect(requests.length).toBe(beforePast);
    await page.locator(".omp-deck").press("l");
    await expect(deckButton(page, "retry")).toBeEnabled();

    report.queued = { text: queuedText, body: requests[0]?.body ?? null, skipBody, requests: requests.length };
  });

  test("the wedged-loop recovery appears only on a stalled live run, with its reason and its confirm", async ({ page }) => {
    test.setTimeout(120_000);
    const requests: ControlRequest[] = [];
    // The recovery kills the lock owner and spawns a real resume loop; in a
    // fixture that owner is this process, so the endpoint is stubbed. What is
    // asserted is the intent and its confirmation, not the kill.
    await page.route("**/api/runs/*/restart-loop", async (route) => {
      requests.push({ path: new URL(route.request().url()).pathname, method: "POST", body: route.request().postData() });
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, applied: "spawned", pid: 4242, log: "resume-stub.log" }),
      });
    });

    await gotoDeck(page);
    await expect(page.locator(".omp-deck-control")).toHaveAttribute("data-live", "true");
    await expect(deckButton(page, "restart-loop")).toHaveCount(0);

    // A live run whose worker transcript has gone quiet for longer than the
    // server's threshold: the fixture ages the file, the server derives
    // `wedged`, the deck's existing alert stack says so — and only then does
    // the recovery appear.
    const log = join(runDir(projectDir, RUN_ID), "slices", "gamma", "worker-1-g0.log");
    const old = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(log, old, old);
    await expect(page.locator('.omp-deck-alerts-list [data-kind="wedged"]')).toHaveCount(1, { timeout: 20_000 });

    const restart = deckButton(page, "restart-loop");
    await expect(restart).toHaveCount(1);
    await expect(restart).toHaveText("Restart wedged loop");

    // The confirmation, then the reason guard — the dashboard's order: the
    // first press arms, the second reports the missing reason, and neither
    // sends a request.
    await restart.click();
    await expect(restart).toHaveText("Confirm restart");
    expect(requests).toHaveLength(0);
    await restart.click();
    await expect(page.locator('.omp-deck-control-status [data-outcome="error"]')).toContainText(
      "restart-loop needs a reason (what wedged the loop)",
    );
    expect(requests).toHaveLength(0);

    await typeReason(page, "deck", "worker silent 30m, loop starved");
    await restart.click();
    await expect(restart).toHaveText("Confirm restart");
    expect(requests).toHaveLength(0);
    await restart.click();
    await expect.poll(() => requests.length, { timeout: 5_000 }).toBe(1);
    expect(JSON.parse(requests[0]!.body ?? "{}")).toEqual({ reason: "worker silent 30m, loop starved" });
    await expect(page.locator('.omp-deck-control-status [data-outcome="applied"]')).toContainText("loop restarted");

    report.restartLoop = { requests: requests.length, body: requests[0]?.body ?? null };
  });

  test("a quiescent run offers the recovery command, not loop-local actions", async ({ page }) => {
    test.setTimeout(120_000);
    releaseLock(projectDir);
    try {
      await gotoDeck(page);
      await expect(page.locator(".omp-deck-control")).toHaveAttribute("data-live", "false", { timeout: 15_000 });

      for (const action of ["pause", "resume", "jobs-set", "restart-loop"]) {
        await expect(deckButton(page, action)).toHaveCount(0);
      }
      // The slice actions stay: they are the ones a quiescent server applies
      // directly, and the dashboard offers them too.
      await expect(deckButton(page, "retry")).toHaveCount(1);

      const resume = deckButton(page, "resume-run");
      await expect(resume).toHaveCount(1);
      await expect(resume).toHaveText("Resume run");
      // The dashboard's exact sentence and command, not a paraphrase.
      const note = page.locator(".omp-deck-control-note").first();
      await expect(note).toContainText("Quiescent (no live loop) — or restart it with");
      await expect(note.locator("code")).toHaveText(`ompo resume --run ${RUN_ID}`);

      // The bar is DOM: it must cost the scene nothing while nothing moves.
      await readSample(page); // start a fresh window
      await page.waitForTimeout(1500);
      const sample = await readSample(page);
      expect(sample.frames).toBe(0);
      report.idle = { frames: sample.frames, commits: sample.commits, domElements: sample.domElements, drawCalls: sample.renderer?.drawCalls ?? null };
      console.log(`deck-d08-idle ${JSON.stringify(report.idle)}`);
      report.quiescent = { note: (await note.innerText()).replace(/\s+/g, " ") };
    } finally {
      takeLock(projectDir);
    }
  });
});
