/**
 * Deck contracts (roadmap slices `d01`–`d02`).
 *
 * Types and the small constants the shell and the deck must agree on. The
 * deck is a projection of state the dashboard already holds: it receives
 * props and returns intents, and it never fetches (CP-4 in
 * `docs/desktop-3d-roadmap.md`).
 */

import type { AgentRow, RunDetail, RunEvent, RunSummary, SliceDetail } from "../api.ts";
import type { QualityTier } from "./tier.ts";

export type { QualityTier } from "./tier.ts";

/** Client-side deck preferences. View state only — never domain state. */
export interface DeckPrefs {
  /** `"auto"` classifies from the WebGL renderer string; a tier pins it. */
  tier: "auto" | QualityTier;
  /** Deck-level override; the OS preference is honoured regardless. */
  reducedMotion: boolean;
}

export const DECK_PREFS_KEY = "ompo.deck.prefs";

export const DEFAULT_DECK_PREFS: DeckPrefs = { tier: "auto", reducedMotion: false };

const TIERS: QualityTier[] = ["minimal", "standard", "high"];

/**
 * Parsed at the storage boundary: unreadable or malformed preferences degrade
 * to the defaults rather than throwing (private mode, cleared storage, a
 * hand-edited value).
 */
export function parseDeckPrefs(raw: string | null): DeckPrefs {
  if (!raw) return DEFAULT_DECK_PREFS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_DECK_PREFS;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_DECK_PREFS;
  const tierValue = "tier" in value ? value.tier : undefined;
  const motionValue = "reducedMotion" in value ? value.reducedMotion : undefined;
  const tier = tierValue === "auto" || (typeof tierValue === "string" && TIERS.includes(tierValue as QualityTier))
    ? (tierValue as DeckPrefs["tier"])
    : DEFAULT_DECK_PREFS.tier;
  return { tier, reducedMotion: motionValue === true };
}

/** Orbital camera state (roadmap §D.4). Excluded from the scene model. */
export interface DeckCamera {
  target: { x: number; y: number; z: number };
  distance: number;
  azimuth: number;
  elevation: number;
}

/** `rail`: elevated three-quarter view of the whole roadmap (`d01` default). */
export const DEFAULT_CAMERA: DeckCamera = {
  target: { x: 0, y: 0, z: 0 },
  distance: 32,
  azimuth: Math.PI / 4,
  elevation: 0.62,
};

/** Perspective field of view, shared by the renderer and `railFraming`. */
export const CAMERA_FOV = 50;

/** A position on the deck floor, in world units. */
export interface RailPosition {
  x: number;
  y: number;
  z: number;
}

/** Footprint of the rail in world units, pad edges included. */
export interface RailBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  width: number;
  depth: number;
  centerX: number;
  centerZ: number;
}

/**
 * What the deck is allowed to show about one pad. Every field is either a DTO
 * field or a `layoutDag` output — the model invents no second lifecycle: the
 * status strings are the roadmap's, and `alert` is the only visual *kind*
 * derived from them.
 */
export interface RailNode {
  id: string;
  title: string;
  /** Roadmap status, verbatim (`pending`, `running`, `done`, `unknown`, …). */
  status: string;
  attempts: number;
  generation: number;
  effort: string | null;
  /** Longest dependency chain — the layout column this pad sits in. */
  depth: number;
  /** World position on the floor (from `railPositions`, never from status). */
  x: number;
  z: number;
  deps: readonly string[];
  selected: boolean;
  /** Scheduler flags, from `dag.ts` (`readyDagIds` / `isDagReady`). */
  ready: boolean;
  blocked: boolean;
  /** Unknown dependency (`layoutDag` ghost node). */
  ghost: boolean;
  /** Member of a dependency cycle (`layoutDag` `cycleIds`). */
  inCycle: boolean;
  /** Failure text for the overlay line; `null` when the DTO has none. */
  reason: string | null;
  /** What the pad must encode beyond colour (`d02`: failed / blocked-env). */
  alert: AlertKind | null;
  /**
   * A worker is in flight (`isLiveStatus`) — station-pool membership, and the
   * reason a pad recedes when it is not the focus.
   */
  live: boolean;
  /**
   * Pipeline stage index for a live slice (`currentStageIndex` over
   * `buildPipelineStages`), `-1` for a slice with no observed phase or for a
   * non-live pad. The station's shaft fills one segment per stage step; the
   * scene reads this number, never the stage names.
   */
  stage: number;
  /** Stage label for the DOM (`buildPipelineStages[stage].label`, "" when none). */
  stageLabel: string;
}

/** Alert kinds the scene can draw as of `d02`; `d05` extends this union. */
export type AlertKind = "failed" | "blocked-env";

/** One dependency edge, projected from the roadmap's `deps`. */
export interface RailEdge {
  key: string;
  /** Dep id (the pad the edge leaves). */
  from: string;
  /** Dependent slice id (the pad the edge arrives at). */
  to: string;
  /** Dep status is done/skipped — `dag.ts` `depSatisfied`. */
  satisfied: boolean;
  /** Dep id is not in the roadmap. */
  unknown: boolean;
  /** Both ends are cycle members. */
  inCycle: boolean;
}

/** Run counts, verbatim from `RunSummary.counts` — nothing is recounted here. */
export type DeckCounts = RunSummary["counts"];

/**
 * Scene contents: the renderer's *only* input, and a pure function of the
 * DTOs and view state (`buildDeckModel` in `model.ts`). `d02` renders the
 * roadmap rail; later slices extend this model rather than adding a parallel
 * path to the scene.
 */
export interface DeckModel {
  runId: string | null;
  live: boolean;
  /** True while a run switch is loading and the deck holds the previous pads. */
  loading: boolean;
  nodes: RailNode[];
  edges: RailEdge[];
  counts: DeckCounts;
  /** The slice that needs eyes (`preferredSliceId`), independent of selection. */
  primaryId: string | null;
  /**
   * Live workers (`liveSliceIds`) in board order — the lane strip, the `[`/`]`
   * cycle and the HUD's `live: N`. Pads carry the same fact per node; this is
   * the ordered projection of it, so the overlay never re-derives the order.
   */
  liveIds: string[];
  /**
   * The worker in front of the operator (`focusTarget`): the pin when one is
   * set, else the live primary, else the overall primary. `null` on an empty
   * roadmap; equal to `primaryId` when nothing is pinned and no worker runs.
   */
  focusId: string | null;
  /** Extent of `nodes`, for the default framing and the floor grid. */
  bounds: RailBounds;
  /**
   * Content key of everything the renderer consumes. Derived from the
   * projection (never a counter), so identical inputs give an identical
   * digest and the scene can prove it did no work.
   */
  digest: string;
}

/**
 * Everything the projection reads. `events`, `agents` and `prefs` are part of
 * the contract for the slices that consume them (`d03` focus/live window);
 * `d02`'s rail is a function of `detail` + `selected` + `runId` only, which is
 * why an event or worker churn cannot touch the scene.
 */
export interface DeckInput {
  runId: string | null;
  detail: RunDetail | null;
  events: readonly RunEvent[];
  agents: readonly AgentRow[];
  selected: string | null;
  /**
   * The shell's slice detail fetch for the current selection (it is the slice
   * the Inspector shows). Used for the focused station's stage index when it
   * belongs to that slice; when it does not, the stage falls back to what the
   * `SliceSummary` alone can prove. Never fetched or cached here.
   */
  sliceDetail: SliceDetail | null;
  /** The operator's pin (view state): wins over the derived focus target. */
  pinnedId: string | null;
  prefs: DeckPrefs;
  live: boolean;
}

/** Props the shell hands the deck. Fetching stays in `App.tsx`. */
export interface DeckProps {
  runId: string | null;
  detail: RunDetail | null;
  events: RunEvent[];
  agents: AgentRow[];
  selected: string | null;
  sliceDetail: SliceDetail | Record<string, unknown> | null;
  live: boolean;
  /** The app's single selection system — the same state the board writes. */
  onSelect: (sliceId: string) => void;
  /** Switch back to the dashboard surface (the `D` key and the HUD button). */
  onExit: () => void;
}

/**
 * Counters the renderer maintains (roadmap slice `d01`). One object, mutated in
 * place per frame — the per-frame path allocates nothing, so copy it if you
 * keep it.
 */
export interface RenderStats {
  /** Draw calls issued by the last `render()`. */
  drawCalls: number;
  triangles: number;
  /** Line segments drawn (grid + rail edges + outlines). */
  lines: number;
  /**
   * `drawCalls + instances` — the `objects` term of the `d00` cost model
   * (`docs/deck-performance-budget.md` §3.2: an instance and a call cost the
   * same, so the budget counts both). Not the scene-graph child count.
   */
  objects: number;
  /** Instances drawn by the last `render()` (pads + markers). */
  instances: number;
  programs: number;
  textures: number;
  geometries: number;
  /** Vertices in the scene's code-generated geometry (exact, captured at build). */
  vertices: number;
  /** Backing-store pixels at the current size (`css × tier.resolutionScale`). */
  pixels: number;
  /** Passes that shade every pixel of the viewport. `d01` issues none. */
  fullScreenLayers: number;
  /** Upper bound of pixels covered by 1 px lines, recomputed on resize. */
  linePixels: number;
  /** `pixels × fullScreenLayers + linePixels`. */
  shadedPixels: number;
  /**
   * Filled shaft segments of the focused station (`d03`) — 0 when nothing is
   * framed or the framed slice is not live. Read from the model, so it is
   * correct before the frame that draws it.
   */
  stationSegments: number;
  /** Frames per second actually rendered, refreshed on read (`info()`). */
  fps: number;
}

/** One row of the §D.5 keymap. The HUD and the tests read this table. */
export interface DeckKey {
  /** Display label, e.g. `T` or `[ / ]`. */
  key: string;
  /** `KeyboardEvent.key` values that trigger it. */
  codes: string[];
  effect: string;
  /** Slice that implements it; the HUD dims the ones that are not live yet. */
  slice: string;
}

export const DECK_KEYS: DeckKey[] = [
  { key: "T", codes: ["t"], effect: "Cycle quality tier (auto → minimal → standard → high)", slice: "d01" },
  { key: "H / ?", codes: ["h", "?"], effect: "Keymap and budget HUD", slice: "d01" },
  { key: "D", codes: ["d"], effect: "Switch to the dashboard surface", slice: "d01" },
  { key: "F", codes: ["f"], effect: "Frame the selection (pin it)", slice: "d03" },
  { key: "Esc", codes: ["Escape"], effect: "Release the pin, re-follow the primary", slice: "d03" },
  { key: "Space", codes: [" "], effect: "Freeze / resume the live window", slice: "d03" },
  { key: "E", codes: ["e"], effect: "Expand the live window to the raw transcript", slice: "d03" },
  { key: "[ / ]", codes: ["[", "]"], effect: "Previous / next live worker", slice: "d03" },
  { key: "arrow keys", codes: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], effect: "Pan the camera along the floor", slice: "d03" },
  { key: "wheel / + / -", codes: ["+", "=", "-"], effect: "Zoom the camera", slice: "d03" },
  { key: "C", codes: ["c"], effect: "Cycle camera preset (command ↔ rail)", slice: "d03" },
  { key: "0", codes: ["0"], effect: "Reset the camera to the preset's framing", slice: "d03" },
  { key: "1…8", codes: ["1", "2", "3", "4", "5", "6", "7", "8"], effect: "Open the dock on inspector tab N", slice: "d06" },
  { key: "M", codes: ["m"], effect: "Toggle reduced motion", slice: "d09" },
];

/** The debug hook the e2e suite and `d10` assert against. Not public API. */
export interface DeckDebugHook {
  tier: QualityTier;
  tierSource: "auto" | "pinned";
  /** Mounts and unmounts across the page's lifetime, so leaks are visible. */
  mounted: number;
  disposed: number;
  /** Frame counter, written in place per frame (no allocation). */
  frames: number;
  drawCalls: number;
  objects: number;
  triangles: number;
  vertices: number;
  pixels: number;
  /** Model counters, written when a model is applied. */
  nodes: number;
  edges: number;
  instances: number;
  /** Digest of the applied model — stable across status-preserving updates. */
  digest: string;
  /** Slice currently selected / under the pointer, as the deck sees them. */
  selected: string | null;
  hover: string | null;
  /** Focus state (`d03`): the framed worker, the pin, and the frozen window. */
  focused: string | null;
  pinned: string | null;
  frozen: string | null;
  /** The camera preset the deck is following (`command` | `rail`). */
  cameraPreset: "command" | "rail";
  /** Live workers the deck can see (lane strip length, HUD `live: N`). */
  liveCount: number;
  /** Camera state last written to the renderer (view state, for the specs). */
  camera: DeckCamera;
  /** Filled shaft segments of the focused station (`0` when nothing is framed). */
  stationSegments: number;
  /** Rows in the live window and raw lines behind it — the bounded-window evidence. */
  liveRows: number;
  logLines: number;
  /**
   * Applied pad positions, `{ id, x, z }` in model order. Allocated per
   * model application (never per frame) so the layout-stability spec can
   * compare real coordinates before and after an app-state change.
   */
  positions: { id: string; x: number; z: number }[];
  /** Canvas-relative CSS pixels of a pad, or `null` when nothing is drawn. */
  screenPosition: ((id: string) => { x: number; y: number } | null) | null;
  instrument: unknown;
}
