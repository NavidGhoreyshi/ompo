/**
 * Station slots (roadmap slice `d04`), tested without a browser.
 *
 * The claims being pinned: the live set maps to pool entries deterministically;
 * a worker's slot does not move while the live set does not move (a station's
 * *coordinate* comes from the roadmap, so a slot is bookkeeping, never a
 * position); a malformed report is repaired and reported instead of silently
 * overlapping two workers on one mesh; and the pool's cap turns into a count
 * and a list, never into a worker that vanishes.
 */

import { describe, expect, test } from "bun:test";
import { overflowCount, stationCountLabel, stationSlots, type StationNode } from "../web/src/scene/lanes.ts";

const nodes = (...pairs: [string, number | null][]): StationNode[] => pairs.map(([id, lane]) => ({ id, lane }));

describe("stationSlots: the pool", () => {
  test("one slot per live worker, in lane order, ties in board order", () => {
    const layout = stationSlots(nodes(["a", 0], ["b", 1], ["c", 2]), ["a", "b", "c"], 8);
    expect(layout.stations).toEqual([
      { id: "a", slot: 0, stack: 0 },
      { id: "b", slot: 1, stack: 0 },
      { id: "c", slot: 2, stack: 0 },
    ]);
    expect(layout.pooled).toBe(3);
    expect(layout.overflow).toBe(0);
    expect(layout.warnings).toEqual([]);
  });

  test("lane order wins over board order; a missing lane sorts last and takes a free slot", () => {
    // A re-indexed report: `b` is lane 0 even though `a` leads the roadmap.
    expect(stationSlots(nodes(["a", 5], ["b", 0]), ["a", "b"], 8).stations.map((s) => s.id)).toEqual(["b", "a"]);
    // `/agents` has not reported `a` yet: it still gets a slot, after `b`.
    const late = stationSlots(nodes(["a", null], ["b", 3]), ["a", "b"], 8);
    expect(late.stations.map((s) => s.id)).toEqual(["b", "a"]);
    expect(late.stations.every((s) => s.stack === 0)).toBe(true);
    expect(late.warnings).toEqual([]);
  });

  test("deterministic, and never two workers on one slot", () => {
    const args = [nodes(["a", 1], ["b", 1], ["c", 2], ["d", 0]), ["a", "b", "c", "d"], 4] as const;
    const first = stationSlots(...args);
    expect(stationSlots(...args)).toEqual(first);
    expect(new Set(first.stations.map((s) => s.slot)).size).toBe(4);
    expect(first.stations.map((s) => s.id)).toEqual(["d", "a", "b", "c"]);
    // `a` keeps slot 1; `b` (same lane) is walked to the next free entry, and
    // the cascade is reported rather than silently folded into one mesh.
    expect(first.stations.find((s) => s.id === "b")?.slot).toBe(2);
    expect(first.stations.find((s) => s.id === "c")?.slot).toBe(3);
    expect(first.warnings).toEqual([
      "b: slot 1 already taken — placed at slot 2",
      "c: slot 2 already taken — placed at slot 3",
    ]);
  });

  test("a lane past the pool is clamped, and the clamp is reported", () => {
    const layout = stationSlots(nodes(["a", 0], ["b", 9]), ["a", "b"], 2);
    expect(layout.stations).toEqual([
      { id: "a", slot: 0, stack: 0 },
      { id: "b", slot: 1, stack: 0 },
    ]);
    expect(layout.warnings).toEqual(["b: lane 9 clamped to slot 1"]);
  });

  test("workers past the cap overflow in order, instead of overwriting a slot", () => {
    const layout = stationSlots(nodes(["a", 0], ["b", 1], ["c", 2], ["d", 3], ["e", 4]), ["a", "b", "c", "d", "e"], 2);
    expect(layout.stations).toEqual([
      { id: "a", slot: 0, stack: 0 },
      { id: "b", slot: 1, stack: 0 },
      { id: "c", slot: 1, stack: 1 },
      { id: "d", slot: 1, stack: 2 },
      { id: "e", slot: 1, stack: 3 },
    ]);
    expect(layout.pooled).toBe(2);
    expect(layout.overflow).toBe(3);
    // Overflow is the tier's cap, not a malformed input: the HUD counts it and
    // the lane list marks it, so no repair warning is owed.
    expect(layout.warnings).toEqual([]);
  });

  test("a zero-station pool is legal: everyone overflows", () => {
    const layout = stationSlots(nodes(["a", 0], ["b", 1]), ["a", "b"], 0);
    expect(layout.pooled).toBe(0);
    expect(layout.overflow).toBe(2);
    expect(layout.stations.map((s) => s.stack)).toEqual([1, 2]);
  });

  test("a duplicated live id is placed once, and said out loud", () => {
    const layout = stationSlots(nodes(["a", 0]), ["a", "a"], 8);
    expect(layout.stations).toEqual([{ id: "a", slot: 0, stack: 0 }]);
    expect(layout.pooled).toBe(1);
    expect(layout.warnings).toEqual(["a: listed twice in the live set — placed once"]);
  });

  test("no live workers, no stations", () => {
    expect(stationSlots(nodes(), [], 8)).toEqual({ stations: [], pooled: 0, overflow: 0, warnings: [] });
  });
});

describe("the overflow count and the HUD phrase", () => {
  test("overflow is live minus the cap, never negative", () => {
    expect(overflowCount(["a", "b", "c"], 8)).toBe(0);
    expect(overflowCount(["a", "b", "c"], 2)).toBe(1);
    expect(overflowCount(["a", "b", "c"], 0)).toBe(3);
    expect(overflowCount([], 0)).toBe(0);
  });

  test("the phrase only mentions stations when the tier is what is hiding one", () => {
    expect(stationCountLabel(3, 3)).toBe("live: 3");
    expect(stationCountLabel(3, 0)).toBe("live: 3 · stations 0");
    expect(stationCountLabel(9, 8)).toBe("live: 9 · stations 8");
  });
});
