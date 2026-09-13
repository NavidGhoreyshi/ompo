/**
 * The deck surface (roadmap slices `d01`–`d02`).
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
 * not even ask.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SliceDetail } from "../api.ts";
import { describeEvent } from "../lib/events.ts";
import { appendDismissed, DISMISSED_KEY, dismissKey, parseDismissed, type DeckAlert } from "./alerts.ts";
import { diffModels, type SceneDelta } from "./deltas.ts";
import { buildDeckModel } from "./model.ts";
import DeckOverlay from "./DeckOverlay.tsx";
import { focusTarget, nextLiveId } from "./focus.ts";
import { applyCameraIntent, edgeAnchor, focusIntent, lerpCamera, offScreenIds, type CameraIntent, type EdgeMarker } from "./camera.ts";
import { stationCountLabel } from "./lanes.ts";
import { createFrameLoop, type FrameLoop } from "./loop.ts";
import { createDeckRenderer, probeRendererString, type DeckRenderer } from "./renderer.ts";
import { instrument } from "./instrument.ts";
import { classifyRenderer, TIER_BUDGETS, type QualityTier } from "./tier.ts";
import {
  DECK_KEYS,
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
const TIER_CYCLE: ("auto" | QualityTier)[] = ["auto", "minimal", "standard", "high"];
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
  heapUsedBytes: number | null;
  heapReason: string;
  eventsPerSec: number;
  latencyP50: number;
  latencySamples: number;
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
      mounted: 0,
      disposed: 0,
      frames: 0,
      drawCalls: 0,
      objects: 0,
      triangles: 0,
      vertices: 0,
      pixels: 0,
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
      camera: { ...DEFAULT_CAMERA, target: { ...DEFAULT_CAMERA.target } },
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

export default function Deck({ runId, detail, events, agents, selected, sliceDetail, live, onSelect, onExit }: DeckProps) {
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
  /** Alert stack collapsed (`d05`): view state, like the window's freeze. */
  const [alertsCollapsed, setAlertsCollapsed] = useState(false);
  /** `command` follows the work; `rail` is the operator's whole-run overview. */
  const [preset, setPreset] = useState<DeckCameraPreset>("command");
  const containerRef = useRef<HTMLDivElement | null>(null);
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
  /** What the last framing decision was about, so it happens once per change. */
  const framingRef = useRef<{ focusId: string | null; shape: string } | null>(null);
  /** Set when a model change still owes the scene a frame (the latency stage). */
  const sceneStagePendingRef = useRef(false);
  const [ready, setReady] = useState(false);
  // A WebGL2 context can still fail to come up (driver crash, context limit);
  // that is the same product state as no WebGL2 at all, not a crashed surface.
  const [contextFailed, setContextFailed] = useState(false);

  // One probe per mount: the string is what `classifyRenderer` was measured on.
  const rendererString = useMemo(() => probeRendererString(), []);
  const tier: QualityTier = prefs.tier === "auto" ? (rendererString === null ? "standard" : classifyRenderer(rendererString)) : prefs.tier;
  const budget = TIER_BUDGETS[tier];
  const systemReducedMotion = useMemo(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const reducedMotion = prefs.reducedMotion || systemReducedMotion;
  // Every tier knob is applied to the live renderer except MSAA, which is fixed
  // when the GL context is created. Only that bit may rebuild the context.
  const contextKey = `${budget.antialias ? "aa" : "plain"}-${reducedMotion ? "still" : "motion"}`;

  const lastEvent = events.length > 0 ? events[events.length - 1]! : null;

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
      }),
    [runId, detail, events, agents, selected, sliceDetail, pinnedId, prefs, live, dismissed, budget.maxStations, budget.maxBeacons],
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
          primaryId: lastModelRef.current.primaryId,
          liveIds: lastModelRef.current.liveIds,
          alerts: lastModelRef.current.alerts,
          beaconAlerts: lastModelRef.current.beaconAlerts,
          alertsOverflow: lastModelRef.current.alertsOverflow,
          focusId: lastModelRef.current.focusId,
          bounds: lastModelRef.current.bounds,
          digest: lastModelRef.current.digest,
        }
      : projected;
  if (!projected.loading) lastModelRef.current = projected;
  const modelRef = useRef(model);
  modelRef.current = model;
  // How many workers the tier's pool holds. `stations` also lists the workers
  // it cannot (so the lane list stays complete); the difference is the HUD's
  // overflow and what the scene folds into its stack marker.
  const pooledStations = model.stations.length - model.stationOverflow;

  /**
   * The deck subtree is the mutation/layout subject the instrument watches —
   * HUD, overlay and pad list included, because a status change re-renders the
   * DOM line exactly as much as it rewrites instance colours.
   */
  const containerCallback = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    instrument.observeDom(element);
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
      } else {
        tweenRef.current = { from: cameraRef.current, to, startedAt: performance.now(), durationMs: CAMERA_LERP_MS };
      }
      loopRef.current?.request();
    },
    [applyCamera, refreshEdgeMarkers, reducedMotion],
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
      hook.nodes = next.nodes.length;
      hook.edges = next.edges.length;
      hook.digest = next.digest;
      hook.selected = next.nodes.find((node) => node.selected)?.id ?? null;
      hook.focused = next.focusId;
      hook.liveCount = next.liveIds.length;
      const info = renderer.info();
      hook.instances = info.instances;
      hook.stations = info.stations;
      hook.stationMarks = info.stationMarks;
      hook.markers = info.markers;
      hook.beacons = info.beacons;
      hook.alerts = next.alerts.length;
      hook.alertsOverflow = next.alertsOverflow;
      hook.tweens = info.tweens;
      hook.animatedEntities = info.animatedEntities;
      hook.deltas = deltas.map((delta) => {
        if (delta.kind === "status") return { kind: delta.kind, id: delta.id, from: delta.from, to: delta.to };
        if (delta.kind === "stage") return { kind: delta.kind, id: delta.id, from: String(delta.from), to: String(delta.to) };
        if (delta.kind === "attempt") return { kind: delta.kind, id: delta.id };
        if (delta.kind === "alert") return { kind: delta.kind, id: delta.id, to: delta.alert.kind };
        return { kind: delta.kind, id: delta.id, to: delta.alertKind };
      });
      hook.stationOverflow = next.stationOverflow;
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
  }, [ready, rendererString, contextFailed]);

  // Size first: a zero-size container gets no renderer at all (a 0-width
  // projection matrix is not a recoverable state, it is a bug).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const apply = (): void => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      sizeRef.current = { width: rect.width, height: rect.height };
      // Cached for pointer picking: a forced layout per pointermove is exactly
      // the cost the deck's instrument exists to catch.
      rectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      const renderer = rendererRef.current;
      if (renderer) {
        renderer.setSize(rect.width, rect.height);
        loopRef.current?.request();
        refreshEdgeMarkers();
      } else {
        setReady(true);
      }
    };
    apply();
    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        apply();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [refreshEdgeMarkers]);

  // Renderer + loop lifecycle: one WebGL context per mount. Creating contexts
  // is the expensive, fragile part on a software rasterizer (measured: a second
  // context can fail to come up at all), and a tier only changes parameters —
  // so only a change of `contextKey` (MSAA, reduced motion) rebuilds it.
  useEffect(() => {
    if (!ready || rendererString === null) return;
    const canvas = canvasRef.current;
    const size = sizeRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;

    let renderer: DeckRenderer;
    try {
      renderer = createDeckRenderer(canvas, tier, { reducedMotion });
    } catch (error) {
      console.error("deck: WebGL2 context unavailable", error);
      setContextFailed(true);
      return;
    }
    setContextFailed(false);
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
          // The camera has stopped: the off-screen set is what it is now.
          refreshEdgeMarkers();
        }
      }
      const started = performance.now();
      const stats = active.render();
      instrument.recordFrame(performance.now() - started);
      hook.frames++;
      hook.drawCalls = stats.drawCalls;
      hook.objects = stats.objects;
      hook.triangles = stats.triangles;
      hook.vertices = stats.vertices;
      hook.pixels = stats.pixels;
      hook.tweens = stats.tweens;
      hook.animatedEntities = stats.animatedEntities;
      hook.beacons = stats.beacons;
      // The scene stage of the event pipeline: the first frame that draws a
      // changed model. Attribution is per event record (instrument.ts).
      if (sceneStagePendingRef.current) {
        sceneStagePendingRef.current = false;
        instrument.noteStage("scene");
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
    hook.screenPosition = (id: string) => {
      const node = modelRef.current.nodes.find((candidate) => candidate.id === id);
      const active = rendererRef.current;
      if (!node || !active) return null;
      return active.project(node.x, 0.2, node.z);
    };

    hook.mounted++;
    hook.tier = tier;
    hook.tierSource = prefs.tier === "auto" ? "auto" : "pinned";
    instrument.setTier(tier);
    instrument.setSources({ renderer: () => renderer.info(), loop: () => loop.stats() });
    instrument.start();
    loop.request();

    return () => {
      loop.stop();
      instrument.stop();
      renderer.dispose();
      rendererRef.current = null;
      loopRef.current = null;
      hook.disposed++;
      hook.screenPosition = null;
      hook.offScreen = [];
    };
    // `tier` and `prefs.tier` are read for the initial values only; later changes
    // go through the parameter effect below, which never rebuilds the context.
  }, [ready, rendererString, contextKey]);

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
    const previous = previousModelRef.current;
    const deltas = previous !== null && previous.digest !== model.digest ? diffModels(previous, model) : [];
    previousModelRef.current = model;
    applyToScene(renderer, model, deltas);
    refreshEdgeMarkers();
  }, [model, applyToScene, refreshEdgeMarkers]);

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

  // A different run is a different world: the pin, the freeze and the window's
  // expansion are per-run view state, so they start clean.
  useEffect(() => {
    setPinnedId(null);
    setFrozenId(null);
    setExpanded(false);
  }, [runId]);

  // Tier changes are parameters: resolution scale, fps cap and the tier label,
  // applied to the live renderer and loop.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setTier(tier);
    loopRef.current?.setMaxFps(budget.maxFps);
    loopRef.current?.request();
    instrument.setTier(tier);
    const hook = deckHook();
    hook.tier = tier;
    hook.tierSource = prefs.tier === "auto" ? "auto" : "pinned";
    setReadout((current) => (current ? { ...current, pixels: renderer.info().pixels } : current));
  }, [tier, prefs.tier, budget.maxFps]);

  // HUD: React state at HUD cadence, never per frame. The forced layout read is
  // the deck's DOM/layout cost sample.
  useEffect(() => {
    if (!ready || rendererString === null) return;
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
        heapUsedBytes: sample.heap.usedBytes,
        heapReason: sample.heap.reason,
        eventsPerSec: sample.events.perSec,
        latencyP50: sample.latencyMs.p50,
        latencySamples: sample.latencyMs.samples,
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
  }, [ready, rendererString, hudOpen]);

  // Every commit of the deck subtree, counted where React schedules it. The
  // HUD's 4 Hz tick is the only thing here that commits on a timer. The live
  // window's row/line counts are read from the DOM the operator is looking at
  // (the component publishes them as data attributes) — that is the bounded
  // window's evidence, and it cannot disagree with what was rendered.
  useEffect(() => {
    instrument.recordCommit();
    const live = containerRef.current?.querySelector(".omp-livefeed");
    if (live) {
      const hook = deckHook();
      hook.liveRows = Number(live.getAttribute("data-rows") ?? 0);
      hook.logLines = Number(live.getAttribute("data-lines") ?? 0);
    }
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
        const current = TIER_CYCLE.indexOf(prefs.tier);
        const next = TIER_CYCLE[(current + 1) % TIER_CYCLE.length]!;
        const updated = { ...prefs, tier: next };
        setPrefs(updated);
        writePrefs(updated);
      } else if (key === "m") {
        // Reduced motion (`d05`): every transition becomes 0 ms, so the scene
        // applies state changes instantly and the alert stack is unchanged.
        const updated = { ...prefs, reducedMotion: !prefs.reducedMotion };
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
        // Release the pin: follow the primary again, from wherever we are.
        setPinnedId(null);
        setPreset("command");
        frameSlice(focusTarget(detail?.slices ?? [], null));
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
        dispatchCamera({ kind: "pan", right, forward }, true);
      } else if (key === "+" || key === "=" || key === "-") {
        dispatchCamera({ kind: "zoom", factor: key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP }, true);
      } else {
        return;
      }
      event.preventDefault();
    },
    [detail, dispatchCamera, focusOn, framePreset, frameSlice, onExit, prefs, preset],
  );

  // Wheel zoom is a native listener: React's synthetic wheel events are
  // passive at the root, so `preventDefault` there would not stop the page
  // from scrolling behind the surface.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent): void => {
      // The transcript and the lane list scroll themselves; only the empty
      // scene area zooms.
      if (event.target instanceof Element && event.target.closest(".omp-livefeed-log, .omp-deck-lanes, .omp-deck-mirror") !== null) return;
      event.preventDefault();
      dispatchCamera({ kind: "zoom", factor: event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP }, true);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [dispatchCamera]);

  useEffect(() => {
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) container.focus({ preventScroll: true });
  }, []);

  if (rendererString === null || contextFailed) {
    // No scene: the deck's information layer is DOM anyway (station line, live
    // workers, the bounded window), so the operator keeps the part that answers
    // questions and loses only the spatial overview (`d09` builds the full flat
    // projection on this contract, including the pad list).
    return (
      <section
        className="omp-deck omp-deck-flat"
        aria-label="Deck"
        ref={containerCallback}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-tier="flat"
        data-motion={reducedMotion ? "reduced" : "full"}
      >
        <div className="omp-deck-notice" role="status">
          <p>3D unavailable on this device — the spatial overview is off; the live deck below still works, and the dashboard has everything else.</p>
          <button type="button" className="omp-deck-button" onClick={onExit}>
            Back to dashboard
          </button>
        </div>
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
          onDismiss={dismissAlert}
          alertsCollapsed={alertsCollapsed}
          onAlertsCollapsedChange={setAlertsCollapsed}
        />
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
      data-motion={reducedMotion ? "reduced" : "full"}
    >
      {/* Keyed by the context identity: a canvas whose context was lost can
          never hand out another one, so a rebuild gets a fresh element. */}
      <canvas
        key={contextKey}
        className="omp-deck-canvas"
        ref={canvasRef}
        aria-label="Workflow scene"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
      />
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
        onDismiss={dismissAlert}
        alertsCollapsed={alertsCollapsed}
        onAlertsCollapsedChange={setAlertsCollapsed}
      />
      <div className="omp-deck-hud" ref={hudRef}>
        <div className="omp-deck-row">
          <span className="omp-deck-chip" data-tier={tier}>
            {tier}
            {prefs.tier === "auto" ? " · auto" : " · pinned"}
          </span>
          {tier === "minimal" && <span className="omp-deck-warn">software renderer detected</span>}
          <span className="omp-deck-metric">{readout ? `${readout.fps.toFixed(0)} fps` : "— fps"}</span>
          <span className="omp-deck-metric">{readout?.drawCalls ?? 0} calls</span>
          <span className="omp-deck-metric">{readout?.objects ?? 0} objects</span>
          <span className="omp-deck-metric" data-model="true">
            {model.nodes.length} pads · {model.edges.length} edges
          </span>
          <span className="omp-deck-metric">
            {budget.resolutionScale}× · {readout?.pixels ?? 0} px
          </span>
          <span className="omp-deck-metric">run {runId ?? "none"}</span>
          <span className="omp-deck-metric" data-live={live ? "true" : "false"}>
            {live ? "live" : "quiescent"}
          </span>
          <span className="omp-deck-metric" data-live-count={model.liveIds.length} data-station-count={pooledStations}>
            {stationCountLabel(model.liveIds.length, pooledStations)} · showing {model.focusId ?? "—"}
            {pinnedId !== null ? ` · pinned` : ""}
          </span>
          <span className="omp-deck-metric" data-motion={reducedMotion ? "reduced" : "full"}>
            motion: {reducedMotion ? "reduced" : "full"}
          </span>
          <span className="omp-deck-metric" data-alert-count={model.alerts.length} data-beacon-count={model.beaconAlerts.length}>
            alerts: {model.alerts.length}
            {model.alertsOverflow > 0 ? ` · ${model.alertsOverflow} over the beacon cap` : ""}
          </span>
          {model.warnings.length > 0 && (
            <span className="omp-deck-warn" data-slot-warnings={model.warnings.length}>
              {model.warnings.length} slot warning{model.warnings.length === 1 ? "" : "s"}
            </span>
          )}
          {lastEvent && (
            <span className="omp-deck-event" ref={(element) => markRendered(element, lastEvent.seq)}>
              {lastEvent.type}
              {lastEvent.sliceId ? ` · ${lastEvent.sliceId}` : ""}
              {describeEvent(lastEvent) && ` · ${describeEvent(lastEvent)}`} · seq {lastEvent.seq}
            </span>
          )}
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
                  {readout?.tweens ?? 0} cues · {readout?.animatedEntities ?? 0} entities · {readout?.sceneWrites ?? 0} scene writes
                  {reducedMotion ? " · motion reduced" : ""}
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
            <ul className="omp-deck-keys">
              {DECK_KEYS.map((entry) => (
                <li key={entry.key} data-live={entry.slice === "d01" ? "true" : "false"}>
                  <kbd>{entry.key}</kbd>
                  <span>{entry.effect}</span>
                  {entry.slice !== "d01" && <em>{entry.slice}</em>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
