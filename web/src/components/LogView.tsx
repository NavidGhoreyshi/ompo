import { useEffect, useRef } from "react";
import { LANE_LABEL } from "../lib/stream.ts";
import { useSliceLog } from "../lib/useSliceLog.ts";

/**
 * Log tab: live tail of the slice's active stage transcript — the worker's
 * generation log, the reviewer's audit, or the running verify gate (the
 * server serves whichever lane wrote last). Polling lives in `useSliceLog`
 * (shared with the overview LiveFeed) — this tab is the per-slice deep view,
 * the feed is the always-visible one. The TUI needs no such tab: it streams
 * every lane to the terminal.
 */
export default function LogView({
  runId,
  sliceId,
  active,
}: {
  runId: string;
  sliceId: string;
  /** True while the slice is running/verifying: poll for new lines. */
  active: boolean;
}) {
  const { name, lane, lines, error, loading } = useSliceLog(runId, sliceId, active, 100);
  const preRef = useRef<HTMLPreElement | null>(null);

  // Tail-following: stay pinned to the newest line as polls land.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div aria-label="Log">
      <h3>
        {lane === null ? "Stage log" : `${LANE_LABEL[lane]} log`}{" "}
        <span className="omp-hint">
          · {name ?? "no transcript yet"} · {active ? "live (2s poll)" : "settled"}
        </span>
      </h3>
      {loading && <p className="omp-hint">loading log…</p>}
      {!loading && error && (
        <p className="omp-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && lines.length === 0 && (
        <p className="omp-hint">no transcript lines yet — output appears once the active stage writes</p>
      )}
      {!loading && !error && lines.length > 0 && (
        <pre ref={preRef} className="omp-code" style={{ maxHeight: 320, overflow: "auto" }}>
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
