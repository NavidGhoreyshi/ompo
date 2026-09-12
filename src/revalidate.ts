/**
 * `ompo revalidate` — agentic roadmap truth-check (explicit, never automatic).
 *
 * Resume trusts the map's *structure* (hash drift → replan, lost merges →
 * demote); it never judges whether the map *describes reality*. When an
 * interrupted run leaves you distrusting the map itself — stale Skip claims,
 * a remainder that moved on, futures that no longer fit — this worker reads
 * the same evidence the importer uses (run cursor + events, git log/status,
 * qa reports, working tree) and proposes a revised ROADMAP.md.
 *
 * The proposal goes through the same gates as any plan: it must parse and
 * pass lint (blocked proposals are never presented). Adoption stays human:
 * the worker never touches ROADMAP.md — review the diff, copy it over, then
 * the existing `ompo replan --run` adopts it without losing done work.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { loadRoadmapConfig } from "./config.ts";
import { loadGlobalConfig, mergeConfigs, resolveRoles } from "./globalConfig.ts";
import { extractRoadmapFromOutput, IMPORT_CLOSE, IMPORT_OPEN } from "./import.ts";
import { lintRoadmap } from "./lint.ts";
import { parseRoadmap } from "./parse.ts";
import { listRuns, loadRun } from "./store.ts";
import { runOmpWorker, type WorkerRunner } from "./worker.ts";

export interface RevalidateOptions {
  projectDir: string;
  /** Run whose cursor the worker audits (default: latest). */
  runId?: string;
  /** Current map under audit (default: ROADMAP.md in project). */
  roadmapPath?: string;
  /** Where to write the proposal (default: ROADMAP.revalidate.md next to the map). */
  outPath?: string;
  runner?: WorkerRunner;
  workerModel?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  onEvent?: (msg: string) => void;
}

export interface RevalidateResult {
  proposalPath: string;
  slices: string[];
}

export function buildRevalidatePrompt(projectDir: string, runId: string, roadmapRel: string): string {
  return `# Roadmap revalidation task

You are auditing an ompo ROADMAP.md against project reality after an
interrupted run. The map may lie: slices marked done that never landed,
remainders that moved on, futures that no longer fit. Decide every slice
from EVIDENCE, never from the map's own claims.

## Inputs to read (do this first, before writing anything)

1. Current map: \`${roadmapRel}\` (read the full file — this is the claim under audit).
2. Run cursor: \`.omp/roadmap/runs/${runId}/roadmap.json\` (per-slice status,
   attempts, verifiedHead) plus the event tail:
   \`tail -40 .omp/roadmap/runs/${runId}/events.jsonl\`.
3. Project truth, same as an import:
   - \`git log --oneline -15\`, \`git status --short\`, \`git diff --stat HEAD\`
   - Per-slice evidence dirs if present (e.g. \`qa/*/report.md\`): a slice with
     a completion record AND its work visible in the tree is DONE.
   - Slice branches \`git branch --list 'ompo/${runId}/*'\`: a done slice whose
     branch is merged is confirmed; a missing branch with no record is suspect.
   - Working-tree state: staged/unstaged changes mark the slice they belong
     to as IN-PROGRESS, with the body narrowed to what is NOT yet done.
4. Repo conventions: \`AGENTS.md\` if present.

Project root for every path above: \`${projectDir}\`.

## Output rules (STRICT — the output is machine-parsed)

Emit exactly one block:

${IMPORT_OPEN}
<revised ompo roadmap markdown>
${IMPORT_CLOSE}

The inner markdown MUST follow the ompo roadmap format (one \`## [id]\`
section per slice) with these audit rules:

- Ids: STABLE. Never rename an id — replan matches by id, and a rename
  drops that slice's run history (status, attempts, verdicts).
- VERIFIED done (record + work in tree, or branch merged): keep the section,
  keep its position, add \`Skip: true\` and a one-line body noting the
  evidence (e.g. \`Done — see qa/s0/report.md.\`).
- SUSPECT done (map claims done, evidence missing): do NOT mark Skip. Keep
  the full body so the slice re-runs, and open the body with
  \`Revalidate: <what evidence was missing>.\`
- IN-PROGRESS: body contains ONLY the remainder. Delete finished items;
  never restate completed work (the worker would redo it). State the resume
  point in the first body line.
- FUTURE: keep the Depends chain and full body; every non-skipped slice
  keeps at least one repeatable \`Verify:\` command (test, build, E2E batch).
  Drop prose gates that are not commands.
- SIZING: one worker session ≈ 15 minutes of agentic work. Split anything
  spanning 2+ work areas into -a/-b parts with chained Depends.

Do NOT write \`${roadmapRel}\` or any other project file — output the
proposal ONLY inside the marker block. A human adopts it after review.
`;
}

export async function runRevalidate(opts: RevalidateOptions): Promise<RevalidateResult> {
  const log = opts.onEvent ?? (() => {});
  const roadmapPath = opts.roadmapPath ?? join(opts.projectDir, "ROADMAP.md");
  // Fail early on unreadable inputs (clear errors before spawning a worker).
  readFileSync(roadmapPath, "utf8");
  const runs = listRuns(opts.projectDir);
  const runId = opts.runId ?? runs[runs.length - 1];
  if (!runId) throw new Error("no runs to revalidate — nothing has run yet");
  loadRun(opts.projectDir, runId);
  const cfg = loadRoadmapConfig(opts.projectDir);
  const globalCfg = loadGlobalConfig();
  const roles = resolveRoles(cfg, globalCfg);
  const effective = mergeConfigs(cfg, globalCfg);
  const runner: WorkerRunner = opts.runner ?? runOmpWorker;
  const prompt = buildRevalidatePrompt(opts.projectDir, runId, relative(opts.projectDir, roadmapPath) || "ROADMAP.md");

  log(`revalidating ${roadmapPath} against run ${runId} (agentic worker)…`);
  const res = await runner(
    { prompt, sliceId: "revalidate", attempt: 1 },
    {
      projectDir: opts.projectDir,
      workerModel: opts.workerModel ?? roles.orchestrator.model,
      timeoutMs: opts.timeoutMs ?? (effective.workerTimeoutSec ? effective.workerTimeoutSec * 1000 : undefined),
      extraArgs: opts.extraArgs,
    },
  );
  if (res.timedOut || res.exit !== 0) {
    throw new Error(
      `revalidate worker failed (exit=${res.exit}, timedOut=${res.timedOut}): ${res.stderr.slice(-2000)}`,
    );
  }
  const markdown = extractRoadmapFromOutput(res.stdout);
  if (!markdown) {
    throw new Error(
      `revalidate worker produced no roadmap block (expected ${IMPORT_OPEN} … ${IMPORT_CLOSE}). stdout tail: ${res.stdout.slice(-2000)}`,
    );
  }
  // Fail closed twice: the proposal must parse AND pass lint — a blocked
  // proposal is never presented for adoption (same rule as the plan preview).
  const doc = parseRoadmap(markdown);
  const lint = lintRoadmap(markdown, { verifyDefaults: cfg.verifyDefaults, agentModels: cfg.agentModels });
  if (lint.errors.length > 0) {
    throw new Error(
      `revalidate proposal is blocked (${lint.errors.length} error(s), first: ${lint.errors[0]!.code} ${lint.errors[0]!.slice ?? ""}) — refusing to present it`,
    );
  }
  const outPath = opts.outPath ?? join(dirname(roadmapPath), "ROADMAP.revalidate.md");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, (markdown.endsWith("\n") ? markdown : markdown + "\n"), "utf8");
  log(`revalidate OK: ${doc.slices.length} slices → ${outPath}`);
  log(`adopt: diff ${roadmapPath} ${outPath} && cp ${outPath} ${roadmapPath} && ompo plan && ompo replan --run ${runId}`);
  return { proposalPath: outPath, slices: doc.slices.map((s) => s.id) };
}
