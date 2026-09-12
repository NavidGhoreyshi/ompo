/**
 * Frame scheduler for the deck (roadmap slice `d01`).
 *
 * Rendering is on demand: a frame happens because something asked for one
 * (`request()`), never because a loop was left running. The `maxFps` cap is a
 * timestamp gate — a tick that arrives too early defers the whole frame rather
 * than drawing half of one — and a hidden document stops scheduling entirely
 * until it is visible again.
 *
 * The scheduler is dependency-injected (`raf`/`cancelRaf`/`now`/`isHidden`/
 * `onVisibility`) so its behaviour is unit-tested without a DOM, and it
 * allocates nothing per frame.
 */

export interface FrameLoopStats {
  /** Frames handed to `onFrame`. */
  frames: number;
  /** Ticks deferred by the `maxFps` gate. */
  deferred: number;
  /** Ticks that found nothing to draw (the loop then stops scheduling). */
  idleStops: number;
  /** Ticks dropped because the document was hidden. */
  hiddenDrops: number;
  maxFps: number;
}

export interface FrameLoopOptions {
  onFrame: () => void;
  maxFps: number;
  /**
   * Continuous-work predicate (an in-flight animation, a live fade). `d01`
   * has none; `d13`'s ambient pass is where this earns its keep.
   */
  isDirty?: () => boolean;
  raf?: (cb: (at: number) => void) => number;
  cancelRaf?: (handle: number) => void;
  isHidden?: () => boolean;
  /** Visibility subscription; defaults to the document listener. */
  onVisibility?: (cb: () => void) => () => void;
  now?: () => number;
}

export interface FrameLoop {
  /** Mark the scene dirty and schedule a frame. Safe to call every render. */
  request(): void;
  setMaxFps(maxFps: number): void;
  stop(): void;
  stats(): FrameLoopStats;
}

/**
 * A tick this far ahead of the gate still counts as "due": rAF cadence jitters
 * (±0.2 ms on this machine's 60 Hz), and without the slack a 30 fps gate would
 * round down to 20 fps on some ticks.
 */
const GATE_SLOP_MS = 0.5;

export function createFrameLoop(options: FrameLoopOptions): FrameLoop {
  const raf = options.raf ?? ((cb) => requestAnimationFrame(cb));
  const cancelRaf = options.cancelRaf ?? ((handle) => cancelAnimationFrame(handle));
  const isHidden = options.isHidden ?? (() => typeof document !== "undefined" && document.hidden);
  const now = options.now ?? (() => performance.now());
  const isDirty = options.isDirty ?? (() => false);

  let maxFps = options.maxFps;
  let handle: number | null = null;
  let requested = false;
  let stopped = false;
  let lastFrameAt = Number.NEGATIVE_INFINITY;
  let frames = 0;
  let deferred = 0;
  let idleStops = 0;
  let hiddenDrops = 0;

  const schedule = (): void => {
    if (stopped || handle !== null || isHidden()) return;
    handle = raf(tick);
  };

  const tick = (): void => {
    handle = null;
    if (stopped) return;
    if (isHidden()) {
      hiddenDrops++;
      return;
    }
    const at = now();
    const minInterval = maxFps > 0 ? 1000 / maxFps : 0;
    if (at - lastFrameAt + GATE_SLOP_MS < minInterval) {
      deferred++;
      schedule();
      return;
    }
    if (!requested && !isDirty()) {
      idleStops++;
      return;
    }
    requested = false;
    lastFrameAt = at;
    frames++;
    options.onFrame();
    if (requested || isDirty()) schedule();
  };

  const unsubscribeVisibility = (options.onVisibility ?? defaultVisibility)(() => {
    if (stopped || isHidden()) return;
    if (requested || isDirty()) schedule();
  });

  return {
    request(): void {
      requested = true;
      schedule();
    },
    setMaxFps(next: number): void {
      maxFps = next > 0 ? next : 0;
    },
    stop(): void {
      stopped = true;
      if (handle !== null) {
        cancelRaf(handle);
        handle = null;
      }
      unsubscribeVisibility();
    },
    stats(): FrameLoopStats {
      return { frames, deferred, idleStops, hiddenDrops, maxFps };
    },
  };
}

/** Document visibility subscription, or a no-op outside the browser. */
function defaultVisibility(cb: () => void): () => void {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return () => {};
  const handler = (): void => cb();
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
