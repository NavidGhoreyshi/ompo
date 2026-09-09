import { useMemo } from "react";
import type { RunEvent } from "../api.ts";

/**
 * Terminal: the raw worker/command view. One untruncated line per event
 * (newest first) with the full payload behind a tooltip — deliberately
 * secondary to the structured Activity stream, which stays the default tab.
 */
export default function Terminal({ events }: { events: RunEvent[] }) {
  const lines = useMemo(() => events.slice(-100).reverse().map(rawLine), [events]);
  return (
    <div className="omp-terminal" aria-label="Terminal">
      <p className="omp-hint">
        Raw worker/command stream — secondary to the structured Activity view.{" "}
        {events.length} event{events.length === 1 ? "" : "s"} in buffer · newest first
      </p>
      {lines.length > 0 ? (
        <pre className="omp-code omp-terminal-log" aria-label="Raw event log" tabIndex={0}>
          {lines.join("\n")}
        </pre>
      ) : (
        <p className="omp-hint">no events yet</p>
      )}
    </div>
  );
}

/** Single raw line: every field the event carries, nothing truncated. */
function rawLine(e: RunEvent): string {
  const head = [
    `#${e.seq}`,
    e.at,
    e.type,
    e.sliceId ?? "-",
    e.attempt !== undefined ? `#${e.attempt}` : null,
    e.reason ? `reason=${e.reason}` : null,
    e.exit !== undefined && e.exit !== null ? `exit=${e.exit}` : null,
    e.timedOut ? "timedOut" : null,
    typeof e.durationMs === "number" ? `${Math.round(e.durationMs)}ms` : null,
  ]
    .filter((p): p is string => p !== null)
    .join(" ");
  return e.detail ? `${head} :: ${e.detail}` : head;
}
