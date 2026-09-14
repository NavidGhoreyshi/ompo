/**
 * Semantic ambient summaries (`ux04`) — pure: no DOM, no `three`, no clock.
 *
 * The rule (correction §5): ambient UI says *what kind of thing happened* in
 * `id · kind-word` form; forensics (paths, exits, tails, counts) live one hop
 * away in `title=` and the Inspector. Never a mid-string fragment of a long
 * diagnostic as the visible text.
 */

import { truncateDetail } from "../lib/events.ts";
import { symbolForStatus } from "../lib/status.ts";
import type { DeckAlert } from "./alerts.ts";

/** Visible alert text: `slice · kind-word`, never a raw tail fragment. */
export function alertSummary(alert: DeckAlert): string {
  const kindWord: Record<DeckAlert["kind"], string> = {
    failed: "failed",
    "blocked-env": "blocked",
    wedged: "stalled",
    "double-loop": "double loop",
    "verify-failed": "gate failed",
    "review-rejected": "review rejected",
    "control-rejected": "control rejected",
    "verdict-stall": "gates idle",
  };
  const where = alert.sliceId ?? "run";
  return `${where} · ${kindWord[alert.kind]}`;
}

/** Basename of a path: the last `/`-segment, unchanged when there is none. */
export function basenameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : (path.slice(index + 1) ?? path);
}

/**
 * One-line lane tail for the collapsed strip: the hero action reduced to a
 * semantic head. A leading `path:` token keeps its basename; over-long text
 * truncates at a word-friendly 80 chars with the full string in `title=`.
 */
export function laneSummary(action: string): string {
  const head = action.trim().split(/\s+/).slice(0, 8).join(" ");
  return truncateDetail(head, 80);
}

/** Live-window head: `id · status glyph + stage`, the window's own subject. */
export function liveHead(id: string, status: string, stageLabel: string): string {
  const stage = stageLabel.trim().split(/\s+/)[0] ?? "";
  const glyph = symbolForStatus(status);
  return stage === "" ? `${glyph} ${id}` : `${glyph} ${id} · ${stage}`;
}
