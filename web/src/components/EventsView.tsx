import { useEffect, useMemo, useState } from "react";
import { api, type RunEvent, type SliceDetail } from "../api.ts";

function hhmmss(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function eventText(e: RunEvent): string {
  return [e.type, e.reason ?? "", e.detail ?? ""].join(" ").toLowerCase();
}

/**
 * Events tab: slice-specific events, searchable by text and filterable by
 * type. Fetches structured events; falls back to the inspector's formatted
 * recent/history lines when the fetch fails or is empty.
 */
export default function EventsView({
  runId,
  sliceId,
  detail,
}: {
  runId: string;
  sliceId: string;
  detail: SliceDetail | null;
}) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .events(runId, -1, 200, { sliceId })
      .then((r) => {
        if (live) setEvents(r.events);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [runId, sliceId]);

  const types = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => (type ? e.type === type : true) && (!q || eventText(e).includes(q)));
  }, [events, query, type]);

  const fallback = [...(detail?.recentEvents ?? []), ...(detail?.history ?? [])];

  return (
    <div aria-label="Events">
      <div className="omp-controls">
        <input
          className="omp-input"
          type="search"
          placeholder="search events…"
          aria-label="Search slice events"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="omp-select" aria-label="Filter by event type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">all types</option>
          {types.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {loading && <p className="omp-hint">loading events…</p>}
      {!loading && error && (
        <p className="omp-warn">live events unavailable: {error} — showing inspector snapshot</p>
      )}
      {!loading && !error && events.length === 0 && fallback.length === 0 && (
        <p className="omp-hint">no events yet</p>
      )}
      {filtered.length > 0 && (
        <p className="omp-hint">
          {filtered.length} of {events.length} event{events.length === 1 ? "" : "s"} · newest first
        </p>
      )}
      {filtered.length > 0 && (
        <ul className="omp-list">
          {[...filtered].reverse().map((e) => (
            <li key={e.seq} className="omp-list-item" title={e.at}>
              <code>#{e.seq}</code>
              <span>{hhmmss(e.at)} {e.type}</span>
              <span className="omp-list-reason">
                {[e.attempt !== undefined ? `#${e.attempt}` : null, e.reason ?? e.detail ?? null]
                  .filter(Boolean)
                  .join(" — ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!loading && filtered.length === 0 && events.length > 0 && (
        <p className="omp-hint">no events match this filter</p>
      )}
      {(!loading && (error || events.length === 0) && fallback.length > 0) && (
        <ul className="omp-list">
          {fallback
            .filter((line) => {
              const q = query.trim().toLowerCase();
              return (!type || line.includes(type)) && (!q || line.toLowerCase().includes(q));
            })
            .map((line, i) => (
              <li key={i} className="omp-list-item">
                <span className="omp-list-reason">{line}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
