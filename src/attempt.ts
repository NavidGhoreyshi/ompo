/**
 * Attempt kernel — shared lifecycle context + small outcome helpers (Sprint 4).
 *
 * Verbatim extraction from `loop.ts`: no behavior change. The orchestrator
 * loop, the review lane (`reviewLane.ts`), and future lifecycle stages share
 * this context instead of growing the central file. Dependency direction:
 * `attempt.ts` ← `reviewLane.ts` ← `loop.ts` (no cycles).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoadmapConfig } from "./config.ts";
import type { FaultSpec } from "./faults.ts";
import type { Mutex } from "./mutex.ts";
import { sliceDir, storeApi } from "./store.ts";
import type { CompletionReport, Slice } from "./types.ts";
import type { TokenUsage, WorkerRunner } from "./worker.ts";
import type { WorktreeOps } from "./worktree.ts";

export interface AttemptCtx {
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
  noUnblock: boolean;
  maxUnblocks: number;
  /** Context-cap handoff disabled (`--no-handoff`): HANDOFF reports fail normally, no cap aborts. */
  noHandoff: boolean;
  /**
   * Per-session token cap before handoff to a fresh generation
   * (CLI > roadmap.yml contextCapTokens > default 120000; 0 disables).
   */
  contextCapTokens: number;
  maxRetriesOverride?: number;
  timeoutMsOverride?: number;
  signal?: AbortSignal;
  onEvent?: (msg: string) => void;
  heartbeatMs: number;
  /** Live operator controls: jobs holder (set-jobs scales the claim loop). */
  jobs: { value: number };
  /** Claim loop paused (pause intent): in-flight finish, nothing new claims. */
  paused: boolean;
  /** Chaos faults + seeded RNG (abort draws). Inactive unless armed. */
  faults: FaultSpec;
  rng: () => number;
  controlOffset: number;
  controlPollMs: number;
  /** Shared live-progress state per in-flight slice (for heartbeat detail). */
  trackers: Map<string, ProgressTracker>;
}

/** Default per-session tokens before a context-cap handoff (overridden by CLI/yml). */
export const DEFAULT_CONTEXT_CAP_TOKENS = 120_000;

export function log(opts: { onEvent?: (msg: string) => void }, msg: string): void {
  (opts.onEvent ?? ((m) => console.log(m)))(msg);
}

/** Live-progress counters for one in-flight attempt (heartbeat + summaries). */
export interface ProgressTracker {
  turns: number;
  tools: number;
  lines: number;
  lastLine: string;
  lastAt: number;
  /** Latest cumulative per-session token usage (headless usage envelopes only). */
  tokens?: TokenUsage;
  /** Last total a `tok` bus line was logged for (throttle — in-memory only). */
  tokensLogged?: number;
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

/** Render one worker progress line exactly as the TUI/activity bus shows it. Pure. */
export function formatProgressLine(sliceId: string, tag: string | undefined, line: string): string {
  const prefix = tag ? `  [${sliceId} ${tag}]` : `  [${sliceId}]`;
  return `${prefix} ${line}`;
}

/** Build an onProgress sink that logs prefixed lines and feeds the heartbeat. */
export function progressFn(ctx: AttemptCtx, sliceId: string, tag?: string): (line: string) => void {
  return (line) => {
    let t = ctx.trackers.get(sliceId);
    if (!t) {
      t = newProgressTracker();
      ctx.trackers.set(sliceId, t);
    }
    noteProgress(t, line);
    log(ctx, formatProgressLine(sliceId, tag, line));
  };
}

/**
 * Build an onUsage sink that records the latest cumulative token usage on
 * the slice tracker (the context-cap check reads it every event) and logs a
 * throttled `tok in=X out=Y` bus line — first sighting plus each 1k-total
 * crossing — so agent rows and the activity bus stay fresh without a line
 * per message. The tag mirrors progressFn so the line lands on the right row.
 */
export function usageFn(ctx: AttemptCtx, sliceId: string, tag?: string): (u: TokenUsage) => void {
  return (u) => {
    let t = ctx.trackers.get(sliceId);
    if (!t) {
      t = newProgressTracker();
      ctx.trackers.set(sliceId, t);
    }
    t.tokens = u;
    const last = t.tokensLogged;
    if (last === undefined || Math.floor(u.total / 1000) > Math.floor(last / 1000)) {
      t.tokensLogged = u.total;
      log(ctx, formatProgressLine(sliceId, tag, `tok in=${u.input} out=${u.output} total=${u.total}`));
    }
  };
}

export function formatTimeout(ms: number | undefined): string {
  if (ms === undefined) return "default";
  const m = Math.round(ms / 60000);
  return m >= 1 ? `${m}m` : `${Math.round(ms / 1000)}s`;
}

export function depSummaries(projectDir: string, runId: string, slice: Slice): Map<string, string> {
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

export function maxRetriesFor(slice: Slice, opts: { maxRetriesOverride?: number; cfg?: { maxRetries?: number } }): number {
  // Precedence: CLI flag > explicit `Retries:` trailer > yml default > parser default.
  if (opts.maxRetriesOverride !== undefined) return opts.maxRetriesOverride;
  if (slice.maxRetriesExplicit) return slice.maxRetries;
  return opts.cfg?.maxRetries ?? slice.maxRetries;
}

export function summarize5(
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
export function classifyFailure(ref: string): string {
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
export function failAttempt(
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

/** Best-effort: commit in-flight work to the slice branch so retries/resume keep it. */
export function preserveIncompleteWork(ctx: AttemptCtx, sliceId: string, attempt: number, reason: string): void {
  try {
    const c = ctx.wt.commitWork(ctx.projectDir, ctx.runId, sliceId, attempt, `incomplete: ${reason}`);
    log(ctx, `  preserved incomplete work: ${c.detail}`);
  } catch (err) {
    log(ctx, `  work-preservation warning: ${err instanceof Error ? err.message : String(err)}`);
  }
}
