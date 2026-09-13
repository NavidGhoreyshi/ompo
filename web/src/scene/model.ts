/**
 * The deck's scene model (roadmap slices `d02`–`d04`).
 *
 * `buildDeckModel` is a deterministic projection of application state into
 * presentation data: DTOs in, an immutable `DeckModel` out. It owns no state,
 * reads no clock, touches no DOM, and returns a new object every call — two
 * calls with the same input are `JSON.stringify`-equal, which is what makes the
 * rail's stability testable. Everything the scene draws is in this file's
 * output; there is no second path from state to pixels.
 *
 * Reuse, not re-derivation (M1): the layout, its depths, ready/blocked flags,
 * cycle membership, dependency satisfaction, the "which slice needs eyes"
 * ranking and the station slot policy all come from `web/src/lib/**` and
 * `lanes.ts`. This file only decides which of those values the scene is
 * allowed to see, and joins them with the DTO fields the overlay needs.
 *
 * Pure module: no `three`, no DOM, no fetching.
 */

import { depSatisfied, layoutDag } from "../lib/dag.ts";
import { buildPipelineStages, currentStageIndex } from "../lib/pipeline.ts";
import { isLiveStatus, preferredSliceId } from "../lib/selection.ts";
import { activeAlerts, deriveAlerts, scanEvents, type DeckAlert } from "./alerts.ts";
import { focusTarget, liveSliceIds } from "./focus.ts";
import { stationSlots } from "./lanes.ts";
import { railBounds, railPositions } from "./rail.ts";
import type { SliceDetail, SliceSummary } from "../api.ts";
import type {
  AlertKind,
  DeckCounts,
  DeckInput,
  DeckModel,
  DeckStation,
  RailEdge,
  RailNode,
} from "./types.ts";

const ZERO_COUNTS: DeckCounts = { done: 0, active: 0, failed: 0, skipped: 0, blockedEnv: 0, pending: 0 };

/**
 * What the pad must encode beyond colour. `d02` marks only the two states the
 * rail can act on (`failed`, `blocked-env`); a broader alert taxonomy is `d05`
 * (`deriveAlerts`), and inventing one here would be a second set of semantics.
 * `aborted` is deliberately not an alert yet: nothing in this slice draws it.
 */
function alertFor(status: string): AlertKind | null {
  if (status === "failed") return "failed";
  if (status === "blocked-env") return "blocked-env";
  return null;
}

/**
 * Content key for the renderer's early-out: exactly the fields the scene
 * consumes, in model order, with positions omitted because they are a pure
 * function of the ids. Changing an event, a worker row or the log text cannot
 * change this string — which is how "text never touches the render loop"
 * (CP-3) becomes observable rather than aspirational. Focus and the station's
 * stage are in it because the shaft and the secondary dimming are drawn from
 * them; the stage *label* is not, because the scene never draws text, and
 * neither are `attempts`/`generation`, which the scene never reads either (a
 * handoff that only bumps a counter must cost the GPU nothing).
 */
function digestOf(
  runId: string | null,
  live: boolean,
  focusId: string | null,
  nodes: RailNode[],
  edges: RailEdge[],
  stations: DeckStation[],
  beacons: DeckAlert[],
): string {
  const parts: string[] = [runId ?? "", live ? "live" : "idle", focusId ?? ""];
  for (const n of nodes) {
    parts.push(
      `${n.id}\u0001${n.status}\u0001${n.alert ?? ""}\u0001` +
        `${n.selected ? 1 : 0}${n.ghost ? 1 : 0}${n.inCycle ? 1 : 0}${n.live ? 1 : 0}\u0001${n.stage}`,
    );
  }
  for (const e of edges) {
    parts.push(`${e.key}\u0001${e.satisfied ? 1 : 0}${e.unknown ? 1 : 0}${e.inCycle ? 1 : 0}`);
  }
  // Stations: the stage marks a worker draws, its wedge pattern, and whether
  // the pool could hold it — everything the station mesh shows. `slot` and
  // `lane` are deliberately absent: a pool entry is not a coordinate, and a
  // worker whose slot moves (a lane re-index upstream) must not repaint the
  // scene. Array order is in it, because that is the order the marks are
  // written.
  for (const s of stations) {
    parts.push(`${s.id}\u0001${s.stack}\u0001${s.stage}\u0001${s.wedged ? 1 : 0}`);
  }
  // Beacons (`d05`): the alerts the scene draws, by kind and severity — the
  // ring pattern and its colour. The *text* and the evidence seq are
  // deliberately absent: a new event on an already-beaconed slice must not
  // repaint the scene, and the stack is DOM that re-renders at model cadence
  // anyway.
  for (const a of beacons) {
    parts.push(`\u0003${a.sliceId ?? "-"}\u0001${a.kind}\u0001${a.severity}`);
  }
  return parts.join("\u0002");
}

/** The model for "nothing to project yet" (loading, or a run with no slices). */
function emptyModel(runId: string | null, live: boolean): DeckModel {
  return {
    runId,
    live,
    loading: true,
    nodes: [],
    edges: [],
    counts: { ...ZERO_COUNTS },
    primaryId: null,
    liveIds: [],
    stations: [],
    stationOverflow: 0,
    alerts: [],
    beaconAlerts: [],
    alertsOverflow: 0,
    warnings: [],
    focusId: null,
    bounds: railBounds([]),
    digest: `${runId ?? ""}\u0002loading`,
  };
}

/**
 * A live slice's pipeline stage, from the DTOs: `buildPipelineStages` +
 * `currentStageIndex` in `lib/pipeline.ts` — the same derivation the hero rail
 * and the inspector checklist draw. The stage is read only for live slices;
 * a terminal pad's phase is its status, and giving it a shaft would be noise.
 */
function stageFor(slice: SliceSummary, detail: SliceDetail | null): { stage: number; label: string } {
  if (!isLiveStatus(slice.status)) return { stage: -1, label: "" };
  const stages = buildPipelineStages(slice, detail);
  const stage = currentStageIndex(stages);
  return { stage, label: stage >= 0 ? (stages[stage]?.label ?? "") : "" };
}

/**
 * Project the run's roadmap into the scene model.
 *
 * `detail === null` (nothing loaded, or a run switch in flight) yields the
 * loading model: no pads, zero counts, `loading: true`. The deck keeps the
 * previous pads on screen while that happens — that is the caller's job, not
 * this function's, because keeping state is exactly what a pure projection
 * must not do.
 */
export function buildDeckModel(input: DeckInput): DeckModel {
  const detail = input.detail;
  if (!detail) return emptyModel(input.runId, input.live);

  const slices = detail.slices;
  const layout = layoutDag(slices);
  const positions = railPositions(layout);
  const byId = new Map(slices.map((s) => [s.id, s]));
  const cycleIds = new Set(layout.cycleIds);
  // The shell fetches slice detail for the *selection*; it is used for nothing
  // but the stage index, and only for the slice it actually belongs to.
  const sliceDetail = input.sliceDetail;

  const agentById = new Map(input.agents.map((row) => [row.id, row]));
  const seqIndex = scanEvents(input.events);

  const nodes: RailNode[] = layout.nodes.map((n) => {
    const slice = byId.get(n.id);
    const position = positions.get(n.id) ?? { x: 0, y: 0, z: 0 };
    const stage = slice ? stageFor(slice, sliceDetail?.sliceId === n.id ? sliceDetail : null) : { stage: -1, label: "" };
    return {
      id: n.id,
      title: n.title,
      status: n.status,
      attempts: slice?.attempts ?? 0,
      generation: slice?.generation ?? 0,
      effort: slice?.effort ?? null,
      depth: n.depth,
      x: position.x,
      z: position.z,
      deps: slice?.deps ?? [],
      selected: input.selected === n.id,
      ready: n.ready,
      blocked: n.blocked,
      ghost: n.ghost,
      inCycle: cycleIds.has(n.id),
      reason: slice?.reason ?? null,
      alert: alertFor(n.status),
      seq: seqIndex.bySlice.get(n.id) ?? 0,
      live: isLiveStatus(n.status),
      stage: stage.stage,
      stageLabel: stage.label,
      lane: agentById.get(n.id)?.lane ?? null,
      wedged: agentById.get(n.id)?.wedged === true,
    };
  });

  // Edges are projected from the roadmap's `deps` (the DTO the operator wrote),
  // by the same rule `layoutDag` uses, so the two can be compared — and are,
  // in `tests/deck-model.test.ts`.
  const edges: RailEdge[] = [];
  for (const slice of slices) {
    for (const dep of slice.deps) {
      edges.push({
        key: `${dep}→${slice.id}`,
        from: dep,
        to: slice.id,
        satisfied: depSatisfied(byId.get(dep)),
        unknown: !byId.has(dep),
        inCycle: cycleIds.has(dep) && cycleIds.has(slice.id),
      });
    }
  }

  const pinnedId = input.pinnedId ?? null;
  const focusId = focusTarget(slices, pinnedId);
  const primaryId = preferredSliceId(slices);
  // Stations: the live set through the slot policy (`lanes.ts`), each worker
  // joined with its own node — stage and wedge come from the same projection,
  // so the scene and the lane list cannot disagree about a worker.
  const stationLayout = stationSlots(
    nodes.map((node) => ({ id: node.id, lane: node.lane })),
    liveSliceIds(slices),
    input.maxStations,
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const stations: DeckStation[] = stationLayout.stations.map((slot) => {
    const node = nodeById.get(slot.id);
    return {
      id: slot.id,
      slot: slot.slot,
      stack: slot.stack,
      stage: node?.stage ?? -1,
      wedged: node?.wedged === true,
      lane: node?.lane ?? null,
      primary: slot.id === primaryId,
      focused: slot.id === focusId,
    };
  });
  // Alerts (`d05`): the §D.8 taxonomy over the same DTOs the rail is built
  // from, minus what the operator has dismissed. The scene draws the first
  // `maxBeacons` of them (severity order, so the cap can only cost a beacon to
  // an advisory alert while a high one is up); the stack renders them all.
  const derived = deriveAlerts({
    slices,
    agents: input.agents,
    events: input.events,
    sliceDetail,
    loops: detail.loops ?? [],
  });
  const alerts = activeAlerts(derived, input.dismissed, detail.runId);
  const beaconAlerts = alerts.slice(0, Math.max(0, Math.floor(input.maxBeacons)));
  return {
    runId: detail.runId,
    live: input.live,
    loading: false,
    nodes,
    edges,
    counts: { ...detail.counts },
    primaryId,
    liveIds: stations.map((station) => station.id),
    stations,
    stationOverflow: stationLayout.overflow,
    alerts,
    beaconAlerts,
    alertsOverflow: alerts.length - beaconAlerts.length,
    warnings: stationLayout.warnings,
    focusId,
    bounds: railBounds(positions.values()),
    digest: digestOf(detail.runId, input.live, focusId, nodes, edges, stations, beaconAlerts),
  };
}
