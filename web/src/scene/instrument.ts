/**
 * Deck instrumentation (roadmap slice `d01`).
 *
 * The gate's instruments are built with the thing they measure: frames and
 * frame times, React commits, DOM mutations, forced-layout cost, long tasks,
 * heap, event→visible latency, and the renderer's own counters. `d03v`
 * consumes them through `window.__ompoDeck` / `snapshot()`.
 *
 * Cost by construction: one 1 s sampler, a fixed-size ring buffer per frame
 * (no allocation), and everything else counted — the per-frame path touches no
 * DOM API and allocates nothing. Instrumentation is always on: the gate must
 * measure the build the operator uses, not a dev-only variant.
 */

import type { FrameLoopStats } from "./loop.ts";
import type { QualityTier } from "./tier.ts";
import type { RenderStats } from "./types.ts";

/** Frame times kept for percentiles (≈50 s at 60 fps). */
export const FRAME_RING = 3000;
/** Event→visible latencies kept per window. */
export const LATENCY_RING = 512;
/** Event records kept per window — one slot per possible latency sample. */
const RECORD_RING = LATENCY_RING;
/** Pending event timestamps remembered for latency matching. */
const PENDING_EVENTS = 512;
/**
 * Fill cost measured by `scripts/deck-probe.ts` (`d00`): 9 ns per shaded
 * pixel, median across runs on this machine. Used only to turn the renderer's
 * pixel counters into a millisecond estimate — the measured frame time stays
 * the ground truth.
 */
export const SHADER_NS_PER_PIXEL = 9;

export interface FrameTimeStats {
  p50: number;
  p95: number;
  worst: number;
  samples: number;
}

export interface HeapReading {
  supported: boolean;
  usedBytes: number | null;
  reason: string;
}

/**
 * Per-stage latency sample sets for one window, split so the gate can attribute
 * a regression to the pipeline stage that caused it instead of one collapsed
 * event→visible number. `transport` is measured from the event's own timestamp
 * (it may have been produced remotely and read later); the other three are
 * measured from the moment the event was applied to React state. A stage with
 * no mark is absent from its set — never zero-filled.
 */
export interface LatencyStageSamples {
  transport: number[];
  dom: number[];
  model: number[];
  scene: number[];
  /** Records that produced at least one stage value. */
  samples: number;
}

/** The same split as `LatencyStageSamples`, reduced to percentiles. */
export interface LatencyStageStats {
  transport: FrameTimeStats;
  dom: FrameTimeStats;
  model: FrameTimeStats;
  scene: FrameTimeStats;
  /** Records that produced at least one stage value. */
  samples: number;
}

/** One JSON-serialisable sample: what the gate records and the HUD shows. */
export interface DeckSample {
  at: string;
  surface: "deck";
  tier: QualityTier;
  windowMs: number;
  frames: number;
  framesPerSec: number;
  frameMs: FrameTimeStats;
  commits: number;
  commitsPerSec: number;
  mutations: number;
  mutationsPerSec: number;
  domElements: number;
  layoutMs: number;
  longTasks: { count: number; worstMs: number };
  heap: HeapReading;
  events: { applied: number; perSec: number; markMisses: number };
  latencyMs: FrameTimeStats;
  /** The same window's event→visible latency, split by pipeline stage. */
  latencyStages: LatencyStageStats;
  renderer: RenderStats | null;
  loop: FrameLoopStats;
  estimate: { shadedPixels: number; shaderMs: number; basis: string };
}

/** Everything `computeSample` needs, so the sampler itself stays pure. */
export interface SampleInput {
  now: number;
  windowStart: number;
  tier: QualityTier;
  frames: number;
  commits: number;
  mutations: number;
  events: number;
  markMisses: number;
  domElements: number;
  longTasks: { count: number; worstMs: number };
  heap: HeapReading;
  frameTimes: number[];
  latencies: number[];
  latencyStages: LatencyStageSamples;
  layouts: number[];
  renderer: RenderStats | null;
  loop: FrameLoopStats;
}

/** Nearest-rank percentiles over an unsorted copy; `worst` is the maximum. */
export function frameTimeStats(values: number[]): FrameTimeStats {
  if (values.length === 0) return { p50: 0, p95: 0, worst: 0, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
  return { p50: at(50), p95: at(95), worst: sorted[sorted.length - 1]!, samples: sorted.length };
}

/** Pure sampler core: rates and percentiles for one window. */
export function computeSample(input: SampleInput): DeckSample {
  const windowMs = Math.max(1, input.now - input.windowStart);
  const perSec = (count: number): number => Math.round((count / (windowMs / 1000)) * 100) / 100;
  const shadedPixels = input.renderer?.shadedPixels ?? 0;
  return {
    at: new Date(input.now).toISOString(),
    surface: "deck",
    tier: input.tier,
    windowMs: Math.round(windowMs),
    frames: input.frames,
    framesPerSec: perSec(input.frames),
    frameMs: frameTimeStats(input.frameTimes),
    commits: input.commits,
    commitsPerSec: perSec(input.commits),
    mutations: input.mutations,
    mutationsPerSec: perSec(input.mutations),
    domElements: input.domElements,
    layoutMs: frameTimeStats(input.layouts).p50,
    longTasks: { count: input.longTasks.count, worstMs: Math.round(input.longTasks.worstMs * 100) / 100 },
    heap: input.heap,
    events: { applied: input.events, perSec: perSec(input.events), markMisses: input.markMisses },
    latencyMs: frameTimeStats(input.latencies),
    latencyStages: {
      transport: frameTimeStats(input.latencyStages.transport),
      dom: frameTimeStats(input.latencyStages.dom),
      model: frameTimeStats(input.latencyStages.model),
      scene: frameTimeStats(input.latencyStages.scene),
      samples: input.latencyStages.samples,
    },
    renderer: input.renderer,
    loop: input.loop,
    estimate: {
      shadedPixels,
      shaderMs: Math.round(shadedPixels * SHADER_NS_PER_PIXEL) / 1e6,
      basis: "shadedPixels = backing pixels × full-screen layers + grid-line upper bound; ms at 9 ns/px (d00)",
    },
  };
}

export interface InstrumentationDeps {
  now?: () => number;
  /**
   * Wall clock for event→visible latency. The event's `at` is an epoch
   * timestamp, so latency must be measured against the same clock — mixing in
   * `performance.now()` would report every mark as zero.
   */
  wallClock?: () => number;
  setInterval?: (cb: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
  observeMutations?: (root: Element, onRecords: (count: number) => void) => () => void;
  observeLongTasks?: (onTask: (durationMs: number) => void) => () => void;
  readHeap?: () => HeapReading;
  /** Element census for the sampled `domElements`; injected for DOM-free tests. */
  countElements?: (root: Element) => number;
}

export interface Instrumentation {
  /** Per frame; allocation-free. */
  recordFrame(ms: number): void;
  /** Per React commit of the deck subtree (a `useEffect` with no deps). */
  recordCommit(): void;
  /** Forced-layout cost, sampled by the HUD tick. */
  recordLayout(ms: number): void;
  /** An event was applied to React state at `at` (`RunEvent.at`, or epoch ms). */
  noteEvent(seq: number, at: string | number): void;
  /** The derived text for `seq` is now in the document. */
  markEventRendered(seq: number): void;
  /**
   * A pipeline stage mark for the current event record: the deck calls this
   * when its model update lands and when it renders the frame. `dom` is the
   * third stage and is written by `markEventRendered`.
   */
  noteStage(stage: "model" | "scene"): void;
  /** Start counting mutations inside the deck subtree. */
  observeDom(root: Element | null): void;
  setTier(tier: QualityTier): void;
  setSources(sources: { renderer: () => RenderStats | null; loop: () => FrameLoopStats }): void;
  start(): void;
  stop(): void;
  /** Windowed sample: everything since the previous `snapshot()`/`start()`. */
  snapshot(): DeckSample;
  /** Read-only view of the current window — the HUD's 4 Hz tick. */
  latest(): DeckSample;
}

/** `performance.memory` is a Chrome-only extension; absent elsewhere. */
function defaultHeap(): HeapReading {
  const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } };
  const used = perf.memory?.usedJSHeapSize;
  if (typeof used !== "number") {
    return { supported: false, usedBytes: null, reason: "performance.memory is unavailable in this browser" };
  }
  return { supported: true, usedBytes: used, reason: "" };
}

function defaultMutations(root: Element, onRecords: (count: number) => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver((records) => onRecords(records.length));
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  return () => observer.disconnect();
}

function defaultLongTasks(onTask: (durationMs: number) => void): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) onTask(entry.duration);
    });
    observer.observe({ entryTypes: ["longtask"] });
    return () => observer.disconnect();
  } catch {
    return () => {}; // entry type unsupported: long tasks simply read as zero
  }
}

export function createInstrumentation(deps: InstrumentationDeps = {}): Instrumentation {
  const now = deps.now ?? (() => performance.now());
  const wallClock = deps.wallClock ?? (() => Date.now());
  const setTimer = deps.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms) as unknown as number);
  const clearTimer = deps.clearInterval ?? ((handle: number) => clearInterval(handle));
  const observeMutations = deps.observeMutations ?? defaultMutations;
  const observeLongTasks = deps.observeLongTasks ?? defaultLongTasks;
  const readHeap = deps.readHeap ?? defaultHeap;
  const countElements = deps.countElements ?? ((root: Element) => root.querySelectorAll("*").length);

  const frameRing = new Float64Array(FRAME_RING);
  let frameWrite = 0;
  let frameCount = 0;

  let tier: QualityTier = "standard";
  let rendererSource: () => RenderStats | null = () => null;
  let loopSource: () => FrameLoopStats = () => ({ frames: 0, deferred: 0, idleStops: 0, hiddenDrops: 0, maxFps: 0 });

  let commits = 0;
  let mutations = 0;
  let eventsApplied = 0;
  let markMisses = 0;
  let domElements = 0;
  let longTaskCount = 0;
  let longTaskWorstMs = 0;
  let timer: number | null = null;
  let windowStart = now();

  const latencies: number[] = [];
  const layouts: number[] = [];
  const pending = new Map<number, number>();
  const pendingAt: number[] = [];
  let detachMutations: (() => void) | null = null;
  /**
   * The element the deck asked to watch. Survives `stop()` on purpose: the
   * instrument is stopped and started again across renderer rebuilds, and the
   * counters must not silently freeze at their last value (see `start`).
   */
  let lastRoot: Element | null = null;
  let detachLongTasks: (() => void) | null = null;

  /**
   * Event records for the stage split, one slot per `noteEvent`. `at`/`rx` are
   * always written; a stage stays NaN until it is marked, so a record without
   * one is absent from that stage's sample set rather than reading as zero.
   */
  const recSeq = new Float64Array(RECORD_RING);
  const recAt = new Float64Array(RECORD_RING);
  const recRx = new Float64Array(RECORD_RING);
  const recDom = new Float64Array(RECORD_RING).fill(NaN);
  const recModel = new Float64Array(RECORD_RING).fill(NaN);
  const recScene = new Float64Array(RECORD_RING).fill(NaN);
  let recWrite = 0;
  let recCount = 0;

  const slotOf = (index: number): number => (recWrite - recCount + index + RECORD_RING) % RECORD_RING;
  const currentSlot = (): number => (recWrite - 1 + RECORD_RING) % RECORD_RING;

  /**
   * Opening a record closes the previous one: it keeps the stages already
   * marked, and only its own `dom` mark (matched by seq) can still land on it.
   *
   * Attribution: the deck's model update and frame follow an event causally and
   * happen before the next event is scripted, so a bare `noteStage` mark
   * belongs to the newest record. The perf spec scripts one event at a time,
   * which is what makes that honest; batched events would need an explicit seq.
   */
  const openRecord = (seq: number, at: number): void => {
    const slot = recWrite % RECORD_RING;
    recSeq[slot] = seq;
    recAt[slot] = at;
    recRx[slot] = wallClock();
    recDom[slot] = NaN;
    recModel[slot] = NaN;
    recScene[slot] = NaN;
    recWrite++;
    if (recCount < RECORD_RING) recCount++;
  };

  /** First mark wins: a stage is a single moment, not the last write. */
  const setStage = (slot: number, target: Float64Array, value: number): void => {
    if (Number.isFinite(target[slot]!)) return;
    target[slot] = value;
  };

  /** `dom` is matched by seq because later events may already have opened. */
  const markRendered = (seq: number, value: number): void => {
    for (let i = recCount - 1; i >= 0; i--) {
      const slot = slotOf(i);
      if (recSeq[slot] === seq) {
        setStage(slot, recDom, value);
        return;
      }
    }
  };

  const stageSamples = (): LatencyStageSamples => {
    const transport: number[] = [];
    const dom: number[] = [];
    const model: number[] = [];
    const scene: number[] = [];
    let samples = 0;
    for (let i = 0; i < recCount; i++) {
      const slot = slotOf(i);
      const rx = recRx[slot]!;
      if (!Number.isFinite(rx)) continue;
      samples++;
      transport.push(Math.max(0, rx - recAt[slot]!));
      if (Number.isFinite(recDom[slot]!)) dom.push(Math.max(0, recDom[slot]! - rx));
      if (Number.isFinite(recModel[slot]!)) model.push(Math.max(0, recModel[slot]! - rx));
      if (Number.isFinite(recScene[slot]!)) scene.push(Math.max(0, recScene[slot]! - rx));
    }
    return { transport, dom, model, scene, samples };
  };

  const frameTimes = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < frameCount; i++) out.push(frameRing[(frameWrite - frameCount + i + FRAME_RING) % FRAME_RING]!);
    return out;
  };

  const ring = (list: number[]): number[] => list.slice(-LATENCY_RING);

  const takeSample = (): DeckSample => {
    const sample = computeSample({
      now: now(),
      windowStart,
      tier,
      frames: frameCount,
      commits,
      mutations,
      events: eventsApplied,
      markMisses,
      domElements,
      longTasks: { count: longTaskCount, worstMs: longTaskWorstMs },
      heap: readHeap(),
      frameTimes: frameTimes(),
      latencies: ring(latencies),
      latencyStages: stageSamples(),
      layouts: ring(layouts),
      renderer: rendererSource(),
      loop: loopSource(),
    });
    return sample;
  };

  const restartWindow = (): void => {
    windowStart = now();
    commits = 0;
    mutations = 0;
    longTaskCount = 0;
    longTaskWorstMs = 0;
    eventsApplied = 0;
    markMisses = 0;
    frameCount = 0;
    frameWrite = 0;
    latencies.length = 0;
    layouts.length = 0;
    recWrite = 0;
    recCount = 0;
  };

  return {
    recordFrame(ms: number): void {
      frameRing[frameWrite % FRAME_RING] = ms;
      frameWrite++;
      if (frameCount < FRAME_RING) frameCount++;
    },
    recordCommit(): void {
      commits++;
    },
    recordLayout(ms: number): void {
      layouts.push(ms);
      if (layouts.length > LATENCY_RING) layouts.shift();
    },
    noteEvent(seq: number, at: string | number): void {
      const stamp = typeof at === "number" ? at : Date.parse(at);
      if (!Number.isFinite(stamp)) return;
      if (pending.size >= PENDING_EVENTS && pendingAt.length > 0) {
        const oldest = pendingAt.shift();
        if (oldest !== undefined) pending.delete(oldest);
      }
      pending.set(seq, stamp);
      pendingAt.push(seq);
      openRecord(seq, stamp);
    },
    markEventRendered(seq: number): void {
      const stamp = pending.get(seq);
      if (stamp === undefined) {
        markMisses++;
        return;
      }
      pending.delete(seq);
      const index = pendingAt.indexOf(seq);
      if (index >= 0) pendingAt.splice(index, 1);
      const renderedAt = wallClock();
      markRendered(seq, renderedAt);
      latencies.push(Math.max(0, renderedAt - stamp));
      eventsApplied++;
      if (latencies.length > LATENCY_RING) latencies.shift();
    },
    noteStage(stage: "model" | "scene"): void {
      // Marked before any event: nothing to attribute it to, so it is ignored.
      if (recWrite === 0) return;
      setStage(currentSlot(), stage === "model" ? recModel : recScene, wallClock());
    },
    observeDom(root: Element | null): void {
      lastRoot = root;
      detachMutations?.();
      detachMutations = null;
      if (root) detachMutations = observeMutations(root, (count) => {
        mutations += count;
      });
    },
    setTier(next: QualityTier): void {
      tier = next;
    },
    setSources(sources: { renderer: () => RenderStats | null; loop: () => FrameLoopStats }): void {
      rendererSource = sources.renderer;
      loopSource = sources.loop;
    },
    start(): void {
      restartWindow();
      if (timer !== null) clearTimer(timer);
      detachLongTasks?.();
      detachLongTasks = observeLongTasks((durationMs) => {
        longTaskCount++;
        longTaskWorstMs = Math.max(longTaskWorstMs, durationMs);
      });
      // Re-attach the DOM observer: `stop()` detaches it (a deck switch or a
      // renderer rebuild stops and starts the instrument), and the element the
      // deck promised to watch is still the one to watch. Without this the
      // mutation and element counters silently freeze at their last values —
      // measured as `mutations: 0` in the reduced-motion transition window
      // (`d05`), where pressing `M` rebuilds the renderer.
      if (lastRoot !== null && detachMutations === null) {
        detachMutations = observeMutations(lastRoot, (count) => {
          mutations += count;
        });
      }
      timer = setTimer(() => {
        if (lastRoot) domElements = countElements(lastRoot);
      }, 1000);
    },
    stop(): void {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      detachLongTasks?.();
      detachLongTasks = null;
      detachMutations?.();
      detachMutations = null;
    },
    snapshot(): DeckSample {
      const sample = takeSample();
      restartWindow();
      return sample;
    },
    latest(): DeckSample {
      return takeSample();
    },
  };
}

/**
 * The page-wide instance. `App.tsx` notes events on it (it is the component
 * that applies them) and the deck writes everything else, so the gate sees one
 * coherent record regardless of which surface is mounted.
 */
export const instrument: Instrumentation = createInstrumentation();
