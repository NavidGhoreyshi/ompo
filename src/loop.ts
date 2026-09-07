/**
 * Orchestrator loop (plan §8, M5):
 * load → select → spawn → verify → merge → persist → repeat, with retries + abort.
 * Each step is a separate store write (crash-safe at every boundary).
 *
 * Parallelism (`jobs > 1`): up to N slice pipelines run concurrently. Each
 * pipeline works on its own worktree branch; verify + merge serialize on one
 * commit mutex (verify is the shared-resource lock, merge inside the same
 * section orders integration). After the merge, an independent review
 * session audits the merged tree OUTSIDE the mutex, then `done` lands on
 * approval. A slice is `done` only after merge + review approval, so
 * dependents always branch off audited state.
 *
 * Exit codes: 0 all done · 1 failures remain · 2 aborted · 3 resume-conflict.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoadmapConfig, type RoadmapConfig } from "./config.ts";
import { depSatisfied, readySlices } from "./select.ts";
import { buildWorkerSpec } from "./spec.ts";
import { sliceDir, storeApi, loadRun, RUNS_DIR } from "./store.ts";
import type { CompletionReport, RoadmapDoc, Slice, Verdict } from "./types.ts";
import { extractHarnessFix, extractReportFromOutput, validateCompletionReport, type HarnessFix } from "./report.ts";
import { buildDebugPrompt, classifyEnvFailure, DEFAULT_DEBUG_TIMEOUT_MS, validateHarnessFix } from "./debug.ts";
import { buildReviewPrompt, extractReviewFromOutput, validateReviewVerdict } from "./review.ts";
import { runVerifiers } from "./verify.ts";
import { resolveWorkerModel, runOmpWorker, type WorkerRunner } from "./worker.ts";
import { createMutex, type Mutex } from "./mutex.ts";
import { worktreeOpsFor, type WorktreeOps } from "./worktree.ts";
import { extractMissingVar, isDeploySlice, loadPlaceholders, placeholderFor, placeholdersDocRef, recordPlaceholder } from "./placeholders.ts";

export interface LoopOptions {
  projectDir: string;
  runId: string;
  runner?: WorkerRunner;
  /** Run only this slice id (must be ready). */
  onlySlice?: string;
  maxRetriesOverride?: number;
  signal?: AbortSignal;
  onEvent?: (msg: string) => void;
  /** Max concurrent slice pipelines (default 1 = sequential). */
  jobs?: number;
  /** Worktree isolation seam (default: git when available, else in-place). */
  worktrees?: WorktreeOps;
  /** Global worker budget override (`--timeout-sec`). */
  timeoutMsOverride?: number;
  /** Heartbeat interval for in-flight slices (default 60000ms). */
  heartbeatMs?: number;
  /** Independent reviewer runner (default: `runner` — a fresh session audits each merge). */
  reviewer?: WorkerRunner;
  /** Disable the post-merge review gate (`--no-review`). */
  noReview?: boolean;
  /** Reviewer model override (default: roadmap.yml reviewModel → workerModel). */
  reviewModel?: string;
  /** Reviewer budget override (default: the slice's own worker budget chain). */
  reviewTimeoutMs?: number;
  /** Disable the debugger session on failure (`--no-debug`). */
  noDebug?: boolean;
  /** Debugger budget override (default 10m). */
  debugTimeoutMs?: number;
  /** Disable dev-only placeholder injection for missing env creds (`--no-placeholders`). */
  noPlaceholders?: boolean;
}

export interface LoopResult {
  exitCode: 0 | 1 | 2 | 3;
  done: number;
  failed: number;
  skipped: number;
  pending: number;
  blockedEnv: number;
}

interface AttemptCtx {
  projectDir: string;
  runId: string;
  runner: WorkerRunner;
  cfg: RoadmapConfig;
  commit: Mutex;
  wt: WorktreeOps;
  reviewer: WorkerRunner;
  noReview: boolean;
  reviewModel?: string;
  reviewTimeoutMs?: number;
  noDebug: boolean;
  debugTimeoutMs?: number;
  noPlaceholders: boolean;
  maxRetriesOverride?: number;
  timeoutMsOverride?: number;
  signal?: AbortSignal;
  onEvent?: (msg: string) => void;
  heartbeatMs: number;
  /** Shared live-progress state per in-flight slice (for heartbeat detail). */
  trackers: Map<string, ProgressTracker>;
}

function log(opts: { onEvent?: (msg: string) => void }, msg: string): void {
  (opts.onEvent ?? ((m) => console.log(m)))(msg);
}

/** Live-progress counters for one in-flight attempt (heartbeat + summaries). */
export interface ProgressTracker {
  turns: number;
  tools: number;
  lines: number;
  lastLine: string;
  lastAt: number;
}

export function newProgressTracker(): ProgressTracker {
  return { turns: 0, tools: 0, lines: 0, lastLine: "", lastAt: Date.now() };
}

function noteProgress(t: ProgressTracker, line: string): void {
  t.lines += 1;
  t.lastLine = line;
  t.lastAt = Date.now();
  if (line.startsWith("turn ")) t.turns += 1;
  else if (line.startsWith("tool ")) t.tools += 1;
}

/** Build an onProgress sink that logs prefixed lines and feeds the heartbeat. */
function progressFn(ctx: AttemptCtx, sliceId: string, tag?: string): (line: string) => void {
  const prefix = tag ? `  [${sliceId} ${tag}]` : `  [${sliceId}]`;
  return (line) => {
    let t = ctx.trackers.get(sliceId);
    if (!t) {
      t = newProgressTracker();
      ctx.trackers.set(sliceId, t);
    }
    noteProgress(t, line);
    log(ctx, `${prefix} ${line}`);
  };
}

function formatTimeout(ms: number | undefined): string {
  if (ms === undefined) return "default";
  const m = Math.round(ms / 60000);
  return m >= 1 ? `${m}m` : `${Math.round(ms / 1000)}s`;
}

function depSummaries(projectDir: string, runId: string, slice: Slice): Map<string, string> {
  const out = new Map<string, string>();
  for (const dep of slice.deps) {
    const reportPath = join(sliceDir(projectDir, runId, dep), "report.json");
    try {
      if (existsSync(reportPath)) {
        const r = JSON.parse(readFileSync(reportPath, "utf8")) as CompletionReport;
        if (r.summary) out.set(dep, r.summary);
      }
    } catch {
      /* missing/unreadable → spec notes "(no summary recorded)" */
    }
  }
  return out;
}

function maxRetriesFor(slice: Slice, opts: { maxRetriesOverride?: number; cfg?: { maxRetries?: number } }): number {
  // Precedence: CLI flag > explicit `Retries:` trailer > yml default > parser default.
  if (opts.maxRetriesOverride !== undefined) return opts.maxRetriesOverride;
  if (slice.maxRetriesExplicit) return slice.maxRetries;
  return opts.cfg?.maxRetries ?? slice.maxRetries;
}

function summarize5(
  slice: Slice,
  outcome: string,
  report?: CompletionReport,
  verdictPass?: boolean,
): string {
  const lines = [
    `— slice ${slice.id}: ${outcome}`,
    `  title: ${slice.title}`,
    `  attempt: ${slice.attempts}`,
  ];
  if (report) lines.push(`  summary: ${report.summary.slice(0, 200)}`);
  if (verdictPass !== undefined) lines.push(`  verify: ${verdictPass ? "pass" : "FAIL"}`);
  return lines.join("\n");
}

/** Map a failure ref (file path) to a short machine-readable class. */
function classifyFailure(ref: string): string {
  if (ref.includes("worktree-")) return "worktree_failed";
  if (ref.includes("report-") && ref.endsWith(".invalid.json")) return "report_missing";
  if (ref.includes("worker-")) return "worker_failed";
  if (ref.includes("review-")) return "review_rejected";
  if (ref.includes("merge-")) return "merge_conflict";
  if (ref.includes("unexpected-")) return "unexpected";
  return "failed";
}

/**
 * Retry-or-terminal shared by worker/spawn/report failures. The terminal
 * events carry a short `reason` class (+ process exit/timing when known) so
 * run logs explain a failure in one line instead of pointing at a file.
 */
function failAttempt(
  ctx: AttemptCtx,
  sliceId: string,
  claimed: Slice,
  ref: string,
  meta?: { cause?: string; exit?: number | null; timedOut?: boolean; durationMs?: number },
): void {
  const maxRetries = maxRetriesFor(claimed, ctx);
  const attempt = claimed.attempts;
  const cause = meta?.cause ?? classifyFailure(ref);
  const extra = {
    exit: meta?.exit ?? null,
    timedOut: meta?.timedOut ?? false,
    durationMs: meta?.durationMs,
  };
  if (attempt <= maxRetries) {
    storeApi.retrySlice(ctx.projectDir, ctx.runId, sliceId);
    log(ctx, `  retrying (${attempt}/${maxRetries} retries used)`);
  } else {
    storeApi.verifyFailed(ctx.projectDir, ctx.runId, sliceId, ref, cause, extra);
    storeApi.terminalFail(ctx.projectDir, ctx.runId, sliceId, cause, extra);
    log(ctx, `  terminal failure (retries exhausted): ${cause}`);
  }
}
/** Repo-relative tracked paths at the base checkout's HEAD (harness-fix rail). */
function headFileSet(projectDir: string): Set<string> {
  const r = spawnSync("git", ["-C", projectDir, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" });
  return new Set((r.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
}

/**
 * Apply a rail-validated harness fix (HARP-1). The diff goes into the slice
 * worktree — the gate's cwd — via `git apply --3way`, then the patched paths
 * are staged. Deliberately NOT applied to the base checkout here: a base-side
 * edit would be overwritten-and-refused by the worktree branch's own merge
 * minutes later (git merge aborts on local changes to files it updates), and
 * the sanctioned commit path is exactly that merge — commitWork includes
 * harness files, so the fix lands on base HEAD when the slice merges. Throws
 * on any failure (base dirt on the patched paths, apply/add errors).
 */
function applyHarnessFix(projectDir: string, wtPath: string, hf: HarnessFix): void {
  // Rail: never clobber real uncommitted work in the base checkout on the
  // patched paths (a later merge of these same files would refuse anyway).
  const status = spawnSync(
    "git",
    ["-C", projectDir, "status", "--porcelain", "--", ...hf.filesPatched],
    { encoding: "utf8" },
  );
  if (status.status !== 0) {
    throw new Error(`cannot check base checkout status (git exit ${status.status})`);
  }
  const dirty = (status.stdout ?? "").trim();
  if (dirty) {
    throw new Error(`base checkout has uncommitted changes to patched files — refusing: ${dirty.split("\n").join("; ")}`);
  }
  // The debugger verifies its fix by editing the file in the worktree, so the
  // patched paths may already carry that exact change. Reset them to HEAD so
  // the emitted diff applies cleanly (filesPatched are never slice-owned, so
  // this discards only the debugger's own harness edit, never slice work).
  const reset = spawnSync("git", ["-C", wtPath, "checkout", "--", ...hf.filesPatched], { encoding: "utf8" });
  if (reset.status !== 0) {
    throw new Error(`git checkout failed in worktree: ${`${reset.stderr ?? ""}${reset.stdout ?? ""}`.trim().slice(-2000)}`);
  }
  const applied = spawnSync("git", ["-C", wtPath, "apply", "--3way", "--"], {
    input: hf.diff,
    encoding: "utf8",
  });
  if (applied.status !== 0) {
    throw new Error(`git apply failed in worktree: ${`${applied.stderr ?? ""}${applied.stdout ?? ""}`.trim().slice(-2000)}`);
  }
  const add = spawnSync("git", ["-C", wtPath, "add", "-A", "--", ...hf.filesPatched], { encoding: "utf8" });
  if (add.status !== 0) {
    throw new Error(`git add failed in worktree: ${`${add.stderr ?? ""}${add.stdout ?? ""}`.trim().slice(-2000)}`);
  }
}

/** Best-effort: commit in-flight work to the slice branch so retries/resume keep it. */
function preserveIncompleteWork(ctx: AttemptCtx, sliceId: string, attempt: number, reason: string): void {
  try {
    const c = ctx.wt.commitWork(ctx.projectDir, ctx.runId, sliceId, attempt, `incomplete: ${reason}`);
    log(ctx, `  preserved incomplete work: ${c.detail}`);
  } catch (err) {
    log(ctx, `  work-preservation warning: ${err instanceof Error ? err.message : String(err)}`);
  }
}
/**
 * Independent review: fresh reviewer session audits the merged slice.
 * Returns true on approval. Rejection/invalid/timeout flow through the
 * standard retry-or-terminal path with findings saved for the next attempt.
 */
async function runReview(
  ctx: AttemptCtx,
  sliceId: string,
  attempt: number,
  claimed: Slice,
  report: CompletionReport,
  verifyCommands: string[],
  env?: Record<string, string>,
): Promise<boolean> {
  const { projectDir, runId } = ctx;
  const dir = sliceDir(projectDir, runId, sliceId);
  const reviewModel = ctx.reviewModel ?? ctx.cfg.reviewModel ?? ctx.cfg.workerModel;
  // Review budgets like the worker that produced the slice: same chain, with
  // an explicit review override on top. The audit re-runs gate commands, so it
  // must not be capped tighter than the work it checks.
  const reviewBudgetMs = ctx.reviewTimeoutMs ?? ctx.timeoutMsOverride ?? claimed.timeoutMs
    ?? (ctx.cfg.workerTimeoutSec ? ctx.cfg.workerTimeoutSec * 1000 : undefined);
  log(ctx, `◈ review ${sliceId} — independent audit (attempt ${attempt})`);
  log(ctx, `  model: ${reviewModel ?? "(default)"} budget: ${formatTimeout(reviewBudgetMs)}`);

  if (ctx.signal?.aborted) {
    storeApi.abortSlice(projectDir, runId, sliceId);
    return false;
  }

  const prompt = buildReviewPrompt(claimed, report, verifyCommands);
  writeFileSync(join(dir, `review-prompt-${attempt}.md`), prompt, "utf8");
  const onProgress = progressFn(ctx, sliceId, "review");
  let reviewOut = "";
  let reviewStdout = "";
  try {
    const res = await ctx.reviewer(
      { prompt, sliceId, attempt, label: `${sliceId} review` },
      { projectDir, workerModel: reviewModel, timeoutMs: reviewBudgetMs, signal: ctx.signal, sessionDir: dir, onProgress, env },
    );
    reviewStdout = res.stdout;
    reviewOut = `exit=${res.exit} timedOut=${res.timedOut} durationMs=${res.durationMs}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`;
    if (res.eventsJsonl) {
      try {
        writeFileSync(join(dir, `review-${attempt}.events.jsonl`), res.eventsJsonl, "utf8");
      } catch {
        /* forensics are best-effort */
      }
    }
    if (res.timedOut) throw new Error(`reviewer timed out`);
    if (res.exit !== 0) {
      const maybe = extractReviewFromOutput(res.stdout);
      if (maybe === undefined) throw new Error(`reviewer exited ${res.exit} with no verdict`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeFileSync(join(dir, `review-${attempt}.log`), reviewOut + `\nREVIEW ERROR: ${msg}\n`, "utf8");
    if (ctx.signal?.aborted) {
      storeApi.abortSlice(projectDir, runId, sliceId);
      log(ctx, summarize5(claimed, `aborted during review (no retry consumed)`));
      return false;
    }
    log(ctx, summarize5(claimed, `review failure: ${msg}`));
    failAttempt(ctx, sliceId, claimed, join("slices", sliceId, `review-${attempt}.log`));
    return false;
  }
  const extracted = extractReviewFromOutput(reviewStdout);
  // Artifact the failure refs: review.json once a verdict parsed, else the
  // invalid-output record.
  let verdictRef = join("slices", sliceId, `review-${attempt}.invalid.json`);
  try {
    if (extracted === undefined) throw new Error("no <<<OMPO_REVIEW>>> block found in reviewer output");
    const verdict = validateReviewVerdict(extracted, sliceId);
    writeFileSync(join(dir, "review.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
    verdictRef = join("slices", sliceId, "review.json");
    if (!verdict.approved) throw new Error(`reviewer rejected: ${verdict.findings.join("; ").slice(0, 300)}`);
    log(ctx, summarize5(claimed, `review approved — ${verdict.notes.slice(0, 200)}`, report, true));
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeFileSync(
      join(dir, `review-${attempt}.invalid.json`),
      JSON.stringify({ error: msg, raw: extracted === undefined ? null : extracted }, null, 2),
      "utf8",
    );
    log(ctx, summarize5(claimed, `review rejected: ${msg}`));
    // Findings feed the next attempt's prompt (see reviewNotes at spec build).
    try {
      const notes = extracted !== undefined
        ? (extracted as { findings?: string[]; notes?: string })
        : null;
      const lines = [
        ...(notes?.findings ?? []).map((f) => `- ${f}`),
        notes?.notes ? `\nReviewer notes: ${notes.notes}` : "",
      ].filter(Boolean).join("\n");
      if (lines) writeFileSync(join(dir, "review-notes.md"), lines + "\n", "utf8");
    } catch {
      /* notes are advisory; the retry proceeds regardless */
    }
    failAttempt(ctx, sliceId, claimed, verdictRef);
    return false;
  }
}

/**
 * Debugger session: one bounded fresh worker that diagnoses a genuine
 * (non-environmental) failure in the slice worktree and fixes only that.
 * Reuses the standard completion-report contract: done=true (plus a self-run
 * green gate) means "re-verify me", anything else falls through to the
 * normal retry-or-terminal path. A <<<OMPO_HARNESS_FIX>>> block (HARP-1) is
 * rail-validated and applied to the worktree here — the slice's own merge
 * lands it on the base checkout — before the same re-verify. Not recursive —
 * one debug per attempt, never consumes a retry itself.
 * Returns true when the gate deserves a re-run.
 */
async function runDebugger(
  ctx: AttemptCtx,
  sliceId: string,
  attempt: number,
  claimed: Slice,
  verifyCommands: string[],
  verdict: Verdict,
  wtPath: string,
  env?: Record<string, string>,
): Promise<boolean> {
  const { projectDir, runId } = ctx;
  const dir = sliceDir(projectDir, runId, sliceId);
  const failedStep = verdict.steps.find((s) => s.exit !== 0);
  const tail = (failedStep?.outputTail ?? "").trim().slice(-3000);
  const prompt = buildDebugPrompt(claimed, { verifyCommands, failingTail: tail, worktree: wtPath, attempt });
  writeFileSync(join(dir, `debug-prompt-${attempt}.md`), prompt, "utf8");
  const workerModel = resolveWorkerModel(claimed.workerAgent, ctx.cfg);
  const debugBudgetMs = ctx.debugTimeoutMs ?? DEFAULT_DEBUG_TIMEOUT_MS;
  log(ctx, `  debug ${sliceId} — diagnosis session (attempt ${attempt}, budget ${formatTimeout(debugBudgetMs)})`);

  if (ctx.signal?.aborted) {
    storeApi.abortSlice(projectDir, runId, sliceId);
    return false;
  }

  const onProgress = progressFn(ctx, sliceId, "debug");
  let debugOut = "";
  let debugStdout = "";
  try {
    const res = await ctx.runner(
      { prompt, sliceId, attempt, label: `${sliceId} debug` },
      { projectDir: wtPath, workerModel, timeoutMs: debugBudgetMs, signal: ctx.signal, sessionDir: dir, onProgress, env },
    );
    debugStdout = res.stdout;
    debugOut = `exit=${res.exit} timedOut=${res.timedOut} durationMs=${res.durationMs}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`;
    writeFileSync(join(dir, `debug-${attempt}.log`), debugOut, "utf8");
    if (res.eventsJsonl) {
      try {
        writeFileSync(join(dir, `debug-${attempt}.events.jsonl`), res.eventsJsonl, "utf8");
      } catch {
        /* forensics are best-effort */
      }
    }
    if (res.timedOut) {
      preserveIncompleteWork(ctx, sliceId, attempt, "debug timeout");
      log(ctx, summarize5(claimed, `debugger timed out (no retry consumed)`));
      return false;
    }
    if (res.exit !== 0) {
      const maybe = extractReportFromOutput(res.stdout);
      if (maybe === undefined) throw new Error(`debugger exited ${res.exit} with no report`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeFileSync(join(dir, `debug-${attempt}.log`), debugOut + `\nDEBUG ERROR: ${msg}\n`, "utf8");
    if (ctx.signal?.aborted) {
      storeApi.abortSlice(projectDir, runId, sliceId);
      log(ctx, summarize5(claimed, `aborted during debug (no retry consumed)`));
      return false;
    }
    log(ctx, summarize5(claimed, `debugger failure: ${msg} (no retry consumed)`));
    return false;
  }

  const extracted = extractReportFromOutput(debugStdout);
  try {
    if (extracted === undefined) throw new Error("no <<<OMPO_REPORT>>> block in debugger output");
    const dreport = validateCompletionReport(extracted, sliceId);
    if (!dreport.done) throw new Error(`debugger gave up: ${dreport.verificationNotes.slice(0, 300)}`);
    // Harness-fix lane (HARP-1): when the failing gate is broken by the
    // harness/verify plumbing itself (proxy 502, stale DATABASE_URL in a
    // Verify command), the debugger keeps done:true AND appends a
    // <<<OMPO_HARNESS_FIX>>> block. Validate every rail, apply, and let the
    // caller re-run the gate as for any debugger fix. One shot: any rail or
    // apply failure rejects the block and returns false (retry-or-terminal).
    const harness = extractHarnessFix(debugStdout);
    if (harness) {
      writeFileSync(join(dir, `debug-${attempt}.harness-fix.json`), JSON.stringify(harness, null, 2) + "\n", "utf8");
      const violations = validateHarnessFix(harness, claimed.files, headFileSet(projectDir));
      if (violations.length > 0) {
        writeFileSync(
          join(dir, `debug-${attempt}.harness-fix-rejected.json`),
          JSON.stringify({ harness, violations }, null, 2) + "\n",
          "utf8",
        );
        log(ctx, summarize5(claimed, `debugger: harness-fix rejected — ${violations.join("; ")}`, dreport, undefined));
        return false;
      }
      try {
        applyHarnessFix(projectDir, wtPath, harness);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeFileSync(
          join(dir, `debug-${attempt}.harness-fix-rejected.json`),
          JSON.stringify({ harness, violations: [msg] }, null, 2) + "\n",
          "utf8",
        );
        log(ctx, summarize5(claimed, `debugger: harness-fix rejected — ${msg}`, dreport, undefined));
        return false;
      }
      writeFileSync(join(dir, `debug-${attempt}.patch-applied`), `${harness.diff}\n`, "utf8");
      log(ctx, `  harness fix applied: ${harness.filesPatched.join(", ")}`);
    }
    log(ctx, summarize5(claimed, `debugger fixed: ${dreport.summary.slice(0, 200)}`, dreport, undefined));
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(ctx, summarize5(claimed, `debug inconclusive: ${msg} (falling back to retry budget)`));
    return false;
  }
}

/**
 * Placeholder recovery for missing named credentials/URLs (default on).
 * Up to 5 rounds: extract the unset var, inject a dev-only placeholder,
 * re-run the gate. Returns passed (gate green), failed (the failure is
 * genuine now — the debugger owns it), or park (deploy slice / unnamed
 * var / still missing — the caller records blocked-env).
 */
type PlaceholderRecovery =
  | { kind: "passed"; verdict: Verdict; env: Record<string, string> }
  | { kind: "failed"; verdict: Verdict; env: Record<string, string> }
  | { kind: "park"; verdict: Verdict; reason: string; fix: string };

async function recoverWithPlaceholders(
  ctx: AttemptCtx,
  sliceId: string,
  attempt: number,
  claimed: Slice,
  verdict: Verdict,
  runGate: (tag: string, env?: Record<string, string>) => Promise<Verdict>,
): Promise<PlaceholderRecovery> {
  const { projectDir, runId } = ctx;
  const docRef = placeholdersDocRef(runId);
  // Scoped to this attempt's gate re-runs: never touches process.env, so
  // concurrent pipelines cannot see each other's placeholders.
  const extraEnv: Record<string, string> = {};
  let cur = verdict;
  for (let round = 0; round < 5; round++) {
    const tails = cur.steps.map((s) => s.outputTail);
    const block = classifyEnvFailure(tails);
    if (!block) return { kind: "failed", verdict: cur, env: { ...extraEnv } };
    const name = extractMissingVar(block.reason, tails);
    if (!name) return { kind: "park", verdict: cur, reason: block.reason, fix: block.fix };
    if (isDeploySlice(sliceId, claimed.title)) {
      return {
        kind: "park",
        verdict: cur,
        reason: block.reason,
        fix: `deploy gate needs the real ${name} — swap the placeholders in ${docRef} first, then \`ompo resume\``,
      };
    }
    // Already set (operator value or earlier injection) yet still named:
    // the value itself is rejected — genuine failure for the debugger.
    // Only truly-unset vars are invented, so real secrets are never recorded.
    if (process.env[name] || extraEnv[name]) return { kind: "failed", verdict: cur, env: { ...extraEnv } };
    const value = placeholderFor(name);
    extraEnv[name] = value;
    recordPlaceholder(projectDir, runId, {
      name,
      value,
      firstSeenSlice: sliceId,
      firstSeenAttempt: attempt,
      at: new Date().toISOString(),
    });
    log(ctx, `  placeholder: ${name} unset — injected dev-only value, noted in ${docRef} (no retry consumed)`);
    cur = await runGate("verify", { ...extraEnv });
    if (cur.pass) {
      log(ctx, `  gate green with placeholder(s): ${Object.keys(extraEnv).join(", ")}`);
      return { kind: "passed", verdict: cur, env: { ...extraEnv } };
    }
  }
  const tails = cur.steps.map((s) => s.outputTail);
  const block = classifyEnvFailure(tails);
  return {
    kind: "park",
    verdict: cur,
    reason: block ? block.reason : "repeated missing credentials",
    fix: block ? block.fix : `set the missing values (see ${docRef}), then \`ompo resume\``,
  };
}

/**
 * End-of-run swap report: var names (never values — those live in the doc)
 * plus the deploy-gate call to action when only deployment slices remain.
 */
function reportPlaceholders(opts: { projectDir: string; runId: string; onEvent?: (msg: string) => void }): void {
  const all = loadPlaceholders(opts.projectDir, opts.runId);
  const names = Object.keys(all);
  if (names.length === 0) return;
  const ref = placeholdersDocRef(opts.runId);
  log(opts, `placeholders: ${names.length} dev-only value(s) — ${names.join(", ")} (see ${ref})`);
  const doc = loadRun(opts.projectDir, opts.runId).doc;
  const remaining = doc.slices.filter((s) => !["done", "failed", "skipped"].includes(s.status));
  if (remaining.length > 0 && remaining.every((s) => isDeploySlice(s.id, s.title))) {
    log(opts, `only deployment slice(s) left (${remaining.map((s) => s.id).join(", ")}) — swap real values, exercise the UI/UX, then deploy`);
  } else {
    log(opts, `swap real values before the deploy slice / final UI-UX pass`);
  }
}

/**
 * One attempt of one slice: worktree → spec → worker → report →
 * verify → merge → review → done. Total: never rejects; all failures land
 * in the store. The worktree is dropped only after review approval.
 */
async function runAttempt(ctx: AttemptCtx, sliceId: string): Promise<void> {
  const { projectDir, runId } = ctx;
  const dir = sliceDir(projectDir, runId, sliceId);
  mkdirSync(dir, { recursive: true });

  const fresh = () => loadRun(projectDir, runId).doc.slices.find((s) => s.id === sliceId)!;
  const claimed = fresh();
  const attempt = claimed.attempts;
  const maxRetries = maxRetriesFor(claimed, ctx);
  log(ctx, `▸ slice ${sliceId} — ${claimed.title} (attempt ${attempt})`);
  ctx.trackers.set(sliceId, newProgressTracker());

  // 1. Worktree isolation (reused across retries; in-place for non-git).
  let wtPath: string;
  try {
    wtPath = ctx.wt.ensure(projectDir, runId, sliceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeFileSync(join(dir, `worktree-${attempt}.error.txt`), msg, "utf8");
    log(ctx, summarize5(claimed, `worktree failure: ${msg}`));
    failAttempt(ctx, sliceId, claimed, join("slices", sliceId, `worktree-${attempt}.error.txt`));
    return;
  }

  // 2. Compile worker spec (worker cwd = worktree). A prior review
  // rejection (review-notes.md) is handed to the next attempt first.
  let reviewNotes: string | undefined;
  try {
    const notesPath = join(dir, "review-notes.md");
    if (existsSync(notesPath)) reviewNotes = readFileSync(notesPath, "utf8").trim() || undefined;
  } catch {
    /* advisory only */
  }
  const spec = buildWorkerSpec(fresh(), loadRun(projectDir, runId).doc, attempt, {
    depSummaries: depSummaries(projectDir, runId, claimed),
    maxChars: ctx.cfg.specBudget,
    projectDir: wtPath,
    reviewNotes,
  });
  writeFileSync(join(dir, `prompt-${attempt}.md`), spec.prompt, "utf8");

  if (ctx.signal?.aborted) {
    storeApi.abortSlice(projectDir, runId, sliceId);
    return;
  }

  // 3. Spawn worker (clean context: fresh `omp -p` process, spec only).
  // Progress streams live via --mode json events (turns, tool calls,
  // assistant snippets) prefixed with the slice id.
  const workerModel = resolveWorkerModel(claimed.workerAgent, ctx.cfg);
  const workerTimeoutMs = ctx.timeoutMsOverride ?? claimed.timeoutMs
    ?? (ctx.cfg.workerTimeoutSec ? ctx.cfg.workerTimeoutSec * 1000 : undefined);
  log(ctx, `  model: ${workerModel ?? "(default)"} worktree: ${wtPath} budget: ${formatTimeout(workerTimeoutMs)}`);
  const onProgress = progressFn(ctx, sliceId);
  let workerOut = "";
  let workerStdout = "";
  // Hoisted worker result so the worker_finished event (step 5) can carry
  // exit/timing enrichment even though the result was scoped to the try.
  let workerMeta: { exit: number | null; timedOut: boolean; durationMs: number } | undefined;
  try {
    const res = await ctx.runner(
      { prompt: spec.prompt, sliceId, attempt },
      { projectDir: wtPath, workerModel, timeoutMs: workerTimeoutMs, signal: ctx.signal, sessionDir: dir, onProgress },
    );
    workerMeta = { exit: res.exit, timedOut: res.timedOut, durationMs: res.durationMs };
    workerStdout = res.stdout;
    workerOut = `exit=${res.exit} timedOut=${res.timedOut} durationMs=${res.durationMs}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`;
    writeFileSync(join(dir, `worker-${attempt}.log`), workerOut, "utf8");
    if (res.eventsJsonl) {
      try {
        writeFileSync(join(dir, `worker-${attempt}.events.jsonl`), res.eventsJsonl, "utf8");
      } catch {
        /* forensics are best-effort */
      }
    }
    const t = ctx.trackers.get(sliceId);
    log(ctx, `  worker exited in ${Math.round(res.durationMs / 1000)}s${t ? ` (${t.turns} turns, ${t.tools} tools)` : ""}`);
    if (res.timedOut) {
      preserveIncompleteWork(ctx, sliceId, attempt, "timeout");
      throw new Error(`worker timed out`);
    }
    if (res.exit !== 0) {
      // Non-zero exit: still try to extract a report (worker may have
      // printed one before failing); else worker failure.
      const maybe = extractReportFromOutput(res.stdout);
      if (maybe === undefined) throw new Error(`worker exited ${res.exit} with no report`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeFileSync(join(dir, `worker-${attempt}.log`), workerOut + `\nSPAWN ERROR: ${msg}\n`, "utf8");
    if (ctx.signal?.aborted) {
      preserveIncompleteWork(ctx, sliceId, attempt, "abort");
      storeApi.abortSlice(projectDir, runId, sliceId);
      log(ctx, summarize5(claimed, `aborted during worker run (no retry consumed)`));
      return;
    }
    log(ctx, summarize5(claimed, `worker failure: ${msg}`));
    failAttempt(ctx, sliceId, claimed, join("slices", sliceId, `worker-${attempt}.log`), {
      cause: msg.includes("timed out") ? "worker_timeout" : "worker_failed",
      exit: workerMeta?.exit ?? null,
      timedOut: workerMeta?.timedOut,
      durationMs: workerMeta?.durationMs,
    });
    return;
  }

  if (ctx.signal?.aborted) {
    preserveIncompleteWork(ctx, sliceId, attempt, "abort");
    storeApi.abortSlice(projectDir, runId, sliceId);
    return;
  }

  // 4. Extract + validate strict report (raw stdout — the decorated log may
  // contain the same delimiters in worker prose).
  const extracted = extractReportFromOutput(workerStdout);
  let report: CompletionReport;
  try {
    if (extracted === undefined) throw new Error("no <<<OMPO_REPORT>>> block found in worker output");
    report = validateCompletionReport(extracted, sliceId);
    if (!report.done) throw new Error(`worker reported done=false: ${report.verificationNotes.slice(0, 300)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeFileSync(join(dir, `report-${attempt}.invalid.json`), JSON.stringify({ error: msg, raw: extracted === undefined ? null : extracted }, null, 2), "utf8");
    log(ctx, summarize5(claimed, `invalid report: ${msg}`));
    failAttempt(ctx, sliceId, claimed, join("slices", sliceId, `report-${attempt}.invalid.json`));
    return;
  }

  // 5. Persist report → verifying.
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  const tracker = ctx.trackers.get(sliceId);
  storeApi.workerFinished(projectDir, runId, sliceId, join("slices", sliceId, "report.json"), {
    exit: workerMeta?.exit ?? null,
    timedOut: workerMeta?.timedOut ?? false,
    durationMs: workerMeta?.durationMs,
    stats: tracker ? { turns: tracker.turns, tools: tracker.tools } : undefined,
  });

  if (ctx.signal?.aborted) {
    storeApi.abortSlice(projectDir, runId, sliceId);
    return;
  }

  // 6+7. Commit phase (serialized): verify in the worktree, then merge.
  // The mutex is the shared-resource lock (one DB, one :3000, one batch
  // runner) and the integration order guarantee. `done` becomes visible only
  // after the merge lands, so dependents branch off merged state.
  const verifyCommands = [...(ctx.cfg.verifyDefaults ?? []), ...claimed.verify];
  let mergedDetail = "";
  let gateEnv: Record<string, string> | undefined;
  const release = await ctx.commit.acquire();
  try {
    log(ctx, `  verify: ${verifyCommands.length} command(s) in ${wtPath}`);
    const runGate = (tag: string, env?: Record<string, string>) =>
      runVerifiers(sliceId, attempt, verifyCommands, join(dir, "logs"), {
        projectDir: wtPath,
        onProgress: progressFn(ctx, sliceId, tag),
        env,
      });
    let verdict = await runGate("verify");
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");

    const logTail = (): void => {
      // Show WHY it failed: tail of the first failing step (full log is in
      // slices/<id>/logs/). Without this the retry/terminal line is a mystery.
      const failedStep = verdict.steps.find((s) => s.exit !== 0);
      const tail = failedStep?.outputTail?.trim();
      if (tail) {
        const clipped = tail.length > 2000 ? tail.slice(-2000) : tail;
        log(ctx, `  verify output tail (${failedStep!.command.slice(0, 80)}):\n${clipped.split("\n").map((l) => `    ${l}`).join("\n")}`);
      }
    };

    if (!verdict.pass) {
      logTail();
      // Triage before spending anything: infrastructure failures (port taken,
      // DB down) are never the worker's fault — park the slice WITHOUT
      // consuming a retry so a dead Postgres can't terminal-fail good code.
      // Missing NAMED credentials/URLs instead get a dev-only placeholder
      // (noted in the run's placeholders.md) and the gate re-runs, so the
      // roadmap keeps moving. Deploy slices and infra failures still park.
      let envBlock = classifyEnvFailure(verdict.steps.map((s) => s.outputTail));
      // Attempt-scoped placeholder env: every gate re-run below (debugger
      // re-verify, reviewer's own checks) sees the same injected values.
      if (envBlock && !ctx.noPlaceholders && ctx.cfg.placeholders !== false) {
        const rec = await recoverWithPlaceholders(ctx, sliceId, attempt, claimed, verdict, runGate);
        verdict = rec.verdict;
        writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
        if (rec.kind === "park") {
          storeApi.blockEnv(projectDir, runId, sliceId, join("slices", sliceId, "verdict.json"), rec.reason);
          log(ctx, summarize5(claimed, `environment blocked: ${rec.reason} (no retry consumed)`, report, false));
          log(ctx, `  fix: ${rec.fix}`);
          return;
        }
        gateEnv = rec.env;
        if (!verdict.pass) {
          logTail();
          envBlock = classifyEnvFailure(verdict.steps.map((s) => s.outputTail));
        } else {
          envBlock = null;
        }
      }
      if (envBlock && !verdict.pass) {
        storeApi.blockEnv(projectDir, runId, sliceId, join("slices", sliceId, "verdict.json"),
          envBlock.reason);
        log(ctx, summarize5(claimed, `environment blocked: ${envBlock.reason} (no retry consumed)`, report, false));
        log(ctx, `  fix: ${envBlock.fix}`);
        return;
      }
      // One bounded debugger session (fresh context, same worktree) gets a
      // chance to fix genuine failures before the retry budget is touched.
      // Not recursive: whatever the debugger leaves behind goes through the
      // standard retry-or-terminal path below.
      if (!ctx.noDebug) {
        const debugged = await runDebugger(ctx, sliceId, attempt, claimed, verifyCommands, verdict, wtPath, gateEnv);
        if (ctx.signal?.aborted) return; // abort already recorded inside runDebugger
        if (debugged) {
          log(ctx, `  debugger claims a fix — re-running the gate`);
          verdict = await runGate("verify", gateEnv ? { ...gateEnv } : undefined);
          writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
          if (!verdict.pass) logTail();
        }
      }
    }

    if (!verdict.pass) {
      const reason = verdict.steps.length === 0
        ? "no verifiers"
        : `verify failed: ${verdict.steps.filter((s) => s.exit !== 0).map((s) => s.command).join("; ").slice(0, 300)}`;
      storeApi.verifyFailed(projectDir, runId, sliceId, join("slices", sliceId, "verdict.json"), "verify_failed");
      if (attempt <= maxRetries) {
        storeApi.retrySlice(projectDir, runId, sliceId);
        log(ctx, summarize5(claimed, reason, report, false));
        log(ctx, `  retrying (${attempt}/${maxRetries} retries used)`);
      } else {
        storeApi.terminalFail(projectDir, runId, sliceId, "verify_failed");
        log(ctx, summarize5(claimed, `${reason} — terminal (retries exhausted)`, report, false));
      }
      return;
    }

    const m = ctx.wt.merge(projectDir, runId, sliceId, attempt);
    if (!m.merged) {
      const conflictFile = join("slices", sliceId, `merge-${attempt}.conflict.txt`);
      writeFileSync(join(dir, `merge-${attempt}.conflict.txt`), m.detail, "utf8");
      storeApi.verifyFailed(projectDir, runId, sliceId, conflictFile, "merge_conflict");
      storeApi.terminalFail(projectDir, runId, sliceId, "merge_conflict");
      log(ctx, summarize5(claimed, `merge conflict — terminal. ${m.detail}`, report, true));
      log(ctx, `  resolve in the slice branch and re-run; worktree kept for forensics`);
      return;
    }
    if (m.nothingToCommit) log(ctx, `  merge: nothing to commit — worker changed no files, proceeding to review`);
    mergedDetail = m.detail;
  } finally {
    release();
  }

  // 7. Independent review (fresh session, merged tree, own checks).
  // Runs OUTSIDE the commit mutex: review only reads and spot-checks, so it
  // may overlap other pipelines' work. Done lands only on approval.
  if (!ctx.noReview) {
    const approved = await runReview(ctx, sliceId, attempt, claimed, report, verifyCommands, gateEnv);
    if (!approved) return;
  }

  storeApi.verifyPassed(projectDir, runId, sliceId, join("slices", sliceId, "verdict.json"));
  log(ctx, summarize5(claimed, `done (${mergedDetail})`, report, true));

  // 8. Drop the worktree after a successful merge (branch kept for audit).
  // Best-effort: the slice is done regardless.
  try {
    ctx.wt.remove(projectDir, runId, sliceId);
  } catch (err) {
    log(ctx, `  worktree cleanup warning for ${sliceId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runRoadmapLoop(opts: LoopOptions): Promise<LoopResult> {
  const runner: WorkerRunner = opts.runner ?? runOmpWorker;
  const cfg = loadRoadmapConfig(opts.projectDir);
  const jobs = Math.max(1, Math.floor(opts.jobs ?? 1));
  const wt = opts.worktrees ?? worktreeOpsFor(opts.projectDir);
  const commit = createMutex();
  const trackers = new Map<string, ProgressTracker>();
  const ctx: AttemptCtx = {
    projectDir: opts.projectDir,
    runId: opts.runId,
    runner,
    cfg,
    commit,
    wt,
    // Independent review: another fresh worker session (default: same runner
    // as the worker, so tmux review sessions get their own pane + TUI).
    reviewer: opts.reviewer ?? runner,
    noReview: opts.noReview ?? false,
    reviewModel: opts.reviewModel,
    reviewTimeoutMs: opts.reviewTimeoutMs,
    noDebug: opts.noDebug ?? false,
    noPlaceholders: opts.noPlaceholders ?? false,
    debugTimeoutMs: opts.debugTimeoutMs
      ?? (cfg.debugTimeoutSec ? cfg.debugTimeoutSec * 1000 : undefined),
    maxRetriesOverride: opts.maxRetriesOverride,
    timeoutMsOverride: opts.timeoutMsOverride,
    signal: opts.signal,
    onEvent: opts.onEvent,
    heartbeatMs: opts.heartbeatMs ?? 60000,
    trackers,
  };
  const finish = (): LoopResult => {
    const cursor = loadRun(opts.projectDir, opts.runId);
    const count = (s: string) => cursor.doc.slices.filter((x) => x.status === s).length;
    const done = count("done");
    const failed = count("failed");
    const skipped = count("skipped");
    const blockedEnv = count("blocked-env");
    const pending = cursor.doc.slices.filter((x) => !["done", "failed", "skipped"].includes(x.status)).length;
    const exitCode = failed > 0 || pending > 0 ? 1 : 0;
    reportPlaceholders({ projectDir: opts.projectDir, runId: opts.runId, onEvent: opts.onEvent });
    return { exitCode, done, failed, skipped, pending, blockedEnv };
  };

  // Single-slice mode: validate, claim, run one attempt, finish.
  if (opts.onlySlice) {
    const doc: RoadmapDoc = loadRun(opts.projectDir, opts.runId).doc;
    const found = doc.slices.find((s) => s.id === opts.onlySlice) ?? null;
    if (!found) throw new Error(`unknown slice "${opts.onlySlice}"`);
    if (["done", "failed", "skipped"].includes(found.status)) {
      log(opts, `slice ${found.id} already ${found.status} — nothing to do`);
      return finish();
    }
    const byId = new Map(doc.slices.map((s) => [s.id, s]));
    if (!found.deps.every((d) => depSatisfied(byId.get(d)))) {
      throw new Error(`slice "${found.id}" is blocked: deps not done`);
    }
    if (found.status !== "pending") {
      throw new Error(`slice "${found.id}" is ${found.status}; resume the run first`);
    }
    storeApi.claimSlice(opts.projectDir, opts.runId, found.id);
    await runAttempt(ctx, found.id);
    return finish();
  }

  // Claim the first ready slice not already in flight. Synchronous from
  // selection through claim (no await between) so concurrent pipelines cannot
  // double-claim; the claim itself is conditional (pending-only) as backup.
  const claimNext = (inflight: Map<string, Promise<void>>): Slice | null => {
    if (opts.signal?.aborted) return null;
    const doc: RoadmapDoc = loadRun(opts.projectDir, opts.runId).doc;
    const next = readySlices(doc).find((s) => !inflight.has(s.id)) ?? null;
    if (!next) return null;
    try {
      storeApi.claimSlice(opts.projectDir, opts.runId, next.id);
    } catch (err) {
      // Lost race with a concurrent pipeline (already claimed): try the next
      // ready slice. Any other store error is real — fail the slice in-store
      // instead of silently treating it as end-of-work.
      if (err instanceof Error && err.message.includes("cannot claim slice")) return null;
      unexpectedFailure(next.id, err);
      return null;
    }
    return loadRun(opts.projectDir, opts.runId).doc.slices.find((s) => s.id === next.id)!;
  };

  // Hang backstop: runAttempt is total by contract, but an unexpected throw
  // outside its guarded regions must fail the slice in-store — never strand
  // the scheduler on a Promise.race that can no longer settle.
  const unexpectedFailure = (sliceId: string, err: unknown): void => {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      const cur = loadRun(opts.projectDir, opts.runId).doc.slices.find((s) => s.id === sliceId)!;
      const ref = join("slices", sliceId, `unexpected-${cur.attempts}.error.txt`);
      writeFileSync(join(sliceDir(opts.projectDir, opts.runId, sliceId), `unexpected-${cur.attempts}.error.txt`), msg, "utf8");
      storeApi.verifyFailed(opts.projectDir, opts.runId, sliceId, ref, "unexpected");
      storeApi.terminalFail(opts.projectDir, opts.runId, sliceId, "unexpected");
      log(opts, `— slice ${sliceId}: unexpected pipeline error — terminal: ${msg.slice(0, 200)}`);
    } catch {
      /* store itself broken; loop will surface it on next load */
    }
  };

  const inflight = new Map<string, Promise<void>>();
  const startedAt = new Map<string, number>();
  const settle = (sliceId: string): void => {
    inflight.delete(sliceId);
    startedAt.delete(sliceId);
    trackers.delete(sliceId);
  };
  for (;;) {
    while (inflight.size < jobs) {
      const next = claimNext(inflight);
      if (!next) break;
      startedAt.set(next.id, Date.now());
      const task = runAttempt(ctx, next.id);
      const tracked = task.then(
        () => settle(next.id),
        (err: unknown) => {
          settle(next.id);
          unexpectedFailure(next.id, err);
        },
      );
      inflight.set(next.id, tracked);
    }
    if (inflight.size === 0) {
      if (opts.signal?.aborted) {
        storeApi.abortRun(opts.projectDir, opts.runId);
        log(opts, "aborted by signal");
        const r = finish();
        return { ...r, exitCode: 2 };
      }
      const r = finish();
      storeApi.finishRun(
        opts.projectDir,
        opts.runId,
        `done=${r.done} failed=${r.failed} skipped=${r.skipped} pending=${r.pending}`,
      );
      log(opts, `run finished: done=${r.done} failed=${r.failed} blocked-env=${r.blockedEnv} skipped=${r.skipped} pending=${r.pending}`);
      if (r.blockedEnv > 0) {
        log(opts, `fix the environment, then \`ompo resume\` to re-queue the blocked slices`);
      }
      return r;
    }

    // Heartbeat + prompt abort: wake every heartbeatMs to report elapsed
    // in-flight slices, or immediately on abort.
    const tick = new Promise<"tick">((resolve) => {
      const t = setTimeout(() => resolve("tick"), ctx.heartbeatMs);
      t.unref?.();
    });
    const aborted = new Promise<"aborted">((resolve) => {
      if (!opts.signal) return;
      if (opts.signal.aborted) resolve("aborted");
      else opts.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const winner = await Promise.race([
      Promise.allSettled(inflight.values()).then((): "settle" => "settle"),
      tick,
      aborted,
    ]);
    if (winner === "tick") {
      for (const [id, t0] of startedAt) {
        const mins = Math.floor((Date.now() - t0) / 60000);
        const t = trackers.get(id);
        const detail = t && t.lines > 0
          ? ` ${t.turns} turns, ${t.tools} tools, last: ${t.lastLine.slice(0, 100)}`
          : " no agent output yet";
        log(opts, `… ${id} still running (${mins}m elapsed,${detail})`);
      }
    }
  }
}
