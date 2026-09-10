import { useEffect, useRef } from "react";
import { useSliceLog } from "../lib/useSliceLog.ts";

/**
 * Log tab: live tail of the current generation's worker log (`ompo logs`
 * parity for the browser). Polling lives in `useSliceLog` (shared with the
 * overview LiveFeed) — this tab is the per-slice deep view, the feed is the
 * always-visible one. The TUI needs no such tab: it streams the worker to
 * the terminal.
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
  const { name, lines, error, loading } = useSliceLog(runId, sliceId, active, 100);
  const preRef = useRef<HTMLPreElement | null>(null);

  // Tail-following: stay pinned to the newest line as polls land.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div aria-label="Log">
      <h3>
        Worker log{" "}
        <span className="omp-hint">
          · {name ?? "no log yet"} · {active ? "live (2s poll)" : "settled"}
        </span>
      </h3>
      {loading && <p className="omp-hint">loading log…</p>}
      {!loading && error && (
        <p className="omp-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && lines.length === 0 && (
        <p className="omp-hint">no worker lines yet — output appears once the worker starts writing</p>
      )}
      {!loading && !error && lines.length > 0 && (
        <pre ref={preRef} className="omp-code" style={{ maxHeight: 320, overflow: "auto" }}>
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
