/**
 * Review lane — independent audit + minor-fix session (Sprint 4).
 *
 * Verbatim extraction from `loop.ts`: no behavior change. The review gate
 * (fresh reviewer session after merge) and the minor-fix lane (bounded fix +
 * re-verify + re-merge + one re-review inside the same attempt) live here so
 * the orchestration core stops accreting audit logic. Shared context and
 * outcome helpers come from `attempt.ts`; the loop keeps scheduling,
 * spawning, verify/merge, and recovery.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  failAttempt,
  formatProgressLine,
  formatTimeout,
  log,
  maxRetriesFor,
  preserveIncompleteWork,
  progressFn,
  summarize5,
  type AttemptCtx,
  usageFn,
} from "./attempt.ts";
import { DEFAULT_DEBUG_TIMEOUT_MS } from "./debug.ts";
import { extractReportFromOutput, validateCompletionReport } from "./report.ts";
import {
  buildReviewFixPrompt,
  buildReviewPrompt,
  extractReviewFromOutput,
  formatReviewFindings,
  validateReviewVerdict,
} from "./review.ts";
import { preMergeSecretGate } from "./secrets.ts";
import { loadRun, sliceDir, storeApi } from "./store.ts";
import type { CompletionReport, Slice } from "./types.ts";
import { runVerifiers } from "./verify.ts";
import {
  buildModelChain,
  displayModel,
  resolveWorkerModel,
  runWithModelFallbacks,
} from "./worker.ts";
import { sliceBranchOf } from "./worktree.ts";

/**
 * Independent review: fresh reviewer session audits the merged slice.
 * Returns true on approval. Rejection/invalid/timeout flow through the
 * standard retry-or-terminal path with findings saved for the next attempt.
 * Minor rejections earn one bounded fix session + re-verify + re-merge +
 * re-review inside the same attempt (`attemptFix`, one shot via a marker
 * file); anything else falls through like a major rejection.
 */
export async function runReview(
  ctx: AttemptCtx,
  sliceId: string,
  attempt: number,
  claimed: Slice,
  report: CompletionReport,
  verifyCommands: string[],
  wtPath: string,
  env?: Record<string, string>,
  attemptFix = true,
): Promise<boolean> {
  const { projectDir, runId } = ctx;
  const dir = sliceDir(projectDir, runId, sliceId);
  const reviewPrimary = ctx.reviewModel ?? ctx.roles.reviewer.model;
  // Review audits through the same fallback chain (no retry consumed on a
  // model outage — the audit just moves to the next model).
  const reviewChain = buildModelChain(reviewPrimary, ctx.cfg.modelFallbacks);
  // Review budgets like the worker that produced the slice: same chain, with
  // an explicit review override on top. The audit re-runs gate commands, so it
  // must not be capped tighter than the work it checks.
  const reviewBudgetMs = ctx.reviewTimeoutMs ?? ctx.timeoutMsOverride ?? claimed.timeoutMs
    ?? (ctx.cfg.workerTimeoutSec ? ctx.cfg.workerTimeoutSec * 1000 : undefined);
  log(ctx, `◈ review ${sliceId} — independent audit (attempt ${attempt})`);

  if (ctx.signal?.aborted) {
    storeApi.abortSlice(projectDir, runId, sliceId);
    return false;
  }

  const prompt = buildReviewPrompt(claimed, report, verifyCommands);
  writeFileSync(join(dir, `review-prompt-${attempt}.md`), prompt, "utf8");
  // Live transcript (worker parity): progress lines land in
  // review-{attempt}.log as they render so tails and the wedge watchdog stay
  // live mid-review. The completion footer below appends to this file.
  const progress = progressFn(ctx, sliceId, "review");
  const reviewLogPath = join(dir, `review-${attempt}.log`);
  try {
    writeFileSync(reviewLogPath, "", "utf8");
  } catch {
    /* transcript is observational */
  }
  const onProgress = (line: string) => {
    progress(line);
    try {
      appendFileSync(reviewLogPath, formatProgressLine(sliceId, "review", line) + "\n");
    } catch {
      /* transcript is observational */
    }
  };
  let reviewOut = "";
  let reviewStdout = "";
  try {
    const res = await runWithModelFallbacks(
      ctx.reviewer,
      { prompt, sliceId, attempt, label: `${sliceId} review` },
      { projectDir, timeoutMs: reviewBudgetMs, signal: ctx.signal, sessionDir: dir, onProgress, onUsage: usageFn(ctx, sliceId, "review"), env },
      reviewChain,
      {
        accept: (stdout) => extractReviewFromOutput(stdout) !== undefined,
        onModelAttempt: (model, i) => {
          const where = i === 0 ? `budget: ${formatTimeout(reviewBudgetMs)}` : `fallback ${i + 1}/${reviewChain.length} (no retry consumed)`;
          log(ctx, `  model: ${displayModel(model)} ${where}`);
        },
        onFallback: (from, to) => {
          log(ctx, `  model ${displayModel(from)} unavailable — falling back to ${displayModel(to)} (no retry consumed)`);
        },
      },
    );
    if (res.fellBack) {
      writeFileSync(join(dir, `review-${attempt}.models.json`), JSON.stringify({ tried: res.tried, accepted: displayModel(res.model) }, null, 2) + "\n", "utf8");
    }
    reviewStdout = res.stdout;
    reviewOut = `exit=${res.exit} timedOut=${res.timedOut} durationMs=${res.durationMs}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`;
    appendFileSync(reviewLogPath, reviewOut, "utf8");
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
    appendFileSync(join(dir, `review-${attempt}.log`), reviewOut + `\nREVIEW ERROR: ${msg}\n`, "utf8");
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
    if (!verdict.approved) {
      // Minor lane: the shape is right, only polish is missing. One bounded
      // fix session + re-verify + re-merge + re-review inside this attempt
      // (marker file bounds it to one shot); a major rejection, a disabled
      // debugger lane, or a second minor all spend budget like any failure.
      if (verdict.severity === "minor" && attemptFix && !ctx.noDebug && !existsSync(join(dir, `review-minor-${attempt}.applied`))) {
        writeFileSync(join(dir, `review-${attempt}.rejected.json`), JSON.stringify(verdict, null, 2) + "\n", "utf8");
        const lane = await runReviewFix(ctx, sliceId, attempt, claimed, verdict, verifyCommands, wtPath, env);
        if (lane === "approved") return true;
        if (lane === "settled") return false;
      }
      throw new Error(`reviewer rejected (${verdict.severity}): ${verdict.findings.join("; ").slice(0, 300)}`);
    }
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
    // Normalize via formatReviewFindings so structured {file, behavior, spec}
    // objects still render as readable lines instead of [object Object].
    try {
      const notes = extracted !== undefined
        ? (extracted as { findings?: unknown; notes?: unknown })
        : null;
      const findings = formatReviewFindings(notes?.findings) ?? [];
      const reviewerNotes = typeof notes?.notes === "string" && notes.notes.trim() ? notes.notes.trim() : "";
      const lines = [
        ...findings.map((f) => `- ${f}`),
        reviewerNotes ? `\nReviewer notes: ${reviewerNotes}` : "",
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
 * Minor-fix lane: one bounded fresh worker addresses ONLY the reviewer's
 * polish findings in the slice worktree, then the gate re-runs and the
 * branch re-merges under the commit mutex, then exactly one re-review
 * decides. Outcomes: "approved" (done — the caller returns true),
 * "settled" (the outcome is already recorded: abort, kill, or a terminal
 * merge conflict — the caller returns false WITHOUT spending budget), or
 * "retry" (nothing conclusive — the caller falls through to the standard
 * retry-or-terminal path, which records it). One shot per attempt via the
 * `review-minor-<attempt>.applied` marker; never recursive (the re-review
 * runs with attemptFix=false); never consumes a retry itself.
 */
export async function runReviewFix(
  ctx: AttemptCtx,
  sliceId: string,
  attempt: number,
  claimed: Slice,
  verdict: { findings: string[] },
  verifyCommands: string[],
  wtPath: string,
  env?: Record<string, string>,
): Promise<"approved" | "settled" | "retry"> {
  const { projectDir, runId } = ctx;
  const dir = sliceDir(projectDir, runId, sliceId);
  // Bounded minor-fix lane: the fast slot owns polish (the worker role),
  // with per-slice Agent: routing still layered on top.
  const fixPrimary = resolveWorkerModel(claimed.workerAgent, { workerModel: ctx.roles.worker.model, agentModels: ctx.cfg.agentModels })
    ?? ctx.roles.worker.model;
  const fixChain = buildModelChain(fixPrimary, ctx.cfg.modelFallbacks);
  const fixBudgetMs = ctx.debugTimeoutMs ?? DEFAULT_DEBUG_TIMEOUT_MS;
  log(ctx, `  review-fix ${sliceId} — minor polish session (attempt ${attempt}, budget ${formatTimeout(fixBudgetMs)})`);

  if (ctx.signal?.aborted) {
    storeApi.abortSlice(projectDir, runId, sliceId);
    return "settled";
  }

  const prompt = buildReviewFixPrompt(claimed, verdict.findings, attempt);
  writeFileSync(join(dir, `review-fix-prompt-${attempt}.md`), prompt, "utf8");
  // Live transcript (review parity): same worker-parity streaming so the
  // wedge watchdog stays live through bounded fix sessions.
  const fixProgress = progressFn(ctx, sliceId, "review-fix");
  const fixLogPath = join(dir, `review-fix-${attempt}.log`);
  try {
    writeFileSync(fixLogPath, "", "utf8");
  } catch {
    /* transcript is observational */
  }
  const onProgress = (line: string) => {
    fixProgress(line);
    try {
      appendFileSync(fixLogPath, formatProgressLine(sliceId, "review-fix", line) + "\n");
    } catch {
      /* transcript is observational */
    }
  };
  let fixStdout = "";
  try {
    const res = await runWithModelFallbacks(
      ctx.runner,
      { prompt, sliceId, attempt, label: `${sliceId} review-fix` },
      { projectDir: wtPath, timeoutMs: fixBudgetMs, signal: ctx.signal, sessionDir: dir, onProgress, onUsage: usageFn(ctx, sliceId, "review-fix"), env },
      fixChain,
      {
        accept: (stdout) => extractReportFromOutput(stdout) !== undefined,
        preserve: () => preserveIncompleteWork(ctx, sliceId, attempt, "review-fix model unavailable, falling back"),
        onModelAttempt: (model, i) => {
          if (i > 0) log(ctx, `  review-fix model: ${displayModel(model)} (fallback ${i + 1}/${fixChain.length}, no retry consumed)`);
        },
        onFallback: (from, to) => {
          log(ctx, `  review-fix model ${displayModel(from)} unavailable — falling back to ${displayModel(to)} (no retry consumed)`);
        },
      },
    );
    if (res.fellBack) {
      writeFileSync(join(dir, `review-fix-${attempt}.models.json`), JSON.stringify({ tried: res.tried, accepted: displayModel(res.model) }, null, 2) + "\n", "utf8");
    }
    fixStdout = res.stdout;
    appendFileSync(fixLogPath, `exit=${res.exit} timedOut=${res.timedOut} durationMs=${res.durationMs}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`, "utf8");
    if (res.eventsJsonl) {
      try {
        writeFileSync(join(dir, `review-fix-${attempt}.events.jsonl`), res.eventsJsonl, "utf8");
      } catch {
        /* forensics are best-effort */
      }
    }
    if (ctx.signal?.aborted) {
      preserveIncompleteWork(ctx, sliceId, attempt, "abort");
      storeApi.abortSlice(projectDir, runId, sliceId);
      return "settled";
    }
    if (res.timedOut) {
      preserveIncompleteWork(ctx, sliceId, attempt, "review-fix timeout");
      log(ctx, summarize5(claimed, `review-fix timed out (no retry consumed)`));
      return "retry";
    }
    if (res.exit !== 0 && extractReportFromOutput(res.stdout) === undefined) {
      throw new Error(`review-fix exited ${res.exit} with no report`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(ctx, summarize5(claimed, `review-fix failure: ${msg} (no retry consumed)`));
    return "retry";
  }

  const extracted = extractReportFromOutput(fixStdout);
  try {
    if (extracted === undefined) throw new Error("no <<<OMPO_REPORT>>> block in review-fix output");
    const freport = validateCompletionReport(extracted, sliceId);
    if (!freport.done) throw new Error(`review-fix gave up: ${freport.verificationNotes.slice(0, 300)}`);
  } catch (err) {
    log(ctx, summarize5(claimed, `review-fix inconclusive: ${err instanceof Error ? err.message : String(err)} (falling back to retry budget)`));
    return "retry";
  }
  writeFileSync(join(dir, `review-minor-${attempt}.applied`), JSON.stringify({ at: new Date().toISOString(), findings: verdict.findings.length }, null, 2) + "\n", "utf8");

  // A kill that landed during the fix session drops out before re-verify.
  try {
    if (loadRun(projectDir, runId).doc.slices.find((s) => s.id === sliceId)?.status === "aborted") {
      preserveIncompleteWork(ctx, sliceId, attempt, "operator kill");
      log(ctx, summarize5(claimed, `killed by operator — review-fix output discarded (no retry consumed)`));
      return "settled";
    }
  } catch {
    /* store unreadable — proceed; the gate below will surface it */
  }

  // Re-verify + re-merge under the commit mutex (same order guarantee as
  // the first pass), then exactly one re-review with the lane closed.
  const release = await ctx.commit.acquire();
  try {
    log(ctx, `  review-fix: re-running ${verifyCommands.length} gate(s) in ${wtPath}`);
    const verdict2 = await runVerifiers(sliceId, attempt, verifyCommands, join(dir, "logs"), {
      projectDir: wtPath,
      onProgress: progressFn(ctx, sliceId, "review-fix"),
      env,
    });
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict2, null, 2) + "\n", "utf8");
    if (!verdict2.pass) {
      const reason = `review-fix gate still red: ${verdict2.steps.filter((s) => s.exit !== 0).map((s) => s.command).join("; ").slice(0, 300)}`;
      log(ctx, summarize5(claimed, `${reason} (falling back to retry budget)`));
      return "retry";
    }
    // Same pre-merge secret gate as the first pass: the fix session's edits
    // merge too, so they scan too. Refusal is already recorded
    // (verify_failed + retry-or-terminal), so report "settled", not "retry".
    let fixReport: CompletionReport | undefined;
    try {
      fixReport = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as CompletionReport;
    } catch {
      /* fallback to declared Files: only */
    }
    if (!preMergeSecretGate({
      projectDir, runId, slice: claimed, attempt, dir, wtPath,
      branch: sliceBranchOf(runId, sliceId), verdict: verdict2, report: fixReport,
      maxRetries: maxRetriesFor(claimed, ctx), log: (m: string) => log(ctx, m),
    })) {
      return "settled";
    }
    const m = ctx.wt.merge(projectDir, runId, sliceId, attempt);
    if (!m.merged) {
      const conflictFile = join("slices", sliceId, `merge-${attempt}.conflict.txt`);
      writeFileSync(join(dir, `merge-${attempt}.conflict.txt`), m.detail, "utf8");
      storeApi.verifyFailed(projectDir, runId, sliceId, conflictFile, "merge_conflict");
      storeApi.terminalFail(projectDir, runId, sliceId, "merge_conflict");
      log(ctx, summarize5(claimed, `review-fix merge conflict — terminal. ${m.detail}`, undefined, true));
      return "settled";
    }
    log(ctx, `  review-fix merged (${m.detail}) — one re-review decides`);
  } finally {
    release();
  }

  // Exact report objects are internal to runAttempt; re-read the current
  // one from disk (the fix session never rewrites report.json).
  const rereport: CompletionReport = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as CompletionReport;
  const reapproved = await runReview(ctx, sliceId, attempt, claimed, rereport, verifyCommands, wtPath, env, false);
  return reapproved ? "approved" : "settled";
}
