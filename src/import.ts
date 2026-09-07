/**
 * Agentic roadmap import (foreign roadmap → ompo ROADMAP.md).
 *
 * The foreign roadmap may use ANY template: slice boundaries are semantic
 * (numbered steps, sections, phases, checkboxes), never assumed to be
 * `## ` headings or `§` markers. A stock `omp -p` worker reads the foreign
 * file plus live project evidence (git log, qa reports, working tree) and
 * emits a strict ompo roadmap. The orchestrator extracts, writes, and
 * validates it with parseRoadmap — fail closed on extraction/parse errors.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseRoadmap, RoadmapParseError } from "./parse.ts";
import { loadRoadmapConfig } from "./config.ts";
import { runOmpWorker, type WorkerRunner } from "./worker.ts";

export const IMPORT_OPEN = "<<<OMPO_ROADMAP";
export const IMPORT_CLOSE = ">>>";

export interface ImportHints {
  /** Slice keys the user declares done (ground truth, overrides inference). */
  done?: string[];
  /** Slice keys the user declares in-progress (body = remainder only). */
  active?: string[];
}

export interface ImportOptions {
  projectDir: string;
  /** Absolute or project-relative path to the foreign roadmap file. */
  fromPath: string;
  /** Where to write the generated roadmap (default: ROADMAP.md in project). */
  roadmapPath?: string;
  runner?: WorkerRunner;
  workerModel?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  hints?: ImportHints;
  onEvent?: (msg: string) => void;
}

export interface ImportResult {
  roadmapPath: string;
  slices: string[];
}

/**
 * Extract the generated roadmap markdown from worker stdout.
 * Last complete block wins (workers may emit a draft, then a corrected
 * version — same multi-turn rationale as report/review extraction).
 * Order: <<<OMPO_ROADMAP … >>> marker → ```markdown fenced block →
 * whole-output fallback (must contain a `## ` heading).
 */
export function extractRoadmapFromOutput(output: string): string | undefined {
  const open = output.lastIndexOf(IMPORT_OPEN);
  if (open >= 0) {
    const close = output.indexOf(IMPORT_CLOSE, open);
    if (close > open) {
      const inner = output.slice(open + IMPORT_OPEN.length, close).trim();
      if (inner) return inner;
    }
  }
  const fences = [...output.matchAll(/```(?:markdown|md)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    if (fences[i]![1]?.includes("## ")) return fences[i]![1]!.trim();
  }
  const trimmed = output.trim();
  if (trimmed.includes("## ")) return trimmed;
  return undefined;
}
export function buildImportPrompt(fromPath: string, hints: ImportHints = {}, targetFile = "ROADMAP.md"): string {
  const doneLine =
    hints.done?.length ?? 0
      ? `User-declared DONE (ground truth, do not second-guess): ${hints.done!.join(", ")}.`
      : "No user-declared done slices — infer progress from evidence.";
  const activeLine =
    hints.active?.length ?? 0
      ? `User-declared IN-PROGRESS (ground truth): ${hints.active!.join(", ")}.`
      : "No user-declared in-progress slice — infer it from evidence.";
  return `# Roadmap import task

You are converting a foreign roadmap into an ompo-executable ROADMAP.md.
The foreign roadmap uses an UNKNOWN template. Slice boundaries are SEMANTIC:
numbered steps, sections, phases, stages, checkboxes, or whatever the file
uses — never assume \`## \` headings or \`§\` markers. Read the whole file
and segment it by meaning, preserving the original execution order.

## Inputs to read (do this first, before writing anything)

1. Foreign roadmap: \`${fromPath}\` (read the full file).
2. Project progress evidence, to decide done / in-progress / remaining:
   - \`git log --oneline -15\`, \`git status --short\`, \`git diff --stat HEAD\`
   - Per-slice evidence dirs if present (e.g. \`qa/*/report.md\`): a slice with
     a completion record AND its work visible in the tree is DONE.
   - Working-tree state: staged/unstaged changes mark the slice they belong
     to as IN-PROGRESS, with the body narrowed to what is NOT yet done.
3. Repo conventions: \`AGENTS.md\` if present.

${doneLine}
${activeLine}

## Output rules (STRICT — the output is machine-parsed)

Emit exactly one block:

${IMPORT_OPEN}
<ompo roadmap markdown>
${IMPORT_CLOSE}

The inner markdown MUST follow this format and nothing else:

    ## [slice-id] Human title
    Body (what the worker must do — concrete, trimmed to remaining work).
    Depends: previous-id
    Verify: <repeatable command, exit 0 required>
    Files: <advisory allowlist, optional>
    Retries: 1
    Timeout: 60m             # only when the slice needs more than the 15m default

Rules:
- One \`## [id]\` section per slice, in original execution order. Content
  before the first \`## \` is ignored by the parser — put nothing load-bearing there.
- Ids: stable, lowercase slug style (e.g. \`s0-baseline\`, \`s1-identity\`).
  Derive from the foreign numbering/names so they stay recognizable.
  NEVER rename ids once a run starts.
- Every slice except the first gets \`Depends: <previous-id>\` (serial chain).
  Foreign roadmaps are sequential by default; only use fan-out deps when the
  source explicitly says slices are independent.
- The first slice gets NO Depends line — never write \`Depends: none\`.
- DONE slices: keep the section, keep its original position, add \`Skip: true\`
  and a one-line body noting where the evidence lives (e.g. \`Done — see qa/s0/report.md.\`).
- IN-PROGRESS slice: body contains ONLY the remainder. Delete finished items;
  never restate completed work (the worker would redo it). State the resume
  point in the first body line (e.g. \`Resume point: <what is left>.\`).
- FUTURE slices: full body translated from the foreign spec (goal + work +
  acceptance), concrete enough that one worker finishes in one session.
- SIZING (hard rule): one worker session ≈ 15 minutes of agentic work
  (explore + implement + verify). A foreign slice spanning 2+ distinct work
  areas (e.g. backend + UI, or flatten + deploy kit) MUST split into -a/-b
  parts with chained Depends, each fittable in one session. Single-area but
  heavy slices (large refactors, multi-file migrations) keep one section but
  get an explicit budget: \`Timeout: 30m\` (heavy) or \`Timeout: 60m\`
  (largest). Trivial slices omit Timeout (15m default). Never emit a slice
  that needs >60m — split it instead.
- Verify: lift repeatable gate commands from the foreign roadmap (test, build,
  type-check, per-slice E2E batch). At least one Verify per non-skipped slice.
  Drop prose gates that are not commands; keep them as body checklist lines.
- Non-slice material (principles, architecture locks, schedules, appendices,
  deferred items): do NOT become slices. Fold the load-bearing parts into the
  slice bodies that need them; ignore the rest.
- Output ONLY the converted slices. No preamble, no appendix, no deferred list.

Also write the same markdown to \`${targetFile}\` (overwrite, path relative to the project root).
`;
}

/** Project-relative markdown docs that may carry planning state. */
export interface DocCandidate {
  path: string;
  mtimeMs: number;
}

// Static skip-list: plain lookup table, never mutated at runtime.
const DOC_SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  ".git": true,
  ".omp": true,
  dist: true,
  build: true,
  coverage: true,
  vendor: true,
  ".next": true,
  ".turbo": true,
};

/**
 * Walk the project for markdown docs (newest first, capped). Skips
 * dependency/build/vcs dirs. Pure fs — unit-tested.
 */
export function collectDocCandidates(projectDir: string, limit = 40): DocCandidate[] {
  const out: DocCandidate[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit * 3) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (DOC_SKIP_DIRS[e.name] || e.name.startsWith(".")) continue;
        walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        try {
          out.push({ path: relative(projectDir, full), mtimeMs: statSync(full).mtimeMs });
        } catch {
          /* raced deletion */
        }
      }
    }
  };
  walk(projectDir);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

export function buildInitPrompt(candidates: DocCandidate[], targetFile = "ROADMAP.md"): string {
  const listed =
    candidates.length > 0
      ? candidates
        .map((c) => `- \`${c.path}\` (updated ${new Date(c.mtimeMs).toISOString().slice(0, 10)})`)
        .join("\n")
      : "(no markdown docs found — survey the code tree itself)";
  return `# Roadmap init task

You are bootstrapping an ompo-executable ROADMAP.md for a project you have
never seen. Survey the project, decide what is already built versus what
remains, and emit the remaining work as strict ompo slices.

## Inputs to read (do this first, before writing anything)

1. Candidate planning docs, newest first — the most recently updated one is
   usually the current source of truth. Cross-check its claims against the
   tree (code present = done, even if the doc says otherwise):
${listed}
2. Project state evidence:
   - \`git log --oneline -15\`, \`git status --short\` (when it is a repo)
   - Package manifest + test/build scripts (\`package.json\`, \`Makefile\`,
     \`pyproject.toml\`, …) to learn the real gate commands
   - Top-level layout (what exists: app code? tests? e2e? deploy config?)
3. Repo conventions: \`AGENTS.md\` if present.
4. Existing \`ROADMAP.md\` if present: treat it as one more input, superseded
   by newer evidence — never copy stale items the tree shows as done.

## Output rules (STRICT — the output is machine-parsed)

Emit exactly one block:

${IMPORT_OPEN}
<ompo roadmap markdown>
${IMPORT_CLOSE}

The inner markdown MUST follow this format and nothing else:

    ## [slice-id] Human title
    Body (goal + work + acceptance — concrete, remaining work only).
    Depends: previous-id
    Verify: <repeatable command you confirmed exists, exit 0 required>
    Files: <advisory allowlist, optional>
    Retries: 1
    Timeout: 60m             # only when the slice needs more than the 15m default

Rules:
- Skip what is built: completed work NEVER becomes a slice. When in doubt
  the tree beats the docs.
- Order slices by dependency (each slice except the first gets
  \`Depends: <previous-id>\`); fan out only for explicitly independent work.
  The first slice gets NO Depends line at all — never write \`Depends: none\`.
- Ids: stable, lowercase slug style (e.g. \`s0-baseline\`, \`s1-auth\`).
- SIZING (hard rule): one worker session ≈ 15 minutes of agentic work.
  Split multi-area work into -a/-b parts with chained Depends. Never emit
  a slice that needs >60m — split it instead.
- Verify: at least one per slice, lifted from the repo's real scripts.
  Drop prose gates that are not commands; keep them as body checklist lines.
- Content before the first \`## \` is ignored by the parser — put nothing
  load-bearing there.

Also write the same markdown to \`${targetFile}\` (overwrite, path relative to the project root).
`;
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.onEvent ?? (() => {});
  const roadmapPath = opts.roadmapPath ?? `${opts.projectDir}/ROADMAP.md`;
  // Fail early on unreadable source (clear error before spawning a worker).
  readFileSync(opts.fromPath, "utf8");
  const cfg = loadRoadmapConfig(opts.projectDir);
  const runner: WorkerRunner = opts.runner ?? runOmpWorker;
  const targetFile = relative(opts.projectDir, roadmapPath) || "ROADMAP.md";
  const prompt = buildImportPrompt(opts.fromPath, opts.hints, targetFile);

  log(`importing roadmap from ${opts.fromPath} (agentic worker)…`);
  const res = await runner(
    { prompt, sliceId: "import", attempt: 1 },
    {
      projectDir: opts.projectDir,
      workerModel: opts.workerModel ?? cfg.workerModel,
      timeoutMs: opts.timeoutMs ?? (cfg.workerTimeoutSec ? cfg.workerTimeoutSec * 1000 : undefined),
      extraArgs: opts.extraArgs,
    },
  );
  if (res.timedOut || res.exit !== 0) {
    throw new Error(
      `import worker failed (exit=${res.exit}, timedOut=${res.timedOut}): ${res.stderr.slice(-2000)}`,
    );
  }
  const markdown = extractRoadmapFromOutput(res.stdout);
  if (!markdown) {
    throw new Error(
      `import worker produced no roadmap block (expected ${IMPORT_OPEN} … ${IMPORT_CLOSE}). stdout tail: ${res.stdout.slice(-2000)}`,
    );
  }
  // Fail closed: the generated file must parse as a strict ompo roadmap.
  const doc = parseRoadmap(markdown);
  mkdirSync(dirname(roadmapPath), { recursive: true });
  writeFileSync(roadmapPath, (markdown.endsWith("\n") ? markdown : markdown + "\n"), "utf8");
  log(`import OK: ${doc.slices.length} slices (${doc.slices.map((s) => s.id).join(", ")}) → ${roadmapPath}`);
  return { roadmapPath, slices: doc.slices.map((s) => s.id) };
}

export interface InitPlannerOptions {
  projectDir: string;
  /** Where to write the generated roadmap (default: ROADMAP.md in project). */
  roadmapPath?: string;
  runner?: WorkerRunner;
  workerModel?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  onEvent?: (msg: string) => void;
  /** Live worker progress lines (default: routed to onEvent). */
  onProgress?: (line: string) => void;
  /** Abort the planner worker (the unified TUI passes its controller). */
  signal?: AbortSignal;
}

/**
 * Agentic init: survey project docs + tree, emit a strict ompo roadmap.
 * Same extract → parse → write pipeline as runImport (fail closed).
 */
export async function runInitPlanner(opts: InitPlannerOptions): Promise<ImportResult> {
  const log = opts.onEvent ?? (() => {});
  const roadmapPath = opts.roadmapPath ?? `${opts.projectDir}/ROADMAP.md`;
  const candidates = collectDocCandidates(opts.projectDir);
  const cfg = loadRoadmapConfig(opts.projectDir);
  const runner: WorkerRunner = opts.runner ?? runOmpWorker;
  const targetFile = relative(opts.projectDir, roadmapPath) || "ROADMAP.md";
  const prompt = buildInitPrompt(candidates, targetFile);

  log(`planning roadmap from ${candidates.length} project doc(s) (agentic worker)…`);
  const progress = opts.onProgress ?? ((line: string) => log(line));
  const spawn = (task: string) =>
    runner(
      { prompt: task, sliceId: "init", attempt: 1 },
      {
        projectDir: opts.projectDir,
        workerModel: opts.workerModel ?? cfg.workerModel,
        timeoutMs: opts.timeoutMs ?? (cfg.workerTimeoutSec ? cfg.workerTimeoutSec * 1000 : undefined),
        extraArgs: opts.extraArgs,
        signal: opts.signal,
        onProgress: progress,
      },
    );
  const res = await spawn(prompt);
  if (res.timedOut || res.exit !== 0) {
    throw new Error(
      `init planner failed (exit=${res.exit}, timedOut=${res.timedOut}): ${res.stderr.slice(-2000)}`,
    );
  }
  const extract = (stdout: string): string => {
    const markdown = extractRoadmapFromOutput(stdout);
    if (!markdown) {
      throw new Error(
        `init planner produced no roadmap block (expected ${IMPORT_OPEN} … ${IMPORT_CLOSE}). stdout tail: ${stdout.slice(-2000)}`,
      );
    }
    return markdown;
  };
  // One bounded self-correction: a strict-parse failure goes back to the
  // planner with the error quoted, instead of failing the whole init.
  let markdown: string;
  try {
    markdown = extract(res.stdout);
    parseRoadmap(markdown);
  } catch (err) {
    if (!(err instanceof RoadmapParseError)) throw err;
    log(`planner output failed to parse (${err.message.slice(0, 200)}) — one retry with the error quoted…`);
    const retry = await spawn(
      `${prompt}\n## Fix requested\nYour previous output failed strict parsing with this error:\n${err.message}\nEmit ONLY the corrected ${IMPORT_OPEN} … ${IMPORT_CLOSE} block.`,
    );
    if (retry.timedOut || retry.exit !== 0) {
      throw new Error(
        `init planner retry failed (exit=${retry.exit}, timedOut=${retry.timedOut}): ${retry.stderr.slice(-2000)}`,
      );
    }
    markdown = extract(retry.stdout);
  }
  // Fail closed: the generated file must parse as a strict ompo roadmap.
  const doc = parseRoadmap(markdown);
  mkdirSync(dirname(roadmapPath), { recursive: true });
  writeFileSync(roadmapPath, (markdown.endsWith("\n") ? markdown : markdown + "\n"), "utf8");
  log(`init OK: ${doc.slices.length} slices (${doc.slices.map((s) => s.id).join(", ")}) → ${roadmapPath}`);
  return { roadmapPath, slices: doc.slices.map((s) => s.id) };
}

/** What `ompo init` should do with ROADMAP.md. */
export type InitPlan = "keep" | "template" | "plan";

export interface InitPlanInput {
  /** Current ROADMAP.md content, or null when absent. */
  existing: string | null;
  template?: boolean;
  replan?: boolean;
  /** The blank template text (owned by cli.ts) for pristine detection. */
  blankTemplate: string;
}

/**
 * Never destroy real work by default: an existing, edited roadmap is kept
 * unless --replan; an untouched blank template carries no information, so
 * it is planned over like a missing file. Pure — unit-tested.
 */
export function resolveInitPlan(input: InitPlanInput): InitPlan {
  const edited = input.existing !== null && input.existing.trim() !== input.blankTemplate.trim();
  if (input.template && (input.replan || !edited)) return "template";
  if (edited && !input.replan) return "keep";
  return "plan";
}

export const ROADMAP_TEMPLATE = `# Roadmap — <project>

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

export const YML_TEMPLATE = `# ompo project-local config — all keys optional.
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

/** Write .omp/roadmap.yml when absent (shared by init + unified flows). */
export function ensureProjectConfig(projectDir: string, onEvent?: (m: string) => void): void {
  const log = onEvent ?? (() => {});
  const dir = join(projectDir, ".omp");
  const ymlPath = join(dir, "roadmap.yml");
  if (!existsSync(ymlPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(ymlPath, YML_TEMPLATE, "utf8");
    log(`wrote ${ymlPath}`);
  } else {
    log(`kept existing ${ymlPath}`);
  }
}
