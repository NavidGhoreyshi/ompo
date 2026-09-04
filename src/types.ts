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
  /** Skip without running (explicit `Skip: true` trailer or --slice filter). */
  skip?: boolean;

  // ---- runtime (persisted in roadmap.json cursor) ----
  status: SliceStatus;
  attempts: number;
  reportRef?: string;
  verdictRef?: string;
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
  | "slice_done"
  | "slice_failed_terminal"
  | "slice_skipped"
  | "run_aborted"
  | "run_resumed"
  | "run_finished";

export interface RunEvent {
  seq: number;
  at: string;
  type: RunEventType;
  sliceId?: string;
  attempt?: number;
  detail?: string;
}

/** Strict completion report a worker must produce (plan §12). */
export interface CompletionReport {
  sliceId: string;
  summary: string;
  filesChanged: string[];
  testsRun: string[];
  testsPassed: boolean;
  verificationNotes: string;
  followUps: string[];
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
