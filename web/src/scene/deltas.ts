/**
 * What changed between two scene models (roadmap slice `d05`) — pure.
 *
 * The renderer receives a *list of changes*, never a second copy of the model
 * and never a queue to drain: the deltas say which entity changed and to what,
 * and the renderer decides whether that earns a transition. Keeping the diff
 * here means "did the deck notice a transition, and which one" is a unit test
 * without a GPU, and the animation layer stays a consumer.
 *
 * The semantic rule this slice is built on: **a delta reports a change the
 * model already made.** `diffModels` never predicts a future state and never
 * interpolates one — it compares two immutable models. The scene applies the
 * new state immediately (colour, height, marks, beacons) and a delta only
 * describes what to call attention to; a transition that is late, lost or
 * dropped can therefore misplace a highlight but never misreport a state.
 *
 * Pure module: no DOM, no `three`, no clock.
 */

import type { DeckAlert, DeckAlertKind, AlertSeverity } from "./alerts.ts";
import type { DeckModel } from "./types.ts";

/**
 * One change between two models.
 *
 * `status` and `stage` are the two the scene paints; `attempt` is recorded but
 * deliberately not animated (a generation handoff costs zero frames — `d03`'s
 * invariant, asserted by `deck-model.test.ts`), and it is here because "the
 * worker restarted a generation" is a real transition the stack and the later
 * history slices read from the same list.
 */
export type SceneDelta =
  | { kind: "status"; id: string; from: string; to: string; seq: number }
  | { kind: "attempt"; id: string; attempt: number; generation: number }
  | { kind: "stage"; id: string; from: number; to: number }
  | { kind: "alert"; id: string | null; alert: DeckAlert }
  | { kind: "alert-cleared"; id: string | null; alertKind: DeckAlertKind; severity: AlertSeverity };

/** Identity of one alert across two models: kind, subject and evidence seq. */
function alertIdentity(alert: DeckAlert): string {
  return `${alert.sliceId ?? "-"}|${alert.kind}|${alert.lastSeq}`;
}

/**
 * Every scene-visible change from `prev` to `next`, in board order, with the
 * alert changes last.
 *
 * `prev === null` (the first paint) yields **nothing**: a deck that has just
 * loaded must not animate the whole world into existence — every pad would
 * pulse and every beacon would scale in, which is exactly the "constantly
 * moving scene" the slice must not become. A run switch yields nothing for the
 * same reason: the pads on screen are a different roadmap, not a transition of
 * this one.
 */
export function diffModels(prev: DeckModel | null, next: DeckModel): SceneDelta[] {
  if (prev === null || prev.runId !== next.runId) return [];

  const deltas: SceneDelta[] = [];
  const previous = new Map(prev.nodes.map((node) => [node.id, node]));

  for (const node of next.nodes) {
    const before = previous.get(node.id);
    if (before === undefined) continue; // a slice added to the roadmap: not a transition
    if (before.status !== node.status) {
      deltas.push({ kind: "status", id: node.id, from: before.status, to: node.status, seq: node.seq });
    } else if (before.stage !== node.stage) {
      // Same status, further along the pipeline (a gate finished inside
      // `running`): a change of phase, and the station's marks moved.
      deltas.push({ kind: "stage", id: node.id, from: before.stage, to: node.stage });
    }
    if (before.attempts !== node.attempts || before.generation !== node.generation) {
      deltas.push({ kind: "attempt", id: node.id, attempt: node.attempts, generation: node.generation });
    }
  }

  const active = new Set(next.alerts.map(alertIdentity));
  const previousAlerts = new Set(prev.alerts.map(alertIdentity));
  for (const alert of next.alerts) {
    if (!previousAlerts.has(alertIdentity(alert))) deltas.push({ kind: "alert", id: alert.sliceId, alert });
  }
  for (const alert of prev.alerts) {
    // A cleared alert is a dismissal or the condition ending: either way the
    // beacon must leave, and it must leave from where it stood.
    if (!active.has(alertIdentity(alert))) {
      deltas.push({ kind: "alert-cleared", id: alert.sliceId, alertKind: alert.kind, severity: alert.severity });
    }
  }

  return deltas;
}

/** Only the deltas that change what the scene draws. */
export function sceneDeltas(deltas: readonly SceneDelta[]): SceneDelta[] {
  return deltas.filter((delta) => delta.kind !== "attempt");
}

/**
 * The entity a delta animates — the renderer's cue identity — or `null` for a
 * delta that is recorded but never animated.
 *
 * One cue per entity is what makes an interrupted transition cheap: a worker
 * whose state changes twice re-targets its own pulse instead of starting a
 * second one behind the first, and a status change and a stage change on the
 * same worker animate *simultaneously* (different entities) rather than
 * serialising. `attempt` deltas (a generation handoff) animate nothing at all:
 * `d03` measured that a handoff buys zero frames, and `d05` keeps it that way.
 */
export function cueEntity(delta: SceneDelta): string | null {
  switch (delta.kind) {
    case "status":
      return `pulse:${delta.id}`;
    case "stage":
      return `marks:${delta.id}`;
    case "alert":
      return delta.alert.sliceId === null ? null : `beacon:${delta.alert.sliceId}|${delta.alert.kind}`;
    case "alert-cleared":
      return delta.id === null ? null : `beacon:${delta.id}|${delta.alertKind}`;
    case "attempt":
      return null;
  }
}
