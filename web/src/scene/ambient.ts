/**
 * The deck's expression layer (roadmap slice `d13`) — pure: no DOM, no
 * `three`, no clock.
 *
 * Three concerns live here, and only three:
 *
 *  1. **The effect registry.** Every visual effect the deck can add on top of
 *     its information hierarchy, with the tier that may run it, whether it is
 *     an animation, and what it costs. The settings panel is generated from
 *     this list, the HUD reads it, and `tests/deck-ambient.test.ts` proves the
 *     list is complete and the gates are total — so "every effect has an off
 *     switch" is a property of the data, not a promise in a comment.
 *  2. **The gate.** `ambientEnabled(tier, prefs, reducedMotion)` answers, per
 *     effect, whether the operator's deck runs it. Three inputs, in this
 *     order: the tier's allowance (a hard cap — an effect that needs a tier
 *     the machine did not classify cannot be switched on), reduced motion
 *     (accessibility wins over a preference), and the operator's own toggle.
 *  3. **The parameters.** Fog distances, the parallax bound, the settle
 *     timing and the drift amplitude, all as pure functions of the camera and
 *     the world — so the shape of the expression pass is testable without a
 *     GPU, and the renderer stays a consumer.
 *
 * The constraint this file exists to keep: **an idle deck renders zero
 * frames.** Nothing here is a function of a timer. Fog is a distance function,
 * parallax is a function of the camera pose, drift advances only across frames
 * that were already being drawn because something else was animating, and the
 * settle is a transition cue like every other cue in `renderer.ts`.
 *
 * The tier table's `ambient` flag is the *expression allowance*: it gates the
 * effects marked `expression: true` (today: focus drift). The effects that
 * clarify an existing surface — the floor, the fog, the parallax and the
 * completion settle — are measured against every tier's frame budget instead
 * (`docs/deck-performance-budget.md` §6), which is why they are not behind a
 * hardware-only flag.
 */

import { TIER_BUDGETS, TIER_ORDER, type QualityTier } from "./tier.ts";
import type { DeckPrefs } from "./types.ts";

/** The effects the deck can run, in the order the panel lists them. */
export type AmbientEffectId = "floor" | "fog" | "parallax" | "settle" | "drift";

export interface AmbientEffect {
  id: AmbientEffectId;
  /** Panel label — what the operator sees in the settings list. */
  label: string;
  /** One sentence: what it adds, in the operator's terms. */
  description: string;
  /** The cheapest tier that may run it. */
  minTier: QualityTier;
  /** Also needs the tier's expression allowance (`TIER_BUDGETS[tier].ambient`). */
  expression: boolean;
  /** True when the effect animates: reduced motion turns it off entirely. */
  motion: boolean;
  /**
   * Tiers whose *measured* budget the effect does not fit, where it therefore
   * ships **off** (the roadmap's `d13` rule: a tier that fails its budget with
   * an effect on must not enable it by default for that tier). Defaults and
   * caps are different things: the tier still *allows* it, and the operator's
   * switch still works — this only decides where the deck starts.
   */
  defaultOff?: readonly QualityTier[];
  /** What one instance costs, in the budget document's terms (`§4.1`). */
  cost: "geometry" | "fill" | "cpu" | "none";
  /** How it degrades when it is off (the panel says this, not the operator's guess). */
  off: string;
}

/**
 * The registry. Order is the panel's order: environment first (what the world
 * is), then motion (what it does), because that is the order it is noticed in.
 */
export const AMBIENT_EFFECTS: readonly AmbientEffect[] = [
  {
    id: "floor",
    label: "Floor grid",
    description: "The ground plane: a bounded grid centred under the rail, so pads sit on something instead of floating.",
    minTier: "minimal",
    expression: false,
    motion: false,
    cost: "geometry",
    off: "the scene keeps a plain background",
  },
  {
    id: "fog",
    label: "Distance fog",
    description: "The far edge of the world fades into the panel background, so near and far read as depth rather than as brightness.",
    minTier: "minimal",
    expression: false,
    motion: false,
    cost: "fill",
    off: "every pad has the same contrast regardless of distance",
    // Measured (docs/deck-performance-budget.md §6.2): the fog's fragment
    // branch is what pushes the `high` tier past its p95 pin on a software
    // rasterizer with MSAA (p95 21.1 ms against 13.1 without it). It ships off
    // there, and the switch still works.
    defaultOff: ["high"],
  },
  {
    id: "parallax",
    label: "Camera parallax",
    description: "The floor trails the camera by less than a world unit, which is what makes a camera move read as movement through a space.",
    minTier: "minimal",
    expression: false,
    motion: true,
    cost: "cpu",
    off: "the floor and the rail move as one plane",
  },
  {
    id: "settle",
    label: "Completion settle",
    description: "A slice that finishes gets a success-coloured plate settling onto its pad (≤ 400 ms), coalesced when several finish together.",
    minTier: "minimal",
    expression: false,
    motion: true,
    cost: "geometry",
    off: "a finished slice changes status with the ordinary highlight only",
  },
  {
    id: "drift",
    label: "Focus drift",
    description: "While a worker is live, the framing breathes by at most half a world unit — motion only while the deck is already animating, never a timer.",
    minTier: "high",
    expression: true,
    motion: true,
    cost: "cpu",
    off: "the camera holds the exact framing",
  },
];

export const AMBIENT_IDS: readonly AmbientEffectId[] = AMBIENT_EFFECTS.map((effect) => effect.id);

/** One boolean per effect: what the deck is actually running right now. */
export type AmbientState = Record<AmbientEffectId, boolean>;

/** Everything on (the default). Gates decide what that means per tier. */
export const AMBIENT_DEFAULT: AmbientState = { floor: true, fog: true, parallax: true, settle: true, drift: true };

/** The registry entry for an id. Total: every id has one. */
export function ambientEffect(id: AmbientEffectId): AmbientEffect {
  const effect = AMBIENT_EFFECTS.find((candidate) => candidate.id === id);
  if (effect === undefined) throw new Error(`unknown ambient effect: ${id}`);
  return effect;
}

/** Tier rank (`minimal` < `standard` < `high`), for the `minTier` comparison. */
function tierRank(tier: QualityTier): number {
  return TIER_ORDER.indexOf(tier);
}

/**
 * Whether a tier may run an effect at all, ignoring the operator's toggle: the
 * effect's own minimum tier, plus the expression allowance when it asks for
 * one. This is the gate the settings panel renders ("needs high") and the one
 * an override cannot defeat.
 */
export function tierAllowsEffect(tier: QualityTier, effect: AmbientEffect): boolean {
  if (tierRank(tier) < tierRank(effect.minTier)) return false;
  return !effect.expression || TIER_BUDGETS[tier].ambient;
}

/**
 * Why an effect is off, when it is off for a reason the operator cannot fix
 * with the toggle — `null` when it is on. The panel prints this string, so a
 * greyed-out switch always says which tier (or which OS setting) it waits for.
 */
export function blockedReason(tier: QualityTier, effect: AmbientEffect, reducedMotion: boolean, prefs: DeckPrefs): string | null {
  if (tierRank(tier) < tierRank(effect.minTier)) return `needs ${effect.minTier}`;
  if (effect.expression && !TIER_BUDGETS[tier].ambient) return "needs the high tier";
  if (effect.motion && reducedMotion) return "motion is reduced";
  if (prefs.effects?.[effect.id] === false) return null; // the operator turned it off
  return null;
}

/**
 * Whether an effect is on by default at a tier: on unless the tier is one whose
 * measured budget the effect does not fit (`defaultOff`).
 */
export function defaultOn(tier: QualityTier, effect: AmbientEffect): boolean {
  return effect.defaultOff?.includes(tier) !== true;
}

/**
 * The resolved state: which effects this deck is running. Tier first (a hard
 * cap), then motion (accessibility), then the operator's choice — which can
 * remove an effect always, and can add one back that the tier merely *defaults*
 * off (a measured budget default is an observation, not a permission).
 */
export function ambientEnabled(tier: QualityTier, prefs: DeckPrefs, reducedMotion: boolean): AmbientState {
  const state = {} as AmbientState;
  for (const effect of AMBIENT_EFFECTS) {
    const allowed = tierAllowsEffect(tier, effect);
    const still = effect.motion && reducedMotion;
    const override = prefs.effects?.[effect.id];
    state[effect.id] = allowed && !still && (override ?? defaultOn(tier, effect));
  }
  return state;
}

/**
 * Validate a stored effect map against the registry: unknown ids are dropped
 * (a retired effect cannot resurrect itself), and only explicit `false` entries
 * survive — "on" is the absence of an override, so a new effect ships on for
 * an operator who never opened the panel.
 */
export function sanitizeEffects(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const id of AMBIENT_IDS) {
    if ((value as Record<string, unknown>)[id] === false) out[id] = false;
  }
  return out;
}

/** The prefs object with one effect switched on or off. View state, pure. */
export function toggleEffect(prefs: DeckPrefs, id: AmbientEffectId, on: boolean): DeckPrefs {
  const effects = { ...(prefs.effects ?? {}) };
  if (on) delete effects[id];
  else effects[id] = false;
  return { ...prefs, effects };
}

/** How many effects are running, for the HUD's one-line summary. */
export function ambientCount(state: AmbientState): number {
  let count = 0;
  for (const id of AMBIENT_IDS) if (state[id]) count++;
  return count;
}

/** The HUD's summary: "3 of 5" when something is off or unavailable, else "all". */
export function ambientSummary(state: AmbientState): string {
  const on = ambientCount(state);
  return on === AMBIENT_EFFECTS.length ? "all on" : `${on}/${AMBIENT_EFFECTS.length} on`;
}

/**
 * Fog distances, relative to the camera's own distance — the one measure that
 * means "how deep is what I am looking at" whatever the run's size. `near` is
 * past the subject so the framed worker keeps its full contrast; `far` is
 * beyond the deck's far corner, so the floor dissolves rather than showing an
 * edge. Off is a far plane rather than a second material: the shader keeps its
 * fog branch, and toggling the effect never recompiles a program.
 */
export const FOG_NEAR = 0.85;
export const FOG_FAR = 2.6;
/** "No fog": far enough that the fog factor is zero at any deck scale. */
export const FOG_OFF = 1e6;

export function fogPlan(cameraDistance: number, on: boolean): { near: number; far: number } {
  const distance = Number.isFinite(cameraDistance) && cameraDistance > 0 ? cameraDistance : 1;
  return on ? { near: distance * FOG_NEAR, far: distance * FOG_FAR } : { near: distance, far: FOG_OFF };
}

/**
 * Parallax: how far the floor trails the camera, bounded by construction. A
 * soft saturation (`|d| / (|d| + softness)`) rather than a clamp, so panning
 * across a long run never parks the floor against its limit — and the floor
 * never leaves the rail's footprint.
 */
export const PARALLAX_MAX = 0.6;
/** Distance at which the parallax is half its maximum, in world units. */
export const PARALLAX_SOFTNESS = 12;

export function parallaxOffset(
  pose: { x: number; z: number },
  centre: { x: number; z: number },
  on: boolean,
): { x: number; z: number } {
  if (!on) return { x: 0, z: 0 };
  const dx = pose.x - centre.x;
  const dz = pose.z - centre.z;
  return {
    x: -PARALLAX_MAX * (dx / (Math.abs(dx) + PARALLAX_SOFTNESS)),
    z: -PARALLAX_MAX * (dz / (Math.abs(dz) + PARALLAX_SOFTNESS)),
  };
}

/**
 * The completion settle. `SETTLE_MS` is the roadmap's ≤ 400 ms; `SETTLE_MAX`
 * is the coalescing rule — when more slices finish in one model application
 * than this, the extra ones get the ordinary status highlight instead of a
 * plate, and the run-complete moment in the HUD still counts all of them.
 */
export const SETTLE_MS = 400;
export const SETTLE_MAX = 4;
/** How far above its pad a settle plate starts, in world units. */
export const SETTLE_LIFT = 1.1;

/**
 * Focus drift: a slow, bounded two-axis wander. Incommensurate periods, so it
 * never reads as a loop; the amplitude is the roadmap's half world unit, and
 * it is a function of elapsed time — the caller advances it across frames it
 * was already drawing (a camera flight, a transition cue), never on its own.
 */
export const DRIFT_AMPLITUDE = 0.5;
export const DRIFT_PERIOD_X_MS = 9_400;
export const DRIFT_PERIOD_Z_MS = 13_700;

export function driftOffset(elapsedMs: number, on: boolean): { x: number; z: number } {
  if (!on) return { x: 0, z: 0 };
  const t = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  return {
    x: DRIFT_AMPLITUDE * Math.sin((t / DRIFT_PERIOD_X_MS) * Math.PI * 2),
    z: DRIFT_AMPLITUDE * 0.6 * Math.sin((t / DRIFT_PERIOD_Z_MS) * Math.PI * 2 + 1.7),
  };
}

/**
 * The settings panel's rows, in registry order: everything the panel needs to
 * render one effect — its label, its sentence, whether it is on, and why it
 * cannot be turned on when it cannot.
 */
export interface AmbientRowState {
  effect: AmbientEffect;
  on: boolean;
  blocked: string | null;
  /**
   * Off because *this tier's* measured budget does not fit it — the panel says
   * so in words, because "greyed out for no stated reason" is the thing an
   * operator cannot act on.
   */
  defaultedOff: boolean;
}

export function ambientRows(tier: QualityTier, prefs: DeckPrefs, reducedMotion: boolean): AmbientRowState[] {
  const state = ambientEnabled(tier, prefs, reducedMotion);
  return AMBIENT_EFFECTS.map((effect) => {
    const blocked = state[effect.id] ? null : blockedReason(tier, effect, reducedMotion, prefs);
    return {
      effect,
      on: state[effect.id],
      blocked,
      defaultedOff: !state[effect.id] && blocked === null && !defaultOn(tier, effect),
    };
  });
}
