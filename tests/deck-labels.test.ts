/**
 * Projected spatial labels (`ux01`), tested without a browser.
 *
 * Three claims, all pure:
 *
 * 1. **Labels are identity, not cards** — `id · Stage` plus glyphs, from
 *    fields the model already decided (no second derivation).
 * 2. **Priority is focus/primary → live → alerted**, pooled stations only.
 * 3. **The density cap never drops focus/primary** and states the remainder.
 */

import { describe, expect, test } from "bun:test";
import { alertGlyphFor, capLabels, labelIds, labelStage, spatialLabelFor } from "../web/src/scene/labels.ts";
import type { DeckModel } from "../web/src/scene/types.ts";

function station(id: string, extra: Record<string, unknown> = {}) {
  return { id, slot: 0, stack: 0, stage: 2, wedged: false, lane: 0, primary: false, focused: false, ...extra };
}

function model(): Pick<DeckModel, "focusId" | "primaryId" | "liveIds" | "stations" | "beaconAlerts"> {
  return {
    focusId: "b",
    primaryId: "b",
    liveIds: ["b", "c"],
    stations: [station("b", { focused: true, primary: true }), station("c"), station("d", { stack: 1 })],
    beaconAlerts: [{ kind: "failed", severity: "high", sliceId: "d", message: "failed", lastSeq: 9 }],
  };
}

describe("ux01 spatial labels", () => {
  test("stage shortens to one word: Generation → Gen, empty stays empty", () => {
    expect(labelStage({ stageLabel: "Generation" })).toBe("Gen");
    expect(labelStage({ stageLabel: "Work" })).toBe("Work");
    expect(labelStage({ stageLabel: "" })).toBe("");
  });

  test("label text is id plus stage, never diagnostics", () => {
    const label = spatialLabelFor({ id: "b", status: "running", stageLabel: "Work", wedged: false }, { focused: true, primary: true }, null);
    expect(label.text).toBe("b · Work");
    expect(label.text).not.toContain("worker-");
    expect(label.glyph).toBe("●");
    expect(label.text.length).toBeLessThan(40);
  });

  test("label order is focus/primary, then live, then alerted; overflow stays out", () => {
    // d is beaconed but pooled-out (stack 1): no label, lane row only.
    expect(labelIds(model())).toEqual(["b", "c"]);
  });

  test("alerted non-live pooled pads earn a label after live workers", () => {
    const m = model();
    m.stations = [...m.stations.slice(0, 2), station("e")];
    m.beaconAlerts = [...m.beaconAlerts, { kind: "blocked-env", severity: "high", sliceId: "e", message: "blocked", lastSeq: 10 }];
    expect(labelIds(m)).toEqual(["b", "c", "e"]);
    expect(alertGlyphFor("e", m.beaconAlerts)).toBe("!!");
    expect(alertGlyphFor("c", m.beaconAlerts)).toBeNull();
  });

  test("the cap states the remainder and never drops focus/primary", () => {
    const ids = ["b", "c", "d", "e", "f"];
    const { shown, hidden } = capLabels(ids, "b", "b", 2);
    expect(shown).toEqual(["b", "c"]);
    expect(hidden).toBe(3);
  });
});
