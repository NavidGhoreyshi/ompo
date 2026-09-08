/**
 * Independent review gate — the orchestrator's own eyes on every slice.
 *
 * After worker + verify + merge, a FRESH reviewer session (own model via
 * `reviewModel`, own context, no worker transcript) audits the slice against
 * the merged tree: report claims vs files on disk, spot-checks, focused
 * re-verification. It never trusts the worker's self-report.
 *
 * Approve → slice done. Reject → findings feed the next attempt's prompt
 * (same retry budget as any other failure).
 */

import type { CompletionReport, Slice } from "./types.ts";

export const REVIEW_OPEN = "<<<OMPO_REVIEW";
export const REVIEW_CLOSE = ">>>";

export interface ReviewVerdict {
  sliceId: string;
  approved: boolean;
  findings: string[];
  notes: string;
  /**
   * Rejection weight. `minor` = polish the worker can fix without redesign
   * (lint, naming, a missing edge test, docs, small scope widening);
   * `major` = the slice is wrong (behavior, missing functionality, weakened
   * tests, unrelated diffs). Minor rejections earn one bounded fix session +
   * re-review inside the same attempt; major rejections spend retry budget
   * like any other failure. Absent/invalid parses as `major` (safe default).
   */
  severity: "minor" | "major";
}

export class ReviewValidationError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`invalid review verdict: ${reasons.join("; ")}`);
    this.name = "ReviewValidationError";
    this.reasons = reasons;
  }
}

/** Last complete verdict block wins (same multi-turn rationale as workers). */
export function extractReviewFromOutput(output: string): unknown | undefined {
  const open = output.lastIndexOf(REVIEW_OPEN);
  if (open < 0) return undefined;
  const close = output.indexOf(REVIEW_CLOSE, open);
  if (close < 0) return undefined;
  try {
    return JSON.parse(output.slice(open + REVIEW_OPEN.length, close).trim());
  } catch {
    return undefined;
  }
}

/** Normalize one findings entry to a plain string.
 * Models often emit structured {file, behavior, spec} objects despite the
 * string[] contract — those carry the file/behavior/spec the prompt asks
 * for, so render them instead of rejecting the verdict. Returns undefined
 * for entries with no readable content. */
export function formatReviewFinding(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    const s = entry.trim();
    return s ? s : undefined;
  }
  if (typeof entry === "object" && entry !== null) {
    const r = entry as Record<string, unknown>;
    const parts = ["file", "behavior", "spec", "message", "detail", "reason"]
      .map((k) => r[k])
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((s) => s.trim());
    if (parts.length > 0) return parts.join(" — ");
    try {
      const s = JSON.stringify(entry);
      return s && s !== "{}" ? s : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Normalize a findings array; undefined when any entry is unreadable. */
export function formatReviewFindings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const e of v) {
    const s = formatReviewFinding(e);
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
}


export function validateReviewVerdict(data: unknown, expectedSliceId: string): ReviewVerdict {
  const reasons: string[] = [];
  if (typeof data !== "object" || data === null) {
    throw new ReviewValidationError(["verdict must be a JSON object"]);
  }
  const r = data as Record<string, unknown>;
  if (r["sliceId"] !== expectedSliceId) {
    reasons.push(`sliceId must be "${expectedSliceId}", got ${JSON.stringify(r["sliceId"])}`);
  }
  if (typeof r["approved"] !== "boolean") reasons.push("approved must be boolean");
  const findings = formatReviewFindings(r["findings"]);
  if (findings === undefined) reasons.push("findings must be string[]");
  if (typeof r["notes"] !== "string") reasons.push("notes must be a string");
  const severity = r["severity"] === "minor" ? "minor" : "major";
  if (r["approved"] === false && findings !== undefined && findings.length === 0) {
    reasons.push("approved=false requires at least one entry in findings");
  }
  if (reasons.length) throw new ReviewValidationError(reasons);
  return {
    sliceId: expectedSliceId,
    approved: r["approved"] as boolean,
    findings: findings as string[],
    notes: r["notes"] as string,
    severity,
  };
}

export function reviewBlockSkeleton(sliceId: string): string {
  return `${REVIEW_OPEN}
${JSON.stringify(
    {
      sliceId,
      approved: true,
      findings: [],
      notes: "<what you checked independently and the result>",
      severity: "major",
    },
    null,
    2,
  )}
${REVIEW_CLOSE}`;
}

export function buildReviewPrompt(slice: Slice, report: CompletionReport, verdictCommands: string[]): string {
  return `# Review slice: ${slice.id} — ${slice.title}

You are an INDEPENDENT auditor. A worker claims this slice is done; your job
is to verify the claim against the repository itself, not the worker's words.
You have full read access and may run commands. You share no context with the
worker — its transcript is not visible, only its report below.

## Slice spec (what was required)

${slice.body || "(no body)"}

## Worker report (CLAIM — verify, do not trust)

Summary: ${report.summary}
Files changed: ${report.filesChanged.join(", ") || "(none listed)"}
Tests run: ${report.testsRun.join(", ") || "(none listed)"} (passed: ${report.testsPassed})
Verification notes: ${report.verificationNotes}
Follow-ups: ${report.followUps.join("; ") || "(none)"}
Deferred live items (standing never-block rule — pre-approved exclusions, NOT findings):
${report.deferred.map((d) => `- ${d}`).join("\n") || "(none)"}

## Gate commands (already green — re-run the load-bearing ones yourself)

${verdictCommands.map((c) => `- ${c}`).join("\n") || "(none)"}

## Audit method

1. Read the spec, then check the tree: every claimed file exists with the
   claimed change; every spec item has a corresponding diff or artifact.
2. Re-run at least the most load-bearing gate command yourself (the one whose
   failure would invalidate the slice). Spot-run focused tests for new behavior.
3. Look for what the worker would hide: weakened tests, widened scopes,
   unrelated diffs, missing error paths, hardcoded values the spec forbids.
4. Approve ONLY if the slice spec holds against the tree as it stands, minus
   the deferred items above: never reject for a deferred live value, but DO
   reject a real-looking secret committed to a tracked file.

When done, print EXACTLY one verdict block, no prose outside it beyond a short note:

${reviewBlockSkeleton(slice.id)}
Rules: sliceId must equal "${slice.id}". approved=false requires at least one
entry in findings, each a plain string naming the file/behavior and the spec
line it breaks (e.g. "qa/s1/report.md — file missing; spec requires restore
evidence"). findings must be string[] — never objects.
Set severity on every verdict: "minor" when the slice is RIGHT but needs
polish a small fix can land without redesign (lint, naming, a missing edge
test, docs, slightly wide scope) — a minor rejection earns one bounded fix
session plus re-review, no retry spent. "major" when the slice is WRONG
(behavior, missing functionality, weakened tests, unrelated diffs, secrets in
tracked files) — a major rejection spends retry budget like any failure.
When in doubt, major. Approved verdicts use "major" (field ignored).
If you cannot complete the audit, print the block with approved=false and say
so in notes.
`;
}

/**
 * Minor-fix session prompt: the reviewer approved the shape but listed
 * polish findings. A fresh worker fixes ONLY those findings in the slice
 * worktree, re-runs the failing gate itself, and reports through the
 * standard completion contract (done=true = re-verify me). Same rails as
 * the debugger: one shot, never recursive, never consumes a retry itself.
 */
export function buildReviewFixPrompt(slice: Slice, findings: string[], attempt: number): string {
  return `# Fix review findings: ${slice.id} — ${slice.title}

An independent reviewer audited this slice against the merged tree and found
it CORRECT in shape but needing polish. Fix ONLY the findings below — no
redesign, no scope changes, no unrelated edits. The slice worktree is your
cwd; the slice branch already holds the merged work.

## Findings to fix (all of them, nothing else)

${findings.map((f) => `- ${f}`).join("\n")}

## Contract

1. Address every finding with the smallest diff that holds.
2. Re-run the slice's gate commands yourself until green (at least the ones
   touching your fix).
3. Print the standard completion report block for slice "${slice.id}" with
   done=true when green (this is attempt ${attempt}, review-fix lane).
   done=false with verificationNotes when a finding cannot be fixed without
   redesign — the orchestrator falls back to the normal retry path.
`;
}
