/**
 * The deck's focus rules and camera math (roadmap slice `d03`), tested without
 * a browser.
 *
 * Three claims are being proven here:
 *
 * 1. The focus target is a *rule*, not a layout intention: a pin wins, then the
 *    live primary (`lib/selection.ts`'s ranking, applied to the live set), then
 *    the overall primary. Nothing else can move it.
 * 2. The camera only ever lands on a state `applyCameraIntent` produced, with
 *    distance/elevation inside the renderer's clamps, and the framed station
 *    inside the frustum — checked against a real `three` camera, not a
 *    re-implementation of one.
 * 3. `lerpCamera` ends exactly on its endpoints, so a finished flight is the
 *    intent's own state and an interrupted one cannot drift.
 */

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import type { SliceSummary } from "../web/src/api.ts";
import { preferredSliceId } from "../web/src/lib/selection.ts";
import { frameForNode, liveSliceIds, focusFraming, focusTarget, nextLiveId, shaftSegments } from "../web/src/scene/focus.ts";
import {
  applyCameraIntent,
  CAMERA_LIMITS,
  edgeAnchor,
  EDGE_INSET,
  focusIntent,
  isDegradedView,
  lerpCamera,
  maxRetreatFor,
  offScreenIds,
  visibleSliceIds,
  type CameraState,
} from "../web/src/scene/camera.ts";
import { railBounds, railFraming, cameraPose } from "../web/src/scene/rail.ts";
import { CAMERA_FOV, DEFAULT_CAMERA } from "../web/src/scene/types.ts";

const AT = "2026-09-12T00:00:00.000Z";

function slice(id: string, status: string, extra: Partial<SliceSummary> = {}): SliceSummary {
  return { id, title: `Slice ${id}`, status, attempts: 1, updatedAt: AT, deps: [], generation: 1, verify: [], ...extra };
}

const ROADMAP: SliceSummary[] = [
  slice("a", "done"),
  slice("b", "done", { updatedAt: "2026-09-12T01:00:00.000Z" }),
  slice("c", "running"),
  slice("d", "pending"),
  slice("e", "verifying"),
  slice("f", "failed"),
  slice("g", "aborted"),
];

/** A 4×2 grid of stations, so visibility has something to include and exclude. */
const NODES = [
  { id: "n0", x: 0, z: 0 },
  { id: "n1", x: 5.52, z: 0 },
  { id: "n2", x: 11.04, z: 0 },
  { id: "n3", x: 16.56, z: 0 },
  { id: "n4", x: 0, z: 1.84 },
  { id: "n5", x: 5.52, z: 1.84 },
  { id: "n6", x: 11.04, z: 1.84 },
  { id: "n7", x: 16.56, z: 1.84 },
];

const BOUNDS = railBounds([{ x: 0, y: 0, z: 0 }, { x: 16.56, y: 0, z: 1.84 }]);

/** The renderer's own camera, from the same pose function the scene uses. */
function threeCamera(state: CameraState, aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, 0.1, 500);
  const pose = cameraPose(state);
  camera.position.set(pose.x, pose.y, pose.z);
  camera.lookAt(state.target.x, state.target.y, state.target.z);
  camera.updateMatrixWorld();
  return camera;
}

describe("liveSliceIds and the focus target", () => {
  test("live workers in board order — not lane order, not recency", () => {
    expect(liveSliceIds(ROADMAP)).toEqual(["c", "e"]);
    expect(liveSliceIds([slice("z", "running"), slice("y", "running")])).toEqual(["z", "y"]);
    expect(liveSliceIds(ROADMAP.filter((s) => s.status === "pending"))).toEqual([]);
  });

  test("a pin wins over everything, including a pin on a terminal slice", () => {
    expect(focusTarget(ROADMAP, "a")).toBe("a");
    expect(focusTarget(ROADMAP, "d")).toBe("d");
  });

  test("unpinned, the live primary wins; with nothing live, the overall primary does", () => {
    expect(focusTarget(ROADMAP, null)).toBe("c");
    expect(focusTarget(ROADMAP, null)).toBe(preferredSliceId(ROADMAP.filter((s) => s.status === "running" || s.status === "verifying")));

    const quiescent = [slice("a", "done"), slice("b", "failed"), slice("c", "pending")];
    expect(focusTarget(quiescent, null)).toBe("b"); // a failure still needs eyes
    const allDone = [slice("a", "done", { updatedAt: "2026-09-12T00:00:00.000Z" }), slice("b", "done", { updatedAt: "2026-09-12T02:00:00.000Z" })];
    expect(focusTarget(allDone, null)).toBe("b"); // most recently completed
    expect(focusTarget([], null)).toBeNull();
  });

  test("nextLiveId wraps, and enters a list it is not part of at the near end", () => {
    const ids = ["c", "e", "h"];
    expect(nextLiveId(ids, "c", 1)).toBe("e");
    expect(nextLiveId(ids, "h", 1)).toBe("c"); // wraps forward
    expect(nextLiveId(ids, "c", -1)).toBe("h"); // wraps backward
    expect(nextLiveId(ids, null, 1)).toBe("c");
    expect(nextLiveId(ids, null, -1)).toBe("h");
    expect(nextLiveId(ids, "a", 1)).toBe("c"); // a pin outside the live set
    expect(nextLiveId([], "c", 1)).toBeNull();
  });
});

describe("framing", () => {
  test("focus framing aims at the station, inside the renderer's clamps", () => {
    for (const aspect of [16 / 9, 1, 390 / 844]) {
      const framing = frameForNode({ x: 5.52, z: 1.84 }, aspect);
      expect(framing.target.x).toBe(5.52);
      expect(framing.target.z).toBe(1.84);
      expect(framing.distance).toBeGreaterThanOrEqual(CAMERA_LIMITS.minDistance);
      expect(framing.distance).toBeLessThanOrEqual(CAMERA_LIMITS.maxDistance);
      // The framed station is on screen, at every window shape.
      expect(visibleSliceIds(framing, NODES, aspect)).toContain("n5");
    }
  });

  test("focusIntent frames the focus target, and the rail when nothing is focused", () => {
    const model = { focusId: "n3", nodes: NODES, bounds: BOUNDS };
    expect(focusIntent(model, 1.6)).toEqual({ kind: "focus", node: { x: 16.56, z: 0 }, aspect: 1.6 });
    expect(focusIntent({ ...model, focusId: null }, 1.6).kind).toBe("rail");
    // A focus id that is not in this model (a stale pin) is not a crash.
    expect(focusIntent({ ...model, focusId: "gone" }, 1.6).kind).toBe("rail");
  });

  test("focusFraming returns null instead of inventing a framing", () => {
    expect(focusFraming(null, NODES, 1.6)).toBeNull();
    expect(focusFraming("missing", NODES, 1.6)).toBeNull();
    expect(focusFraming("n0", NODES, 1.6)?.target.x).toBe(0);
  });
});

describe("applyCameraIntent", () => {
  test("focus and rail intents are absolute; pan/zoom/orbit are relative and clamped", () => {
    const focused = applyCameraIntent(DEFAULT_CAMERA, { kind: "focus", node: { x: 3, z: 4 }, aspect: 1.6 });
    expect(focused).toEqual(frameForNode({ x: 3, z: 4 }, 1.6));
    expect(applyCameraIntent(DEFAULT_CAMERA, { kind: "rail", bounds: BOUNDS, aspect: 1.6 })).toEqual(railFraming(BOUNDS, 1.6));

    // Zoom in far enough and the clamp stops it, in both directions.
    let zoomed = DEFAULT_CAMERA;
    for (let i = 0; i < 60; i++) zoomed = applyCameraIntent(zoomed, { kind: "zoom", factor: 0.8 });
    expect(zoomed.distance).toBe(CAMERA_LIMITS.minDistance);
    for (let i = 0; i < 60; i++) zoomed = applyCameraIntent(zoomed, { kind: "zoom", factor: 1.25 });
    expect(zoomed.distance).toBe(CAMERA_LIMITS.maxDistance);

    const up = applyCameraIntent(DEFAULT_CAMERA, { kind: "orbit", dAzimuth: 0.3, dElevation: 10 });
    expect(up.azimuth).toBeCloseTo(DEFAULT_CAMERA.azimuth + 0.3, 10);
    expect(up.elevation).toBe(CAMERA_LIMITS.maxElevation);
    const down = applyCameraIntent(DEFAULT_CAMERA, { kind: "orbit", dAzimuth: 0, dElevation: -10 });
    expect(down.elevation).toBe(CAMERA_LIMITS.minElevation);
  });

  test("panning moves the target along the camera's floor basis", () => {
    const state: CameraState = { target: { x: 0, y: 0.35, z: 0 }, distance: 20, azimuth: 0, elevation: 0.5 };
    // Azimuth 0: screen-right is +X, forward (away from the camera) is −Z.
    const panned = applyCameraIntent(state, { kind: "pan", right: 2, forward: 3 });
    expect(panned.target.x).toBeCloseTo(2, 10);
    expect(panned.target.z).toBeCloseTo(-3, 10);
    expect(panned.target.y).toBe(state.target.y); // panning never leaves the floor
    expect(panned.distance).toBe(state.distance);
  });
});

describe("lerpCamera", () => {
  const a: CameraState = { target: { x: 0, y: 0, z: 0 }, distance: 10, azimuth: 0.2, elevation: 0.3 };
  const b: CameraState = { target: { x: 8, y: 1, z: -4 }, distance: 30, azimuth: 1.1, elevation: 0.9 };

  test("the endpoints are exact, and the middle is the middle", () => {
    expect(lerpCamera(a, b, 0)).toEqual(a);
    expect(lerpCamera(a, b, 1)).toEqual(b);
    const mid = lerpCamera(a, b, 0.5);
    expect(mid.target.x).toBeCloseTo(4, 10);
    expect(mid.distance).toBeCloseTo(20, 10);
    expect(mid.elevation).toBeCloseTo(0.6, 10);
    expect(lerpCamera(a, b, -5)).toEqual(a); // out-of-range t is clamped, not extrapolated
    expect(lerpCamera(a, b, 5)).toEqual(b);
  });

  test("azimuth takes the short way round", () => {
    const from: CameraState = { ...a, azimuth: 3.0 };
    const to: CameraState = { ...a, azimuth: -3.0 }; // 0.28 rad the short way, 6.0 the long way
    const mid = lerpCamera(from, to, 0.5);
    expect(Math.abs(mid.azimuth - 3.14)).toBeLessThan(0.1);
  });
});

describe("visibleSliceIds agrees with the renderer's own projection", () => {
  test("same membership as a real three camera, at three window shapes", () => {
    const states: CameraState[] = [
      railFraming(BOUNDS, 1.6),
      frameForNode({ x: 16.56, z: 0 }, 1.6),
      { target: { x: 8, y: 0.35, z: 1 }, distance: 7, azimuth: 2.4, elevation: 0.3 },
      DEFAULT_CAMERA,
    ];
    for (const aspect of [16 / 9, 1, 390 / 844]) {
      for (const state of states) {
        const camera = threeCamera(state, aspect);
        const mine = new Set(visibleSliceIds(state, NODES, aspect));
        for (const node of NODES) {
          const point = new THREE.Vector3(node.x, 0.35, node.z).project(camera);
          // Nodes sitting within 2 % of the frame edge are excluded: float
          // order decides them, and neither answer would be a bug.
          if (Math.abs(point.x) > 0.98 && Math.abs(point.x) < 1.02) continue;
          if (Math.abs(point.y) > 0.98 && Math.abs(point.y) < 1.02) continue;
          const theirs = Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && point.z <= 1;
          expect(`${state.azimuth}@${aspect} ${node.id}:${mine.has(node.id)}`).toBe(`${state.azimuth}@${aspect} ${node.id}:${theirs}`);
        }
      }
    }
  });
});

describe("edgeAnchor and offScreenIds: where an off-screen worker points", () => {
  const states: CameraState[] = [
    railFraming(BOUNDS, 1.6),
    frameForNode({ x: 16.56, z: 0 }, 1.6),
    { target: { x: 8, y: 0.35, z: 1 }, distance: 7, azimuth: 2.4, elevation: 0.3 },
  ];

  test("offScreenIds is exactly the complement of visibleSliceIds", () => {
    for (const state of states) {
      const visible = new Set(visibleSliceIds(state, NODES, 1.6));
      const hidden = offScreenIds(state, NODES, 1.6);
      expect(hidden).toEqual(NODES.filter((node) => !visible.has(node.id)).map((node) => node.id));
    }
  });

  test("an on-screen node anchors at its own projection; an off-screen one at the frame", () => {
    for (const state of states) {
      const camera = threeCamera(state, 1.6);
      const hidden = new Set(offScreenIds(state, NODES, 1.6));
      for (const node of NODES) {
        const anchor = edgeAnchor(state, node, 1.6);
        const point = new THREE.Vector3(node.x, 0.35, node.z).project(camera);
        if (!hidden.has(node.id)) {
          expect(anchor.x).toBeCloseTo(point.x * 0.5 + 0.5, 3);
          expect(anchor.y).toBeCloseTo(0.5 - point.y * 0.5, 3);
          expect(anchor.behind).toBe(false);
          continue;
        }
        // Off screen: inside the viewport, on the edge band the inset defines,
        // and on the side the node actually is.
        expect(anchor.x).toBeGreaterThan(0);
        expect(anchor.x).toBeLessThan(1);
        expect(anchor.y).toBeGreaterThan(0);
        expect(anchor.y).toBeLessThan(1);
        const down = Math.max(Math.abs(anchor.x - 0.5), Math.abs(anchor.y - 0.5));
        expect(down).toBeGreaterThan(0.5 - EDGE_INSET - 0.02);
        expect(Math.sign(anchor.x - 0.5)).toBe(Math.sign(point.x) || 1);
      }
    }
  });

  test("a node behind the camera anchors on the side the operator must turn to", () => {
    // Looking from +z toward -z (`azimuth` 0), so camera right *is* world +x.
    const away: CameraState = { target: { x: 0, y: 0.35, z: 0 }, distance: 20, azimuth: 0, elevation: 0.12 };
    const inFrontRight = edgeAnchor(away, { x: 10, z: -10 }, 1.6);
    const behindRight = edgeAnchor(away, { x: 10, z: 30 }, 1.6);
    const behindLeft = edgeAnchor(away, { x: -10, z: 30 }, 1.6);
    expect(inFrontRight.behind).toBe(false);
    expect(inFrontRight.x).toBeGreaterThan(0.5);
    // Behind the lens there is no projection, so the marker is the antipode of
    // the camera-space direction: behind-right is still "turn right".
    expect(behindRight.behind).toBe(true);
    expect(behindRight.x).toBeGreaterThan(0.5);
    expect(behindLeft.behind).toBe(true);
    expect(behindLeft.x).toBeLessThan(0.5);
    for (const anchor of [behindRight, behindLeft]) {
      expect(anchor.x).toBeGreaterThanOrEqual(0);
      expect(anchor.x).toBeLessThanOrEqual(1);
      expect(anchor.y).toBeGreaterThanOrEqual(0);
      expect(anchor.y).toBeLessThanOrEqual(1);
    }
  });
});

describe("the station shaft", () => {
  test("monotone in the stage, empty for no phase, full at the last stage", () => {
    expect(shaftSegments(-1)).toBe(0);
    const values = [0, 1, 2, 3, 4, 5, 6].map(shaftSegments);
    expect(values[0]).toBeGreaterThan(0);
    expect(values[6]).toBe(4);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    // Out-of-range input (a future pipeline with more or fewer steps) stays bounded.
    expect(shaftSegments(99)).toBe(4);
  });
});

describe("ux02 camera safety: degenerate states are unreachable, recovery is one key", () => {
  test("elevation never drops to edge-on, even under repeated orbit", () => {
    let state = DEFAULT_CAMERA;
    for (let i = 0; i < 20; i++) state = applyCameraIntent(state, { kind: "orbit", dAzimuth: 0, dElevation: -1 });
    expect(state.elevation).toBeGreaterThanOrEqual(0.35);
    expect(state.elevation).toBe(CAMERA_LIMITS.minElevation);
  });

  test("bounded pan stays on the rail; unbounded pan keeps legacy behaviour", () => {
    const state: CameraState = { target: { x: 0, y: 0.35, z: 0 }, distance: 20, azimuth: 0, elevation: 0.5 };
    const bounded = applyCameraIntent(state, { kind: "pan", right: 1000, forward: 1000, bounds: BOUNDS });
    const margin = Math.min(BOUNDS.width, BOUNDS.depth) * 0.5 + 6;
    expect(Math.abs(bounded.target.x - BOUNDS.centerX)).toBeLessThanOrEqual(margin);
    expect(Math.abs(bounded.target.z - BOUNDS.centerZ)).toBeLessThanOrEqual(margin);
    const legacy = applyCameraIntent(state, { kind: "pan", right: 1000, forward: 0 });
    expect(legacy.target.x).toBeCloseTo(1000, 10);
  });
  test("bounded zoom retreats no farther than 1.6x the rail fit", () => {
    const ceiling = maxRetreatFor(BOUNDS, 1.6);
    let state = DEFAULT_CAMERA;
    for (let i = 0; i < 60; i++) state = applyCameraIntent(state, { kind: "zoom", factor: 1.25, maxDistance: ceiling });
    expect(state.distance).toBe(ceiling);
    expect(ceiling).toBeLessThan(CAMERA_LIMITS.maxDistance);
  });

  test("isDegradedView fires when focus leaves or the live set is lost, never on a healthy frame", () => {
    const healthy = railFraming(BOUNDS, 1.6);
    expect(isDegradedView(healthy, { focusId: "n5", liveIds: ["n4", "n5"], nodes: NODES }, 1.6)).toBe(false);
    expect(isDegradedView(healthy, { focusId: "n5", liveIds: [], nodes: NODES }, 1.6)).toBe(false);
    const lost: CameraState = { target: { x: 1000, y: 0.35, z: 1000 }, distance: 20, azimuth: 0, elevation: 0.5 };
    expect(isDegradedView(lost, { focusId: "n5", liveIds: ["n4", "n5"], nodes: NODES }, 1.6)).toBe(true);
  });
});
