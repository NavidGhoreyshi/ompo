/**
 * Quality tiers for the deck (roadmap slice `d00`).
 *
 * The numbers are derived from measurements recorded in
 * `docs/deck-performance-budget.md`, which also states the method and the
 * re-measure command. `tests/deck-perf.test.ts` asserts that the table in
 * that document and `TIER_BUDGETS` below cannot drift apart.
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
  },
  standard: {
    resolutionScale: 1,
    maxFps: 60,
    antialias: false,
    maxDrawCalls: 48,
    maxStations: 16,
    maxBeacons: 64,
    ambient: false,
  },
  high: {
    resolutionScale: 1,
    maxFps: 60,
    antialias: true,
    maxDrawCalls: 96,
    maxStations: 32,
    maxBeacons: 128,
    ambient: true,
  },
};

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
