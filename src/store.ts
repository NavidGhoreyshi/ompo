/**
 * Durable store (plan §13, M2).
 *
 * Layout (project-local, checkable):
 *   .omp/roadmap/
 *     runs/<runId>/
 *       roadmap.json      # { doc, nextSeq, runId, createdAt } (materialized cursor)
 *       events.jsonl      # append-only RunEvents (audit + replay)
 *       slices/<sliceId>/report.json | verdict.json | worker-<n>.log
 *         | secret-accept.json (operator-blessed scan findings, gate-read)
 *     runs/<runId>.lock   # exclusive run lock { pid, startedAt }
 *
 * Write discipline: events are appended (O_APPEND) BEFORE the cursor is
 * rewritten (tmp+rename), so a crash can only lose the cursor update — which
 * load() then rebuilds from the event log. Each step of the loop is a
 * separate store write (crash-safe at every boundary, plan §8).
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  crashedInFlight,
  resumeDemotes,
  type EventExtra,
  type RoadmapDoc,
  type RunEvent,
  type RunEventType,
  type Slice,
} from "./types.ts";

export const STORE_DIR = join(".omp", "roadmap");
export const RUNS_DIR = join(STORE_DIR, "runs");

export class StoreLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreLockedError";
  }
}

export interface RunCursor {
  runId: string;
  createdAt: string;
  updatedAt: string;
  nextSeq: number;
  doc: RoadmapDoc;
}

function runsDir(projectDir: string): string {
  return join(projectDir, RUNS_DIR);
}

export function runDir(projectDir: string, runId: string): string {
  return join(runsDir(projectDir), runId);
}

function lockPath(projectDir: string, runId: string): string {
  return join(runsDir(projectDir), `${runId}.lock`);
}

function cursorPath(projectDir: string, runId: string): string {
  return join(runDir(projectDir, runId), "roadmap.json");
}

function eventsPath(projectDir: string, runId: string): string {
  return join(runDir(projectDir, runId), "events.jsonl");
}

export function sliceDir(projectDir: string, runId: string, sliceId: string): string {
  return join(runDir(projectDir, runId), "slices", sliceId);
}

/** Atomic JSON write: tmp + rename. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Remove crashed `writeJsonAtomic` leftovers (`roadmap.json.<pid>.tmp`). Best-effort. */
function reapTmpFiles(projectDir: string, runId: string): void {
  let entries: string[];
  try {
    entries = readdirSync(runDir(projectDir, runId));
  } catch {
    return;
  }
  for (const e of entries) {
    if (/^roadmap\.json\.\d+\.tmp$/.test(e)) {
      try {
        rmSync(join(runDir(projectDir, runId), e), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function generateRunId(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

// ---- lock ----

export interface LockData {
  pid: number;
  startedAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire exclusive lock. Throws StoreLockedError when held by a live process. */
export function acquireLock(projectDir: string, runId: string, attempts = 5): void {
  mkdirSync(runsDir(projectDir), { recursive: true });
  reapTmpFiles(projectDir, runId);
  const path = lockPath(projectDir, runId);
  const data: LockData = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    const fd = openSync(path, "wx", 0o644);
    writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    closeSync(fd);
    return;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST") throw err;
  }
  // Lock exists: reclaim iff owner dead or heartbeat older than 10 min.
  // The `wx` create above serializes concurrent reclaimers: losers re-read
  // the winner's fresh lock below and back off with StoreLockedError.
  if (attempts <= 0) {
    throw new StoreLockedError(`run "${runId}" is locked (reclaim raced); retry \`ompo resume\``);
  }
  try {
    const prev = readJson<LockData>(path);
    const ageMs = Date.now() - Date.parse(prev.startedAt);
    if (!pidAlive(prev.pid) || ageMs > 10 * 60 * 1000) {
      rmSync(path, { force: true });
      return acquireLock(projectDir, runId, attempts - 1);
    }
    throw new StoreLockedError(
      `run "${runId}" is locked by live pid ${prev.pid} (started ${prev.startedAt}). Use --resume in the owning process or remove ${path} if stale.`,
    );
  } catch (err) {
    if (err instanceof StoreLockedError) throw err;
    // Unreadable lock: replace it.
    rmSync(path, { force: true });
    return acquireLock(projectDir, runId, attempts - 1);
  }
}

export function releaseLock(projectDir: string, runId: string): void {
  rmSync(lockPath(projectDir, runId), { force: true });
}

export function lockHeld(projectDir: string, runId: string): boolean {
  if (!existsSync(lockPath(projectDir, runId))) return false;
  try {
    const prev = readJson<LockData>(lockPath(projectDir, runId));
    return pidAlive(prev.pid);
  } catch {
    return true;
  }
}
/** Lock owner when the lock file parses, else null (absent or corrupt). */
export function lockOwner(projectDir: string, runId: string): LockData | null {
  try {
    return readJson<LockData>(lockPath(projectDir, runId));
  } catch {
    return null;
  }
}

// ---- runs ----

export function createRun(
  projectDir: string,
  doc: RoadmapDoc,
  runId = generateRunId(),
): RunCursor {
  const dir = runDir(projectDir, runId);
  mkdirSync(join(dir, "slices"), { recursive: true });
  const now = new Date().toISOString();
  const cursor: RunCursor = { runId, createdAt: now, updatedAt: now, nextSeq: 1, doc };
  writeJsonAtomic(cursorPath(projectDir, runId), cursor);
  writeFileSync(eventsPath(projectDir, runId), "", "utf8");
  appendEvent(projectDir, runId, "run_started", undefined, `sourceHash=${doc.sourceHash}`);
  return loadRun(projectDir, runId);
}

/** Creation time of a run, from its cursor; "" when the cursor is missing. */
function runCreatedAt(projectDir: string, runId: string): string {
  try {
    return readJson<{ createdAt?: string }>(cursorPath(projectDir, runId)).createdAt ?? "";
  } catch {
    return "";
  }
}

export function listRuns(projectDir: string): string[] {
  const dir = runsDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // Run ids are `YYYYMMDD-<random>` (see generateRunId), so lexical order is
    // NOT chronological. Every "latest run" default (watch/log/status/resume)
    // takes the last element, so sort by the cursor's createdAt — newest last.
    .sort(
      (a, b) =>
        runCreatedAt(projectDir, a).localeCompare(runCreatedAt(projectDir, b)) ||
        a.localeCompare(b),
    );
}

export function loadRun(projectDir: string, runId: string): RunCursor {
  const cursor = readJson<RunCursor>(cursorPath(projectDir, runId));
  if (cursor.doc.version !== 1) {
    throw new Error(`unsupported roadmap version ${cursor.doc.version}`);
  }
  return cursor;
}

/**
 * Replace the run's materialized cursor doc (replan --merge). The events log
 * is the audit trail — callers append a `roadmap_replanned` event alongside.
 * Refuses nothing itself; guards (lock, in-flight) live in the caller.
 */
export function saveRunDoc(projectDir: string, runId: string, doc: RoadmapDoc): RunCursor {
  const cursor = loadRun(projectDir, runId);
  cursor.doc = doc;
  cursor.updatedAt = new Date().toISOString();
  writeJsonAtomic(cursorPath(projectDir, runId), cursor);
  return cursor;
}

export function readEvents(projectDir: string, runId: string): RunEvent[] {
  const path = eventsPath(projectDir, runId);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return [];
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunEvent);
}

/** Append an event; returns the assigned event. */
export function appendEvent(
  projectDir: string,
  runId: string,
  type: RunEventType,
  sliceId?: string,
  detail?: string,
  attempt?: number,
): RunEvent {
  const cursor = loadRun(projectDir, runId);
  const ev: RunEvent = {
    seq: cursor.nextSeq,
    at: new Date().toISOString(),
    type,
    sliceId,
    attempt,
    detail,
  };
  appendFileSync(eventsPath(projectDir, runId), JSON.stringify(ev) + "\n", "utf8");
  cursor.nextSeq += 1;
  cursor.updatedAt = ev.at;
  writeJsonAtomic(cursorPath(projectDir, runId), cursor);
  return ev;
}

// Concurrency invariant: every mutation below is a synchronous read-modify-write
// (readJson → appendFileSync → writeJsonAtomic tmp+rename). A single Node
// process cannot interleave inside a sync block, so concurrent slice pipelines
// in one orchestrator are atomic by construction — provided callers keep
// selection and claim adjacent with no await between. Cross-process races are
// excluded by the run lock (one orchestrator per run). Claims stay conditional
// (pending-only) so a lost race surfaces as an error, never a double-run.
function mutateSlice(
  projectDir: string,
  runId: string,
  sliceId: string,
  type: RunEventType,
  fn: (s: Slice) => void,
  detail?: string,
  extra?: EventExtra,
): RunCursor {
  const cursor = loadRun(projectDir, runId);
  const slice = cursor.doc.slices.find((s) => s.id === sliceId);
  if (!slice) throw new Error(`unknown slice "${sliceId}"`);
  fn(slice);
  slice.updatedAt = new Date().toISOString();
  const ev: RunEvent = {
    seq: cursor.nextSeq,
    at: slice.updatedAt,
    type,
    sliceId,
    attempt: slice.attempts,
    detail,
    ...extra,
  };
  appendFileSync(eventsPath(projectDir, runId), JSON.stringify(ev) + "\n", "utf8");
  cursor.nextSeq += 1;
  cursor.updatedAt = ev.at;
  writeJsonAtomic(cursorPath(projectDir, runId), cursor);
  return cursor;
}

/** Operator-blessed secret-scan finding. The blessing pins the exact line
 * content hash at accept time — the gate re-checks it, so edited lines
 * re-fire while untouched blessed lines stay silent. */
export interface SecretAcceptance {
  /** Worktree/project-relative path. */
  file: string;
  /** 1-based line number at accept time. */
  line: number;
  /** Pattern class, e.g. "secret-assignment". No secret value, ever. */
  kind: string;
  /** sha256 of the trimmed line content when blessed. */
  lineHash: string;
  acceptedBy: string;
  acceptedAt: string;
  reason: string;
}

/** Blessed findings for a slice (missing file = none). Never throws. */
export function loadSecretAcceptances(projectDir: string, runId: string, sliceId: string): SecretAcceptance[] {
  try {
    const raw = readJson<{ findings?: SecretAcceptance[] }>(
      join(sliceDir(projectDir, runId, sliceId), "secret-accept.json"),
    );
    return Array.isArray(raw.findings) ? raw.findings : [];
  } catch {
    return [];
  }
}

export const storeApi = {
  /** Claim fence (plan §14): pending → running, attempts++. */
  claimSlice(projectDir: string, runId: string, sliceId: string): RunCursor {
    return mutateSlice(projectDir, runId, sliceId, "slice_claimed", (s) => {
      if (s.status !== "pending") {
        throw new Error(`cannot claim slice "${sliceId}" in status ${s.status}`);
      }
      s.status = "running";
      s.attempts += 1;
    });
  },
  workerFinished(
    projectDir: string,
    runId: string,
    sliceId: string,
    reportRef: string,
    extra?: EventExtra,
  ): RunCursor {
    return mutateSlice(
      projectDir,
      runId,
      sliceId,
      "worker_finished",
      (s) => {
        s.status = "verifying";
        s.reportRef = reportRef;
      },
      `report=${reportRef}`,
      extra,
    );
  },
  verifyPassed(projectDir: string, runId: string, sliceId: string, verdictRef: string, head?: string | null): RunCursor {
    let c = mutateSlice(
      projectDir,
      runId,
      sliceId,
      "verify_passed",
      (s) => {
        s.status = "done";
        s.verdictRef = verdictRef;
        if (head) s.verifiedHead = head;
      },
      `verdict=${verdictRef}`,
    );
    c = mutateSlice(projectDir, runId, sliceId, "slice_done", () => {});
    return c;
  },
  verifyFailed(
    projectDir: string,
    runId: string,
    sliceId: string,
    verdictRef: string,
    reason?: string,
    extra?: EventExtra,
  ): RunCursor {
    return mutateSlice(
      projectDir,
      runId,
      sliceId,
      "verify_failed",
      (s) => {
        s.status = "failed";
        s.verdictRef = verdictRef;
      },
      `verdict=${verdictRef}`,
      { ...extra, reason },
    );
  },
  retrySlice(projectDir: string, runId: string, sliceId: string, reason?: string): RunCursor {
    return mutateSlice(projectDir, runId, sliceId, "slice_retried", (s) => {
      s.status = "pending";
    }, reason);
  },
  /**
   * Context-cap handoff: a generation ended (cap abort or HANDOFF: report)
   * and the next generation respawns the same attempt. Status untouched
   * (still running) — no retry consumed, no failure recorded.
   */
  recordHandoff(
    projectDir: string,
    runId: string,
    sliceId: string,
    detail: string,
    extra?: EventExtra,
  ): RunCursor {
    return mutateSlice(projectDir, runId, sliceId, "slice_handoff", () => {}, detail, extra);
  },

  /**
   * Done-trust stamp: records which base HEAD a done slice was confirmed on
   * (merge journal, ancestry recheck, or --reverify gate pass). Status keeps
   * its value — the event log shows the audit trail, replay ignores it.
   */
  reverifySlice(projectDir: string, runId: string, sliceId: string, head: string, detail?: string): RunCursor {
    return mutateSlice(projectDir, runId, sliceId, "slice_reverified", (s) => {
      s.verifiedHead = head;
    }, detail ?? `head=${head}`);
  },
  terminalFail(
    projectDir: string,
    runId: string,
    sliceId: string,
    reason?: string,
    extra?: EventExtra,
  ): RunCursor {
    return mutateSlice(
      projectDir,
      runId,
      sliceId,
      "slice_failed_terminal",
      (s) => {
        s.status = "failed";
      },
      undefined,
      { ...extra, reason },
    );
  },
  /**
   * Operator retry-now: a terminal/blocked slice gets exactly one more
   * attempt. attempts keeps counting (artifact names never collide); the
   * budget grants one extra by raising maxRetries to the current attempts,
   * so the next failure terminals again unless the operator re-queues.
   */
  operatorRetry(projectDir: string, runId: string, sliceId: string, reason?: string): RunCursor {
    return mutateSlice(projectDir, runId, sliceId, "slice_retried", (s) => {
      if (s.status !== "failed" && s.status !== "blocked-env") {
        throw new Error(`cannot operator-retry slice "${sliceId}" in status ${s.status} (needs failed or blocked-env)`);
      }
      const wasBlockedEnv = s.status === "blocked-env";
      s.status = "pending";
      // Blocked slices never consumed budget — re-queue as-is. Failed slices
      // get exactly one more attempt (attempts keeps counting so attempt
      // artifacts never collide).
      if (!wasBlockedEnv && s.attempts > s.maxRetries) {
        s.maxRetries = s.attempts;
        s.maxRetriesExplicit = true;
      }
    }, reason ?? "operator retry");
  },

  /**
   * Operator park: a quiescent slice waits on the environment with an
   * operator-supplied reason (no retry consumed; resume re-queues).
   * In-flight slices need kill first, like skip.
   */
  parkSlice(projectDir: string, runId: string, sliceId: string, reason: string): RunCursor {
    return mutateSlice(projectDir, runId, sliceId, "slice_blocked_env", (s) => {
      if (s.status !== "pending" && s.status !== "failed") {
        throw new Error(`cannot park slice "${sliceId}" in status ${s.status} (kill it first if running)`);
      }
      mkdirSync(sliceDir(projectDir, runId, sliceId), { recursive: true });
      writeFileSync(join(sliceDir(projectDir, runId, sliceId), "control-park.md"), `# operator park\n${reason}\n`, "utf8");
      s.status = "blocked-env";
      s.verdictRef = join("slices", sliceId, "control-park.md");
    }, reason, { reason });
  },
  /**
   * Operator skip: quiescent slices (pending/failed/blocked-env) leave the
   * roadmap without running. Downstream proceeds past skips (depSatisfied).
   * In-flight slices need kill first — silently skipping running work would
   * strand the pipeline holding the worktree.
   */
  skipSlice(projectDir: string, runId: string, sliceId: string, reason?: string): RunCursor {
    return mutateSlice(projectDir, runId, sliceId, "slice_skipped", (s) => {
      if (s.status !== "pending" && s.status !== "failed" && s.status !== "blocked-env") {
        throw new Error(`cannot skip slice "${sliceId}" in status ${s.status} (kill it first if running)`);
      }
      s.status = "skipped";
    }, reason ?? "operator skip");
  },
  /**
   * Operator blesses secret-scan findings as reviewed false positives.
   * File-only effect read at gate time (no cursor status change), so it is
   * safe on live runs by construction — but the slice guard ensures no
   * in-flight gate is mid-scan for this slice. Retrying afterwards re-runs
   * verify; untouched blessed lines stay silent, edited lines re-fire.
   */
  acceptSecretFindings(
    projectDir: string,
    runId: string,
    sliceId: string,
    items: { file: string; line: number; kind: string; lineHash: string }[],
    reason: string,
  ): RunCursor {
    const by = process.env.USER ?? process.env.USERNAME ?? "operator";
    const at = new Date().toISOString();
    const list = items.map((i) => `${i.file}:${i.line} (${i.kind})`).join("; ");
    return mutateSlice(projectDir, runId, sliceId, "secret_accepted", (s) => {
      if (s.status !== "pending" && s.status !== "failed" && s.status !== "blocked-env") {
        throw new Error(`cannot accept secrets for slice "${sliceId}" in status ${s.status} (kill it first if running)`);
      }
      const dest = join(sliceDir(projectDir, runId, sliceId), "secret-accept.json");
      mkdirSync(sliceDir(projectDir, runId, sliceId), { recursive: true });
      const prev = loadSecretAcceptances(projectDir, runId, sliceId);
      for (const it of items) {
        if (!prev.some((m) => m.file === it.file && m.line === it.line && m.kind === it.kind)) {
          prev.push({ ...it, acceptedBy: by, acceptedAt: at, reason });
        }
      }
      writeJsonAtomic(dest, { version: 1, findings: prev });
    }, `accepted ${list} — ${reason}`);
  },
  /**
   * Operator kill: pending or in-flight work stops and parks as aborted
   * (resume re-queues it). The loop also watches for the kill at stage
   * boundaries and discards post-kill worker output. Terminal slices
   * (done/failed/skipped) are history — killing them is rejected.
   */
  killSlice(projectDir: string, runId: string, sliceId: string, reason?: string): RunCursor {
    return mutateSlice(projectDir, runId, sliceId, "slice_killed", (s) => {
      if (s.status !== "pending" && s.status !== "running" && s.status !== "verifying" && s.status !== "blocked-env") {
        throw new Error(`cannot kill slice "${sliceId}" in status ${s.status}`);
      }
      s.status = "aborted";
    }, reason ?? "operator kill");
  },
  /**
   * Environment triage: the gate failed on infrastructure (port taken, DB
   * down), not on the worker's code. No retry consumed; `resume` re-queues
   * the slice once the operator fixes the environment.
   */
  blockEnv(projectDir: string, runId: string, sliceId: string, verdictRef: string, reason: string): RunCursor {
    return mutateSlice(
      projectDir,
      runId,
      sliceId,
      "slice_blocked_env",
      (s) => {
        s.status = "blocked-env";
        s.verdictRef = verdictRef;
      },
      reason,
    );
  },
  abortSlice(projectDir: string, runId: string, sliceId: string): RunCursor {
    return mutateSlice(projectDir, runId, sliceId, "run_aborted", (s) => {
      if (!crashedInFlight(s.status)) {
        throw new Error(`cannot abort slice "${sliceId}" in status ${s.status}`);
      }
      s.status = "aborted";
    });
  },
  abortRun(projectDir: string, runId: string): RunEvent {
    return appendEvent(projectDir, runId, "run_aborted");
  },
  finishRun(projectDir: string, runId: string, detail?: string): RunEvent {
    return appendEvent(projectDir, runId, "run_finished", undefined, detail);
  },
  resumeRun(projectDir: string, runId: string): RunCursor {
    const cursor = loadRun(projectDir, runId);
    let demoted = 0;
    for (const s of cursor.doc.slices) {
      if (resumeDemotes(s.status)) {
        s.status = "pending";
        s.updatedAt = new Date().toISOString();
        demoted++;
      }
    }
    writeJsonAtomic(cursorPath(projectDir, runId), cursor);
    appendEvent(projectDir, runId, "run_resumed", undefined, `demoted=${demoted}`);
    return loadRun(projectDir, runId);
  },
};

/**
 * Rebuild expected statuses purely from the event log (crash-replay check).
 * Returns map sliceId → status. Terminal `failed` via slice_failed_terminal
 * stays failed; `verify_failed` is transient (may be followed by retry→pending).
 */
export function rebuildStatusesFromEvents(
  initial: RoadmapDoc,
  events: RunEvent[],
): Map<string, Slice["status"]> {
  const status = new Map<string, Slice["status"]>();
  for (const s of initial.slices) status.set(s.id, s.skip ? "skipped" : "pending");
  for (const ev of events) {
    if (!ev.sliceId) continue;
    switch (ev.type) {
      case "slice_claimed":
        status.set(ev.sliceId, "running");
        break;
      case "worker_finished":
        status.set(ev.sliceId, "verifying");
        break;
      case "verify_passed":
      case "slice_done":
        status.set(ev.sliceId, "done");
        break;
      case "verify_failed":
        status.set(ev.sliceId, "failed");
        break;
      case "slice_retried":
        status.set(ev.sliceId, "pending");
        break;
      case "slice_failed_terminal":
        status.set(ev.sliceId, "failed");
        break;
      case "slice_blocked_env":
        status.set(ev.sliceId, "blocked-env");
        break;
      case "slice_skipped":
        status.set(ev.sliceId, "skipped");
        break;
      case "slice_killed":
        status.set(ev.sliceId, "aborted");
        break;
      case "verify_passed":
      case "slice_done":
        status.set(ev.sliceId, "done");
        break;
      case "verify_failed":
        status.set(ev.sliceId, "failed");
        break;
      case "slice_retried":
        status.set(ev.sliceId, "pending");
        break;
      case "slice_failed_terminal":
        status.set(ev.sliceId, "failed");
        break;
      case "run_aborted":
        if (status.get(ev.sliceId) === "running" || status.get(ev.sliceId) === "verifying") {
          status.set(ev.sliceId, "aborted");
        }
        break;
      case "secret_accepted":
        // No status impact by design: the acceptance file carries the effect
        // at gate time; replay must reproduce cursor statuses exactly.
        break;
    }
  }
  return status;
}
