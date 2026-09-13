/**
 * Control semantics shared by the dashboard and the deck (roadmap slice
 * `d08`), tested without a browser.
 *
 * The claim this slice rests on is "the deck does what the dashboard does".
 * That is not a claim about two UIs; it is a claim about one module, and these
 * are its rules:
 *
 * 1. **One builder per body.** `ompo ctl`'s contract (kind + sliceId/jobs +
 *    optional trimmed reason) is produced in one place, so a press on either
 *    surface is the same request.
 * 2. **The guards are stated once.** Destructive actions confirm, park and
 *    restart-loop need a reason, loop-local kinds are withheld from a
 *    quiescent run, and the wedged-loop recovery appears only when it can act.
 * 3. **A queued intent settles on the orchestrator's own event.** The
 *    correlation is scope + recency + kind, and it never lets another intent's
 *    outcome settle this one.
 */

import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../web/src/api.ts";
import {
  DESTRUCTIVE,
  JOBS_MAX,
  JOBS_MIN,
  RESUME_HINT_PREFIX,
  SLICE_ACTIONS,
  findOutcome,
  jobsError,
  jobsIntent,
  loopLocal,
  outcomeMatches,
  parkReasonError,
  pendingFrom,
  restartOffered,
  restartOutcome,
  restartReasonError,
  resumeCommand,
  resumeOutcome,
  runIntent,
  sliceIntent,
  type PendingIntent,
} from "../web/src/lib/control.ts";

const AT = "2026-09-13T00:00:00.000Z";

function event(seq: number, type: string, extra: Partial<RunEvent> = {}): RunEvent {
  return { seq, at: AT, type, ...extra };
}

describe("bodies: one builder, `ompo ctl`'s contract", () => {
  test("a slice action carries only its kind and slice", () => {
    expect(sliceIntent("retry", "alpha")).toEqual({ kind: "retry", sliceId: "alpha" });
    expect(sliceIntent("kill", "alpha", "   ")).toEqual({ kind: "kill", sliceId: "alpha" });
  });

  test("a reason is trimmed and attached when the operator typed one", () => {
    expect(sliceIntent("park", "beta", "  wait for the env  ")).toEqual({
      kind: "park",
      sliceId: "beta",
      reason: "wait for the env",
    });
    expect(runIntent("pause", "drain first")).toEqual({ kind: "pause", reason: "drain first" });
    expect(runIntent("resume")).toEqual({ kind: "resume" });
  });

  test("set-jobs carries the value and no slice", () => {
    expect(jobsIntent(6)).toEqual({ kind: "set-jobs", jobs: 6 });
    expect(jobsIntent(2, "tighten")).toEqual({ kind: "set-jobs", jobs: 2, reason: "tighten" });
  });

  test("the rendered action list is the taxonomy: every kind, in order", () => {
    expect(SLICE_ACTIONS.map((action) => action.kind)).toEqual(["retry", "skip", "park", "kill"]);
    for (const action of SLICE_ACTIONS) {
      expect(typeof action.label).toBe("string");
      expect(action.hint.length).toBeGreaterThan(0);
    }
  });

  test("destructive actions are exactly skip and kill", () => {
    expect(DESTRUCTIVE).toEqual({ retry: false, skip: true, park: false, kill: true });
  });

  test("loop-local kinds are the ones a quiescent run cannot serve", () => {
    expect(loopLocal("pause")).toBe(true);
    expect(loopLocal("resume")).toBe(true);
    expect(loopLocal("set-jobs")).toBe(true);
    expect(loopLocal("retry")).toBe(false);
    expect(loopLocal("skip")).toBe(false);
    expect(loopLocal("park")).toBe(false);
    expect(loopLocal("kill")).toBe(false);
    expect(loopLocal("restart-loop")).toBe(false);
  });
});

describe("guards", () => {
  test("park and restart-loop need the operator's words", () => {
    expect(parkReasonError("   ")).toBe("park needs a reason (what to fix before resume)");
    expect(parkReasonError("waiting on CI")).toBeNull();
    expect(restartReasonError("")).toBe("restart-loop needs a reason (what wedged the loop)");
    expect(restartReasonError("stale transcript 40m")).toBeNull();
  });

  test("set-jobs bounds are the server's, inclusive", () => {
    expect(jobsError(JOBS_MIN)).toBeNull();
    expect(jobsError(JOBS_MAX)).toBeNull();
    expect(jobsError(JOBS_MIN - 1)).toBe(`set-jobs needs an integer jobs ${JOBS_MIN}..${JOBS_MAX} (got 0)`);
    expect(jobsError(JOBS_MAX + 1)).toBe(`set-jobs needs an integer jobs ${JOBS_MIN}..${JOBS_MAX} (got 33)`);
    expect(jobsError(4.5)).toContain("(got 4.5)");
    expect(jobsError(Number.NaN)).toContain("(got NaN)");
  });

  test("the wedged-loop recovery is offered only when it can act", () => {
    expect(restartOffered({ live: true, loops: 1, stalled: true })).toBe(true);
    expect(restartOffered({ live: true, loops: 2, stalled: true })).toBe(true);
    // A healthy live run needs no recovery; a quiescent one has no loop to restart.
    expect(restartOffered({ live: true, loops: 1, stalled: false })).toBe(false);
    expect(restartOffered({ live: false, loops: 1, stalled: true })).toBe(false);
    expect(restartOffered({ live: true, loops: 0, stalled: true })).toBe(false);
  });

  test("the quiescent recovery is the dashboard's exact sentence and command", () => {
    expect(RESUME_HINT_PREFIX).toBe("Quiescent (no live loop) — or restart it with");
    expect(resumeCommand("d08")).toBe("ompo resume --run d08");
  });
});

describe("intent lifecycle", () => {
  test("a 202 keeps the seq, the kind, the subject and the typed jobs", () => {
    expect(pendingFrom({ seq: 12, kind: "retry", sliceId: "alpha", applied: "queued" })).toEqual({
      seq: 12,
      kind: "retry",
      sliceId: "alpha",
    });
    expect(pendingFrom({ seq: 13, kind: "set-jobs", applied: "queued" }, 6)).toEqual({ seq: 13, kind: "set-jobs", jobs: 6 });
  });

  test("an outcome must be newer, a control outcome, and in scope", () => {
    const pending: PendingIntent = { seq: 10, kind: "retry", sliceId: "alpha" };
    expect(outcomeMatches(event(11, "control_applied", { sliceId: "alpha", detail: "retry: requeued" }), pending)).toBe(true);
    // Its own request is not its outcome; a later event about another slice is not either.
    expect(outcomeMatches(event(10, "control_applied", { sliceId: "alpha" }), pending)).toBe(false);
    expect(outcomeMatches(event(11, "control_applied", { sliceId: "beta" }), pending)).toBe(false);
    expect(outcomeMatches(event(11, "worker_finished", { sliceId: "alpha" }), pending)).toBe(false);
  });

  test("a run-level intent correlates on the absence of a slice", () => {
    const pending: PendingIntent = { seq: 4, kind: "pause" };
    expect(outcomeMatches(event(5, "control_applied", { detail: "pause: claiming stopped" }), pending)).toBe(true);
    expect(outcomeMatches(event(5, "control_applied", { sliceId: "alpha" }), pending)).toBe(false);
  });

  test("a detail naming another kind does not settle this intent, its own does", () => {
    const pending: PendingIntent = { seq: 7, kind: "retry", sliceId: "alpha" };
    expect(outcomeMatches(event(8, "control_rejected", { sliceId: "alpha", detail: "skip: not needed" }), pending)).toBe(false);
    expect(outcomeMatches(event(8, "control_rejected", { sliceId: "alpha", detail: "retry: slice is done" }), pending)).toBe(true);
    // No detail at all: scope + recency still settle it rather than hanging forever.
    expect(outcomeMatches(event(8, "control_rejected", { sliceId: "alpha" }), pending)).toBe(true);
  });

  test("the oldest settling event wins, and a settled intent keeps its outcome", () => {
    const pending: PendingIntent = { seq: 20, kind: "skip", sliceId: "alpha" };
    const events = [
      event(19, "control_applied", { sliceId: "alpha" }),
      event(21, "control_rejected", { sliceId: "alpha", detail: "skip: already done" }),
      event(24, "control_applied", { sliceId: "alpha", detail: "skip: skipped" }),
    ];
    expect(findOutcome(events, pending)?.seq).toBe(21);
    expect(findOutcome(events, { seq: 25, kind: "skip", sliceId: "alpha" })).toBeNull();
    expect(findOutcome([], pending)).toBeNull();
  });
});

describe("direct outcomes", () => {
  test("a restarted loop and a spawned resume read as the dashboard reads them", () => {
    expect(restartOutcome({ ok: true, applied: "spawned", pid: 42, log: "resume-1.log" })).toEqual({
      ok: true,
      message: "loop restarted (pid 42, log resume-1.log) — liveness follows on Activity",
    });
    expect(restartOutcome({ ok: false, message: "no live loop to restart" })).toEqual({
      ok: false,
      message: "no live loop to restart",
    });
    expect(resumeOutcome({ ok: true, applied: "spawned", pid: 7, log: "resume-2.log" })).toEqual({
      ok: true,
      message: "resume loop spawned (pid 7, log resume-2.log) — liveness follows on Activity",
    });
  });
});
