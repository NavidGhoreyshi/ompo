#!/usr/bin/env bun
/**
 * ompo — OMP Roadmap Orchestrator CLI (M6).
 * Usage in ANY new project:
 *   ompo init            # scaffold ROADMAP.md + .omp/roadmap.yml
 *   ompo run             # execute roadmap headlessly (sequential slices)
 *   ompo status          # read-only store dump
 *   ompo resume          # resume latest run after crash/abort
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { formatCiEvent, jobSummaryPaths, parseCiFormat, renderProgressBar, summarizeRun, type CiFormat } from "./ci.ts";
import { collectChecklist, fillChecklist, renderChecklistJson, renderChecklistMd } from "./checklist.ts";
import { explainConfig, runDoctor } from "./doctor.ts";
import { diffSliceBranch, pruneWorktrees, renderShowText, showSlice, sliceWorktreePath, tailSliceLog } from "./forensics.ts";
import { computeStats, exportHtml, queryEvents, replayRun } from "./stats.ts";
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
                                            line logs when piped (--format pretty|json|tap|github)
  ompo resume [FLAGS]                       resume latest run (alias: run --resume)
  ompo ctl ACTION [--run ID] [--slice ID]   live control: retry|skip|park|kill [--slice ID] [--reason R],
                                            jobs --jobs N, pause, resume (queued on live runs, applied now otherwise)
  ompo replan [--run ID] [--project DIR]    adopt an edited ROADMAP.md into a quiescent run (keeps done,
                                            resets changed slices, refuses live runs and changed in-flight slices)
  ompo revalidate [--run ID] [--project DIR] [--roadmap PATH] [--model M]
                                            agentic truth-check: audit ROADMAP.md vs run evidence + tree,
                                            propose ROADMAP.revalidate.md (adopt via replan)
  ompo plan [--project DIR] [--roadmap PATH]  preview the plan: slices, gates, deps + lint (exit 1 when blocked)
  ompo show <id> [--run ID]                inspector tabs for scripts (report, verdict, review, prompt, models, timing)
  ompo diff <id> [--run ID]                slice branch vs merge-base (stat + hunks, or "in-place run, no branch")
  ompo shell <id> [--run ID]               $SHELL with cwd=slice worktree (or project dir in-place)
  ompo logs <id> [--run ID] [--tail N] [--follow]  newest worker log tail (follow polls)
  ompo retry <id> [--run ID] [--reason R]   one more attempt now (queued on live runs, applied now otherwise)
  ompo skip <id> [--run ID] [--reason R]    skip slice without running (downstream proceeds past skips)
  ompo worktrees prune [--project DIR]      git worktree prune + drop dirs for terminal/unknown runs
  ompo checklist [--run ID] [--json]        merged deferred + placeholders list (what — needs value; manual check)
  ompo fill --var K=V [--var ...] [--run ID] re-run gates of slices mentioning the vars (never writes the store)
  ompo doctor [--project DIR]               pre-run env scan (omp, models, tmux, git, tree, gates, disk, config)
  ompo config [--explain] [--project DIR]   resolved .omp/roadmap.yml + per-slice effective models
  ompo stats [--run ID] [--json]            pass rate, means, per-Effort, top failing gates, model fallbacks
  ompo query "EXPR" [--run ID] [--json]     tiny DSL: all|failed|slice ID [where attempts>1 and reason~timeout]
  ompo export --html [--run ID] [--out FILE] self-contained HTML run report (stdout without --out)
  ompo replay [--run ID]                    rebuild statuses from events.jsonl, diff vs cursor
  ompo status [--run ID] [--project DIR]    read-only store dump
  ompo list [--project DIR]                 list runs
  ompo log [--run ID] [--follow] [--json] [--format FMT] render a run's event stream
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
  --no-unblock       disable end-of-run unblock sessions (default: up to maxUnblocks rounds)
  --max-unblocks N   end-of-run unblock sessions before giving up (0..5, default 2)
  --no-handoff       disable context-cap handoff to a fresh session (default: handoff at cap)
  --context-cap N    per-session tokens before handoff to a fresh session (0 disables, default 120000)
  --reverify         re-run done slices' gates on current HEAD at loop start (demotes failures)
  --check-env        probe every gate once for env blocks before spawning (fail fast, burn nothing)
  --format FMT       headless output: pretty|json|tap|github (progress bar on stderr, events on stdout,
                      deferred.md/placeholders.md as job summary; $GITHUB_STEP_SUMMARY appended when set)
  --seed N           deterministic RNG seed for chaos draws (suffixes fresh run ids -sN)
  --fault-inject SPEC chaos, CLI-only: fail-verify=a+b,abort-attempt=0.25,crash-after=5
  --replan           re-run the planner even if ROADMAP.md exists (overwrite)
  --template         blank 2-slice template instead of the planner session

LOG FLAGS
  --follow           tail the run's event stream (works on a live run)
  --json             raw events, one JSON object per line
  --format FMT       pretty|json|tap|github rendering of the event stream

FORENSICS FLAGS (show/diff/shell/logs/retry/skip/worktrees/checklist/fill/stats/query/export/replay/doctor/config)
  --var K=V          fill: real value for a placeholder var (repeatable)
  --tail N           logs: last N worker-log lines (default 50)
  --html             export: self-contained HTML report
  --out FILE         export: write to FILE instead of stdout
  --explain          config: dump resolved config + per-slice models (also the bare default)
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
  /** First positional after the command (`ctl` action, slice id, query head, `worktrees` subcommand). */
  sub?: string;
  /** Extra positionals after `sub` (query DSL words when unquoted). */
  rest: string[];
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
  noUnblock?: boolean;
  maxUnblocks?: number;
  noHandoff?: boolean;
  contextCap?: number;
  reverify?: boolean;
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
  /** `run --format` / `log --format`: pretty|json|tap|github. */
  format?: string;
  /** `fill --var K=V` (repeatable). */
  vars: Record<string, string>;
  /** `export --html`: write a self-contained HTML report. */
  html?: boolean;
  /** `export --out FILE`, `logs --out` target. */
  out?: string;
  /** `logs --tail N`: last N worker-log lines (default 50). */
  tail?: number;
  /** `config --explain`: dump resolved config + per-slice models. */
  explain?: boolean;
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
    rest: [],
    vars: {},
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
    else if (t === "--no-unblock") a.noUnblock = true;
    else if (t === "--max-unblocks" && argv[i + 1]) a.maxUnblocks = parseNonNegativeInt(argv[++i]!, "--max-unblocks", 5);
    else if (t === "--no-handoff") a.noHandoff = true;
    else if (t === "--context-cap" && argv[i + 1]) a.contextCap = parseNonNegativeInt(argv[++i]!, "--context-cap", 1_000_000);
    else if (t === "--reverify") a.reverify = true;
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
    else if (t === "--format" && argv[i + 1]) a.format = argv[++i]!;
    else if (t === "--var" && argv[i + 1]) {
      const raw = argv[++i]!;
      const eq = raw.indexOf("=");
      if (eq <= 0) throw new Error(`--var needs K=V (got "${raw}")`);
      a.vars[raw.slice(0, eq)!.trim()] = raw.slice(eq + 1);
    } else if (t === "--html") a.html = true;
    else if (t === "--out" && argv[i + 1]) a.out = argv[++i]!;
    else if (t === "--tail" && argv[i + 1]) a.tail = parsePositiveInt(argv[++i]!, "--tail");
    else if (t === "--explain") a.explain = true;
    else if (!t.startsWith("-") && a.sub === undefined) a.sub = t;
    else if (!t.startsWith("-")) a.rest.push(t);
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
/**
 * End-of-run CI report: formatted event stream on stdout (parseable) plus
 * deferred.md/placeholders.md as the job summary ($GITHUB_STEP_SUMMARY when
 * set, paths on stdout otherwise). Best-effort — never fails the run.
 */
function emitCiReport(project: string, runId: string, format: CiFormat): void {
  try {
    const events = readEvents(project, runId);
    if (format === "tap") console.log(`TAP version 13\n1..${events.length}`);
    events.forEach((ev, i) => {
      console.log(formatCiEvent(ev, format, { n: i + 1, total: events.length }));
    });
    try {
      const cur = loadRun(project, runId);
      const counts: Record<string, number> = {};
      for (const s of cur.doc.slices) counts[s.status] = (counts[s.status] ?? 0) + 1;
      const s = summarizeRun(counts, events);
      console.log(`# ompo summary: ${s.done}/${s.total} done, ${s.failed} failed`);
    } catch {
      /* summary line is advisory */
    }
    const docs = jobSummaryPaths(project, runId);
    const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
    for (const doc of docs) {
      try {
        const text = readFileSync(join(project, doc), "utf8");
        if (summaryFile) appendFileSync(summaryFile, `\n# ompo ${doc}\n\n${text}\n`, "utf8");
        console.log(`job summary: ${doc}`);
      } catch {
        /* one missing doc never blocks the others */
      }
    }
  } catch {
    /* CI rendering never fails the run */
  }
}

async function cmdRun(a: Args): Promise<number> {
  // (--jobs/--timeout-sec/--max-retries already validated in parseArgs.)
  let ciFormat: CiFormat = "pretty";
  if (a.format !== undefined) {
    try {
      ciFormat = parseCiFormat(a.format);
    } catch (err) {
      console.error(String((err as Error).message));
      return 1;
    }
  }
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
    noUnblock: a.noUnblock,
    maxUnblocksOverride: a.maxUnblocks,
    noHandoff: a.noHandoff,
    contextCapOverride: a.contextCap,
    reverify: a.reverify,
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
    process.on("SIGHUP", onSig);
    // CI formats: loop chatter goes to stderr (stdout stays parseable) with a
    // progress bar; the formatted event stream + job summary print at the end.
    const onEvent =
      ciFormat === "pretty"
        ? (m: string) => console.log(m)
        : (m: string) => {
            console.error(m);
            try {
              const cur = loadRun(a.project, runId);
              const counts: Record<string, number> = {};
              for (const s of cur.doc.slices) counts[s.status] = (counts[s.status] ?? 0) + 1;
              const done = counts["done"] ?? 0;
              console.error(`${renderProgressBar(done, cur.doc.slices.length)} ${done}/${cur.doc.slices.length}`);
            } catch {
              /* best-effort progress — never break the run */
            }
          };
    try {
      const res = await runRoadmapLoop({ ...loopOpts, signal: ctrl.signal, onEvent });
      if (ciFormat !== "pretty") emitCiReport(a.project, runId, ciFormat);
      return res.exitCode;
    } finally {
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      process.off("SIGHUP", onSig);
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

async function cmdPlan(a: Args): Promise<number> {
  if (!existsSync(a.roadmap)) {
    console.error(`roadmap not found: ${a.roadmap}\nrun \`ompo init --project ${a.project}\` first`);
    return 1;
  }
  const { buildPlanPreview, formatPreviewSummary, renderPreviewLines } = await import("./planPreview.ts");
  const cfg = loadRoadmapConfig(a.project);
  const preview = buildPlanPreview(readFileSync(a.roadmap, "utf8"), { verifyDefaults: cfg.verifyDefaults, agentModels: cfg.agentModels });
  for (const line of renderPreviewLines(preview)) console.log(line);
  console.log(formatPreviewSummary(preview));
  return preview.status === "blocked" ? 1 : 0;
}
 function needRun(project: string, run?: string): string | null {
  const runId = run ?? latestRun(project);
  if (!runId || !listRuns(project).includes(runId)) return null;
  return runId;
}

/** Shared retry/skip path: queued on live runs, applied now when quiescent. */
function cmdDirectControl(a: Args, kind: "retry" | "skip"): number {
  const sliceId = a.sub ?? a.slice;
  if (!sliceId) {
    console.error(`ompo ${kind} needs a slice id (ompo ${kind} <id>)`);
    return 1;
  }
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  const intent: ControlIntent = { kind, sliceId, reason: a.reason };
  const bad = validateIntent(intent);
  if (bad) {
    console.error(bad);
    return 1;
  }
  try {
    if (!lockHeld(a.project, runId)) {
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
    console.log(`queued ${kind} ${sliceId} on live run ${runId} — loop applies within ~2s (watch \`ompo log --run ${runId} --follow\`)`);
    return 0;
  } catch (err) {
    console.error(`control failed: ${String((err as Error).message)}`);
    return 1;
  }
}

async function cmdShow(a: Args): Promise<number> {
  if (!a.sub) {
    console.error("ompo show needs a slice id (ompo show <id>)");
    return 1;
  }
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  try {
    console.log(renderShowText(showSlice(a.project, runId, a.sub)));
    return 0;
  } catch (err) {
    console.error(String((err as Error).message));
    return 1;
  }
}

async function cmdDiff(a: Args): Promise<number> {
  if (!a.sub) {
    console.error("ompo diff needs a slice id (ompo diff <id>)");
    return 1;
  }
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  const d = diffSliceBranch(a.project, runId, a.sub);
  if (d.base === null) {
    console.log(`in-place run, no branch (${d.branch})${d.note && d.note !== "in-place run, no branch" ? ` — ${d.note}` : ""}`);
    return 0;
  }
  if (d.stat) console.log(d.stat);
  if (d.diff) console.log(d.diff);
  if (d.note) console.error(`note: ${d.note}`);
  if (!d.stat && !d.diff) console.log("(no changes)");
  return 0;
}

async function cmdShell(a: Args): Promise<number> {
  if (!a.sub) {
    console.error("ompo shell needs a slice id (ompo shell <id>)");
    return 1;
  }
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  try {
    const cursor = loadRun(a.project, runId);
    if (!cursor.doc.slices.some((s) => s.id === a.sub)) {
      console.error(`unknown slice "${a.sub}"`);
      return 1;
    }
  } catch (err) {
    console.error(String((err as Error).message));
    return 1;
  }
  const cwd = sliceWorktreePath(a.project, runId, a.sub);
  const shell = process.env["SHELL"] ?? "sh";
  try {
    const r = spawnSync(shell, [], { cwd, stdio: "inherit" });
    return r.status ?? 0;
  } catch (err) {
    console.error(`shell failed: ${String((err as Error).message)}`);
    return 1;
  }
}

async function cmdLogs(a: Args): Promise<number> {
  if (!a.sub) {
    console.error("ompo logs needs a slice id (ompo logs <id> [--tail N] [--follow])");
    return 1;
  }
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  const n = a.tail ?? 50;
  if (!a.follow) {
    for (const line of tailSliceLog(a.project, runId, a.sub, n)) console.log(line);
    return 0;
  }
  let stopped = false;
  const onSig = (): void => {
    stopped = true;
  };
  process.on("SIGINT", onSig);
  let shown = 0;
  try {
    for (;;) {
      if (stopped) break;
      const lines = tailSliceLog(a.project, runId, a.sub, Math.max(n, shown + 200));
      // Print only what is new since the last poll (follow grows the window).
      const fresh = lines.slice(shown);
      for (const line of fresh) console.log(line);
      shown = lines.length;
      await new Promise((r) => setTimeout(r, 500));
    }
    return 0;
  } finally {
    process.off("SIGINT", onSig);
  }
}

async function cmdWorktrees(a: Args): Promise<number> {
  if (a.sub !== "prune") {
    console.error(`unknown worktrees action ${JSON.stringify(a.sub ?? "(none)")} (want: prune)`);
    return 1;
  }
  const { pruned, kept } = pruneWorktrees(a.project);
  console.log(`pruned ${pruned.length} worktree(s), kept ${kept.length}`);
  for (const p of pruned) console.log(`  pruned: ${p}`);
  return 0;
}

async function cmdChecklist(a: Args): Promise<number> {
  const runId = a.run ?? latestRun(a.project);
  if (!runId) {
    console.log("no runs yet");
    return 0;
  }
  if (!listRuns(a.project).includes(runId)) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  const items = collectChecklist(a.project, runId);
  console.log(a.logJson ? renderChecklistJson(items) : renderChecklistMd(items, runId));
  return 0;
}

async function cmdFill(a: Args): Promise<number> {
  const vars = a.vars ?? {};
  if (Object.keys(vars).length === 0) {
    console.error("ompo fill needs --var K=V (repeatable: --var A=1 --var B=2)");
    return 1;
  }
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  const res = await fillChecklist(a.project, runId, vars);
  if (res.affected.length === 0) {
    console.log("fill: no checklist items mention these vars — nothing re-verified");
    return 0;
  }
  console.log(`fill: affected ${res.affected.join(", ")}`);
  for (const id of res.passed) console.log(`  pass: ${id}`);
  for (const f of res.failed) {
    console.error(`  FAIL: ${f.sliceId}`);
    if (f.output) console.error(f.output);
  }
  return res.failed.length > 0 ? 1 : 0;
}

async function cmdDoctor(a: Args): Promise<number> {
  const res = await runDoctor(a.project);
  for (const c of res.checks) {
    const line = `${c.ok ? "ok" : "FAIL"} ${c.name} — ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ""}`;
    if (c.ok) console.log(line);
    else console.error(line);
  }
  return res.ok ? 0 : 1;
}

async function cmdConfig(a: Args): Promise<number> {
  console.log(explainConfig(a.project));
  return 0;
}

async function cmdStats(a: Args): Promise<number> {
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  const s = computeStats(a.project, runId);
  if (a.logJson) {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }
  console.log(`run ${s.runId} — pass rate ${s.passRate === null ? "-" : `${(s.passRate * 100).toFixed(1)}%`}`);
  console.log(`totals: ${JSON.stringify(s.totals)} · attempts: ${s.attempts.total}`);
  const fmt = (v: number | null): string => (v === null ? "-" : Number.isInteger(v) ? String(v) : v.toFixed(1));
  console.log(`means: turns ${fmt(s.meanTurns)} · tools ${fmt(s.meanTools)} · durationMs ${fmt(s.meanDurationMs)}`);
  for (const k of ["lo", "med", "hi", "none"] as const) {
    const g = s.byEffort[k];
    console.log(`  effort ${k}: count ${g.count} done ${g.done} durationMs ${fmt(g.meanDurationMs)} turns ${fmt(g.meanTurns)} tools ${fmt(g.meanTools)}`);
  }
  if (s.topFailingGates.length > 0) {
    console.log("top failing gates:");
    for (const g of s.topFailingGates) console.log(`  ${g.fails}x ${g.command}`);
  }
  const fallbacks = Object.entries(s.modelFallbacks);
  if (fallbacks.length > 0) {
    console.log("model fallbacks:");
    for (const [m, n] of fallbacks) console.log(`  ${n}x ${m}`);
  }
  return 0;
}

async function cmdQuery(a: Args): Promise<number> {
  const q = [a.sub, ...(a.rest ?? [])].filter(Boolean).join(" ").trim();
  if (!q) {
    console.error('ompo query needs an expression (e.g. ompo query "failed where attempts>1")');
    return 1;
  }
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  let results;
  try {
    results = queryEvents(a.project, runId, q);
  } catch (err) {
    console.error(String((err as Error).message));
    return 1;
  }
  if (a.logJson) {
    for (const ev of results) console.log(JSON.stringify(ev));
    return 0;
  }
  for (const ev of results) {
    console.log(` ${String(ev.seq).padStart(3)} ${ev.type} ${ev.sliceId ?? "-"}${ev.attempt !== undefined ? ` #${ev.attempt}` : ""}${ev.detail ? ` ${ev.detail}` : ""}${ev.reason ? ` reason=${ev.reason}` : ""}`);
  }
  console.log(`— ${results.length} event(s)`);
  return 0;
}

async function cmdExport(a: Args): Promise<number> {
  if (!a.html) {
    console.error("ompo export needs --html (ompo export --html [--out FILE])");
    return 1;
  }
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  const html = exportHtml(a.project, runId);
  if (a.out) {
    mkdirSync(dirname(a.out), { recursive: true });
    writeFileSync(a.out, html, "utf8");
    console.log(`wrote ${a.out}`);
    return 0;
  }
  console.log(html);
  return 0;
}

async function cmdReplay(a: Args): Promise<number> {
  const runId = needRun(a.project, a.run);
  if (!runId) {
    console.error(`unknown run ${JSON.stringify(a.run ?? "(none)")} — use ompo list`);
    return 1;
  }
  const r = replayRun(a.project, runId);
  console.log(`replay run ${runId}: ${r.events} event(s)`);
  if (r.mismatches.length === 0) {
    console.log("ok: cursor matches event-log replay");
    return 0;
  }
  for (const m of r.mismatches) console.error(`mismatch: ${m}`);
  console.error(`${r.mismatches.length} mismatch(s) — cursor diverges from events.jsonl`);
  return 1;
}

async function cmdRevalidate(a: Args): Promise<number> {
  const { runRevalidate } = await import("./revalidate.ts");
  try {
    const res = await runRevalidate({
      projectDir: a.project,
      runId: a.run,
      roadmapPath: a.roadmap,
      workerModel: a.model,
      timeoutMs: a.timeoutSec ? a.timeoutSec * 1000 : undefined,
      onEvent: (m) => console.log(m),
    });
    console.log(`next: review ${res.proposalPath}, then \`ompo plan\` + \`ompo replan\` to adopt`);
    return 0;
  } catch (err) {
    console.error(`revalidate failed: ${String((err as Error).message)}`);
    return 1;
  }
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
      noDebug: a.noDebug,
      noPlaceholders: a.noPlaceholders,
      noUnblock: a.noUnblock,
      maxUnblocks: a.maxUnblocks,
      noHandoff: a.noHandoff,
      contextCap: a.contextCap,
      reverify: a.reverify,
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
    case "revalidate":
      return cmdRevalidate(a);
    case "run":
      return cmdRun(a);
    case "resume":
      a.resume = true;
      return cmdRun(a);
    case "status":
      return cmdStatus(a);
    case "ctl":
      return cmdCtl(a);
    case "plan":
      return cmdPlan(a);
    case "lint":
      return cmdLint(a);
    case "show":
      return cmdShow(a);
    case "diff":
      return cmdDiff(a);
    case "shell":
      return cmdShell(a);
    case "logs":
      return cmdLogs(a);
    case "retry":
      return cmdDirectControl(a, "retry");
    case "skip":
      return cmdDirectControl(a, "skip");
    case "worktrees":
      return cmdWorktrees(a);
    case "checklist":
      return cmdChecklist(a);
    case "fill":
      return cmdFill(a);
    case "doctor":
      return cmdDoctor(a);
    case "config":
      return cmdConfig(a);
    case "stats":
      return cmdStats(a);
    case "query":
      return cmdQuery(a);
    case "export":
      return cmdExport(a);
    case "replay":
      return cmdReplay(a);
    case "list":
      console.log(listRuns(a.project).join("\n") || "(no runs)");
      return 0;
    case "log":
      return cmdLog({
        project: a.project,
        run: a.run,
        follow: a.follow ?? false,
        json: a.logJson ?? false,
        format: a.format,
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
