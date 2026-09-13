/**
 * The deck's DOM layer (roadmap slice `d02`).
 *
 * All text lives in the document (CP-3): the canvas draws geometry, and this
 * file draws the words — the selected (or hovered) slice's status line, and the
 * pad list that gives the scene its keyboard and assistive-technology path.
 *
 * It derives nothing: the line reads `DeckModel` fields plus the app's existing
 * `heroAction` and `liveSliceEvent` helpers — the same rules the dashboard's
 * run header uses, so the two surfaces cannot disagree about what a slice is
 * doing. No fetching, no state: props in, DOM out.
 */

import type { AgentRow, RunEvent } from "../api.ts";
import StatusBadge from "../components/StatusBadge.tsx";
import { liveSliceEvent } from "../lib/events.ts";
import { heroAction } from "../lib/selection.ts";
import type { DeckModel, RailNode } from "./types.ts";

/**
 * Pads listed in the DOM mirror. Past this the list states the remainder in
 * words — a long run is never silently truncated (`d09` builds the full
 * virtualised list on top of this contract).
 */
export const MIRROR_LIMIT = 200;

/** The mirror's rows and the count it does not list (never silent). */
export function mirrorRows(nodes: RailNode[]): { listed: RailNode[]; hidden: number } {
  return { listed: nodes.slice(0, MIRROR_LIMIT), hidden: Math.max(0, nodes.length - MIRROR_LIMIT) };
}

function mirrorLabel(node: RailNode): string {
  const parts = [`${node.id} — ${node.title}`, `status ${node.status}`, `attempt ${node.attempts}`, `generation ${node.generation}`];
  if (node.effort) parts.push(node.effort);
  if (node.ghost) parts.push("unknown dependency");
  if (node.inCycle) parts.push("dependency cycle");
  if (node.alert) parts.push(node.alert);
  return parts.join(" · ");
}

export default function DeckOverlay({
  model,
  hoverId,
  agents,
  events,
  onSelect,
}: {
  model: DeckModel;
  /** Pad under the pointer, if any — previewed without changing selection. */
  hoverId: string | null;
  agents: AgentRow[];
  events: RunEvent[];
  onSelect: (sliceId: string) => void;
}) {
  const selected = model.nodes.find((node) => node.selected) ?? null;
  const hovered = hoverId === null ? null : (model.nodes.find((node) => node.id === hoverId) ?? null);
  const shown = hovered ?? selected;
  const { listed: mirror, hidden } = mirrorRows(model.nodes);
  const agent = shown ? agents.find((row) => row.id === shown.id) : undefined;
  const action = shown
    ? heroAction({
        status: shown.status,
        lastLine: agent?.lastLine,
        lastEvent: liveSliceEvent(shown.status, events, shown.id),
        reason: shown.reason,
        deps: shown.deps,
      })
    : null;

  if (model.nodes.length === 0) {
    return (
      <div className="omp-deck-overlay">
        <p className="omp-deck-empty" role="status">
          {model.loading ? `loading run ${model.runId ?? ""}…` : "no slices in this run"}
        </p>
      </div>
    );
  }

  return (
    <div className="omp-deck-overlay">
      <p className="omp-deck-line" data-kind={hovered ? "hover" : "selected"}>
        <span className="omp-deck-line-hint">{hovered ? "hover" : "selected"}</span>
        {shown ? (
          <>
            <StatusBadge status={shown.status} />
            <code className="omp-deck-line-id">{shown.id}</code>
            <span className="omp-deck-line-title" title={shown.title}>
              {shown.title}
            </span>
            <span className="omp-deck-line-meta">
              gen {shown.generation} · attempt {shown.attempts}
              {shown.effort ? ` · ${shown.effort}` : ""}
            </span>
            {action && (
              <span className="omp-deck-line-action" title={action}>
                {action}
              </span>
            )}
          </>
        ) : (
          <span className="omp-deck-line-meta">nothing selected</span>
        )}
      </p>

      {/* The accessibility backbone: every pad is a real button, in roadmap
          order. Visually hidden until focused so it never competes with the
          scene, present in the tab order from the first frame. */}
      <ul className="omp-deck-mirror" aria-label="Roadmap pads">
        {mirror.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              aria-current={node.selected ? "true" : undefined}
              aria-label={mirrorLabel(node)}
              onClick={() => onSelect(node.id)}
            >
              <span className="omp-deck-mirror-id">{node.id}</span>
              <span className="omp-deck-mirror-status">{node.status}</span>
              <span className="omp-deck-mirror-title">{node.title}</span>
            </button>
          </li>
        ))}
        {hidden > 0 && <li className="omp-deck-mirror-more">{hidden} more slices not listed</li>}
      </ul>
    </div>
  );
}
