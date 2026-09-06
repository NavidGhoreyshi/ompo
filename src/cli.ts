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
import { join, resolve } from "node:path";
import { parseRoadmap, sha256Hex } from "./parse.ts";
import { nextReady, summarize } from "./select.ts";
import {
  acquireLock,
  createRun,
  generateRunId,
  listRuns,
  loadRun,
  readEvents,
  releaseLock,
  storeApi,
  StoreLockedError,
} from "./store.ts";
import { runRoadmapLoop } from "./loop.ts";
import { runImport } from "./import.ts";
import { createTmuxRunner } from "./tmux.ts";
import { cmdLog } from "./log.ts";

const VERSION = "0.1.0";
function help(): string {
  return `ompo ${VERSION} — long-horizon roadmap orchestrator for stock omp

USAGE
  ompo init [--project DIR]                 scaffold ROADMAP.md + .omp/roadmap.yml
  ompo import --from FILE [--project DIR] [--roadmap PATH] [--done IDS] [--active IDS] [--model M]
                                            agentic import: foreign roadmap (any template) → ROADMAP.md
  ompo run [FLAGS]                          run roadmap (creates or resumes a run)
  ompo resume [FLAGS]                       resume latest run (alias: run --resume)
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
  --dry-run          parse + print ready order, spawn nothing
  --max-retries N    override per-slice retries
  --tmux             live omp TUI per worker pane in this window (needs $TMUX_PANE)
  --jobs N           max concurrent slices (default 1; git worktree isolation)
  --timeout-sec N    global worker budget (beats per-slice Timeout:)
  --no-review        skip the independent post-merge review session
  --review-model M   reviewer model (default: roadmap.yml reviewModel → workerModel)
  --no-debug         skip the debugger session on failure (straight to retry budget)

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
  follow?: boolean;
  logJson?: boolean;
}

function splitIds(v?: string): string[] | undefined {
  if (!v) return undefined;
  const ids = v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : undefined;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: argv[0] ?? "--help",
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
    else if (t === "--max-retries" && argv[i + 1]) a.maxRetries = Number(argv[++i]!);
    else if (t === "--from" && argv[i + 1]) a.from = argv[++i]!;
    else if (t === "--model" && argv[i + 1]) a.model = argv[++i]!;
    else if (t === "--done" && argv[i + 1]) a.done = argv[++i]!;
    else if (t === "--active" && argv[i + 1]) a.active = argv[++i]!;
    else if (t === "--timeout-sec" && argv[i + 1]) a.timeoutSec = Number(argv[++i]!);
    else if (t === "--jobs" && argv[i + 1]) a.jobs = Number(argv[++i]!);
    else if (t === "--no-review") a.noReview = true;
    else if (t === "--no-debug") a.noDebug = true;
    else if (t === "--follow") a.follow = true;
    else if (t === "--json") a.logJson = true;
    else if (t === "--review-model" && argv[i + 1]) a.reviewModel = argv[++i]!;
    else if (t === "--help" || t === "-h") a.cmd = "--help";
    else if (t === "--tmux") a.tmux = true;
    else throw new Error(`unknown flag ${t}`);
  }
  if (!a.roadmap) a.roadmap = join(a.project, "ROADMAP.md");
  return a;
}

const ROADMAP_TEMPLATE = `# Roadmap — <project>

> One \`## \` section per slice. Ids in brackets are stable — rename titles
> freely, never rename ids after a run starts. Keep slices small.

## [01-scaffold] Scaffold

Create the project skeleton (dirs, package manifest, hello-world entry).

Verify: bun test
Files: src/index.ts
Retries: 1

## [02-feature] First feature

Implement the first vertical slice.

Depends: 01-scaffold
Verify: bun test
Retries: 1
`;

const YML_TEMPLATE = `# ompo project-local config — all keys optional.
# workerModel: model pattern passed to \`omp --model\` for every slice worker.
#   Omit to use your configured default model. Cheap default recommended
#   (this template pins a free-tier model; override hard slices via Agent:).
workerModel: muse-spark-1.3-contributor-free
maxRetries: 1
specBudget: 12000
workerTimeoutSec: 900
# agentModels: per-slice Agent: name → model pattern.
agentModels:
  task: muse-spark-1.3-contributor-free
# verifyDefaults: commands prepended before every slice's \`Verify:\` steps.
verifyDefaults: []
`;

async function cmdInit(a: Args): Promise<number> {
  const roadmapPath = join(a.project, "ROADMAP.md");
  if (!existsSync(roadmapPath)) {
    writeFileSync(roadmapPath, ROADMAP_TEMPLATE, "utf8");
    console.log(`wrote ${roadmapPath}`);
  } else {
    console.log(`kept existing ${roadmapPath}`);
  }
  const ymlPath = join(a.project, ".omp", "roadmap.yml");
  if (!existsSync(ymlPath)) {
    mkdirSync(join(a.project, ".omp"), { recursive: true });
    writeFileSync(ymlPath, YML_TEMPLATE, "utf8");
    console.log(`wrote ${ymlPath}`);
  } else {
    console.log(`kept existing ${ymlPath}`);
  }
  // Validate the (possibly existing) roadmap.
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
  if (a.jobs !== undefined && !(a.jobs >= 1)) {
    console.error(`--jobs must be a positive integer (got "${a.jobs}")`);
    return 1;
  }
  if (!existsSync(a.roadmap)) {
    console.error(`roadmap not found: ${a.roadmap}\nrun \`ompo init --project ${a.project}\` first`);
    return 1;
  }
  const markdown = readFileSync(a.roadmap, "utf8");
  const parsed = parseRoadmap(markdown);

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
          `Refusing to resume with a different roadmap. Finish or abandon this run first.`,
      );
      return 1;
    }
    storeApi.resumeRun(a.project, runId);
    console.log(`resumed run ${runId}`);
  } else {
    runId = a.run ?? generateRunId();
    if (a.maxRetries !== undefined) {
      for (const s of parsed.slices) s.maxRetries = a.maxRetries;
    }
    createRun(a.project, parsed, runId);
    console.log(`created run ${runId} (${parsed.slices.length} slices)`);
  }

  if (a.dryRun) {
    const cursor = loadRun(a.project, runId);
    const order: string[] = [];
    const clone = JSON.parse(JSON.stringify(cursor.doc)) as typeof cursor.doc;
    // Simulate: repeatedly take nextReady marking done (deps-only view).
    for (;;) {
      const { nextReady: nr } = await import("./select.ts");
      const n = nr({ ...clone });
      if (!n) break;
      order.push(n.id);
      n.status = "done";
      if (order.length > clone.slices.length + 2) break;
    }
    const first = nextReady(cursor.doc);
    console.log(`dry-run: ${cursor.doc.slices.length} slices, summary ${JSON.stringify(summarize(cursor.doc))}`);
    console.log(`first ready: ${first ? first.id : "(none)"}`);
    console.log(`dependency order: ${order.join(" → ")}`);
    if (a.slice) console.log(`--slice ${a.slice}: ${cursor.doc.slices.some((s) => s.id === a.slice) ? "exists" : "UNKNOWN ID"}`);
    // Dry-run runs create an empty run dir; leave it (it is a valid empty run).
    return 0;
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

  const ctrl = new AbortController();
  const onSig = () => {
    console.log("\nreceived interrupt — finishing in-flight store write, then aborting…");
    ctrl.abort();
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  if (a.tmux) {
    spawnSync("tmux", ["select-pane", "-T", `ompo run ${runId}`]);
  }
  try {
    const res = await runRoadmapLoop({
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
      signal: ctrl.signal,
      onEvent: (m) => console.log(m),
    });
    return res.exitCode;
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
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
    const extra = s.status === "done" ? "" : s.status === "failed" ? ` attempts=${s.attempts}` : ` attempts=${s.attempts}`;
    console.log(`  [${s.status.padEnd(8)}] ${s.id} — ${s.title}${extra}`);
  }
  return 0;
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

async function main(): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    console.log(help());
    return 1;
  }
  switch (a.cmd) {
    case "init":
      return cmdInit(a);
    case "import":
      return cmdImport(a);
    case "run":
      return cmdRun(a);
    case "resume":
      a.resume = true;
      return cmdRun(a);
    case "status":
      return cmdStatus(a);
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
