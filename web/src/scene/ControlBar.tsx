/**
 * The deck's action bar (roadmap slice `d08`): the dashboard's control, from
 * the spatial selection.
 *
 * Control was already reachable from the deck through the dock, which renders
 * the dashboard's own `ControlPanel` (`d06`). What this adds is the *distance*:
 * the operator acting on what they are pointing at presses a button where they
 * are looking instead of opening a 2D panel first — and the outcome of that
 * press (queued, applied, rejected) appears in the same place, because "I
 * pressed retry and nothing happened" is worse on a spatial surface than it is
 * in a dense table.
 *
 * It holds no semantics of its own. Every body comes from `lib/control.ts` (the
 * module `ControlPanel` uses too), the confirmation rule is the same
 * `DESTRUCTIVE` set, the queued intent settles through the same correlation
 * (`findOutcome` over the event tail), and the quiescent run is recast with the
 * dashboard's exact sentence. The deck owns exactly one thing here: this
 * component's view state — the reason box, the armed confirm, the last intent
 * and its outcome. Nothing about control is written to the store, and the
 * spatial layer is untouched: a press becomes a `POST`, and the resulting model
 * change is the same transition `d05` already renders.
 *
 * Two rules are the deck's own, and both exist to keep a press honest:
 *
 *  - **Control acts on the live run.** At a recorded cursor the statuses on
 *    screen are the log's, so every action is disabled with a note naming the
 *    way back (`L`) rather than acting on a slice whose button says
 *    "running" while the run has moved on.
 *  - **Nothing is reported as success that has not happened.** A 202 renders
 *    `queued (seq N)` and stays queued until the orchestrator's own
 *    `control_applied`/`control_rejected` arrives; a 200 renders the direct
 *    outcome; a failed request renders the message with a retry, never a
 *    silent clear.
 */

import { useEffect, useMemo, useState } from "react";
import { api, type ControlIntent, type RunEvent } from "../api.ts";
import {
  DESTRUCTIVE,
  JOBS_MAX,
  JOBS_MIN,
  RESUME_HINT_PREFIX,
  SLICE_ACTIONS,
  findOutcome,
  jobsError,
  jobsIntent,
  parkReasonError,
  pendingFrom,
  restartOffered,
  restartOutcome,
  restartReasonError,
  resumeCommand,
  resumeOutcome,
  runIntent,
  sliceIntent,
  type DirectOutcome,
  type PendingIntent,
  type SliceKind,
} from "../lib/control.ts";

/**
 * How long the queued row keeps spinning. The intent may legitimately take
 * longer than this (the loop drains on its own cadence), so the row stays —
 * only the motion stops, because a spinner that runs forever reads as progress
 * that is not happening.
 */
const SPIN_MS = 2000;

export interface DeckControlBarProps {
  runId: string | null;
  /** The slice the actions act on: the selection, resolved against this run's DTOs. */
  target: { id: string } | null;
  /**
   * The app's selection when it did *not* resolve — a run switch in flight, or
   * a slice the new run does not have. The actions are disabled until it does,
   * so a press can never address the previous run's slice by name.
   */
  selectedId: string | null;
  /** The live event tail the shell polls — the outcome correlation's only source. */
  events: RunEvent[];
  live: boolean;
  /** `RunDetail.loops.length`: a recorded loop process for this run. */
  loops: number;
  /** Something on this surface is stalled (a wedged worker, an idle verdict). */
  stalled: boolean;
  /** The deck's cursor: non-null means the scene is showing a recorded state. */
  historySeq: number | null;
  /** `AgentRow.wedged` for the target, when the shell knows it. */
  wedged?: boolean;
  /** The shell's refetch after an attempt — the dashboard's own callback. */
  onControlDone: () => void;
}

export default function DeckControlBar({
  runId,
  target,
  selectedId,
  events,
  live,
  loops,
  stalled,
  historySeq,
  wedged,
  onControlDone,
}: DeckControlBarProps) {
  const [reason, setReason] = useState("");
  const [jobs, setJobs] = useState("4");
  const [armed, setArmed] = useState<SliceKind | null>(null);
  const [restartArmed, setRestartArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingIntent | null>(null);
  const [direct, setDirect] = useState<DirectOutcome | null>(null);
  const [error, setError] = useState<{ message: string; retry: ControlIntent | null } | null>(null);
  const [awaiting, setAwaiting] = useState(false);

  // A run switch retires in-flight view state: the events belong to the old
  // run, and a pending intent that never settles would be a permanent lie.
  useEffect(() => {
    setPending(null);
    setDirect(null);
    setError(null);
    setArmed(null);
    setRestartArmed(false);
    setReason("");
  }, [runId]);

  // A new selection disarms any armed confirm; the pending intent (if any)
  // stays until its orchestrator outcome lands in the event tail.
  const targetId = target?.id ?? null;
  useEffect(() => {
    setArmed(null);
    setRestartArmed(false);
  }, [targetId]);

  const outcome = useMemo(() => (pending === null ? null : findOutcome(events, pending)), [events, pending]);

  // The queued row spins only while waiting is news.
  useEffect(() => {
    if (pending === null || outcome !== null) {
      setAwaiting(false);
      return;
    }
    setAwaiting(true);
    const timer = window.setTimeout(() => setAwaiting(false), SPIN_MS);
    return () => window.clearTimeout(timer);
  }, [pending, outcome]);

  const past = historySeq !== null;
  const noRun = runId === null;
  const blocked = busy || past || noRun;
  const sliceBlocked = blocked || targetId === null;
  const reasonText = reason.trim();
  const restart = restartOffered({ live, loops, stalled });

  async function send(body: ControlIntent, pendingJobs?: number): Promise<void> {
    if (runId === null) return;
    setBusy(true);
    setError(null);
    setDirect(null);
    try {
      const res = await api.control(runId, body);
      if (res.applied === "queued") {
        setPending(pendingFrom(res, pendingJobs));
      } else {
        setPending(null);
        setDirect({ ok: res.ok, message: res.message });
      }
      onControlDone();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), retry: body });
    } finally {
      setBusy(false);
    }
  }

  function clickSlice(kind: SliceKind): void {
    if (sliceBlocked || targetId === null) return;
    const bad = kind === "park" ? parkReasonError(reason) : null;
    if (bad !== null) {
      setError({ message: bad, retry: null });
      return;
    }
    if (DESTRUCTIVE[kind] && armed !== kind) {
      setArmed(kind);
      return;
    }
    setArmed(null);
    void send(sliceIntent(kind, targetId, reason));
  }

  function stepJobs(delta: -1 | 1): void {
    const base = Number.parseInt(jobs, 10);
    const current = Number.isInteger(base) ? base : 4;
    sendJobs(Math.min(JOBS_MAX, Math.max(JOBS_MIN, current + delta)));
  }

  function sendJobs(value: number): void {
    const bad = jobsError(value);
    if (bad !== null) {
      setError({ message: bad, retry: null });
      return;
    }
    setJobs(String(value));
    void send(jobsIntent(value, reason), value);
  }

  async function sendRestartLoop(): Promise<void> {
    const bad = restartReasonError(reason);
    if (bad !== null) {
      setError({ message: bad, retry: null });
      return;
    }
    if (runId === null) return;
    setBusy(true);
    setError(null);
    setDirect(null);
    try {
      const res = await api.restartLoop(runId, reasonText);
      setDirect(restartOutcome(res));
      onControlDone();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), retry: null });
    } finally {
      setBusy(false);
    }
  }

  function clickRestart(): void {
    if (blocked) return;
    if (!restartArmed) {
      setRestartArmed(true);
      return;
    }
    setRestartArmed(false);
    void sendRestartLoop();
  }

  async function sendResumeRun(): Promise<void> {
    if (runId === null) return;
    setBusy(true);
    setError(null);
    setDirect(null);
    try {
      const res = await api.resume(runId);
      setDirect(resumeOutcome(res));
      onControlDone();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), retry: null });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="omp-deck-control" aria-label="Control" data-live={live ? "true" : "false"} data-history={past ? "past" : "live"}>
      <div className="omp-deck-control-row" role="group" aria-label={`Slice actions${targetId === null ? "" : ` for ${targetId}`}`}>
        <span className="omp-deck-control-label">
          Slice <code>{targetId ?? "— none selected —"}</code>
        </span>
        {SLICE_ACTIONS.map((action) => {
          const isArmed = armed === action.kind;
          const needsReason = action.kind === "park" && reasonText.length === 0;
          return (
            <button
              key={action.kind}
              type="button"
              className="omp-deck-control-button"
              data-action={action.kind}
              data-armed={isArmed ? "true" : "false"}
              data-destructive={DESTRUCTIVE[action.kind] ? "true" : "false"}
              disabled={sliceBlocked || needsReason}
              title={
                past
                  ? "control acts on the live run — return to live first (L)"
                  : targetId === null
                    ? selectedId === null
                      ? "select a slice first"
                      : `${selectedId} is not in this run — select a slice`
                    : needsReason
                      ? "park needs a reason — type one first"
                      : action.hint
              }
              onClick={() => clickSlice(action.kind)}
            >
              {isArmed ? `Confirm ${action.kind}` : action.label}
            </button>
          );
        })}
        <input
          className="omp-deck-control-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="reason — required for park"
          aria-label="Control reason"
        />
      </div>

      <div className="omp-deck-control-row" role="group" aria-label="Run actions">
        {live ? (
          <>
            <button
              type="button"
              className="omp-deck-control-button"
              data-action="pause"
              disabled={blocked}
              title="pause claiming — in-flight slices finish, nothing new claims"
              onClick={() => void send(runIntent("pause", reason))}
            >
              Pause
            </button>
            <button
              type="button"
              className="omp-deck-control-button"
              data-action="resume"
              disabled={blocked}
              title="resume claiming"
              onClick={() => void send(runIntent("resume", reason))}
            >
              Resume
            </button>
            {restart && (
              <button
                type="button"
                className="omp-deck-control-button"
                data-action="restart-loop"
                data-armed={restartArmed ? "true" : "false"}
                data-wedged={wedged === true ? "true" : "false"}
                disabled={blocked}
                title={
                  wedged === true
                    ? "loop looks wedged (stale transcript) — kill it and spawn a fresh resume (needs a reason)"
                    : "kill the live loop and spawn a fresh resume (needs a reason)"
                }
                onClick={clickRestart}
              >
                {restartArmed ? "Confirm restart" : wedged === true ? "Restart wedged loop" : "Restart loop"}
              </button>
            )}
            <span className="omp-deck-control-label">Jobs</span>
            <button
              type="button"
              className="omp-deck-control-button"
              data-action="jobs-down"
              aria-label="Decrease jobs by one"
              disabled={blocked}
              onClick={() => stepJobs(-1)}
            >
              −
            </button>
            <input
              className="omp-deck-control-jobs"
              value={jobs}
              onChange={(event) => setJobs(event.target.value)}
              aria-label="jobs"
            />
            <button
              type="button"
              className="omp-deck-control-button"
              data-action="jobs-up"
              aria-label="Increase jobs by one"
              disabled={blocked}
              onClick={() => stepJobs(1)}
            >
              +
            </button>
            <button
              type="button"
              className="omp-deck-control-button"
              data-action="jobs-set"
              disabled={blocked}
              title="apply the typed jobs value (1..32)"
              onClick={() => sendJobs(Number(jobs))}
            >
              Set
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="omp-deck-control-button"
              data-action="resume-run"
              disabled={blocked}
              title="spawn a detached resume loop for this run"
              onClick={() => void sendResumeRun()}
            >
              Resume run
            </button>
            <span className="omp-deck-control-note">
              {RESUME_HINT_PREFIX} <code>{resumeCommand(runId ?? "")}</code>
            </span>
          </>
        )}
      </div>

      {past && (
        <p className="omp-deck-control-note" data-mode="past">
          Control acts on the live run — press <kbd>L</kbd> to return to it.
        </p>
      )}

      <div className="omp-deck-control-status" aria-live="polite">
        {error !== null && (
          <p className="omp-deck-control-error" role="alert" data-outcome="error">
            <span className="omp-deck-control-verb">failed</span>
            <span className="omp-deck-control-message">{error.message}</span>
            {error.retry !== null && (
              <button
                type="button"
                className="omp-deck-control-button"
                data-action="retry-request"
                disabled={blocked}
                title="send the same intent again"
                onClick={() => void send(error.retry!)}
              >
                Retry request
              </button>
            )}
            <button
              type="button"
              className="omp-deck-control-dismiss"
              aria-label="Dismiss the control error"
              onClick={() => setError(null)}
            >
              ✕
            </button>
          </p>
        )}

        {pending !== null && outcome === null && (
          <p data-outcome="queued" data-awaiting={awaiting ? "true" : "false"}>
            <span className="omp-deck-control-spin" aria-hidden="true">
              ◌
            </span>
            <span className="omp-deck-control-verb">queued</span>
            <code>
              #{pending.seq} {pending.kind}
              {pending.sliceId ? ` ${pending.sliceId}` : ""}
              {pending.jobs !== undefined ? ` jobs=${pending.jobs}` : ""}
            </code>
            <span className="omp-deck-control-message">
              — waiting for the loop to confirm; the outcome lands on the event log, not here.
            </span>
          </p>
        )}

        {pending !== null && outcome !== null && (
          <p data-outcome={outcome.type === "control_applied" ? "applied" : "rejected"}>
            <span className="omp-deck-control-verb">{outcome.type === "control_applied" ? "applied" : "rejected"}</span>
            <code>
              #{pending.seq} {pending.kind}
              {pending.sliceId ? ` ${pending.sliceId}` : ""}
            </code>
            <span className="omp-deck-control-message">
              → {outcome.detail ?? outcome.type} (#{outcome.seq})
            </span>
          </p>
        )}

        {pending === null && direct !== null && (
          <p data-outcome={direct.ok ? "applied" : "rejected"}>
            <span className="omp-deck-control-verb">{direct.ok ? "applied" : "rejected"}</span>
            <span className="omp-deck-control-message">
              {direct.message} <span className="omp-deck-control-hint">(direct — quiescent run)</span>
            </span>
          </p>
        )}
      </div>
    </section>
  );
}
