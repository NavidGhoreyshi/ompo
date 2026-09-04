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
      done: true,
    },
    null,
    2,
  )}
${REPORT_CLOSE}`;
}
