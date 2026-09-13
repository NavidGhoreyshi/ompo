import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AgentRow, RunEvent, SliceSummary } from "../api.ts";
import { COMPACT_ROWS, followFromScroll, LANE_LABEL, rawLine, type StreamEntry } from "../lib/stream.ts";
import { LIVE_TAIL, useLiveStream } from "../lib/useLiveStream.ts";
import { toneForStatus } from "../lib/status.ts";

/** Ghost rows live just long enough to be seen leaving. */
const EXIT_MS = 240;

/** No motion pass in flight — what the window resumes with. */
const NO_MOTION: { enter: string[]; leave: StreamEntry[] } = { enter: [], leave: [] };

function StreamRow({ entry, motion }: { entry: StreamEntry; motion?: "enter" | "leave" }) {
  return (
    <div
      className="omp-live-row"
      data-kind={entry.kind}
      data-motion={motion ?? "steady"}
      data-key={entry.key}
      title={entry.meta ? `${entry.text} — ${entry.meta}` : entry.text}
    >
      <span aria-hidden="true" className="omp-live-tag" data-kind={entry.kind}>
        {entry.tag}
      </span>
      <span className="omp-live-text">{entry.text}</span>
      {entry.meta && <span className="omp-live-meta">{entry.meta}</span>}
    </div>
  );
}

/**
 * The window frozen in time. Taken on the freeze edge so a frozen window is a frame
 * of the past rather than a paused subscription: the rows it showed, the raw
 * tail behind them, and the counters that say what has landed since.
 */
interface FreezeSnapshot {
  /** Compact rows at the moment of freezing — the same window the compact view renders. */
  rows: StreamEntry[];
  /** Expanded rows at that moment, so expanding while frozen keeps the same frame. */
  raw: StreamEntry[];
  /** `stream.lines.length` then: raw lines past this point are new. */
  lines: number;
  /** `stream.entries.length` then: semantic rows past this index are new. */
  entries: number;
}

/**
 * The live worker window — the visual protagonist of the Overview.
 *
 * Compact (default): the newest few *meaningful* rows — tool calls, turn
 * boundaries, lifecycle events — in a fixed window with no scrollbar. New rows
 * rise in, the row that falls out of the window is animated out, and the
 * window never grows. Expanded: the full worker-log tail the panel polled
 * (raw lines, semantic colors), scrolling independently.
 *
 * Following is behavior, not decoration: the compact window follows by
 * construction, and the expanded window follows until the operator scrolls
 * away from the bottom — then a `Jump to live` affordance appears and stays
 * until they take it. Collapsing never silently re-enables follow. Nothing is
 * truncated permanently; the expanded view and the Inspector's Log tab read
 * the same log.
 *
 * The window is also drivable from outside without forking it: `expanded` and
 * `frozen` are optional, and the dashboard passes neither, so its own toggle
 * and its never-frozen window are unchanged. A frozen window is a frame of the
 * past — the rows it showed plus a count of what landed since — and resuming
 * shows the newest window at once. Freezing is the operator's term, so it must
 * never quietly drop a row: that count is the evidence.
 */
export default function LiveFeed({
  runId,
  slice,
  agent,
  events,
  expanded: expandedProp,
  onExpandedChange,
  frozen: frozenProp,
  onFrozenChange,
}: {
  runId: string | null;
  slice: SliceSummary | null;
  agent?: AgentRow;
  events: RunEvent[];
  /** Controlled expand toggle; omitted, the head button owns the state. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Controlled freeze; omitted, the window never freezes. */
  frozen?: boolean;
  onFrozenChange?: (frozen: boolean) => void;
}) {
  const stream = useLiveStream(runId, slice, events);
  const [expandedState, setExpandedState] = useState(false);
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Controlled when the caller passes the prop, local otherwise — one
  // component, and neither caller pays for the other's mode.
  const expanded = expandedProp ?? expandedState;
  const freeze = frozenProp === true;
  const setExpanded = (next: boolean) => {
    if (expandedProp === undefined) setExpandedState(next);
    onExpandedChange?.(next);
  };

  // Enter/leave motion for the compact window: rows that just arrived, and the
  // rows that fell out of it. One pass per window change, cleared on a timer.
  const [motion, setMotion] = useState<{ enter: string[]; leave: StreamEntry[] }>(NO_MOTION);
  const [snapshot, setSnapshot] = useState<FreezeSnapshot | null>(null);
  const frozenRef = useRef<{ frozen: boolean; sliceId: string | null }>({ frozen: false, sliceId: null });
  const prevRef = useRef<StreamEntry[]>(stream.compact);
  const windowKey = stream.compact.map((e) => e.key).join("|");
  useEffect(() => {
    // A frozen window runs no motion pass — but it keeps the comparison point in
    // step with the live window, so resuming does not replay the frozen period as
    // enter/leave motion.
    if (freeze) {
      prevRef.current = stream.compact;
      return;
    }
    const prev = prevRef.current;
    const next = stream.compact;
    prevRef.current = next;
    const nextKeys = new Set(next.map((e) => e.key));
    const leave = prev.filter((e) => !nextKeys.has(e.key));
    const prevKeys = new Set(prev.map((e) => e.key));
    const enter = next.filter((e) => !prevKeys.has(e.key)).map((e) => e.key);
    if (leave.length === 0 && enter.length === 0) return;
    setMotion({ enter, leave });
    const timer = setTimeout(() => setMotion(NO_MOTION), EXIT_MS);
    return () => clearTimeout(timer);
    // Keyed on the window's keys, not the array identity: a re-render that
    // rebuilds the same rows must not replay the motion.
  }, [windowKey, freeze]);

  // Follow: the expanded view stays pinned to the newest line while following.
  useEffect(() => {
    const el = bodyRef.current;
    // A frozen window does not move: freezing keeps the scroll where the operator
    // left it, and resuming lands at the bottom with the newest rows in place.
    if (el && expanded && follow && !freeze) el.scrollTop = el.scrollHeight;
    // Pinned on new output, on expanding, on re-taking the follow, and on
    // resuming.
  }, [expanded, follow, freeze, stream.lines.length]);

  if (!slice) {
    return (
      <section
        className="omp-livefeed"
        data-live="false"
        data-expanded="false"
        data-rows={0}
        data-lines={0}
        aria-label="Live worker output"
      >
        <div className="omp-livefeed-head">
          <span className="omp-section-label">Live output</span>
          <span className="omp-hint">no slices yet</span>
        </div>
      </section>
    );
  }

  // Freezing is an edge, not a level: take the frame on the way in, drop it on
  // the way out. Adjusted during render (React's props-change pattern) so the
  // first frozen frame is the frame the operator froze — an effect would paint one
  // live frame over it. A slice switch while frozen re-frames: another slice's
  // rows under this header would be a lie.
  if (freeze !== frozenRef.current.frozen || slice.id !== frozenRef.current.sliceId) {
    frozenRef.current = { frozen: freeze, sliceId: slice.id };
    setSnapshot(
      freeze
        ? {
            rows: stream.compact,
            raw: stream.lines.map((line, i) => rawLine(line, stream.ids[i] ?? i, stream.logName, stream.lane)),
            lines: stream.lines.length,
            entries: stream.entries.length,
          }
        : null,
    );
    // Resuming shows the newest window at once; enter/leave from the frozen
    // period is motion the operator never watched.
    if (!freeze) setMotion(NO_MOTION);
  }

  const tone = toneForStatus(slice.status);
  const streaming = slice.status === "running" || slice.status === "verifying";
  const lane = stream.lane === null ? null : LANE_LABEL[stream.lane];
  // The compact window follows by construction; `follow` is the operator's
  // choice inside the expanded view and survives collapsing.
  const following = !expanded || follow;
  // A frozen window renders its frame rather than the rows landing behind it.
  const rows =
    snapshot === null
      ? expanded
        ? stream.lines.map((line, i) => rawLine(line, stream.ids[i] ?? i, stream.logName, stream.lane))
        : stream.compact
      : expanded
        ? snapshot.raw
        : snapshot.rows;
  // What the freeze skipped, as the operator's evidence that nothing is lost:
  // every semantic row since the frame, and — when the raw tail is on screen —
  // every new transcript line too. Raw rows are the expanded view's own, so a
  // compact freeze does not count them twice.
  const skipped =
    snapshot === null
      ? 0
      : stream.entries.slice(snapshot.entries).filter((e) => e.kind !== "raw").length +
        (expanded ? Math.max(0, stream.lines.length - snapshot.lines) : 0);
  // Line counts describe what is on screen, so a frozen frame does not claim the
  // lines that landed behind it.
  const shownLines = snapshot === null ? stream.lines.length : snapshot.lines;
  const capped = expanded && shownLines >= LIVE_TAIL;
  const empty = !stream.loading && !stream.error && rows.length === 0;

  return (
    <section
      className="omp-livefeed"
      data-live={streaming ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
      data-rows={rows.length}
      data-lines={stream.lines.length}
      aria-label={`Live stage output — ${slice.id}`}
      style={{ "--omp-live-rows": COMPACT_ROWS } as CSSProperties}
    >
      <div className="omp-livefeed-head">
        <span className="omp-section-label">Live output</span>
        <span aria-hidden="true" className="omp-livefeed-dot" data-tone={tone} />
        {streaming && following ? (
          <span className="omp-livefeed-follow" title="Following new output">
            live
          </span>
        ) : (
          <span className="omp-hint">{streaming ? "paused" : "settled"}</span>
        )}
        {lane !== null && (
          <span className="omp-livefeed-lane" data-lane={stream.lane}>
            {lane}
          </span>
        )}
        {agent !== undefined && (
          <span className="omp-hint">
            L{agent.lane} · gen {agent.generation} · attempt {agent.attempt}
          </span>
        )}
        <span className="omp-livefeed-log-name omp-ellipsis" title={stream.logName ?? undefined}>
          {stream.logName ?? "no transcript yet"}
          {shownLines > 0 ? ` · ${shownLines} lines` : ""}
        </span>
        {snapshot !== null && (
          <>
            {/* A status, not an alert: the count ticking up is the
                operator's evidence that freezing loses nothing. */}
            <span className="omp-livefeed-frozen" role="status">
              frozen — {skipped} new rows
            </span>
            <button type="button" className="omp-livefeed-resume" onClick={() => onFrozenChange?.(false)}>
              resume
            </button>
          </>
        )}
        <button
          type="button"
          className="omp-livefeed-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Collapse log" : "View full log"}
        </button>
      </div>

      {agent?.wedged === true && (
        <p className="omp-attention" role="alert" title="The worker transcript stopped growing while the run still holds its lock — the loop is wedged, not working">
          <strong>STALLED</strong>
          <span className="omp-hint">
            no worker output {agent.staleForMs == null ? "" : `for ${Math.max(1, Math.round(agent.staleForMs / 60000))}m`} — the
            lock is still held
          </span>
        </p>
      )}

      {stream.loading && stream.lines.length === 0 && <p className="omp-hint">loading worker log…</p>}
      {!stream.loading && stream.error && (
        <p className="omp-error" role="alert">
          {stream.error}
        </p>
      )}
      {empty && (
        <p className="omp-hint">
          {streaming
            ? "no stage output yet — lines appear once the current stage writes"
            : slice.reason
              ? `no output recorded · ${slice.reason}`
              : "no output recorded for this slice"}
        </p>
      )}

      {rows.length > 0 && (
        <div
          ref={bodyRef}
          className="omp-code omp-livefeed-log"
          role="log"
          aria-label={`Stage output — ${slice.id}${expanded ? "" : " (latest lines)"}`}
          tabIndex={expanded ? 0 : -1}
          data-follow={following ? "true" : "false"}
          onScroll={
            expanded
              ? (e) => {
                  const el = e.currentTarget;
                  setFollow(
                    followFromScroll(Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop)),
                  );
                }
              : undefined
          }
        >
          {/* Ghosts belong to the live window: a frozen frame has no
              rows leaving it. */}
          {snapshot === null &&
            motion.leave.map((entry) => <StreamRow key={`leave:${entry.key}`} entry={entry} motion="leave" />)}
          {rows.map((entry) => (
            <StreamRow
              key={entry.key}
              entry={entry}
              motion={snapshot === null && motion.enter.includes(entry.key) ? "enter" : undefined}
            />
          ))}
        </div>
      )}

      {expanded && (
        <p className="omp-livefeed-foot">
          {!follow && (
            <button
              type="button"
              className="omp-livefeed-jump"
              onClick={() => {
                const el = bodyRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setFollow(true);
              }}
            >
              Jump to live
            </button>
          )}
          <span className="omp-hint">
            {capped ? `last ${shownLines} lines` : `${shownLines} lines`} · raw transcript · following{" "}
            {follow ? "on" : "off"}
            {slice.status === "running" || slice.status === "verifying" ? " · refreshing every 2s" : ""}
          </span>
        </p>
      )}
    </section>
  );
}
