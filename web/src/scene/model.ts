/**
 * The deck's scene model (roadmap slices `d02`–`d04`, temporal layer `d07`).
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
 * ranking and the station slot policy all come from `web/src/lib/**`,
 * `lanes.ts` and — for the historical cursor — `history.ts`, whose fold is the
 * store's own status rule stopped at a seq. This file only decides which of
 * those values the scene is allowed to see, and joins them with the DTO fields
 * the overlay needs.
 *
 * Two modes, one projection:
 *
 *  - **live** (`historySeq === null`): every rail field is the DTO's, exactly
 *    as `d02`–`d05` defined it. Nothing in this slice changed that path.
 *  - **history** (`historySeq === N`): the pads show the log's state at N, the
 *    stations, beacons and alerts are empty (they describe the run as it is
 *    now — a past moment has none of them), the counts count the historical
 *    statuses, and the cursor/ribbon/wall carry the time axis. Both modes go
 *    through the same layout, the same digest and the same renderer.
 *
 * Pure module: no `three`, no DOM, no fetching.
 */

import { depSatisfied, layoutDag } from "../lib/dag.ts";
import { buildPipelineStages, currentStageIndex } from "../lib/pipeline.ts";
import { isLiveStatus, preferredSliceId } from "../lib/selection.ts";
import { activeAlerts, deriveAlerts, scanEvents, type DeckAlert } from "./alerts.ts";
import { focusTarget, liveSliceIds } from "./focus.ts";
import type { HistorySnapshot } from "./history.ts";
import { stationSlots } from "./lanes.ts";
import {
  railBounds,
  railPositions,
  RIBBON_MAX_BARS,
  ribbonPitch,
  ribbonX,
  ribbonZ,
  tilePositions,
  withTemporalBand,
} from "./rail.ts";
import type { SliceDetail, SliceSummary } from "../api.ts";
import type {
  AlertKind,
  DeckCounts,
  DeckHistoryInput,
  DeckInput,
  DeckModel,
  DeckStation,
  HistoryTile,
  RailBounds,
  RailEdge,
  RailNode,
  RibbonRail,
} from "./types.ts";

/**
 * Runs the wall row draws. Past the cap the newest are drawn and the DOM list
 * states the remainder — the same rule as the ribbon's bucket cap: a bounded
 * scene never means hidden information.
 */
export const HISTORY_TILE_CAP = 24;

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
 *
 * The ribbon and the tile row are in it (`d07`): they are geometry the scene
 * draws, and their content changes at transition cadence (one event at a
 * time), never per log line. The cursor is in it too, so scrubbing repaints
 * the playhead and nothing else changes.
 */
function digestOf(
  runId: string | null,
  live: boolean,
  focusId: string | null,
  historySeq: number | null,
  ribbonCursor: number,
  nodes: RailNode[],
  edges: RailEdge[],
  stations: DeckStation[],
  beacons: DeckAlert[],
  ribbon: readonly { count: number; lane: string | null; active: number }[],
  ribbonRail: RibbonRail,
  tiles: readonly HistoryTile[],
): string {
  const parts: string[] = [
    runId ?? "",
    live ? "live" : "idle",
    focusId ?? "",
    historySeq === null ? "now" : `at:${historySeq}:${ribbonCursor}`,
  ];
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
  // The ribbon (`d07`): per bucket, what its bar shows (count → height, lane →
  // colour, in-flight workers → the concurrency reading). One event changes
  // one bucket, so the scene repaints once per event — never per log line.
  for (const b of ribbon) {
    parts.push(`\u0004${b.count}\u0001${b.lane ?? "-"}\u0001${b.active}`);
  }
  // …and where the bars stand: the drawn count and pitch are a function of the
  // bucket count and the world's extent, stated explicitly so a merged strip
  // can never be painted from a stale layout.
  parts.push(`\u0006${ribbonRail.bars}\u0001${ribbonRail.pitch.toFixed(3)}\u0001${ribbonRail.x0.toFixed(3)}\u0001${ribbonRail.z.toFixed(3)}`);
  // The wall: identity only. A tile's geometry is a function of the row's
  // index and the bounds, both already in or absent by the rules above.
  for (const t of tiles) {
    parts.push(`\u0005${t.runId}\u0001${t.live ? 1 : 0}${t.current ? 1 : 0}`);
  }
  return parts.join("\u0002");
}

/**
 * The run's statuses folded into the same six buckets `RunSummary.counts`
 * uses — a count of what the pads show, computed the way `server.ts` counts the
 * summary, never a second status rule (`status` is already the log's, or the
 * DTO's in live mode).
 */
function countStatuses(statuses: readonly string[]): DeckCounts {
  const counts = { ...ZERO_COUNTS };
  for (const status of statuses) {
    switch (status) {
      case "done":
        counts.done++;
        break;
      case "running":
      case "verifying":
        counts.active++;
        break;
      case "failed":
      case "aborted":
        counts.failed++;
        break;
      case "skipped":
        counts.skipped++;
        break;
      case "blocked-env":
      case "blocked":
        counts.blockedEnv++;
        break;
      default:
        counts.pending++;
    }
  }
  return counts;
}

/** The wall row from the shell's polled run list: newest first, capped. */
function wallTiles(input: DeckInput, detailRunId: string, bounds: RailBounds): {
  tiles: HistoryTile[];
  overflow: number;
} {
  const newest = input.runs.slice(-HISTORY_TILE_CAP).reverse();
  const spots = tilePositions(bounds, newest.length);
  const tiles = newest.map((run, index) => ({
    runId: run.runId,
    live: run.live === true,
    current: run.runId === detailRunId,
    x: spots[index]?.x ?? 0,
    z: spots[index]?.z ?? 0,
  }));
  return { tiles, overflow: Math.max(0, input.runs.length - newest.length) };
}

/** The model for "nothing to project yet" (loading, or a run with no slices). */
function emptyModel(input: DeckInput): DeckModel {
  const history = input.history;
  const cursor = history?.seq ?? null;
  const snapshot = cursor === null || history === null ? null : history.index.snapshotAt(cursor);
  const ribbon = history === null ? [] : [...history.index.buckets];
  const bounds = withTemporalBand(railBounds([]));
  const wall = wallTiles(input, input.runId ?? "", bounds);
  const ribbonRail: RibbonRail = { bars: 0, pitch: 0, x0: bounds.centerX, z: ribbonZ(bounds) };
  return {
    runId: input.runId,
    live: input.live,
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
    bounds,
    ribbon,
    ribbonRecorded: history === null ? [] : [...history.index.recorded],
    ribbonRail,
    ribbonCursor: history === null || cursor === null ? -1 : (history.index.bucketAt(cursor)?.index ?? -1),
    historySeq: cursor,
    historyAt: snapshot?.at ?? null,
    historyActive: snapshot?.activeIds.length ?? 0,
    tiles: wall.tiles,
    tilesOverflow: wall.overflow,
    digest: `${input.runId ?? ""}\u0002loading\u0002${cursor ?? "now"}`,
  };
}

/**
 * A live slice's pipeline stage, from the DTOs: `buildPipelineStages` +
 * `currentStageIndex` in `lib/pipeline.ts` — the same derivation the hero rail
 * and the inspector checklist draw. The stage is read only for live slices;
 * a terminal pad's phase is its status, and giving it a shaft would be noise.
 * History mode draws no stages at all: the pipeline index is a function of the
 * *current* slice record, and a past moment has no recorded counterpart.
 */
function stageFor(slice: SliceSummary, detail: SliceDetail | null): { stage: number; label: string } {
  if (!isLiveStatus(slice.status)) return { stage: -1, label: "" };
  const stages = buildPipelineStages(slice, detail);
  const stage = currentStageIndex(stages);
  return { stage, label: stage >= 0 ? (stages[stage]?.label ?? "") : "" };
}

/**
 * Project the run's roadmap into the scene model — live, or at a historical
 * cursor.
 *
 * `detail === null` (nothing loaded, or a run switch in flight) yields the
 * loading model: no pads, zero counts, `loading: true`. The deck keeps the
 * previous pads on screen while that happens — that is the caller's job, not
 * this function's, because keeping state is exactly what a pure projection
 * must not do.
 *
 * History mode changes the projection's *status source* and nothing else: the
 * layout, the positions and the digest rules are the same code, so the world
 * cannot reflow when the operator scrubs (a pad's place is a function of the
 * roadmap's structure — `d02`'s hard rule — and the log never changes that).
 */
export function buildDeckModel(input: DeckInput): DeckModel {
  const detail = input.detail;
  const history: DeckHistoryInput | null = input.history;
  const cursor = history?.seq ?? null;
  if (!detail) return emptyModel(input);

  // The state at the cursor, from the log alone. `null` = live: the DTOs are
  // the truth and the ribbon is just an index.
  const snapshot: HistorySnapshot | null = history === null || cursor === null ? null : history.index.snapshotAt(cursor);
  const ribbon = history === null ? [] : [...history.index.buckets];
  const ribbonRecorded = history === null ? [] : [...history.index.recorded];
  const ribbonCursor = history === null || cursor === null ? -1 : (history.index.bucketAt(cursor)?.index ?? -1);

  const slices = detail.slices;
  // One status source for the whole projection. Two cases the log cannot
  // answer, both stated rather than guessed:
  //
  //  - the log mentions the slice but not yet at this cursor (the cursor is
  //    before its first event) → the log's initial state, `pending`;
  //  - the log never mentions the slice at all → it never changed inside the
  //    window, so its current DTO status *is* its state for the whole window
  //    (a slice skipped at parse time has no events, and reads `skipped`).
  const touched = history?.index.touched;
  const historicalStatus = (slice: SliceSummary): string => {
    const state = snapshot?.states.get(slice.id);
    if (state !== undefined) return state.status;
    return touched?.has(slice.id) === true ? "pending" : slice.status;
  };
  const viewSlices: SliceSummary[] =
    snapshot === null
      ? slices
      : slices.map((slice) => {
          const status = historicalStatus(slice);
          return status === slice.status ? slice : { ...slice, status };
        });
  const stateById = snapshot?.states ?? null;

  const layout = layoutDag(viewSlices);
  const positions = railPositions(layout);
  const byId = new Map(viewSlices.map((s) => [s.id, s]));
  const cycleIds = new Set(layout.cycleIds);
  // The shell fetches slice detail for the *selection*; it is used for nothing
  // but the stage index, and only for the slice it actually belongs to.
  const sliceDetail = input.sliceDetail;

  const agentById = new Map(input.agents.map((row) => [row.id, row]));
  const seqIndex = scanEvents(input.events);

  const nodes: RailNode[] = layout.nodes.map((n) => {
    const slice = byId.get(n.id);
    const position = positions.get(n.id) ?? { x: 0, y: 0, z: 0 };
    const state = stateById?.get(n.id);
    const stage =
      snapshot === null && slice ? stageFor(slice, sliceDetail?.sliceId === n.id ? sliceDetail : null) : { stage: -1, label: "" };
    return {
      id: n.id,
      title: n.title,
      status: n.status,
      attempts: state === undefined ? (snapshot === null ? (slice?.attempts ?? 0) : 0) : (state.attempt ?? 0),
      generation: state === undefined ? (snapshot === null ? (slice?.generation ?? 0) : 0) : state.generation,
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
      // The failure *reason* is a current-state field (`SliceSummary.reason` is
      // the server's latest derivation): history shows the state the log
      // recorded and leaves the explanation to the dock.
      reason: snapshot === null ? (slice?.reason ?? null) : null,
      alert: alertFor(n.status),
      seq: state === undefined ? (snapshot === null ? (seqIndex.bySlice.get(n.id) ?? 0) : 0) : state.seq,
      // No pad is "live" at a past cursor: the `live` flag is the dimming rule
      // for workers running *right now*, and dimming the workers that were
      // running in the past is the opposite of what history is for.
      live: snapshot === null ? isLiveStatus(n.status) : false,
      stage: stage.stage,
      stageLabel: stage.label,
      lane: snapshot === null ? (agentById.get(n.id)?.lane ?? null) : null,
      wedged: snapshot === null ? agentById.get(n.id)?.wedged === true : false,
    };
  });

  // Edges are projected from the roadmap's `deps` (the DTO the operator wrote),
  // by the same rule `layoutDag` uses, so the two can be compared — and are,
  // in `tests/deck-model.test.ts`. `satisfied` reads the mode's own statuses:
  // at a historical cursor an edge is as satisfied as it was then.
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
  const focusId = focusTarget(viewSlices, pinnedId);
  const primaryId = preferredSliceId(viewSlices);
  // Stations (`d04`): live only. A station's shaft is a *current* pipeline
  // stage; at a historical cursor the pads' own states carry "who was running"
  // and `historyActive` carries "how many", with no invented stage.
  const stationLayout =
    snapshot === null
      ? stationSlots(
          nodes.map((node) => ({ id: node.id, lane: node.lane })),
          liveSliceIds(viewSlices),
          input.maxStations,
        )
      : { stations: [], overflow: 0, warnings: [] as string[] };
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
  // from, minus what the operator has dismissed. They are *current* conditions
  // (a wedged worker, a stalled verdict): at a historical cursor they are
  // empty, because a past moment has no live alerts and inventing historical
  // ones would be a second alert policy.
  const derived =
    snapshot === null
      ? deriveAlerts({
          slices: viewSlices,
          agents: input.agents,
          events: input.events,
          sliceDetail,
          loops: detail.loops ?? [],
        })
      : [];
  const alerts = snapshot === null ? activeAlerts(derived, input.dismissed, detail.runId) : [];
  const beaconAlerts = alerts.slice(0, Math.max(0, Math.floor(input.maxBeacons)));

  // The temporal band's geometry (`d07`): the strip is laid out from the
  // *rail's* box (so its pitch and the deck's box cannot chase each other),
  // and the deck's box then grows to hold it. `bars` merges buckets past
  // `RIBBON_MAX_BARS`; the DOM strip still lists every one of them.
  const railBox = railBounds(positions.values());
  const bars = Math.min(ribbon.length, RIBBON_MAX_BARS);
  const pitch = bars === 0 ? 0 : ribbonPitch(railBox, bars);
  const bounds = withTemporalBand(railBox, bars * pitch);
  const ribbonRail: RibbonRail = {
    bars,
    pitch,
    x0: bars === 0 ? bounds.centerX : ribbonX(railBox, 0, bars),
    z: ribbonZ(bounds),
  };
  const wall = wallTiles(input, detail.runId, bounds);

  return {
    runId: detail.runId,
    live: input.live,
    loading: false,
    nodes,
    edges,
    counts: snapshot === null ? { ...detail.counts } : countStatuses(viewSlices.map((slice) => slice.status)),
    primaryId,
    liveIds: stations.map((station) => station.id),
    stations,
    stationOverflow: stationLayout.overflow,
    alerts,
    beaconAlerts,
    alertsOverflow: alerts.length - beaconAlerts.length,
    warnings: stationLayout.warnings,
    focusId,
    bounds,
    ribbon,
    ribbonRecorded,
    ribbonRail,
    ribbonCursor,
    historySeq: cursor,
    historyAt: snapshot?.at ?? null,
    historyActive: snapshot?.activeIds.length ?? 0,
    tiles: wall.tiles,
    tilesOverflow: wall.overflow,
    digest: digestOf(
      detail.runId,
      input.live,
      focusId,
      cursor,
      ribbonCursor,
      nodes,
      edges,
      stations,
      beaconAlerts,
      ribbon,
      ribbonRail,
      wall.tiles,
    ),
  };
}
