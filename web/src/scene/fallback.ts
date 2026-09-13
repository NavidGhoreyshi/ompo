/**
 * The deck's fallback and text projection (`d09`) — pure: no DOM, no `three`,
 * no fetching.
 *
 * Two questions, one module: *may this device render the 3D surface*
 * (`deckAvailability` — capability plus the operator's explicit choice; the
 * probe itself belongs to the caller) and *what does the scene say, in text*
 * (`flatRows` — the ordered row list the flat projection renders and the pad
 * mirror announces). The 3D and flat surfaces consume the same `DeckModel`, so
 * the fallback cannot drift from the scene: a divergence is a projection bug
 * caught by tests, not a UI bug discovered by a user.
 */

import { symbolForStatus } from "../lib/status.ts";
import type { QualityTier } from "./tier.ts";
import type { DeckModel, DeckPrefs, RailNode } from "./types.ts";

export type DeckAvailability = "3d" | "flat";

/** The `T` cycle (`d09`): the tiers, then the flat projection, then around. */
export type DeckMode = "auto" | QualityTier | "flat";
export const DECK_MODES: readonly DeckMode[] = ["auto", "minimal", "standard", "high", "flat"];

export function nextDeckMode(current: DeckMode): DeckMode {
  const index = DECK_MODES.indexOf(current);
  return DECK_MODES[(index + 1) % DECK_MODES.length]!;
}

/** The mode a prefs object is in: an explicit flat wins over the tier. */
export function deckMode(prefs: DeckPrefs): DeckMode {
  return prefs.forced === "flat" ? "flat" : prefs.tier;
}

export interface AvailabilityInput {
  /** True when a WebGL2 context can be created at all (the mount probe). */
  webgl2: boolean;
  tier: QualityTier;
  /** The operator's explicit choice; `"3d"` is the retry after a lost context. */
  forced?: "3d" | "flat" | null;
  /**
   * The resolved motion preference. Carried so a caller passes one prefs
   * slice, but it never decides availability: motion changes how the deck
   * moves, not whether the device can draw it (asserted by tests).
   */
  reducedMotion: boolean;
}

/**
 * Which projection the deck may render. `minimal` is a 3D tier, not a
 * fallback — it is the expected tier on the gate machine. A device with no
 * WebGL2 cannot be forced into 3D, so `forced: "3d"` degrades to `"flat"`
 * there.
 */
export function deckAvailability(input: AvailabilityInput): DeckAvailability {
  if (input.forced === "flat") return "flat";
  if (!input.webgl2) return "flat";
  return "3d";
}

/** One pad's information, as the flat projection renders and the mirror reads it. */
export interface FlatRow {
  id: string;
  title: string;
  /** Roadmap status, verbatim. */
  status: string;
  /** The status's text symbol — the non-colour channel, next to the word. */
  glyph: string;
  attempts: number;
  generation: number;
  effort: string | null;
  /** Pipeline stage index (`-1` when none has been observed). */
  stage: number;
  stageLabel: string;
  /** The pad's alert kind (`failed` / `blocked-env`), or `null`. */
  alert: RailNode["alert"];
  live: boolean;
  wedged: boolean;
  selected: boolean;
  focused: boolean;
  ghost: boolean;
  inCycle: boolean;
  lane: number | null;
}

/**
 * Every node of the model, in rail order, exactly once — the scene's own
 * information set as an ordered list: status glyph, id, title,
 * attempt/generation, stage, alert kind, live/stalled marker. No field is
 * derived here that the model did not already decide.
 */
export function flatRows(model: DeckModel): FlatRow[] {
  return model.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    status: node.status,
    glyph: symbolForStatus(node.status),
    attempts: node.attempts,
    generation: node.generation,
    effort: node.effort,
    stage: node.stage,
    stageLabel: node.stageLabel,
    alert: node.alert,
    live: node.live,
    wedged: node.wedged,
    selected: node.selected,
    focused: node.id === model.focusId,
    ghost: node.ghost,
    inCycle: node.inCycle,
    lane: node.lane,
  }));
}

/**
 * A row's full sentence, for the mirror's `aria-label` and the flat table's
 * `title`: everything the pad encodes beyond a colour, in words.
 */
export function flatRowLabel(row: FlatRow): string {
  const parts = [
    `${row.id} — ${row.title}`,
    `status ${row.status}`,
    `attempt ${row.attempts}`,
    `generation ${row.generation}`,
  ];
  if (row.effort) parts.push(row.effort);
  if (row.stageLabel) parts.push(`stage ${row.stageLabel}`);
  if (row.lane !== null) parts.push(`lane ${row.lane}`);
  if (row.alert) parts.push(row.alert);
  if (row.live) parts.push(row.wedged ? "live, stalled" : "live");
  if (row.ghost) parts.push("unknown dependency");
  if (row.inCycle) parts.push("dependency cycle");
  if (row.selected) parts.push("selected");
  return parts.join(" · ");
}

/**
 * The deck's focus state as one polite sentence (`d09`): what is focused, what
 * it is doing, and how many workers and alerts are around it. Its input is the
 * model, so an event that changes no status, stage or count produces the same
 * string — and React therefore never touches the live region's text (`d09`'s
 * "announced once, never per log line").
 */
export function focusMirrorText(model: DeckModel): string {
  const focused = model.focusId === null ? null : (model.nodes.find((node) => node.id === model.focusId) ?? null);
  const alerts = `${model.alerts.length} alert${model.alerts.length === 1 ? "" : "s"}`;
  const live = `${model.liveIds.length} live worker${model.liveIds.length === 1 ? "" : "s"}`;
  if (focused === null) return `No slice focused · ${live} · ${alerts}`;
  const stage = focused.stageLabel === "" ? "" : ` · ${focused.stageLabel}`;
  const tense = model.historySeq === null ? "" : ` · recorded state at seq ${model.historySeq}`;
  return `Focused ${focused.id} · ${focused.status}${stage}${focused.wedged ? " · stalled" : ""}${tense} · ${alerts} · ${live}`;
}
