import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AgentRow, RunEvent, SliceSummary } from "../api.ts";
import { COMPACT_ROWS, followFromScroll, rawLine, type StreamEntry } from "../lib/stream.ts";
import { LIVE_TAIL, useLiveStream } from "../lib/useLiveStream.ts";
import { toneForStatus } from "./StatusBadge.tsx";

/** Ghost rows live just long enough to be seen leaving. */
const EXIT_MS = 240;

function StreamRow({ entry, motion }: { entry: StreamEntry; motion?: "enter" | "leave" }) {
  return (
    <div
      className="omp-live-row"
      data-kind={entry.kind}
      data-motion={motion ?? "steady"}
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
 */
export default function LiveFeed({
  runId,
  slice,
  agent,
  events,
}: {
  runId: string | null;
  slice: SliceSummary | null;
  agent?: AgentRow;
  events: RunEvent[];
}) {
  const stream = useLiveStream(runId, slice, events);
  const [expanded, setExpanded] = useState(false);
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Enter/leave motion for the compact window: rows that just arrived, and the
  // rows that fell out of it. One pass per window change, cleared on a timer.
  const [motion, setMotion] = useState<{ enter: string[]; leave: StreamEntry[] }>({ enter: [], leave: [] });
  const prevRef = useRef<StreamEntry[]>(stream.compact);
  const windowKey = stream.compact.map((e) => e.key).join("|");
  useEffect(() => {
    const prev = prevRef.current;
    const next = stream.compact;
    prevRef.current = next;
    const nextKeys = new Set(next.map((e) => e.key));
    const leave = prev.filter((e) => !nextKeys.has(e.key));
    const prevKeys = new Set(prev.map((e) => e.key));
    const enter = next.filter((e) => !prevKeys.has(e.key)).map((e) => e.key);
    if (leave.length === 0 && enter.length === 0) return;
    setMotion({ enter, leave });
    const timer = setTimeout(() => setMotion({ enter: [], leave: [] }), EXIT_MS);
    return () => clearTimeout(timer);
    // Keyed on the window's keys, not the array identity: a re-render that
    // rebuilds the same rows must not replay the motion.
  }, [windowKey]);

  // Follow: the expanded view stays pinned to the newest line while following.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && expanded && follow) el.scrollTop = el.scrollHeight;
    // Pinned on new output, on expanding, and on re-taking the follow.
  }, [expanded, follow, stream.lines.length]);

  if (!slice) {
    return (
      <section className="omp-livefeed" data-live="false" data-expanded="false" aria-label="Live worker output">
        <div className="omp-livefeed-head">
          <span className="omp-section-label">Live output</span>
          <span className="omp-hint">no slices yet</span>
        </div>
      </section>
    );
  }

  const tone = toneForStatus(slice.status);
  const streaming = slice.status === "running" || slice.status === "verifying";
  // The compact window follows by construction; `follow` is the operator's
  // choice inside the expanded view and survives collapsing.
  const following = !expanded || follow;
  const rows = expanded
    ? stream.lines.map((line, i) => rawLine(line, stream.ids[i] ?? i, stream.logName))
    : stream.compact;
  const capped = expanded && stream.lines.length >= LIVE_TAIL;
  const empty = !stream.loading && !stream.error && rows.length === 0;

  return (
    <section
      className="omp-livefeed"
      data-live={streaming ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
      aria-label={`Live worker output — ${slice.id}`}
      style={{ "--omp-live-rows": COMPACT_ROWS } as CSSProperties}
    >
      <div className="omp-livefeed-head">
        <span className="omp-section-label">Live output</span>
        <span aria-hidden="true" className="omp-livefeed-dot" data-tone={tone} />
        {streaming && following ? (
          <span className="omp-livefeed-follow" title="Following new worker output">
            live
          </span>
        ) : (
          <span className="omp-hint">{streaming ? "paused" : "settled"}</span>
        )}
        {agent !== undefined && (
          <span className="omp-hint">
            L{agent.lane} · gen {agent.generation} · attempt {agent.attempt}
          </span>
        )}
        <span className="omp-livefeed-log-name omp-ellipsis" title={stream.logName ?? undefined}>
          {stream.logName ?? "no worker log yet"}
          {stream.lines.length > 0 ? ` · ${stream.lines.length} lines` : ""}
        </span>
        <button
          type="button"
          className="omp-livefeed-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
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
            ? "worker started — lines appear once it writes"
            : slice.reason
              ? `no worker output · ${slice.reason}`
              : "no worker output recorded for this slice"}
        </p>
      )}

      {rows.length > 0 && (
        <div
          ref={bodyRef}
          className="omp-code omp-livefeed-log"
          role="log"
          aria-label={`Worker output — ${slice.id}${expanded ? "" : " (latest lines)"}`}
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
          {motion.leave.map((entry) => (
            <StreamRow key={`leave:${entry.key}`} entry={entry} motion="leave" />
          ))}
          {rows.map((entry) => (
            <StreamRow
              key={entry.key}
              entry={entry}
              motion={motion.enter.includes(entry.key) ? "enter" : undefined}
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
            {capped ? `last ${stream.lines.length} lines` : `${stream.lines.length} lines`} · raw worker log · following{" "}
            {follow ? "on" : "off"}
            {slice.status === "running" || slice.status === "verifying" ? " · refreshing every 2s" : ""}
          </span>
        </p>
      )}
    </section>
  );
}
