/**
 * Quality tiers and the auto-downgrade controller for the deck (roadmap
 * slices `d00` and `d10`).
 *
 * The numbers are derived from measurements recorded in
 * `docs/deck-performance-budget.md`, which also states the method and the
 * re-measure command (`bun scripts/deck-perf.ts`). `tests/deck-perf.test.ts`
 * asserts that the table in that document and `TIER_BUDGETS` below cannot
 * drift apart.
 *
 * Pure module: no DOM, no `three`. The gate machine has no hardware GL
 * (SwiftShader, ~44 ns/pixel for a trivial shader), so `minimal` is the
 * tier that must remain usable at 30 fps.
 */

export type QualityTier = "minimal" | "standard" | "high";

export interface TierBudget {
  /** Backing-store scale: canvas pixels per CSS pixel. */
  resolutionScale: number;
  /** Hard cap on scheduled frames per second (rendering is on demand). */
  maxFps: number;
  /** MSAA request for the WebGL2 context. */
  antialias: boolean;
  /** Instanced batches + individual meshes allowed in one frame. */
  maxDrawCalls: number;
  /** Slice stations the rail may show at once before collapsing to lanes. */
  maxStations: number;
  /** Alert beacons renderable at once. */
  maxBeacons: number;
  /** Ambient/expression pass allowed (`d13`). */
  ambient: boolean;
  /**
   * Frame-cost budget, ms: the median time one rendered frame may spend
   * inside the renderer. This is the number the tier controller (`d10`)
   * measures, the HUD reports and `scripts/deck-perf.ts` gates — one budget,
   * three readers. It is a *work* budget, not a frame interval: the tier's
   * `maxFps` is a cap, and a frame is allowed to spend its whole slot.
   */
  frameBudgetMs: number;
  /** p95 frame-cost budget, ms (the `d00` gate's M2 p95 column). */
  frameP95Ms: number;
}

/** CPU rasterizers: every fragment is shaded on the CPU. */
export const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|software|basic render|mesa offscreen/i;

export const TIER_BUDGETS: Record<QualityTier, TierBudget> = {
  minimal: {
    resolutionScale: 0.5,
    maxFps: 30,
    antialias: false,
    maxDrawCalls: 24,
    maxStations: 8,
    maxBeacons: 32,
    ambient: false,
    frameBudgetMs: 33,
    frameP95Ms: 45,
  },
  standard: {
    resolutionScale: 1,
    maxFps: 60,
    antialias: false,
    maxDrawCalls: 48,
    maxStations: 16,
    maxBeacons: 64,
    ambient: false,
    frameBudgetMs: 16,
    frameP95Ms: 25,
  },
  high: {
    resolutionScale: 1,
    maxFps: 60,
    antialias: true,
    maxDrawCalls: 96,
    maxStations: 32,
    maxBeacons: 128,
    ambient: true,
    frameBudgetMs: 12,
    frameP95Ms: 20,
  },
};

/** Cheapest first: the order the controller walks down (`d10`). */
export const TIER_ORDER: readonly QualityTier[] = ["minimal", "standard", "high"];

/** One step down the tier ladder, or `null` when there is nowhere lower. */
export function demoteTier(tier: QualityTier): QualityTier | null {
  const index = TIER_ORDER.indexOf(tier);
  return index > 0 ? TIER_ORDER[index - 1]! : null;
}

/**
 * Frames in the controller's rolling window (`d10`). A downgrade needs a full
 * window whose median is over budget: one slow frame (a shader compile, a GC
 * pause, a foreign process on the box) must not demote a machine that is
 * otherwise inside its budget, and a scene that is genuinely over budget
 * produces a full window of over-budget frames within a second or two.
 */
export const FRAME_WINDOW = 60;

/** Automatic demotions allowed per controller arming (`d10`). */
export const AUTO_DOWNGRADE_LIMIT = 2;

/** What one automatic demotion was: the tier it left, and the evidence. */
export interface TierDowngrade {
  from: QualityTier;
  to: QualityTier;
  /** Median frame cost of the triggering window, ms (what the HUD shows). */
  medianMs: number;
  /** Frames the controller had observed when it fired. */
  frames: number;
}

/**
 * The `d10` feedback loop, as a pure state machine: the deck feeds it the
 * cost of every rendered frame, and it answers with a demotion when the
 * machine cannot sustain the tier it is running.
 *
 * Rules, all asserted by `tests/deck-perf.test.ts`:
 *
 *  - a demotion needs a full `FRAME_WINDOW` of frames whose median exceeds
 *    the tier's `frameBudgetMs`;
 *  - it never upgrades — coming back up is an explicit operator choice (`T`);
 *  - it demotes at most `AUTO_DOWNGRADE_LIMIT` times per arming and never
 *    below `minimal`;
 *  - `stop()` is the operator's word: the controller never acts again.
 *
 * Reading `frameBudgetMs` from `TIER_BUDGETS` here is what keeps the loop, the
 * renderer, the HUD and `scripts/deck-perf.ts` on one table.
 */
export interface TierController {
  /**
   * Feed one rendered frame's cost (ms). Returns the demotion the frame
   * produced, or `null`. Allocation-free: the window and its sort scratch are
   * pre-allocated per controller.
   */
  observe(frameMs: number): TierDowngrade | null;
  /** The tier the controller is currently budgeting for. */
  tier(): QualityTier;
  /** Demotions this controller has issued. */
  downgrades(): number;
  /** Frames fed since arming. */
  samples(): number;
  /** Median of the last full window, ms; `0` until the first window fills. */
  medianMs(): number;
  /** An explicit operator choice: the controller never fires again. */
  stop(): void;
}

export function createTierController(tier: QualityTier): TierController {
  const window = new Float64Array(FRAME_WINDOW);
  const scratch = new Float64Array(FRAME_WINDOW);
  let current = tier;
  let write = 0;
  let count = 0;
  let samples = 0;
  let downgrades = 0;
  let stopped = false;
  let median = 0;

  return {
    observe(frameMs: number): TierDowngrade | null {
      if (stopped || !Number.isFinite(frameMs) || frameMs < 0) return null;
      samples++;
      window[write % FRAME_WINDOW] = frameMs;
      write++;
      if (count < FRAME_WINDOW) count++;
      if (count < FRAME_WINDOW) return null;
      scratch.set(window);
      scratch.sort();
      const half = FRAME_WINDOW / 2;
      median = (scratch[half - 1]! + scratch[half]!) / 2;
      if (median <= TIER_BUDGETS[current].frameBudgetMs) return null;
      // The floor: `minimal` has nowhere to go, so an over-budget window there
      // ends the controller instead of demoting.
      const to = demoteTier(current);
      if (to === null) {
        stopped = true;
        return null;
      }
      const from = current;
      current = to;
      downgrades++;
      // Fresh evidence at the new tier: the frames that demoted the old one
      // must not demote the new one before it has rendered anything.
      write = 0;
      count = 0;
      if (downgrades >= AUTO_DOWNGRADE_LIMIT || demoteTier(to) === null) stopped = true;
      return { from, to, medianMs: Math.round(median * 100) / 100, frames: samples };
    },
    tier(): QualityTier {
      return current;
    },
    downgrades(): number {
      return downgrades;
    },
    samples(): number {
      return samples;
    },
    medianMs(): number {
      return median;
    },
    stop(): void {
      stopped = true;
    },
  };
}

/**
 * Tier from `UNMASKED_RENDERER_WEBGL` (or `renderer.ts` after a lost context,
 * where the parameter is `null`).
 *
 * `high` is deliberately unreachable here: it is only ever selected by an
 * explicit operator choice (`T` in `d01`, persisted), never guessed from a
 * vendor string.
 */
export function classifyRenderer(renderer: string | null): QualityTier {
  if (renderer === null || renderer.trim() === "") return "standard";
  return SOFTWARE_RENDERER_RE.test(renderer) ? "minimal" : "standard";
}
