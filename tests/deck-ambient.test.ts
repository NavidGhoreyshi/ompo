/**
 * The deck's expression layer (roadmap slice `d13`).
 *
 * These are the rules the settings panel and the renderer both depend on, and
 * they are all provable without a GPU: the registry is complete (every effect
 * has a label, a tier, a cost and an off state), the gate is total over tiers,
 * motion and preferences, an override can only ever *remove* an effect, and
 * every parameter is bounded — which is what "an idle deck renders zero frames"
 * and "polish never competes with the work" mean in numbers.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AMBIENT_DEFAULT,
  AMBIENT_EFFECTS,
  defaultOn,
  AMBIENT_IDS,
  DRIFT_AMPLITUDE,
  FOG_FAR,
  FOG_NEAR,
  FOG_OFF,
  PARALLAX_MAX,
  SETTLE_LIFT,
  SETTLE_MAX,
  SETTLE_MS,
  ambientCount,
  ambientEffect,
  ambientEnabled,
  ambientRows,
  ambientSummary,
  blockedReason,
  driftOffset,
  fogPlan,
  parallaxOffset,
  sanitizeEffects,
  tierAllowsEffect,
  toggleEffect,
  type AmbientEffectId,
} from "../web/src/scene/ambient.ts";
import { TIER_BUDGETS } from "../web/src/scene/tier.ts";
import { DEFAULT_DECK_PREFS, parseDeckPrefs, type DeckPrefs } from "../web/src/scene/types.ts";

const TIERS = ["minimal", "standard", "high"] as const;

const prefs = (effects?: Record<string, boolean>): DeckPrefs => ({ ...DEFAULT_DECK_PREFS, effects: effects ?? {} });

describe("the effect registry", () => {
  test("every effect is complete: id, label, sentence, tier, cost and an off state", () => {
    expect(AMBIENT_EFFECTS.length).toBeGreaterThan(3);
    expect(new Set(AMBIENT_IDS).size).toBe(AMBIENT_EFFECTS.length);
    for (const effect of AMBIENT_EFFECTS) {
      expect(effect.id.length).toBeGreaterThan(0);
      expect(effect.label.length).toBeGreaterThan(0);
      expect(effect.description.length).toBeGreaterThan(20);
      // "Every effect has an off switch" is only true if the panel can say what
      // it loses when it is off.
      expect(effect.off.length).toBeGreaterThan(10);
      expect(TIERS).toContain(effect.minTier);
      expect(["geometry", "fill", "cpu", "none"]).toContain(effect.cost);
      expect(typeof effect.motion).toBe("boolean");
      expect(typeof effect.expression).toBe("boolean");
      for (const tier of effect.defaultOff ?? []) expect(TIERS).toContain(tier);
      expect(ambientEffect(effect.id)).toBe(effect);
    }
  });

  test("an unknown id is a programming error, not a silent no-op", () => {
    expect(() => ambientEffect("nope" as AmbientEffectId)).toThrow();
  });

  test("the expression pass is the one the tier table's ambient flag gates", () => {
    const expression = AMBIENT_EFFECTS.filter((effect) => effect.expression);
    expect(expression.length).toBeGreaterThan(0);
    for (const tier of TIERS) {
      for (const effect of expression) {
        // A tier without the allowance cannot run an expression effect, whatever
        // the effect's own minimum says.
        if (!TIER_BUDGETS[tier].ambient) expect(tierAllowsEffect(tier, effect)).toBe(false);
      }
    }
    // The clarifying effects (floor, fog, parallax, settle) are *not* behind a
    // hardware-only flag: they are measured against every tier's frame budget
    // instead, which is why the minimal tier keeps them.
    for (const id of ["floor", "fog", "parallax", "settle"] as const) {
      expect(ambientEffect(id).expression).toBe(false);
      expect(tierAllowsEffect("minimal", ambientEffect(id))).toBe(true);
    }
  });

  test("every effect is listed in the budget document's table", () => {
    const doc = readFileSync(join(import.meta.dir, "..", "docs", "deck-performance-budget.md"), "utf8");
    for (const effect of AMBIENT_EFFECTS) {
      expect(`doc: ${effect.id}: ${doc.includes(`\`${effect.id}\``)}`).toBe(`doc: ${effect.id}: true`);
    }
  });
});

describe("ambientEnabled", () => {
  test("the default deck runs the cheap set, and only the high tier runs the expression pass", () => {
    expect(ambientEnabled("minimal", prefs(), false)).toEqual({
      floor: true,
      fog: true,
      parallax: true,
      settle: true,
      drift: false,
    });
    expect(ambientEnabled("standard", prefs(), false).drift).toBe(false);
    // `high` is where the expression pass lives — and where the fog ships off
    // (its own measured default, asserted below).
    expect(ambientEnabled("high", prefs(), false)).toEqual({ ...AMBIENT_DEFAULT, fog: false });
  });

  test("an effect a tier's measured budget does not fit ships off there, and stays switchable", () => {
    // `fog` is the one: it pushed `high`'s p95 past its pin on this software
    // rasterizer (docs/deck-performance-budget.md §6.2), which is the roadmap's
    // rule for a default — not a cap.
    expect(ambientEffect("fog").defaultOff).toEqual(["high"]);
    expect(defaultOn("high", ambientEffect("fog"))).toBe(false);
    expect(ambientEnabled("high", prefs(), false).fog).toBe(false);
    // Every other tier still gets it, and the operator can have it at `high`.
    expect(ambientEnabled("minimal", prefs(), false).fog).toBe(true);
    expect(ambientEnabled("standard", prefs(), false).fog).toBe(true);
    expect(ambientEnabled("high", prefs({ fog: true }), false).fog).toBe(true);
    // …but nothing about the default makes it a *blocked* row: the switch works.
    const row = ambientRows("high", prefs(), false).find((candidate) => candidate.effect.id === "fog")!;
    expect(row).toEqual({ effect: ambientEffect("fog"), on: false, blocked: null, defaultedOff: true });
    const enabled = ambientRows("high", prefs({ fog: true }), false).find((candidate) => candidate.effect.id === "fog")!;
    expect(enabled.on).toBe(true);
    expect(enabled.defaultedOff).toBe(false);
  });

  test("reduced motion stops every animated effect and no static one", () => {
    const state = ambientEnabled("high", prefs(), true);
    expect(state).toEqual({ floor: true, fog: false, parallax: false, settle: false, drift: false });
    // Motion is a property of the effect, not of the tier: the reduced-motion
    // answer is the same wherever it runs.
    for (const tier of TIERS) {
      for (const effect of AMBIENT_EFFECTS) {
        if (!effect.motion) continue;
        expect(`${tier}/${effect.id}: ${ambientEnabled(tier, prefs(), true)[effect.id]}`).toBe(`${tier}/${effect.id}: false`);
      }
    }
  });

  test("an override can remove an effect and can never add one the tier refuses", () => {
    expect(ambientEnabled("high", prefs({ fog: false }), false).fog).toBe(false);
    // `drift: true` on a tier without the allowance changes nothing.
    expect(ambientEnabled("minimal", prefs({ drift: true }), false).drift).toBe(false);
    // …and an override cannot defeat reduced motion either.
    expect(ambientEnabled("high", prefs({ settle: true }), true).settle).toBe(false);
  });

  test("all effects off is a valid, fully enumerated state", () => {
    const off: Record<string, boolean> = {};
    for (const id of AMBIENT_IDS) off[id] = false;
    const state = ambientEnabled("high", prefs(off), false);
    expect(ambientCount(state)).toBe(0);
    expect(ambientSummary(state)).toBe(`0/${AMBIENT_EFFECTS.length} on`);
    for (const id of AMBIENT_IDS) expect(state[id]).toBe(false);
  });

  test("the summary counts what is running", () => {
    expect(ambientSummary(AMBIENT_DEFAULT)).toBe("all on");
    expect(ambientCount(ambientEnabled("minimal", prefs(), false))).toBe(4);
    expect(ambientSummary(ambientEnabled("minimal", prefs(), false))).toBe(`4/${AMBIENT_EFFECTS.length} on`);
  });
});

describe("why an effect is off", () => {
  test("a tier gap, a motion preference, and the operator's own choice are told apart", () => {
    expect(blockedReason("minimal", ambientEffect("drift"), false, prefs())).toBe("needs high");
    expect(blockedReason("high", ambientEffect("settle"), true, prefs())).toBe("motion is reduced");
    // Switched off by hand: nothing is blocking it, and the panel must not say
    // otherwise.
    expect(blockedReason("high", ambientEffect("fog"), false, prefs({ fog: false }))).toBeNull();
    expect(blockedReason("high", ambientEffect("fog"), false, prefs())).toBeNull();
  });

  test("the panel's rows carry the reason, and a disabled row always has one", () => {
    for (const tier of TIERS) {
      for (const row of ambientRows(tier, prefs(), false)) {
        // A row that is off always says why: a tier it needs, a motion
        // preference, or the tier's own measured default.
        expect(row.on || row.blocked !== null || row.defaultedOff).toBe(true);
        expect(row.on && row.blocked !== null).toBe(false);
        expect(row.on && row.defaultedOff).toBe(false);
      }
    }
    const rows = ambientRows("minimal", prefs(), false);
    expect(rows.map((row) => row.effect.id)).toEqual([...AMBIENT_IDS]);
    expect(rows.find((row) => row.effect.id === "drift")?.blocked).toBe("needs high");
    // The operator's own off switch is not a "blocked" row: it is switchable.
    const manual = ambientRows("high", prefs({ floor: false }), false).find((row) => row.effect.id === "floor");
    expect(manual?.on).toBe(false);
    expect(manual?.blocked).toBeNull();
    expect(manual?.defaultedOff).toBe(false);
  });
});

describe("the stored preference map", () => {
  test("only known ids and only explicit offs survive a round trip through storage", () => {
    expect(sanitizeEffects(undefined)).toEqual({});
    expect(sanitizeEffects(null)).toEqual({});
    expect(sanitizeEffects("nope")).toEqual({});
    expect(sanitizeEffects({ fog: false, "gone-effect": false, drift: true, settle: "yes" })).toEqual({ fog: false });
  });

  test("a hand-edited prefs blob cannot resurrect a retired effect or enable a blocked one", () => {
    const stored = JSON.stringify({ tier: "minimal", motion: "on", forced: null, effects: { ghost: false, drift: true } });
    const parsed = parseDeckPrefs(stored);
    expect(parsed.effects).toEqual({});
    expect(ambientEnabled("minimal", parsed, false).drift).toBe(false);
  });

  test("a legacy blob with no effect map keeps the registry's defaults", () => {
    const parsed = parseDeckPrefs(JSON.stringify({ tier: "auto", motion: "system", forced: null }));
    expect(parsed.effects).toEqual({});
    expect(ambientEnabled("minimal", parsed, false)).toEqual({ ...AMBIENT_DEFAULT, drift: false });
  });

  test("toggling is pure, and 'on' is the absence of an override", () => {
    const before = prefs({ fog: false });
    const off = toggleEffect(before, "settle", false);
    expect(off.effects).toEqual({ fog: false, settle: false });
    expect(before.effects).toEqual({ fog: false }); // not mutated
    const on = toggleEffect(off, "fog", true);
    expect(on.effects).toEqual({ settle: false });
    expect(on.effects!.fog).toBeUndefined();
  });
});

describe("parameters are bounded functions of the world", () => {
  test("fog: off is a far plane, on is a window past the subject", () => {
    const on = fogPlan(30, true);
    expect(on.near).toBeCloseTo(30 * FOG_NEAR, 6);
    expect(on.far).toBeCloseTo(30 * FOG_FAR, 6);
    expect(on.far).toBeGreaterThan(on.near);
    const off = fogPlan(30, false);
    expect(off.far).toBe(FOG_OFF);
    expect(off.far).toBeGreaterThan(on.far);
    // A degenerate camera must not produce NaN uniforms.
    for (const distance of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = fogPlan(distance, true);
      expect(Number.isFinite(plan.near)).toBe(true);
      expect(Number.isFinite(plan.far)).toBe(true);
      expect(plan.far).toBeGreaterThan(plan.near);
    }
  });

  test("parallax trails the camera, saturates below its bound, and is free when off", () => {
    const centre = { x: 10, z: -4 };
    expect(parallaxOffset({ x: 40, z: 30 }, centre, false)).toEqual({ x: 0, z: 0 });
    const near = parallaxOffset({ x: centre.x + 5, z: centre.z }, centre, true);
    const far = parallaxOffset({ x: centre.x + 400, z: centre.z }, centre, true);
    expect(near.x).toBeLessThan(0); // the floor lags behind the camera
    expect(Math.abs(far.x)).toBeLessThanOrEqual(PARALLAX_MAX);
    expect(Math.abs(far.x)).toBeGreaterThan(Math.abs(near.x)); // monotone in |dx|
    for (const dx of [1e6, -1e6, 0.5]) {
      const offset = parallaxOffset({ x: dx, z: -dx }, centre, true);
      expect(Math.abs(offset.x)).toBeLessThanOrEqual(PARALLAX_MAX);
      expect(Math.abs(offset.z)).toBeLessThanOrEqual(PARALLAX_MAX);
    }
    // Half-amplitude at the softness distance, by construction.
    const half = parallaxOffset({ x: centre.x + 12, z: centre.z }, centre, true);
    expect(half.x).toBeCloseTo(-PARALLAX_MAX / 2, 6);
  });

  test("drift is bounded, off is exactly zero, and it does not repeat on a short cycle", () => {
    expect(driftOffset(1_234, false)).toEqual({ x: 0, z: 0 });
    let maxX = 0;
    let maxZ = 0;
    let previous = driftOffset(0, true);
    let biggestStep = 0;
    for (let t = 0; t <= 60_000; t += 250) {
      const offset = driftOffset(t, true);
      maxX = Math.max(maxX, Math.abs(offset.x));
      maxZ = Math.max(maxZ, Math.abs(offset.z));
      biggestStep = Math.max(biggestStep, Math.abs(offset.x - previous.x), Math.abs(offset.z - previous.z));
      previous = offset;
    }
    expect(maxX).toBeLessThanOrEqual(DRIFT_AMPLITUDE);
    expect(maxZ).toBeLessThanOrEqual(DRIFT_AMPLITUDE);
    // Never a jump: at a quarter-second cadence the framings stay continuous.
    expect(biggestStep).toBeLessThan(0.2);
    // The phase differs after a minute, i.e. it is not a fixed point or a
    // one-second loop masquerading as breathing.
    expect(driftOffset(60_000, true)).not.toEqual(driftOffset(0, true));
    // A non-finite clock reads as the phase's origin: finite, bounded, never NaN
    // in a matrix.
    expect(driftOffset(Number.NaN, true)).toEqual(driftOffset(0, true));
    expect(Number.isFinite(driftOffset(Number.POSITIVE_INFINITY, true).x)).toBe(true);
  });

  test("the settle is inside the roadmap's bound and coalesces", () => {
    expect(SETTLE_MS).toBeLessThanOrEqual(400);
    expect(SETTLE_MS).toBeGreaterThan(0);
    expect(SETTLE_MAX).toBeGreaterThanOrEqual(1);
    expect(SETTLE_LIFT).toBeGreaterThan(0);
  });
});
