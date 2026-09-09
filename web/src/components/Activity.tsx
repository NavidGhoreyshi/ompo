import { useMemo, useState } from "react";
import type { RunEvent } from "../api.ts";
import {
  ACTIVITY_FILTERS,
  describeEvent,
  eventLane,
  eventLaneLabel,
  eventMatchesQuery,
  formatEventTime,
  type ActivityFilter,
} from "../lib/events.ts";
import Terminal from "./Terminal.tsx";

type PanelView = "activity" | "terminal";

/**
 * Bottom activity strip: the live browser event stream. Rows show timestamp,
 * lane/worker, event type, slice, and concise details; lane chips plus a
 * text search narrow the stream. The events prop is SSE-owned (App appends
 * live frames with a polling fallback), so the stream updates automatically.
 * The raw Terminal view sits one tab over, secondary by default.
 */
export default function Activity({ events }: { events: RunEvent[] }) {
  const [view, setView] = useState<PanelView>("activity");
  const [filter, setFilter] = useState<ActivityFilter>("All");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const lane = filter.toLowerCase();
    return events
      .filter((e) => (filter === "All" || eventLane(e) === lane) && eventMatchesQuery(e, query))
      .slice(-100)
      .reverse();
  }, [events, filter, query]);

  return (
    <footer className="omp-activity" aria-label="Activity">
      <div className="omp-activity-inner">
        <div className="omp-activity-head">
          <h2>Activity</h2>
          <div className="omp-filter-chips" role="tablist" aria-label="Activity views">
            <button
              type="button"
              className="omp-chip"
              role="tab"
              aria-selected={view === "activity"}
              aria-pressed={view === "activity"}
              onClick={() => setView("activity")}
            >
              Activity
            </button>
            <button
              type="button"
              className="omp-chip"
              role="tab"
              aria-selected={view === "terminal"}
              aria-pressed={view === "terminal"}
              onClick={() => setView("terminal")}
            >
              Terminal
            </button>
          </div>
          <span className="omp-hint">
            {view === "activity"
              ? `${filtered.length} of ${events.length} events · live via SSE · newest first`
              : "raw view · structured stream stays on Activity"}
          </span>
        </div>

        {view === "terminal" ? (
          <Terminal events={events} />
        ) : (
          <>
            <div className="omp-controls">
              <div className="omp-filter-chips" role="group" aria-label="Filter events by lane">
                {ACTIVITY_FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="omp-chip"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <input
                className="omp-input"
                type="search"
                placeholder="Search events..."
                aria-label="Search events"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <ul className="omp-activity-list">
              {filtered.map((e) => {
                const lane = eventLane(e);
                const detail = describeEvent(e);
                return (
                  <li key={e.seq} title={`${e.at} ${e.type}\n${e.reason ?? ""}\n${e.detail ?? ""}`}>
                    <span className="omp-activity-time">{formatEventTime(e.at)}</span>
                    <span className="omp-activity-lane" data-lane={lane}>
                      {eventLaneLabel(e)}
                    </span>
                    <span className="omp-activity-type">{e.type}</span>
                    <span className="omp-activity-slice">{e.sliceId ?? "—"}</span>
                    <span className="omp-activity-line">{detail || "—"}</span>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li>
                  <span className="omp-activity-line">
                    {events.length === 0 ? "no events yet" : "no events match this filter"}
                  </span>
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </footer>
  );
}
