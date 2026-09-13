/**
 * The inspection dock's state machine (roadmap slice `d06`), tested without a
 * browser.
 *
 * The claims being pinned: `1`…`8` address the inspector's tabs by position
 * and nothing else does; closing remembers the tab while a new subject resets
 * it (the dashboard inspector's own rule); a new run closes the dock outright;
 * and the whole module is pure — transitions that change nothing return the
 * same object, which is what lets the deck call them as reducers without
 * committing a re-render.
 *
 * The link to the *actual* tab list is asserted against `DECK_KEYS`' `1…8`
 * entry, and end to end in `tests/e2e/deck-inspector.e2e.ts` (press `5`, the
 * Prompt panel is the one on screen) — a second tab list here would be the
 * duplication this slice forbids.
 */

import { describe, expect, test } from "bun:test";
import {
  DOCK_CLOSED,
  dockOnNewSelection,
  dockTabForKey,
  hideDock,
  showDockTab,
  type DockState,
} from "../web/src/scene/dock.ts";
import type { InspectorTab } from "../web/src/components/Inspector.tsx";
import { DECK_KEYS } from "../web/src/scene/types.ts";

/** The inspector's tabs, in its order (`INSPECTOR_TABS`), as ids only. */
const TABS: readonly { id: InspectorTab }[] = [
  { id: "Output" },
  { id: "Diff" },
  { id: "Verify" },
  { id: "Review" },
  { id: "Prompt" },
  { id: "Events" },
  { id: "Usage" },
  { id: "Log" },
];

describe("dockTabForKey", () => {
  test("digits address tabs by position, in the inspector's order", () => {
    expect(dockTabForKey("1", TABS)).toBe("Output");
    expect(dockTabForKey("2", TABS)).toBe("Diff");
    expect(dockTabForKey("5", TABS)).toBe("Prompt");
    expect(dockTabForKey("8", TABS)).toBe("Log");
  });

  test("anything outside 1…8 is not a tab", () => {
    expect(dockTabForKey("0", TABS)).toBeNull();
    expect(dockTabForKey("9", TABS)).toBeNull();
    expect(dockTabForKey("12", TABS)).toBeNull();
    expect(dockTabForKey("", TABS)).toBeNull();
    expect(dockTabForKey("a", TABS)).toBeNull();
    expect(dockTabForKey("+", TABS)).toBeNull();
  });

  test("an empty tab list cannot produce a tab", () => {
    expect(dockTabForKey("1", [])).toBeNull();
  });

  test("the keymap's 1…8 row and the tab list agree on the count", () => {
    const row = DECK_KEYS.find((entry) => entry.key === "1…8");
    expect(row).toBeDefined();
    expect(row!.codes).toHaveLength(TABS.length);
    // Every code in the row resolves to a tab, in order — so a ninth tab, or a
    // reorder, fails here rather than silently shifting every key.
    expect(row!.codes.map((code) => dockTabForKey(code, TABS))).toEqual(TABS.map((tab) => tab.id));
  });
});

describe("dock transitions", () => {
  const OPEN_LOG: DockState = { open: true, tab: "Log" };

  test("showDockTab opens on the tab and is idempotent", () => {
    expect(showDockTab(DOCK_CLOSED, "Diff")).toEqual({ open: true, tab: "Diff" });
    // Same open state and tab: the same object, so a reducer-style call
    // commits nothing.
    expect(showDockTab(OPEN_LOG, "Log")).toBe(OPEN_LOG);
  });

  test("closing remembers the tab; closing a closed dock is a no-op", () => {
    expect(hideDock(OPEN_LOG)).toEqual({ open: false, tab: "Log" });
    expect(hideDock(DOCK_CLOSED)).toBe(DOCK_CLOSED);
    // Reopening after a close resumes the remembered tab.
    expect(showDockTab(hideDock(OPEN_LOG), "Log")).toEqual(OPEN_LOG);
  });

  test("a new subject resets to Output, and keeps the dock open", () => {
    expect(dockOnNewSelection(OPEN_LOG)).toEqual({ open: true, tab: "Output" });
    expect(dockOnNewSelection({ open: false, tab: "Log" })).toEqual({ open: false, tab: "Output" });
    // Already on Output: nothing changed, nothing to commit.
    expect(dockOnNewSelection(DOCK_CLOSED)).toBe(DOCK_CLOSED);
  });

  test("transitions never mutate their input", () => {
    const before = { ...OPEN_LOG };
    showDockTab(OPEN_LOG, "Diff");
    hideDock(OPEN_LOG);
    dockOnNewSelection(OPEN_LOG);
    expect(OPEN_LOG).toEqual(before);
  });
});
