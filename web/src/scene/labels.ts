/**
 * Projected spatial labels (`ux01`) — pure: no DOM, no `three`, no clock.
 *
 * Identity for the scene's pooled stations, without replicating the lane
 * strip: `id · stage` plus a glyph that survives greyscale. Everything here
 * reads `RailNode`/`DeckStation`/`DeckAlert` fields the model already decided
 * (M1: no second derivation) — this file only decides which of those values
 * a label may show, and joins them into display strings.
 *
 * Hierarchy (correction §2): always label the focus/primary worker; normally
 * label other live workers; conditionally label alerted workers. Crowding is
 * solved by suppressing labels (off-screen, occluded, too small, over the
 * density cap) — never by shrinking text.
 */

import { symbolForStatus } from "../lib/status.ts";
import { SEVERITY_GLYPH } from "./alerts.ts";
import type { DeckModel, DeckStation, RailNode } from "./types.ts";

/**
 * The stage word a label may show: the model's own `stageLabel`, shortened to
 * its first word ("Generation" → "Gen"). Empty when the model has none — a
 * label never invents a phase.
 */
export function labelStage(node: Pick<RailNode, "stageLabel">): string {
  const word = node.stageLabel.trim().split(/\s+/)[0] ?? "";
  if (word === "") return "";
  return word === "Generation" ? "Gen" : word;
}

/** One label's display content: identity + status, never diagnostics. */
export interface SpatialLabel {
  id: string;
  /** `alpha · Work` — the ambient string, glyph included. */
  text: string;
  /** Status glyph (non-colour channel, from `lib/status.ts`). */
  glyph: string;
  /** Short stage word, or `""` when the model reports none. */
  stage: string;
  /** Alert glyph (`!!`/`!`/`i`), or `null` when no beacon covers this pad. */
  alertGlyph: string | null;
  focused: boolean;
  primary: boolean;
  wedged: boolean;
}

/**
 * Render one node's ambient label: `id · Stage`, glyph + alert glyph carried
 * as data (the DOM decides how to draw them). No logs, paths, reasons,
 * controls, tables, or review content — the Inspector owns those.
 */
export function spatialLabelFor(
  node: Pick<RailNode, "id" | "status" | "stageLabel" | "wedged">,
  station: Pick<DeckStation, "focused" | "primary">,
  alertGlyph: string | null,
): SpatialLabel {
  const stage = labelStage(node);
  return {
    id: node.id,
    text: stage === "" ? node.id : `${node.id} · ${stage}`,
    glyph: symbolForStatus(node.status),
    stage,
    alertGlyph,
    focused: station.focused,
    primary: station.primary,
    wedged: node.wedged,
  };
}

/**
 * Which ids earn a label, in priority order: focus/primary first, then live
 * workers in station order, then beaconed non-live pads. Pooled (drawn)
 * stations only — overflow workers keep their lane row, never a label.
 * Pure over the model + the tier's station cap; the DOM applies projection
 * (off-screen) and legibility (size/occlusion) suppression on top.
 */
export function labelIds(model: Pick<DeckModel, "focusId" | "primaryId" | "liveIds" | "stations" | "beaconAlerts">): string[] {
  const pooled = new Set(model.stations.filter((station) => station.stack === 0).map((station) => station.id));
  const ordered: string[] = [];
  const seen = new Set<string>();
  const take = (id: string | null): void => {
    if (id === null || seen.has(id) || !pooled.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };
  take(model.focusId);
  take(model.primaryId);
  for (const id of model.liveIds) take(id);
  for (const alert of model.beaconAlerts) {
    if (alert.sliceId !== null) take(alert.sliceId);
  }
  return ordered;
}

/**
 * Cap the label set for human parsing (correction §2): past `cap` the
 * remainder is stated, never silently dropped. Focus + primary are never
 * capped away — they are the operator's handle on the scene.
 */
export function capLabels(
  ids: readonly string[],
  focusId: string | null,
  primaryId: string | null,
  cap: number,
): { shown: string[]; hidden: number } {
  if (ids.length <= cap) return { shown: [...ids], hidden: 0 };
  const protectedIds = new Set([focusId, primaryId].filter((id): id is string => id !== null));
  const kept: string[] = [];
  const rest: string[] = [];
  for (const id of ids) {
    if (kept.length < cap || protectedIds.has(id)) kept.push(id);
    else rest.push(id);
  }
  if (kept.length <= cap) return { shown: kept, hidden: rest.length };
  const overflow = kept.length - cap;
  return { shown: kept.slice(0, cap), hidden: rest.length + overflow };
}

/** The alert glyph for one pad: the severest beacon covering it, or `null`. */
export function alertGlyphFor(
  sliceId: string,
  beaconAlerts: Pick<DeckModel, "beaconAlerts">["beaconAlerts"],
): string | null {
  for (const alert of beaconAlerts) {
    if (alert.sliceId === sliceId) return SEVERITY_GLYPH[alert.severity];
  }
  return null;
}
