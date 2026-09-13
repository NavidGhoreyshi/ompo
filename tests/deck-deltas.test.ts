/**
 * Scene deltas (roadmap slice `d05`), tested without a browser.
 *
 * `diffModels` is the deck's answer to "what changed, and for whom", and the
 * properties that matter are the ones an operator would notice if they broke:
 *
 * 1. **A delta reports a change the model already made.** Never a prediction,
 *    never an interpolation — so a dropped animation can misplace a highlight
 *    but cannot misreport a state.
 * 2. **The first paint is silent.** A deck that has just loaded does not pulse
 *    every pad and grow every beacon: `diffModels(null, model)` is empty, and a
 *    run switch is not a transition of this run.
 * 3. **One cue per entity.** Two status changes on one worker map to one cue
 *    identity (the later target wins), while a status change and a stage change
 *    on the same worker stay independent — concurrent transitions do not
 *    serialise, and repeated ones do not queue.
 */

import { describe, expect, test } from "bun:test";
import type { RunDetail, RunEvent, SliceDetail, SliceSummary } from "../web/src/api.ts";
import { buildDeckModel } from "../web/src/scene/model.ts";
import { cueEntity, diffModels, sceneDeltas, type SceneDelta } from "../web/src/scene/deltas.ts";
import { DEFAULT_DECK_PREFS, type DeckInput, type DeckModel } from "../web/src/scene/types.ts";

const AT = "2026-09-13T00:00:00.000Z";

function slice(id: string, status: string, extra: Partial<SliceSummary> = {}): SliceSummary {
  return { id, title: `Slice ${id}`, status, attempts: 1, updatedAt: AT, deps: [], generation: 0, verify: [], ...extra };
}

function detail(slices: SliceSummary[], extra: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "run-1",
    createdAt: AT,
    updatedAt: AT,
    live: true,
    counts: { done: 0, active: 0, failed: 0, skipped: 0, blockedEnv: 0, pending: 0 },
    workers: slices.length,
    total: slices.length,
    status: "running",
    retries: 0,
    handoffs: 0,
    tokens: null,
    cost: null,
    slices,
    ...extra,
  };
}

function event(seq: number, type: string, sliceId: string, extra: Partial<RunEvent> = {}): RunEvent {
  return { seq, at: AT, type, sliceId, ...extra };
}

function model(slices: SliceSummary[], overrides: Partial<DeckInput> = {}): DeckModel {
  return buildDeckModel({
    runId: "run-1",
    detail: detail(slices),
    events: [],
    agents: [],
    selected: null,
    sliceDetail: null,
    pinnedId: null,
    prefs: DEFAULT_DECK_PREFS,
    live: true,
    dismissed: new Set<string>(),
    maxStations: 8,
    maxBeacons: 32,
    history: null,
    runs: [],
    ...overrides,
  });
}

const kinds = (deltas: SceneDelta[]): string[] => deltas.map((delta) => delta.kind);

/** A `SliceDetail` for one slice — the only detail the shell fetches. */
function sliceDetail(sliceId: string, extra: Partial<SliceDetail> = {}): SliceDetail {
  return {
    sliceId,
    title: `Slice ${sliceId}`,
    status: "running",
    attempts: 1,
    generation: 0,
    verify: [],
    deps: [],
    recentEvents: [],
    history: [],
    artifacts: { report: false, verdict: false, review: false, workerLog: false, prompt: false },
    ...extra,
  };
}

describe("diffModels: the transition record", () => {
  test("a worker moving through the lifecycle yields one ordered delta per step", () => {
    const running = model([slice("a", "running")], { events: [event(1, "slice_claimed", "a")] });
    const verifying = model([slice("a", "verifying")], { events: [event(1, "slice_claimed", "a"), event(2, "worker_finished", "a")] });
    const done = model([slice("a", "done")], {
      events: [event(1, "slice_claimed", "a"), event(2, "worker_finished", "a"), event(3, "slice_done", "a")],
    });

    const first = diffModels(running, verifying);
    const second = diffModels(verifying, done);
    expect(first).toEqual([{ kind: "status", id: "a", from: "running", to: "verifying", seq: 2 }]);
    expect(second).toEqual([{ kind: "status", id: "a", from: "verifying", to: "done", seq: 3 }]);
  });

  test("the first paint and a run switch are silent", () => {
    const one = model([slice("a", "running")]);
    expect(diffModels(null, one)).toEqual([]);
    // A different run is a different world, not a transition of this one.
    const other = { ...one, runId: "run-2" };
    expect(diffModels(one, other)).toEqual([]);
  });

  test("an unchanged model reports nothing", () => {
    const one = model([slice("a", "running"), slice("b", "pending", { deps: ["a"] })]);
    const two = model([slice("a", "running"), slice("b", "pending", { deps: ["a"] })]);
    expect(diffModels(one, two)).toEqual([]);
  });

  test("a status change with no matching event is still a delta (the DTO is authoritative)", () => {
    const before = model([slice("a", "running")]);
    const after = model([slice("a", "done")]);
    expect(diffModels(before, after)).toEqual([{ kind: "status", id: "a", from: "running", to: "done", seq: 0 }]);
  });

  test("a stage change inside a status is a stage delta, not a status one", () => {
    // Same status (`running`), but the slice is now in its Verify phase: the
    // stage moved and the station's marks with it.
    const work = model([slice("a", "running")]);
    const gates = model([slice("a", "running")], {
      sliceDetail: sliceDetail("a", { verdictSteps: [{ name: "bun test", exit: 0, timedOut: false, tail: "" }] }),
    });
    const deltas = diffModels(work, gates);
    expect(kinds(deltas)).toEqual(["stage"]);
    expect(deltas[0]).toEqual({ kind: "stage", id: "a", from: 2, to: 4 });
  });

  test("a handoff (generation bump) is recorded and animates nothing", () => {
    const before = model([slice("a", "running", { generation: 1 })]);
    const after = model([slice("a", "running", { generation: 2 })]);
    const deltas = diffModels(before, after);
    expect(deltas).toEqual([{ kind: "attempt", id: "a", attempt: 1, generation: 2 }]);
    expect(sceneDeltas(deltas)).toEqual([]);
    expect(cueEntity(deltas[0]!)).toBeNull();
  });

  test("a new alert is a delta; a dismissed one clears", () => {
    const failed = [slice("a", "failed", { reason: "boom" })];
    const quiet = model([slice("a", "running")]);
    const alerted = model(failed, { events: [event(4, "slice_failed_terminal", "a")] });
    const raised = diffModels(quiet, alerted);
    expect(raised).toHaveLength(2);
    expect(raised[0]).toMatchObject({ kind: "status", id: "a", from: "running", to: "failed", seq: 4 });
    expect(raised[1]).toMatchObject({ kind: "alert", id: "a" });
    expect(raised[1]?.kind === "alert" && raised[1].alert.kind).toBe("failed");

    // Dismissal is view state: the alert disappears from the model, and the
    // scene is told to take its beacon away.
    const dismissed = model(failed, {
      events: [event(4, "slice_failed_terminal", "a")],
      dismissed: new Set([`run-1|a|failed|4`]),
    });
    expect(dismissed.alerts).toEqual([]);
    const cleared = diffModels(alerted, dismissed);
    expect(cleared).toEqual([{ kind: "alert-cleared", id: "a", alertKind: "failed", severity: "high" }]);
    expect(cueEntity(cleared[0]!)).toBe("beacon:a|failed");
  });

  test("a run-level alert has a cue of its own and never a slice's", () => {
    const quiet = model([slice("a", "running")]);
    const looping = model([slice("a", "running")], { detail: detail([slice("a", "running")], { loops: [{ pid: 3, lockOwner: true }, { pid: 4, lockOwner: false }] }) });
    const deltas = diffModels(quiet, looping);
    expect(deltas).toEqual([{ kind: "alert", id: null, alert: expect.objectContaining({ kind: "double-loop" }) }]);
    expect(cueEntity(deltas[0]!)).toBeNull();
  });
});

describe("cueEntity: one cue per entity", () => {
  const status = (to: string): Extract<SceneDelta, { kind: "status" }> => ({
    kind: "status",
    id: "a",
    from: "running",
    to,
    seq: 1,
  });

  test("two changes on one worker share an identity, so the later target wins", () => {
    const map = new Map<string, string>();
    for (const delta of [status("verifying"), status("done")]) {
      map.set(cueEntity(delta)!, delta.kind === "status" ? delta.to : "");
    }
    expect(map.size).toBe(1);
    expect([...map.values()]).toEqual(["done"]);
  });

  test("the transitions of one worker that can run together do not collide", () => {
    const deltas = diffModels(model([slice("a", "running", { generation: 0 })]), model([slice("a", "verifying", { generation: 1 })]));
    const entities = deltas.map((delta) => cueEntity(delta));
    expect(new Set(entities).size).toBe(entities.length);
    expect(entities).toContain("pulse:a");
    expect(entities).toContain(null); // the attempt delta
  });
});
