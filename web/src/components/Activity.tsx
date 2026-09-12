import { useMemo, useState } from "react";
import { LuChevronDown, LuChevronUp, LuSearch } from "react-icons/lu";
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
import { LaneSymbol } from "./icons.tsx";
import Terminal from "./Terminal.tsx";

type PanelView = "activity" | "terminal";

/** Rows previewed in the collapsed bar. */
const PEEK_ROWS = 3;

/** Timestamp, lane (glyph + label + attempt), and type — both views share them. */
function EventMeta({ event }: { event: RunEvent }) {
  const lane = eventLane(event);
  return (
    <>
      <span className="omp-activity-time">{formatEventTime(event.at)}</span>
      <span className="omp-activity-lane" data-lane={lane}>
        <span aria-hidden="true" className="omp-lane-glyph">
          <LaneSymbol lane={lane} />
        </span>
        {eventLaneLabel(event)}
      </span>
      <span className="omp-activity-type">{event.type}</span>
    </>
  );
}

/**
 * Activity: the run's event stream, present but not in the way.
 *
 * Collapsed (default) it is a single strip — how many events, whether the
 * stream is live, and the newest few — so the worker keeps the viewport.
 * Opening it reveals the full stream: lane filters, search, and the raw
 * Terminal view. The events prop is SSE-owned (App appends live frames with a
 * polling fallback), so both states are always current.
 */
export default function Activity({ events, live }: { events: RunEvent[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
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

  const peek = events.slice(-PEEK_ROWS).reverse();

  return (
    <footer className="omp-activity" data-open={open ? "true" : "false"} aria-label="Activity">
      <div className="omp-activity-inner">
        <div className="omp-activity-head">
          <button
            type="button"
            className="omp-activity-toggle"
            aria-expanded={open}
            aria-controls="omp-activity-body"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <LuChevronDown aria-hidden="true" /> : <LuChevronUp aria-hidden="true" />}
            Activity
          </button>
          <span className="omp-hint">
            <strong>{events.length}</strong> event{events.length === 1 ? "" : "s"}
            {live === undefined ? "" : live ? " · live via SSE" : " · settled"}
          </span>

          {!open && (
            <span className="omp-activity-peek">
              {peek.length === 0 ? (
                <span className="omp-hint">no events yet</span>
              ) : (
                peek.map((e) => {
                  const lane = eventLane(e);
                  return (
                    <span key={e.seq} className="omp-activity-peek-row" data-lane={lane} title={`${e.at} ${e.type}\n${describeEvent(e)}`}>
                      <EventMeta event={e} />
                      <span className="omp-activity-peek-detail omp-ellipsis">{describeEvent(e) || e.sliceId || "—"}</span>
                    </span>
                  );
                })
              )}
            </span>
          )}

          {open && (
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
          )}

          {open && (
            <span className="omp-hint">
              {view === "activity"
                ? `${filtered.length} of ${events.length} events · newest first`
                : "raw view · structured stream stays on Activity"}
            </span>
          )}
        </div>

        {open && (
          <div className="omp-activity-body" id="omp-activity-body">
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
                        {f !== "All" && (
                          <span aria-hidden="true" className="omp-chip-glyph">
                            <LaneSymbol lane={f.toLowerCase()} />
                          </span>
                        )}
                        {f}
                      </button>
                    ))}
                  </div>
                  <span className="omp-activity-search">
                    <span aria-hidden="true" className="omp-activity-search-icon">
                      <LuSearch />
                    </span>
                    <input
                      className="omp-input"
                      type="search"
                      placeholder="Search events..."
                      aria-label="Search events"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </span>
                </div>
                <ul className="omp-activity-list">
                  {filtered.map((e) => {
                    const detail = describeEvent(e);
                    return (
                      <li key={e.seq} title={`${e.at} ${e.type}\n${e.reason ?? ""}\n${e.detail ?? ""}`}>
                        <EventMeta event={e} />
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
        )}
      </div>
    </footer>
  );
}
