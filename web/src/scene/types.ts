/**
 * Deck contracts (roadmap slice `d01`).
 *
 * Types and the small constants the shell and the deck must agree on. The
 * deck is a projection of state the dashboard already holds: it receives
 * props and returns intents, and it never fetches (CP-4 in
 * `docs/desktop-3d-roadmap.md`).
 */

import type { AgentRow, RunDetail, RunEvent, SliceDetail } from "../api.ts";
import type { QualityTier } from "./tier.ts";

export type { QualityTier } from "./tier.ts";

/** Client-side deck preferences. View state only — never domain state. */
export interface DeckPrefs {
  /** `"auto"` classifies from the WebGL renderer string; a tier pins it. */
  tier: "auto" | QualityTier;
  /** Deck-level override; the OS preference is honoured regardless. */
  reducedMotion: boolean;
}

export const DECK_PREFS_KEY = "ompo.deck.prefs";

export const DEFAULT_DECK_PREFS: DeckPrefs = { tier: "auto", reducedMotion: false };

const TIERS: QualityTier[] = ["minimal", "standard", "high"];

/**
 * Parsed at the storage boundary: unreadable or malformed preferences degrade
 * to the defaults rather than throwing (private mode, cleared storage, a
 * hand-edited value).
 */
export function parseDeckPrefs(raw: string | null): DeckPrefs {
  if (!raw) return DEFAULT_DECK_PREFS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_DECK_PREFS;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_DECK_PREFS;
  const tierValue = "tier" in value ? value.tier : undefined;
  const motionValue = "reducedMotion" in value ? value.reducedMotion : undefined;
  const tier = tierValue === "auto" || (typeof tierValue === "string" && TIERS.includes(tierValue as QualityTier))
    ? (tierValue as DeckPrefs["tier"])
    : DEFAULT_DECK_PREFS.tier;
  return { tier, reducedMotion: motionValue === true };
}

/** Orbital camera state (roadmap §D.4). Excluded from the scene model. */
export interface DeckCamera {
  target: { x: number; y: number; z: number };
  distance: number;
  azimuth: number;
  elevation: number;
}

/** `rail`: elevated three-quarter view of the whole roadmap (`d01` default). */
export const DEFAULT_CAMERA: DeckCamera = {
  target: { x: 0, y: 0, z: 0 },
  distance: 32,
  azimuth: Math.PI / 4,
  elevation: 0.62,
};

/**
 * Scene contents. `d01` renders an empty world (a floor grid and nothing
 * else); `d02` builds the real model from the DTOs and this is the only
 * thing the renderer ever receives.
 */
export interface DeckModel {
  /** Monotonic revision; a change is what makes the renderer re-apply. */
  revision: number;
}

/** Props the shell hands the deck. Fetching stays in `App.tsx`. */
export interface DeckProps {
  runId: string | null;
  detail: RunDetail | null;
  events: RunEvent[];
  agents: AgentRow[];
  selected: string | null;
  sliceDetail: SliceDetail | Record<string, unknown> | null;
  live: boolean;
  /** Switch back to the dashboard surface (the `D` key and the HUD button). */
  onExit: () => void;
}

/**
 * Counters the renderer maintains (roadmap slice `d01`). One object, mutated in
 * place per frame — the per-frame path allocates nothing, so copy it if you
 * keep it.
 */
export interface RenderStats {
  /** Draw calls issued by the last `render()`. */
  drawCalls: number;
  triangles: number;
  /** Line segments (the floor grid) — lines, not triangles, are the `d01` world. */
  lines: number;
  /** Top-level scene nodes. */
  objects: number;
  programs: number;
  textures: number;
  geometries: number;
  /** Vertices in the scene's code-generated geometry (exact, captured at build). */
  vertices: number;
  /** Backing-store pixels at the current size (`css × tier.resolutionScale`). */
  pixels: number;
  /** Passes that shade every pixel of the viewport. `d01` issues none. */
  fullScreenLayers: number;
  /** Upper bound of pixels covered by 1 px lines, recomputed on resize. */
  linePixels: number;
  /** `pixels × fullScreenLayers + linePixels`. */
  shadedPixels: number;
  /** Frames per second actually rendered, refreshed on read (`info()`). */
  fps: number;
}

/** One row of the §D.5 keymap. The HUD and the tests read this table. */
export interface DeckKey {
  /** Display label, e.g. `T` or `[ / ]`. */
  key: string;
  /** `KeyboardEvent.key` values that trigger it. */
  codes: string[];
  effect: string;
  /** Slice that implements it; the HUD dims the ones that are not live yet. */
  slice: string;
}

export const DECK_KEYS: DeckKey[] = [
  { key: "T", codes: ["t"], effect: "Cycle quality tier (auto → minimal → standard → high)", slice: "d01" },
  { key: "H / ?", codes: ["h", "?"], effect: "Keymap and budget HUD", slice: "d01" },
  { key: "D", codes: ["d"], effect: "Switch to the dashboard surface", slice: "d01" },
  { key: "F", codes: ["f"], effect: "Frame the selection (pin)", slice: "d03" },
  { key: "Esc", codes: ["Escape"], effect: "Release the pin, then close the dock", slice: "d03" },
  { key: "Space", codes: [" "], effect: "Freeze / resume the live window", slice: "d03" },
  { key: "E", codes: ["e"], effect: "Expand the live window to the raw transcript", slice: "d03" },
  { key: "C", codes: ["c"], effect: "Cycle camera preset (command → rail → topology)", slice: "d03" },
  { key: "0", codes: ["0"], effect: "Reset the camera to the preset default", slice: "d03" },
  { key: "[ / ]", codes: ["[", "]"], effect: "Previous / next live worker", slice: "d04" },
  { key: "1…8", codes: ["1", "2", "3", "4", "5", "6", "7", "8"], effect: "Open the dock on inspector tab N", slice: "d06" },
  { key: "M", codes: ["m"], effect: "Toggle reduced motion", slice: "d09" },
];

/** The debug hook the e2e suite and `d10` assert against. Not public API. */
export interface DeckDebugHook {
  tier: QualityTier;
  tierSource: "auto" | "pinned";
  /** Mounts and unmounts across the page's lifetime, so leaks are visible. */
  mounted: number;
  disposed: number;
  /** Frame counter, written in place per frame (no allocation). */
  frames: number;
  drawCalls: number;
  objects: number;
  triangles: number;
  vertices: number;
  pixels: number;
  instrument: unknown;
}
