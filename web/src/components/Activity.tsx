import type { RunEvent } from "../api.ts";

/** Bottom activity strip: live event tail (SSE-owned, polling fallback). */
export default function Activity({ events }: { events: RunEvent[] }) {
  const tail = events.slice(-40).reverse();
  return (
    <footer className="omp-activity" aria-label="Activity">
      <div className="omp-activity-inner">
        <div className="omp-activity-head">
          <h2>Activity</h2>
          <span className="omp-hint">{events.length} events in buffer · newest first</span>
        </div>
        <ul className="omp-activity-list">
          {tail.map((e) => (
            <li key={e.seq} title={`${e.at} ${e.type}`}>
              <span className="omp-activity-seq">#{e.seq}</span>
              <span className="omp-activity-type">{e.type}</span>
              <span className="omp-activity-line">
                {[e.sliceId ? `${e.sliceId}` : null, e.reason ?? e.detail ?? null]
                  .filter(Boolean)
                  .join(" — ")}
              </span>
            </li>
          ))}
          {tail.length === 0 && <li><span className="omp-activity-line">no events yet</span></li>}
        </ul>
      </div>
    </footer>
  );
}
