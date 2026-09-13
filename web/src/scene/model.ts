/**
 * The deck's scene model (roadmap slice `d02`).
 *
 * `buildDeckModel` is a deterministic projection of application state into
 * presentation data: DTOs in, an immutable `DeckModel` out. It owns no state,
 * reads no clock, touches no DOM, and returns a new object every call — two
 * calls with the same input are `JSON.stringify`-equal, which is what makes the
 * rail's stability testable. Everything the scene draws is in this file's
 * output; there is no second path from state to pixels.
 *
 * Reuse, not re-derivation (M1): the layout, its depths, ready/blocked flags,
 * cycle membership, dependency satisfaction and the "which slice needs eyes"
 * ranking all come from `web/src/lib/**`. This file only decides which of those
 * values the scene is allowed to see, and joins them with the DTO fields the
 * overlay needs.
 *
 * Pure module: no `three`, no DOM, no fetching.
 */

import { depSatisfied, layoutDag } from "../lib/dag.ts";
import { buildPipelineStages, currentStageIndex } from "../lib/pipeline.ts";
import { isLiveStatus, preferredSliceId } from "../lib/selection.ts";
import { focusTarget, liveSliceIds } from "./focus.ts";
import { railBounds, railPositions } from "./rail.ts";
import type { SliceDetail, SliceSummary } from "../api.ts";
import type {
  AlertKind,
  DeckCounts,
  DeckInput,
  DeckModel,
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
      live: isLiveStatus(n.status),
      stage: stage.stage,
      stageLabel: stage.label,
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
  return {
    runId: detail.runId,
    live: input.live,
    loading: false,
    nodes,
    edges,
    counts: { ...detail.counts },
    primaryId: preferredSliceId(slices),
    liveIds: liveSliceIds(slices),
    focusId,
    bounds: railBounds(positions.values()),
    digest: digestOf(detail.runId, input.live, focusId, nodes, edges),
  };
}
