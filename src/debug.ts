/**
 * Failure triage for the orchestrator loop.
 *
 * Two bounded tools, both deterministic (no model calls here):
 *
 * 1. `classifyEnvFailure()` — recognizes infrastructure failures in verifier
 *    output (port in use, database unreachable, missing DB/role, disk full).
 *    Those are never the worker's fault: the loop marks the slice
 *    `blocked-env` WITHOUT consuming a retry, so a dead Postgres or a
 *    squatted port can't burn the retry budget or terminal-fail good code.
 *
 * 2. `buildDebugPrompt()` — compiles the one-shot debugger session prompt:
 *    a fresh worker that diagnoses a genuine (non-env) failure in the
 *    worktree and fixes only that, then re-prints the standard completion
 *    report contract so the loop can re-verify through the same gate. When
 *    the failure is harness-caused (proxy 502, stale gate env), the debugger
 *    may also emit a <<<OMPO_HARNESS_FIX>>> block (see `validateHarnessFix`)
 *    that the loop applies before re-verifying.
 */

import { reportBlockSkeleton, type HarnessFix } from "./report.ts";
import type { Slice } from "./types.ts";

/** Default debugger session budget (10m) — override via debugTimeoutSec. */
export const DEFAULT_DEBUG_TIMEOUT_MS = 10 * 60 * 1000;

/** Max unified-diff lines a harness fix may carry (HARP-1 rail). */
export const MAX_HARNESS_DIFF_LINES = 40;

/**
 * Rail validation for a debugger-emitted harness fix (HARP-1). Returns [] when
 * the fix is acceptable, else every violation (collected, not short-circuited).
 * `sliceFiles` is the slice's declared in-scope allowlist (harness files must
 * be OUT of it) and `allFilesAtHead` the repo-relative paths tracked at the
 * base checkout's HEAD. Pure — unit-tested.
 */
export function validateHarnessFix(
  hf: HarnessFix,
  sliceFiles: string[],
  allFilesAtHead: Set<string>,
): string[] {
  const violations: string[] = [];
  if (typeof hf !== "object" || hf === null || Array.isArray(hf)) {
    return ["harness fix must be a JSON object"];
  }
  if (typeof hf.sliceId !== "string" || hf.sliceId.trim() === "") {
    violations.push("sliceId required");
  }
  if (!Array.isArray(hf.filesPatched) || hf.filesPatched.length === 0) {
    violations.push("filesPatched required");
  } else {
    for (const f of hf.filesPatched) {
      if (typeof f !== "string" || f.trim() === "") {
        violations.push("filesPatched entries must be repo-relative paths");
        continue;
      }
      if (sliceFiles.includes(f)) violations.push(`cannot patch slice-owned files: ${f}`);
      if (!allFilesAtHead.has(f)) violations.push(`file not at HEAD: ${f}`);
    }
  }
  if (typeof hf.diff !== "string" || hf.diff.trim() === "") {
    violations.push("diff required");
  } else {
    const lineCount = hf.diff.endsWith("\n")
      ? hf.diff.split("\n").length - 1
      : hf.diff.split("\n").length;
    if (lineCount > MAX_HARNESS_DIFF_LINES) {
      violations.push(`diff exceeds ${MAX_HARNESS_DIFF_LINES} lines`);
    }
  }
  if (typeof hf.summary !== "string" || hf.summary.trim() === "") {
    violations.push("summary required");
  }
  return violations;
}

export interface EnvBlock {
  /** Short cause, persisted on the block event (e.g. "port 3000 in use"). */
  reason: string;
  /** Operator-facing fix hint logged alongside the block. */
  fix: string;
}

interface EnvPattern {
  match: RegExp;
  reason: (m: RegExpMatchArray) => string;
  fix: string;
}

const ENV_PATTERNS: EnvPattern[] = [
  // Greedy to the LAST :digits (IPv4/IPv6 tails like 0.0.0.0:3000, [::]:3000).
  {
    match: /EADDRINUSE[^\n]*:(\d+)/i,
    reason: (m) => `port ${m[1]} already in use`,
    fix: "free the port (e.g. stop the holder) or move the gate's server port, then `ompo resume`",
  },
  {
    match: /address already in use[^\n]*:(\d+)/i,
    reason: (m) => `port ${m[1]} already in use`,
    fix: "free the port (e.g. stop the holder) or move the gate's server port, then `ompo resume`",
  },
  {
    match: /EADDRINUSE|address already in use/i,
    reason: () => "port already in use",
    fix: "free the port (e.g. stop the holder) or move the gate's server port, then `ompo resume`",
  },
  {
    match: /can't reach database server|ECONNREFUSED|connection refused|connect ETIMEDOUT|connection timed out/i,
    reason: () => "database unreachable",
    fix: "start the database / check DATABASE_URL, then `ompo resume`",
  },
  {
    match: /database "([^"]+)" does not exist/i,
    reason: (m) => `database "${m[1]}" missing`,
    fix: "create the database + migrate/seed, then `ompo resume`",
  },
  {
    match: /role "([^"]+)" does not exist/i,
    reason: (m) => `database role "${m[1]}" missing`,
    fix: "create the database role, then `ompo resume`",
  },
  {
    match: /ENOTFOUND|getaddrinfo ENOTFOUND|no such host/i,
    reason: () => "host unresolvable",
    fix: "check network/DNS for the gate's host, then `ompo resume`",
  },
  {
    match: /no space left on device|ENOSPC/i,
    reason: () => "disk full",
    fix: "free disk space, then `ompo resume`",
  },
  {
    match: /\b([A-Z][A-Z0-9_]{2,})\s+must be set\b/,
    reason: (m) => `missing env var "${m[1]}"`,
    fix: "export the required env var/secret (see the verifier output for its name), then `ompo resume`",
  },
  {
    match: /missing[^\n]*\benv(ironment)?\s+var(iable)?s?\b[^\n]*|\benv(ironment)?\s+var(iable)?s?\b[^\n]*(missing|not set|not defined|undefined|required|must be set)/i,
    reason: (m) => {
      const v = m[0].match(/[A-Z][A-Z0-9_]{2,}/);
      return v ? `missing env var "${v[0]}"` : "required env var missing";
    },
    fix: "export the required env var/secret (see the verifier output for its name), then `ompo resume`",
  },
  {
    match: /parameter null or not set|unbound variable/i,
    reason: () => "required env var missing (shell strict mode)",
    fix: "export the required variable (or relax 'set -u' in the gate), then `ompo resume`",
  },
];

/**
 * Scan verifier outputs for infrastructure failure signatures.
 * Returns the first match, or null when the failure looks like a
 * genuine code/test problem the worker (or debugger) should own.
 * Pure — unit-tested.
 */
export function classifyEnvFailure(outputs: string[]): EnvBlock | null {
  for (const text of outputs) {
    if (!text) continue;
    for (const p of ENV_PATTERNS) {
      const m = text.match(p.match);
      if (m) return { reason: p.reason(m), fix: p.fix };
    }
  }
  return null;
}

export interface DebugBrief {
  /** Failing gate commands (in order). */
  verifyCommands: string[];
  /** Tail of the first failing step's output (already clipped). */
  failingTail: string;
  /** Slice worktree the debugger must work in. */
  worktree: string;
  /** Attempt number this debug belongs to (artifacts + prompt). */
  attempt: number;
}

/**
 * Compile the debugger session prompt: repo-local diagnosis only. The
 * debugger fixes the failure in the worktree and closes with the standard
 * completion-report block (done=true iff it re-ran the failing command green
 * itself). A rare harness bug may additionally carry a <<<OMPO_HARNESS_FIX>>>
 * block (HARP-1 rule 5b) which the loop validates + applies. The loop
 * re-verifies; the report is advisory.
 */
export function buildDebugPrompt(slice: Slice, brief: DebugBrief): string {
  const tail = brief.failingTail.length > 3000
    ? brief.failingTail.slice(-3000)
    : brief.failingTail;
  return [
    `# Debug session: ${slice.id} — ${slice.title} (attempt ${brief.attempt})`,
    ``,
    `You are debugging ONE failed verification of a slice someone else implemented.`,
    `Work in: ${brief.worktree}`,
    `Do not redesign, do not expand scope, do not touch unrelated files.`,
    ``,
    `## The failing gate`,
    ...brief.verifyCommands.map((c) => `$ ${c}`),
    ``,
    `## Failing output tail`,
    tail || "(no output captured)",
    ``,
    `## Slice scope (for context only — the implementation exists, fix the failure)`,
    `${slice.body || "(no body)"}`,
    slice.files.length > 0 ? `\nFiles in scope: ${slice.files.join(", ")}` : ``,
    ``,
    `## Contract (STRICT)`,
    `1. Reproduce: run the failing command yourself in the worktree.`,
    `2. Fix ONLY the root cause. If the failure is environmental (port taken,`,
    `   database down, missing service, missing env var/secret) STOP and say so — do not hack around it.`,
    `3. Re-run the failing command until it passes.`,
    `4. When finished, print EXACTLY one report block:`,
    ``,
    `${reportBlockSkeleton(slice.id)}`,
    ``,
    `Rules: done=true only when the failing command now passes by your own run.`,
    `done=false with the cause in verificationNotes when it is environmental`,
    `or unfixable within scope. filesChanged lists repo-relative paths you touched.`,
    ``,
    `Rule 5b — HARNESS BUGS ONLY (rare). If the failure is environmental on`,
    `the surface but is caused by a BUG IN THE HARNESS / verify plumbing itself`,
    `(e.g. a Playwright webServer polling through an un-bypassed proxy → 502; a`,
    `stale DATABASE_URL in the gate; a verify command with a wrong port — the`,
    `*tooling* between you and the slice is broken, not your code), you may emit`,
    `a harness fix: keep done:true, AND append a <<<OMPO_HARNESS_FIX { ... } >>>`,
    `block with filesPatched (repo files only, NOT this slice's declared Files`,
    `list), diff (unified, ≤ ${MAX_HARNESS_DIFF_LINES} lines, base-clean only), and summary.`,
    `The patch is applied to the worktree + base on your behalf before the gate`,
    `re-runs. If the failure is truly environmental (dead DB, squatted port, missing secret you`,
    `can't fix in code), STOP and report done=false with verificationNotes — do`,
    `not paper over it.`,
  ].join("\n");
}
