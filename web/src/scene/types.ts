/**
 * Deck contracts (roadmap slices `d01`–`d02`).
 *
 * Types and the small constants the shell and the deck must agree on. The
 * deck is a projection of state the dashboard already holds: it receives
 * props and returns intents, and it never fetches (CP-4 in
 * `docs/desktop-3d-roadmap.md`).
 */

import type { AgentRow, RunDetail, RunEvent, RunSummary, SliceDetail } from "../api.ts";
import type { DeckAlert } from "./alerts.ts";
import type { HistoryIndex, RibbonBucket } from "./history.ts";
import type { QualityTier } from "./tier.ts";

export type { QualityTier } from "./tier.ts";

/**
 * The operator's motion choice (`d09`). `"system"` follows
 * `prefers-reduced-motion`; `"reduced"` and `"on"` are explicit and survive a
 * reload — `M` must be able to turn motion *back on* on a machine whose OS
 * asks for reduced motion, which a boolean "override" cannot express.
 */
export type DeckMotion = "system" | "on" | "reduced";

/** Client-side deck preferences. View state only — never domain state. */
export interface DeckPrefs {
  /** `"auto"` classifies from the WebGL renderer string; a tier pins it. */
  tier: "auto" | QualityTier;
  /** Deck-level motion choice; the OS preference is the default (`"system"`). */
  motion: DeckMotion;
  /**
   * Explicit availability choice (`T` cycles flat, `d09`): `"flat"` renders
   * the flat projection even where WebGL works; `"3d"` is the retry after a
   * lost context. `null` lets capability decide.
   */
  forced: "3d" | "flat" | null;
}

export const DECK_PREFS_KEY = "ompo.deck.prefs";

export const DEFAULT_DECK_PREFS: DeckPrefs = { tier: "auto", motion: "system", forced: null };

const TIERS: QualityTier[] = ["minimal", "standard", "high"];
const MOTIONS: DeckMotion[] = ["system", "on", "reduced"];

/**
 * Parsed at the storage boundary: unreadable or malformed preferences degrade
 * to the defaults rather than throwing (private mode, cleared storage, a
 * hand-edited value). The `d01`–`d08` shape stored `reducedMotion: boolean`;
 * `true` migrates to `motion: "reduced"`, everything else to `"system"` — an
 * absent/`false` legacy flag never claimed an explicit motion choice, so the
 * OS preference keeps applying to it.
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
  const motionValue = "motion" in value ? value.motion : undefined;
  const legacyMotion = "reducedMotion" in value ? value.reducedMotion : undefined;
  const forcedValue = "forced" in value ? value.forced : undefined;
  const tier = tierValue === "auto" || (typeof tierValue === "string" && TIERS.includes(tierValue as QualityTier))
    ? (tierValue as DeckPrefs["tier"])
    : DEFAULT_DECK_PREFS.tier;
  const motion = typeof motionValue === "string" && MOTIONS.includes(motionValue as DeckMotion)
    ? (motionValue as DeckMotion)
    : legacyMotion === true
      ? "reduced"
      : DEFAULT_DECK_PREFS.motion;
  const forced = forcedValue === "flat" || forcedValue === "3d" ? forcedValue : DEFAULT_DECK_PREFS.forced;
  return { tier, motion, forced };
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
   * Newest event seq this slice produced (0 when it has none). It is the
   * evidence stamp a transition and an alert carry (`d05`), so the scene never
   * reports a change without the log entry that caused it.
   */
  seq: number;
  /**
   * A worker is in flight (`isLiveStatus`) — station-pool membership, and the
   * reason a pad recedes when it is not the focus.
   */
  live: boolean;
  /**
   * Pipeline stage index for a live slice (`currentStageIndex` over
   * `buildPipelineStages`), `-1` for a slice with no observed phase or for a
   * non-live pad. The station's column fills one mark per stage step; the
   * scene reads this number, never the stage names.
   */
  stage: number;
  /** Stage label for the DOM (`buildPipelineStages[stage].label`, "" when none). */
  stageLabel: string;
  /**
   * `AgentRow.lane` for this slice, or `null` when `/agents` has not reported
   * it (`d04`). A live worker's station slot is derived from it; a non-live
   * slice never has one.
   */
  lane: number | null;
  /**
   * `AgentRow.wedged` — live but silent past the server's wedge threshold
   * (`d04`). Scene-visible: a wedged station draws its column with a static
   * break, so "stalled" survives greyscale.
   */
  wedged: boolean;
}

/**
 * One live worker's station (`d04`). A station is the deck's answer to "who is
 * running": a column above the worker's own pad, its marks the pipeline stage,
 * its brightness the operator's focus. `slot`/`stack` come from the pure policy
 * in `lanes.ts` — the renderer never decides placement, and the slot is a pool
 * entry, never a coordinate.
 */
export interface DeckStation {
  id: string;
  /** Pool entry this station is drawn from (`0 … maxStations-1`). */
  slot: number;
  /** `0` when the station is drawn; `1…n` when the pool is full (overflow). */
  stack: number;
  /** Pipeline stage index, `-1` when no phase has been observed yet. */
  stage: number;
  /** `AgentRow.wedged` — drawn as a static break, not a colour change. */
  wedged: boolean;
  /** `AgentRow.lane`, or `null` before the worker is reported. */
  lane: number | null;
  /** The slice that needs eyes (`preferredSliceId`), independent of focus. */
  primary: boolean;
  /** The worker the operator is pointed at (`focusId`). */
  focused: boolean;
}

/** Alert kinds the scene can draw as of `d02`; `d05` extends this union. */
export type AlertKind = "failed" | "blocked-env";

/**
 * One previous run on the history wall (`d07`). A tile is *inert*: the DOM
 * list is where runs are chosen, and the tile row is the same information made
 * spatial ("how many runs, which one am I on"). Nothing here is derived from a
 * count — a tile is the run's identity plus `RunSummary.live` and whether it is
 * the run the deck is showing.
 */
export interface HistoryTile {
  runId: string;
  live: boolean;
  /** The run the whole surface is currently projecting. */
  current: boolean;
  /** World position on the wall row (from `rail.ts`, never from the data). */
  x: number;
  z: number;
}

/**
 * The scene ribbon's geometry (`d07`), laid out once in the projection so the
 * renderer, the playhead and the tests share one mapping. The DOM strip draws
 * every bucket; the scene draws at most `bars` of them, merging neighbours past
 * `RIBBON_MAX_BARS`, and never thinner than `RIBBON_MIN_PITCH` — the strip is
 * as wide as the rail or wider, but its bars stay readable.
 */
export interface RibbonRail {
  /** Bars drawn: `min(ribbon.length, RIBBON_MAX_BARS)`, `0` with no window. */
  bars: number;
  /** Centre-to-centre bar distance, in world units (`0` when no bars). */
  pitch: number;
  /** Centre X of bar 0 (bar `i` is at `x0 + i × pitch`), `0`-bar case aside. */
  x0: number;
  /** Centre Z of the strip, behind the rail's far edge. */
  z: number;
}

/**
 * The temporal layer's input (`d07`): the window's index and the cursor. The
 * index is built once per event window (`buildHistoryIndex`), never per model
 * build; `seq === null` means live — the DTOs are the truth and the log is
 * only the ribbon.
 */
export interface DeckHistoryInput {
  index: HistoryIndex;
  seq: number | null;
}

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
   * Live workers in station order (lane order, ties in board order) — the lane
   * strip, the `[`/`]` cycle and the HUD's `live: N`. Pads carry the same fact
   * per node; this is the ordered projection of it, so the overlay never
   * re-derives the order. `stations` carries the same ids with their slots.
   */
  liveIds: string[];
  /**
   * The live workers as stations (`d04`), every live id exactly once: the
   * pooled ones in slot order, then the overflow ones the tier cannot draw.
   * The scene draws this array and nothing else; the lane list lists it.
   */
  stations: DeckStation[];
  /** Workers the station pool cannot hold (HUD count; `0` when everything fits). */
  stationOverflow: number;
  /**
   * Every active alert (`deriveAlerts`), severity first, with the operator's
   * dismissals already applied: what the DOM stack renders, verbatim.
   */
  alerts: DeckAlert[];
  /**
   * The subset the scene draws beacons for (`≤ maxBeacons`, first in `alerts`
   * order, so the most severe always get one). Overflow is counted in
   * `alertsOverflow` and every alert keeps its stack row — a capped scene
   * never means a hidden alert.
   */
  beaconAlerts: DeckAlert[];
  /** Alerts with no beacon left in the tier's budget (`0` normally). */
  alertsOverflow: number;
  /**
   * Inputs the slot policy had to repair (a malformed lane, a collision, a
   * duplicate live id). Empty in normal operation; rendered in the HUD so a
   * repair is never silent.
   */
  warnings: string[];
  /**
   * The worker in front of the operator (`focusTarget`): the pin when one is
   * set, else the live primary, else the overall primary. `null` on an empty
   * roadmap; equal to `primaryId` when nothing is pinned and no worker runs.
   */
  focusId: string | null;
  /** Extent of `nodes`, for the default framing and the floor grid. */
  bounds: RailBounds;
  /**
   * The run's event ribbon (`d07`): the whole event window as ≤
   * `RIBBON_MAX_BUCKETS` time buckets, empty ones included. It is an *index*
   * of the log, never a second state model — the pads' statuses stay the
   * DTOs' (live) or the log's at the cursor (history).
   */
  ribbon: RibbonBucket[];
  /** The bucket the history cursor sits in, `-1` while live. */
  ribbonCursor: number;
  /**
   * The buckets a cursor can occupy (`HistoryIndex.recorded`): the ribbon's
   * positions that carry a recorded event. The strip draws every bucket; the
   * scrubber walks this list, so its positions are all real moments.
   */
  ribbonRecorded: number[];
  /** The strip's geometry: where the drawn bars stand (`rail.ts` decides). */
  ribbonRail: RibbonRail;
  /**
   * The temporal cursor. `null` = live: every pad, count and alert is the
   * DTO's. A number = the seq whose log-derived state the pads show, and the
   * stations, beacons and alerts are empty by rule (they describe the run as
   * it is now; a past moment has none of them).
   */
  historySeq: number | null;
  /** Timestamp of the newest event at or before the cursor (`null` while live). */
  historyAt: string | null;
  /** Workers in flight *at the cursor* — the concurrency answer (`0` while live). */
  historyActive: number;
  /** Previous runs as the wall row, newest first, capped at the tile budget. */
  tiles: HistoryTile[];
  /** Runs the tile row could not draw (`0` normally; the DOM list shows all). */
  tilesOverflow: number;
  /**
   * Content key of everything the renderer consumes. Derived from the
   * projection (never a counter), so identical inputs give an identical
   * digest and the scene can prove it did no work.
   */
  digest: string;
}

/**
 * Everything the projection reads. `events`, `agents` and `prefs` are part of
 * the contract for the slices that consume them (`d03` focus/live window,
 * `d04` stations); the rail itself is a function of `detail` + `selected` +
 * `runId` only, which is why an event or worker churn cannot touch the scene.
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
  /**
   * Dismissal keys (`dismissKey` in `alerts.ts`) the operator has cleared.
   * View state, so it enters here rather than inside `deriveAlerts`: the
   * taxonomy is a function of the DTOs, what the operator has acknowledged is
   * a function of the session.
   */
  dismissed: ReadonlySet<string>;
  /**
   * How many stations the operator's tier can draw (`TIER_BUDGETS[tier].maxStations`).
   * The projection, not the renderer, decides which workers get a slot, so the
   * overflow count and the lane list agree with the scene by construction.
   */
  maxStations: number;
  /** Beacons the tier can draw (`TIER_BUDGETS[tier].maxBeacons`), same rule. */
  maxBeacons: number;
  /**
   * The temporal layer (`d07`). `null` before a window loads or when it has no
   * parseable times: the model then draws no ribbon and stays live. The index
   * is the caller's memo — the model may call `snapshotAt` (pure) but never
   * builds a second index.
   */
  history: DeckHistoryInput | null;
  /**
   * The run list the shell already polls (`api.runs()`), oldest first as the
   * endpoint returns it. The model takes the newest `HISTORY_TILE_CAP` for the
   * wall row and counts the rest — the DOM list shows every one of them.
   */
  runs: readonly RunSummary[];
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
  /**
   * The run's event window for the temporal layer (`d07`), newest-bounded by
   * the shell (`App.tsx`'s paging cap) and *distinct from* `events`: `events`
   * is the bounded live window the feed and the inspector read, this is the
   * window history is derived from. Superset of `events` in practice, and
   * never larger than the shell's cap.
   */
  timeline: RunEvent[];
  /**
   * True when the run's log is longer than the window (the shell saw a full
   * page past the cap). The temporal layer states its span either way; this
   * only lets the bar say "newest N events" instead of implying the whole run.
   */
  timelineTruncated: boolean;
  /** `api.runs()` as the shell polls it (oldest first) — the history wall. */
  runs: RunSummary[];
  /** Switch the whole surface to another run (App's existing `openRun`). */
  onOpenRun: (runId: string) => void;
  /** The app's single selection system — the same state the board writes. */
  onSelect: (sliceId: string) => void;
  /**
   * The dock's control outcomes run through the shell's own refresh path (the
   * same handler the dashboard hands its inspector): refetch this run and the
   * run list. The deck itself never fetches.
   */
  onControlDone: () => void;
  /**
   * The last `/replay` result the operator asked for (`null` until then; reset
   * on a run switch). The deck renders it as text and never reconstructs it:
   * the comparison of the store's replay against the cursor is the server's
   * own answer.
   */
  replay: ReplayState | null;
  /** Ask the shell for a fresh `/replay` of the current run (explicit only). */
  onVerifyReplay: () => void;
  /** Switch back to the dashboard surface (the `D` key and the HUD button). */
  onExit: () => void;
}

/**
 * One `/replay` outcome, as the deck shows it: the counts the endpoint
 * returned, plus the error path so a failed fetch is not silently "0
 * mismatches". `status` is the only thing the deck decides.
 */
export interface ReplayState {
  status: "loading" | "ready" | "error";
  /** `RunReplay.events` — how many events the server checked. */
  events: number;
  /** Mismatch lines (`"<slice>: expected X got Y"`), empty when the log agrees. */
  mismatches: string[];
  /** The error message when the request failed. */
  error: string | null;
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
   * Stations drawn (`d04`): one per live worker the tier's pool holds, each
   * `SHAFT_SEGMENTS` marks at most. Independent of focus, so switching the
   * focused worker costs no instances.
   */
  stations: number;
  /** Instances those stations occupy (their filled stage marks). */
  stationMarks: number;
  /** Alert markers drawn (failed / blocked-env beacons) — `d02`, counted here. */
  markers: number;
  /**
   * Event-ribbon instances drawn (`d07`): one bar per non-empty-or-empty bucket
   * (a bar for every bucket in the window) plus the history cursor playhead.
   * `0` when the window has no parseable times.
   */
  ribbon: number;
  /** Run-wall tiles drawn (`d07`), one per `model.tiles` entry. */
  tiles: number;
  /**
   * Alert beacons drawn (`d05`) — `SEVERITY_RINGS[severity]` rings per alert in
   * `model.beaconAlerts`. Zero when no alert is active, which is the normal
   * state of a healthy run.
   */
  beacons: number;
  /**
   * Transition cues active in the last frame (`d05`). `0` in every steady
   * state; a sequence of transitions must return to `0` when it ends, which is
   * the acceptance test for "no queue growth".
   */
  tweens: number;
  /** Distinct entities with an active cue in the last frame. */
  animatedEntities: number;
  /**
   * Cumulative instance-buffer rewrites. A model application is one; each
   * animated frame is another while cues last. This is the "scene mutations"
   * figure of the transition cost, and it is monotonic, so a spec can diff it.
   */
  sceneWrites: number;
  /**
   * Filled marks of the *focused* station (`d03`) — 0 when nothing is framed
   * or the framed slice is not live. Read from the model, so it is correct
   * before the frame that draws it.
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
  { key: "T", codes: ["t"], effect: "Cycle quality tier (auto → minimal → standard → high → flat)", slice: "d01" },
  { key: "H / ?", codes: ["h", "?"], effect: "Keymap and budget HUD", slice: "d01" },
  { key: "D", codes: ["d"], effect: "Switch to the dashboard surface", slice: "d01" },
  { key: "F", codes: ["f"], effect: "Frame the selection (pin it)", slice: "d03" },
  { key: "Esc", codes: ["Escape"], effect: "Close the dock if it is open, else release the pin", slice: "d06" },
  { key: "Space", codes: [" "], effect: "Freeze / resume the live window", slice: "d03" },
  { key: "E", codes: ["e"], effect: "Expand the live window to the raw transcript", slice: "d03" },
  { key: "[ / ]", codes: ["[", "]"], effect: "Previous / next live worker (focus only — F frames it)", slice: "d04" },
  { key: "arrow keys", codes: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], effect: "Pan the camera along the floor", slice: "d03" },
  { key: "wheel / + / -", codes: ["+", "=", "-"], effect: "Zoom the camera", slice: "d03" },
  { key: "C", codes: ["c"], effect: "Cycle camera preset (command ↔ rail)", slice: "d03" },
  { key: "0", codes: ["0"], effect: "Reset the camera to the preset's framing", slice: "d03" },
  { key: "1…8", codes: ["1", "2", "3", "4", "5", "6", "7", "8"], effect: "Open the dock on inspector tab N", slice: "d06" },
  { key: "M", codes: ["m"], effect: "Toggle reduced motion (transitions off, alerts unchanged)", slice: "d05" },
  { key: ", / .", codes: [",", "."], effect: "History: step one bucket back / forward (`.` past the end returns live)", slice: "d07" },
  { key: "L", codes: ["l"], effect: "History: return to live", slice: "d07" },
  { key: "P", codes: ["p"], effect: "History: play / pause the recorded run (from live, replays from the start)", slice: "d07" },
];

/** The debug hook the e2e suite and `d10` assert against. Not public API. */
export interface DeckDebugHook {
  /** The **effective** tier: auto-classified, auto-demoted or pinned (`d10`). */
  tier: QualityTier;
  /**
   * `"auto"` while the tier is the deck's own decision (classification or an
   * automatic demotion); `"pinned"` only when the operator's `T` chose it.
   */
  tierSource: "auto" | "pinned";
  /** The automatic demotion in effect, or `null` (`d10`). */
  autoTier: QualityTier | null;
  /** True once an explicit operator choice has taken the tier back (`d10`). */
  autoStopped: boolean;
  /** Automatic demotions this page's life; at most `AUTO_DOWNGRADE_LIMIT`. */
  downgrades: number;
  /** Median frame cost of the window that triggered the last demotion, ms. */
  downgradeMedianMs: number;
  /** Which projection is on screen (`d09`): the WebGL scene, or the flat deck. */
  availability: "3d" | "flat";
  /** Why the flat projection is up; `null` while the scene renders (`d09`). */
  flatReason: "no-webgl2" | "context-lost" | "create-failed" | "forced" | null;
  /** `webglcontextlost` events the deck handled this page's life (`d09`). */
  contextLost: number;
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
  /**
   * `renderer.info.memory` — live GPU resources in the current context
   * (`d10`'s disposal audit: 20 mount/unmount cycles must return these to the
   * first mount's values, and a renderer that leaks shows up as growth).
   */
  geometries: number;
  textures: number;
  programs: number;
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
  /** Stations the pool drew (`d04`), their instances, and the workers it could not hold. */
  stations: number;
  stationMarks: number;
  /** Alert markers drawn — half of the `instances` identity the specs assert. */
  markers: number;
  /** Alert beacons drawn (`d05`), the active alert count, and the cap overflow. */
  beacons: number;
  alerts: number;
  alertsOverflow: number;
  /** Transitions (`d05`): active cues, animated entities, and the resolved motion flag. */
  tweens: number;
  animatedEntities: number;
  motion: "full" | "reduced";
  /**
   * The deltas the last applied model produced (`d05`): the deck's own record
   * of which worker changed and to what. Allocated per model application, never
   * per frame. `attempt` deltas are included (they are recorded, not animated).
   */
  deltas: { kind: string; id: string | null; from?: string; to?: string }[];
  /** Dismissed alert keys — the session's acknowledgements, for the specs. */
  dismissed: string[];
  stationOverflow: number;
  /** Live workers with no on-screen station, by id (`d04` edge markers). */
  offScreen: string[];
  /**
   * The inspection dock (`d06`): whether the 2D surface is open and which tab
   * it shows. View state — the specs assert it does not move the camera, the
   * selection or the scene.
   */
  dockOpen: boolean;
  dockTab: string;
  /**
   * The temporal layer (`d07`): the history cursor (`null` while live), the
   * bucket it sits in, the ribbon bars and wall tiles **drawn** (the renderer's
   * own counters, from the same snapshot as `instances`), and whether the
   * playback timer is running. The window's bucket count — which the drawn
   * bars are capped against (`RIBBON_MAX_BARS`) — is `ribbonBuckets`. All view
   * state; none of it reaches the store.
   */
  historySeq: number | null;
  historyBucket: number;
  historyActive: number;
  ribbon: number;
  tiles: number;
  /** Buckets in the event window (≤ `RIBBON_MAX_BUCKETS`); drawn bars may be fewer. */
  ribbonBuckets: number;
  playing: boolean;
  /** Camera state last written to the renderer (view state, for the specs). */
  camera: DeckCamera;
  /** Filled marks of the focused station (`0` when nothing is framed). */
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
