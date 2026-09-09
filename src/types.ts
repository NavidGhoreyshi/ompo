/**
 * Roadmap model — frozen since M1 (plan §5, §6).
 * Changes after M2 require updating store tests (plan M1 gate).
 */

/** Slice lifecycle states (plan §6). */
export type SliceStatus =
  | "pending"
  | "running"
  | "verifying"
  | "done"
  | "failed"
  | "aborted"
  | "blocked"
  | "blocked-env"
  | "skipped";

export const TERMINAL_STATUSES: ReadonlySet<SliceStatus> = new Set([
  "done",
  "failed",
  "skipped",
]);

export type Effort = "lo" | "med" | "hi";

export interface Slice {
  /** Stable id: explicit `[id]` in heading, else slug of title. */
  id: string;
  title: string;
  /** Markdown body (heading line + trailers excluded). */
  body: string;
  /** Ids of slices that must be `done` first. */
  deps: string[];
  /** Worker agent/model selector, e.g. "task", "sonic", or a model pattern. */
  workerAgent?: string;
  effort?: Effort;
  /** Shell commands run by the verifier after the worker finishes. */
  verify: string[];
  /** File allowlist declared by the slice (advisory for spec-builder). */
  files: string[];
  maxRetries: number;
  /** True when `Retries:` was set on the slice (beats the yml default). */
  maxRetriesExplicit?: boolean;
  /** Per-slice worker budget in ms (`Timeout:` trailer). */
  timeoutMs?: number;
  /** Skip without running (explicit `Skip: true` trailer or --slice filter). */
  skip?: boolean;

  // ---- runtime (persisted in roadmap.json cursor) ----
  status: SliceStatus;
  attempts: number;
  reportRef?: string;
  verdictRef?: string;
  /** Base HEAD the slice was merged + verified on (crash-trust anchor). */
  verifiedHead?: string;
  updatedAt: string;
}

export interface RoadmapDoc {
  version: 1;
  /** sha256 of the source markdown at parse time (drift detection). */
  sourceHash: string;
  slices: Slice[];
}

export type RunEventType =
  | "run_started"
  | "slice_claimed"
  | "worker_finished"
  | "verify_passed"
  | "verify_failed"
  | "slice_retried"
  | "slice_handoff"
  | "slice_done"
  | "slice_reverified"
  | "slice_failed_terminal"
  | "slice_blocked_env"
  | "slice_skipped"
  | "slice_killed"
  | "run_aborted"
  | "run_resumed"
  | "run_finished"
  | "control_requested"
  | "control_applied"
  | "control_rejected"
  | "roadmap_replanned";

export interface RunEvent {
  seq: number;
  at: string;
  type: RunEventType;
  sliceId?: string;
  attempt?: number;
  detail?: string;
  // ---- enrichment (all optional; runs recorded before these fields land
  // render the missing columns as "-", never break readers) ----
  /** Short machine-readable failure class, e.g. report_missing | worker_timeout | merge_conflict. */
  reason?: string;
  /** Process exit code (null/absent when killed or timed out). */
  exit?: number | null;
  timedOut?: boolean;
  /** Wall-clock duration of the underlying process (worker/gate). */
  durationMs?: number;
  /** Agent session counters (worker_finished only; best-effort). */
  stats?: { turns: number; tools: number };
}

/** Enrichment fields a store mutation may attach to the event it appends. */
export type EventExtra = Partial<Pick<RunEvent, "reason" | "exit" | "timedOut" | "durationMs" | "stats">>;

/** Strict completion report a worker must produce (plan §12). */
export interface CompletionReport {
  sliceId: string;
  summary: string;
  filesChanged: string[];
  testsRun: string[];
  testsPassed: boolean;
  verificationNotes: string;
  followUps: string[];
  /**
   * Never-block rule: live-only items the worker could not prove because
   * they need operator-supplied real values (secrets, accounts, phone
   * steps, domains, approvals). Missing live values must NEVER yield
   * done=false — the worker defers them here and the run aggregates them
   * into deferred.md for the post-run manual pass.
   */
  deferred: string[];
  done: boolean;
}

export interface VerdictStep {
  name: string;
  command: string;
  exit: number | null;
  timedOut: boolean;
  /** Tail of combined output (capped). Full log lives on disk. */
  outputTail: string;
  logRef: string;
}

export interface Verdict {
  sliceId: string;
  attempt: number;
  pass: boolean;
  steps: VerdictStep[];
  at: string;
}

export function terminalStatus(s: SliceStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

/** Sentinel: crash-recovery demotes these back to pending (plan §14). */
export function crashedInFlight(s: SliceStatus): boolean {
  return s === "running" || s === "verifying" || s === "aborted";
}

/**
 * Sentinel: `resume` re-queues these as pending. In-flight crash states plus
 * `blocked-env` (operator was asked to fix the environment and re-run).
 */
export function resumeDemotes(s: SliceStatus): boolean {
  return crashedInFlight(s) || s === "blocked-env";
}
