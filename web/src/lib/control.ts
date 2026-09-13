/**
 * Control-intent semantics shared by the dashboard's `ControlPanel` and the
 * deck's action bar (roadmap slice `d08`) — pure.
 *
 * "The deck does exactly what the dashboard does" has to be true by
 * construction, not by two implementations agreeing today: one module builds
 * every `ControlIntent` body, names the actions that must be confirmed, states
 * the reasons a run action is withheld, renders the 202/200 response as view
 * state, and correlates a queued intent with its orchestrator outcome. The two
 * surfaces are renderings of these rules; a divergence is a change here.
 *
 * The bodies are `ompo ctl`'s own contract (arch §5): no control surface may
 * invent a kind, a field or a default. `reason` is trimmed and omitted when
 * empty, exactly as the panel has always sent it.
 *
 * Pure module: no DOM, no `three`, no fetching.
 */

import type { ControlIntent, ControlKind, ControlQueued, ResumeResult, RunEvent } from "../api.ts";

/** Slice-scoped kinds, in the order both surfaces render them. */
export type SliceKind = "retry" | "skip" | "park" | "kill";
/** Run-scoped kinds the deck offers directly. */
export type RunKind = "pause" | "resume";

/** The slice actions, with their operator-facing words — one list, two skins. */
export const SLICE_ACTIONS: readonly { kind: SliceKind; label: string; hint: string }[] = [
  { kind: "retry", label: "Retry", hint: "re-queue the slice with one more attempt" },
  { kind: "skip", label: "Skip", hint: "mark skipped — needs confirmation" },
  { kind: "park", label: "Park", hint: "park with a reason (required)" },
  { kind: "kill", label: "Kill", hint: "kill the slice — needs confirmation" },
];

/** Destructive slice actions arm an inline confirm before the same API call. */
export const DESTRUCTIVE: Readonly<Record<SliceKind, boolean>> = { retry: false, skip: true, park: false, kill: true };

/** `set-jobs` bounds: the server's validator (`src/control.ts`) is the authority. */
export const JOBS_MIN = 1;
export const JOBS_MAX = 32;

/**
 * Kinds a quiescent run cannot serve: they act on the loop's own memory, and
 * the server rejects them before appending (`quiescentLoopLocalRejection`).
 * Both surfaces recast these instead of offering a button that always fails.
 */
export function loopLocal(kind: ControlKind): boolean {
  return kind === "set-jobs" || kind === "pause" || kind === "resume";
}

/** The dashboard's exact recovery sentence, before the command it names. */
export const RESUME_HINT_PREFIX = "Quiescent (no live loop) — or restart it with";
/** The command that sentence names. */
export function resumeCommand(runId: string): string {
  return `ompo resume --run ${runId}`;
}

// ---- guards (the enabled/disabled matrix, once) ----

/** Park needs the operator's own words: they are the note the next resume reads. */
export function parkReasonError(reason: string): string | null {
  return reason.trim().length === 0 ? "park needs a reason (what to fix before resume)" : null;
}

/** Restart-loop needs a reason: it kills a live loop and lands on the audit log. */
export function restartReasonError(reason: string): string | null {
  return reason.trim().length === 0 ? "restart-loop needs a reason (what wedged the loop)" : null;
}

export function jobsError(value: number): string | null {
  if (!Number.isInteger(value) || value < JOBS_MIN || value > JOBS_MAX) {
    return `set-jobs needs an integer jobs ${JOBS_MIN}..${JOBS_MAX} (got ${value})`;
  }
  return null;
}

/**
 * The wedged-loop recovery is offered only when it can act: the run has a
 * recorded loop, it reads live, and something on the surface is stalled. A
 * live run with nothing stalled needs no recovery; a quiescent one cannot
 * restart a loop that is not there (the server refuses both).
 */
export function restartOffered(input: { live: boolean; loops: number; stalled: boolean }): boolean {
  return input.live && input.loops >= 1 && input.stalled;
}

// ---- bodies (byte-identical on every surface) ----

function withReason(body: ControlIntent, reason: string): ControlIntent {
  const trimmed = reason.trim();
  if (trimmed.length > 0) body.reason = trimmed;
  return body;
}

export function sliceIntent(kind: SliceKind, sliceId: string, reason = ""): ControlIntent {
  return withReason({ kind, sliceId }, reason);
}

export function runIntent(kind: RunKind, reason = ""): ControlIntent {
  return withReason({ kind }, reason);
}

export function jobsIntent(jobs: number, reason = ""): ControlIntent {
  return withReason({ kind: "set-jobs", jobs }, reason);
}

// ---- intent lifecycle (queued → applied/rejected) ----

/** A 202: the intent is on the log, and the loop owns the outcome. */
export interface PendingIntent {
  seq: number;
  kind: ControlKind;
  sliceId?: string;
  jobs?: number;
}

/** The 202 response as the pending row's view state. `jobs` is the value typed. */
export function pendingFrom(res: ControlQueued, jobs?: number): PendingIntent {
  return {
    seq: res.seq,
    kind: res.kind,
    ...(res.sliceId ? { sliceId: res.sliceId } : {}),
    ...(jobs !== undefined ? { jobs } : {}),
  };
}

/** A 200: applied (or refused) synchronously, with no event to wait for. */
export interface DirectOutcome {
  ok: boolean;
  message: string;
}

export function restartOutcome(res: ResumeResult | { ok: false; message: string }): DirectOutcome {
  if ("message" in res) return { ok: res.ok, message: res.message };
  return { ok: true, message: `loop restarted (pid ${res.pid}, log ${res.log}) — liveness follows on Activity` };
}

export function resumeOutcome(res: ResumeResult): DirectOutcome {
  return { ok: true, message: `resume loop spawned (pid ${res.pid}, log ${res.log}) — liveness follows on Activity` };
}

/** The kinds the server's control endpoint accepts — `ControlKind`, at runtime. */
const CONTROL_KINDS: readonly string[] = ["retry", "skip", "park", "kill", "set-jobs", "pause", "resume", "restart-loop"];

export function isControlKind(value: string): value is ControlKind {
  return CONTROL_KINDS.includes(value);
}

/**
 * Does this event settle `pending`? The intent's own seq is the correlation:
 * the outcome is newer, is a control outcome, is about the same slice (the
 * anchor both sides write), and — when its detail names a kind — names *this*
 * one. Applied/rejected details are `${kind}: ${message}` (`control.ts`
 * `applyIntent`), so a queued retry is never settled by a skip's rejection that
 * happened to land later. A detail with no kind in it (an outcome the writer
 * did not label) still settles by scope and recency, so a queued intent cannot
 * hang forever on a payload the deck does not recognize.
 */
export function outcomeMatches(e: RunEvent, pending: PendingIntent): boolean {
  if (e.seq <= pending.seq) return false;
  if (e.type !== "control_applied" && e.type !== "control_rejected") return false;
  if ((e.sliceId ?? undefined) !== pending.sliceId) return false;
  const label = /^([a-z][a-z-]*):/.exec(e.detail ?? "")?.[1];
  if (label !== undefined && isControlKind(label)) return label === pending.kind;
  return true;
}

/** The oldest event that settles `pending`, or `null` while it is still queued. */
export function findOutcome(events: readonly RunEvent[], pending: PendingIntent): RunEvent | null {
  let best: RunEvent | null = null;
  for (const e of events) {
    if (!outcomeMatches(e, pending)) continue;
    if (!best || e.seq < best.seq) best = e;
  }
  return best;
}
