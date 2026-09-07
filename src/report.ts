/**
 * CompletionReport validation + extraction (plan §12, M3).
 * Out-of-core mirror of the in-core strict outputSchema pipeline:
 * prompt contract → extract → validate → retry (max 3 parse attempts worth
 * of strictness collapses to one extraction + one validation here; the
 * retry loop lives in loop.ts at slice granularity).
 */

import type { CompletionReport } from "./types.ts";

export class ReportValidationError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`invalid completion report: ${reasons.join("; ")}`);
    this.name = "ReportValidationError";
    this.reasons = reasons;
  }
}

export const REPORT_OPEN = "<<<OMPO_REPORT";
export const REPORT_CLOSE = ">>>";

/** Harness-fix block markers (HARP-1): debugger-issued, loop-applied. */
export const HARNESS_OPEN = "<<<OMPO_HARNESS_FIX";
export const HARNESS_CLOSE = ">>>";

/**
 * A machine-parsable harness fix a debugger may append to its report when the
 * failing gate is broken by harness/verify plumbing (proxy 502, stale
 * DATABASE_URL in a Verify command) rather than by slice code. The orchestrator
 * validates the rails and applies the diff to the worktree before re-running
 * the gate; the slice branch's own merge lands it on the base checkout.
 */
export interface HarnessFix {
  /** Must match the run report's sliceId. */
  sliceId: string;
  /** Repo-relative paths, all present at base HEAD, none slice-owned. */
  filesPatched: string[];
  /** Unified diff applied with `git apply --3way` (≤ MAX_HARNESS_DIFF_LINES). */
  diff: string;
  /** 5-20 words: why the harness bug broke this slice's gate. */
  summary: string;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Extract the report payload from worker stdout.
 * Order: <<<OMPO_REPORT {...} >>> marker → ```json fenced block →
 * whole-output JSON. Returns undefined when nothing parses.
 */
export function extractReportFromOutput(output: string): unknown | undefined {
  const open = output.indexOf(REPORT_OPEN);
  if (open >= 0) {
    const close = output.indexOf(REPORT_CLOSE, open);
    if (close > open) {
      const inner = output.slice(open + REPORT_OPEN.length, close).trim();
      const parsed = tryParseJson(inner);
      if (parsed !== undefined) return parsed;
    }
  }
  const fence = output.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) {
    const parsed = tryParseJson(fence[1]!.trim());
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null && "sliceId" in parsed) {
      return parsed;
    }
  }
  const trimmed = output.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const parsed = tryParseJson(trimmed);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === "string");
}

/**
 * Extract the harness-fix block from debugger stdout: the first
 * `<<<OMPO_HARNESS_FIX` … `>>>` region parsed as JSON. Returns undefined when
 * no block exists or its body does not parse (rail validation happens later in
 * `validateHarnessFix`).
 */
export function extractHarnessFix(output: string): HarnessFix | undefined {
  const open = output.indexOf(HARNESS_OPEN);
  if (open < 0) return undefined;
  const close = output.indexOf(HARNESS_CLOSE, open);
  if (close <= open) return undefined;
  const parsed = tryParseJson(output.slice(open + HARNESS_OPEN.length, close).trim());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as HarnessFix;
}

export function validateCompletionReport(
  data: unknown,
  expectedSliceId: string,
): CompletionReport {
  const reasons: string[] = [];
  if (typeof data !== "object" || data === null) {
    throw new ReportValidationError(["report must be a JSON object"]);
  }
  const r = data as Record<string, unknown>;
  if (r["sliceId"] !== expectedSliceId) {
    reasons.push(`sliceId must be "${expectedSliceId}", got ${JSON.stringify(r["sliceId"])}`);
  }
  if (typeof r["summary"] !== "string" || r["summary"].trim() === "") {
    reasons.push("summary must be a non-empty string");
  }
  if (!isStringArray(r["filesChanged"])) reasons.push("filesChanged must be string[]");
  if (!isStringArray(r["testsRun"])) reasons.push("testsRun must be string[]");
  if (typeof r["testsPassed"] !== "boolean") reasons.push("testsPassed must be boolean");
  if (typeof r["verificationNotes"] !== "string") {
    reasons.push("verificationNotes must be a string");
  }
  if (!isStringArray(r["followUps"])) reasons.push("followUps must be string[]");
  if (!isStringArray(r["deferred"])) reasons.push("deferred must be string[]");
  if (typeof r["done"] !== "boolean") reasons.push("done must be boolean");
  if (reasons.length) throw new ReportValidationError(reasons);
  return {
    sliceId: expectedSliceId,
    summary: (r["summary"] as string).trim(),
    filesChanged: r["filesChanged"] as string[],
    testsRun: r["testsRun"] as string[],
    testsPassed: r["testsPassed"] as boolean,
    verificationNotes: r["verificationNotes"] as string,
    followUps: r["followUps"] as string[],
    deferred: r["deferred"] as string[],
    done: r["done"] as boolean,
  };
}

/** Canonical report block workers are instructed to print. */
export function reportBlockSkeleton(sliceId: string): string {
  return `${REPORT_OPEN}
${JSON.stringify(
    {
      sliceId,
      summary: "<one-paragraph outcome>",
      filesChanged: ["path/to/file"],
      testsRun: ["<command>"],
      testsPassed: true,
      verificationNotes: "<how you verified>",
      followUps: [],
      deferred: [],
      done: true,
    },
    null,
    2,
  )}
${REPORT_CLOSE}
// Debug sessions ONLY — optional <<<OMPO_HARNESS_FIX { "sliceId": ..., "filesPatched": [...],
// "diff": ..., "summary": ... } >>> block for broken harness tooling (Playwright proxy 502).
// NOT for implementers, do NOT print — see the debug prompt's rule 5b.
`;
}
