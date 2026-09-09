import type { RunDetail, RunEvent } from "../api.ts";
import RunHeader from "../components/RunHeader.tsx";
import SliceTable from "../components/SliceTable.tsx";
import StatusBadge from "../components/StatusBadge.tsx";
import type { View } from "../components/Sidebar.tsx";

export default function Overview({
  detail,
  events,
  selected,
  onInspect,
  onNavigate,
}: {
  detail: RunDetail | null;
  events: RunEvent[];
  selected?: string | null;
  onInspect: (sliceId: string) => void;
  onNavigate: (v: View) => void;
}) {
  if (!detail) {
    return (
      <section className="omp-panel" aria-label="Overview">
        <h2>Overview</h2>
        <p className="omp-hint">Loading run…</p>
      </section>
    );
  }

  const attention = detail.slices.filter((s) => s.status === "failed" || s.status === "blocked-env");
  const upNext = detail.slices.filter((s) => s.status === "pending").slice(0, 8);
  const recent = events.slice(-8).reverse();

  return (
    <>
      <RunHeader detail={detail} events={events} />

      <SliceTable slices={detail.slices} selected={selected} onSelect={onInspect} events={events} />

      <section className="omp-panel" aria-label="Needs attention">
        <h2>Needs attention ({attention.length})</h2>
        {attention.length === 0 ? (
          <p className="omp-hint">Nothing failed or blocked.</p>
        ) : (
          <ul className="omp-list">
            {attention.map((s) => (
              <li key={s.id} className="omp-list-item" onClick={() => onInspect(s.id)}>
                <code>{s.id}</code>
                <StatusBadge status={s.status} />
                <span className="omp-list-reason">{s.reason ?? s.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <section className="omp-panel" aria-label="Up next">
          <h2>Up next</h2>
          {upNext.length === 0 ? (
            <p className="omp-hint">No pending slices.</p>
          ) : (
            <ul className="omp-list">
              {upNext.map((s) => (
                <li key={s.id} className="omp-list-item" onClick={() => onInspect(s.id)}>
                  <code>{s.id}</code>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="omp-panel" aria-label="Latest events">
          <h2>Latest events</h2>
          {recent.length === 0 ? (
            <p className="omp-hint">No events yet.</p>
          ) : (
            <ul className="omp-list">
              {recent.map((e) => (
                <li key={e.seq} className="omp-list-item" onClick={() => e.sliceId && onInspect(e.sliceId)}>
                  <code>#{e.seq}</code>
                  <span>{e.type}</span>
                  <span className="omp-list-reason">{e.sliceId ?? e.reason ?? ""}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="omp-hint">
        <button className="omp-btn" onClick={() => onNavigate("roadmap")}>Open roadmap</button>{" "}
        <button className="omp-btn" onClick={() => onNavigate("stats")}>View stats</button>
      </p>
    </>
  );
}
