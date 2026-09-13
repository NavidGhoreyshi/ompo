/**
 * "What is in front of the operator" for the deck (roadmap slice `d03`) — pure.
 *
 * One module decides which worker the surface presents as primary, which live
 * workers exist and in what order, and where the `command` framing puts the
 * camera. It reads the same two rules the dashboard reads (`isLiveStatus`,
 * `preferredSliceId`) and invents no third ranking: a worker is live because
 * `web/src/lib/selection.ts` says so, and the primary among live workers is
 * the same slice the TUI's cursor would land on.
 *
 * Pure module: no `three`, no DOM, no state.
 */

import type { SliceSummary } from "../api.ts";
import { isLiveStatus, preferredSliceId } from "../lib/selection.ts";
import { PAD_D, PAD_W } from "./rail.ts";
import { CAMERA_FOV, type DeckCamera } from "./types.ts";

/** The two `status` strings `preferredSliceId` ranks first, via `lib`'s rule. */
type SliceLike = Pick<SliceSummary, "id" | "status" | "updatedAt">;

/**
 * World units the camera keeps beside a framed station: the station is never
 * edge-to-edge, and its neighbours stay legible in the same frame.
 */
export const LIVE_FRAME_UNITS = 8;

/** `command` framing looks slightly flatter than the `rail` preset. */
const FRAME_ELEVATION = 0.55;
const FRAME_AZIMUTH = Math.PI / 4;
/** Pad mid-height — what the framing aims at, matching the renderer's pads. */
const FRAME_EYE_Y = 0.35;
/** Framing clamps, shared with the renderer's near/far planes (0.1 / 500). */
const MIN_DISTANCE = 6;
const MAX_DISTANCE = 400;

/**
 * The live workers, in roadmap order (the order `detail.slices` arrives in).
 * Board order — not lane order, not recency — is the tie-break the rest of the
 * app already uses, so the deck's lane strip and `[`/`]` cycle agree with the
 * dashboard's lanes without a second sort.
 */
export function liveSliceIds(slices: readonly SliceLike[]): string[] {
  return slices.filter((slice) => isLiveStatus(slice.status)).map((slice) => slice.id);
}

/**
 * The worker the operator should be looking at: the pin when one is set, else
 * the primary among live workers, else the overall primary (`preferredSliceId`
 * already ranks a failed slice above a done one, which is what "needs eyes"
 * means on a quiescent run).
 *
 * `agents` is deliberately not an input: wedged/stale workers are alerts
 * (`d05`), and letting them move the focus here would be a second ranking.
 */
export function focusTarget(slices: readonly SliceLike[], pinnedId: string | null): string | null {
  if (pinnedId !== null) return pinnedId;
  const live = slices.filter((slice) => isLiveStatus(slice.status));
  return preferredSliceId(live.length > 0 ? live : [...slices]);
}

/**
 * The next (`step` > 0) or previous live worker from `from`, wrapping. A
 * `from` that is not live (a pin on a terminal slice, a fresh deck) enters the
 * list at the near end rather than jumping to a neighbour; no live workers
 * yields `null`, and the caller keeps its current focus.
 */
export function nextLiveId(ids: readonly string[], from: string | null, step: number): string | null {
  if (ids.length === 0) return null;
  const index = from === null ? -1 : ids.indexOf(from);
  if (index < 0) return ids[step < 0 ? ids.length - 1 : 0]!;
  const delta = step < 0 ? ids.length - 1 : 1;
  return ids[(index + delta) % ids.length]!;
}

/**
 * `command` framing: an over-the-shoulder view of one station. The fit is
 * analytic over the station's own box in the camera's basis (the same method
 * as `railFraming`), so the station plus `LIVE_FRAME_UNITS` beside it fills the
 * frame at any window shape, and the distance stays inside the renderer's
 * clamps.
 *
 * `bounds` keeps the azimuth/elevation choice honest for an empty (zero-size)
 * rail: the framing never depends on the rail's extent, only on the station.
 */
export function frameForNode(node: { x: number; z: number }, aspect: number): DeckCamera {
  const fitAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfY = (CAMERA_FOV * Math.PI) / 360;
  const halfX = Math.atan(Math.tan(halfY) * fitAspect);
  // The station's own footprint (pads are the widest thing it draws).
  const halfRight = Math.abs(Math.cos(FRAME_AZIMUTH)) * (PAD_W / 2) + Math.abs(Math.sin(FRAME_AZIMUTH)) * (PAD_D / 2);
  const halfUp = Math.abs(Math.sin(FRAME_ELEVATION)) * (PAD_W / 2);
  const fit = Math.max(halfRight / Math.tan(halfX), halfUp / Math.tan(halfY));
  return {
    target: { x: node.x, y: FRAME_EYE_Y, z: node.z },
    distance: Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, fit + LIVE_FRAME_UNITS)),
    azimuth: FRAME_AZIMUTH,
    elevation: FRAME_ELEVATION,
  };
}

/**
 * The framing for a focus target, from the model's own node list: `command`
 * on the node, or `null` when nothing is framed (the caller falls back to the
 * `rail` preset).
 */
export function focusFraming(
  focusId: string | null,
  nodes: readonly { id: string; x: number; z: number }[],
  aspect: number,
): DeckCamera | null {
  if (focusId === null) return null;
  const node = nodes.find((candidate) => candidate.id === focusId);
  return node === undefined ? null : frameForNode(node, aspect);
}

/**
 * Filled segments of a station's shaft: the pipeline's seven steps compressed
 * onto `SEGMENTS` marks, so every step is visible but the shaft never grows
 * with the pipeline's length. `-1` (no observed phase) fills nothing.
 */
export const SHAFT_SEGMENTS = 4;
const PIPELINE_STEPS = 7;

export function shaftSegments(stage: number): number {
  if (stage < 0) return 0;
  return Math.min(SHAFT_SEGMENTS, Math.max(1, Math.ceil(((stage + 1) / PIPELINE_STEPS) * SHAFT_SEGMENTS)));
}