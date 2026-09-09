/**
 * Planner preview — inspection/approval boundary before execution (Sprint 4).
 *
 * Execution is more mature than planning: the planner exposes too little
 * before the loop starts spending model calls. This module surfaces what is
 * already computable — slice ids/titles, Effort, Verify gates, Files, Depends,
 * and the existing lint findings — with no invented metrics (no ETA, cost,
 * or success forecasts).
 *
 * Reuses the parsed roadmap structures and `lintRoadmap` directly: there is
 * exactly one roadmap schema and one lint implementation. `lintRoadmap`
 * already folds parse failures (unknown deps, cycles, bad trailers) into
 * errors, so the preview status is a pure function of its result.
 */

import { parseRoadmap } from "./parse.ts";
import { lintRoadmap, type LintFinding, type LintOptions } from "./lint.ts";

export type PreviewDecision = "accept" | "edit" | "abort";

/** Resolve a preview into a decision (TUI keypress, CLI prompt, or test fake). */
export type PreviewHandler = (preview: PlanPreview) => Promise<PreviewDecision>;

export interface PlanPreviewRow {
  id: string;
  title: string;
  /** Effort trailer, or "(none)" when the slice omits it. */
  effort: string;
  verifyCount: number;
  /** Full Verify: gate commands in slice order (empty when the slice omits them). */
  verify: string[];
  /** Files: allowlist declared by the slice (advisory for spec-builder). */
  files: string[];
  deps: string[];
  errors: LintFinding[];
  warnings: LintFinding[];
}

export interface PlanPreview {
  rows: PlanPreviewRow[];
  errors: LintFinding[];
  warnings: LintFinding[];
  /** ready: no findings · warnings: valid with caveats · blocked: errors. */
  status: "ready" | "warnings" | "blocked";
}

/**
 * Build the preview for a roadmap markdown text. Pure — the unit-test seam.
 * Unparseable roadmaps yield zero rows with the parse error in `errors`.
 */
export function buildPlanPreview(markdown: string, opts: LintOptions = {}): PlanPreview {
  const linted = lintRoadmap(markdown, opts);
  let rows: PlanPreviewRow[] = [];
  try {
    const doc = parseRoadmap(markdown);
    rows = doc.slices.map((s) => ({
      id: s.id,
      title: s.title,
      effort: s.effort ?? "(none)",
      verifyCount: s.verify.length,
      verify: [...s.verify],
      files: [...s.files],
      deps: [...s.deps],
      errors: linted.errors.filter((f) => f.slice === s.id),
      warnings: linted.warnings.filter((f) => f.slice === s.id),
    }));
  } catch {
    // parseRoadmap threw, so lintRoadmap already recorded the parse error.
    // Rows stay empty: there is no trustworthy structure to show.
    rows = [];
  }
  return {
    rows,
    errors: linted.errors,
    warnings: linted.warnings,
    status: linted.errors.length > 0 ? "blocked" : linted.warnings.length > 0 ? "warnings" : "ready",
  };
}

/** One-line status for logs: counts, never forecasts. */
export function formatPreviewSummary(p: PlanPreview): string {
  const base = `plan preview: ${p.rows.length} slice(s) — ${p.status}`;
  const tails: string[] = [];
  if (p.errors.length > 0) tails.push(`${p.errors.length} error(s)`);
  if (p.warnings.length > 0) tails.push(`${p.warnings.length} warning(s)`);
  return tails.length > 0 ? `${base} (${tails.join(", ")})` : base;
}

/** Render preview rows for humans (TUI pane + `ompo plan` + log lines). Pure. */
export function renderPreviewLines(p: PlanPreview): string[] {
  const out: string[] = [];
  for (const r of p.rows) {
    const gates = r.verifyCount === 0 ? "no Verify" : `${r.verifyCount} gate(s)`;
    const deps = r.deps.length > 0 ? ` ← ${r.deps.join(",")}` : "";
    const marks: string[] = [];
    if (r.errors.length > 0) marks.push(`${r.errors.length} error(s)`);
    if (r.warnings.length > 0) marks.push(`${r.warnings.length} warning(s)`);
    out.push(`  ${r.id} — ${r.title} [${r.effort}] ${gates}${deps}${marks.length > 0 ? ` (! ${marks.join(", ")})` : ""}`);
  }
  for (const f of [...p.errors, ...p.warnings]) {
    out.push(`  ${f.level === "error" ? "error" : "warn"} [${f.code}]${f.slice ? ` ${f.slice}:` : ""} ${f.message.split("\n")[0]}`);
  }
  return out;
}


/**
 * Headless/test default: valid plans proceed, blocked plans throw — an
 * invalid roadmap never silently proceeds to execution.
 */
export async function defaultPreviewDecision(p: PlanPreview): Promise<PreviewDecision> {
  if (p.status === "blocked") {
    const first = p.errors[0];
    const where = first ? ` (${first.code}${first.slice ? ` ${first.slice}` : ""}: ${first.message.split("\n")[0]?.slice(0, 200)})` : "";
    throw new Error(`roadmap has ${p.errors.length} blocking error(s)${where} — fix the roadmap and re-run`);
  }
  return "accept";
}