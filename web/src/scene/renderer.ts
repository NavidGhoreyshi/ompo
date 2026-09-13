/**
 * The deck's WebGL2 renderer (roadmap slices `d01`–`d04`) — the **only**
 * module in the repository that imports `three` (asserted by
 * `tests/release-gate.test.ts`).
 *
 * It owns a scene graph and nothing else: no DTOs, no fetching, no derivation.
 * Its whole input is a `DeckModel` (plain arrays, built by `model.ts`), and the
 * only state it keeps is the model it drew last — used to look up the pad under
 * the pointer and to move the selection ring, never to decide anything.
 *
 * `d02` draws the roadmap rail with the cheapest primitives that carry the
 * information: pads and their alert markers are two instanced meshes, all
 * dependency edges are one vertex-coloured `LineSegments`, ghosts/cycles are one
 * more, and the selection is one line loop. `d04` adds the station pool: the
 * same three instanced meshes plus one for every live worker's stage marks,
 * sized once for the largest tier. No lights (`MeshBasicMaterial`), no textures,
 * no post-processing, no in-canvas text (CP-3), no per-frame work: a model
 * change rewrites buffers and requests one frame, and nothing else touches the
 * GPU.
 *
 * `info()` returns one object that is mutated in place: the per-frame path must
 * not allocate, and callers that keep it must copy it.
 */

import * as THREE from "three";
import { SEVERITY_RINGS, type AlertSeverity, type DeckAlert, type DeckAlertKind } from "./alerts.ts";
import { cueEntity, type SceneDelta } from "./deltas.ts";
import { TIER_BUDGETS, type QualityTier } from "./tier.ts";
import { cameraPose, gridPlan, PAD_D, PAD_W, RING_MARGIN } from "./rail.ts";
import { SHAFT_SEGMENTS, shaftSegments } from "./focus.ts";
import { CAMERA_FOV, type DeckCamera, type DeckModel, type RailNode, type RenderStats } from "./types.ts";

export interface DeckRenderer {
  /**
   * Diff-apply a model, then turn `deltas` into transitions. Returns false when
   * the digest was already drawn (in which case no cue is created either — the
   * scene is already showing that state).
   *
   * The state itself is applied **first and unconditionally**: colour, height,
   * marks and beacons are the model's values from this call onward, and a cue
   * only adds a decaying highlight on top. There is no path where the scene
   * says "verifying" while the model says "running".
   */
  applyModel(model: DeckModel, deltas?: readonly SceneDelta[]): boolean;
  setCamera(state: DeckCamera): void;
  /** Pointer feedback: the pad under the cursor, or `null`. View state only. */
  setHover(nodeId: string | null): void;
  /** Screen-space pick: NDC in, slice id out (`null` when no pad is there). */
  pick(ndcX: number, ndcY: number): string | null;
  /** Canvas-relative CSS pixels of a world point, or `null` when it is off screen. */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
  setSize(cssWidth: number, cssHeight: number): void;
  /**
   * Re-read a tier's budget (resolution scale, caps) and re-apply the size.
   * `antialias` is fixed at context creation, so the caller re-creates the
   * renderer only when that bit changes — not on every tier change.
   */
  setTier(tier: QualityTier): void;
  render(): RenderStats;
  info(): RenderStats;
  /** True while a transition cue or the intro fade still wants frames. */
  animating(): boolean;
  /** Digest of the last model handed to `applyModel` ("" before the first). */
  appliedDigest(): string;
  dispose(): void;
  disposed(): boolean;
}

export interface DeckRendererOptions {
  reducedMotion?: boolean;
  /** Clock injection: the fade and fps sampling are deterministic in tests. */
  now?: () => number;
}

/**
 * `UNMASKED_RENDERER_WEBGL` from a throwaway context, or `null` when this
 * device has no WebGL2 at all (the caller shows the flat notice instead of a
 * canvas — `d09` builds the full fallback).
 */
export function probeRendererString(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return null;
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const value = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof value === "string" && value.length > 0 ? value : "";
  } catch {
    return null;
  }
}

/** Theme tokens → scene colours; the values are `tokens.css`'s fallbacks. */
const TOKEN_FALLBACKS = {
  info: 0x35d6f2,
  success: 0x3ee6a6,
  warning: 0xffb838,
  destructive: 0xff6b6b,
  muted: 0x8595a8,
  ring: 0x8f86ff,
} satisfies Record<string, number>;

type TokenName = keyof typeof TOKEN_FALLBACKS;

const TOKEN_VARS: Record<TokenName, string> = {
  info: "--info",
  success: "--success",
  warning: "--warning",
  destructive: "--destructive",
  muted: "--muted-foreground",
  ring: "--ring",
};

/**
 * Read the dashboard's status tokens once, at renderer creation (CP-3: the
 * scene uses the operator's palette, not a second one). A token that is missing
 * falls back to its `tokens.css` value — a failed stylesheet must not paint the
 * rail black.
 */
function readTokens(): Record<TokenName, THREE.Color> {
  const computed = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
  const out = {} as Record<TokenName, THREE.Color>;
  for (const name of Object.keys(TOKEN_FALLBACKS) as TokenName[]) {
    const raw = computed?.getPropertyValue(TOKEN_VARS[name]).trim() ?? "";
    out[name] = new THREE.Color(raw.length > 0 ? raw : TOKEN_FALLBACKS[name]);
  }
  return out;
}

/** Pad height and colour per roadmap status — the non-colour encoding. */
const PAD_STYLES: Record<string, { token: TokenName; height: number }> = {
  running: { token: "info", height: 0.85 },
  verifying: { token: "info", height: 0.85 },
  done: { token: "success", height: 0.4 },
  failed: { token: "destructive", height: 0.2 },
  aborted: { token: "destructive", height: 0.2 },
  "blocked-env": { token: "warning", height: 0.2 },
  blocked: { token: "warning", height: 0.2 },
  skipped: { token: "muted", height: 0.06 },
  pending: { token: "muted", height: 0.1 },
};

const DEFAULT_PAD_STYLE = { token: "muted" as TokenName, height: 0.1 };

/** Alert markers: one pole for `failed`, a second for `blocked-env`. */
const MARKER_W = 0.08;
const MARKER_H = 0.85;
const MARKER_OFFSET = 0.22;

/**
 * Alert beacons (`d05`): a flat ring on the floor around the affected pad,
 * drawn from one instanced mesh. This is the alert's **non-colour** channel:
 * severity is the ring count (high: two concentric rings, medium: one,
 * advisory: one, nested and dimmer) — a pattern that survives greyscale and a
 * screenshot, while the DOM stack carries the words.
 *
 * The ring is wider than the pad's footprint (half-diagonal ≈ 1.83 world
 * units) so it is never hidden under a pad, and it sits just above the floor.
 * No pulse animation: a steady scene with a legible pattern beats a scene that
 * never stops moving (and an idle deck must keep drawing zero frames).
 */
const BEACON_INNER = 2.0;
const BEACON_OUTER = 2.34;
const BEACON_Y = 0.03;
/** Advisory's ring is nested inside the standard one, and dimmed. */
const BEACON_ADVISORY_SCALE = 0.94;
const BEACON_RING_STEP = 1.22;
const BEACON_SEGMENTS = 24;
/** Ring colour per alert kind. Redundant with the ring count and the text. */
const BEACON_TOKENS: Record<DeckAlertKind, TokenName> = {
  failed: "destructive",
  "blocked-env": "warning",
  wedged: "warning",
  "double-loop": "destructive",
  "verify-failed": "warning",
  "review-rejected": "ring",
  "verdict-stall": "muted",
};
/** Brightness per severity: a third, redundant channel on top of count and text. */
const BEACON_DIM: Record<AlertSeverity, number> = { high: 1, medium: 0.85, advisory: 0.55 };
/**
 * Beacon pool: every tier's cap, two rings each. Allocated once, like the
 * station pool — an alert arriving never allocates a mesh.
 */
const BEACON_POOL = TIER_BUDGETS.high.maxBeacons * 2;

/**
 * Transition cue durations (`d05`), per tier: `d00`'s minimal tier stays at or
 * below the 200 ms it budgeted, the others at the roadmap's ≤ 400 ms. Reduced
 * motion is 0 — the renderer then creates no cues at all, so `stats.tweens` is
 * exactly 0 rather than "an animation that completed instantly".
 */
const CUE_MS: Record<QualityTier, number> = { minimal: 200, standard: 320, high: 320 };
/** Cues alive at once. Transitions are rare; past this the oldest is dropped. */
const CUE_CAP = 48;
/** A cue's start scale (beacons grow in, a cleared one shrinks out). */
const CUE_START_SCALE = 0.42;
/** A newly filled stage mark stands this fraction of its height on arrival. */
const CUE_MARK_SCALE = 0.35;
/** How far a status change lerps the pad toward the focus token at t=0. */
const CUE_PULSE = 0.5;
/** The scene's clear colour: a cleared beacon fades toward it (a floor fade). */
const BEACON_FLOOR = 0x0a0e14;

/**
 * Stations (`d03`–`d04`): one short box per filled stage mark, standing on the
 * worker's own pad. Geometry, not text (CP-3), instanced into one draw call
 * whose capacity is fixed at creation. Every live worker draws from this one
 * pool — a worker joining, leaving, or becoming the focus rewrites instances,
 * it never creates a mesh, and the instance count does not depend on which
 * worker is focused (focus is brightness, not geometry).
 */
const STATION_W = 0.2;
const STATION_H = 0.24;
const STATION_GAP = 0.09;
/** Overflow: marks stacked beside the last station, one per hidden worker. */
const STATION_STACK_CAP = 4;
const STATION_STACK_H = 0.13;
/**
 * Pool capacity: the most stations any tier can draw, times the marks per
 * station, plus the overflow stack. The tier's `maxStations` caps what is
 * *drawn* (the model decides that); this allocation happens once.
 */
const STATION_POOL = TIER_BUDGETS.high.maxStations * SHAFT_SEGMENTS + STATION_STACK_CAP;

/**
 * How much a live pad that is *not* the focus recedes. Colour only: height
 * already encodes status, and dimming a running pad's height would make
 * "secondary" look like "less alive" — decoration must never overwrite
 * information.
 */
const SECONDARY_DIM = 0.6;

/** Station material per live phase (the pad keeps the roadmap's status colour). */
const STATION_TOKENS: Record<string, TokenName> = { running: "info", verifying: "warning" };

/** Edges: sampled arcs, dashed by emitting every other segment. */
const EDGE_SEGMENTS = 8;
const EDGE_ARC = 0.08;
const EDGE_ARC_MIN = 0.08;
const EDGE_ARC_MAX = 0.7;

const PAD_CAPACITY = 32;
const MARKER_CAPACITY = 16;
const LINE_CAPACITY = 1024;
const FADE_MS = 200;

interface InstanceBuffer {
  mesh: THREE.InstancedMesh;
  capacity: number;
  count: number;
}

interface LineBuffer {
  mesh: THREE.LineSegments;
  positions: Float32Array;
  colours: Float32Array;
  capacity: number;
  /** Vertices written by the last `applyModel`. */
  written: number;
}

/**
 * One transition in flight (`d05`). A cue is *presentation only*: it never
 * holds the state to be shown, it holds how far the highlight has decayed.
 * The entity it belongs to is the key, so a worker changing state twice in a
 * second gets one cue at the newer target — the roadmap's interruption rule,
 * with no queue to grow.
 */
export type CueKind = "pulse" | "marks" | "beacon-in" | "beacon-out";

interface Cue {
  kind: CueKind;
  /** The slice this cue is about (what `animatedEntities` counts). */
  id: string;
  start: number;
  durationMs: number;
  /** `marks`: filled marks the station had before the transition. */
  fromMarks?: number;
  /** `beacon-out`: where the ring stood and what it looked like. */
  x?: number;
  z?: number;
  y?: number;
  scale?: number;
  colour?: THREE.Color;
  rings?: number;
}

export function createDeckRenderer(canvas: HTMLCanvasElement, tier: QualityTier, options: DeckRendererOptions = {}): DeckRenderer {
  const now = options.now ?? (() => performance.now());
  let budget = TIER_BUDGETS[tier];

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: budget.antialias,
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
  });
  // The `d00` budget is denominated in backing-store pixels, so the ratio is
  // fixed at 1 and the tier's scale is applied in `setSize` instead.
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x0a0e14, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 500);
  const cameraTarget = new THREE.Vector3();
  const tokens = readTokens();

  // One finitely sized grid: lines are 1 px wide, cover a bounded area, and
  // never shade the whole viewport (no full-screen layer anywhere in the deck).
  // Its scale follows the rail (`gridPlan`), so the floor keeps a fixed world
  // cell and covers any run with a bounded number of lines.
  const createGrid = (size: number, divisions: number): THREE.GridHelper => {
    const helper = new THREE.GridHelper(size, divisions, 0x3b536b, 0x22303d);
    const material = helper.material as THREE.LineBasicMaterial;
    material.transparent = true;
    material.opacity = 0;
    helper.position.y = -0.01;
    return helper;
  };
  let grid = createGrid(40, 8);
  let gridMaterial = grid.material as THREE.LineBasicMaterial;
  let gridDivisions = 8;
  let gridVertices = grid.geometry.getAttribute("position").count;
  scene.add(grid);

  const padGeometry = new THREE.BoxGeometry(PAD_W, 1, PAD_D);
  padGeometry.translate(0, 0.5, 0);
  const markerGeometry = new THREE.BoxGeometry(MARKER_W, 1, MARKER_W);
  markerGeometry.translate(0, 0.5, 0);
  const stationGeometry = new THREE.BoxGeometry(STATION_W, 1, STATION_W);
  stationGeometry.translate(0, 0.5, 0);
  const beaconGeometry = new THREE.RingGeometry(BEACON_INNER, BEACON_OUTER, BEACON_SEGMENTS);
  beaconGeometry.rotateX(-Math.PI / 2);
  const surfaceMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
  const lineMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0 });

  const ringGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-(PAD_W + RING_MARGIN) / 2, 0, -(PAD_D + RING_MARGIN) / 2),
    new THREE.Vector3((PAD_W + RING_MARGIN) / 2, 0, -(PAD_D + RING_MARGIN) / 2),
    new THREE.Vector3((PAD_W + RING_MARGIN) / 2, 0, (PAD_D + RING_MARGIN) / 2),
    new THREE.Vector3(-(PAD_W + RING_MARGIN) / 2, 0, (PAD_D + RING_MARGIN) / 2),
  ]);
  const ringMaterial = new THREE.LineBasicMaterial({ color: tokens.ring, transparent: true, opacity: 0 });
  const ring = new THREE.LineLoop(ringGeometry, ringMaterial);
  ring.frustumCulled = false;
  ring.visible = false;
  scene.add(ring);

  const createInstances = (geometry: THREE.BufferGeometry, capacity: number): InstanceBuffer => {
    const mesh = new THREE.InstancedMesh(geometry, surfaceMaterial, capacity);
    mesh.frustumCulled = false;
    mesh.count = 0;
    scene.add(mesh);
    return { mesh, capacity, count: 0 };
  };

  const createLines = (capacity: number): LineBuffer => {
    const positions = new Float32Array(capacity * 3);
    const colours = new Float32Array(capacity * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geometry.setDrawRange(0, 0);
    const mesh = new THREE.LineSegments(geometry, lineMaterial);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, positions, colours, capacity, written: 0 };
  };

  /** Grow an instanced buffer by allocating a new mesh; rare (id-set changes). */
  const ensureInstances = (buffer: InstanceBuffer, geometry: THREE.BufferGeometry, needed: number): void => {
    if (needed <= buffer.capacity) return;
    let capacity = buffer.capacity;
    while (capacity < needed) capacity *= 2;
    scene.remove(buffer.mesh);
    buffer.mesh.dispose();
    const next = createInstances(geometry, capacity);
    buffer.mesh = next.mesh;
    buffer.capacity = capacity;
  };

  /** Grow a line buffer's arrays; the mesh keeps its identity (same geometry). */
  const ensureLines = (buffer: LineBuffer, needed: number): void => {
    if (needed <= buffer.capacity) return;
    let capacity = buffer.capacity;
    while (capacity < needed) capacity *= 2;
    buffer.capacity = capacity;
    buffer.positions = new Float32Array(capacity * 3);
    buffer.colours = new Float32Array(capacity * 3);
    buffer.mesh.geometry.setAttribute("position", new THREE.BufferAttribute(buffer.positions, 3));
    buffer.mesh.geometry.setAttribute("color", new THREE.BufferAttribute(buffer.colours, 3));
  };

  const pads = createInstances(padGeometry, PAD_CAPACITY);
  const markers = createInstances(markerGeometry, MARKER_CAPACITY);
  const stations = createInstances(stationGeometry, STATION_POOL);
  const beacons = createInstances(beaconGeometry, BEACON_POOL);
  const edges = createLines(LINE_CAPACITY);
  const outlines = createLines(LINE_CAPACITY);

  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const projected = new THREE.Vector3();

  const fadeMs = options.reducedMotion ? 0 : FADE_MS;
  const fadeStart = now();

  const stats: RenderStats = {
    drawCalls: 0,
    triangles: 0,
    lines: 0,
    objects: 0,
    instances: 0,
    programs: 0,
    textures: 0,
    geometries: 0,
    vertices: gridVertices,
    pixels: 0,
    fullScreenLayers: 0,
    linePixels: 0,
    shadedPixels: 0,
    stations: 0,
    stationMarks: 0,
    markers: 0,
    beacons: 0,
    tweens: 0,
    animatedEntities: 0,
    sceneWrites: 0,
    stationSegments: 0,
    fps: 0,
  };

  let width = 0;
  let height = 0;
  let cssWidth = 0;
  let cssHeight = 0;
  let disposed = false;
  let digest = "";
  let applied: DeckModel | null = null;
  let hoverId: string | null = null;
  /** Pad instance index → slice id, in the order the last model was written. */
  let padIds: string[] = [];
  /**
   * Transition cues (`d05`): one entry per entity, keyed by entity, so a
   * second transition on the same worker **interrupts and re-targets** the
   * first instead of queueing behind it. The map is small (≤ `CUE_CAP`) and
   * only touched on a model change or while a cue is live.
   */
  const cues = new Map<string, Cue>();
  let cueMs = options.reducedMotion ? 0 : CUE_MS[tier];
  /** True while the last paint drew a cue overlay (see `render`). */
  let paintedWithCues = false;

  // Frame intervals, for the fps reading only. Fixed ring, no allocation.
  const intervals = new Float64Array(32);
  let intervalWrite = 0;
  let intervalCount = 0;
  let lastRenderAt = Number.NaN;

  const fadeProgress = (): number => {
    if (fadeMs <= 0) return 1;
    return Math.min(1, Math.max(0, (now() - fadeStart) / fadeMs));
  };

  const medianInterval = (): number => {
    if (intervalCount === 0) return 0;
    const values: number[] = [];
    for (let i = 0; i < intervalCount; i++) values.push(intervals[(intervalWrite - intervalCount + i + intervals.length) % intervals.length]!);
    values.sort((a, b) => a - b);
    return values[values.length >> 1]!;
  };

  const cameraFromState = (state: DeckCamera): void => {
    const pose = cameraPose(state);
    cameraTarget.set(state.target.x, state.target.y, state.target.z);
    camera.position.set(pose.x, pose.y, pose.z);
    camera.lookAt(cameraTarget);
  };

  /**
   * Pad colour for a node, with the pointer's highlight folded in. A live pad
   * that is not the focus recedes in colour only (see `SECONDARY_DIM`).
   */
  const padColour = (node: RailNode, focusId: string | null, out: THREE.Color): THREE.Color => {
    out.copy(tokens[(PAD_STYLES[node.status] ?? DEFAULT_PAD_STYLE).token]);
    if (node.live && node.id !== focusId) out.multiplyScalar(SECONDARY_DIM);
    if (node.ghost || node.inCycle) out.multiplyScalar(0.6);
    if (node.id === hoverId) out.lerp(tokens.ring, 0.45);
    return out;
  };

  const pushInstance = (buffer: InstanceBuffer, x: number, y: number, z: number, sx: number, sy: number, sz: number, colour: THREE.Color): void => {
    if (buffer.count >= buffer.capacity) return;
    origin.set(x, y, z);
    scale.set(sx, sy, sz);
    matrix.compose(origin, quaternion, scale);
    buffer.mesh.setMatrixAt(buffer.count, matrix);
    buffer.mesh.setColorAt(buffer.count, colour);
    buffer.count++;
  };

  const finishInstances = (buffer: InstanceBuffer): void => {
    buffer.mesh.count = buffer.count;
    buffer.mesh.instanceMatrix.needsUpdate = true;
    if (buffer.mesh.instanceColor) buffer.mesh.instanceColor.needsUpdate = true;
    // three computes and caches the instance bounding sphere on the first frame
    // (and the raycast reads it): an empty world draws a frame of its own before
    // the first model arrives, so the cached sphere has to be invalidated here
    // or picking keeps testing a sphere that contains no instances.
    buffer.mesh.boundingSphere = null;
  };

  const pushLine = (buffer: LineBuffer, ax: number, ay: number, az: number, bx: number, by: number, bz: number, colour: THREE.Color): void => {
    if (buffer.written + 2 > buffer.capacity) return;
    const o = buffer.written * 3;
    buffer.positions[o] = ax;
    buffer.positions[o + 1] = ay;
    buffer.positions[o + 2] = az;
    buffer.positions[o + 3] = bx;
    buffer.positions[o + 4] = by;
    buffer.positions[o + 5] = bz;
    buffer.colours[o] = colour.r;
    buffer.colours[o + 1] = colour.g;
    buffer.colours[o + 2] = colour.b;
    buffer.colours[o + 3] = colour.r;
    buffer.colours[o + 4] = colour.g;
    buffer.colours[o + 5] = colour.b;
    buffer.written += 2;
  };

  const finishLines = (buffer: LineBuffer): void => {
    buffer.mesh.geometry.setDrawRange(0, buffer.written);
    buffer.mesh.geometry.getAttribute("position").needsUpdate = true;
    buffer.mesh.geometry.getAttribute("color").needsUpdate = true;
  };

  const edgeColour = new THREE.Color();
  const outlineColour = new THREE.Color();
  const nodeColour = new THREE.Color();
  const stationColour = new THREE.Color();
  const beaconColour = new THREE.Color();
  const beaconScratch = new THREE.Color();
  /** The clear colour as a colour, for a cleared beacon's fade-out. */
  const beaconFloor = new THREE.Color(BEACON_FLOOR);
  /** Ring colour for one alert kind (severity is the ring count, not this). */
  const beaconToken = (kind: DeckAlertKind): THREE.Color => tokens[BEACON_TOKENS[kind]];

  const cueProgress = (cue: Cue, at: number): number => {
    if (cue.durationMs <= 0) return 1;
    return Math.min(1, Math.max(0, (at - cue.start) / cue.durationMs));
  };
  const ease = (t: number): number => t * t * (3 - 2 * t);

  /**
   * Re-target a cue. Keyed by entity, so a worker that changes state twice in
   * the same second animates twice from the *newer* target — never a queue
   * that grows, and never a second highlight chasing the first.
   */
  const addCue = (entity: string, cue: Cue): void => {
    cues.delete(entity);
    cues.set(entity, cue);
    while (cues.size > CUE_CAP) {
      const oldest = cues.keys().next();
      if (oldest.done === true) break;
      cues.delete(oldest.value);
    }
  };

  /** Drop finished cues. Called once per frame, only while any exist. */
  const pruneCues = (at: number): void => {
    if (cues.size === 0) return;
    for (const [entity, cue] of cues) {
      if (cueProgress(cue, at) >= 1) cues.delete(entity);
    }
  };

  const animatedIds: string[] = [];
  const animatedEntityCount = (): number => {
    animatedIds.length = 0;
    for (const cue of cues.values()) {
      if (!animatedIds.includes(cue.id)) animatedIds.push(cue.id);
    }
    return animatedIds.length;
  };

  /** One alert's rings, at `scale`, in `colour` (dimmed by severity). */
  const pushBeacon = (x: number, y: number, z: number, rings: number, scale: number, dim: number, colour: THREE.Color): void => {
    for (let r = 0; r < rings; r++) {
      const ringScale = scale * (r === 0 ? 1 : BEACON_RING_STEP);
      beaconScratch.copy(colour).multiplyScalar(dim);
      pushInstance(beacons, x, y + r * 0.012, z, ringScale, 1, ringScale, beaconScratch);
    }
  };

  /** Rings a cleared beacon still owes the current frame. */
  const clearingRings = (): number => {
    let total = 0;
    for (const cue of cues.values()) {
      if (cue.kind === "beacon-out") total += cue.rings ?? 1;
    }
    return total;
  };

  /**
   * Write every instanced buffer from `model`, with the transition cues live
   * at `at` folded in.
   *
   * Two rules make this the whole of the deck's animation:
   *
   *  1. **The state is the model's, from this write onward.** Colour, height,
   *     mark count and beacon set are never interpolated: a pad shows its new
   *     status colour on the first frame, and a cue may only *add* a decaying
   *     highlight (a pad pulse, a new mark growing, a beacon arriving or
   *     leaving). There is no frame where the scene shows a state the model
   *     does not.
   *  2. **Nothing moves that is not a change.** With no cues this function
   *     runs once per model change; with cues it runs per frame until they
   *     expire, and the frame that ends the last one writes the final state
   *     again so nothing animated is left painted.
   */
  const writeInstances = (model: DeckModel, at: number): void => {
    const padsNeeded = model.nodes.filter((n) => !n.ghost && !n.inCycle).length;
    const markersNeeded = model.nodes.reduce((sum, n) => sum + (n.alert === null ? 0 : n.alert === "blocked-env" ? 2 : 1), 0);
    const nodesById = new Map(model.nodes.map((n) => [n.id, n]));
    // Stations (`d04`): every live worker the pool holds, drawn from one pooled
    // mesh. The model decided the slots (`lanes.ts`); this decides only paint.
    const pooled = model.stations.filter((station) => station.stack === 0);
    const hidden = model.stations.length - pooled.length;
    // Beacons (`d05`): one ring per severity step, per alert the model chose to
    // draw (a run-level alert has no pad, so it is DOM-only by construction).
    const beaconRings = model.beaconAlerts.reduce(
      (sum, alert) => sum + (alert.sliceId !== null && nodesById.has(alert.sliceId) ? SEVERITY_RINGS[alert.severity] : 0),
      0,
    );
    ensureInstances(pads, padGeometry, padsNeeded);
    ensureInstances(markers, markerGeometry, markersNeeded);
    ensureInstances(stations, stationGeometry, pooled.length * SHAFT_SEGMENTS + Math.min(hidden, STATION_STACK_CAP) + 1);
    ensureInstances(beacons, beaconGeometry, beaconRings + clearingRings());

    pads.count = 0;
    markers.count = 0;
    stations.count = 0;
    beacons.count = 0;
    padIds = [];

    for (const node of model.nodes) {
      if (node.ghost || node.inCycle) continue; // footprints are lines (writeRail)
      const style = PAD_STYLES[node.status] ?? DEFAULT_PAD_STYLE;
      padColour(node, model.focusId, nodeColour);
      // A status change brightens the pad's *own* new colour and decays back to
      // it: the change is visible, and no frame shows a height or hue between
      // two states. This is the difference between "worker X changed" and
      // "something moved and changed colour".
      const pulse = cues.get(`pulse:${node.id}`);
      if (pulse !== undefined) nodeColour.lerp(tokens.ring, CUE_PULSE * (1 - ease(cueProgress(pulse, at))));
      pushInstance(pads, node.x, 0, node.z, 1, style.height, 1, nodeColour);
      padIds.push(node.id);

      if (node.alert !== null) {
        const marker = tokens[node.alert === "failed" ? "destructive" : "warning"];
        pushInstance(markers, node.x, style.height, node.z, 1, MARKER_H, 1, marker);
        if (node.alert === "blocked-env") {
          pushInstance(markers, node.x + MARKER_OFFSET, style.height, node.z, 1, MARKER_H * 0.7, 1, marker);
        }
      }
    }

    // Stations: a column of stage marks standing on each worker's own pad.
    // Brightness is the only focus-dependent thing here, so switching focus
    // rewrites instance colours — never the instance count (d03 finding 3).
    let drawnStations = 0;
    let focusedSegments = 0;
    // The overflow stack hangs off the *last* pool entry (the highest slot),
    // so it does not move when the stations are merely re-ordered.
    let anchor: RailNode | null = null;
    let anchorSlot = -1;
    let anchorHeight = 0;
    for (const station of pooled) {
      const node = nodesById.get(station.id);
      if (!node || node.ghost || node.inCycle) continue;
      const height = (PAD_STYLES[node.status] ?? DEFAULT_PAD_STYLE).height;
      // A wedged worker's column is broken at the top: a static pattern, so
      // "stalled" survives greyscale instead of depending on the amber colour.
      const marks = station.wedged ? Math.max(1, shaftSegments(station.stage)) : shaftSegments(station.stage);
      stationColour.copy(tokens[station.wedged ? "warning" : (STATION_TOKENS[node.status] ?? "info")]);
      if (!station.focused) stationColour.multiplyScalar(SECONDARY_DIM);
      // A mark that just filled grows into place. The *count* is the model's
      // (the station is as tall as the new stage from this frame); only the
      // added marks' size animates, and each grows from its own base.
      const arrival = cues.get(`marks:${station.id}`);
      const fromMarks = arrival === undefined ? marks : Math.min(marks, arrival.fromMarks ?? marks);
      const grow = arrival === undefined ? 1 : CUE_MARK_SCALE + (1 - CUE_MARK_SCALE) * ease(cueProgress(arrival, at));
      for (let i = 0; i < marks; i++) {
        const broken = station.wedged && i === marks - 1;
        pushInstance(
          stations,
          node.x + (broken ? STATION_W * 1.8 : 0),
          height + STATION_GAP + i * (STATION_H + STATION_GAP),
          node.z,
          1,
          i >= fromMarks ? STATION_H * grow : STATION_H,
          1,
          stationColour,
        );
      }
      drawnStations += 1;
      if (station.focused) focusedSegments = shaftSegments(station.stage);
      if (station.slot > anchorSlot) {
        anchor = node;
        anchorSlot = station.slot;
        anchorHeight = height;
      }
    }

    // The pool is full: the workers it cannot hold become one dim mark each,
    // stacked beside the last station. The HUD carries the count and the lane
    // list still lists every one of them — overflow is reported, never hidden.
    if (anchor !== null && hidden > 0) {
      stationColour.copy(tokens.muted).multiplyScalar(SECONDARY_DIM);
      const marks = Math.min(hidden, STATION_STACK_CAP);
      for (let i = 0; i < marks; i++) {
        pushInstance(
          stations,
          anchor.x + PAD_W / 2 + STATION_W,
          anchorHeight + STATION_GAP + i * STATION_STACK_H,
          anchor.z,
          1,
          STATION_STACK_H,
          1,
          stationColour,
        );
      }
    }

    // Beacons: the alert's rings around its own pad, severity as ring count and
    // brightness, colour as the redundant channel. Arriving beacons grow in;
    // cleared ones shrink out *from where they stood*, fading toward the floor.
    for (const alert of model.beaconAlerts) {
      const node = alert.sliceId === null ? undefined : nodesById.get(alert.sliceId);
      if (node === undefined) continue;
      const arrival = cues.get(`beacon:${alert.sliceId}|${alert.kind}`);
      const grow = arrival === undefined ? 1 : CUE_START_SCALE + (1 - CUE_START_SCALE) * ease(cueProgress(arrival, at));
      const scale = grow * (alert.severity === "advisory" ? BEACON_ADVISORY_SCALE : 1);
      pushBeacon(node.x, BEACON_Y, node.z, SEVERITY_RINGS[alert.severity], scale, BEACON_DIM[alert.severity], beaconToken(alert.kind));
    }
    for (const cue of cues.values()) {
      if (cue.kind !== "beacon-out" || cue.colour === undefined) continue;
      const t = ease(cueProgress(cue, at));
      const grow = CUE_START_SCALE + (1 - CUE_START_SCALE) * t;
      beaconColour.copy(cue.colour).lerp(beaconFloor, t);
      pushBeacon(cue.x ?? 0, cue.y ?? BEACON_Y, cue.z ?? 0, cue.rings ?? 1, grow, BEACON_DIM.high, beaconColour);
    }

    finishInstances(pads);
    finishInstances(markers);
    finishInstances(stations);
    finishInstances(beacons);

    stats.instances = pads.count + markers.count + stations.count + beacons.count;
    stats.stations = drawnStations;
    stats.stationMarks = stations.count;
    stats.markers = markers.count;
    stats.beacons = beacons.count;
    stats.stationSegments = focusedSegments;
    stats.tweens = cues.size;
    stats.animatedEntities = animatedEntityCount();
    stats.sceneWrites += 1;
    stats.vertices =
      gridVertices +
      pads.count * 24 +
      markers.count * 24 +
      stations.count * 24 +
      beacons.count * 24 +
      edges.written +
      outlines.written +
      ringGeometry.getAttribute("position").count;
  };

  /**
   * Rewrite every rail buffer from `model`. Called on a model change only: the
   * digest early-out is what keeps a 1 Hz event stream from touching the GPU,
   * and the buffers are rewritten in place (no geometry, material or object is
   * recreated unless the pad/edge count outgrows its capacity).
   */
  const writeRail = (model: DeckModel): void => {
    writeInstances(model, now());
    const byId = new Map(model.nodes.map((n) => [n.id, n]));

    outlines.written = 0;
    for (const node of model.nodes) {
      if (!node.ghost && !node.inCycle) continue;
      // Outline only: the pad does not exist as a slice (unknown dep) or its
      // position in the graph is unreliable (cycle). Drawn as a footprint.
      outlineColour.copy(tokens[node.ghost ? "muted" : "destructive"]);
      outlineColour.multiplyScalar(node.ghost ? 0.9 : 0.8);
      const hw = PAD_W / 2;
      const hd = PAD_D / 2;
      const y = 0.015;
      pushLine(outlines, node.x - hw, y, node.z - hd, node.x + hw, y, node.z - hd, outlineColour);
      pushLine(outlines, node.x + hw, y, node.z - hd, node.x + hw, y, node.z + hd, outlineColour);
      pushLine(outlines, node.x + hw, y, node.z + hd, node.x - hw, y, node.z + hd, outlineColour);
      pushLine(outlines, node.x - hw, y, node.z + hd, node.x - hw, y, node.z - hd, outlineColour);
    }
    ensureLines(edges, model.edges.length * (EDGE_SEGMENTS / 2 + 1) * 2 + 16);
    ensureLines(outlines, model.nodes.length * 8 + 16);

    edges.written = 0;
    // Dependency edges: an arc per edge (height separates crossings), drawn as
    // contiguous segments when satisfied and every other segment when not, so
    // "satisfied" survives greyscale as line pattern as well as brightness.
    for (const edge of model.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const span = Math.hypot(dx, dz);
      const arc = Math.min(EDGE_ARC_MAX, Math.max(EDGE_ARC_MIN, span * EDGE_ARC));
      const dashed = !edge.satisfied || edge.unknown || edge.inCycle;
      edgeColour.copy(edge.inCycle ? tokens.destructive : edge.unknown ? tokens.warning : edge.satisfied ? tokens.info : tokens.muted);
      edgeColour.multiplyScalar(edge.satisfied && !edge.unknown && !edge.inCycle ? 0.85 : 0.55);
      let px = from.x;
      let py = 0.02;
      let pz = from.z;
      for (let i = 1; i <= EDGE_SEGMENTS; i++) {
        const t = i / EDGE_SEGMENTS;
        const inv = 1 - t;
        // Quadratic arc: apex at `arc` above the floor, endpoints on it.
        const x = inv * inv * from.x + 2 * inv * t * ((from.x + to.x) / 2) + t * t * to.x;
        const z = inv * inv * from.z + 2 * inv * t * ((from.z + to.z) / 2) + t * t * to.z;
        const y = 4 * inv * t * arc;
        const draw = !dashed || (i - 1) % 2 === 0;
        if (draw) pushLine(edges, px, py, pz, x, y + 0.02, z, edgeColour);
        px = x;
        py = y + 0.02;
        pz = z;
      }
    }

    finishLines(edges);
    finishLines(outlines);

    // Selection ring: the same primitive for every pad, moved into place.
    const selected = model.nodes.find((n) => n.selected);
    ring.visible = selected !== undefined;
    ring.position.set(selected?.x ?? 0, 0.025, selected?.z ?? 0);

    // The floor follows the rail's extent, at a fixed world cell size. A change
    // of division count is a structural change (a slice was added), never a
    // status change.
    const plan = gridPlan(model.bounds);
    if (plan.divisions !== gridDivisions) {
      scene.remove(grid);
      grid.geometry.dispose();
      gridMaterial.dispose();
      grid = createGrid(plan.size, plan.divisions);
      gridMaterial = grid.material as THREE.LineBasicMaterial;
      gridMaterial.opacity = fadeProgress();
      gridDivisions = plan.divisions;
      gridVertices = grid.geometry.getAttribute("position").count;
      scene.add(grid);
    }

    stats.vertices =
      gridVertices +
      pads.count * 24 +
      markers.count * 24 +
      stations.count * 24 +
      beacons.count * 24 +
      edges.written +
      outlines.written +
      ringGeometry.getAttribute("position").count;
  };

  /**
   * Turn an applied model's deltas into cues. Under reduced motion `cueMs` is
   * 0 and no cue is created at all — the counters then report "no transitions
   * ran" rather than "they ran instantly", which is the difference the
   * acceptance test can see.
   *
   * The scene only animates what it draws: an alert with no beacon (past the
   * tier's cap, or run-level) gets its row in the DOM stack and no cue.
   */
  const enqueue = (model: DeckModel, deltas: readonly SceneDelta[], at: number): void => {
    if (cueMs <= 0 || deltas.length === 0) return;
    const nodesById = new Map(model.nodes.map((n) => [n.id, n]));
    const beaconed = new Set(model.beaconAlerts.map((alert) => `${alert.sliceId ?? ""}|${alert.kind}`));
    for (const delta of deltas) {
      const entity = cueEntity(delta);
      if (entity === null) continue; // recorded, not animated (`attempt`)
      if (delta.kind === "status") {
        addCue(entity, { kind: "pulse", id: delta.id, start: at, durationMs: cueMs });
        continue;
      }
      if (delta.kind === "stage") {
        const fromMarks = shaftSegments(delta.from);
        if (shaftSegments(delta.to) > fromMarks) {
          addCue(entity, { kind: "marks", id: delta.id, start: at, durationMs: cueMs, fromMarks });
        }
        continue;
      }
      if (delta.kind === "alert") {
        // The scene only animates what it draws: an alert past the tier's
        // beacon cap has its stack row and no cue.
        if (delta.alert.sliceId === null || !beaconed.has(`${delta.alert.sliceId}|${delta.alert.kind}`)) continue;
        addCue(entity, { kind: "beacon-in", id: delta.alert.sliceId, start: at, durationMs: cueMs });
        continue;
      }
      if (delta.kind === "alert-cleared") {
        const sliceId = delta.id;
        if (sliceId === null) continue;
        const node = nodesById.get(sliceId);
        if (node === undefined) continue;
        addCue(entity, {
          kind: "beacon-out",
          id: sliceId,
          start: at,
          durationMs: Math.min(cueMs, 200),
          x: node.x,
          y: BEACON_Y,
          z: node.z,
          rings: SEVERITY_RINGS[delta.severity],
          colour: beaconToken(delta.alertKind).clone(),
        });
      }
    }
  };

  return {
    applyModel(model: DeckModel, deltas: readonly SceneDelta[] = []): boolean {
      if (model.digest === digest && applied !== null) {
        applied = model;
        return false;
      }
      digest = model.digest;
      // State first, transition second: the write below is the model's own
      // values, and the cue only adds a decaying highlight on top of them.
      writeRail(model);
      applied = model;
      enqueue(model, deltas, now());
      return true;
    },
    setCamera(state: DeckCamera): void {
      cameraFromState(state);
    },
    setHover(nodeId: string | null): void {
      if (nodeId === hoverId) return;
      hoverId = nodeId;
      if (!applied) return;
      // Only instance colours change: no buffer is reallocated and no object is
      // recreated because the pointer moved.
      let index = 0;
      for (const node of applied.nodes) {
        if (node.ghost || node.inCycle) continue;
        pads.mesh.setColorAt(index, padColour(node, applied.focusId, nodeColour));
        index++;
      }
      if (pads.mesh.instanceColor) pads.mesh.instanceColor.needsUpdate = true;
    },
    pick(ndcX: number, ndcY: number): string | null {
      if (!applied || pads.count === 0) return null;
      pointer.set(ndcX, ndcY);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(pads.mesh, false);
      for (const hit of hits) {
        const instanceId = hit.instanceId;
        if (instanceId === undefined) continue;
        const id = padIds[instanceId];
        if (id !== undefined) return id;
      }
      return null;
    },
    project(x: number, y: number, z: number): { x: number; y: number } | null {
      if (cssWidth <= 0 || cssHeight <= 0) return null;
      projected.set(x, y, z).project(camera);
      // `null` means "nothing is drawn there": behind the camera, past the far
      // plane, or outside the viewport. A pad the operator cannot see must not
      // report a clickable point (the `d02` hook contract, tightened in `d03`
      // when the camera started framing one station rather than the whole rail).
      if (projected.z > 1 || projected.z < -1) return null;
      if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) return null;
      return {
        x: (projected.x * 0.5 + 0.5) * cssWidth,
        y: (0.5 - projected.y * 0.5) * cssHeight,
      };
    },
    setSize(nextCssWidth: number, nextCssHeight: number): void {
      if (nextCssWidth <= 0 || nextCssHeight <= 0) return;
      cssWidth = nextCssWidth;
      cssHeight = nextCssHeight;
      const nextScale = budget.resolutionScale;
      width = Math.max(1, Math.round(cssWidth * nextScale));
      height = Math.max(1, Math.round(cssHeight * nextScale));
      renderer.setSize(width, height, false);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      camera.aspect = cssWidth / cssHeight;
      camera.updateProjectionMatrix();
      stats.pixels = width * height;
      stats.shadedPixels = stats.pixels * stats.fullScreenLayers + stats.linePixels;
    },
    setTier(next: QualityTier): void {
      budget = TIER_BUDGETS[next];
      cueMs = options.reducedMotion ? 0 : CUE_MS[next];
      if (cssWidth > 0 && cssHeight > 0) {
        const nextScale = budget.resolutionScale;
        width = Math.max(1, Math.round(cssWidth * nextScale));
        height = Math.max(1, Math.round(cssHeight * nextScale));
        renderer.setSize(width, height, false);
        camera.aspect = cssWidth / cssHeight;
        camera.updateProjectionMatrix();
        stats.pixels = width * height;
        stats.shadedPixels = stats.pixels * stats.fullScreenLayers + stats.linePixels;
      }
    },
    render(): RenderStats {
      const at = now();
      if (Number.isFinite(lastRenderAt)) {
        intervals[intervalWrite % intervals.length] = at - lastRenderAt;
        intervalWrite++;
        if (intervalCount < intervals.length) intervalCount++;
      }
      lastRenderAt = at;

      // Transition cues: the only per-frame scene work in the deck. While one
      // is live the instance buffers are re-written with its decay folded in;
      // the frame that ends the last cue writes the final state once more, so
      // a cleared beacon is not left on the floor.
      if (cues.size > 0) {
        pruneCues(at);
        if (cues.size > 0) {
          if (applied) {
            writeInstances(applied, at);
            paintedWithCues = true;
          }
        } else if (paintedWithCues && applied) {
          writeInstances(applied, at);
          paintedWithCues = false;
        }
      }

      const progress = fadeProgress();
      if (gridMaterial.opacity !== progress) gridMaterial.opacity = progress;
      if (surfaceMaterial.opacity !== progress) surfaceMaterial.opacity = progress;
      if (lineMaterial.opacity !== progress) lineMaterial.opacity = progress;
      if (ringMaterial.opacity !== progress * 0.95) ringMaterial.opacity = progress * 0.95;

      renderer.render(scene, camera);

      const info = renderer.info;
      stats.drawCalls = info.render.calls;
      stats.triangles = info.render.triangles;
      stats.lines = info.render.lines;
      stats.objects = stats.drawCalls + stats.instances;
      stats.programs = info.programs?.length ?? 0;
      stats.textures = info.memory.textures;
      stats.geometries = info.memory.geometries;
      // Upper bound: no 1 px line covers more than the screen diagonal.
      stats.linePixels = Math.round(stats.lines * Math.hypot(width, height));
      stats.shadedPixels = stats.pixels * stats.fullScreenLayers + stats.linePixels;
      return stats;
    },
    info(): RenderStats {
      const interval = medianInterval();
      stats.fps = interval > 0 ? Math.round((1000 / interval) * 10) / 10 : 0;
      return stats;
    },
    animating(): boolean {
      return !disposed && (fadeProgress() < 1 || cues.size > 0);
    },
    appliedDigest(): string {
      return digest;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(grid, pads.mesh, markers.mesh, stations.mesh, beacons.mesh, edges.mesh, outlines.mesh, ring);
      grid.geometry.dispose();
      gridMaterial.dispose();
      padGeometry.dispose();
      markerGeometry.dispose();
      stationGeometry.dispose();
      beaconGeometry.dispose();
      ringGeometry.dispose();
      ringMaterial.dispose();
      surfaceMaterial.dispose();
      lineMaterial.dispose();
      pads.mesh.dispose();
      markers.mesh.dispose();
      stations.mesh.dispose();
      beacons.mesh.dispose();
      edges.mesh.geometry.dispose();
      outlines.mesh.geometry.dispose();
      cues.clear();
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        // A lost context is already released; nothing to do.
      }
    },
    disposed(): boolean {
      return disposed;
    },
  };
}
