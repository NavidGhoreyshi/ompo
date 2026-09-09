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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  depSummaries,
  DEFAULT_CONTEXT_CAP_TOKENS,
  failAttempt,
  formatTimeout,
  log,
  maxRetriesFor,
  newProgressTracker,
  preserveIncompleteWork,
  progressFn,
  usageFn,
  summarize5,
  type AttemptCtx,
  type ProgressTracker,
} from "./attempt.ts";
import { loadRoadmapConfig } from "./config.ts";
import { depSatisfied, readySlices } from "./select.ts";
import { buildWorkerSpec } from "./spec.ts";
import { sliceDir, storeApi, loadRun, RUNS_DIR } from "./store.ts";
import type { CompletionReport, RoadmapDoc, Slice, Verdict } from "./types.ts";
import { buildUnblockPrompt, collectUnblockInfo, hasPredeployWork, recheckUnblockTargets, stallTargets, unblockPromptRef } from "./unblock.ts";
import { applyIntent, drainIntents, latestSeq } from "./control.ts";
import { EMPTY_FAULTS, faultsArmed, mulberry32, shouldAbortAttempt, shouldCrashAfter, shouldFailVerify, type FaultSpec } from "./faults.ts";
import { extractHarnessFix, extractReportFromOutput, validateCompletionReport } from "./report.ts";
import { buildDebugPrompt, classifyEnvFailure, DEFAULT_DEBUG_TIMEOUT_MS, validateHarnessFix } from "./debug.ts";
import { applyHarnessFix, headFileSet } from "./harnessFix.ts";
import { runVerifiers } from "./verify.ts";
import { reportDeferred, reportPlaceholders } from "./runReports.ts";
import { runReview } from "./reviewLane.ts";
import { buildModelChain, displayModel, resolveWorkerModel, runOmpWorker, runWithModelFallbacks, type TokenUsage, type WorkerRunner } from "./worker.ts";
import { handoffBriefRef, recordHandoff, type HandoffCause } from "./handoffs.ts";
import { createMutex, type Mutex } from "./mutex.ts";
import { worktreeOpsFor, sliceBranchOf, type WorktreeOps } from "./worktree.ts";
import { extractMissingVar, loadPlaceholders, placeholderFor, placeholdersDocRef, recordPlaceholder } from "./placeholders.ts";
import { hasServices, healServices, isHealableBlock, serviceEnvOf } from "./services.ts";
import { preMergeSecretGate } from "./secrets.ts";

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
  /** Disable end-of-run unblock sessions (`--no-unblock`). */
  noUnblock?: boolean;
  maxUnblocksOverride?: number;
  /** Disable context-cap handoff to a fresh session (`--no-handoff`). */
  noHandoff?: boolean;
  /** Per-session token cap before handoff (`--context-cap N`, roadmap.yml contextCapTokens, default 120000, 0 disables). */
  contextCapOverride?: number;
  /** Deterministic RNG seed (chaos abort draws; CLI also suffixes fresh run ids). */
  seed?: number;
  /** Parsed chaos faults (CLI-only `--fault-inject`, never config). */
  faults?: FaultSpec;
  /** Control-intent poll interval for cross-process `ompo ctl` (default 2000ms). */
  controlPollMs?: number;
  /** Re-run done slices' gates on current HEAD at loop start (`--reverify`). */
  reverify?: boolean;
}

export interface LoopResult {
  exitCode: 0 | 1 | 2 | 3;
  done: number;
  failed: number;
  skipped: number;
  pending: number;
  blockedEnv: number;
}


/** Base HEAD SHA, best-effort (null outside git or on spawn failure). */
function gitHead(projectDir: string): string | null {
  try {
    const r = spawnSync("git", ["-C", projectDir, "rev-parse", "HEAD"], { encoding: "utf8" });
    const out = (r.stdout ?? "").trim();
    return r.status === 0 && out !== "" ? out : null;
  } catch {
    return null;
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
  // Debugger runs through the same fallback chain: a model outage must not
  // eat the one debug session (no retry consumed, partial fix preserved).
  const debugChain = buildModelChain(resolveWorkerModel(claimed.workerAgent, ctx.cfg), ctx.cfg.modelFallbacks);
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
    const res = await runWithModelFallbacks(
      ctx.runner,
      { prompt, sliceId, attempt, label: `${sliceId} debug` },
      { projectDir: wtPath, timeoutMs: debugBudgetMs, signal: ctx.signal, sessionDir: dir, onProgress, env },
      debugChain,
      {
        accept: (stdout) => extractReportFromOutput(stdout) !== undefined,
        preserve: () => preserveIncompleteWork(ctx, sliceId, attempt, "debug model unavailable, falling back"),
        onModelAttempt: (model, i) => {
          if (i > 0) log(ctx, `  debug model: ${displayModel(model)} (fallback ${i + 1}/${debugChain.length}, no retry consumed)`);
        },
        onFallback: (from, to) => {
          log(ctx, `  debug model ${displayModel(from)} unavailable — falling back to ${displayModel(to)} (no retry consumed)`);
        },
      },
    );
    if (res.fellBack) {
      writeFileSync(join(dir, `debug-${attempt}.models.json`), JSON.stringify({ tried: res.tried, accepted: displayModel(res.model) }, null, 2) + "\n", "utf8");
    }
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
 * End-of-run unblock session (self-sufficient loop): one bounded fresh agent
 * diagnoses whatever blocks the run and fixes it at host + worktree level.
 * Returns "continue" when recheck-green targets were demoted (caller loops),
 * "finish" when the run should end as before, "aborted" on operator abort.
 * Never throws; all failures land in the log as "finish".
 */
async function runUnblocker(ctx: AttemptCtx, round: number): Promise<"continue" | "finish" | "aborted"> {
  const { projectDir, runId } = ctx;
  const runRoot = join(projectDir, RUNS_DIR, runId);
  const doc = loadRun(projectDir, runId).doc;
  const targets = collectUnblockInfo(projectDir, runId, doc, (id) => ctx.wt.ensure(projectDir, runId, id));
  if (targets.length === 0) return "finish";
  const head = doc.slices.find((s) => s.id === targets[0]!.sliceId)!;
  const prompt = buildUnblockPrompt(targets, round, ctx.maxUnblocks);
  writeFileSync(join(runRoot, `unblock-${round}.prompt.md`), prompt, "utf8");
  log(ctx, `  prompt: ${unblockPromptRef(runId, round)}`);
  const unblockChain = buildModelChain(resolveWorkerModel(head.workerAgent, ctx.cfg), ctx.cfg.modelFallbacks);
  const unblockBudgetMs = ctx.debugTimeoutMs ?? DEFAULT_DEBUG_TIMEOUT_MS;
  log(ctx, `◐ unblock round ${round}/${ctx.maxUnblocks} — ${targets.length} blocked slice(s): ${targets.map((t) => t.sliceId).join(", ")} (budget ${formatTimeout(unblockBudgetMs)})`);
  if (ctx.signal?.aborted) return "aborted";
  const onProgress = progressFn(ctx, head.id, "unblock");
  let unblockStdout = "";
  try {
    const res = await runWithModelFallbacks(
      ctx.runner,
      { prompt, sliceId: head.id, attempt: head.attempts, label: `${head.id} unblock` },
      {
        projectDir,
        timeoutMs: unblockBudgetMs,
        signal: ctx.signal,
        sessionDir: runRoot,
        onProgress,
        env: hasServices(ctx.cfg) ? serviceEnvOf(ctx.cfg) : undefined,
      },
      unblockChain,
      {
        accept: (stdout) => extractReportFromOutput(stdout) !== undefined,
        preserve: () => preserveIncompleteWork(ctx, head.id, head.attempts, "unblock model unavailable, falling back"),
        onModelAttempt: (model, i) => {
          if (i > 0) log(ctx, `  unblock model: ${displayModel(model)} (fallback ${i + 1}/${unblockChain.length}, round continues)`);
        },
        onFallback: (from, to) => {
          log(ctx, `  unblock model ${displayModel(from)} unavailable — falling back to ${displayModel(to)} (round continues)`);
        },
      },
    );
    writeFileSync(join(runRoot, `unblock-${round}.log`), `exit=${res.exit} timedOut=${res.timedOut} durationMs=${res.durationMs}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`, "utf8");
    if (res.eventsJsonl) {
      try {
        writeFileSync(join(runRoot, `unblock-${round}.events.jsonl`), res.eventsJsonl, "utf8");
      } catch {
        /* forensics are best-effort */
      }
    }
    unblockStdout = res.stdout;
    if (res.timedOut) {
      log(ctx, `  unblock round ${round} timed out — ending run, \`ompo resume\` still works`);
      return "finish";
    }
    if (res.exit !== 0 && extractReportFromOutput(res.stdout) === undefined) {
      log(ctx, `  unblock round ${round} exited ${res.exit} with no report — ending run, \`ompo resume\` still works`);
      return "finish";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.signal?.aborted) return "aborted";
    log(ctx, `  unblock round ${round} failed: ${msg} — ending run, \`ompo resume\` still works`);
    return "finish";
  }
  let report;
  try {
    const extracted = extractReportFromOutput(unblockStdout);
    if (extracted === undefined) throw new Error("no <<<OMPO_REPORT>>> block in unblock output");
    report = validateCompletionReport(extracted, head.id);
    if (!report.done) throw new Error(`unblocker gave up: ${report.verificationNotes.slice(0, 300)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(ctx, `  unblock inconclusive: ${msg} — ending run, \`ompo resume\` still works`);
    return "finish";
  }
  // Preserve whatever the agent changed in the worktrees onto the slice
  // branches (best-effort per target), then deterministically re-run each
  // recorded failing command. Only recheck-green targets demote — the
  // report is advisory, the recheck decides.
  for (const t of targets) {
    try {
      const cur = loadRun(projectDir, runId).doc.slices.find((s) => s.id === t.sliceId)!;
      const snap = ctx.wt.commitWork(projectDir, runId, t.sliceId, cur.attempts, `unblock-${round} snapshot`);
      if (!snap.nothingToCommit) log(ctx, `  preserved unblock work on ${t.sliceId}: ${snap.detail}`);
    } catch {
      /* preservation is best-effort */
    }
  }
  const recorded = loadPlaceholders(projectDir, runId);
  const recheckEnv: Record<string, string> = {
    ...serviceEnvOf(ctx.cfg),
    ...Object.fromEntries(Object.values(recorded).map((e) => [e.name, e.value])),
  };
  const green = await recheckUnblockTargets({
    projectDir,
    targets,
    env: Object.keys(recheckEnv).length > 0 ? recheckEnv : undefined,
    onEvent: (m) => log(ctx, m),
  });
  if (green.length === 0) {
    log(ctx, `  unblock claims fixed but recheck is still red — ending run, \`ompo resume\` still works`);
    return "finish";
  }
  for (const id of green) {
    storeApi.operatorRetry(projectDir, runId, id, `unblock round ${round}: recheck green`);
  }
  log(ctx, `  unblocked: ${green.join(", ")} (recheck green — re-queued; failed slices get one extra attempt, attempts keep counting)`);
  return "continue";
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
  verdict: Verdict,
  runGate: (tag: string, env?: Record<string, string>) => Promise<Verdict>,
  baseEnv?: Record<string, string>,
): Promise<PlaceholderRecovery> {
  const { projectDir, runId } = ctx;
  const docRef = placeholdersDocRef(runId);
  // Scoped to this attempt's gate re-runs: never touches process.env, so
  // concurrent pipelines cannot see each other's placeholders. Starts from
  // the healed service env (real values win — never re-invent those names).
  const extraEnv: Record<string, string> = { ...(baseEnv ?? {}) };
  let cur = verdict;
  for (let round = 0; round < 5; round++) {
    const tails = cur.steps.map((s) => s.outputTail);
    const block = classifyEnvFailure(tails);
    if (!block) return { kind: "failed", verdict: cur, env: { ...extraEnv } };
    const name = extractMissingVar(block.reason, tails);
    if (!name) return { kind: "park", verdict: cur, reason: block.reason, fix: block.fix };
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
 * Continuation brief for one ended generation (written to
 * slices/<id>/handoff-<attempt>-g<gen>.md and inlined into the next
 * generation's prompt). Pure — unit-tested.
 */
export function buildHandoffBrief(args: {
  sliceId: string;
  attempt: number;
  generation: number;
  cause: HandoffCause;
  tokens: number;
  cap: number;
  preservedReason: string;
  logRef: string;
  promptRef: string;
  agentNotes?: string;
}): string {
  const causeLine =
    args.cause === "context-cap"
      ? `Orchestrator cap abort: the session reached ${args.tokens} tokens (cap ${args.cap}).`
      : `Agent-declared: the worker judged its context nearly exhausted and stopped cleanly.`;
  const notes = args.agentNotes?.trim()
    ? args.agentNotes.trim()
    : "(none — reconstruct state from the worker log tail and the branch diff below.)";
  return [
    `# Handoff brief — ${args.sliceId} attempt ${args.attempt} g${args.generation} → g${args.generation + 1}`,
    ``,
    `${causeLine}`,
    `Incomplete work was preserved on the slice branch as "${args.preservedReason}" — resume from it, do not redo it.`,
    `Generation artifacts: ${args.logRef}, ${args.promptRef}.`,
    ``,
    `## Agent notes (verbatim from the ended generation)`,
    ``,
    notes,
    ``,
  ].join("\n");
}

/**
 * Generation ≥1 prompt: the original spec plus the prior brief inline.
 * Pure — unit-tested.
 */
export function buildContinuationPrompt(specPrompt: string, brief: string): string {
  return (
    `${specPrompt}\n\n## CONTINUATION — a prior generation handed this slice to you (fresh context)\n` +
    `You are the next generation of the SAME attempt on the SAME branch. Work already done stays done: ` +
    `verify what remains against the brief and finish the slice under the same completion contract.\n\n${brief}`
  );
}

/**
 * Durable side of one handoff: brief file + handoffs.md entry +
 * slice_handoff event. Returns the brief (inlined into the next prompt).
 * The slice status is untouched (still running) — no retry consumed.
 */
function recordGenerationHandoff(
  ctx: AttemptCtx,
  sliceId: string,
  attempt: number,
  generation: number,
  cause: HandoffCause,
  tokens: number,
  preservedReason: string,
  agentNotes?: string,
): string {
  const { projectDir, runId } = ctx;
  const dir = sliceDir(projectDir, runId, sliceId);
  const logRef = join("slices", sliceId, `worker-${attempt}-g${generation}.log`);
  const brief = buildHandoffBrief({
    sliceId,
    attempt,
    generation,
    cause,
    tokens,
    cap: ctx.contextCapTokens,
    preservedReason,
    logRef,
    promptRef: join("slices", sliceId, `prompt-${attempt}-g${generation}.md`),
    agentNotes,
  });
  const briefRef = handoffBriefRef(sliceId, attempt, generation);
  writeFileSync(join(dir, `handoff-${attempt}-g${generation}.md`), brief, "utf8");
  recordHandoff(projectDir, runId, {
    sliceId,
    attempt,
    generation,
    cause,
    tokens,
    cap: ctx.contextCapTokens,
    briefRef,
    preserved: preservedReason,
  });
  storeApi.recordHandoff(projectDir, runId, sliceId, `g${generation} → g${generation + 1} (${cause}, ${tokens} tokens)`);
  log(ctx, `  handoff g${generation} → g${generation + 1} (${cause}, ${tokens} tokens): ${briefRef}`);
  return brief;
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
  // 1b. Shared services (self-sufficient loop): bring the project's world up
  // before the worker starts so its own verification uses the shared service
  // instead of improvising a disposable one. Best-effort here — a failed heal
  // never fails the attempt; the gate-phase heal re-tries before parking.
  let workerServiceEnv: Record<string, string> | undefined;
  if (hasServices(ctx.cfg)) {
    workerServiceEnv = serviceEnvOf(ctx.cfg);
    try {
      const pre = await healServices({ projectDir, cfg: ctx.cfg, onEvent: (m) => log(ctx, m) });
      if (!pre.ok) log(ctx, `  services: pre-worker heal failed (${pre.detail}) — worker proceeds, gate will retry`);
    } catch (err) {
      log(ctx, `  services warning for ${sliceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Compile worker spec (worker cwd = worktree). A prior review
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
  // 3. Spawn worker generations (fresh `omp -p` context per generation).
  // A generation ends by report (stage 4 below), context-cap abort, or an
  // agent-declared HANDOFF: report — the latter two preserve incomplete work
  // and respawn the SAME attempt with generation+1 (no retry consumed).
  // Model fallback chain: primary, then modelFallbacks, then omp default.
  // A model that is unavailable (rate limit, unknown id) is skipped within
  // the same attempt — no retry consumed, partial work preserved on the branch.
  const workerChain = buildModelChain(resolveWorkerModel(claimed.workerAgent, ctx.cfg), ctx.cfg.modelFallbacks);
  const workerTimeoutMs = ctx.timeoutMsOverride ?? claimed.timeoutMs
    ?? (ctx.cfg.workerTimeoutSec ? ctx.cfg.workerTimeoutSec * 1000 : undefined);
  const onProgress = progressFn(ctx, sliceId);
  const onUsage = usageFn(ctx, sliceId);
  const cap = ctx.contextCapTokens;
  let workerOut = "";
  let workerStdout = "";
  // Hoisted worker result so the worker_finished event (step 5) can carry
  // exit/timing enrichment even though the result was scoped to the try.
  let workerMeta: { exit: number | null; timedOut: boolean; durationMs: number } | undefined;
  let report: CompletionReport | undefined;
  let lastBrief = "";
  for (let gen = 0; report === undefined; gen++) {
    const prompt = gen === 0 ? spec.prompt : buildContinuationPrompt(spec.prompt, lastBrief);
    writeFileSync(join(dir, `prompt-${attempt}-g${gen}.md`), prompt, "utf8");
    // Fresh per-generation token window: usage envelopes report cumulative
    // session totals and each generation is a new session.
    workerOut = "";
    workerStdout = "";
    workerMeta = undefined;
    const genTracker = ctx.trackers.get(sliceId);
    if (genTracker) genTracker.tokens = undefined;

    if (ctx.signal?.aborted) {
      storeApi.abortSlice(projectDir, runId, sliceId);
      return;
    }

    // Per-generation abort: operator aborts forward in; the cap abort fires
    // from the usage sink below. The runner sees one signal either way.
    const genCtrl = new AbortController();
    const forwardAbort = () => genCtrl.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) genCtrl.abort();
      else ctx.signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const stopForwarding = () => ctx.signal?.removeEventListener("abort", forwardAbort);
    let capHit = false;
    // A generation whose FIRST usage observation already meets the cap never
    // did billable work under it (the session baseline alone costs ≥ cap):
    // respawning would abort instantly forever, so fail loudly instead.
    let capBelowBaseline = false;
    let usageEvents = 0;
    const trackUsage = (u: TokenUsage) => {
      onUsage(u);
      usageEvents += 1;
      if (cap > 0 && usageEvents === 1 && u.total >= cap) capBelowBaseline = true;
      if (!capHit && cap > 0 && u.total >= cap) {
        capHit = true;
        log(ctx, `  context cap reached (g${gen}: ${u.total} tokens ≥ ${cap}) — preserving + respawning fresh (no retry consumed)`);
        genCtrl.abort();
      }
    };
    const genTokens = () => ctx.trackers.get(sliceId)?.tokens?.total ?? 0;
    // Shared exit for an unreachable cap: preserve, then fail through the
    // normal retry budget (bounded spend, loud cause) instead of handoff.
    const failUnreachableCap = () => {
      const reason = `context cap ${cap} below session baseline (${genTokens()} tokens on first use)`;
      preserveIncompleteWork(ctx, sliceId, attempt, reason);
      log(ctx, summarize5(claimed, `context cap unreachable: ${reason} — raise --context-cap / contextCapTokens or shrink the spec`));
      failAttempt(ctx, sliceId, claimed, join("slices", sliceId, `worker-${attempt}-g${gen}.log`), {
        cause: "context_cap_baseline",
        exit: workerMeta?.exit ?? null,
        timedOut: workerMeta?.timedOut,
        durationMs: workerMeta?.durationMs,
      });
    };
    try {
      const res = await runWithModelFallbacks(
        ctx.runner,
        { prompt, sliceId, attempt, generation: gen },
        { projectDir: wtPath, timeoutMs: workerTimeoutMs, signal: genCtrl.signal, sessionDir: dir, onProgress, onUsage: trackUsage, env: workerServiceEnv },
        workerChain,
        {
          accept: (stdout) => extractReportFromOutput(stdout) !== undefined,
          preserve: () => preserveIncompleteWork(ctx, sliceId, attempt, `model unavailable, falling back (g${gen})`),
          onModelAttempt: (model, i) => {
            const where = i === 0
              ? `worktree: ${wtPath} budget: ${formatTimeout(workerTimeoutMs)}`
              : `fallback ${i + 1}/${workerChain.length} (no retry consumed)`;
            log(ctx, `  model: ${displayModel(model)} ${where}`);
          },
          onFallback: (from, to) => {
            log(ctx, `  model ${displayModel(from)} unavailable — falling back to ${displayModel(to)} (no retry consumed)`);
          },
        },
      );
      stopForwarding();
      if (res.fellBack) {
        writeFileSync(join(dir, `worker-${attempt}-g${gen}.models.json`), JSON.stringify({ tried: res.tried, accepted: displayModel(res.model) }, null, 2) + "\n", "utf8");
      }
      workerMeta = { exit: res.exit, timedOut: res.timedOut, durationMs: res.durationMs };
      workerStdout = res.stdout;
      workerOut = `exit=${res.exit} timedOut=${res.timedOut} durationMs=${res.durationMs}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`;
      writeFileSync(join(dir, `worker-${attempt}-g${gen}.log`), workerOut, "utf8");
      if (res.eventsJsonl) {
        try {
          writeFileSync(join(dir, `worker-${attempt}-g${gen}.events.jsonl`), res.eventsJsonl, "utf8");
        } catch {
          /* forensics are best-effort */
        }
      }
      const t = ctx.trackers.get(sliceId);
      log(ctx, `  worker g${gen} exited in ${Math.round(res.durationMs / 1000)}s${t ? ` (${t.turns} turns, ${t.tools} tools)` : ""}`);
      if (capBelowBaseline && !ctx.signal?.aborted && fresh().status !== "aborted") {
        failUnreachableCap();
        return;
      }
      if (capHit && !ctx.signal?.aborted && fresh().status !== "aborted") {
        // Cap abort won the race: the session is spent by construction —
        // handoff instead of verifying its partial output.
        const reason = `context-cap g${gen}`;
        preserveIncompleteWork(ctx, sliceId, attempt, reason);
        lastBrief = recordGenerationHandoff(ctx, sliceId, attempt, gen, "context-cap", genTokens(), reason);
        continue;
      }
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
      stopForwarding();
      const msg = err instanceof Error ? err.message : String(err);
      writeFileSync(join(dir, `worker-${attempt}-g${gen}.log`), workerOut + `\nSPAWN ERROR: ${msg}\n`, "utf8");
      if (ctx.signal?.aborted) {
        preserveIncompleteWork(ctx, sliceId, attempt, "abort");
        storeApi.abortSlice(projectDir, runId, sliceId);
        log(ctx, summarize5(claimed, `aborted during worker run (no retry consumed)`));
        return;
      }
      if (capBelowBaseline && fresh().status !== "aborted") {
        failUnreachableCap();
        return;
      }
      if (capHit && fresh().status !== "aborted") {
        const reason = `context-cap g${gen}`;
        preserveIncompleteWork(ctx, sliceId, attempt, reason);
        lastBrief = recordGenerationHandoff(ctx, sliceId, attempt, gen, "context-cap", genTokens(), reason);
        continue;
      }
      if (fresh().status === "aborted") {
        preserveIncompleteWork(ctx, sliceId, attempt, "operator kill");
        log(ctx, summarize5(claimed, `killed by operator — worker output discarded (no retry consumed)`));
        return;
      }
      log(ctx, summarize5(claimed, `worker failure: ${msg}`));
      failAttempt(ctx, sliceId, claimed, join("slices", sliceId, `worker-${attempt}-g${gen}.log`), {
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

    // Operator kill that landed mid-worker: the branch work is preserved but
    // the output is dropped — a killed slice must never verify or merge.
    if (fresh().status === "aborted") {
      preserveIncompleteWork(ctx, sliceId, attempt, "operator kill");
      log(ctx, summarize5(claimed, `killed by operator — worker output discarded (no retry consumed)`));
      return;
    }

    // 4. Extract + validate strict report (raw stdout — the decorated log may
    // contain the same delimiters in worker prose).
    const extracted = extractReportFromOutput(workerStdout);
    try {
      if (extracted === undefined) throw new Error("no <<<OMPO_REPORT>>> block found in worker output");
      const candidate = validateCompletionReport(extracted, sliceId);
      if (!candidate.done && !ctx.noHandoff && candidate.verificationNotes.trimStart().startsWith("HANDOFF:")) {
        // Agent-declared handoff (also the tmux path — no usage stream
        // there): same preserve + respawn as a cap abort, no retry consumed.
        const reason = `agent-declared handoff g${gen}`;
        preserveIncompleteWork(ctx, sliceId, attempt, reason);
        lastBrief = recordGenerationHandoff(ctx, sliceId, attempt, gen, "agent-declared", genTokens(), reason, candidate.verificationNotes);
        continue;
      }
      if (!candidate.done) throw new Error(`worker reported done=false: ${candidate.verificationNotes.slice(0, 300)}`);
      report = candidate;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeFileSync(join(dir, `report-${attempt}.invalid.json`), JSON.stringify({ error: msg, raw: extracted === undefined ? null : extracted }, null, 2) + "\n", "utf8");
      log(ctx, summarize5(claimed, `invalid report: ${msg}`));
      failAttempt(ctx, sliceId, claimed, join("slices", sliceId, `report-${attempt}.invalid.json`));
      return;
    }
  }
  if (report === undefined) throw new Error("unreachable: generation loop exited without a report");

  // 5. Persist report → verifying.
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  // Crash durability: commit the worker's tree onto the slice branch now, so
  // a WSL kill / SIGKILL before the merge loses no file work — the retry
  // resumes from the branch instead of a bare tree. Warning-only: the merge
  // path commits again, so a failed snapshot never fails the attempt.
  try {
    const snap = ctx.wt.commitWork(projectDir, runId, sliceId, attempt, "worker-finished snapshot");
    if (!snap.nothingToCommit) log(ctx, `  preserved worker output: ${snap.detail}`);
  } catch (err) {
    log(ctx, `  snapshot warning for ${sliceId}: ${err instanceof Error ? err.message : String(err)}`);
  }
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

  // Chaos abort-attempt draw (one draw per attempt, seeded): exercises the
  // abort→resume path with real branch preservation, no retry consumed.
  if (shouldAbortAttempt(ctx.faults, ctx.rng)) {
    preserveIncompleteWork(ctx, sliceId, attempt, "fault-inject abort-attempt");
    storeApi.abortSlice(projectDir, runId, sliceId);
    log(ctx, summarize5(claimed, `FAULT INJECTED: abort-attempt — parked as aborted, resume re-queues (no retry consumed)`));
    return;
  }

  // Crash-recovery seam: everything below needs no worker — the saved report
  // carries the done claim. Recovery replays runCommitPhase from report.json.
  await runCommitPhase(ctx, sliceId, attempt, report);
}

/**
 * Commit phase of one attempt (stages 6-8): verify → secret scan → merge →
 * review → done. Split from runAttempt so crash recovery can replay it from
 * a saved report.json without respawning the worker (the expensive part).
 * Total by contract like runAttempt: failures land in-store, never throw.
 */
export async function runCommitPhase(
  ctx: AttemptCtx,
  sliceId: string,
  attempt: number,
  report: CompletionReport,
): Promise<void> {
  const { projectDir, runId } = ctx;
  const dir = sliceDir(projectDir, runId, sliceId);
  const fresh = () => loadRun(projectDir, runId).doc.slices.find((s) => s.id === sliceId)!;
  const claimed = fresh();
  const maxRetries = maxRetriesFor(claimed, ctx);
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

  // 6+7. Commit phase (serialized): verify in the worktree, then merge.
  // The mutex is the shared-resource lock (one DB, one :3000, one batch
  // runner) and the integration order guarantee. `done` becomes visible only
  // after the merge lands, so dependents branch off merged state.
  const verifyCommands = [...(ctx.cfg.verifyDefaults ?? []), ...claimed.verify];
  let mergedDetail = "";
  let gateEnv: Record<string, string> | undefined;
  const release = await ctx.commit.acquire();
  try {
    // A kill that landed while queued on the mutex drops out here — the
    // finally below still releases, and the branch work stays preserved.
    if (fresh().status === "aborted") {
      preserveIncompleteWork(ctx, sliceId, attempt, "operator kill");
      log(ctx, summarize5(claimed, `killed by operator — gate skipped (no retry consumed)`));
      return;
    }
    log(ctx, `  verify: ${verifyCommands.length} command(s) in ${wtPath}`);
    const runGate = (tag: string, env?: Record<string, string>): Promise<Verdict> => {
      // Chaos fail-verify: the verdict is injected, no command runs — the
      // retry/debugger/terminal path below exercises exactly as on a real red.
      if (shouldFailVerify(ctx.faults, sliceId)) {
        return Promise.resolve({
          sliceId,
          attempt,
          pass: false,
          steps: verifyCommands.map((command) => ({
            name: command.slice(0, 80),
            command,
            exit: 1,
            timedOut: false,
            outputTail: "FAULT INJECTED: fail-verify — no command ran",
            logRef: join("slices", sliceId, "logs"),
          })),
          at: new Date().toISOString(),
        });
      }
      return runVerifiers(sliceId, attempt, verifyCommands, join(dir, "logs"), {
        projectDir: wtPath,
        onProgress: progressFn(ctx, sliceId, tag),
        env,
      });
    };
    let verdict = await runGate("verify");
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");

    const logTail = (): void => {
      // Show WHY it failed: tail of the first failing step (full log is in
      // slices/<id>/logs/). Without this the retry/terminal line is a mystery.
      // Split `&&` chains put setup output in the PASSING prior gate, so its
      // tail prints as context — otherwise `echo why && exit 1` loses the why.
      const idx = verdict.steps.findIndex((s) => s.exit !== 0);
      const failedStep = idx >= 0 ? verdict.steps[idx] : undefined;
      if (failedStep) {
        const tail = failedStep.outputTail?.trim() ?? "";
        const clipped = tail.length > 2000 ? tail.slice(-2000) : tail;
        const body = clipped ? clipped.split("\n").map((l) => `    ${l}`).join("\n") : "    (empty — gate produced no output)";
        log(ctx, `  verify output tail (${failedStep.command.slice(0, 80)}):\n${body}`);
      }
      const prev = idx > 0 ? verdict.steps[idx - 1]?.outputTail?.trim() : undefined;
      if (prev) {
        const clipped = prev.length > 500 ? prev.slice(-500) : prev;
        log(ctx, `  previous gate tail:\n${clipped.split("\n").map((l) => `    ${l}`).join("\n")}`);
      }
    };

    if (!verdict.pass) {
      logTail();
      // Triage before spending anything: infrastructure failures (port taken,
      // DB down) are never the worker's fault — park the slice WITHOUT
      // consuming a retry so a dead Postgres can't terminal-fail good code.
      // Missing NAMED credentials/URLs instead get a dev-only placeholder
      // (noted in the run's placeholders.md) and the gate re-runs, so the
      // roadmap keeps moving. Only infra failures still park.
      let envBlock = classifyEnvFailure(verdict.steps.map((s) => s.outputTail));
      // Self-sufficient loop: healable infra (DB down, port taken) runs the
      // project's serviceUp/serviceReady once and re-runs the gate before any
      // parking. Real service values seed gateEnv so placeholders never invent
      // names the services already provide.
      if (envBlock && isHealableBlock(envBlock.reason) && hasServices(ctx.cfg)) {
        log(ctx, `  services: gate blocked (${envBlock.reason}) — healing before parking`);
        try {
          const heal = await healServices({ projectDir, cfg: ctx.cfg, onEvent: (m) => log(ctx, m) });
          if (heal.ok) {
            gateEnv = { ...heal.env, ...(gateEnv ?? {}) };
            log(ctx, `  services healed — re-running the gate`);
            verdict = await runGate("verify", { ...gateEnv });
            writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
            if (!verdict.pass) logTail();
            envBlock = verdict.pass ? null : classifyEnvFailure(verdict.steps.map((s) => s.outputTail));
          } else {
            log(ctx, `  services heal failed (${heal.detail}) — falling through to park path`);
          }
        } catch (err) {
          log(ctx, `  services warning for ${sliceId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (envBlock && !ctx.noPlaceholders && ctx.cfg.placeholders !== false) {
        const rec = await recoverWithPlaceholders(ctx, sliceId, attempt, verdict, runGate, gateEnv ? { ...gateEnv } : undefined);
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

    // Deterministic pre-merge secret scan: reviewer secret judgment is
    // heuristic; this gate is exact. Findings refuse the merge through the
    // standard retry-or-terminal path with no debugger session (model
    // sessions are never pointed at secrets). Runs inside the commit mutex
    // so nothing merges between the scan and the merge below.
    if (!preMergeSecretGate({
      projectDir, runId, slice: claimed, attempt, dir, wtPath,
      branch: sliceBranchOf(runId, sliceId), verdict, report,
      maxRetries, log: (m) => log(ctx, m),
    })) {
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
    // Crash journal: record the merge landing (branch + base HEAD) so a kill
    // between here and slice_done is recognizable on resume — and so later
    // done-trust checks know which base commit this slice was verified on.
    // Advisory only: the merge already landed, a failed write changes nothing.
    try {
      const head = gitHead(projectDir);
      if (head !== null) {
        writeFileSync(
          join(dir, `merge-${attempt}.json`),
          JSON.stringify({ branch: sliceBranchOf(runId, sliceId), baseHead: head, at: new Date().toISOString() }, null, 2) + "\n",
          "utf8",
        );
      }
    } catch {
      /* journal is advisory */
    }
  } finally {
    release();
  }

  // 7. Independent review (fresh session, merged tree, own checks).
  // Runs OUTSIDE the commit mutex: review only reads and spot-checks, so it
  // may overlap other pipelines' work. Done lands only on approval.
  // A kill that landed during verify/merge drops out before the audit.
  if (fresh().status === "aborted") {
    log(ctx, summarize5(claimed, `killed by operator — review skipped (no retry consumed)`));
    return;
  }
  if (!ctx.noReview) {
    const approved = await runReview(ctx, sliceId, attempt, claimed, report, verifyCommands, wtPath, gateEnv);
    if (!approved) return;
  }

  storeApi.verifyPassed(projectDir, runId, sliceId, join("slices", sliceId, "verdict.json"), gitHead(projectDir));
  log(ctx, summarize5(claimed, `done (${mergedDetail})`, report, true));

  // 8. Drop the worktree after a successful merge (branch kept for audit).
  // Best-effort: the slice is done regardless.
  try {
    ctx.wt.remove(projectDir, runId, sliceId);
  } catch (err) {
    log(ctx, `  worktree cleanup warning for ${sliceId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface RecoveryPlan {
  sliceId: string;
  attempt: number;
  status: string;
  report: CompletionReport;
}

/**
 * Pure detector: crashed-in-flight slices (running/verifying/aborted after a
 * WSL kill, SIGKILL, or net-drop death) that left a valid saved done-report.
 * Torn or missing reports are skipped — the normal retry path owns those.
 * No store writes here; the caller applies.
 */
export function scanRecovery(projectDir: string, runId: string): RecoveryPlan[] {
  const out: RecoveryPlan[] = [];
  let doc;
  try {
    doc = loadRun(projectDir, runId).doc;
  } catch {
    return out;
  }
  for (const s of doc.slices) {
    if (s.status !== "running" && s.status !== "verifying" && s.status !== "aborted") continue;
    let raw: string;
    try {
      raw = readFileSync(join(sliceDir(projectDir, runId, s.id), "report.json"), "utf8");
    } catch {
      continue;
    }
    try {
      const report = validateCompletionReport(JSON.parse(raw), s.id);
      if (!report.done) continue;
      out.push({ sliceId: s.id, attempt: s.attempts, status: s.status, report });
    } catch {
      /* torn/invalid report: normal retry owns it */
    }
  }
  return out;
}

export interface DoneTrust {
  sliceId: string;
  outcome: "confirmed" | "backfilled" | "demoted" | "unverifiable";
  detail: string;
}

function gitIsRepo(projectDir: string): boolean {
  try {
    return spawnSync("git", ["-C", projectDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Is the slice's merge commit still in base history?
 * true = present · false = branch exists but rewritten away · null = unknown
 * (no branch, or git itself failed — never proof of loss).
 */
function branchMerged(projectDir: string, branch: string): boolean | null {
  try {
    if (spawnSync("git", ["-C", projectDir, "merge-base", "--is-ancestor", branch, "HEAD"], { encoding: "utf8" }).status === 0) {
      return true;
    }
    return spawnSync("git", ["-C", projectDir, "show-ref", "--verify", `refs/heads/${branch}`], { encoding: "utf8" }).status === 0
      ? false
      : null;
  } catch {
    return null;
  }
}

/** Base HEAD recorded by the merge journal (merge-<attempt>.json), if any. */
function mergeJournalHead(projectDir: string, runId: string, sliceId: string): string | null {
  let files: string[];
  try {
    files = readdirSync(sliceDir(projectDir, runId, sliceId)).filter((f) => /^merge-\d+\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  try {
    const journal = JSON.parse(readFileSync(join(sliceDir(projectDir, runId, sliceId), files[files.length - 1]!), "utf8"));
    return typeof journal?.baseHead === "string" && journal.baseHead !== "" ? journal.baseHead : null;
  } catch {
    return null;
  }
}

/**
 * Pure detector: are recorded done-merges still in history? Demotion needs
 * proof of loss (a RECORDED merge gone from HEAD) — suspicion alone
 * (missing branch, pre-journal run) only warns, never destroys done.
 * Non-git projects have nothing to check against → empty.
 */
export function scanDoneTrust(projectDir: string, runId: string): DoneTrust[] {
  const out: DoneTrust[] = [];
  let doc;
  try {
    doc = loadRun(projectDir, runId).doc;
  } catch {
    return out;
  }
  if (!doc.slices.some((s) => s.status === "done")) return out;
  if (!gitIsRepo(projectDir)) return out;
  for (const s of doc.slices) {
    if (s.status !== "done") continue;
    const recorded = s.verifiedHead ?? mergeJournalHead(projectDir, runId, s.id);
    const merged = branchMerged(projectDir, sliceBranchOf(runId, s.id));
    if (merged === true) {
      out.push(recorded
        ? { sliceId: s.id, outcome: "confirmed", detail: `merge verified on ${(recorded as string).slice(0, 12)}, still in history` }
        : { sliceId: s.id, outcome: "backfilled", detail: "branch in history but no merge record (pre-journal run) — stampable" });
    } else if (merged === false && recorded) {
      out.push({ sliceId: s.id, outcome: "demoted", detail: `merge verified on ${(recorded as string).slice(0, 12)} no longer in HEAD — history rewritten or merge lost` });
    } else {
      out.push({ sliceId: s.id, outcome: "unverifiable", detail: "no merge record and branch state unknown — cannot confirm, leaving done" });
    }
  }
  return out;
}

/**
 * Pure detector: skipped slices citing qa evidence that no longer exists.
 * Warn-only — revalidate (not resume) is the path for distrusting the map.
 */
export function scanSkipEvidence(projectDir: string, runId: string): { sliceId: string; missing: string[] }[] {
  const out: { sliceId: string; missing: string[] }[] = [];
  let doc;
  try {
    doc = loadRun(projectDir, runId).doc;
  } catch {
    return out;
  }
  for (const s of doc.slices) {
    if (!s.skip || (s.status !== "skipped" && s.status !== "done")) continue;
    const refs = [...s.body.matchAll(/qa\/[^\s,;)"']+/g)].map((m) => m[0].replace(/[.:]+$/, ""));
    const missing = [...new Set(refs)].filter((r) => !existsSync(join(projectDir, r)));
    if (missing.length > 0) out.push({ sliceId: s.id, missing });
  }
  return out;
}

/**
 * Gate-level reaudit of one done slice against current HEAD (--reverify).
 * Git projects get an ephemeral detached HEAD worktree; others run in place.
 * Pass stamps verifiedHead; env blocks park without consuming retry; genuine
 * failures demote to pending through the standard retry path. Never throws —
 * an errored reaudit leaves the slice done.
 */
async function reverifyDoneSlice(ctx: AttemptCtx, slice: Slice): Promise<void> {
  const { projectDir, runId } = ctx;
  const dir = sliceDir(projectDir, runId, slice.id);
  const commands = [...(ctx.cfg.verifyDefaults ?? []), ...slice.verify];
  const verdictRef = join("slices", slice.id, "verdict-reverify.json");
  if (commands.length === 0) {
    log(ctx, `◎ reverify ${slice.id}: no gates — nothing to run`);
    return;
  }
  const head = gitHead(projectDir);
  const runGates = (cwd: string): Promise<Verdict> =>
    runVerifiers(slice.id, slice.attempts, commands, join(dir, "logs-reverify"), {
      projectDir: cwd,
      onProgress: progressFn(ctx, slice.id, "reverify"),
    });
  let verdict: Verdict;
  if (gitIsRepo(projectDir) && head !== null) {
    const wt = join(projectDir, ".omp", "roadmap", "worktrees", `reverify-${runId}-${slice.id}`);
    spawnSync("git", ["-C", projectDir, "worktree", "remove", "--force", wt], { encoding: "utf8" });
    const add = spawnSync("git", ["-C", projectDir, "worktree", "add", "--detach", wt, "HEAD"], { encoding: "utf8" });
    if (add.status !== 0) throw new Error(`ephemeral worktree failed: ${((add.stderr ?? add.stdout ?? "") as string).slice(-500)}`);
    try {
      verdict = await runGates(wt);
    } finally {
      spawnSync("git", ["-C", projectDir, "worktree", "remove", "--force", wt], { encoding: "utf8" });
    }
  } else {
    verdict = await runGates(projectDir);
  }
  writeFileSync(join(dir, "verdict-reverify.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
  if (verdict.pass) {
    if (head !== null) storeApi.reverifySlice(projectDir, runId, slice.id, head, `reverify pass on ${head.slice(0, 12)}`);
    log(ctx, `◎ reverify ${slice.id}: gates pass on current HEAD`);
    return;
  }
  const envBlock = classifyEnvFailure(verdict.steps.map((st) => st.outputTail));
  if (envBlock) {
    storeApi.blockEnv(projectDir, runId, slice.id, verdictRef, envBlock.reason);
    log(ctx, `◎ reverify ${slice.id}: environment blocked: ${envBlock.reason} (no retry consumed)`);
    log(ctx, `  fix: ${envBlock.fix}`);
    return;
  }
  storeApi.verifyFailed(projectDir, runId, slice.id, verdictRef, "reverify_failed");
  storeApi.retrySlice(projectDir, runId, slice.id, "reverify gates failed on current HEAD");
  log(ctx, `⚠ reverify ${slice.id}: gates failed on current HEAD — demoted to pending`);
}

export async function runRoadmapLoop(opts: LoopOptions): Promise<LoopResult> {
  const runner: WorkerRunner = opts.runner ?? runOmpWorker;
  const cfg = loadRoadmapConfig(opts.projectDir);
  const jobs = { value: Math.max(1, Math.floor(opts.jobs ?? 1)) };
  const wt = opts.worktrees ?? worktreeOpsFor(opts.projectDir);
  const commit = createMutex();
  const trackers = new Map<string, ProgressTracker>();
  const faults = opts.faults ?? EMPTY_FAULTS;
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
    noUnblock: opts.noUnblock ?? false,
    maxUnblocks: opts.maxUnblocksOverride ?? cfg.maxUnblocks ?? 2,
    noHandoff: opts.noHandoff ?? false,
    contextCapTokens: (opts.noHandoff ?? false) ? 0 : (opts.contextCapOverride ?? cfg.contextCapTokens ?? DEFAULT_CONTEXT_CAP_TOKENS),
    debugTimeoutMs: opts.debugTimeoutMs
      ?? (cfg.debugTimeoutSec ? cfg.debugTimeoutSec * 1000 : undefined),
    maxRetriesOverride: opts.maxRetriesOverride,
    timeoutMsOverride: opts.timeoutMsOverride,
    signal: opts.signal,
    onEvent: opts.onEvent,
    heartbeatMs: opts.heartbeatMs ?? 60000,
    jobs,
    paused: false,
    faults,
    rng: mulberry32(opts.seed ?? (Date.now() % 4294967296)),
    controlOffset: latestSeq(opts.projectDir, opts.runId),
    controlPollMs: Math.max(250, opts.controlPollMs ?? 2000),
    trackers,
  };
  // Crash recovery (WSL kill / SIGKILL / net-drop death): slices that left a
  // valid saved done-report replay the commit phase — gates re-run, the merge
  // fast-paths when it already landed, review re-audits — instead of burning
  // a fresh worker session on already-done work. Runs before all loop paths
  // (including --slice) so every loop start heals. Replay failures never
  // throw: the slice stays queued for the normal retry path.
  const recoveredIds = new Set<string>();
  for (const rec of scanRecovery(opts.projectDir, opts.runId)) {
    try {
      const cur = loadRun(opts.projectDir, opts.runId).doc.slices.find((s) => s.id === rec.sliceId)!;
      if (cur.status !== "verifying") {
        storeApi.workerFinished(opts.projectDir, opts.runId, rec.sliceId, join("slices", rec.sliceId, "report.json"));
      }
      log(ctx, `↻ crash recovery: ${rec.sliceId} left a saved report (attempt ${rec.attempt}, was ${rec.status}) — replaying verify+merge+review, no new worker`);
      await runCommitPhase(ctx, rec.sliceId, rec.attempt, rec.report);
      recoveredIds.add(rec.sliceId);
    } catch (err) {
      log(ctx, `↻ crash recovery: ${rec.sliceId} replay failed (${err instanceof Error ? err.message : String(err)}) — leaving for the normal retry path`);
    }
  }
  // Done-trust recheck: recorded merges must still be in history. Demotion
  // needs proof of loss; suspicion only warns. Backfilled slices get their
  // record stamped so the warning fires once.
  for (const t of scanDoneTrust(opts.projectDir, opts.runId)) {
    if (t.outcome === "demoted") {
      storeApi.retrySlice(opts.projectDir, opts.runId, t.sliceId, t.detail);
      log(ctx, `⚠ done-trust: ${t.sliceId} demoted to pending — ${t.detail}`);
    } else if (t.outcome === "backfilled") {
      const head = gitHead(opts.projectDir);
      if (head !== null) storeApi.reverifySlice(opts.projectDir, opts.runId, t.sliceId, head, "backfilled: branch in history, no merge journal");
      log(ctx, `✓ done-trust: ${t.sliceId} confirmed in history (record stamped)`);
    } else if (t.outcome === "unverifiable") {
      log(ctx, `⚠ done-trust: ${t.sliceId} unverifiable — ${t.detail}`);
    }
  }
  for (const s of scanSkipEvidence(opts.projectDir, opts.runId)) {
    log(ctx, `⚠ done-trust: ${s.sliceId} cites missing evidence: ${s.missing.join(", ")}`);
  }
  // Opt-in reaudit (--reverify): re-run done slices' gates on current HEAD.
  // Slices just recovered above already ran fresh gates — skip them.
  if (opts.reverify) {
    const dones = loadRun(opts.projectDir, opts.runId).doc.slices.filter(
      (s) => s.status === "done" && !s.skip && !recoveredIds.has(s.id),
    );
    if (dones.length > 0) log(ctx, `◎ reverify: re-running gates for ${dones.length} done slice(s) on current HEAD…`);
    for (const s of dones) {
      if (opts.signal?.aborted) break;
      try {
        await reverifyDoneSlice(ctx, s);
      } catch (err) {
        log(ctx, `◎ reverify ${s.id} errored (${err instanceof Error ? err.message : String(err)}) — leaving done`);
      }
    }
  }
  if (faultsArmed(faults)) {
    log(ctx, `CHAOS ARMED (seed ${opts.seed ?? "random"}): ${faults.failVerify.length ? `fail-verify=${faults.failVerify.join("+")} ` : ""}${faults.abortAttempt ? `abort-attempt=${faults.abortAttempt} ` : ""}${faults.crashAfter !== undefined ? `crash-after=${faults.crashAfter}` : ""}`.trim());
  }
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
    reportDeferred({ projectDir: opts.projectDir, runId: opts.runId, onEvent: opts.onEvent });
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
    if (ctx.paused) return null;
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
  let settledTotal = 0;
  let unblockRounds = 0;
  const settle = (sliceId: string): void => {
    inflight.delete(sliceId);
    startedAt.delete(sliceId);
    trackers.delete(sliceId);
    settledTotal += 1;
  };
  // Operator control plane: drain queued intents (TUI keys, `ompo ctl`)
  // at this safe point — between claims, never mid-mutation. Slice effects
  // go through the conditional storeApi guards; jobs/pause install locally.
  const drainControls = (): void => {
    const { intents, offset } = drainIntents(opts.projectDir, opts.runId, ctx.controlOffset);
    ctx.controlOffset = offset;
    if (intents.length === 0) return;
    for (const intent of intents) {
      const res = applyIntent(opts.projectDir, opts.runId, intent, ctx);
      log(ctx, res.ok
        ? `⌁ control ${intent.kind}${intent.sliceId ? ` ${intent.sliceId}` : ""}: ${res.message}`
        : `⌁ control ${intent.kind}${intent.sliceId ? ` ${intent.sliceId}` : ""} rejected: ${res.message}`);
    }
    ctx.controlOffset = latestSeq(opts.projectDir, opts.runId);
  };
  for (;;) {
    drainControls();
    if (shouldCrashAfter(ctx.faults, settledTotal)) {
      // Injected crash: a real process death mid-run. The store is already
      // consistent (every boundary wrote through), so `ompo resume` rebuilds.
      log(ctx, `FAULT INJECTED: crash-after=${ctx.faults.crashAfter} — dying now (exit 137); resume to recover`);
      await new Promise((r) => setTimeout(r, 50));
      process.exit(137);
    }
    while (inflight.size < jobs.value) {
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
      if (ctx.paused) {
        // Paused with nothing in flight: never finish (pending work waits).
        // Sleep past the control poll so resume/jobs land promptly; an abort
        // during the nap still exits 2 on the next pass.
        await new Promise((r) => setTimeout(r, ctx.controlPollMs));
        continue;
      }
      // End-of-run unblock lane: about to stop with pre-deployment slices
      // blocked? Spend one bounded agent session doing this session's job —
      // diagnose, fix, prove green — then resume in-process. Deploy-only
      // remainders and spent budgets finish as before.
      const snapNow = loadRun(opts.projectDir, opts.runId).doc;
      const stalledNow = stallTargets(snapNow);
      if (!ctx.noUnblock && stalledNow.length > 0 && hasPredeployWork(snapNow)) {
        if (unblockRounds < ctx.maxUnblocks) {
          unblockRounds += 1;
          const lane = await runUnblocker(ctx, unblockRounds);
          if (lane === "aborted") {
            storeApi.abortRun(opts.projectDir, opts.runId);
            log(opts, "aborted by signal");
            const a = finish();
            return { ...a, exitCode: 2 };
          }
          if (lane === "continue") continue;
        } else {
          log(opts, `unblock budget spent (${unblockRounds} round(s)) — fix the rest, then \`ompo resume\``);
        }
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

    // Heartbeat + prompt abort + control poll: wake every heartbeatMs to
    // report elapsed in-flight slices, every controlPollMs to drain `ompo
    // ctl` intents (pause/jobs/kill must land in seconds, not minutes), or
    // immediately on abort.
    const tick = new Promise<"tick">((resolve) => {
      const t = setTimeout(() => resolve("tick"), ctx.heartbeatMs);
      t.unref?.();
    });
    const control = new Promise<"control">((resolve) => {
      const t = setTimeout(() => resolve("control"), ctx.controlPollMs);
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
      control,
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
