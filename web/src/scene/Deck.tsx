/**
 * The deck surface (roadmap slices `d01`–`d02`, inspection dock `d06`).
 *
 * A React boundary and nothing more: it reads preferences, probes the tier,
 * owns the renderer + frame-loop lifecycle, projects the app's state into a
 * `DeckModel` (`buildDeckModel`, pure) and renders a canvas plus a DOM overlay.
 * It fetches nothing, derives nothing that `web/src/lib/**` or `model.ts`
 * already derives, and never mutates domain state — every value it shows
 * arrives as a prop or comes from the renderer/instrument it owns.
 *
 * Layout: the HUD is plain DOM at 4 Hz; the canvas is the only thing that
 * redraws, and only when something asked for a frame (`loop.request()`), an
 * animation is in flight (the 200 ms intro fade), or the window was resized. A
 * model whose digest is unchanged (an event landed, a worker line moved) does
 * not even ask. The stage (`.omp-deck-stage`) is the box the scene owns; the
 * inspection dock (`d06`) narrows it — the dock's state never reaches the
 * model, so opening it moves nothing the scene draws.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SliceDetail } from "../api.ts";
import { INSPECTOR_TABS, type InspectorTab } from "../components/Inspector.tsx";
import { describeEvent } from "../lib/events.ts";
import { formatDurationMs } from "../lib/format.ts";
import { appendDismissed, DISMISSED_KEY, dismissKey, parseDismissed, type DeckAlert } from "./alerts.ts";
import {
  AMBIENT_EFFECTS,
  AMBIENT_IDS,
  ambientEnabled,
  ambientRows,
  ambientSummary,
  driftOffset,
  toggleEffect,
  type AmbientEffectId,
} from "./ambient.ts";
import { diffModels, type SceneDelta } from "./deltas.ts";
import { attemptSegments, buildHistoryIndex, type RibbonBucket } from "./history.ts";
import { buildDeckModel } from "./model.ts";
import { DOCK_CLOSED, dockOnNewSelection, dockTabForKey, hideDock, showDockTab, type DockState } from "./dock.ts";
import DeckInspector from "./DeckInspector.tsx";
import DeckOverlay from "./DeckOverlay.tsx";
import { deckAvailability, deckMode, nextDeckMode, type DeckAvailability } from "./fallback.ts";
import { focusTarget, nextLiveId } from "./focus.ts";
import {
  applyCameraIntent,
  edgeAnchor,
  focusIntent,
  isDegradedView,
  lerpCamera,
  maxRetreatFor,
  offScreenIds,
  type CameraIntent,
  type EdgeMarker,
} from "./camera.ts";
import { stationCountLabel } from "./lanes.ts";
import { capLabels, labelIds } from "./labels.ts";
import { createFrameLoop, type FrameLoop } from "./loop.ts";
import { createDeckRenderer, probeRendererString, type DeckRenderer } from "./renderer.ts";
import { instrument } from "./instrument.ts";
import { classifyRenderer, createTierController, TIER_BUDGETS, type QualityTier, type TierController, type TierDowngrade } from "./tier.ts";
import {
  DECK_PREFS_KEY,
  DEFAULT_CAMERA,
  DEFAULT_DECK_PREFS,
  parseDeckPrefs,
  type DeckCamera,
  type DeckDebugHook,
  type DeckModel,
  type DeckPrefs,
  type DeckProps,
  type RailBounds,
} from "./types.ts";

const HUD_MS = 250;
const RESIZE_DEBOUNCE_MS = 150;
/** Camera flights are short and rare: one per focus change, never per frame. */
const CAMERA_LERP_MS = 450;
/** One arrow key press, in world units; one wheel notch, as a zoom factor. */
const PAN_STEP = 1.2;
const ZOOM_STEP = 1.12;
/**
 * Playback cadence (`d07`): one bucket per tick. The scene *jumps* between two
 * recorded states — nothing interpolates a status — so the cadence only decides
 * how fast the operator walks the log, and a whole window replays in
 * ≤ `RIBBON_MAX_BUCKETS × this`.
 */
const PLAY_MS = 320;
/**
 * Projected labels shown at once (`ux01`): the focus/primary pair plus live
 * workers, capped for human parsing — past this the remainder keeps its lane
 * row and the label layer states the count. Focus + primary are never capped
 * away (`capLabels`).
 */
const LABEL_CAP = 8;
/**
 * The two camera presets this slice owns (`d04` adds `topology`): `command`
 * frames the focus target, `rail` fits the whole roadmap. Auto-framing only
 * happens in `command` — an operator who asked for the overview keeps it.
 */
export type DeckCameraPreset = "command" | "rail";

interface HudReadout {
  fps: number;
  drawCalls: number;
  objects: number;
  stations: number;
  lines: number;
  vertices: number;
  pixels: number;
  shadedPixels: number;
  shaderMs: number;
  frameP50: number;
  frameP95: number;
  frameWorst: number;
  frames: number;
  commitsPerSec: number;
  mutationsPerSec: number;
  domElements: number;
  layoutMs: number;
  longTasks: number;
  longTaskWorstMs: number;
  /** Transition counters (`d05`), read from the renderer's own statistics. */
  tweens: number;
  animatedEntities: number;
  sceneWrites: number;
  beacons: number;
  settles: number;
  heapUsedBytes: number | null;
  heapReason: string;
  eventsPerSec: number;
  latencyP50: number;
  latencySamples: number;
  /** Dock latencies (`d06`): intent → painted, p50 per interaction. */
  interactionOpen: number;
  interactionClose: number;
  interactionTab: number;
  interactionSamples: number;
  deferred: number;
  idleStops: number;
}

/**
 * Field-by-field equality for the HUD's **always-visible row only**. While the
 * deck is idle nothing the row shows changes, so a settled deck stops
 * re-rendering entirely — the per-second rates and the panel-only metrics decay
 * continuously and would otherwise commit seven times a second for pixels
 * nobody is looking at. The panel is ticked unconditionally while it is open.
 */
function sameCompactReadout(a: HudReadout, b: HudReadout): boolean {
  return (
    a.fps === b.fps &&
    a.drawCalls === b.drawCalls &&
    a.objects === b.objects &&
    a.pixels === b.pixels
  );
}

/** Bounds identity for "did the world change size?" — extent, not equality. */
function boundsShape(bounds: RailBounds): string {
  return `${bounds.width},${bounds.depth},${bounds.centerX},${bounds.centerZ}`;
}

/**
 * Run `callback` after the frame that follows the current one — the first
 * moment a change committed in this tick can have been painted. Used for the
 * dock's intent→painted latencies (`d06`); it schedules two frames and costs
 * nothing on the path it measures.
 */
function afterPaint(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function readPrefs(): DeckPrefs {
  try {
    return parseDeckPrefs(window.localStorage.getItem(DECK_PREFS_KEY));
  } catch {
    return DEFAULT_DECK_PREFS; // private mode: preferences are best-effort
  }
}

function writePrefs(prefs: DeckPrefs): void {
  try {
    window.localStorage.setItem(DECK_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: the session keeps the in-memory value.
  }
}

/**
 * Dismissed alerts (`d05`): client-side view state, one run-prefixed key per
 * acknowledged condition (`dismissKey`). Storage that cannot be read or
 * written degrades to session memory — never a throw, and never an alert the
 * operator cannot clear.
 */
function readDismissed(): string[] {
  try {
    return parseDismissed(window.localStorage.getItem(DISMISSED_KEY));
  } catch {
    return [];
  }
}

function writeDismissed(keys: string[]): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys));
  } catch {
    // Private mode: the dismissals last as long as the page does.
  }
}

/**
 * The shell types `sliceDetail` as `SliceDetail | Record<string, unknown>`
 * because its own state is written by more than one fetch (a failed lookup
 * stores `{ error }`). The projection may only see a real detail, so the
 * boundary narrows on the one field it will read.
 */
function asSliceDetail(value: DeckProps["sliceDetail"]): SliceDetail | null {
  if (value === null || typeof value !== "object") return null;
  if (!("sliceId" in value) || typeof value.sliceId !== "string") return null;
  // The shell's state is the union of a real fetch and its failure marker; the
  // `sliceId` check is what separates them, and this is the one place that
  // trusts the rest of the shape (the model reads only optional fields).
  const detail = value as SliceDetail;
  return detail;
}

/**
 * The debug hook survives unmounts so a switch-away is observable: `mounted`
 * and `disposed` accumulate across the page's lifetime.
 */
function deckHook(): DeckDebugHook {
  const page = window as unknown as { __ompoDeck?: DeckDebugHook };
  if (!page.__ompoDeck) {
    page.__ompoDeck = {
      tier: "standard",
      tierSource: "auto",
      autoTier: null,
      autoStopped: false,
      downgrades: 0,
      downgradeMedianMs: 0,
      availability: "3d",
      flatReason: null,
      contextLost: 0,
      mounted: 0,
      disposed: 0,
      frames: 0,
      drawCalls: 0,
      objects: 0,
      triangles: 0,
      vertices: 0,
      pixels: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
      nodes: 0,
      edges: 0,
      instances: 0,
      digest: "",
      selected: null,
      hover: null,
      focused: null,
      pinned: null,
      frozen: null,
      cameraPreset: "command",
      liveCount: 0,
      stations: 0,
      stationMarks: 0,
      markers: 0,
      beacons: 0,
      alerts: 0,
      alertsOverflow: 0,
      tweens: 0,
      animatedEntities: 0,
      motion: "full",
      deltas: [],
      dismissed: [],
      stationOverflow: 0,
      offScreen: [],
      dockOpen: false,
      dockTab: "Output",
      historySeq: null,
      historyBucket: -1,
      historyActive: 0,
      ribbon: 0,
      tiles: 0,
      ribbonBuckets: 0,
      settles: 0,
      ambient: [],
      completion: null,
      playing: false,
      camera: { ...DEFAULT_CAMERA, target: { ...DEFAULT_CAMERA.target } },
      cameraDrift: { x: 0, z: 0 },
      stationSegments: 0,
      liveRows: 0,
      logLines: 0,
      positions: [],
      screenPosition: null,
      instrument,
    };
  }
  return page.__ompoDeck;
}

export default function Deck({
  runId,
  detail,
  events,
  timeline,
  timelineTruncated,
  runs,
  agents,
  selected,
  sliceDetail,
  live,
  onSelect,
  onOpenRun,
  onControlDone,
  replay,
  onVerifyReplay,
  onExit,
}: DeckProps) {
  const [prefs, setPrefs] = useState<DeckPrefs>(readPrefs);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [hudOpen, setHudOpen] = useState(false);
  const [readout, setReadout] = useState<HudReadout | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Deck view state (never persisted, never domain state): the pin that
  // overrides auto-follow, the frozen live window (keyed to its slice), and
  // whether the window shows the raw transcript.
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [frozenId, setFrozenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  /** Alert stack collapsed (`d05`): view state, like the window's freeze. Auto-collapses past 2 rows (`ux03`, effect below the model). */
  const [alertsCollapsed, setAlertsCollapsed] = useState(false);
  /**
   * The temporal cursor (`d07`): `null` = live, a seq = the log's state at
   * that moment. Deck-local view state — the store, the run and the app's own
   * selection are never touched by scrubbing; leaving history restores the
   * live projection exactly.
   */
  const [historySeq, setHistorySeq] = useState<number | null>(null);
  /** Playback runs only in history mode and stops at the window's last bucket. */
  const [playing, setPlaying] = useState(false);
  /** The history wall's DOM list (the tiles themselves are inert geometry). */
  const [wallOpen, setWallOpen] = useState(false);
  /**
   * The inspection dock (`d06`): 2D view state, like the pin and the freeze.
   * The scene is untouched by it — `buildDeckModel` never sees this — and the
   * only spatial effect is the stage resize when it opens (`data-dock`).
   */
  const [dock, setDock] = useState<DockState>(DOCK_CLOSED);
  /** `command` follows the work; `rail` is the operator's whole-run overview. */
  const [preset, setPreset] = useState<DeckCameraPreset>("command");
  /**
   * Projected spatial labels (`ux01`): screen-space positions of the label
   * set, recomputed when the camera settles or the world changes — never per
   * frame. Entries whose pad projects to `null` (off-screen, behind) are
   * suppressed by rule, not hidden by clipping.
   */
  const [labelPositions, setLabelPositions] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const labelKeyRef = useRef("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef(dock);
  dockRef.current = dock;
  /**
   * A tab asked for together with a subject (`d07`'s bucket click): the
   * selection effect consumes it instead of resetting the tab to `Output`.
   */
  const explicitTabRef = useRef<{ sliceId: string; tab: InspectorTab } | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<DeckRenderer | null>(null);
  const loopRef = useRef<FrameLoop | null>(null);
  const markedSeqRef = useRef(-1);
  const lastReadoutRef = useRef<HudReadout | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const rectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const hoverRef = useRef<string | null>(null);
  /** The camera as the renderer last received it, and the flight in progress. */
  const cameraRef = useRef<DeckCamera>(DEFAULT_CAMERA);
  const tweenRef = useRef<{ from: DeckCamera; to: DeckCamera; startedAt: number; durationMs: number } | null>(null);
  /**
   * Focus drift (`d13`): the phase's origin (the mount, so the wander continues
   * across animation episodes instead of restarting) and whether the pose on
   * the canvas is currently drifted — the flag that guarantees the exact
   * framing is restored before the loop settles.
   */
  const driftEpochRef = useRef(performance.now());
  const driftAppliedRef = useRef(false);
  /** What the last framing decision was about, so it happens once per change. */
  const framingRef = useRef<{ focusId: string | null; shape: string } | null>(null);
  /** Set when a model change still owes the scene a frame (the latency stage). */
  const sceneStagePendingRef = useRef(false);
  const [ready, setReady] = useState(false);
  // A WebGL2 context can still fail to come up (driver crash, context limit);
  // that is the same product state as no WebGL2 at all, not a crashed surface.
  const [contextFailed, setContextFailed] = useState(false);
  // A context the driver takes away mid-session (`webglcontextlost`) is a third
  // such state: keep the model, switch projection, offer the fresh-context retry.
  const [contextLost, setContextLost] = useState(false);

  // One probe per mount: the string is what `classifyRenderer` was measured on.
  const rendererString = useMemo(() => probeRendererString(), []);
  /**
   * The automatic tier's feedback loop (`d10`). `autoTier` is the demotion the
   * controller issued, `autoStopped` is the operator's explicit choice that
   * ends it, and the notice is the one-shot HUD chip. All three are session
   * state; the tier the operator owns is `prefs.tier`.
   */
  const [autoTier, setAutoTier] = useState<QualityTier | null>(null);
  const [autoStopped, setAutoStopped] = useState(false);
  const [downgradeNotice, setDowngradeNotice] = useState<TierDowngrade | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  /** The effects list is a disclosure inside the HUD panel (`d13`). */
  const [effectsOpen, setEffectsOpen] = useState(false);
  /** The tier before any automatic demotion: classification or the pin. */
  const baseTier: QualityTier =
    prefs.tier === "auto" ? (rendererString === null ? "standard" : classifyRenderer(rendererString)) : prefs.tier;
  /** The tier on screen: an automatic demotion outranks its source. */
  const tier: QualityTier = autoTier ?? baseTier;
  const budget = TIER_BUDGETS[tier];
  const tierSource: "auto" | "pinned" = autoTier !== null || prefs.tier === "auto" ? "auto" : "pinned";
  /**
   * One controller per arming, created from the source tier. It is *not*
   * re-created when it demotes (that would reset its two-step allowance and
   * re-arm it at its own output); an explicit `T` replaces or stops it.
   */
  const controllerRef = useRef<TierController | null>(null);
  const downgradeCountRef = useRef(0);
  const pendingDowngradeRef = useRef<TierDowngrade | null>(null);
  useEffect(() => {
    controllerRef.current = autoStopped ? null : createTierController(baseTier);
  }, [baseTier, autoStopped]);
  /**
   * Feed one frame's render cost to the controller (`d10`). A demotion is
   * only *recorded* here: it is applied on a frame with no tween or cue in
   * flight, so the operator never sees the tier change land inside an
   * animation.
   */
  const observeFrameCost = useCallback((renderMs: number): void => {
    const downgrade = controllerRef.current?.observe(renderMs) ?? null;
    if (downgrade !== null) pendingDowngradeRef.current = downgrade;
  }, []);
  const applyPendingDowngrade = useCallback((): void => {
    const downgrade = pendingDowngradeRef.current;
    if (downgrade === null) return;
    pendingDowngradeRef.current = null;
    downgradeCountRef.current++;
    setAutoTier(downgrade.to);
    setDowngradeNotice(downgrade);
    deckHook().downgradeMedianMs = downgrade.medianMs;
  }, []);
  const systemReducedMotion = useMemo(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  // `M` owns an explicit choice (`on` / `reduced`); `system` follows the OS at
  // mount. The explicit choice is what lets `M` turn motion back on where the
  // OS asks for reduced motion.
  const reducedMotion = prefs.motion === "system" ? systemReducedMotion : prefs.motion === "reduced";
  /**
   * The expression layer (`d13`): which effects this deck is running, resolved
   * from the tier, the motion choice and the operator's own overrides. A tier
   * change (an automatic demotion included) re-resolves it, which is how a
   * machine that cannot afford an effect stops paying for it mid-session.
   */
  const ambientState = useMemo(() => ambientEnabled(tier, prefs, reducedMotion), [tier, prefs, reducedMotion]);
  const ambientRef = useRef(ambientState);
  ambientRef.current = ambientState;
  // Which projection may render (`d09`). The decision is made before any
  // renderer exists, so a no-WebGL2 device never creates a canvas it cannot
  // use; a lost or uncreatable context degrades to the same flat surface.
  const availability: DeckAvailability = deckAvailability({
    webgl2: rendererString !== null,
    tier,
    forced: contextLost || contextFailed ? "flat" : prefs.forced,
    reducedMotion,
  });
  const flatReason = availability !== "flat"
    ? null
    : rendererString === null
      ? "no-webgl2"
      : contextLost
        ? "context-lost"
        : contextFailed
          ? "create-failed"
          : "forced";
  // Every tier knob is applied to the live renderer except MSAA, which is fixed
  // when the GL context is created. Only that bit may rebuild the context.
  const contextKey = `${budget.antialias ? "aa" : "plain"}-${reducedMotion ? "still" : "motion"}`;

  const lastEvent = events.length > 0 ? events[events.length - 1]! : null;

  /**
   * The temporal index (`d07`): buckets, checkpoints and `snapshotAt` over the
   * shell's event window. Built once per window identity — never per scrub
   * tick and never per frame — so moving through history costs a bounded fold
   * (`CHECKPOINT_EVERY` events) plus one model build, whatever the window's
   * length. `timeline` changes identity only when an event arrives or the run
   * switches; the shell hands its own array.
   */
  const historyIndex = useMemo(() => buildHistoryIndex(timeline), [timeline]);
  /** The cursor the projection reads. `null` = live. */
  const historyInput = useMemo(
    () => (historySeq === null ? { index: historyIndex, seq: null } : { index: historyIndex, seq: historySeq }),
    [historyIndex, historySeq],
  );
  /**
   * The selected slice's observed attempts, from the dashboard's own
   * segmentation (`lib/timeline.ts`, via `history.ts`) — the strip answers
   * "how many tries has this taken, and how long was each", and a second
   * segmenter would be exactly the drift the roadmap's M1 rule forbids.
   */
  const attempts = useMemo(
    () => (selected === null ? [] : attemptSegments(timeline, selected)),
    [timeline, selected],
  );

  // The projection: application state in, an immutable model out. `events`,
  // `agents` and `prefs` are inputs the later slices consume; the rail is a
  // function of `detail` + `selected`, so their churn leaves the digest intact.
  // `maxStations` is the tier's cap: which workers get a station is a
  // projection decision, so the scene, the HUD count and the lane list agree.
  const projected = useMemo(
    () =>
      buildDeckModel({
        runId,
        detail,
        events,
        agents,
        selected,
        sliceDetail: asSliceDetail(sliceDetail),
        pinnedId,
        prefs,
        live,
        dismissed: new Set(dismissed),
        maxStations: budget.maxStations,
        maxBeacons: budget.maxBeacons,
        history: historyInput,
        runs,
      }),
    [
      runId,
      detail,
      events,
      agents,
      selected,
      sliceDetail,
      pinnedId,
      prefs,
      live,
      dismissed,
      budget.maxStations,
      budget.maxBeacons,
      historyInput,
      runs,
    ],
  );
  const lastModelRef = useRef<DeckModel | null>(null);
  /**
   * The model the *scene* last drew, for the transition diff. Distinct from
   * `lastModelRef`, which survives a run switch so the previous rail stays on
   * the floor while the next one loads (`d02`).
   */
  const previousModelRef = useRef<DeckModel | null>(null);
  // A run switch that is still loading keeps the previous pads on the floor
  // (d02 error behaviour): the world must not flash empty, and the DOM line
  // says what is happening instead. The digest stays the previous one because
  // the rail on screen *is* the previous rail.
  const model: DeckModel =
    projected.loading && lastModelRef.current
      ? {
          ...projected,
          nodes: lastModelRef.current.nodes,
          edges: lastModelRef.current.edges,
          counts: lastModelRef.current.counts,
          completion: lastModelRef.current.completion,
          primaryId: lastModelRef.current.primaryId,
          liveIds: lastModelRef.current.liveIds,
          alerts: lastModelRef.current.alerts,
          beaconAlerts: lastModelRef.current.beaconAlerts,
          alertsOverflow: lastModelRef.current.alertsOverflow,
          focusId: lastModelRef.current.focusId,
          bounds: lastModelRef.current.bounds,
          // The time axis stays with the world it belongs to: a run switch
          // shows the previous run's ribbon and wall until the next one's
          // timeline arrives, exactly like its pads.
          ribbon: lastModelRef.current.ribbon,
          ribbonRecorded: lastModelRef.current.ribbonRecorded,
          ribbonCursor: lastModelRef.current.ribbonCursor,
          historySeq: lastModelRef.current.historySeq,
          historyAt: lastModelRef.current.historyAt,
          historyActive: lastModelRef.current.historyActive,
          tiles: lastModelRef.current.tiles,
          tilesOverflow: lastModelRef.current.tilesOverflow,
          digest: lastModelRef.current.digest,
        }
      : projected;
  if (!projected.loading) lastModelRef.current = projected;
  const modelRef = useRef(model);
  modelRef.current = model;
  // Auto-collapse the alert stack past 2 rows (`ux03`): the head keeps the
  // count + highest severity, so the scan stays one line. Explicit expand
  // still wins within a run — this only fires when the count grows past 2.
  const alertCountRef = useRef(0);
  useEffect(() => {
    if (model.alerts.length > 2 && alertCountRef.current <= 2) setAlertsCollapsed(true);
    alertCountRef.current = model.alerts.length;
  }, [model.alerts.length]);
  // How many workers the tier's pool holds. `stations` also lists the workers
  // it cannot (so the lane list stays complete); the difference is the HUD's
  // overflow and what the scene folds into its stack marker.
  const pooledStations = model.stations.length - model.stationOverflow;
  /**
   * The run's ending (`d13`), as one line — `null` while anything is still to
   * run, and while the deck is at a historical cursor (the pads show the
   * recorded state then; "complete" is a present-tense claim). Complete is the
   * strict all-done case; a run that ended with failures or skips says what is
   * left over instead of staying silent, because "finished" and "done" are not
   * the same answer and the operator is owed the difference.
   */
  const completion = model.completion;
  const completionLine =
    historySeq !== null || completion === null || !completion.terminal
      ? null
      : completion.complete
        ? `run complete · ${completion.total} slice${completion.total === 1 ? "" : "s"}${
            completion.durationMs === null ? "" : ` · ${formatDurationMs(completion.durationMs)}`
          }`
        : `run finished · ${completion.done}/${completion.total} done${
            completion.failed > 0 ? ` · ${completion.failed} failed` : ""
          }${completion.skipped > 0 ? ` · ${completion.skipped} skipped` : ""}${
            completion.blocked > 0 ? ` · ${completion.blocked} blocked` : ""
          }`;

  /** Switch one effect on or off (`d13`); the renderer follows on the next frame. */
  const setEffect = useCallback((id: AmbientEffectId, on: boolean): void => {
    setPrefs((current) => {
      const next = toggleEffect(current, id, on);
      writePrefs(next);
      return next;
    });
  }, []);

  /**
   * The deck subtree is the mutation/layout subject the instrument watches —
   * HUD, overlay, dock and pad list included, because a status change
   * re-renders the DOM line exactly as much as it rewrites instance colours.
   * The dock is inside it deliberately: its mutations are part of what the
   * operator pays for, and `d06` measures them (`§9` of the slice brief).
   */
  const containerCallback = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    instrument.observeDom(element);
  }, []);

  /**
   * The stage is the area the scene owns: it shrinks by the dock's width when
   * the dock opens, so the camera keeps the whole world on screen instead of
   * being covered by a panel. Measuring and observing happen here; the section
   * above is only the instrument's subject and the key/focus scope.
   */
  const stageCallback = useCallback((element: HTMLDivElement | null) => {
    stageRef.current = element;
  }, []);

  const markRendered = useCallback((element: HTMLSpanElement | null, seq: number) => {
    if (!element || markedSeqRef.current === seq) return;
    markedSeqRef.current = seq;
    instrument.markEventRendered(seq);
  }, []);

  /** Canvas aspect, from the last measured size; 1 before the first layout. */
  const aspect = useCallback((): number => {
    const size = sizeRef.current;
    return size.height > 0 ? size.width / size.height : 1;
  }, []);

  /**
   * Off-screen live workers (`d04`): recomputed when the camera settles or the
   * world changes, never per frame — a marker is where a worker *is*, so it
   * moves only when the camera stops moving. The key guard means a settled
   * camera (and an unchanged live set) commits nothing at all.
   */
  const [edgeMarkers, setEdgeMarkers] = useState<EdgeMarker[]>([]);
  const edgeKeyRef = useRef("");
  const refreshEdgeMarkers = useCallback((): void => {
    const renderer = rendererRef.current;
    const current = modelRef.current;
    if (!renderer) {
      // The flat path has no camera, so nothing is off screen — the notice
      // says what is missing instead (`d09` builds the real fallback).
      if (edgeKeyRef.current !== "") {
        edgeKeyRef.current = "";
        setEdgeMarkers([]);
      }
      return;
    }
    const camera = cameraRef.current;
    const view = aspect();
    const hidden = new Set(offScreenIds(camera, current.nodes, view));
    const nodeById = new Map(current.nodes.map((node) => [node.id, node]));
    const markers: EdgeMarker[] = [];
    for (const id of current.liveIds) {
      const node = hidden.has(id) ? nodeById.get(id) : undefined;
      if (node === undefined) continue;
      markers.push({ id, ...edgeAnchor(camera, node, view) });
    }
    const key = markers
      .map((marker) => `${marker.id}@${marker.x.toFixed(3)},${marker.y.toFixed(3)},${marker.angle.toFixed(3)}${marker.behind ? "b" : ""}`)
      .join("|");
    if (key === edgeKeyRef.current) return;
    edgeKeyRef.current = key;
    deckHook().offScreen = markers.map((marker) => marker.id);
    setEdgeMarkers(markers);
  }, [aspect]);
  /**
   * Projected label positions (`ux01`): the `labelIds` set resolved to
   * screen-space points at pad-top height. Same cadence as the edge markers
   * (camera settle / world change, never per frame); a pad whose projection
   * is `null` stays out of the map, and a settled camera with an unchanged
   * set commits nothing. Labels never request a frame and never schedule one.
   */
  const refreshLabelPositions = useCallback((): void => {
    const renderer = rendererRef.current;
    const current = modelRef.current;
    if (!renderer) {
      if (labelKeyRef.current !== "") {
        labelKeyRef.current = "";
        setLabelPositions(new Map());
      }
      return;
    }
    const nodeById = new Map(current.nodes.map((node) => [node.id, node]));
    const next = new Map<string, { x: number; y: number }>();
    for (const id of labelIds(current)) {
      const node = nodeById.get(id);
      if (!node) continue;
      // Above the tallest pad (running/verifying 0.85) plus the station
      // column's headroom — a fixed anchor, never per-status math here.
      const point = renderer.project(node.x, 2.2, node.z);
      if (point) next.set(id, point);
    }
    const key = [...next.entries()].map(([id, point]) => `${id}@${point.x.toFixed(1)},${point.y.toFixed(1)}`).join("|");
    if (key === labelKeyRef.current) return;
    labelKeyRef.current = key;
    setLabelPositions(next);
  }, []);


  /** Write a camera state through to the renderer and publish it to the hook. */
  const applyCamera = useCallback((renderer: DeckRenderer, next: DeckCamera): void => {
    cameraRef.current = next;
    renderer.setCamera(next);
    const hook = deckHook();
    hook.camera = { ...next, target: { ...next.target } };
  }, []);

  /**
   * Apply an intent. Framing intents (`focus`/`rail`) fly for ≤ 450 ms unless
   * motion is reduced; direct-manipulation intents (pan/zoom/orbit) land at
   * once, because a lag between the wheel and the world reads as a bug.
   */
  const dispatchCamera = useCallback(
    (intent: CameraIntent, immediate = false): void => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const to = applyCameraIntent(cameraRef.current, intent);
      if (immediate || reducedMotion) {
        tweenRef.current = null;
        applyCamera(renderer, to);
        refreshEdgeMarkers();
        refreshLabelPositions();
      } else {
        tweenRef.current = { from: cameraRef.current, to, startedAt: performance.now(), durationMs: CAMERA_LERP_MS };
      }
      loopRef.current?.request();
    },
    [applyCamera, refreshEdgeMarkers, refreshLabelPositions, reducedMotion],
  );

  /** Frame one slice id, from the model's own node list. */
  const frameSlice = useCallback(
    (sliceId: string | null, immediate = false): void => {
      dispatchCamera(focusIntent({ focusId: sliceId, nodes: modelRef.current.nodes, bounds: modelRef.current.bounds }, aspect()), immediate);
    },
    [aspect, dispatchCamera],
  );

  /** Frame a preset: `rail` fits the roadmap, `command` the focus target. */
  const framePreset = useCallback(
    (next: DeckCameraPreset, immediate = false): void => {
      frameSlice(next === "rail" ? null : modelRef.current.focusId, immediate);
    },
    [frameSlice],
  );

  /** Write a model (and the transitions that led to it) into the scene. */
  const applyToScene = useCallback(
    (renderer: DeckRenderer, next: DeckModel, deltas: readonly SceneDelta[]): void => {
      if (!renderer.applyModel(next, deltas)) return;
      const hook = deckHook();
      const info = renderer.info();
      hook.instances = info.instances;
      hook.stations = info.stations;
      hook.stationMarks = info.stationMarks;
      hook.markers = info.markers;
      hook.beacons = info.beacons;
      // Drawn instances, from the one snapshot the other counters came from:
      // the instance identity (`d01`) reads them, and a second writer with the
      // *model's* bucket count made that identity depend on which effect ran
      // last. The window's own size is `ribbonBuckets` (`d09`).
      hook.ribbon = info.ribbon;
      hook.tiles = info.tiles;
      hook.tweens = info.tweens;
      hook.animatedEntities = info.animatedEntities;
      hook.deltas = deltas.map((delta) => {
        if (delta.kind === "status") return { kind: delta.kind, id: delta.id, from: delta.from, to: delta.to };
        if (delta.kind === "stage") return { kind: delta.kind, id: delta.id, from: String(delta.from), to: String(delta.to) };
        if (delta.kind === "attempt") return { kind: delta.kind, id: delta.id };
        if (delta.kind === "alert") return { kind: delta.kind, id: delta.id, to: delta.alert.kind };
        return { kind: delta.kind, id: delta.id, to: delta.alertKind };
      });
      hook.stationSegments = info.stationSegments;
      hook.positions = next.nodes.map((node) => ({ id: node.id, x: node.x, z: node.z }));
      // The model reached the scene; the frame that draws it is the scene stage.
      instrument.noteStage("model");
      sceneStagePendingRef.current = true;
      loopRef.current?.request();
    },
    [],
  );

  // The station line and the lane strip hang under the HUD, whose height
  // depends on how many chips the operator's window fits on one line. It is
  // measured, not assumed: a lane row covered by the HUD strip would hide the
  // primary worker, which is the one thing this surface may never do.
  useEffect(() => {
    const hud = hudRef.current;
    const section = containerRef.current;
    if (!hud || !section || typeof ResizeObserver !== "function") return;
    const measure = (): void => {
      section.style.setProperty("--omp-deck-hud-h", `${Math.ceil(hud.getBoundingClientRect().height)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(hud);
    return () => {
      observer.disconnect();
      section.style.removeProperty("--omp-deck-hud-h");
    };
    // `availability`: the HUD only exists in 3D, so returning from flat must
    // re-measure it (and flat clears the property it owned).
  }, [availability, ready, rendererString, contextFailed]);

  // Size first: a zero-size container gets no renderer at all (a 0-width
  // projection matrix is not a recoverable state, it is a bug). The subject is
  // the stage, which is what the dock narrows (`d06`); the measure, and the
  // pointer-picking rect with it, lands on the first resize notification while
  // the renderer resize is debounced, so opening the dock cannot leave picking
  // mapped to the old rectangle.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = (): { width: number; height: number } | null => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      sizeRef.current = { width: rect.width, height: rect.height };
      // Cached for pointer picking: a forced layout per pointermove is exactly
      // the cost the deck's instrument exists to catch.
      rectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      return { width: rect.width, height: rect.height };
    };
    const apply = (): void => {
      const size = measure();
      if (!size) return;
      const renderer = rendererRef.current;
      if (renderer) {
        renderer.setSize(size.width, size.height);
        loopRef.current?.request();
        refreshEdgeMarkers();
        refreshLabelPositions();
      } else {
        setReady(true);
      }
    };
    apply();
    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      measure();
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        apply();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(stage);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    };
    // `availability` re-runs this when the deck returns from flat mode: the
    // stage is a different element then, and it must be measured before the
    // renderer effect builds a context for it.
  }, [availability, refreshEdgeMarkers, refreshLabelPositions]);

  // Renderer + loop lifecycle: one WebGL context per mount. Creating contexts
  // is the expensive, fragile part on a software rasterizer (measured: a second
  // context can fail to come up at all), and a tier only changes parameters —
  // so only a change of `contextKey` (MSAA, reduced motion) rebuilds it.
  useEffect(() => {
    if (!ready || availability !== "3d") return;
    const canvas = canvasRef.current;
    const size = sizeRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;

    let renderer: DeckRenderer;
    try {
      renderer = createDeckRenderer(canvas, tier, { reducedMotion, ambient: ambientRef.current });
    } catch (error) {
      console.error("deck: WebGL2 context unavailable", error);
      setContextFailed(true);
      return;
    }
    setContextFailed(false);
    /**
     * The driver took the context away. The canvas a lost context lived on can
     * never hand out another one, so the deck keeps its model and state, shows
     * the flat projection, and the notice's retry mounts a fresh canvas
     * (`d09`). `preventDefault` is what makes a synthetic event — the e2e's —
     * behave like a real one here.
     */
    const onContextLost = (event: Event): void => {
      event.preventDefault();
      deckHook().contextLost++;
      setContextLost(true);
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    const hook = deckHook();
    const onFrame = (): void => {
      const active = rendererRef.current;
      if (!active) return;
      // Advance any camera flight before drawing, so the frame that is about to
      // be rendered is the frame the camera is in. When it lands, `isDirty()`
      // goes false and the loop stops scheduling — no per-frame camera work.
      const tween = tweenRef.current;
      if (tween) {
        const t = Math.min(1, (performance.now() - tween.startedAt) / tween.durationMs);
        applyCamera(active, lerpCamera(tween.from, tween.to, t * t * (3 - 2 * t)));
        if (t >= 1) {
          tweenRef.current = null;
          refreshEdgeMarkers();
          refreshLabelPositions();
        }
      }
      /**
       * Focus drift (`d13`): while a worker is live and the deck is already
       * animating (a camera flight, a transition cue), the framing breathes by
       * at most half a world unit. It is deliberately *not* a reason to render:
       * a settled deck draws no frame for it, and the frame that ends the last
       * animation restores the exact framing (below), so the world never rests
       * in a drifted pose and the published camera never moves.
       */
      const driftOn = ambientRef.current.drift && modelRef.current.focusId !== null;
      if (driftOn && (active.animating() || tweenRef.current !== null)) {
        const offset = driftOffset(performance.now() - driftEpochRef.current, true);
        // Published into a stable object (the specs read it): a camera flight
        // must not allocate per frame any more than the scene does.
        hook.cameraDrift.x = offset.x;
        hook.cameraDrift.z = offset.z;
        active.setCamera({
          ...cameraRef.current,
          target: {
            x: cameraRef.current.target.x + offset.x,
            y: cameraRef.current.target.y,
            z: cameraRef.current.target.z + offset.z,
          },
        });
        driftAppliedRef.current = true;
      } else if (driftAppliedRef.current) {
        active.setCamera(cameraRef.current);
        hook.cameraDrift.x = 0;
        hook.cameraDrift.z = 0;
        driftAppliedRef.current = false;
      }
      const started = performance.now();
      const stats = active.render();
      const renderMs = performance.now() - started;
      instrument.recordFrame(renderMs);
      observeFrameCost(renderMs);
      hook.frames++;
      hook.drawCalls = stats.drawCalls;
      hook.objects = stats.objects;
      hook.triangles = stats.triangles;
      hook.vertices = stats.vertices;
      hook.pixels = stats.pixels;
      hook.geometries = stats.geometries;
      hook.textures = stats.textures;
      hook.programs = stats.programs;
      hook.tweens = stats.tweens;
      hook.animatedEntities = stats.animatedEntities;
      hook.beacons = stats.beacons;
      hook.settles = stats.settles;
      // A drift that ends *inside* this frame (the cue it rode expired) must not
      // be left painted: one more frame restores the exact framing and then the
      // loop settles, because nothing else is dirty.
      if (driftAppliedRef.current && !active.animating() && tweenRef.current === null) {
        active.setCamera(cameraRef.current);
        hook.cameraDrift.x = 0;
        hook.cameraDrift.z = 0;
        driftAppliedRef.current = false;
        loop.request();
      }
      // The scene stage of the event pipeline: the first frame that draws a
      // changed model. Attribution is per event record (instrument.ts).
      if (sceneStagePendingRef.current) {
        sceneStagePendingRef.current = false;
        instrument.noteStage("scene");
      }
      // A demotion waits for a settled scene — no cue, no camera flight — so
      // the tier change (a canvas resize) never lands inside an animation.
      if (pendingDowngradeRef.current !== null && !active.animating() && tweenRef.current === null) {
        applyPendingDowngrade();
      }
    };
    const loop = createFrameLoop({
      onFrame,
      maxFps: budget.maxFps,
      isDirty: () => renderer.animating() || tweenRef.current !== null,
    });

    rendererRef.current = renderer;
    loopRef.current = loop;
    renderer.setCamera(DEFAULT_CAMERA);
    cameraRef.current = DEFAULT_CAMERA;
    // Mount order: the renderer exists after the size effect's state update, so
    // the model is applied here as well as from the model effect below. The
    // first paint carries no deltas: a freshly loaded deck must not animate the
    // whole world into existence (`diffModels(null, model)` is empty by rule).
    previousModelRef.current = modelRef.current;
    applyToScene(renderer, modelRef.current, []);
    renderer.setSize(size.width, size.height);
    // First paint frames the focus target (or the rail) immediately: an
    // animated first approach would be motion the operator did not ask for.
    frameSlice(modelRef.current.focusId, true);
    framingRef.current = { focusId: modelRef.current.focusId, shape: boundsShape(modelRef.current.bounds) };
    refreshEdgeMarkers();
    refreshLabelPositions();
    hook.screenPosition = (id: string) => {
      const node = modelRef.current.nodes.find((candidate) => candidate.id === id);
      const active = rendererRef.current;
      if (!node || !active) return null;
      return active.project(node.x, 0.2, node.z);
    };

    hook.mounted++;
    instrument.setTier(tier);
    instrument.setSources({ renderer: () => renderer.info(), loop: () => loop.stats() });
    instrument.start();
    loop.request();

    return () => {
      canvas.removeEventListener("webglcontextlost", onContextLost);
      loop.stop();
      instrument.stop();
      renderer.dispose();
      rendererRef.current = null;
      loopRef.current = null;
      pendingDowngradeRef.current = null;
      hook.disposed++;
      hook.screenPosition = null;
      hook.offScreen = [];
    };
    // `tier` and `prefs.tier` are read for the initial values only; later changes
    // go through the parameter effect below, which never rebuilds the context.
    // `availability` is in here so switching to flat (a lost context, `T`)
    // disposes the renderer, and returning to 3D builds one on the fresh canvas.
  }, [availability, ready, rendererString, contextKey]);

  // The expression layer (`d13`): one writer for the renderer and the hook. A
  // toggle is applied on the next frame, never rebuilds the context, and never
  // touches the model — the state on screen is the same state either way.
  useEffect(() => {
    const renderer = rendererRef.current;
    const hook = deckHook();
    hook.ambient = AMBIENT_IDS.filter((id) => ambientState[id]);
    if (!renderer) return;
    renderer.setAmbient(ambientState);
    loopRef.current?.request();
  }, [ambientState]);

  // The tier, where it came from, and the automatic-demotion record (`d10`).
  // One writer for all of it: the renderer lifecycle above and the parameter
  // effect below publish neither — two writers on one hook field made the
  // `d01` instance identity flake (`d09`), and this is the same trap.
  useEffect(() => {
    const hook = deckHook();
    hook.tier = tier;
    hook.tierSource = tierSource;
    hook.autoTier = autoTier;
    hook.autoStopped = autoStopped;
    hook.downgrades = downgradeCountRef.current;
  }, [tier, tierSource, autoTier, autoStopped]);

  // Model changes: rewrite the rail's buffers (in place; the renderer diffs on
  // the digest) and ask for one frame. An unchanged digest — an event, a log
  // line, a worker row — asks for nothing at all. The live set is what the
  // edge markers are about, so they are refreshed here too.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    // Transitions (`d05`): what changed between the model the scene last drew
    // and this one. Computed only when the digest moved — an identical digest
    // is by definition no scene-visible change — and handed to the renderer,
    // which applies the state first and the cues second.
    //
    // History (`d07`) never animates a change of the *reference frame*: while
    // the cursor is anywhere other than live, and on the way into and out of
    // it, the scene applies states instantly. A cue would otherwise make
    // "go back three minutes" look like a burst of transitions that never
    // happened — the one thing this layer must not imply.
    const previous = previousModelRef.current;
    const projectedCues = previous !== null && previous.digest !== model.digest;
    const deltas =
      projectedCues && model.historySeq === null && previous?.historySeq === null ? diffModels(previous, model) : [];
    previousModelRef.current = model;
    applyToScene(renderer, model, deltas);
    refreshEdgeMarkers();
    refreshLabelPositions();
  }, [model, applyToScene, refreshEdgeMarkers, refreshLabelPositions]);

  /**
   * The camera policy — the only place that decides a framing without the
   * operator asking for one:
   *
   *  - the focus target moved → `command` framing on it, **unless** a pin is
   *    set (a pin exists exactly to stop the camera following the work);
   *  - nothing is focused and the rail's extent changed → `rail` framing, so a
   *    quiescent run is readable from the first frame;
   *  - nothing else moves the camera. Not an event, not a status change, not a
   *    hover, not a log line.
   */
  useEffect(() => {
    const previous = framingRef.current;
    const next = { focusId: model.focusId, shape: boundsShape(model.bounds) };
    framingRef.current = next;
    // `rail` is the operator's explicit overview: nothing re-frames it.
    if (previous === null || preset !== "command") return;
    if (pinnedId !== null) return;
    // A historical cursor is a different frame of reference: the operator is
    // reading the log, and a camera flight per scrub tick would be motion they
    // did not ask for (and a frame budget spent on nothing).
    if (model.historySeq !== null) return;
    if (previous.focusId !== next.focusId) {
      frameSlice(next.focusId);
    } else if (next.focusId === null && previous.shape !== next.shape) {
      frameSlice(null);
    }
  }, [model, pinnedId, preset, frameSlice]);

  // The pin and the freeze are view state the specs read back: publish them,
  // and clear a freeze whose slice is no longer the one on screen (a frozen
  // window must never describe another worker's output).
  useEffect(() => {
    deckHook().pinned = pinnedId;
  }, [pinnedId]);

  useEffect(() => {
    deckHook().motion = reducedMotion ? "reduced" : "full";
  }, [reducedMotion]);

  // The projection that is up, and why — the `d09` specs read it from here.
  useEffect(() => {
    const hook = deckHook();
    hook.availability = availability;
    hook.flatReason = flatReason;
  }, [availability, flatReason]);

  // Model-level facts the specs read on *either* surface (`d09`): selection,
  // focus, counts and overflow are projection facts, not renderer output, so
  // they are published here. The renderer counters stay in `applyToScene`,
  // which only runs in 3D — in flat mode they keep their last value.
  useEffect(() => {
    const hook = deckHook();
    hook.nodes = model.nodes.length;
    hook.edges = model.edges.length;
    hook.digest = model.digest;
    hook.selected = model.nodes.find((node) => node.selected)?.id ?? null;
    hook.focused = model.focusId;
    hook.liveCount = model.liveIds.length;
    hook.alerts = model.alerts.length;
    hook.alertsOverflow = model.alertsOverflow;
    hook.stationOverflow = model.stationOverflow;
    hook.completion = model.completion;
  }, [model]);

  useEffect(() => {
    deckHook().cameraPreset = preset;
  }, [preset]);

  useEffect(() => {
    if (frozenId !== null && frozenId !== model.focusId) {
      setFrozenId(null);
      return;
    }
    deckHook().frozen = frozenId;
  }, [frozenId, model.focusId]);

  // A different run is a different world: the pin, the freeze, the window's
  // expansion, the dock and the temporal cursor are per-run view state, so
  // they start clean. The dock closes outright — a panel still describing the
  // previous run's slice would be worse than no panel (the roadmap's error
  // rule for `d06`) — and history returns to live: the new run's arrival is
  // the one moment "now" is unambiguous.
  useEffect(() => {
    setPinnedId(null);
    setFrozenId(null);
    setExpanded(false);
    setDock(DOCK_CLOSED);
    setHistorySeq(null);
    setPlaying(false);
    setWallOpen(false);
  }, [runId]);

  // The dock follows the selection: it stays where it is and shows the new
  // subject, whose tabs start on `Output` — the dashboard inspector's own rule
  // (`Inspector.tsx`), applied by the dock because the dock owns the tab.
  //
  // One exception, and only one: an intent that named *both* a subject and a
  // tab (`d07`'s bucket click — "show me the events of that moment") must not
  // have its tab undone by the reset it triggered. The ref holds that pairing
  // for exactly one selection change.
  useEffect(() => {
    const explicit = explicitTabRef.current;
    if (explicit !== null && explicit.sliceId === selected) {
      explicitTabRef.current = null;
      setDock(showDockTab(dockRef.current, explicit.tab));
      return;
    }
    setDock(dockOnNewSelection);
  }, [selected]);

  // Closing the dock hands the keyboard back to the deck: the shortcuts live on
  // the section, so a close that leaves focus on a removed button (the panel's
  // X, a tab trigger) would silently disable every deck key until the next
  // click. Focus is only taken back if it was inside the deck already.
  const dockWasOpenRef = useRef(dock.open);
  useEffect(() => {
    const wasOpen = dockWasOpenRef.current;
    dockWasOpenRef.current = dock.open;
    if (!wasOpen || dock.open) return;
    const container = containerRef.current;
    const active = document.activeElement;
    if (container && (active === null || active === document.body || !container.contains(active))) {
      container.focus({ preventScroll: true });
    }
  }, [dock.open]);

  useEffect(() => {
    const hook = deckHook();
    hook.dockOpen = dock.open;
    hook.dockTab = dock.tab;
  }, [dock]);

  // The temporal cursor is view state the specs read back: the seq it points
  // at, the bucket it lands in, and whether playback is running.
  useEffect(() => {
    const hook = deckHook();
    hook.historySeq = historySeq;
    hook.historyBucket = historySeq === null ? -1 : (historyIndex.bucketAt(historySeq)?.index ?? -1);
    hook.historyActive = model.historyActive;
    // The *window's* size, not the renderer's drawn bars (`hook.ribbon`):
    // `d07`'s spec records how many buckets the window has, and the renderer's
    // cap (`RIBBON_MAX_BARS`) is not that number.
    hook.ribbonBuckets = model.ribbon.length;
    hook.playing = playing;
  }, [historySeq, historyIndex, model.historyActive, model.ribbon.length, playing]);

  // Tier changes are parameters: resolution scale, fps cap and the tier label,
  // applied to the live renderer and loop.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setTier(tier);
    loopRef.current?.setMaxFps(budget.maxFps);
    loopRef.current?.request();
    instrument.setTier(tier);
    setReadout((current) => (current ? { ...current, pixels: renderer.info().pixels } : current));
  }, [tier, budget.maxFps]);

  // HUD: React state at HUD cadence, never per frame. The forced layout read is
  // the deck's DOM/layout cost sample.
  useEffect(() => {
    if (!ready || availability !== "3d") return;
    const tick = (): void => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const stats = renderer.info();
      const started = performance.now();
      containerRef.current?.getBoundingClientRect();
      instrument.recordLayout(performance.now() - started);
      const sample = instrument.latest();
      const next: HudReadout = {
        fps: stats.fps,
        drawCalls: stats.drawCalls,
        objects: stats.objects,
        stations: stats.stations,
        lines: stats.lines,
        vertices: stats.vertices,
        pixels: stats.pixels,
        shadedPixels: sample.estimate.shadedPixels,
        shaderMs: sample.estimate.shaderMs,
        frameP50: sample.frameMs.p50,
        frameP95: sample.frameMs.p95,
        frameWorst: sample.frameMs.worst,
        frames: sample.frames,
        commitsPerSec: sample.commitsPerSec,
        mutationsPerSec: sample.mutationsPerSec,
        domElements: sample.domElements,
        layoutMs: sample.layoutMs,
        longTasks: sample.longTasks.count,
        longTaskWorstMs: sample.longTasks.worstMs,
        tweens: stats.tweens,
        animatedEntities: stats.animatedEntities,
        sceneWrites: stats.sceneWrites,
        beacons: stats.beacons,
        settles: stats.settles,
        heapUsedBytes: sample.heap.usedBytes,
        heapReason: sample.heap.reason,
        eventsPerSec: sample.events.perSec,
        latencyP50: sample.latencyMs.p50,
        latencySamples: sample.latencyMs.samples,
        interactionOpen: sample.interactions.open.p50,
        interactionClose: sample.interactions.close.p50,
        interactionTab: sample.interactions.tab.p50,
        interactionSamples: sample.interactions.samples,
        deferred: sample.loop.deferred,
        idleStops: sample.loop.idleStops,
      };
      const previous = lastReadoutRef.current;
      if (hudOpen || !previous || !sameCompactReadout(previous, next)) {
        lastReadoutRef.current = next;
        setReadout(next);
      }
    };
    tick();
    const timer = window.setInterval(tick, HUD_MS);
    return () => window.clearInterval(timer);
  }, [availability, ready, hudOpen]);

  // Every commit of the deck subtree, counted where React schedules it. The
  // HUD's 4 Hz tick is the only thing here that commits on a timer. The live
  // window's row/line counts are read from the DOM the operator is looking at
  // (the component publishes them as data attributes) — that is the bounded
  // window's evidence, and it cannot disagree with what was rendered.
  useEffect(() => {
    instrument.recordCommit();
    const live = containerRef.current?.querySelector(".omp-livefeed");
    const hook = deckHook();
    // At a historical cursor the window is not mounted at all: "0 rows" is the
    // truth, and a stale count from before the walk would be a lie the specs
    // would read.
    hook.liveRows = Number(live?.getAttribute("data-rows") ?? 0);
    hook.logLines = Number(live?.getAttribute("data-lines") ?? 0);
  });

  /** Raycast through the cached canvas rect: pad id under a client point. */
  const pickAt = useCallback((clientX: number, clientY: number): string | null => {
    const rect = rectRef.current;
    const renderer = rendererRef.current;
    if (!rect || !renderer || rect.width <= 0 || rect.height <= 0) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    return renderer.pick(ndcX, ndcY);
  }, []);

  const showHover = useCallback(
    (nodeId: string | null): void => {
      if (hoverRef.current === nodeId) return;
      hoverRef.current = nodeId;
      setHover(nodeId);
      deckHook().hover = nodeId;
      rendererRef.current?.setHover(nodeId);
      loopRef.current?.request();
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      showHover(pickAt(event.clientX, event.clientY));
    },
    [pickAt, showHover],
  );

  const onPointerLeave = useCallback(() => showHover(null), [showHover]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const id = pickAt(event.clientX, event.clientY);
      if (id !== null) onSelect(id);
    },
    [onSelect, pickAt],
  );

  /**
   * Point the deck at one worker: the pin (so auto-follow stops) and the shared
   * selection (the dashboard's Inspector and the shell's slice-detail fetch
   * follow it, which is what gives the station its stage). The camera moves
   * only when the caller asks: `[`/`]` and a lane click are pointer changes,
   * while `F` and an edge marker are a "take me there".
   */
  const focusOn = useCallback(
    (sliceId: string, frame: boolean): void => {
      setPinnedId(sliceId);
      onSelect(sliceId);
      if (frame) frameSlice(sliceId);
    },
    [frameSlice, onSelect],
  );

  /**
   * The inspection dock (`d06`). Opening is an explicit act — `1`…`8`, an
   * Inspect affordance, an alert row — never a side effect of selecting: a
   * click on a pad is a spatial act ("which slice is that?"), and reflowing
   * the stage for every glance would make the overview unusable and the dock a
   * second dashboard. What the dock inspects is the *selection*, which is why
   * the shell's existing slice-detail fetch feeds it with nothing new.
   *
   * Each intent is measured where it happens: from the key/click to the second
   * animation frame afterwards, i.e. the first frame the operator can see the
   * change in (`recordInteraction`). No sample is recorded for a no-op.
   */
  const showDockTabIntent = useCallback(
    (tab: InspectorTab): void => {
      if (runId === null) return; // nothing to inspect
      const current = dockRef.current;
      const next = showDockTab(current, tab);
      if (next === current) return;
      const started = performance.now();
      setDock(next);
      afterPaint(() =>
        instrument.recordInteraction(current.open ? "inspection-tab" : "inspection-open", performance.now() - started),
      );
    },
    [runId],
  );

  const closeDockPanel = useCallback((): void => {
    const current = dockRef.current;
    const next = hideDock(current);
    if (next === current) return;
    const started = performance.now();
    setDock(next);
    afterPaint(() => instrument.recordInteraction("inspection-close", performance.now() - started));
  }, []);

  /**
   * "Inspect": make the dock show this slice. The selection is already the
   * dock's subject, so the affordance only has to open it (on `Output`) when it
   * is closed — a click on Inspect must not disturb a dock the operator has
   * positioned on another tab.
   */
  const inspectSlice = useCallback(
    (sliceId: string): void => {
      onSelect(sliceId);
      if (!dockRef.current.open) showDockTabIntent("Output");
    },
    [onSelect, showDockTabIntent],
  );

  /**
   * Dismiss one alert. The key includes the evidence seq, so this clears the
   * condition as the operator sees it *now* — when it recurs (a second
   * failure, a later wedge) the new key is not in the list and the alert
   * comes back. There is deliberately no "dismiss all".
   */
  const dismissAlert = useCallback(
    (alert: DeckAlert): void => {
      const key = dismissKey(modelRef.current.runId, alert);
      const next = appendDismissed(dismissed, key);
      setDismissed(next);
      writeDismissed(next);
    },
    [dismissed],
  );

  // ------------------------------------------------------------------
  // The temporal layer (`d07`). Four intents, all of them about one value:
  // the cursor. Nothing here can reach the run, the store, the app's
  // selection or a persisted artifact — history is a projection, and the only
  // thing it projects *onto* is the deck's own view state.
  //
  // The cursor is always an event seq, so a given seq produces the same scene
  // however it was reached (slice strip, slider, `,`/`.`/`P`, a second visit).
  // ------------------------------------------------------------------

  /** Move the cursor to a recorded seq. */
  const goHistory = useCallback((seq: number): void => {
    setHistorySeq(seq);
  }, []);

  /**
   * Return to live: the cursor goes away and the projection is the DTOs'
   * again. Playback stops with it — a timer that kept advancing would drag the
   * operator back out of the state they just asked for.
   */
  const goLive = useCallback((): void => {
    setPlaying(false);
    setHistorySeq(null);
  }, []);

  /**
   * One recorded bucket back (`-1`) or forward (`+1`). The walk skips empty
   * buckets: a quiet stretch is part of the ribbon's shape but not a moment
   * the log can describe, and the cursor must always name a real seq. From
   * live, back enters at the newest recorded moment; forward past the last one
   * is how `.` returns to live.
   */
  const stepHistory = useCallback(
    (direction: 1 | -1): void => {
      const buckets = historyIndex.buckets;
      const recorded = historyIndex.recorded;
      if (recorded.length === 0) return;
      const current = historySeq === null ? -1 : (historyIndex.bucketAt(historySeq)?.index ?? -1);
      const position = current < 0 ? -1 : recorded.indexOf(current);
      if (position < 0) {
        if (direction < 0) setHistorySeq(buckets[recorded[recorded.length - 1]!]!.lastSeq);
        return;
      }
      const target = position + direction;
      if (target >= recorded.length) {
        goLive();
        return;
      }
      if (target < 0) return;
      setHistorySeq(buckets[recorded[target]!]!.lastSeq);
    },
    [goLive, historyIndex, historySeq],
  );

  /**
   * Play / pause. From live this starts at the window's first recorded moment —
   * "watch the run" — and playback then advances one recorded bucket per tick,
   * stopping at the last one: the scene jumps between recorded states, and it
   * never wraps into a future that did not happen.
   */
  const togglePlay = useCallback((): void => {
    if (playing) {
      setPlaying(false);
      return;
    }
    const first = historyIndex.recorded[0];
    if (first === undefined) return;
    if (historySeq === null) setHistorySeq(historyIndex.buckets[first]!.lastSeq);
    setPlaying(true);
  }, [historyIndex, historySeq, playing]);

  /**
   * The scrubber's positions are *recorded moments* (plus live at the end), so
   * every position is a state that exists. The strip below draws the whole
   * ribbon — gaps included — and highlights the same cursor.
   */
  const scrubTo = useCallback(
    (position: number): void => {
      const buckets = historyIndex.buckets;
      const recorded = historyIndex.recorded;
      if (recorded.length === 0) return;
      if (position >= recorded.length) {
        goLive();
        return;
      }
      const bucket = buckets[recorded[Math.max(0, position)]!];
      if (bucket !== undefined) goHistory(bucket.lastSeq);
    },
    [goHistory, goLive, historyIndex],
  );

  /**
   * A bucket clicked: the roadmap's "jump from an interesting moment straight
   * to the slice and its events". The cursor moves to the bucket, the newest
   * slice it touched becomes the app's selection (one selection system — the
   * dock, the ring and the shell's slice fetch all follow it), and the dock
   * opens on Events. A bucket whose events were all run-level moves the cursor
   * and nothing else; an empty bucket shows the newest recorded state at or
   * before it — "what was happening in that quiet stretch".
   */
  const openBucket = useCallback(
    (bucket: RibbonBucket): void => {
      if (bucket.count === 0) {
        const recorded = historyIndex.recorded;
        let target: RibbonBucket | undefined;
        for (const index of recorded) {
          if (index > bucket.index) break;
          target = historyIndex.buckets[index];
        }
        const fallback = target ?? (recorded[0] === undefined ? undefined : historyIndex.buckets[recorded[0]]);
        if (fallback !== undefined) setHistorySeq(fallback.lastSeq);
        return;
      }
      setHistorySeq(bucket.lastSeq);
      const sliceId = bucket.slices[0];
      if (sliceId === undefined) return;
      explicitTabRef.current = { sliceId, tab: "Events" };
      onSelect(sliceId);
      showDockTabIntent("Events");
    },
    [historyIndex, onSelect, showDockTabIntent],
  );

  /** The wall's DOM list; the tiles in the scene are inert geometry. */
  const toggleWall = useCallback((): void => {
    setWallOpen((open) => !open);
  }, []);

  /**
   * Leave flat mode (`d09`). `retry3d` is the context-loss affordance: the
   * canvas a lost context lived on can never hand out another one, but the
   * flat branch does not render a canvas at all — returning to 3D mounts a
   * fresh element, and the availability change re-runs the renderer effect on
   * it. `clearForcedFlat` undoes an explicit `T` choice.
   */
  const retry3d = useCallback((): void => {
    setContextLost(false);
    setContextFailed(false);
    const updated: DeckPrefs = { ...prefs, forced: "3d" };
    setPrefs(updated);
    writePrefs(updated);
  }, [prefs]);

  const clearForcedFlat = useCallback((): void => {
    const updated: DeckPrefs = { ...prefs, forced: null };
    setPrefs(updated);
    writePrefs(updated);
  }, [prefs]);

  // Playback (`d07`): a timer that advances the cursor one *recorded* bucket
  // per tick and re-arms itself from the new cursor. Each tick lands on a
  // state the log recorded — no interpolation, no intermediate status — and
  // the chain ends at the last recorded bucket.
  useEffect(() => {
    if (!playing || historySeq === null) return;
    const buckets = historyIndex.buckets;
    const recorded = historyIndex.recorded;
    const current = historyIndex.bucketAt(historySeq)?.index ?? -1;
    const position = current < 0 ? -1 : recorded.indexOf(current);
    const next = position + 1;
    if (recorded.length === 0 || position < 0 || next >= recorded.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setHistorySeq(buckets[recorded[next]!]!.lastSeq), PLAY_MS);
    return () => window.clearTimeout(timer);
  }, [playing, historySeq, historyIndex]);

  useEffect(() => {
    deckHook().dismissed = dismissed;
  }, [dismissed]);

  // Keys live on the surface, not the window: focus inside the deck is the
  // gate, and text inputs are never hijacked.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        // Never hijack a control that answers the key itself (a text field, a
        // link) — and a focused button owns Space/Enter, which is how the lane
        // rows and the edge markers stay keyboard-reachable. Every other deck
        // key still works from a focused button, so `]` keeps cycling after a
        // click (d04).
        if (event.target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "A") {
          return;
        }
        if (tag === "BUTTON" && (event.key === " " || event.key === "Enter")) return;
      }
      const key = event.key.toLowerCase();
      const model = modelRef.current;
      // Inside the window's transcript (or a scrolling list) the scrolling keys
      // belong to that element: an operator reading back through the log must
      // be able to move it, while the deck's own keys still work.
      if (
        event.target instanceof Element &&
        event.target.closest(".omp-livefeed-log, .omp-deck-lanes, .omp-deck-mirror") !== null &&
        /^(Arrow|Page|Home|End| )/.test(event.key)
      ) {
        return;
      }
      if (key === "t") {
        // The cycle includes `flat` (`d09`) and starts from the tier actually
        // on screen, so a tier the deck demoted itself to is where the operator
        // picks up (`d10`). The press is an explicit choice: it takes the tier
        // back from the controller for the session — landing on `auto` hands
        // the choice back and re-arms the guard.
        const next = nextDeckMode(autoTier ?? deckMode(prefs));
        setAutoTier(null);
        setAutoStopped(next !== "auto");
        controllerRef.current?.stop();
        const updated: DeckPrefs =
          next === "flat" ? { ...prefs, forced: "flat" } : { ...prefs, forced: null, tier: next };
        setPrefs(updated);
        writePrefs(updated);
      } else if (key === "m") {
        // Reduced motion (`d05`, explicit choice since `d09`): the toggle
        // flips the *effective* state, so it can also turn motion back on
        // where the OS asks for reduced motion, and the choice persists.
        const updated: DeckPrefs = { ...prefs, motion: reducedMotion ? "on" : "reduced" };
        setPrefs(updated);
        writePrefs(updated);
      } else if (key === "d") {
        onExit();
      } else if (key === "h" || event.key === "?") {
        setHudOpen((open) => !open);
      } else if (key === "f") {
        // Frame the selection — the operator's explicit "watch this one".
        const target = model.nodes.find((node) => node.selected)?.id ?? model.focusId;
        if (target !== null) focusOn(target, true);
      } else if (event.key === "Escape") {
        // One key, one meaning at a time, topmost layer first: help (modal),
        // then the dock, then the wall's list, then history returns to live,
        // and with nothing open this is the `d03` pin release.
        if (hudOpen) {
          setHudOpen(false);
        } else if (dockRef.current.open) {
          closeDockPanel();
        } else if (wallOpen) {
          setWallOpen(false);
        } else if (historySeq !== null) {
          goLive();
        } else {
          setPinnedId(null);
          setPreset("command");
          frameSlice(focusTarget(detail?.slices ?? [], null));
        }
      } else if (/^[1-8]$/.test(event.key)) {
        // The dock's tabs, by position in `INSPECTOR_TABS`: opening it when it
        // is closed, switching it when it is already up (`d06`).
        const tab = dockTabForKey(event.key, INSPECTOR_TABS);
        if (tab !== null) showDockTabIntent(tab);
      } else if (event.key === " ") {
        const target = model.focusId;
        if (target !== null) setFrozenId((current) => (current === target ? null : target));
      } else if (key === "e") {
        setExpanded((open) => !open);
      } else if (key === "c") {
        // `command` ↔ `rail`: the operator's whole-run overview is one key away,
        // and `command` puts the camera back on the work.
        const next: DeckCameraPreset = preset === "command" ? "rail" : "command";
        setPreset(next);
        framePreset(next);
      } else if (event.key === "," || event.key === ".") {
        // History step (`d07`). These keys are not used by the camera, the
        // window or the dock, so they are safe from anywhere on the surface.
        stepHistory(event.key === "," ? -1 : 1);
      } else if (key === "l") {
        // Return to live: the one key that always exists, whatever the cursor
        // is doing, so history can never trap the operator.
        goLive();
      } else if (key === "p") {
        togglePlay();
      } else if (event.key === "0") {
        framePreset(preset);
      } else if (event.key === "[" || event.key === "]") {
        // Focus only: `]` walks the live set the way the lane list reads,
        // and the camera stays where the operator put it (`F` frames).
        const next = nextLiveId(model.liveIds, model.focusId, event.key === "]" ? 1 : -1);
        if (next !== null) focusOn(next, false);
      } else if (event.key.startsWith("Arrow")) {
        const step = event.shiftKey ? PAN_STEP * 3 : PAN_STEP;
        const right = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
        const forward = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
        dispatchCamera({ kind: "pan", right, forward, bounds: model.bounds }, true);
      } else if (key === "+" || key === "=" || key === "-") {
        dispatchCamera(
          { kind: "zoom", factor: key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP, maxDistance: maxRetreatFor(model.bounds, aspect()) },
          true,
        );
      } else {
        return;
      }
    },
    [
      autoTier,
      closeDockPanel,
      detail,
      dispatchCamera,
      focusOn,
      framePreset,
      frameSlice,
      goLive,
      historySeq,
      hudOpen,
      prefs,
      reducedMotion,
      preset,
      showDockTabIntent,
      stepHistory,
      togglePlay,
      wallOpen,
    ],
  );

  // Wheel zoom is a native listener: React's synthetic wheel events are
  // passive at the root, so `preventDefault` there would not stop the page
  // from scrolling behind the surface. It lives on the stage — the canvas and
  // nothing else — so a wheel over any DOM panel (live window, lanes, alerts,
  // dock) belongs to that panel and never zooms the world (`d06`: the dock is
  // a 2D surface first).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent): void => {
      // The transcript and the lane list scroll themselves; only the empty
      // scene area zooms.
      if (event.target instanceof Element && event.target.closest(".omp-livefeed-log, .omp-deck-lanes, .omp-deck-mirror") !== null) return;
      event.preventDefault();
      const current = modelRef.current;
      dispatchCamera(
        { kind: "zoom", factor: event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, maxDistance: maxRetreatFor(current.bounds, aspect()) },
        true,
      );
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [aspect, dispatchCamera]);

  useEffect(() => {
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) container.focus({ preventScroll: true });
  }, []);
  /**
   * The capped render set (`ux01`): `labelIds` priority order through
   * `capLabels`, intersected with the projected positions (off-screen stays
   * out). Flat renders none — the table is the identity there.
   */
  const { labelRenderPositions, labelsHidden } = useMemo(() => {
    if (availability === "flat" || labelPositions.size === 0) return { labelRenderPositions: labelPositions, labelsHidden: 0 };
    const ordered = labelIds(model);
    const { shown, hidden } = capLabels(ordered, model.focusId, model.primaryId, LABEL_CAP);
    const kept = new Set(shown);
    const render = new Map<string, { x: number; y: number }>();
    for (const [id, point] of labelPositions) {
      if (kept.has(id)) render.set(id, point);
    }
    return { labelRenderPositions: render, labelsHidden: hidden };
  }, [availability, labelPositions, model]);
  /**
   * Degraded view (`ux02`): pure read of camera vs work, recomputed from the
   * same inputs as the markers (no new subscription, no automation). Flat
   * never degrades — the table cannot lose the work.
   */
  const degraded = useMemo(
    () => availability === "3d" && isDegradedView(cameraRef.current, model, aspect()),
    // cameraRef/aspect read live at render: model + markers + labels move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [availability, model, edgeMarkers, labelPositions],
  );



  /**
   * The DOM layer is identical whichever path renders — the canvas draws
   * geometry, this draws the words — so it is built once, from the same
   * props, in both branches. `d09`'s flat projection extends it rather than
   * forking it.
   */
  const overlay = (
    <DeckOverlay
      model={model}
      hoverId={hover}
      agents={agents}
      events={events}
      focusSlice={detail?.slices.find((slice) => slice.id === model.focusId) ?? null}
      frozen={frozenId !== null}
      onFrozenChange={(next) => setFrozenId(next ? (model.focusId ?? null) : null)}
      expanded={expanded}
      onExpandedChange={setExpanded}
      edgeMarkers={edgeMarkers}
      onFocus={focusOn}
      onSelect={onSelect}
      onInspect={inspectSlice}
      dockOpen={dock.open}
      onDismiss={dismissAlert}
      alertsCollapsed={alertsCollapsed}
      onAlertsCollapsedChange={setAlertsCollapsed}
      attempts={attempts}
      timelineTruncated={timelineTruncated}
      playing={playing}
      wallOpen={wallOpen}
      runs={runs}
      replay={replay}
      onScrub={scrubTo}
      onStep={stepHistory}
      onBucket={openBucket}
      onLive={goLive}
      onPlayToggle={togglePlay}
      onToggleWall={toggleWall}
      onOpenRun={onOpenRun}
      onVerifyReplay={onVerifyReplay}
      live={live}
      loops={detail?.loops?.length ?? 0}
      onControlDone={onControlDone}
      selectedId={selected}
      slices={detail?.slices ?? []}
      flat={availability === "flat"}
      helpOpen={hudOpen}
      labelPositions={labelRenderPositions}
      labelsHidden={labelsHidden}
      degraded={degraded}
      onReframe={() => framePreset(preset)}
    />
  );

  /**
   * The inspection dock (`d06`): the dashboard's own `Inspector`, in a frame.
   * It is a sibling of the stage, never inside it, and takes props only — no
   * renderer, no camera, no model — so the 2D surface stays usable with the
   * canvas absent (the flat path above renders it too).
   */
  const dockPanel =
    dock.open && runId !== null ? (
      <aside className="omp-deck-dock" aria-label="Inspection dock">
        <DeckInspector
          runId={runId}
          selected={detail?.slices.find((slice) => slice.id === selected) ?? undefined}
          detail={sliceDetail}
          slices={detail?.slices ?? []}
          events={events}
          live={live}
          wedged={agents.find((agent) => agent.id === selected)?.wedged === true}
          tab={dock.tab}
          onTabChange={showDockTabIntent}
          onControlDone={onControlDone}
          onClose={closeDockPanel}
        />
      </aside>
    ) : null;

  if (availability === "flat") {
    // No scene (`d09`): the same overlay supplies the live window, the time
    // axis, the alerts and the controls, `FlatDeck` supplies the board, the
    // pad list and the worker lanes, and this notice says why — one sentence
    // per reason, with the device detail and the way back.
    return (
      <section
        className="omp-deck omp-deck-flat"
        aria-label="Deck"
        ref={containerCallback}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-tier="flat"
        data-availability="flat"
        data-flat-reason={flatReason ?? ""}
        data-motion={reducedMotion ? "reduced" : "full"}
        data-dock={dock.open ? "open" : "closed"}
      >
        <div className="omp-deck-notice" role="status">
          <p>
            {flatReason === "no-webgl2"
              ? "3D unavailable on this device (no WebGL2 context) — the deck is showing its flat projection: the same slices, workers, live window, alerts and controls, without the spatial rail."
              : flatReason === "context-lost"
                ? "The 3D context was lost — the deck switched to its flat projection and kept your place; retrying builds a fresh canvas."
                : flatReason === "create-failed"
                  ? "The 3D renderer could not start on this device — the deck is showing its flat projection instead of a blank canvas."
                  : "Flat mode is on — the spatial rail is off; the deck's slices, workers, live window, alerts and controls are all here."}
          </p>
          {rendererString !== null && (
            <code className="omp-deck-notice-device" title={rendererString}>
              {rendererString}
            </code>
          )}
          <div className="omp-deck-actions">
            {(contextLost || contextFailed) && (
              <button type="button" className="omp-deck-button" onClick={retry3d}>
                Retry 3D
              </button>
            )}
            {flatReason === "forced" && (
              <button type="button" className="omp-deck-button" onClick={clearForcedFlat}>
                Use 3D
              </button>
            )}
            <button
              type="button"
              className="omp-deck-button"
              aria-expanded={hudOpen}
              onClick={() => setHudOpen((open) => !open)}
            >
              Keyboard help
            </button>
            <button type="button" className="omp-deck-button" onClick={onExit}>
              Back to dashboard
            </button>
          </div>
        </div>
        {overlay}
        {dockPanel}
      </section>
    );
  }

  return (
    <section
      className="omp-deck"
      aria-label="Deck"
      ref={containerCallback}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-hud={hudOpen ? "open" : "closed"}
      data-tier={tier}
      data-availability="3d"
      data-motion={reducedMotion ? "reduced" : "full"}
      data-dock={dock.open ? "open" : "closed"}
    >
      {/* The stage is the area the scene owns; the dock narrows it (CSS, one
          resize, one frame) instead of covering the world, so the camera keeps
          the whole layout on screen and `Esc` gives back the same scene. */}
      <div className="omp-deck-stage" ref={stageCallback}>
        {/* Keyed by the context identity: a canvas whose context was lost can
            never hand out another one, so a rebuild gets a fresh element.
            Decorative (`d09`): every fact it draws is in the DOM layer, so it
            is hidden from assistive technology and never takes focus. */}
        <canvas
          key={contextKey}
          className="omp-deck-canvas"
          ref={canvasRef}
          aria-hidden="true"
          aria-label="Workflow scene — a spatial projection of the roadmap; the same state is in the deck's text panels"
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onPointerDown={onPointerDown}
        />
      </div>
      {overlay}
      {dockPanel}
      <div className="omp-deck-hud" ref={hudRef}>
        {/* The compact row, in three clusters — what the run *is* (identity,
            state, alerts), what the frame *costs*, and where the camera is
            pointed. The order is the operator's hierarchy: a live worker and a
            critical alert outrank a frame counter, so the state cluster leads
            and the event line gets a line of its own. Clustering is
            presentation only: every chip keeps its own class and data
            attributes, so nothing that reads the HUD has to know about it. */}
        <div className="omp-deck-row">
          {/* Primary scan (`ux03`): LIVE N · ALERTS N · FOCUS id. Three facts,
              always visible. Everything else — tier, frame, world, completion,
              warnings, last change — lives in the diagnostics disclosure below
              (correction §9: diagnostics must not pollute the scan). */}
          <span className="omp-deck-metric" data-live={live ? "true" : "false"}>
            {live ? "live" : "quiescent"}
          </span>
          <span className="omp-deck-metric" data-live-count={model.liveIds.length} data-station-count={pooledStations}>
            {stationCountLabel(model.liveIds.length, pooledStations)}
          </span>
          <span className="omp-deck-metric" data-alert-count={model.alerts.length} data-beacon-count={model.beaconAlerts.length}>
            alerts: {model.alerts.length}
            {model.alertsOverflow > 0 ? ` · ${model.alertsOverflow} over the beacon cap` : ""}
          </span>
          <span className="omp-deck-metric" data-focus={model.focusId ?? ""}>
            focus: {model.focusId ?? "—"}
            {pinnedId !== null ? ` · pinned` : ""}
          </span>
          <button type="button" className="omp-deck-button" aria-expanded={hudOpen} onClick={() => setHudOpen((open) => !open)}>
            HUD
          </button>
          <button type="button" className="omp-deck-button" onClick={onExit}>
            Dashboard
          </button>
        </div>
        {hudOpen && (
          <div className="omp-deck-panel">
            <p className="omp-deck-subject">
              <span className="omp-deck-chip" data-tier={tier} data-tier-source={tierSource}>
                {tier}
                {tierSource === "auto" ? " · auto" : " · pinned"}
              </span>
              {tier === "minimal" && <span className="omp-deck-warn">software renderer detected</span>}{" "}
              <span className="omp-deck-metric" data-model="true">
                {model.nodes.length} pads · {model.edges.length} edges
              </span>{" "}
              <span className="omp-deck-metric">run {runId ?? "none"}</span>{" "}
              <span
                className="omp-deck-metric"
                data-history={model.historySeq === null ? "live" : "past"}
                data-history-seq={model.historySeq ?? ""}
              >
                {model.historySeq === null
                  ? "at now"
                  : `at seq ${model.historySeq}${playing ? " · playing" : ""}${model.historyActive > 0 ? ` · ${model.historyActive} active` : ""}`}
              </span>{" "}
              <span className="omp-deck-metric" data-motion={reducedMotion ? "reduced" : "full"}>
                motion: {reducedMotion ? "reduced" : "full"}
              </span>{" "}
              <span className="omp-deck-metric" data-ambient={ambientSummary(ambientState)}>
                effects: {ambientSummary(ambientState)}
              </span>
            </p>
            {downgradeNotice !== null && !noticeDismissed && (
              <span className="omp-deck-warn omp-deck-downgrade" role="status" data-downgrade-to={downgradeNotice.to}>
                downgraded to {downgradeNotice.to} — {Math.round(downgradeNotice.medianMs)} ms/frame
                <button
                  type="button"
                  className="omp-deck-button omp-deck-downgrade-x"
                  aria-label="Dismiss the downgrade notice"
                  onClick={() => setNoticeDismissed(true)}
                >
                  ×
                </button>
              </span>
            )}
            {completionLine !== null && <p className="omp-deck-subject">{completionLine}</p>}
            {lastEvent && (
              <p className="omp-deck-subject">
                <span className="omp-deck-event" ref={(element) => markRendered(element, lastEvent.seq)}>
                  <span className="omp-deck-event-tag">last change</span>
                  {lastEvent.type}
                  {lastEvent.sliceId ? ` · ${lastEvent.sliceId}` : ""}
                  {describeEvent(lastEvent) && ` · ${describeEvent(lastEvent)}`} · seq {lastEvent.seq}
                </span>
              </p>
            )}
            <p className="omp-deck-subject">
              budget: {budget.resolutionScale}× backing · {budget.maxFps} fps cap · ≤{budget.maxDrawCalls} calls · ≤{budget.maxStations}{" "}
              stations · ≤{budget.maxBeacons} beacons
            </p>
            {model.warnings.length > 0 && (
              <p className="omp-deck-subject" data-slot-warnings={model.warnings.length}>
                slot policy: {model.warnings.join("; ")}
              </p>
            )}
            <dl className="omp-deck-costs">
              <div>
                <dt>frame</dt>
                <dd>
                  p50 {readout?.frameP50.toFixed(1) ?? "—"} ms · p95 {readout?.frameP95.toFixed(1) ?? "—"} · worst{" "}
                  {readout?.frameWorst.toFixed(1) ?? "—"}
                </dd>
              </div>
              <div>
                <dt>shaded pixels</dt>
                <dd>
                  {readout?.shadedPixels.toLocaleString() ?? "—"} px · est {readout?.shaderMs.toFixed(2) ?? "—"} ms at 9 ns/px
                </dd>
              </div>
              <div>
                <dt>geometry</dt>
                <dd>
                  {readout?.vertices ?? 0} verts · {readout?.lines ?? 0} lines · {readout?.drawCalls ?? 0} draw calls ·{" "}
                  {readout?.objects ?? 0} objects
                </dd>
              </div>
              <div>
                <dt>stations</dt>
                <dd>
                  {readout?.stations ?? 0} drawn · {model.liveIds.length} live
                  {model.stationOverflow > 0 ? ` · ${model.stationOverflow} over the tier's cap` : ""}
                </dd>
              </div>
              <div>
                <dt>transitions</dt>
                <dd>
                  {readout?.tweens ?? 0} cues · {readout?.animatedEntities ?? 0} entities · {readout?.settles ?? 0} completion
                  plates · {readout?.sceneWrites ?? 0} scene writes
                  {reducedMotion ? " · motion reduced" : ""}
                </dd>
              </div>
              <div>
                <dt>effects</dt>
                <dd data-ambient={ambientSummary(ambientState)}>
                  {ambientSummary(ambientState)} · {AMBIENT_EFFECTS.filter((effect) => ambientState[effect.id]).map((effect) => effect.id).join(", ") || "none"}
                </dd>
              </div>
              <div>
                <dt>alerts</dt>
                <dd>
                  {model.alerts.length} active · {model.beaconAlerts.length} beacons
                  {model.alertsOverflow > 0 ? ` · ${model.alertsOverflow} text-only` : ""}
                </dd>
              </div>
              <div>
                <dt>react / DOM</dt>
                <dd>
                  {readout?.commitsPerSec.toFixed(1) ?? "—"} commits/s · {readout?.mutationsPerSec.toFixed(1) ?? "—"} mutations/s ·{" "}
                  {readout?.domElements ?? 0} nodes · layout {readout?.layoutMs.toFixed(2) ?? "—"} ms
                </dd>
              </div>
              <div>
                <dt>events</dt>
                <dd>
                  {readout?.eventsPerSec.toFixed(2) ?? "—"}/s · to screen p50 {readout?.latencyP50.toFixed(0) ?? "—"} ms (
                  {readout?.latencySamples ?? 0} marks)
                </dd>
              </div>
              <div>
                <dt>inspection</dt>
                <dd data-dock-open={dock.open ? "true" : "false"} data-dock-tab={dock.tab}>
                  {dock.open ? `dock open · ${dock.tab}` : "dock closed"}
                  {readout !== null && readout.interactionSamples > 0
                    ? ` · open p50 ${readout.interactionOpen.toFixed(0)} ms · close p50 ${readout.interactionClose.toFixed(0)} ms · tab p50 ${readout.interactionTab.toFixed(0)} ms (${readout.interactionSamples})`
                    : " · no interactions this window"}
                </dd>
              </div>
              <div>
                <dt>history</dt>
                <dd
                  data-history={model.historySeq === null ? "live" : "past"}
                  data-history-seq={model.historySeq ?? ""}
                  data-history-buckets={model.ribbon.length}
                >
                  {model.historySeq === null ? "live" : `at seq ${model.historySeq}`} · {model.ribbon.length} buckets ·{" "}
                  {model.tiles.length} run{model.tiles.length === 1 ? "" : "s"}
                  {model.tilesOverflow > 0 ? ` (+${model.tilesOverflow} not drawn)` : ""}
                  {timelineTruncated ? " · window is the newest page" : ""}
                </dd>
              </div>
              <div>
                <dt>loop</dt>
                <dd>
                  {readout?.frames ?? 0} frames · {readout?.deferred ?? 0} gated · {readout?.idleStops ?? 0} idle stops
                </dd>
              </div>
              <div>
                <dt>long tasks</dt>
                <dd>
                  {readout?.longTasks ?? 0} over 50 ms · worst {readout?.longTaskWorstMs.toFixed(0) ?? "—"} ms
                </dd>
              </div>
              <div>
                <dt>heap</dt>
                <dd>{readout?.heapUsedBytes === null || readout?.heapUsedBytes === undefined ? readout?.heapReason || "—" : `${(readout.heapUsedBytes / 1048576).toFixed(1)} MB`}</dd>
              </div>
            </dl>
            {/* Effects (`d13`): the one part of the panel that is a *setting*
                rather than a measurement, so it is rendered from the registry
                itself — a new effect appears here with its tier requirement and
                its off switch, and nothing else has to know it exists. The list
                is a disclosure (the alert stack's own pattern): the panel keeps
                its summary line and the deck keeps its DOM budget, which a
                mount of thirty extra rows in the same tick would spend. */}
            <section className="omp-deck-effects" aria-label="Visual effects">
              <button
                type="button"
                className="omp-deck-effects-head"
                aria-expanded={effectsOpen}
                onClick={() => setEffectsOpen((open) => !open)}
              >
                <span className="omp-deck-effects-title">visual effects</span>
                <span className="omp-deck-effects-summary" data-ambient={ambientSummary(ambientState)}>
                  {ambientSummary(ambientState)}
                </span>
                <span className="omp-deck-effects-toggle" aria-hidden="true">
                  {effectsOpen ? "▾" : "▸"}
                </span>
              </button>
                {effectsOpen && (
                <>
                  <p className="omp-deck-subject">
                    Each one decorates or clarifies the surface; none of them changes what the deck reports, and all of them
                    off is still a fully working deck.
                  </p>
                  <ul className="omp-deck-effect-list">
                    {ambientRows(tier, prefs, reducedMotion).map(({ effect, on, blocked, defaultedOff }) => (
                      <li
                        key={effect.id}
                        className="omp-deck-effect"
                        data-effect={effect.id}
                        data-on={on ? "true" : "false"}
                        data-blocked={blocked ?? ""}
                        data-default-off={defaultedOff ? "true" : "false"}
                        data-cost={effect.cost}
                      >
                        <label>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={blocked !== null}
                            onChange={(event) => setEffect(effect.id, event.currentTarget.checked)}
                          />
                          <span className="omp-deck-effect-label">{effect.label}</span>
                          <span className="omp-deck-effect-tier" title={`cheapest tier that may run it: ${effect.minTier}`}>
                            {effect.minTier}
                          </span>
                          <span className="omp-deck-effect-note">
                            {blocked !== null
                              ? `${blocked} — ${effect.off}`
                              : defaultedOff
                                ? `off by default at this tier — ${effect.off}`
                                : effect.description}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            {/* The keyboard help moved to the overlay (`d09`): `H` opens it
                from either surface, including flat mode where no HUD exists. */}
          </div>
        )}
      </div>
    </section>
  );
}
