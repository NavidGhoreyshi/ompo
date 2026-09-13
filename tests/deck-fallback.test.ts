/**
 * The fallback projection (roadmap slice `d09`), tested without a browser.
 *
 * Three claims, all pure:
 *
 * 1. **Availability is capability plus an explicit choice** — no WebGL2 means
 *    flat, `minimal` is a 3D tier (not a fallback), an explicit flat wins, and
 *    motion never decides any of it.
 * 2. **`flatRows` is the scene's information set as text** — every pad exactly
 *    once, in rail order, carrying status/attempts/generation/stage/alert/live.
 * 3. **The focus mirror is a function of the model**, so an event that changes
 *    no status, stage or count cannot re-announce anything.
 */

import { describe, expect, test } from "bun:test";
import type { AgentRow, RunDetail, RunEvent, SliceSummary } from "../web/src/api.ts";
import {
  DECK_MODES,
  deckAvailability,
  deckMode,
  flatRowLabel,
  flatRows,
  focusMirrorText,
  nextDeckMode,
  type AvailabilityInput,
} from "../web/src/scene/fallback.ts";
import { buildHistoryIndex } from "../web/src/scene/history.ts";
import { buildDeckModel } from "../web/src/scene/model.ts";
import { DECK_KEYS, DEFAULT_DECK_PREFS, type DeckInput } from "../web/src/scene/types.ts";

const AT = "2026-09-13T00:00:00.000Z";

function slice(id: string, status: string, deps: string[] = [], extra: Partial<SliceSummary> = {}): SliceSummary {
  return {
    id,
    title: `Slice ${id}`,
    status,
    attempts: 1,
    updatedAt: AT,
    deps,
    generation: 1,
    verify: [],
    ...extra,
  };
}

const SLICES: SliceSummary[] = [
  slice("a", "done"),
  slice("b", "running", ["a"], { attempts: 2, generation: 3 }),
  slice("c", "pending", ["b"]),
  slice("d", "failed", ["b"], { reason: "worker exited 1" }),
  slice("e", "blocked-env", ["b"]),
  slice("ghost", "pending", ["absent"]),
];

const AGENTS: AgentRow[] = [
  { id: "b", lane: 1, status: "running", attempt: 2, generation: 3, lastLine: "[b] tool edit: web/src/scene/fallback.ts" },
];

function detail(slices: SliceSummary[] = SLICES): RunDetail {
  return {
    runId: "run-1",
    createdAt: AT,
    updatedAt: AT,
    live: true,
    counts: { done: 1, active: 1, failed: 1, skipped: 0, blockedEnv: 1, pending: 2 },
    workers: 1,
    total: slices.length,
    status: "running",
    retries: 0,
    handoffs: 0,
    tokens: null,
    cost: null,
    slices,
  };
}

const EVENTS: RunEvent[] = [
  { seq: 1, at: AT, type: "slice_claimed", sliceId: "b" },
  { seq: 2, at: AT, type: "slice_completed", sliceId: "a" },
];

function input(overrides: Partial<DeckInput> = {}): DeckInput {
  return {
    runId: "run-1",
    detail: detail(),
    events: EVENTS,
    agents: AGENTS,
    selected: "b",
    sliceDetail: null,
    pinnedId: null,
    prefs: DEFAULT_DECK_PREFS,
    live: true,
    dismissed: new Set<string>(),
    maxStations: 8,
    maxBeacons: 32,
    history: null,
    runs: [],
    ...overrides,
  };
}

const availability = (overrides: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
  webgl2: true,
  tier: "standard",
  forced: null,
  reducedMotion: false,
  ...overrides,
});

describe("deckAvailability: capability plus an explicit choice", () => {
  test("no WebGL2 is flat, whatever the tier or the operator asks", () => {
    expect(deckAvailability(availability({ webgl2: false }))).toBe("flat");
    expect(deckAvailability(availability({ webgl2: false, tier: "minimal" }))).toBe("flat");
    expect(deckAvailability(availability({ webgl2: false, forced: "3d" }))).toBe("flat");
  });

  test("minimal is a 3D tier — it is the expected tier on a software rasterizer", () => {
    expect(deckAvailability(availability({ tier: "minimal" }))).toBe("3d");
    expect(deckAvailability(availability({ tier: "high" }))).toBe("3d");
  });

  test("an explicit flat wins over any device; an explicit 3D only where a context exists", () => {
    expect(deckAvailability(availability({ tier: "high", forced: "flat" }))).toBe("flat");
    expect(deckAvailability(availability({ tier: "minimal", forced: "3d" }))).toBe("3d");
  });

  test("motion is not an availability input: reduce never forces the fallback", () => {
    for (const webgl2 of [true, false]) {
      for (const forced of [null, "3d", "flat"] as const) {
        const base = availability({ webgl2, forced });
        expect(deckAvailability({ ...base, reducedMotion: true })).toBe(deckAvailability(base));
      }
    }
  });
});

describe("the T cycle", () => {
  test("walks the tiers, then flat, then back to auto", () => {
    expect(DECK_MODES).toEqual(["auto", "minimal", "standard", "high", "flat"]);
    expect(nextDeckMode("auto")).toBe("minimal");
    expect(nextDeckMode("high")).toBe("flat");
    expect(nextDeckMode("flat")).toBe("auto");
  });

  test("a prefs object is in its forced mode, else its tier", () => {
    expect(deckMode(DEFAULT_DECK_PREFS)).toBe("auto");
    expect(deckMode({ tier: "standard", motion: "system", forced: null })).toBe("standard");
    expect(deckMode({ tier: "standard", motion: "system", forced: "flat" })).toBe("flat");
    expect(deckMode({ tier: "standard", motion: "system", forced: "3d" })).toBe("standard");
  });
});

describe("flatRows: the scene's information set as text", () => {
  const model = buildDeckModel(input());
  const rows = flatRows(model);

  test("every pad exactly once, in rail order", () => {
    expect(rows.map((row) => row.id)).toEqual(model.nodes.map((node) => node.id));
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  test("carries status, glyph, attempts/generation, stage and lane", () => {
    const b = rows.find((row) => row.id === "b")!;
    const node = model.nodes.find((candidate) => candidate.id === "b")!;
    expect(b.status).toBe("running");
    expect(b.glyph).toBe("●");
    expect(b.attempts).toBe(2);
    expect(b.generation).toBe(3);
    expect(b.stage).toBe(node.stage);
    expect(b.stageLabel).toBe(node.stageLabel);
    expect(b.lane).toBe(1);
    expect(b.live).toBe(true);
  });

  test("carries the alert kinds and the structural flags the pads encode", () => {
    expect(rows.find((row) => row.id === "d")!.alert).toBe("failed");
    expect(rows.find((row) => row.id === "e")!.alert).toBe("blocked-env");
    expect(rows.find((row) => row.id === "a")!.alert).toBeNull();
    // An unknown dependency is the ghost pad (`layoutDag`), not the dependent.
    expect(rows.find((row) => row.id === "absent")!.ghost).toBe(true);
  });

  test("marks selection and focus from the model, not from a second rule", () => {
    expect(rows.filter((row) => row.selected).map((row) => row.id)).toEqual(["b"]);
    expect(model.focusId).toBe("b");
    expect(rows.filter((row) => row.focused).map((row) => row.id)).toEqual(["b"]);
  });

  test("the label is a sentence: status, stage, alerts and the live marker in words", () => {
    const b = flatRowLabel(rows.find((row) => row.id === "b")!);
    expect(b).toContain("b — Slice b");
    expect(b).toContain("status running");
    expect(b).toContain("attempt 2");
    expect(b).toContain("generation 3");
    expect(b).toContain("live");
    const d = flatRowLabel(rows.find((row) => row.id === "d")!);
    expect(d).toContain("failed");
  });

  test("an empty model is an empty list", () => {
    expect(flatRows(buildDeckModel(input({ detail: null })))).toEqual([]);
  });
});

describe("focusMirrorText: announced once, never per log line", () => {
  test("names the focused slice, its state and the surrounding counts", () => {
    const model = buildDeckModel(input());
    const text = focusMirrorText(model);
    expect(text).toContain("Focused b");
    expect(text).toContain("running");
    expect(model.alerts).toHaveLength(2);
    expect(text).toContain("2 alerts");
    expect(text).toContain("1 live worker");
  });

  test("changes when the focused slice's status changes, and only then", () => {
    const before = buildDeckModel(input());
    const statusMoved = buildDeckModel(
      input({
        detail: detail([...SLICES.slice(0, 1), slice("b", "verifying", ["a"], { attempts: 2, generation: 3 }), ...SLICES.slice(2)]),
      }),
    );
    expect(focusMirrorText(statusMoved)).not.toBe(focusMirrorText(before));

    // A log line that moves no status, stage, alert or worker count is not an
    // announcement: the same string means React never rewrites the node.
    const logOnly = buildDeckModel(
      input({ events: [...EVENTS, { seq: 3, at: AT, type: "worker_progress", sliceId: "c" }] }),
    );
    expect(focusMirrorText(logOnly)).toBe(focusMirrorText(before));
  });

  test("says when the deck is at a recorded cursor", () => {
    const index = buildHistoryIndex(EVENTS);
    const bucket = index.buckets[index.recorded[0]!]!;
    const past = focusMirrorText(buildDeckModel(input({ history: { index, seq: bucket.lastSeq } })));
    expect(past).toContain(`recorded state at seq ${bucket.lastSeq}`);
    expect(focusMirrorText(buildDeckModel(input()))).not.toContain("recorded state");
  });
});

describe("the keymap is complete enough for the help panel", () => {
  test("every entry has a label, at least one code and an effect", () => {
    for (const entry of DECK_KEYS) {
      expect(entry.key.trim().length).toBeGreaterThan(0);
      expect(entry.codes.length).toBeGreaterThan(0);
      expect(entry.effect.trim().length).toBeGreaterThan(0);
      expect(entry.slice.trim().length).toBeGreaterThan(0);
    }
  });
});
