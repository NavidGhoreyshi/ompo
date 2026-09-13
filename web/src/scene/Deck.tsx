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
import { describeEvent } from "../lib/events.ts";
import { buildDeckModel } from "./model.ts";
import DeckOverlay from "./DeckOverlay.tsx";
import { railFraming } from "./rail.ts";
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
  type DeckDebugHook,
  type DeckModel,
  type DeckPrefs,
  type DeckProps,
  type RailBounds,
} from "./types.ts";

const HUD_MS = 250;
const RESIZE_DEBOUNCE_MS = 150;
const TIER_CYCLE: ("auto" | QualityTier)[] = ["auto", "minimal", "standard", "high"];

interface HudReadout {
  fps: number;
  drawCalls: number;
  objects: number;
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

/** Bounds identity for "did the world change size?" — pad positions, not equality. */
function sameBounds(a: RailBounds, b: RailBounds): boolean {
  return a.width === b.width && a.depth === b.depth && a.centerX === b.centerX && a.centerZ === b.centerZ;
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
      positions: [],
      screenPosition: null,
      instrument,
    };
  }
  return page.__ompoDeck;
}

export default function Deck({ runId, detail, events, agents, selected, live, onSelect, onExit }: DeckProps) {
  const [prefs, setPrefs] = useState<DeckPrefs>(readPrefs);
  const [hudOpen, setHudOpen] = useState(false);
  const [readout, setReadout] = useState<HudReadout | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<DeckRenderer | null>(null);
  const loopRef = useRef<FrameLoop | null>(null);
  const markedSeqRef = useRef(-1);
  const lastReadoutRef = useRef<HudReadout | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const rectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const boundsRef = useRef<RailBounds | null>(null);
  const hoverRef = useRef<string | null>(null);
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
  const projected = useMemo(
    () => buildDeckModel({ runId, detail, events, agents, selected, prefs, live }),
    [runId, detail, events, agents, selected, prefs, live],
  );
  const lastModelRef = useRef<DeckModel | null>(null);
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
          bounds: lastModelRef.current.bounds,
          digest: lastModelRef.current.digest,
        }
      : projected;
  if (!projected.loading) lastModelRef.current = projected;
  const modelRef = useRef(model);
  modelRef.current = model;

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

  /**
   * The camera frames the rail when the world's extent changes (a slice was
   * added, the run was replaced) — never per frame, and never because a status
   * moved. Pad positions do not depend on this.
   */
  const frameRail = useCallback((renderer: DeckRenderer, next: DeckModel): void => {
    const previous = boundsRef.current;
    if (previous && sameBounds(previous, next.bounds)) return;
    boundsRef.current = next.bounds;
    const size = sizeRef.current;
    renderer.setCamera(railFraming(next.bounds, size.height > 0 ? size.width / size.height : 1));
  }, []);

  /** Write a model into the scene and publish it to the debug hook. */
  const applyToScene = useCallback(
    (renderer: DeckRenderer, next: DeckModel): void => {
      if (!renderer.applyModel(next)) return;
      const hook = deckHook();
      hook.nodes = next.nodes.length;
      hook.edges = next.edges.length;
      hook.digest = next.digest;
      hook.selected = next.nodes.find((node) => node.selected)?.id ?? null;
      hook.instances = renderer.info().instances;
      hook.positions = next.nodes.map((node) => ({ id: node.id, x: node.x, z: node.z }));
      frameRail(renderer, next);
      loopRef.current?.request();
    },
    [frameRail],
  );

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
  }, []);

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
      const started = performance.now();
      const stats = active.render();
      instrument.recordFrame(performance.now() - started);
      hook.frames++;
      hook.drawCalls = stats.drawCalls;
      hook.objects = stats.objects;
      hook.triangles = stats.triangles;
      hook.vertices = stats.vertices;
      hook.pixels = stats.pixels;
    };
    const loop = createFrameLoop({
      onFrame,
      maxFps: budget.maxFps,
      isDirty: () => renderer.animating(),
    });

    rendererRef.current = renderer;
    loopRef.current = loop;
    renderer.setCamera(DEFAULT_CAMERA);
    // Mount order: the renderer exists after the size effect's state update, so
    // the model is applied here as well as from the model effect below.
    applyToScene(renderer, modelRef.current);
    renderer.setSize(size.width, size.height);
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
    };
    // `tier` and `prefs.tier` are read for the initial values only; later changes
    // go through the parameter effect below, which never rebuilds the context.
  }, [ready, rendererString, contextKey]);

  // Model changes: rewrite the rail's buffers (in place; the renderer diffs on
  // the digest) and ask for one frame. An unchanged digest — an event, a log
  // line, a worker row — asks for nothing at all.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    applyToScene(renderer, model);
  }, [model, applyToScene]);

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
  // HUD's 4 Hz tick is the only thing here that commits on a timer.
  useEffect(() => {
    instrument.recordCommit();
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

  // Keys live on the surface, not the window: focus inside the deck is the
  // gate, and text inputs are never hijacked.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (event.target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      }
      const key = event.key.toLowerCase();
      if (key === "t") {
        const current = TIER_CYCLE.indexOf(prefs.tier);
        const next = TIER_CYCLE[(current + 1) % TIER_CYCLE.length]!;
        const updated = { ...prefs, tier: next };
        setPrefs(updated);
        writePrefs(updated);
      } else if (key === "d") {
        onExit();
      } else if (key === "h" || event.key === "?") {
        setHudOpen((open) => !open);
      } else {
        return;
      }
      event.preventDefault();
    },
    [onExit, prefs],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) container.focus({ preventScroll: true });
  }, []);

  if (rendererString === null || contextFailed) {
    return (
      <section className="omp-deck omp-deck-flat" aria-label="Deck">
        <div className="omp-deck-notice" role="status">
          <p>3D unavailable on this device — the dashboard has everything.</p>
          <button type="button" className="omp-deck-button" onClick={onExit}>
            Back to dashboard
          </button>
        </div>
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
      <DeckOverlay model={model} hoverId={hover} agents={agents} events={events} onSelect={onSelect} />
      <div className="omp-deck-hud">
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
          {lastEvent && (
            <span className="omp-deck-event" ref={(element) => markRendered(element, lastEvent.seq)}>
              {lastEvent.type}
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
