/**
 * Camera state transitions for the deck (roadmap slice `d03`) — pure math.
 *
 * The renderer applies a `CameraState`; it never decides one. Every intent
 * (frame a station, fit the rail, pan, zoom, orbit) lands here, so the clamps
 * and the animation are testable without a WebGL context, and the camera can
 * only ever be in a state this module produced.
 *
 * `CameraState` is the existing `DeckCamera` struct — one camera
 * representation for the renderer, the framing functions and the specs.
 *
 * Pure module: no `three`, no DOM.
 */

import { railFraming } from "./rail.ts";
import { frameForNode } from "./focus.ts";
import { CAMERA_FOV, type DeckCamera, type DeckModel } from "./types.ts";

export type CameraState = DeckCamera;

export type CameraIntent =
  /** `command`: over the shoulder onto one station. */
  | { kind: "focus"; node: { x: number; z: number }; aspect: number }
  /** `rail`: fit the whole roadmap. */
  | { kind: "rail"; bounds: DeckModel["bounds"]; aspect: number }
  /** Operator pan, in world units along the camera's floor basis. */
  | { kind: "pan"; right: number; forward: number }
  | { kind: "zoom"; factor: number }
  | { kind: "orbit"; dAzimuth: number; dElevation: number };

/** Clamps shared by every intent; the renderer's near/far planes are 0.1/500. */
export const CAMERA_LIMITS = {
  minDistance: 6,
  maxDistance: 400,
  minElevation: 0.12,
  maxElevation: 1.45,
  /** How far past the rail's box a pan may go before it stops. */
  panMargin: 12,
} as const;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Pad mid-height, matching `focus.ts`'s framing eye and the renderer's pads. */
const PAD_EYE_Y = 0.35;

/** Shortest signed angular difference, so a lerp never spins the long way. */
function wrapAngle(delta: number): number {
  const turn = Math.PI * 2;
  const wrapped = ((delta + Math.PI) % turn + turn) % turn;
  return wrapped - Math.PI;
}

/**
 * The intent the deck dispatches when the world changes shape or focus moves:
 * `command` framing on the focus target, `rail` when there is nothing to frame.
 * Pure, so "the camera follows the worker" is a unit test, not a browser test.
 */
export function focusIntent(
  model: { focusId: string | null; nodes: readonly { id: string; x: number; z: number }[]; bounds: DeckModel["bounds"] },
  aspect: number,
): CameraIntent {
  const node = model.focusId === null ? undefined : model.nodes.find((candidate) => candidate.id === model.focusId);
  return node === undefined
    ? { kind: "rail", bounds: model.bounds, aspect }
    : { kind: "focus", node: { x: node.x, z: node.z }, aspect };
}

/**
 * One intent applied to a camera state. Focus and rail intents are absolute
 * (they ignore the current state, because that is what "frame this" means);
 * pan/zoom/orbit are relative to it. Every result is clamped.
 */
export function applyCameraIntent(state: CameraState, intent: CameraIntent): CameraState {
  switch (intent.kind) {
    case "focus":
      return frameForNode(intent.node, intent.aspect);
    case "rail":
      return railFraming(intent.bounds, intent.aspect);
    case "zoom":
      return { ...state, distance: clamp(state.distance * intent.factor, CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance) };
    case "orbit":
      return {
        ...state,
        azimuth: state.azimuth + intent.dAzimuth,
        elevation: clamp(state.elevation + intent.dElevation, CAMERA_LIMITS.minElevation, CAMERA_LIMITS.maxElevation),
      };
    case "pan":
      return { ...state, target: panTarget(state, intent.right, intent.forward) };
  }
}

/**
 * Move the target along the camera's own floor basis: `right` is the view's
 * screen-right flattened onto the floor, `forward` the view's look direction
 * flattened. Panning therefore tracks the arrow keys at any azimuth, which is
 * how the operator reads it. (Basis = three's `lookAt`: `z = eye − target`,
 * `x = normalize(cross(up, z))`, `y = cross(z, x)`.)
 */
function panTarget(state: CameraState, right: number, forward: number): { x: number; y: number; z: number } {
  const sinA = Math.sin(state.azimuth);
  const cosA = Math.cos(state.azimuth);
  // screen-right = (cosA, 0, −sinA); look direction = (−sinA, 0, −cosA)
  return {
    x: state.target.x + cosA * right - sinA * forward,
    y: state.target.y,
    z: state.target.z - sinA * right - cosA * forward,
  };
}

/**
 * The interpolation step for a camera in flight. `t` is already eased by the
 * caller. The endpoints are returned exactly (not just approximately) so a
 * finished animation is the intent's own state, and `lerpCamera(a, b, 0)`
 * cannot drift.
 */
export function lerpCamera(a: CameraState, b: CameraState, t: number): CameraState {
  if (t <= 0) return { ...a, target: { ...a.target } };
  if (t >= 1) return { ...b, target: { ...b.target } };
  const mix = (from: number, to: number): number => from + (to - from) * t;
  return {
    target: { x: mix(a.target.x, b.target.x), y: mix(a.target.y, b.target.y), z: mix(a.target.z, b.target.z) },
    distance: mix(a.distance, b.distance),
    azimuth: a.azimuth + wrapAngle(b.azimuth - a.azimuth) * t,
    elevation: mix(a.elevation, b.elevation),
  };
}

/**
 * Which slice ids a camera can see, from the same basis the renderer uses
 * (`cameraPose` + the shared FOV): a node is visible when its pad centre
 * projects inside the frustum and in front of the camera.
 *
 * `d04` builds its off-screen markers on this; `d03` uses it to prove the
 * focused station is on screen after an auto-frame.
 */
export function visibleSliceIds(
  state: CameraState,
  nodes: readonly { id: string; x: number; z: number }[],
  aspect: number,
): string[] {
  const fitAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfY = (CAMERA_FOV * Math.PI) / 360;
  const tanY = Math.tan(halfY);
  const tanX = tanY * fitAspect;

  const cosE = Math.cos(state.elevation);
  const sinE = Math.sin(state.elevation);
  const sinA = Math.sin(state.azimuth);
  const cosA = Math.cos(state.azimuth);
  const eye = {
    x: state.target.x + state.distance * cosE * sinA,
    y: state.target.y + state.distance * sinE,
    z: state.target.z + state.distance * cosE * cosA,
  };
  // Camera-space basis, matching three's `lookAt` exactly:
  //   z = normalize(eye − target), x = normalize(cross(up, z)), y = cross(z, x)
  // with up = +Y. Closed forms (the camera's own constants are the only inputs).
  const fx = -cosE * sinA;
  const fy = -sinE;
  const fz = -cosE * cosA;
  const rx = cosA;
  const rz = -sinA;
  const ux = -sinE * sinA;
  const uy = cosE;
  const uz = -sinE * cosA;

  const visible: string[] = [];
  for (const node of nodes) {
    const dx = node.x - eye.x;
    const dy = PAD_EYE_Y - eye.y;
    const dz = node.z - eye.z;
    const depth = dx * fx + dy * fy + dz * fz;
    if (depth <= 0.1 || depth >= 500) continue;
    const x = dx * rx + dz * rz;
    const y = dx * ux + dy * uy + dz * uz;
    if (Math.abs(x) <= depth * tanX && Math.abs(y) <= depth * tanY) visible.push(node.id);
  }
  return visible;
}
