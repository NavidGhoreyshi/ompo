/**
 * The deck's DOM layer (roadmap slices `d02`–`d04`, dock affordances `d06`).
 *
 * All text lives in the document (CP-3): the canvas draws geometry, and this
 * file draws the words — the selected (or hovered) slice's status line, the
 * focused worker's station line, the lane list of every live worker (with its
 * action line), the off-screen markers, the bounded live window, and the pad
 * list that gives the scene its keyboard and assistive-technology path. From
 * `d06` it also offers the way into the 2D inspection dock ("Inspect" on the
 * selected line and on the focused lane row) — and nothing else: the dock
 * itself, and every question it answers, lives outside the scene.
 *
 * It derives nothing: every line reads `DeckModel` fields plus the app's
 * existing helpers (`heroAction`, `liveSliceEvent`) and the dashboard's own
 * `LiveFeed` component — the same rules and the same window the dashboard uses,
 * so the two surfaces cannot disagree about what a slice is doing. No
 * fetching, no state of its own: props in, DOM out.
 *
 * Layout: the panels are absolutely positioned in the deck's corners. Two
 * wrappers (`.omp-deck-top`: station line + lane strip; `.omp-deck-bottom`:
 * selected line + live window + alert column) are `display: contents` unless
 * the dock is open, when they become the bands of the column it leaves free.
 */

import type { AgentRow, RunEvent, SliceSummary } from "../api.ts";
import StatusBadge from "../components/StatusBadge.tsx";
import LiveFeed from "../components/LiveFeed.tsx";
import { liveSliceEvent } from "../lib/events.ts";
import { heroAction } from "../lib/selection.ts";
import type { AlertSeverity, DeckAlert } from "./alerts.ts";
import type { EdgeMarker } from "./camera.ts";
import type { DeckModel, RailNode } from "./types.ts";

/**
 * Severity as a glyph, next to the plain word. The stack never depends on
 * colour: the ring count in the scene, the glyph and the word here, and the
 * message itself all say the same thing.
 */
const SEVERITY_GLYPH: Record<AlertSeverity, string> = { high: "!!", medium: "!", advisory: "i" };

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
  edgeMarkers,
  onFrozenChange,
  onExpandedChange,
  onFocus,
  onSelect,
  onInspect,
  dockOpen,
  onDismiss,
  alertsCollapsed,
  onAlertsCollapsedChange,
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
  /**
   * Live workers the camera cannot see, with the viewport-edge anchor they
   * point from (`camera.edgeAnchor`). Empty while every worker is on screen —
   * and the lane list below lists every worker either way.
   */
  edgeMarkers: EdgeMarker[];
  onFrozenChange: (frozen: boolean) => void;
  onExpandedChange: (expanded: boolean) => void;
  /**
   * Focus a worker. `frame` also moves the camera: lane rows pass `false`
   * (focus is a pointer change, not a camera order), edge markers pass `true`
   * (the worker is off screen, so "there" is the whole request).
   */
  onFocus: (sliceId: string, frame: boolean) => void;
  onSelect: (sliceId: string) => void;
  /**
   * Open the 2D inspection dock on this slice (`d06`). The only thing the
   * spatial layer is allowed to say to the inspection surface: *which* worker.
   */
  onInspect: (sliceId: string) => void;
  /**
   * Whether the dock is already on screen. The Inspect affordances exist to
   * *open* it, so they are not offered while it is open — a button that does
   * nothing is worse than no button, and the focused lane row gets its action
   * line back.
   */
  dockOpen: boolean;
  /** Acknowledge one alert (`d05`). Recurrence is a new key and re-raises. */
  onDismiss: (alert: DeckAlert) => void;
  alertsCollapsed: boolean;
  onAlertsCollapsedChange: (collapsed: boolean) => void;
}) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
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

  // The live workers, in station order (`model.stations` is that order and the
  // scene's slot order at once). The focused one is the operator's handle on
  // "which worker the deck is pointing at".
  const focused = model.focusId === null ? null : (model.nodes.find((node) => node.id === model.focusId) ?? null);
  const focusAgent = focused === null ? undefined : agents.find((row) => row.id === focused.id);

  // Alerts (`d05`): run-level conditions are banners (a double loop is not a
  // slice's problem), slice conditions are stack rows in severity order. Both
  // lists come straight from the model, so the scene, the stack and the HUD
  // cannot disagree about what is alerting.
  const banners = model.alerts.filter((alert) => alert.sliceId === null);
  const rows = model.alerts.filter((alert) => alert.sliceId !== null);
  const highest = model.alerts[0] ?? null;

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
      {/* Off-screen workers (`d04`): a marker on the viewport edge the worker's
          direction leaves, so a station the camera cannot show is still
          reachable — click it and the deck goes there. The lane list below
          lists every live worker whether or not a marker exists. Drawn first,
          so no panel is ever covered by a marker. */}
      {edgeMarkers.length > 0 && (
        <div className="omp-deck-edges" role="group" aria-label="Off-screen workers">
          {edgeMarkers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              className="omp-deck-edge"
              data-slice-id={marker.id}
              data-behind={marker.behind ? "true" : "false"}
              style={{ left: `${(marker.x * 100).toFixed(2)}%`, top: `${(marker.y * 100).toFixed(2)}%` }}
              title={`${marker.id} is off screen`}
              aria-label={`Focus and frame ${marker.id} (off screen)`}
              onClick={() => onFocus(marker.id, true)}
            >
              <span
                className="omp-deck-edge-arrow"
                style={{ transform: `rotate(${((marker.angle * 180) / Math.PI).toFixed(1)}deg)` }}
                aria-hidden="true"
              />
              <span className="omp-deck-edge-id">{marker.id}</span>
            </button>
          ))}
        </div>
      )}

      {/* The top band: the station line (what the scene is pointed at, in
          words) and the lane strip (every live worker). Side by side normally;
          stacked in the narrower column the dock leaves (`d06`). The wrapper
          is `display: contents` until then, so neither panel moves. */}
      <div className="omp-deck-top">
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
                {model.liveIds.length === 0 ? "no worker running" : `live: ${model.liveIds.length}`}
              </span>
            </>
          ) : (
            <span className="omp-deck-station-meta">showing nothing</span>
          )}
        </p>

        {model.stations.length > 0 && (
          <ul className="omp-deck-lanes" aria-label="Live workers">
            {model.stations.map((station) => {
              const node = nodeById.get(station.id);
              if (!node) return null;
              const row = agents.find((agentRow) => agentRow.id === station.id);
              const laneAction = heroAction({
                status: node.status,
                lastLine: row?.lastLine,
                lastEvent: liveSliceEvent(node.status, events, node.id),
                reason: node.reason,
                deps: node.deps,
              });
              return (
                <li key={station.id}>
                  <button
                    type="button"
                    className="omp-deck-lane"
                    data-focused={station.focused ? "true" : "false"}
                    data-primary={station.primary ? "true" : "false"}
                    data-overflow={station.stack > 0 ? "true" : "false"}
                    aria-current={station.focused ? "true" : undefined}
                    title={laneAction}
                    onClick={() => onFocus(station.id, false)}
                  >
                    <span className="omp-deck-lane-dot" aria-hidden="true">
                      {station.focused ? "●" : "○"}
                    </span>
                    <span className="omp-deck-lane-id">{station.id}</span>
                    <span className="omp-deck-lane-status">{node.status}</span>
                    <span className="omp-deck-lane-stage">{node.stageLabel || "—"}</span>
                    <span className="omp-deck-lane-meta">
                      {station.lane === null ? "L—" : `L${station.lane}`} · g{node.generation} · a{node.attempts}
                    </span>
                    <span className="omp-deck-lane-tail">
                      {station.wedged && <span className="omp-deck-lane-warn">stalled</span>}
                      <span className="omp-deck-lane-action">{laneAction}</span>
                    </span>
                  </button>
                  {/* The focused worker's own way into the dock (`d06`): the
                      lane row is the "watch this" affordance, this is the
                      "show me everything" one. Sibling, not nested — the row
                      stays one button and one focus stop. */}
                  {station.focused && !dockOpen && (
                    <button
                      type="button"
                      className="omp-deck-inspect omp-deck-lane-inspect"
                      aria-label={`Inspect ${station.id} in the dock`}
                      onClick={() => onInspect(station.id)}
                    >
                      Inspect
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* The bottom band: the selected/hovered line, the live window and the
          alert column. Normal layout: line bottom-right, window bottom-left,
          alerts bottom-right — the wrapper is `display: contents`, so nothing
          moves. With the dock open (`d06`) it becomes one grid in the column
          the dock leaves: the line names the subject, the window and the
          alerts share the row beneath it. */}
      <div className="omp-deck-bottom">
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
              {/* Inspecting acts on the *selection*; while the pointer is
                  previewing another pad the line is a hover readout, so the
                  affordance is not offered there. */}
              {hovered === null && !dockOpen && (
                <button
                  type="button"
                  className="omp-deck-inspect omp-deck-line-inspect"
                  aria-label={`Inspect ${shown.id} in the dock`}
                  onClick={() => onInspect(shown.id)}
                >
                  Inspect
                </button>
              )}
            </>
          ) : (
            <span className="omp-deck-line-meta">nothing selected</span>
          )}
        </p>

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

        {/* Run-level alerts (`d05`) and the slice stack share one bottom-right
            column: the HUD owns the top, the lane strip the top-right, the live
            window the bottom-left. A banner is for a condition that is not one
            slice's problem (two loop processes). */}
        {(banners.length > 0 || rows.length > 0) && (
          <div className="omp-deck-alertcol">
          {banners.map((alert) => (
            <p key={`${alert.kind}:${alert.lastSeq}`} className="omp-deck-banner" data-kind={alert.kind} data-severity={alert.severity} role="alert">
              <span className="omp-deck-alert-glyph" aria-hidden="true">
                {SEVERITY_GLYPH[alert.severity]}
              </span>
              <strong>{alert.kind}</strong>
              <span className="omp-deck-banner-text">{alert.message}</span>
              <button
                type="button"
                className="omp-deck-alert-dismiss"
                aria-label={`Dismiss ${alert.kind} alert`}
                onClick={() => onDismiss(alert)}
              >
                ✕
              </button>
            </p>
          ))}

          {/* The alert stack: every active alert, severity-stamped in words and
              glyph, one row each, dismissable one at a time. The scene carries
              the ring pattern; this carries the sentence. */}
          {rows.length > 0 && (
            <section className="omp-deck-alerts" data-count={rows.length} data-overflow={model.alertsOverflow} aria-label="Alerts">
              <button
                type="button"
                className="omp-deck-alerts-head"
                aria-expanded={!alertsCollapsed}
                onClick={() => onAlertsCollapsedChange(!alertsCollapsed)}
              >
                <span className="omp-deck-alerts-count">
                  {rows.length} alert{rows.length === 1 ? "" : "s"}
                </span>
                {highest !== null && (
                  <span className="omp-deck-alerts-highest">
                    highest: {highest.severity} · {highest.kind}
                    {alertsCollapsed && highest.sliceId !== null ? ` · ${highest.sliceId}` : ""}
                  </span>
                )}
                <span className="omp-deck-alerts-toggle" aria-hidden="true">
                  {alertsCollapsed ? "▸" : "▾"}
                </span>
              </button>
              {!alertsCollapsed && (
                <ul className="omp-deck-alerts-list">
                  {rows.map((alert) => {
                    const sliceId = alert.sliceId ?? "";
                    return (
                      <li
                        key={`${sliceId}:${alert.kind}:${alert.lastSeq}`}
                        className="omp-deck-alert"
                        data-kind={alert.kind}
                        data-severity={alert.severity}
                        data-slice-id={sliceId}
                      >
                        <button
                          type="button"
                          className="omp-deck-alert-row"
                          title={alert.message}
                          // Taking the operator to the problem is two acts in
                          // one: point the deck at the worker, then open the
                          // detail (`d05`'s rule, wired to the dock in `d06`).
                          onClick={() => {
                            onFocus(sliceId, false);
                            onInspect(sliceId);
                          }}
                        >
                          <span className="omp-deck-alert-glyph" aria-hidden="true">
                            {SEVERITY_GLYPH[alert.severity]}
                          </span>
                          <span className="omp-deck-alert-severity">{alert.severity}</span>
                          <code className="omp-deck-alert-slice">{sliceId}</code>
                          <span className="omp-deck-alert-message">{alert.message}</span>
                        </button>
                        <button
                          type="button"
                          className="omp-deck-alert-dismiss"
                          aria-label={`Dismiss ${alert.kind} alert for ${sliceId}`}
                          onClick={() => onDismiss(alert)}
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
          </div>
        )}
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
