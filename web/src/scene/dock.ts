/**
 * The inspection dock's state machine (roadmap slice `d06`) — pure.
 *
 * The dock is where the deck stops answering "where is the work" and starts
 * answering "show me the exact details": the scene selects and orients, the 2D
 * layer inspects (roadmap §13). Everything here is view state — like the pin
 * and the freeze — so none of it may enter `DeckModel`: an open dock and an
 * active tab change nothing the scene draws, and the digest assertion in
 * `tests/e2e/deck-inspector.e2e.ts` is what keeps that true.
 *
 * Three rules the rest of the deck reads from here:
 *
 *  - `1`…`8` address the inspector's tabs **by position** in the list
 *    `Inspector.tsx` itself renders, so a ninth tab without a key, or a
 *    reorder, shows up in one place (`dockTabForKey` + its unit test).
 *  - closing remembers the tab; a **new subject** (another selection) starts on
 *    `Output`, which is the dashboard inspector's own rule — the two surfaces
 *    must not disagree about what a fresh selection shows.
 *  - a **new run** closes the dock entirely: the selection belonged to the run
 *    that is gone, and a dock describing a stale slice is worse than no dock.
 *
 * Pure module: no React, no DOM, no fetching.
 */

import type { InspectorTab } from "../components/Inspector.tsx";

export interface DockState {
  /** Whether the 2D inspection surface is on screen. */
  open: boolean;
  /** The tab it shows; kept across a close, reset only by a new subject/run. */
  tab: InspectorTab;
}

/** Closed, on the dashboard's default tab. */
export const DOCK_CLOSED: DockState = { open: false, tab: "Output" };

/**
 * The tab a digit key addresses: `tabs[0]` for `"1"`, `tabs[7]` for `"8"`.
 * Anything that is not a single digit inside the list's range is `null` — the
 * caller keeps its current state rather than guessing a tab.
 */
export function dockTabForKey(key: string, tabs: readonly { id: InspectorTab }[]): InspectorTab | null {
  if (key.length !== 1) return null;
  const index = key.charCodeAt(0) - 49; // "1" → 0
  if (index < 0 || index >= tabs.length) return null;
  return tabs[index]?.id ?? null;
}

/** Open the dock on `tab` (the `1`…`8` keys, the Inspect affordances, alerts). */
export function showDockTab(state: DockState, tab: InspectorTab): DockState {
  return state.open && state.tab === tab ? state : { open: true, tab };
}

/** Close it; the tab is remembered for the next open of the same run. */
export function hideDock(state: DockState): DockState {
  return state.open ? { ...state, open: false } : state;
}

/**
 * The selection moved: the dock now inspects another slice, so it starts where
 * the dashboard's inspector starts a new subject (`Output`). A closed dock is
 * untouched — this is the transition, not a reset of everything.
 */
export function dockOnNewSelection(state: DockState): DockState {
  return state.tab === "Output" ? state : { open: state.open, tab: "Output" };
}
