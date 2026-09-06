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

import { readFileSync, writeFileSync } from "node:fs";
import { parseRoadmap } from "./parse.ts";
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
 * Order: <<<OMPO_ROADMAP … >>> marker → ```markdown fenced block →
 * whole-output fallback (must contain a `## ` heading).
 */
export function extractRoadmapFromOutput(output: string): string | undefined {
  const open = output.indexOf(IMPORT_OPEN);
  if (open >= 0) {
    const close = output.indexOf(IMPORT_CLOSE, open);
    if (close > open) {
      const inner = output.slice(open + IMPORT_OPEN.length, close).trim();
      if (inner) return inner;
    }
  }
  const fence = output.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/);
  if (fence?.[1]?.includes("## ")) return fence[1].trim();
  const trimmed = output.trim();
  if (trimmed.includes("## ")) return trimmed;
  return undefined;
}

export function buildImportPrompt(fromPath: string, hints: ImportHints = {}): string {
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

Also write the same markdown to \`ROADMAP.md\` in the project root (overwrite).
`;
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.onEvent ?? (() => {});
  const roadmapPath = opts.roadmapPath ?? `${opts.projectDir}/ROADMAP.md`;
  // Fail early on unreadable source (clear error before spawning a worker).
  readFileSync(opts.fromPath, "utf8");
  const cfg = loadRoadmapConfig(opts.projectDir);
  const runner: WorkerRunner = opts.runner ?? runOmpWorker;
  const prompt = buildImportPrompt(opts.fromPath, opts.hints);

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
  writeFileSync(roadmapPath, (markdown.endsWith("\n") ? markdown : markdown + "\n"), "utf8");
  log(`import OK: ${doc.slices.length} slices (${doc.slices.map((s) => s.id).join(", ")}) → ${roadmapPath}`);
  return { roadmapPath, slices: doc.slices.map((s) => s.id) };
}
