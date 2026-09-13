/**
 * The inspection dock (roadmap slice `d06`).
 *
 * This file is the deck's half of the product boundary: the scene answers
 * "*where* is the work and what is happening", the dock answers "show me the
 * exact details". It renders the dashboard's own `Inspector` — same component,
 * same props, same endpoints, same caps — and adds nothing deck-specific but
 * the frame around it. Any re-implementation here would be the duplication the
 * roadmap forbids, and the two surfaces would drift within a slice.
 *
 * It depends on **no renderer, no camera, no scene model**: the spatial layer
 * tells it one thing ("the operator selected this slice") and everything else
 * — log fetching, diff parsing, verification output, review findings, prompt
 * history — stays in the existing 2D views. The dock is therefore usable with
 * the canvas absent (the flat path) and under test without WebGL.
 *
 * Inspection UI state (scroll position, expanded sections, filters, the
 * control form) lives inside those views. The two values the deck shell holds
 * — whether the dock is open and which tab it shows — exist so the keymap can
 * address it (`1`…`8`, `Esc`); neither is part of `DeckModel`, so neither can
 * ask the scene for a frame.
 */

import type { RunEvent, SliceDetail, SliceSummary } from "../api.ts";
import Inspector, { type InspectorTab } from "../components/Inspector.tsx";

export interface DeckInspectorProps {
  runId: string;
  selected: SliceSummary | undefined;
  detail: SliceDetail | Record<string, unknown> | null;
  slices: SliceSummary[];
  events: RunEvent[];
  live: boolean;
  wedged?: boolean;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onControlDone: () => void;
  /** Close the dock (the panel's X). `Esc` closes it from the deck's keys. */
  onClose: () => void;
}

export default function DeckInspector(props: DeckInspectorProps) {
  return (
    <div className="omp-deck-dock-body" data-dock-tab={props.tab}>
      <Inspector
        runId={props.runId}
        selected={props.selected}
        detail={props.detail}
        onControlDone={props.onControlDone}
        onClose={props.onClose}
        slices={props.slices}
        events={props.events}
        live={props.live}
        wedged={props.wedged}
        tab={props.tab}
        onTabChange={props.onTabChange}
      />
    </div>
  );
}
