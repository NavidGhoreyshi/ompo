/**
 * Worker-spec compiler (plan §12, M3): slice → prompt + file allowlist.
 *
 * Anti-exhaustion invariant: worker input is O(slice + dep-summaries),
 * never O(history). Truncation order: dep-summaries → body; fail closed
 * when the slice alone exceeds the budget.
 */

import type { RoadmapDoc, Slice } from "./types.ts";
import { reportBlockSkeleton } from "./report.ts";

export interface SpecOptions {
  /** Total prompt budget in chars (default 12000). */
  maxChars?: number;
  /** sliceId → summary of done deps (from their report.json). */
  depSummaries?: Map<string, string>;
  /** Project-relative working directory note for the worker. */
  projectDir?: string;
  /** Extra repo conventions to cite (default AGENTS.md). */
  conventions?: string[];
}

export interface WorkerSpec {
  prompt: string;
  files: string[];
  budgetChars: number;
  usedChars: number;
  truncatedDeps: boolean;
}

export const DEFAULT_SPEC_BUDGET = 12_000;

function depSummaryLines(slice: Slice, depSummaries?: Map<string, string>): string[] {
  if (slice.deps.length === 0) return ["(none)"];
  return slice.deps.map((d) => {
    const s = depSummaries?.get(d);
    return s ? `- ${d}: ${s}` : `- ${d}: (no summary recorded)`;
  });
}

export function buildWorkerSpec(
  slice: Slice,
  _doc: RoadmapDoc,
  attempt: number,
  opts: SpecOptions = {},
): WorkerSpec {
  const budget = opts.maxChars ?? DEFAULT_SPEC_BUDGET;
  const conventions = opts.conventions ?? ["AGENTS.md"];
  const files = [...slice.files];

  const header =
    `# Task slice: ${slice.id} — ${slice.title} (attempt ${attempt})\n\n` +
    `You are a mechanical implementer working on ONE slice of a larger roadmap. ` +
    `Do exactly what this slice asks. Do not refactor unrelated code. Do not expand scope.\n\n`;

  const scope = `## Slice\n\n${slice.body || "(no body)"}\n`;
  const effort = slice.effort ? `\nSuggested effort: ${slice.effort} (lo=quick, med=normal, hi=thorough).\n` : "";

  const filesNote =
    files.length > 0
      ? `\n## Files in scope\n${files.map((f) => `- ${f}`).join("\n")}\n(Read only what you need; prefer these paths.)\n`
      : `\n## Files in scope\n(not declared — discover minimal paths yourself, keep the diff small.)\n`;

  const conventionsNote = `\n## Repo conventions\nFollow ${conventions.join(", ")} if present.\n`;

  const contract =
    `\n## Completion contract (STRICT)\n` +
    `1. Implement the slice, then verify it yourself (run relevant tests/lint).\n` +
    `2. When done, print EXACTLY one report block, no prose outside it beyond a short note:\n\n` +
    `${reportBlockSkeleton(slice.id)}\n\n` +
    `Rules: sliceId must equal "${slice.id}". done=true only when the slice body is fully ` +
    `implemented AND you ran verification. filesChanged lists repo-relative paths you touched. ` +
    `If you cannot complete, still print the block with done=false and explain in verificationNotes.\n`;

  // Budget: header + scope are mandatory; shrink dep lines, then body.
  let depLines = depSummaryLines(slice, opts.depSummaries);
  let truncatedDeps = false;
  const fixed = header + effort + filesNote + conventionsNote + contract;

  const fit = (bodyText: string, deps: string[]): string =>
    fixed + `## Dependencies (summaries only — never full transcripts)\n${deps.join("\n")}\n\n` + `## Slice\n\n${bodyText}\n`;

  // Note: scope duplicates body; rebuild with truncation-aware body.
  void scope;
  let bodyText = slice.body || "(no body)";
  const mandatory = header + effort + filesNote + conventionsNote + contract +
    "## Dependencies (summaries only — never full transcripts)\n(none)\n\n## Slice\n\n\n";
  if (mandatory.length + slice.title.length > budget) {
    throw new Error(
      `slice "${slice.id}" exceeds worker prompt budget (${budget} chars) before content — split the slice`,
    );
  }

  // Shrink dep summaries first.
  let prompt = fit(bodyText, depLines);
  while (prompt.length > budget && depLines.length > 1) {
    depLines = depLines.slice(0, Math.max(1, Math.floor(depLines.length / 2)));
    truncatedDeps = true;
    prompt = fit(bodyText, [...depLines, `(${slice.deps.length - depLines.length} more summaries dropped for budget)`]);
  }
  if (prompt.length > budget && depLines.length >= 1 && slice.deps.length > 0) {
    depLines = [`(${slice.deps.length} dependency summaries dropped for budget — see report files if needed)`];
    truncatedDeps = true;
    prompt = fit(bodyText, depLines);
  }
  // Then shrink body.
  while (prompt.length > budget && bodyText.length > 500) {
    bodyText = bodyText.slice(0, Math.floor(bodyText.length * 0.7));
    prompt = fit(bodyText + "\n\n[…body truncated for budget…]", depLines);
  }
  if (prompt.length > budget) {
    throw new Error(
      `slice "${slice.id}" body alone exceeds worker prompt budget (${budget} chars) — split the slice`,
    );
  }

  return { prompt, files, budgetChars: budget, usedChars: prompt.length, truncatedDeps };
}
