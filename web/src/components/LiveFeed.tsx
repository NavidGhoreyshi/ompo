import { useEffect, useRef } from "react";
import type { AgentRow, SliceSummary } from "../api.ts";
import { useSliceLog } from "../lib/useSliceLog.ts";
import { StatusSymbol } from "./icons.tsx";
import { toneForStatus } from "./StatusBadge.tsx";

type FeedTagKind = "read" | "shell" | "turn";

function tagForLine(line: string): { tag: string; kind: FeedTagKind } | null {
  const read = line.match(/^\s*(read|glob|grep)\b/i);
  if (read) return { tag: read[1]!.toLowerCase(), kind: "read" };
  if (/^\s*bash\b/i.test(line)) return { tag: "bash", kind: "shell" };
  const turn = line.match(/turn\s+\d+\s+done\b/i);
  if (turn) return { tag: turn[0]!.toLowerCase(), kind: "turn" };
  return null;
}

/**
 * Live worker feed: the TUI-equivalent stream, front and center. Follows the
 * active slice (selection, else the slice that needs eyes): who is working
 * (lane), what turn the session is on (attempt/generation, turns/tools), the
 * worker's latest progress line, and the live tail of its log — the
 * turn-by-turn progress the event stream can't show (events only advance at
 * stage boundaries). Quiescent runs show the settled tail, marked settled;
 * a slice with no log yet says so honestly. Never empty, never estimated.
 *
 * Lines render as index · tag · content: read-type calls (read/glob/grep)
 * in blue, shell calls (bash) in amber, turn markers muted. Tool-type color
 * is categorical, not a run status — the feed and the status pills never
 * share a visual unit.
 */
export default function LiveFeed({
  runId,
  slice,
  agent,
  live,
}: {
  runId: string | null;
  slice: SliceSummary | null;
  agent?: AgentRow;
  live: boolean;
}) {
  const active = slice !== null && (slice.status === "running" || slice.status === "verifying");
  const { name, lines, error, loading } = useSliceLog(runId, slice?.id ?? null, active, 100);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Tail-following: stay pinned to the newest line as polls land.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!slice) {
    return (
      <section className="omp-livefeed" data-live="false" aria-label="Live worker feed">
        <div className="omp-livefeed-head">
          <span className="omp-section-label">Live feed</span>
          <span className="omp-hint">no slices yet</span>
        </div>
      </section>
    );
  }

  const tone = toneForStatus(slice.status);
  const metrics = agent?.metrics;
  const progress =
    metrics !== undefined
      ? `${metrics.turns}t/${metrics.tools}tl`
      : agent !== undefined
        ? `attempt ${agent.attempt} · gen ${agent.generation}`
        : `attempt ${slice.attempts} · gen ${slice.generation}`;
  const lastLine = lines.length > 0 ? lines[lines.length - 1]! : null;

  return (
    <section className="omp-livefeed" data-live={active ? "true" : "false"} aria-label={`Live worker feed — ${slice.id}`}>
      <div className="omp-livefeed-head">
        <span className="omp-section-label">Live feed</span>
        <span aria-hidden="true" className="omp-livefeed-dot" data-tone={tone} />
        <code className="omp-livefeed-id">{slice.id}</code>
        <span className="omp-ellipsis omp-livefeed-title" title={slice.title}>
          {slice.title}
        </span>
        <span aria-hidden="true" className="omp-status-sym" data-tone={tone}>
          <StatusSymbol status={slice.status} />
        </span>
        <span className="omp-board-state" data-tone={tone}>
          {slice.status}
        </span>
        <span className="omp-hint">
          {agent !== undefined ? `L${agent.lane} · ` : ""}
          {progress}
          {" · "}
          {active ? "live (2s poll)" : "settled"}
        </span>
      </div>
      {agent?.lastLine ? (
        <p className="omp-ellipsis omp-livefeed-latest" title={agent.lastLine}>
          <span className="omp-hint">latest · </span>
          {agent.lastLine}
        </p>
      ) : (
        slice.reason && (
          <p className="omp-ellipsis omp-livefeed-latest" title={slice.reason}>
            <span className="omp-hint">reason · </span>
            {slice.reason}
          </p>
        )
      )}
      {loading && <p className="omp-hint">loading worker log…</p>}
      {!loading && error && (
        <p className="omp-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && lines.length === 0 && (
        <p className="omp-hint">
          {active ? "worker started — lines appear once it starts writing" : `no worker lines yet · ${name ?? "no log file"}`}
        </p>
      )}
      {!loading && !error && lastLine !== null && (
        <p className="omp-ellipsis omp-livefeed-latest" data-fresh="true" title={lastLine}>
          <span className="omp-hint">last line · </span>
          {lastLine}
        </p>
      )}
      {!loading && !error && lines.length > 0 && (
        <div
          ref={logRef}
          className="omp-code omp-livefeed-log"
          role="log"
          aria-label={`Worker log tail — ${slice.id}`}
          tabIndex={0}
        >
          {lines.map((line, i) => {
            const tagged = tagForLine(line);
            const fresh = i === lines.length - 1;
            return (
              <div key={`${i}-${line.length}`} className="omp-feed-line" data-fresh={fresh ? "true" : "false"}>
                <span aria-hidden="true" className="omp-feed-idx">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {tagged && (
                  <span className="omp-feed-tag" data-kind={tagged.kind}>
                    {tagged.tag}
                  </span>
                )}
                <span className="omp-feed-text">{line}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
