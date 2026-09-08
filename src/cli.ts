#!/usr/bin/env bun
/**
 * ompo — OMP Roadmap Orchestrator CLI (M6).
 * Usage in ANY new project:
 *   ompo init            # scaffold ROADMAP.md + .omp/roadmap.yml
 *   ompo run             # execute roadmap headlessly (sequential slices)
 *   ompo status          # read-only store dump
 *   ompo resume          # resume latest run after crash/abort
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { parseRoadmap, sha256Hex } from "./parse.ts";
import { nextReady, summarize } from "./select.ts";
import {
  acquireLock,
  appendEvent,
  createRun,
  generateRunId,
  listRuns,
  loadRun,
  lockHeld,
  readEvents,
  releaseLock,
  saveRunDoc,
  storeApi,
  StoreLockedError,
} from "./store.ts";
import { applyIntent, drainIntents, latestSeq, requestControl, validateIntent, type ControlIntent } from "./control.ts";
import { mergeRoadmap, replanGuards } from "./replan.ts";
import { formatFinding, lintFailed, lintRoadmap } from "./lint.ts";
import { parseFaultSpec, seedSuffix } from "./faults.ts";
import { loadRoadmapConfig } from "./config.ts";
import { preflightEnv } from "./verify.ts";
import { runRoadmapLoop, type LoopOptions } from "./loop.ts";
import { runImport, runInitPlanner, resolveInitPlan, ROADMAP_TEMPLATE, ensureProjectConfig } from "./import.ts";
import { createTmuxRunner } from "./tmux.ts";
import { cmdLog } from "./log.ts";
import pkg from "../package.json";

const VERSION: string = pkg.version;
function help(): string {
  return `ompo ${VERSION} — long-horizon roadmap orchestrator for stock omp

USAGE
  ompo                                    unified TUI: plan (if needed) → run → done
  ompo init [--project DIR] [--roadmap PATH] [--replan] [--template] [--model M]
                                            planner session: survey docs → roadmap file (+ .omp/roadmap.yml)
  ompo import --from FILE [--project DIR] [--roadmap PATH] [--done IDS] [--active IDS] [--model M]
                                            agentic import: foreign roadmap (any template) → ROADMAP.md
  ompo run [FLAGS]                          run roadmap — live TUI (board + logs) in a terminal,
                                            line logs when piped
  ompo resume [FLAGS]                       resume latest run (alias: run --resume)
  ompo ctl ACTION [--run ID] [--slice ID]   live control: retry|skip|park|kill [--slice ID] [--reason R],
                                            jobs --jobs N, pause, resume (queued on live runs, applied now otherwise)
  ompo replan [--run ID] [--project DIR]    adopt an edited ROADMAP.md into a quiescent run (keeps done,
                                            resets changed slices, refuses live runs and changed in-flight slices)
  ompo lint [--project DIR] [--roadmap PATH] validate the roadmap (gates, budgets, agents, skips); exit 1 on errors
  ompo status [--run ID] [--project DIR]    read-only store dump
  ompo list [--project DIR]                 list runs
  ompo log [--run ID] [--follow] [--json]   render a run's event stream (pretty | follow | raw)
  ompo watch [--run ID] [--project DIR]     live TUI: slice board + attempt inspector

RUN FLAGS
  --roadmap PATH     roadmap markdown (default: ROADMAP.md in project)
  --project DIR      project directory (default: cwd)
  --run ID           run id (create with this id, or resume this run)
  --resume           resume existing run instead of creating one
  --slice ID         run only one slice (must be ready)
  --no-review        skip the independent post-merge review session
  --review-model M   reviewer model (default: roadmap.yml reviewModel → workerModel)
  --no-placeholders    disable dev-only placeholders for missing env creds (default: on)
  --check-env        probe every gate once for env blocks before spawning (fail fast, burn nothing)
  --seed N           deterministic RNG seed for chaos draws (suffixes fresh run ids -sN)
  --fault-inject SPEC chaos, CLI-only: fail-verify=a+b,abort-attempt=0.25,crash-after=5
  --replan           re-run the planner even if ROADMAP.md exists (overwrite)
  --template         blank 2-slice template instead of the planner session

LOG FLAGS
  --follow           tail the run's event stream (works on a live run)
  --json             raw events, one JSON object per line

IMPORT FLAGS (ompo import --from FILE)
  --from FILE        foreign roadmap in any template (required)
  --done IDS         comma/space-separated foreign keys already done (Skip: true)
  --active IDS       comma/space-separated foreign keys in progress (body = remainder)
  --model M          worker model pattern (default: .omp/roadmap.yml workerModel)
  --timeout-sec N    import worker timeout in seconds

EXIT CODES
  0 all done · 1 failures remain · 2 aborted · 3 resume-conflict (locked)

EXAMPLES
  ompo init
  ompo run --dry-run
  ompo run
  ompo status
  kill -INT <pid>; ompo resume   # crash recovery
`;
}

interface Args {
  cmd: string;
  /** First positional after the command (`ctl` action). */
  sub?: string;
  project: string;
  roadmap: string;
  run?: string;
  resume: boolean;
  slice?: string;
  dryRun: boolean;
  maxRetries?: number;
  from?: string;
  model?: string;
  done?: string;
  active?: string;
  timeoutSec?: number;
  tmux?: boolean;
  jobs?: number;
  noReview?: boolean;
  reviewModel?: string;
  noDebug?: boolean;
  noPlaceholders?: boolean;
  template?: boolean;
  replan?: boolean;
  follow?: boolean;
  logJson?: boolean;
  /** `ctl park` / `ctl retry` reason. */
  reason?: string;
  /** `run --check-env`: probe gates for env blocks before spawning. */
  checkEnv?: boolean;
  /** Deterministic RNG seed (chaos abort draws; suffixes fresh run ids). */
  seed?: number;
  /** Chaos spec `fail-verify=..,abort-attempt=..,crash-after=..`. */
  faultInject?: string;
}

function splitIds(v?: string): string[] | undefined {
  if (!v) return undefined;
  const ids = v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : undefined;
}
function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer (got "${raw}")`);
  return n;
}

function parseNonNegativeInt(raw: string, flag: string, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${flag} must be an integer 0..${max} (got "${raw}")`);
  return n;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: argv[0] ?? "tui",
    project: process.cwd(),
    roadmap: "",
    resume: false,
    dryRun: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--project" && argv[i + 1]) a.project = resolve(argv[++i]!);
    else if (t === "--roadmap" && argv[i + 1]) a.roadmap = argv[++i]!;
    else if (t === "--run" && argv[i + 1]) a.run = argv[++i]!;
    else if (t === "--resume") a.resume = true;
    else if (t === "--slice" && argv[i + 1]) a.slice = argv[++i]!;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--max-retries" && argv[i + 1]) a.maxRetries = parseNonNegativeInt(argv[++i]!, "--max-retries", 10);
    else if (t === "--from" && argv[i + 1]) a.from = argv[++i]!;
    else if (t === "--model" && argv[i + 1]) a.model = argv[++i]!;
    else if (t === "--done" && argv[i + 1]) a.done = argv[++i]!;
    else if (t === "--active" && argv[i + 1]) a.active = argv[++i]!;
    else if (t === "--timeout-sec" && argv[i + 1]) a.timeoutSec = parsePositiveInt(argv[++i]!, "--timeout-sec");
    else if (t === "--jobs" && argv[i + 1]) a.jobs = parsePositiveInt(argv[++i]!, "--jobs");
    else if (t === "--no-review") a.noReview = true;
    else if (t === "--no-debug") a.noDebug = true;
    else if (t === "--no-placeholders") a.noPlaceholders = true;
    else if (t === "--template") a.template = true;
    else if (t === "--replan") a.replan = true;
    else if (t === "--follow") a.follow = true;
    else if (t === "--json") a.logJson = true;
    else if (t === "--review-model" && argv[i + 1]) a.reviewModel = argv[++i]!;
    else if (t === "--help" || t === "-h") a.cmd = "--help";
    else if (t === "--tmux") a.tmux = true;
    else if (t === "--reason" && argv[i + 1]) a.reason = argv[++i]!;
    else if (t === "--check-env") a.checkEnv = true;
    else if (t === "--seed" && argv[i + 1]) a.seed = parseNonNegativeInt(argv[++i]!, "--seed", 2147483647);
    else if (t === "--fault-inject" && argv[i + 1]) a.faultInject = argv[++i]!;
    else if (!t.startsWith("-") && a.sub === undefined) a.sub = t;
    else throw new Error(`unknown flag ${t}`);
  }
  if (!a.roadmap) a.roadmap = join(a.project, "ROADMAP.md");
  return a;
}

async function cmdInit(a: Args): Promise<number> {
  ensureProjectConfig(a.project, (m) => console.log(m));
  const roadmapPath = a.roadmap;
  mkdirSync(dirname(roadmapPath), { recursive: true });
  const existing = existsSync(roadmapPath) ? readFileSync(roadmapPath, "utf8") : null;
  switch (resolveInitPlan({ existing, template: a.template, replan: a.replan, blankTemplate: ROADMAP_TEMPLATE })) {
    case "keep":
      console.log(`kept existing ${roadmapPath}`);
      break;
    case "template":
      writeFileSync(roadmapPath, ROADMAP_TEMPLATE, "utf8");
      console.log(`wrote ${roadmapPath} (blank template)`);
      break;
    case "plan": {
      // Agentic planner: survey project docs + tree, emit a strict roadmap.
      // Any failure falls back to the blank template — never empty-handed.
      if (existing !== null) console.log(`existing ${roadmapPath} is the untouched blank template — planning from project docs…`);
      try {
        await runInitPlanner({
          projectDir: a.project,
          roadmapPath,
          workerModel: a.model,
          timeoutMs: a.timeoutSec ? a.timeoutSec * 1000 : undefined,
          onEvent: (m) => console.log(m),
        });
      } catch (err) {
        console.error(`planner failed (${String((err as Error).message).slice(0, 300)}); falling back to blank template`);
        writeFileSync(roadmapPath, ROADMAP_TEMPLATE, "utf8");
        console.log(`wrote ${roadmapPath} (blank template)`);
      }
      break;
    }
  }
  // Validate the roadmap.
  const doc = parseRoadmap(readFileSync(roadmapPath, "utf8"));
  console.log(`roadmap OK: ${doc.slices.length} slices (${doc.slices.map((s) => s.id).join(", ")})`);
  console.log("next: edit ROADMAP.md, then `ompo run --dry-run`, then `ompo run`");
  return 0;
}

function latestRun(project: string): string | null {
  const runs = listRuns(project);
  return runs.length ? runs[runs.length - 1]! : null;
}

async function cmdRun(a: Args): Promise<number> {
  // (--jobs/--timeout-sec/--max-retries already validated in parseArgs.)
  if (!existsSync(a.roadmap)) {
    console.error(`roadmap not found: ${a.roadmap}\nrun \`ompo init --project ${a.project}\` first`);
    return 1;
  }
  const markdown = readFileSync(a.roadmap, "utf8");
  const parsed = parseRoadmap(markdown);
  const cfg = loadRoadmapConfig(a.project);

  // Dry-run never creates a run dir: simulate purely from the parsed doc so
  // "latest run" (resume/status/log/watch) keeps pointing at the last real run.
  if (a.dryRun) {
    const order: string[] = [];
    const clone = JSON.parse(JSON.stringify(parsed)) as typeof parsed;
    // Simulate: repeatedly take nextReady marking done (deps-only view).
    for (;;) {
      const n = nextReady(clone);
      if (!n) break;
      order.push(n.id);
      n.status = "done";
      if (order.length > clone.slices.length + 2) break;
    }
    const first = nextReady(parsed);
    console.log(`dry-run: ${parsed.slices.length} slices, summary ${JSON.stringify(summarize(parsed))}`);
    console.log(`first ready: ${first ? first.id : "(none)"}`);
    console.log(`dependency order: ${order.join(" → ")}`);
    if (a.slice) console.log(`--slice ${a.slice}: ${parsed.slices.some((s) => s.id === a.slice) ? "exists" : "UNKNOWN ID"}`);
    const lint = lintRoadmap(markdown, { verifyDefaults: cfg.verifyDefaults, agentModels: cfg.agentModels });
    for (const f of lint.errors) console.error(formatFinding(f));
    for (const f of lint.warnings) console.log(formatFinding(f));
    console.log(`lint: ${lint.errors.length} error(s), ${lint.warnings.length} warning(s)`);
    return lintFailed(lint) ? 1 : 0;
  }

  // Env preflight: every unique gate once against the base tree BEFORE any
  // worker spawns. Only infrastructure signatures block (a dead DB or a
  // squatted port); pre-slice code failures are the slices' job, not ours.
  if (a.checkEnv) {
    const gates = [...new Set([...(cfg.verifyDefaults ?? []), ...parsed.slices.filter((s) => !s.skip).flatMap((s) => s.verify)])];
    if (gates.length === 0) {
      console.log("check-env: no gates to probe");
    } else {
      const probes = await preflightEnv(a.project, gates, { onProgress: (m) => console.log(m) });
      const blocked = probes.filter((p) => p.envBlocked);
      if (blocked.length > 0) {
        for (const p of blocked) {
          console.error(`env blocked: ${p.command} — ${p.reason}`);
          if (p.fix) console.error(`  fix: ${p.fix}`);
        }
        console.error(`check-env: ${blocked.length}/${probes.length} gate(s) env-blocked — fix the environment, spawn nothing (no model burned)`);
        return 1;
      }
      console.log(`check-env: ${probes.length} gate(s) probed, no environment blocks`);
    }
  }

  // Fail fast on a bad chaos spec: parsing here keeps a typo from creating
  // a stray run (or resuming one) before the loop ever validates it.
  let faults;
  if (a.faultInject !== undefined) {
    try {
      faults = parseFaultSpec(a.faultInject);
    } catch (err) {
      console.error(`bad --fault-inject: ${String((err as Error).message)}`);
      return 1;
    }
  }

  let runId: string;
  if (a.resume || (a.run && listRuns(a.project).includes(a.run))) {
    runId = a.run ?? latestRun(a.project) ?? "";
    if (!runId) {
      console.error("no runs to resume");
      return 1;
    }
    // Drift detection (plan §11): abort if source changed mid-run.
    const cursor = loadRun(a.project, runId);
    if (cursor.doc.sourceHash !== sha256Hex(markdown)) {
      console.error(
        `roadmap source changed since run ${runId} started (hash mismatch).\n` +
          `Refusing to resume with a different roadmap. Adopt it first: \`ompo replan --run ${runId}\`, then resume.`,
      );
      return 1;
    }
    storeApi.resumeRun(a.project, runId);
    console.log(`resumed run ${runId}`);
  } else {
    runId = a.run ?? `${generateRunId()}${seedSuffix(a.seed)}`;
    if (a.maxRetries !== undefined) {
      for (const s of parsed.slices) s.maxRetries = a.maxRetries;
    }
    createRun(a.project, parsed, runId);
    console.log(`created run ${runId} (${parsed.slices.length} slices)`);
  }
  if (a.tmux && !process.env.TMUX_PANE) {
    console.error("ompo run --tmux must run from inside a tmux client ($TMUX_PANE unset)");
    return 1;
  }

  try {
    acquireLock(a.project, runId);
  } catch (err) {
    if (err instanceof StoreLockedError) {
      console.error(String(err.message ?? err));
      return 3;
    }
    throw err;
  }

  if (a.tmux) {
    spawnSync("tmux", ["select-pane", "-T", `ompo run ${runId}`]);
  }

  const loopOpts: Omit<LoopOptions, "onEvent" | "signal"> = {
    projectDir: a.project,
    runId,
    onlySlice: a.slice,
    maxRetriesOverride: a.maxRetries,
    timeoutMsOverride: a.timeoutSec ? a.timeoutSec * 1000 : undefined,
    jobs: a.jobs,
    runner: a.tmux ? createTmuxRunner() : undefined,
    noReview: a.noReview,
    reviewModel: a.reviewModel,
    noDebug: a.noDebug,
    noPlaceholders: a.noPlaceholders,
    seed: a.seed,
    faults,
  };

  try {
    // Interactive terminal: drive the loop from inside the watch-style TUI,
    // where the loop's 1-line logs stream into the bottom activity pane under
    // the slice board (see run.tsx). Pipes/CI have no raw-mode frame, so they
    // keep the headless log stream below.
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      const { runRoadmapLoopTui } = await import("./run.tsx");
      const res = await runRoadmapLoopTui(loopOpts);
      return res.exitCode;
    }

    const ctrl = new AbortController();
    const onSig = () => {
      console.log("\nreceived interrupt — finishing in-flight store write, then aborting…");
      ctrl.abort();
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    try {
      const res = await runRoadmapLoop({ ...loopOpts, signal: ctrl.signal, onEvent: (m) => console.log(m) });
      return res.exitCode;
    } finally {
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
    }
  } finally {
    releaseLock(a.project, runId);
  }
}

async function cmdStatus(a: Args): Promise<number> {
  const runId = a.run ?? latestRun(a.project);
  if (!runId) {
    console.log("no runs yet");
    return 0;
  }
  const cursor = loadRun(a.project, runId);
  const events = readEvents(a.project, runId);
  console.log(`run ${runId} — ${cursor.doc.slices.length} slices, ${events.length} events`);
  console.log(`summary: ${JSON.stringify(summarize(cursor.doc))}`);
  for (const s of cursor.doc.slices) {
    const extra = s.status === "done" || s.status === "skipped" ? "" : ` attempts=${s.attempts}`;
    console.log(`  [${s.status.padEnd(8)}] ${s.id} — ${s.title}${extra}`);
  }
  return 0;
}

async function cmdCtl(a: Args): Promise<number> {
  const runId = a.run ?? latestRun(a.project);
  if (!runId || !listRuns(a.project).includes(runId)) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  const action = a.sub;
  let intent: ControlIntent;
  switch (action) {
    case "retry":
    case "skip":
    case "park":
    case "kill":
      if (!a.slice) {
        console.error(`ompo ctl ${action} needs --slice ID`);
        return 1;
      }
      intent = { kind: action, sliceId: a.slice, reason: a.reason };
      break;
    case "jobs":
      if (a.jobs === undefined) {
        console.error("ompo ctl jobs needs --jobs N");
        return 1;
      }
      intent = { kind: "set-jobs", jobs: a.jobs };
      break;
    case "pause":
      intent = { kind: "pause" };
      break;
    case "resume":
      intent = { kind: "resume" };
      break;
    default:
      console.error(`unknown ctl action ${JSON.stringify(action)} (want retry|skip|park|kill|jobs|pause|resume)`);
      return 1;
  }
  const bad = validateIntent(intent);
  if (bad) {
    console.error(bad);
    return 1;
  }
  const loopLocal = intent.kind === "set-jobs" || intent.kind === "pause" || intent.kind === "resume";
  try {
    if (!lockHeld(a.project, runId)) {
      if (loopLocal) {
        console.error(`${intent.kind} needs a live loop (no lock on run ${runId})`);
        return 1;
      }
      // Quiescent run: no drain will come, so validate + apply immediately
      // through the same machinery (requested → applied/rejected audit).
      const before = latestSeq(a.project, runId);
      requestControl(a.project, runId, intent);
      const { intents } = drainIntents(a.project, runId, before);
      for (const queued of intents) {
        const res = applyIntent(a.project, runId, queued, { jobs: { value: 0 }, paused: false });
        console.log(res.ok ? `control ${queued.kind}${queued.sliceId ? ` ${queued.sliceId}` : ""}: ${res.message}` : `control rejected: ${res.message}`);
        return res.ok ? 0 : 1;
      }
      return 0;
    }
    requestControl(a.project, runId, intent);
    console.log(`queued ${intent.kind}${intent.sliceId ? ` ${intent.sliceId}` : ""} on live run ${runId} — loop applies within ~2s (watch \`ompo log --run ${runId} --follow\`)`);
    return 0;
  } catch (err) {
    console.error(`control failed: ${String((err as Error).message)}`);
    return 1;
  }
}

async function cmdReplan(a: Args): Promise<number> {
  const runId = a.run ?? latestRun(a.project);
  if (!runId || !listRuns(a.project).includes(runId)) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  if (!existsSync(a.roadmap)) {
    console.error(`roadmap not found: ${a.roadmap}`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseRoadmap(readFileSync(a.roadmap, "utf8"));
  } catch (err) {
    console.error(`roadmap parse: ${String((err as Error).message)}`);
    return 1;
  }
  const cursor = loadRun(a.project, runId);
  const locked = lockHeld(a.project, runId);
  const refusal = replanGuards(cursor.doc, parsed, locked);
  if (refusal) {
    console.error(`cannot replan run ${runId}: ${refusal}`);
    return locked ? 3 : 1;
  }
  const m = mergeRoadmap(cursor.doc, parsed);
  saveRunDoc(a.project, runId, m.doc);
  appendEvent(a.project, runId, "roadmap_replanned", undefined, `kept=${m.kept.length} reset=${m.reset.length} added=${m.added.length} dropped=${m.dropped.length}`);
  const show = (label: string, ids: string[]): void => {
    if (ids.length > 0) console.log(`  ${label}: ${ids.join(", ")}`);
  };
  console.log(`replanned run ${runId} (sourceHash updated — resume accepts it)`);
  show("kept (status preserved)", m.kept);
  show("reset to pending (spec changed)", m.reset);
  show("added", m.added);
  show("dropped (artifacts kept on disk)", m.dropped);
  console.log(`next: \`ompo resume --run ${runId}\``);
  return 0;
}

async function cmdLint(a: Args): Promise<number> {
  if (!existsSync(a.roadmap)) {
    console.error(`roadmap not found: ${a.roadmap}\nrun \`ompo init --project ${a.project}\` first`);
    return 1;
  }
  const cfg = loadRoadmapConfig(a.project);
  const res = lintRoadmap(readFileSync(a.roadmap, "utf8"), { verifyDefaults: cfg.verifyDefaults, agentModels: cfg.agentModels });
  for (const f of res.errors) console.error(formatFinding(f));
  for (const f of res.warnings) console.log(formatFinding(f));
  console.log(`lint: ${res.errors.length} error(s), ${res.warnings.length} warning(s)`);
  return lintFailed(res) ? 1 : 0;
}

async function cmdImport(a: Args): Promise<number> {
  if (!a.from) {
    console.error("ompo import requires --from FILE (foreign roadmap in any template)");
    return 1;
  }
  try {
    await runImport({
      projectDir: a.project,
      fromPath: a.from,
      roadmapPath: a.roadmap,
      workerModel: a.model,
      timeoutMs: a.timeoutSec ? a.timeoutSec * 1000 : undefined,
      hints: { done: splitIds(a.done), active: splitIds(a.active) },
      onEvent: (m) => console.log(m),
    });
    console.log(`next: \`ompo run --dry-run --project ${a.project}\`, then \`ompo run\``);
    return 0;
  } catch (err) {
    console.error(`import failed: ${String((err as Error).message)}`);
    return 1;
  }
}

async function cmdUnified(a: Args): Promise<number> {
  // Lazy import: the react/ink frame loads only for the TUI path.
  const { runUnified } = await import("./unified.tsx");
  try {
    const res = await runUnified({
      projectDir: a.project,
      roadmapPath: a.roadmap,
      runId: a.run,
      model: a.model,
      timeoutSec: a.timeoutSec,
      maxRetries: a.maxRetries,
      jobs: a.jobs,
      template: a.template,
      replan: a.replan,
      noReview: a.noReview,
      reviewModel: a.reviewModel,
      noDebug: a.noDebug,
      noPlaceholders: a.noPlaceholders,
      tmux: a.tmux,
    });
    return res.exitCode;
  } catch (err) {
    console.error(`ompo failed: ${String((err as Error).message)}`);
    return 1;
  }
}

async function main(): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    console.log(help());
    return 1;
  }
  // Bare `ompo` (no command, or flags only) launches the unified TUI.
  // Explicit --help/-h still prints help.
  const raw = process.argv.slice(2);
  if ((raw.length === 0 || raw[0]!.startsWith("-")) && a.cmd !== "--help") a.cmd = "tui";
  switch (a.cmd) {
    case "init":
      return cmdInit(a);
    case "tui":
      return cmdUnified(a);
    case "import":
      return cmdImport(a);
    case "run":
      return cmdRun(a);
    case "resume":
      a.resume = true;
      return cmdRun(a);
    case "status":
      return cmdStatus(a);
    case "ctl":
      return cmdCtl(a);
    case "replan":
      return cmdReplan(a);
    case "lint":
      return cmdLint(a);
    case "list":
      console.log(listRuns(a.project).join("\n") || "(no runs)");
      return 0;
    case "log":
      return cmdLog({
        project: a.project,
        run: a.run,
        follow: a.follow ?? false,
        json: a.logJson ?? false,
      });
    case "watch": {
      // Lazy import: ink/react load only when the TUI actually runs, keeping
      // every other command's startup lean.
      const { cmdWatch } = await import("./watch.tsx");
      return cmdWatch({ project: a.project, run: a.run });
    }
    case "--help":
    case "help":
    case "-h":
      console.log(help());
      return 0;
    default:
      console.error(`unknown command "${a.cmd}"`);
      console.log(help());
      return 1;
  }
}

const code = await main();
process.exit(code);
