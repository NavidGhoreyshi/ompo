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

import { useState } from "react";
import type { AgentRow, RunEvent, RunSummary, SliceSummary } from "../api.ts";
import StatusBadge from "../components/StatusBadge.tsx";
import LiveFeed from "../components/LiveFeed.tsx";
import { formatEventTime, liveSliceEvent } from "../lib/events.ts";
import { formatDurationMs, formatSpan } from "../lib/format.ts";
import { heroAction } from "../lib/selection.ts";
import type { TimelineAttempt } from "../lib/timeline.ts";
import { SEVERITY_GLYPH, type AlertSeverity, type DeckAlert } from "./alerts.ts";
import type { EdgeMarker } from "./camera.ts";
import { flatRowLabel, flatRows, focusMirrorText } from "./fallback.ts";
import { alertGlyphFor, labelStage, spatialLabelFor } from "./labels.ts";
import FlatDeck from "./FlatDeck.tsx";
import type { RibbonBucket } from "./history.ts";
import { useRovingFocus } from "./roving.ts";
import type { DeckModel, ReplayState } from "./types.ts";
import { DECK_KEYS } from "./types.ts";
import HistoryWall from "./HistoryWall.tsx";
import DeckControlBar from "./ControlBar.tsx";

/**
 * Pads listed in the DOM mirror. Past this the list states the remainder in
 * words — a long run is never silently truncated (`d09` builds the full
 * virtualised list on top of this contract).
 */
export const MIRROR_LIMIT = 200;

/** The mirror's rows and the count it does not list (never silent). */
export function mirrorRows<T extends { id: string }>(nodes: readonly T[]): { listed: T[]; hidden: number } {
  return { listed: nodes.slice(0, MIRROR_LIMIT), hidden: Math.max(0, nodes.length - MIRROR_LIMIT) };
}

/** One bucket's one-line description, for its title, its aria-label and hover. */
function bucketLabel(bucket: RibbonBucket): string {
  const span = `${formatEventTime(bucket.startAt)}–${formatEventTime(bucket.endAt)}`;
  if (bucket.count === 0) return `${span} · no events`;
  const lanes = (Object.entries(bucket.laneCounts) as [string, number][])
    .filter(([, count]) => count > 0)
    .map(([lane, count]) => `${lane} ${count}`)
    .join(", ");
  const touched = bucket.slices.length > 0 ? ` · touched ${bucket.slices.join(", ")}` : "";
  return `${span} · ${bucket.count} event${bucket.count === 1 ? "" : "s"} · ${lanes} · ${bucket.active} active${touched}`;
}

/** `1m 12s` / `42s` / `—`: an attempt's observed wall clock, never an estimate. */
function attemptLabel(attempt: TimelineAttempt): string {
  const index = attempt.attempt === null ? "?" : String(attempt.attempt);
  // An attempt whose only observed event is its own claim has no span yet: the
  // repo's rule for "not known" is `—`, never a 0 that reads like a duration.
  const duration =
    attempt.durationMs === null || attempt.durationMs === 0 ? "—" : formatDurationMs(attempt.durationMs);
  return `#${index} ${duration}${attempt.open ? " open" : ""}`;
}

/** The ribbon's bucket size, read off the buckets themselves ("30s", "5m"). */
function bucketSizeLabel(buckets: RibbonBucket[]): string {
  const bucket = buckets[1] ?? buckets[0];
  return bucket === undefined ? "—" : formatSpan(bucket.endMs - bucket.startMs);
}

/**
 * A bar's height as a percentage of the strip, relative to the busiest bucket
 * of *this window* — the same rule the scene's ribbon uses (`renderer.ts`), so
 * the DOM strip and the 3D bars read as one shape. An empty bucket keeps a
 * visible floor: a gap is information, not nothing.
 */
function bucketHeight(bucket: RibbonBucket, buckets: readonly RibbonBucket[]): number {
  if (bucket.count === 0) return 6;
  let busiest = 1;
  for (const candidate of buckets) {
    if (candidate.count > busiest) busiest = candidate.count;
  }
  return Math.max(10, Math.round((bucket.count / busiest) * 100));
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
  attempts,
  timelineTruncated,
  playing,
  wallOpen,
  runs,
  replay,
  onScrub,
  onStep,
  onBucket,
  onLive,
  onPlayToggle,
  onToggleWall,
  onOpenRun,
  onVerifyReplay,
  live,
  loops,
  onControlDone,
  selectedId,
  slices,
  flat = false,
  helpOpen = false,
  labelPositions,
  labelsHidden = 0,
  degraded = false,
  onReframe,
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
  /** The selected slice's observed attempts (`d07`), oldest first. */
  attempts: TimelineAttempt[];
  /** The window is the newest page of a longer log (`d07`) — said, not hidden. */
  timelineTruncated: boolean;
  playing: boolean;
  /** The wall's DOM list (the scene's tiles are inert geometry). */
  wallOpen: boolean;
  /** `api.runs()` as the shell polls it, oldest first. */
  runs: RunSummary[];
  /** The last `/replay` outcome, or `null` until the operator asks for one. */
  replay: ReplayState | null;
  /** Slider position: bucket index, or `buckets.length` for live. */
  onScrub: (position: number) => void;
  /** Step one bucket (`-1` back, `+1` forward). */
  onStep: (direction: 1 | -1) => void;
  /** A ribbon bucket clicked: jump there, select what it touched, inspect it. */
  onBucket: (bucket: RibbonBucket) => void;
  /** Return to the live projection. */
  onLive: () => void;
  onPlayToggle: () => void;
  onToggleWall: () => void;
  onOpenRun: (runId: string) => void;
  onVerifyReplay: () => void;
  /** The run's live flag (`RunDetail.live`) — the action bar's quiescent recast. */
  live: boolean;
  /** Recorded loop processes for this run (`RunDetail.loops.length`). */
  loops: number;
  /** The shell's refetch after a control attempt — the dashboard's own callback. */
  onControlDone: () => void;
  /** The app's selection, before it is resolved against this run's DTOs (`d08`). */
  selectedId: string | null;
  /** The current run's slice DTOs — the list a control press must address. */
  slices: SliceSummary[];
  /**
   * True while the flat projection is up (`d09`): the canvas is absent, so the
   * deck's station lane strip is replaced by the dashboard's own `WorkerLanes`
   * inside `FlatDeck`, and the panels flow as a document instead of anchoring
   * to a scene (`CSS` reads the same flag off the section).
   */
  flat?: boolean;
  /** The keyboard help panel (`d09`), toggled by `H`/`?` on the deck. */
  helpOpen?: boolean;
  /**
   * Projected label positions (`ux01`): screen-space points keyed by slice
   * id, resolved by the shell from `renderer.project` at camera settle. The
   * overlay only renders the entries present — suppression (off-screen,
   * uncapped) already happened upstream.
   */
  labelPositions?: ReadonlyMap<string, { x: number; y: number }>;
  /** Labels suppressed by the density cap — stated, never silent. */
  labelsHidden?: number;
  /** The camera has lost the work (`ux02`): fewer than half the live set
   * visible, or the focus off-screen. Shows the recovery affordance only. */
  degraded?: boolean;
  /** Re-frame to the readable state (`0` preset framing). Present only. */
  onReframe?: () => void;
}) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const selected = model.nodes.find((node) => node.selected) ?? null;
  const hovered = hoverId === null ? null : (model.nodes.find((node) => node.id === hoverId) ?? null);
  const shown = hovered ?? selected;
  // The mirror is the flat projection's row list (`d09`): every pad, in rail
  // order, with the same fields the scene encodes — the mirror announces them
  // and `FlatDeck` renders them. The cap stays: past it the remainder is
  // stated, never silently dropped.
  const padRows = flatRows(model);
  const { listed: mirror, hidden } = mirrorRows(padRows);
  const roving = useRovingFocus(
    mirror.map((row) => row.id),
    selected?.id ?? null,
  );
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

  // Control (`d08`): the action bar acts on the *selection*, never on the
  // hover preview — and only when the selection still exists in the run on
  // screen, so a run switch in flight disables the bar instead of letting a
  // press address the previous run's slice by name. "Stalled" is the deck's
  // own existing stall signal — a wedged worker or an idle verdict already on
  // the alert stack — so the wedged-loop recovery appears when the surface is
  // already saying "stuck", and never as an extra button on a healthy run.
  const controlTarget = selectedId === null ? null : (slices.find((slice) => slice.id === selectedId) ?? null);
  const stalled = model.alerts.some((alert) => alert.kind === "wedged" || alert.kind === "verdict-stall");
  const targetWedged = controlTarget !== null && agents.find((row) => row.id === controlTarget.id)?.wedged === true;

  // ---- the temporal layer (`d07`) ----
  //
  // The ribbon and the wall are *views* of the model here: this component adds
  // the words and the hit areas, and nothing about time is derived again. The
  // slider's rightmost position is live by construction (`max = buckets`), so
  // "return to live" is also a place on the axis, not only a button.
  const [hoverBucket, setHoverBucket] = useState<number | null>(null);
  const buckets = model.ribbon;
  const cursorBucket = model.ribbonCursor;
  // The scrubber walks the *recorded* moments (plus live at the end), while the
  // strip below draws every bucket: every scrub position is a state that
  // exists, and the strip shows where that state sits in the run's shape.
  const recordedPositions = model.ribbonRecorded.length;
  const cursorPosition = cursorBucket < 0 ? -1 : model.ribbonRecorded.indexOf(cursorBucket);
  const sliderValue = model.historySeq === null || cursorPosition < 0 ? recordedPositions : cursorPosition;
  const hoveredBucket = hoverBucket === null ? null : (buckets[hoverBucket] ?? null);
  const firstBucket = buckets[0] ?? null;
  const lastBucket = buckets[buckets.length - 1] ?? null;
  const spanLabel =
    firstBucket !== null && lastBucket !== null
      ? `${formatEventTime(firstBucket.startAt)}–${formatEventTime(lastBucket.endAt)} · ${buckets.length} × ${bucketSizeLabel(buckets)}${timelineTruncated ? " · window is the newest page" : ""}`
      : "no timed events yet";

  const timeBar = (
    <div className="omp-deck-time" data-history={model.historySeq === null ? "live" : "past"}>
      <div className="omp-deck-time-row">
        <button
          type="button"
          className="omp-deck-time-live"
          data-live={model.historySeq === null ? "true" : "false"}
          aria-pressed={model.historySeq === null}
          title="The live projection is the default; this returns to it (L)"
          onClick={onLive}
        >
          {model.historySeq === null ? "LIVE" : "RETURN TO LIVE"}
        </button>
        <span className="omp-deck-time-state">
          {model.historySeq === null
            ? "showing the run as it is now"
            : `recorded state at seq ${model.historySeq}${model.historyAt === null ? "" : ` · ${formatEventTime(model.historyAt)}`} · ${model.historyActive} active`}
        </span>
        <span className="omp-deck-time-hover" aria-live="off">
          {hoveredBucket === null ? spanLabel : bucketLabel(hoveredBucket)}
        </span>
        <span className="omp-deck-time-controls">
          <button type="button" className="omp-deck-time-step" aria-label="Previous bucket (,)" title="Previous bucket (,)" onClick={() => onStep(-1)}>
            ‹
          </button>
          <button
            type="button"
            className="omp-deck-time-step"
            aria-pressed={playing}
            aria-label={playing ? "Pause playback (P)" : "Play the recorded run (P)"}
            title={playing ? "Pause playback (P)" : "Play the recorded run (P)"}
            onClick={onPlayToggle}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button type="button" className="omp-deck-time-step" aria-label="Next bucket (.)" title="Next bucket (.)" onClick={() => onStep(1)}>
            ›
          </button>
        </span>
        <button type="button" className="omp-deck-time-wall" aria-expanded={wallOpen} onClick={onToggleWall}>
          runs ({runs.length})
        </button>
        <button type="button" className="omp-deck-time-replay" onClick={onVerifyReplay} title="Ask the server to replay the log against the run cursor (read-only)">
          verify replay
        </button>
        {replay !== null && (
          <span className="omp-deck-time-replay-result" data-replay={replay.status}>
            {replay.status === "loading"
              ? "replay…"
              : replay.status === "error"
                ? `replay failed: ${replay.error ?? "unknown error"}`
                : replay.mismatches.length === 0
                  ? `replay agrees · ${replay.events} events`
                  : `${replay.mismatches.length} mismatch${replay.mismatches.length === 1 ? "" : "es"}`}
            {replay.status === "ready" && replay.mismatches.length > 0 && (
              <details>
                <summary>mismatches</summary>
                <ul>
                  {replay.mismatches.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
          </span>
        )}
      </div>
      <input
        className="omp-deck-time-slider"
        type="range"
        min={0}
        max={Math.max(0, recordedPositions)}
        step={1}
        value={sliderValue}
        aria-label="Recorded moment — the rightmost position is live"
        aria-valuetext={
          model.historySeq === null
            ? "live"
            : `seq ${model.historySeq}${model.historyAt === null ? "" : `, ${formatEventTime(model.historyAt)}`}`
        }
        onChange={(event) => onScrub(Number(event.currentTarget.value))}
        disabled={recordedPositions === 0}
      />
      {buckets.length > 0 && (
        <ol className="omp-deck-ribbon" aria-label="Event ribbon">
          {buckets.map((bucket, index) => (
            <li key={bucket.index}>
              <button
                type="button"
                className="omp-deck-ribbon-bar"
                data-lane={bucket.lane ?? "none"}
                data-cursor={index === cursorBucket ? "true" : "false"}
                data-live-end={index === buckets.length - 1 && model.historySeq === null ? "true" : "false"}
                title={bucketLabel(bucket)}
                aria-label={bucketLabel(bucket)}
                tabIndex={-1}
                onMouseEnter={() => setHoverBucket(index)}
                onMouseLeave={() => setHoverBucket((current) => (current === index ? null : current))}
                onClick={() => onBucket(bucket)}
              >
                <span
                  className="omp-deck-ribbon-fill"
                  style={{ height: `${bucketHeight(bucket, buckets)}%` }}
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ol>
      )}
      {wallOpen && <HistoryWall runs={runs} activeRunId={model.runId} onOpenRun={onOpenRun} onClose={onToggleWall} />}
    </div>
  );

  // The focus mirror (`d09`): one polite node whose text is a function of the
  // model. A log line that changes no status, stage or count produces the same
  // string, so React never writes it and the operator is never interrupted.
  const focusStatus = (
    <p className="omp-sr-only" aria-live="polite" aria-atomic="true" data-focus-mirror="true">
      {focusMirrorText(model)}
    </p>
  );

  // The keyboard help (`d09`): every binding, generated from `DECK_KEYS`
  // verbatim, so a key that exists in code and not in the panel (or the other
  // way around) is impossible.
  const helpPanel = helpOpen ? (
    <section className="omp-deck-help" aria-label="Keyboard help">
      <p className="omp-deck-help-head">
        Keyboard — every deck binding. <kbd>H</kbd> or <kbd>?</kbd> toggles this panel.
      </p>
      <ul className="omp-deck-keys">
        {DECK_KEYS.map((entry) => (
          <li key={entry.key} data-live={entry.slice === "d01" ? "true" : "false"}>
            <kbd>{entry.key}</kbd>
            <span>{entry.effect}</span>
            <em>{entry.slice}</em>
          </li>
        ))}
      </ul>
    </section>
  ) : null;

  if (model.nodes.length === 0) {
    return (
      <div className="omp-deck-overlay">
        {/* The deck's two "nothing on the rail" states (`d13`): which state it
            is in, what it is holding meanwhile, and where the way back is. */}
        <div className="omp-deck-empty" role="status">
          <p className="omp-deck-empty-title">
            {model.loading ? `loading run ${model.runId ?? ""}…` : "no slices in this run"}
          </p>
          <p className="omp-deck-empty-hint">
            {model.loading
              ? "the deck keeps the last world it drew on the floor until this run's slices arrive — nothing is lost, and the panels below are already live"
              : "a run with no slices has nothing to place on the rail; the Runs list in the dashboard is the way to another run"}
          </p>
        </div>
        {timeBar}
        {focusStatus}
        {helpPanel}
      </div>
    );
  }

  return (
    <div className="omp-deck-overlay">
      {timeBar}
      {focusStatus}
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
      {/* Degraded view (`ux02`): the camera lost the work. One quiet button
          naming the exit — never an auto-reframe (correction §10). */}
      {!flat && degraded && onReframe && (
        <button type="button" className="omp-deck-reframe" onClick={onReframe} title="Re-frame the run (0)">
          Reset framing (0)
        </button>
      )}
      {/* Projected spatial labels (`ux01`): DOM identity at the pad's screen
          position — `id · Stage` plus glyphs, never diagnostics. Decorative
          duplication of the lane strip's identity, so `aria-hidden`: the
          mirror stays the assistive-technology path, and the labels take no
          focus and no pointer events. Suppression (off-screen, over-cap)
          happened upstream; only present positions render. */}
      {!flat && labelPositions && labelPositions.size > 0 && (
        <div className="omp-deck-labels" aria-hidden="true">
          {[...labelPositions.entries()].map(([id, point]) => {
            const node = nodeById.get(id);
            const station = model.stations.find((candidate) => candidate.id === id);
            if (!node || !station) return null;
            const label = spatialLabelFor(node, station, alertGlyphFor(id, model.beaconAlerts));
            return (
              <span
                key={id}
                className="omp-deck-label"
                data-slice-id={id}
                data-focused={label.focused ? "true" : "false"}
                data-primary={label.primary ? "true" : "false"}
                style={{ left: `${point.x.toFixed(1)}px`, top: `${point.y.toFixed(1)}px` }}
              >
                <span className="omp-deck-label-id">{label.id}</span>
                {label.stage !== "" && <span className="omp-deck-label-stage">{label.stage}</span>}
                {label.alertGlyph !== null && <span className="omp-deck-label-alert">{label.alertGlyph}</span>}
              </span>
            );
          })}
          {labelsHidden > 0 && <span className="omp-deck-labels-more">+{labelsHidden} more</span>}
        </div>
      )}
      {/* Legend (`ux01`): the frozen visual semantics (§11) in words, as a
          closed disclosure so it costs one chip until asked. Clarifies; adds
          no new channel. */}
      {!flat && (
        <details className="omp-deck-legend">
          <summary>Legend</summary>
          <ul>
            <li>position · roadmap topology</li>
            <li>height · status</li>
            <li>brightness · focus</li>
            <li>ring · selection</li>
            <li>floor rings · alert severity</li>
            <li>broken column · stalled</li>
            <li>dashed edge · waiting on deps</li>
            <li>column marks · pipeline stage</li>
          </ul>
        </details>
      )}


      {/* The top band: the station line (what the scene is pointed at, in
          words) and the lane strip (every live worker). Side by side normally;
          stacked in the narrower column the dock leaves (`d06`). The wrapper
          is `display: contents` until then, so neither panel moves. */}
      <div className="omp-deck-top">
        <p className="omp-deck-station" data-live={focused?.live === true ? "true" : "false"}>
          <span className="omp-deck-station-tag">
            {model.historySeq !== null ? "recorded" : focused?.live === true ? "focused" : "quiescent run"}
          </span>
          {focused ? (
            <>
              <StatusBadge status={focused.status} />
              <code className="omp-deck-station-id">{focused.id}</code>
              <span className="omp-deck-station-meta">
                gen {focused.generation} · attempt {focused.attempts}
                {focused.stageLabel ? ` · ${focused.stageLabel}` : ""}
              </span>
              {/* Two tenses, never mixed: at a cursor the count is the workers
                  in flight *at that point*; live it is the station pool's own
                  count (`no worker running` is a present-tense claim). */}
              <span className="omp-deck-station-meta">
                {model.historySeq !== null
                  ? `${model.historyActive} active at this point`
                  : model.liveIds.length === 0
                    ? "no worker running"
                    : `live: ${model.liveIds.length}`}
              </span>
            </>
          ) : (
            <span className="omp-deck-station-meta">showing nothing</span>
          )}
        </p>

        {/* The station lane strip is the 3D surface's worker list. In flat
            mode the dashboard's own `WorkerLanes` (inside `FlatDeck`) lists
            the same workers, so this one stays off instead of saying it
            twice. */}
        {!flat && model.stations.length > 0 && (
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

      {/* The flat projection (`d09`) sits between the station line and the
          bottom band: in flat mode it is the workspace (board, pad list,
          worker lanes) and the CSS flows it as a document; in 3D mode it is
          not rendered at all. */}
      {flat && (
        <FlatDeck
          model={model}
          slices={slices}
          agents={agents}
          events={events}
          selected={selectedId}
          live={live}
          onSelect={onSelect}
        />
      )}

      {/* The bottom band: the live window bottom-left, and one right-hand
          column that stacks the alert column above the selected line and its
          action bar (`d08`). One column, because two panels anchored to the
          same corner would overlap the moment either grew — and the bar is
          *clickable*, so "the alerts paint over it" is not a cosmetic bug.
          Normal layout: the wrapper is absolute in the corner; with the dock
          open (`d06`) it becomes `display: contents`, so its two children take
          the grid cells they had before (the line spanning both columns, the
          window and the alerts sharing the row beneath it). */}
      <div className="omp-deck-bottom">
        <div className="omp-deck-right">
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

        {/* The selection's panel: the line names the subject, the action bar
            (`d08`) acts on it. They share one wrapper so the bar appears
            exactly where the selection is named, and the panel grows upward as
            one object instead of covering the window or the alert column. */}
        <div className="omp-deck-linewrap">
        <DeckControlBar
          runId={model.runId}
          target={controlTarget}
          selectedId={selectedId}
          events={events}
          live={live}
          loops={loops}
          stalled={stalled}
          historySeq={model.historySeq}
          wedged={targetWedged}
          onControlDone={onControlDone}
        />
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
              {/* The selected slice's observed attempts (`d07`), from the
                  dashboard's own segmentation: how many tries, how long each,
                  which one is open. Read, never re-derived. */}
              {attempts.length > 0 && (
                <span className="omp-deck-line-attempts" title={attempts.map(attemptLabel).join(" · ")}>
                  {attempts.slice(-4).map((attempt) => (
                    <span key={`${attempt.attempt}:${attempt.startSeq}`} data-open={attempt.open ? "true" : "false"}>
                      {attemptLabel(attempt)}
                    </span>
                  ))}
                  {attempts.length > 4 && <span>+{attempts.length - 4}</span>}
                </span>
              )}
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
        </div>
        </div>

        {/* The live window: the dashboard's own component, driven but never
            forked. Freeze and expand are the deck's view state, so the keyboard
            can own them (Space / E) without reaching into the window.
            At a historical cursor the window is *paused instead of retargeted*:
            it shows the run as it is now, and mixing that with a recorded scene
            would make the surface say two tenses at once — and every scrub step
            would re-subject it (and re-fetch). The note names the way back, so
            the live workflow is one key away rather than hidden. */}
        {model.historySeq === null ? (
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
        ) : (
          <div className="omp-deck-live omp-deck-live-past" role="status">
            {/* No button here on purpose: the band above already carries
                `RETURN TO LIVE`, and a second control for the same act is the
                duplication this surface exists to avoid. The note says what is
                missing and where the way back is. */}
            <p className="omp-deck-live-note">
              The live window is paused while the deck shows the recorded state at seq {model.historySeq} — press{" "}
              <kbd>L</kbd> or <strong>RETURN TO LIVE</strong> above.
            </p>
          </div>
        )}

        {/* Run-level alerts (`d05`) and the slice stack live in the column
            above; a banner is for a condition that is not one slice's problem
            (two loop processes). */}
      </div>

      {/* The accessibility backbone: every pad is a real button, in roadmap
          order. Visually hidden until focused so it never competes with the
          scene, present in the tab order from the first frame. */}
      <ul className="omp-deck-mirror" aria-label="Roadmap pads" onKeyDown={roving.onKeyDown}>
        {mirror.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              aria-current={row.selected ? "true" : undefined}
              aria-label={flatRowLabel(row)}
              ref={roving.register(row.id)}
              tabIndex={roving.tabIndexFor(row.id)}
              onFocus={() => roving.activate(row.id)}
              onClick={() => onSelect(row.id)}
            >
              <span aria-hidden="true" className="omp-deck-mirror-glyph">
                {row.glyph}
              </span>
              <span className="omp-deck-mirror-id">{row.id}</span>
              <span className="omp-deck-mirror-status">{row.status}</span>
              <span className="omp-deck-mirror-title">{row.title}</span>
            </button>
          </li>
        ))}
        {hidden > 0 && <li className="omp-deck-mirror-more">{hidden} more slices not listed</li>}
      </ul>

      {helpPanel}
    </div>
  );
}
