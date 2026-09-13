/**
 * The deck's DOM layer (roadmap slices `d02`–`d03`).
 *
 * All text lives in the document (CP-3): the canvas draws geometry, and this
 * file draws the words — the selected (or hovered) slice's status line, the
 * focused worker's station line and lane strip, the bounded live window, and
 * the pad list that gives the scene its keyboard and assistive-technology path.
 *
 * It derives nothing: every line reads `DeckModel` fields plus the app's
 * existing helpers (`heroAction`, `liveSliceEvent`) and the dashboard's own
 * `LiveFeed` component — the same rules and the same window the dashboard uses,
 * so the two surfaces cannot disagree about what a slice is doing. No
 * fetching, no state of its own: props in, DOM out.
 */

import type { AgentRow, RunEvent, SliceSummary } from "../api.ts";
import StatusBadge from "../components/StatusBadge.tsx";
import LiveFeed from "../components/LiveFeed.tsx";
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
  focusSlice,
  frozen,
  expanded,
  onFrozenChange,
  onExpandedChange,
  onFocus,
  onSelect,
}: {
  model: DeckModel;
  /** Pad under the pointer, if any — previewed without changing selection. */
  hoverId: string | null;
  agents: AgentRow[];
  events: RunEvent[];
  /**
   * The focused worker's own DTO (the shell's `detail.slices` entry). The live
   * window takes a real `SliceSummary`, never a re-shaped model node.
   */
  focusSlice: SliceSummary | null;
  frozen: boolean;
  expanded: boolean;
  onFrozenChange: (frozen: boolean) => void;
  onExpandedChange: (expanded: boolean) => void;
  /** Focus a worker: pin it, select it, frame it (the lane strip's action). */
  onFocus: (sliceId: string) => void;
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

  // The live workers, in board order (`liveIds` is that order; the nodes carry
  // the per-worker facts). The focused one is the operator's handle on "which
  // worker is the deck pointing at".
  const liveNodes = model.nodes.filter((node) => node.live);
  const focused = model.focusId === null ? null : (model.nodes.find((node) => node.id === model.focusId) ?? null);
  const focusAgent = focused === null ? undefined : agents.find((row) => row.id === focused.id);

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

      {/* The station line: what the scene is pointed at, in words. It answers
          "who is the primary" without reading the 3D scene, and stays true
          when there is no live worker at all. */}
      <p className="omp-deck-station" data-live={focused?.live === true ? "true" : "false"}>
        <span className="omp-deck-station-tag">{focused?.live === true ? "focused" : "quiescent run"}</span>
        {focused ? (
          <>
            <StatusBadge status={focused.status} />
            <code className="omp-deck-station-id">{focused.id}</code>
            <span className="omp-deck-station-meta">
              gen {focused.generation} · attempt {focused.attempts}
              {focused.stageLabel ? ` · ${focused.stageLabel}` : ""}
            </span>
            <span className="omp-deck-station-meta">
              {liveNodes.length === 0 ? "no worker running" : `live: ${liveNodes.length}`}
            </span>
          </>
        ) : (
          <span className="omp-deck-station-meta">showing nothing</span>
        )}
      </p>

      {liveNodes.length > 0 && (
        <ul className="omp-deck-lanes" aria-label="Live workers">
          {liveNodes.map((node) => {
            const laneAgent = agents.find((row) => row.id === node.id);
            const isFocused = node.id === model.focusId;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  className="omp-deck-lane"
                  data-focused={isFocused ? "true" : "false"}
                  aria-current={isFocused ? "true" : undefined}
                  onClick={() => onFocus(node.id)}
                >
                  <span className="omp-deck-lane-id">{node.id}</span>
                  <span className="omp-deck-lane-status">{node.status}</span>
                  {node.stageLabel && <span className="omp-deck-lane-stage">{node.stageLabel}</span>}
                  <span className="omp-deck-lane-meta">
                    L{laneAgent?.lane ?? "—"} · gen {node.generation} · a{node.attempts}
                  </span>
                  {laneAgent?.wedged === true && <span className="omp-deck-lane-warn">stalled</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* The live window: the dashboard's own component, driven but never
          forked. Freeze and expand are the deck's view state, so the keyboard
          can own them (Space / E) without reaching into the window. */}
      <div className="omp-deck-live">
        <LiveFeed
          runId={model.runId}
          slice={focusSlice}
          agent={focusAgent}
          events={events}
          frozen={frozen}
          onFrozenChange={onFrozenChange}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
        />
      </div>

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
