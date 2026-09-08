/**
 * Operator control plane: in-run intents (retry-now, skip, park, kill,
 * set-jobs, pause, resume) travel as `control_requested` events in the same
 * append-only events.jsonl the loop already replays, so they work
 * cross-process (TUI keys, `ompo ctl` from another shell, headless runs)
 * through one uniform path: request → drain at scheduler safe points →
 * store mutation + `control_applied` (or `control_rejected` with a reason).
 *
 * No new files, no sockets: the event log is the queue, the loop's seq
 * cursor is the consumer offset. Idempotency comes free — a twice-applied
 * intent fails its status guard the second time and records a rejection.
 */

import { appendEvent, loadRun, readEvents, storeApi } from "./store.ts";
import type { RunEvent } from "./types.ts";

/** Operator intent kinds. Slice-scoped except set-jobs/pause/resume. */
export type ControlKind = "retry" | "skip" | "park" | "kill" | "set-jobs" | "pause" | "resume";

export interface ControlIntent {
  kind: ControlKind;
  /** Target slice (retry/skip/park/kill). */
  sliceId?: string;
  /** set-jobs value. */
  jobs?: number;
  /** Operator-supplied reason (park reason, audit note). */
  reason?: string;
}

export interface DrainedIntent extends ControlIntent {
  seq: number;
  at: string;
}

const KINDS: Record<string, true> = {
  retry: true,
  skip: true,
  park: true,
  kill: true,
  "set-jobs": true,
  pause: true,
  resume: true,
};

/** Validate a raw intent (pure — CLI and TUI share it). Returns an error string or null. */
export function validateIntent(intent: ControlIntent): string | null {
  if (!intent || !KINDS[intent.kind]) return `unknown control kind ${JSON.stringify(intent?.kind)} (want retry|skip|park|kill|set-jobs|pause|resume)`;
  const needsSlice = intent.kind === "retry" || intent.kind === "skip" || intent.kind === "park" || intent.kind === "kill";
  if (needsSlice && !intent.sliceId?.trim()) return `${intent.kind} needs a slice id`;
  if (!needsSlice && intent.sliceId) return `${intent.kind} takes no slice id`;
  if (intent.kind === "set-jobs") {
    if (!Number.isInteger(intent.jobs) || intent.jobs! < 1 || intent.jobs! > 32) {
      return `set-jobs needs an integer jobs 1..32 (got ${JSON.stringify(intent.jobs)})`;
    }
  }
  if (intent.kind === "park" && !intent.reason?.trim()) return "park needs a reason (what to fix before resume)";
  return null;
}

/** Queue an intent on the run's event log. Throws on invalid intents. */
export function requestControl(projectDir: string, runId: string, intent: ControlIntent): RunEvent {
  const bad = validateIntent(intent);
  if (bad) throw new Error(bad);
  // Unknown-slice check now (cheap) so typos fail at request time, not drain time.
  if (intent.sliceId) {
    const doc = loadRun(projectDir, runId).doc;
    if (!doc.slices.some((s) => s.id === intent.sliceId)) throw new Error(`unknown slice "${intent.sliceId}"`);
  }
  return appendEvent(projectDir, runId, "control_requested", intent.sliceId, JSON.stringify(intent));
}

/** Parse one control_requested event's payload. Undefined when malformed. */
export function parseIntentPayload(ev: RunEvent): ControlIntent | undefined {
  if (ev.type !== "control_requested" || !ev.detail) return undefined;
  try {
    const raw = JSON.parse(ev.detail) as Partial<ControlIntent>;
    const intent: ControlIntent = { kind: raw.kind as ControlKind, sliceId: raw.sliceId, jobs: raw.jobs, reason: raw.reason };
    return validateIntent(intent) ? undefined : intent;
  } catch {
    return undefined;
  }
}

/** Highest event seq in the run (a fresh loop starts draining after this). */
export function latestSeq(projectDir: string, runId: string): number {
  let max = -1;
  for (const ev of readEvents(projectDir, runId)) if (ev.seq > max) max = ev.seq;
  return max;
}

/** Intents queued after `afterSeq`, plus the new consumer offset (max seq seen). */
export function drainIntents(projectDir: string, runId: string, afterSeq: number): { intents: DrainedIntent[]; offset: number } {
  const intents: DrainedIntent[] = [];
  let offset = afterSeq;
  for (const ev of readEvents(projectDir, runId)) {
    if (ev.seq > offset) offset = ev.seq;
    if (ev.type !== "control_requested" || ev.seq <= afterSeq) continue;
    const intent = parseIntentPayload(ev);
    if (intent) intents.push({ ...intent, seq: ev.seq, at: ev.at });
  }
  return { intents, offset };
}

export interface AppliedOutcome {
  intent: DrainedIntent;
  ok: boolean;
  message: string;
}

/**
 * Apply one drained intent to the store. Slice mutations go through the
 * conditional storeApi guards (a stale intent surfaces as a rejection, never
 * a double-run). Loop-local effects (set-jobs/pause/resume) report back for
 * the caller to install. Every outcome appends control_applied/rejected, so
 * `ompo log` shows the full operator audit.
 */
export function applyIntent(
  projectDir: string,
  runId: string,
  intent: DrainedIntent,
  loop: { jobs: { value: number }; paused: boolean },
): AppliedOutcome {
  const done = (ok: boolean, message: string): AppliedOutcome => {
    appendEvent(projectDir, runId, ok ? "control_applied" : "control_rejected", intent.sliceId, `${intent.kind}: ${message}`);
    return { intent, ok, message };
  };
  try {
    switch (intent.kind) {
      case "retry":
        storeApi.operatorRetry(projectDir, runId, intent.sliceId!, intent.reason);
        return done(true, `${intent.sliceId} re-queued with one more attempt`);
      case "skip":
        storeApi.skipSlice(projectDir, runId, intent.sliceId!, intent.reason);
        return done(true, `${intent.sliceId} skipped`);
      case "park":
        storeApi.parkSlice(projectDir, runId, intent.sliceId!, intent.reason!);
        return done(true, `${intent.sliceId} parked: ${intent.reason}`);
      case "kill": {
        const cur = loadRun(projectDir, runId).doc.slices.find((s) => s.id === intent.sliceId)!;
        const inflight = cur.status === "running" || cur.status === "verifying";
        storeApi.killSlice(projectDir, runId, intent.sliceId!, intent.reason);
        return done(true, inflight ? `${intent.sliceId} killed — pipeline drops it at the next stage boundary` : `${intent.sliceId} killed while pending`);
      }
      case "set-jobs":
        loop.jobs.value = intent.jobs!;
        return done(true, `jobs now ${intent.jobs}`);
      case "pause":
        loop.paused = true;
        return done(true, "claim loop paused — in-flight slices finish, nothing new claims");
      case "resume":
        loop.paused = false;
        return done(true, "claim loop resumed");
    }
  } catch (err) {
    return done(false, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Queue an intent from a live surface (TUI key, `ompo ctl`) with immediate
 * feedback on the same sink the loop's applied/rejected lines land on. The
 * loop drains within ~controlPollMs; request-time throws (bad shape, unknown
 * slice) report instantly instead of silently vanishing.
 */
export function queueControl(push: (m: string) => void, projectDir: string, runId: string, intent: ControlIntent): void {
  try {
    requestControl(projectDir, runId, intent);
    push(`⌁ control ${intent.kind}${intent.sliceId ? ` ${intent.sliceId}` : ""} queued — loop applies within ~2s`);
  } catch (err) {
    push(`⌁ control ${intent.kind} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
