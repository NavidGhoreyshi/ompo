/**
 * World coordinates for the roadmap rail (roadmap slice `d02`).
 *
 * The single place that decides where a pad sits. A world position is a pure
 * function of `layoutDag`'s structural layout — column (dependency depth) and
 * row (roadmap order inside the column) — and of nothing else: status,
 * selection, events, workers and preferences cannot move a pad, so a status
 * change is a change *on* the floor, never a re-layout of it (CP-7), and
 * appending a slice at the end of a column leaves every pad already on the
 * floor where it was.
 *
 * Pure module: no `three`, no DOM. `renderer.ts` never computes layout, and
 * `model.ts` never computes geometry.
 */

import { DAG_PAD, type DagLayout } from "../lib/dag.ts";
import { CAMERA_FOV, type DeckCamera, type RailBounds, type RailPosition } from "./types.ts";

/**
 * SVG layout unit → world unit. One SVG column pitch (276 units) is 5.52 world
 * units and one row pitch (92 units) 1.84, so `PAD_*` below leaves a gap in
 * both directions and two pads never touch.
 */
export const RAIL_SCALE = 0.02;
/** Pad footprint in world units, well inside the 4 × 1.4 the scale allows. */
export const PAD_W = 3.5;
export const PAD_D = 1.1;
/** Selection ring clearance around the pad footprint. */
export const RING_MARGIN = 0.45;
/** Default `rail` elevation and azimuth (types.ts `DEFAULT_CAMERA`). */
const RAIL_ELEVATION = 0.62;
const RAIL_AZIMUTH = Math.PI / 4;
/** Framing clamps: the camera's near/far planes are 0.1 / 500. */
const MIN_DISTANCE = 6;
const MAX_DISTANCE = 400;
/** Headroom between the rail's edge and the viewport edge. */
const FRAMING_MARGIN = 1.12;
/**
 * Floor grid: cell size in world units, and the most divisions a rebuild may
 * create. Cells never shrink below `GRID_CELL`; on a huge roadmap they grow so
 * the floor still covers it with a bounded line count.
 */
export const GRID_CELL = 5;
const GRID_MAX_DIVISIONS = 64;

/**
 * One world position per layout node, keyed by node id (ghost nodes included —
 * they are pads too, drawn as outlines).
 *
 * The origin is the layout's top-left *pad corner* rather than its centre: a
 * position depends only on the node's own column and row, so the world does not
 * shift when the roadmap grows (a centred world would move every pad whenever
 * the bounding box changed). `railFraming` puts the camera where the content is.
 */
export function railPositions(layout: DagLayout): Map<string, RailPosition> {
  const positions = new Map<string, RailPosition>();
  for (const node of layout.nodes) {
    positions.set(node.id, {
      x: (node.x - DAG_PAD) * RAIL_SCALE,
      y: 0,
      z: (node.y - DAG_PAD) * RAIL_SCALE,
    });
  }
  return positions;
}

/** Footprint of the rail, pad edges included. Zero-sized for an empty rail. */
export function railBounds(positions: Iterable<RailPosition>): RailBounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const p of positions) {
    count++;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (count === 0) {
    return { minX: 0, maxX: 0, minZ: 0, maxZ: 0, width: 0, depth: 0, centerX: 0, centerZ: 0 };
  }
  const halfW = PAD_W / 2;
  const halfD = PAD_D / 2;
  const width = maxX - minX + PAD_W;
  const depth = maxZ - minZ + PAD_D;
  return {
    minX: minX - halfW,
    maxX: maxX + halfW,
    minZ: minZ - halfD,
    maxZ: maxZ + halfD,
    width,
    depth,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

/**
 * `rail` framing: the three-quarter view that fits the whole rail, computed
 * once per bounds change (never per frame).
 *
 * The fit is analytic over the rail's box in the camera's own basis, so both
 * frustum axes are satisfied at any window shape and a long, shallow rail (a
 * mostly sequential run) fills the frame instead of being fitted by a
 * bounding sphere that would shrink it to nothing.
 */
export function railFraming(bounds: RailBounds, aspect: number): DeckCamera {
  const halfY = (CAMERA_FOV * Math.PI) / 360;
  const fitAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfX = Math.atan(Math.tan(halfY) * fitAspect);

  const halfW = Math.max(bounds.width, PAD_W) / 2;
  const halfD = Math.max(bounds.depth, PAD_D) / 2;
  const sinA = Math.sin(RAIL_AZIMUTH);
  const cosA = Math.cos(RAIL_AZIMUTH);
  const sinE = Math.sin(RAIL_ELEVATION);
  const cosE = Math.cos(RAIL_ELEVATION);

  // Camera basis for the fixed rail orientation (`lookAt` the target with +Y up):
  // how far the box reaches along the view's right, up and depth axes.
  const halfRight = Math.abs(cosA) * halfW + Math.abs(sinA) * halfD;
  const halfUp = Math.abs(sinE * sinA) * halfW + Math.abs(sinE * cosA) * halfD;
  const halfDepth = Math.abs(cosE * sinA) * halfW + Math.abs(cosE * cosA) * halfD;

  const needed = Math.max(halfRight / Math.tan(halfX), halfUp / Math.tan(halfY)) * FRAMING_MARGIN;
  const distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, halfDepth + needed));

  return {
    target: { x: bounds.centerX, y: 0, z: bounds.centerZ },
    distance,
    azimuth: RAIL_AZIMUTH,
    elevation: RAIL_ELEVATION,
  };
}

/**
 * World position of the camera for a `DeckCamera` state. The renderer and the
 * framing tests share this one formula, so a framing claim is testable without
 * a WebGL context.
 */
export function cameraPose(state: DeckCamera): { x: number; y: number; z: number } {
  const cosElevation = Math.cos(state.elevation);
  return {
    x: state.target.x + state.distance * cosElevation * Math.sin(state.azimuth),
    y: state.target.y + state.distance * Math.sin(state.elevation),
    z: state.target.z + state.distance * cosElevation * Math.cos(state.azimuth),
  };
}

/** Grid size and divisions that cover `bounds` at no smaller than `GRID_CELL`. */
export function gridPlan(bounds: RailBounds): { size: number; divisions: number } {
  const span = Math.max(bounds.width, bounds.depth, GRID_CELL * 4);
  const cell = Math.max(GRID_CELL, span / GRID_MAX_DIVISIONS);
  const divisions = Math.max(4, Math.ceil((span + GRID_CELL * 2) / cell));
  return { size: divisions * cell, divisions };
}

/**
 * The temporal band (`d07`): a shallow ribbon strip and a row of run tiles,
 * both along the rail's **near** edge (`maxZ` — the side the default camera is
 * on). Geometry, not data: the ribbon's *buckets* come from `history.ts` and a
 * tile's identity from the run list; this file only says where the strip and
 * the row stand, and `withTemporalBand` grows the deck's box so the `rail`
 * framing shows them.
 *
 * Where the band sits, measured rather than guessed (`d07`): the default camera
 * sits at azimuth 45°, so a band hugging the rail's far edge projects into the
 * rail's own screen silhouette — on the real 22-pad run the strip's bars landed
 * within 3–7 px of the pads' tops and were covered. Pushed back to
 * `RIBBON_GAP` (5 units), the bars clear that silhouette by 14–26 px on the
 * same run, stay above the station-line panel, and keep clear of the
 * bottom-left live window. The near side was measured too and rejected: there
 * the strip runs into the bottom-right panels and the live window's corner.
 *
 * The ribbon's readability rule: **a sub-pixel bar is not a reading**. The
 * strip is as wide as the rail when that is enough, and grows past the rail
 * when a bucket would otherwise be thinner than `RIBBON_MIN_PITCH` — the world
 * gets wider rather than the time axis becoming a smudge. Beyond
 * `RIBBON_MAX_BARS` buckets, adjacent buckets are drawn as one bar (the scene
 * shows the shape; the DOM strip keeps every bucket exact).
 */
export const RIBBON_DEPTH = 1.2;
/** Tallest bar, in world units. Twice a pad's height on purpose: the strip is
 *  read from the rail preset, ~70 world units away, where a 1-unit bar is a
 *  ~10 px smudge (measured with a pixel probe on the real run in `d07`). */
export const RIBBON_HEIGHT = 2.2;
/** Bars the scene ribbon draws at most; the DOM strip draws every bucket. */
export const RIBBON_MAX_BARS = 48;
/** The thinnest a bar may get, in world units. */
export const RIBBON_MIN_PITCH = 0.32;
/** Gaps: rail edge → ribbon (`RIBBON_GAP`), ribbon → tile row (`WALL_GAP`).
 *  The rail gap is the wide one: it is what lifts the strip clear of the
 *  rail's own silhouette from the default camera (see the note above), and the
 *  tile row then sits just beyond the bars. */
const RIBBON_GAP = 5;
const WALL_GAP = 2.2;
/** Run tile footprint, in world units (upright tablets on the wall row). */
export const TILE_W = 1;
export const TILE_H = 0.62;
export const TILE_D = 0.24;
/** Depth the band adds behind the rail: gap + ribbon + gap + tile. */
const TEMPORAL_DEPTH = RIBBON_GAP + RIBBON_DEPTH + WALL_GAP + TILE_D;

/**
 * The rail's box grown to include the temporal band. Everything the deck draws
 * (rail, ribbon, wall) is inside the result, which is why the `rail` preset
 * keeps framing the whole world instead of cropping the time axis. `stripWidth`
 * is the ribbon's own width (`ribbonPitch × bars`): the box widens along X only
 * when the time axis needs more room than the roadmap does.
 */
export function withTemporalBand(bounds: RailBounds, stripWidth = 0): RailBounds {
  const width = Math.max(bounds.width, stripWidth, PAD_W);
  const minX = bounds.centerX - width / 2;
  const minZ = bounds.minZ - TEMPORAL_DEPTH;
  const depth = bounds.depth + TEMPORAL_DEPTH;
  return {
    minX,
    maxX: minX + width,
    minZ,
    maxZ: bounds.maxZ,
    width,
    depth,
    centerX: bounds.centerX,
    centerZ: bounds.centerZ - TEMPORAL_DEPTH / 2,
  };
}

/**
 * Bar-to-bar distance for `count` bars over the *rail's* width, never below
 * `RIBBON_MIN_PITCH`. Callers compute it from the rail's box (before
 * `withTemporalBand`), so the strip's width and the deck's box cannot chase
 * each other.
 */
export function ribbonPitch(bounds: RailBounds, count: number): number {
  const bars = Math.max(1, count);
  return Math.max(Math.max(bounds.width, PAD_W) / bars, RIBBON_MIN_PITCH);
}

/** Centre X of bar `index` of `count`, the strip centred on the rail. */
export function ribbonX(bounds: RailBounds, index: number, count: number): number {
  const pitch = ribbonPitch(bounds, count);
  const width = pitch * Math.max(1, count);
  return bounds.centerX - width / 2 + pitch * (index + 0.5);
}

/** Z of the ribbon strip's centre, from the *deck* box (`withTemporalBand`):
 *  the strip is the innermost element of the band, nearest the rail. */
export function ribbonZ(bounds: RailBounds): number {
  return bounds.minZ + TILE_D + WALL_GAP + RIBBON_DEPTH / 2;
}

/**
 * The bar a bucket is drawn as: with more buckets than bars, adjacent buckets
 * merge into one (`bars` is `min(count, RIBBON_MAX_BARS)` by construction). One
 * rule, so the playhead and the bars cannot disagree about where a bucket is.
 */
export function ribbonGroup(bucketIndex: number, bucketCount: number, bars: number): number {
  if (bars <= 0) return 0;
  if (bucketCount <= bars) return Math.min(bucketIndex, bars - 1);
  return Math.min(bars - 1, Math.floor((bucketIndex * bars) / bucketCount));
}

/** World positions of the run tiles, newest first, centred on the wall row. */
export function tilePositions(bounds: RailBounds, count: number): RailPosition[] {
  if (count <= 0) return [];
  const z = bounds.minZ + TILE_D / 2;
  const pitch = Math.min(TILE_W * 2.4, Math.max(TILE_W * 1.25, bounds.width / (count * 1.5)));
  const first = bounds.centerX - ((count - 1) * pitch) / 2;
  const positions: RailPosition[] = [];
  for (let index = 0; index < count; index++) {
    positions.push({ x: first + index * pitch, y: 0, z });
  }
  return positions;
}
