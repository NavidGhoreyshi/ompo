export type View = "overview" | "runs" | "roadmap" | "agents" | "stats";

export const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "◈" },
  { id: "runs", label: "Runs", icon: "▤" },
  { id: "roadmap", label: "Roadmap", icon: "☰" },
  { id: "agents", label: "Agents", icon: "⚙" },
  { id: "stats", label: "Stats", icon: "∑" },
];

export default function Sidebar({
  view,
  onNavigate,
  counts,
}: {
  view: View;
  onNavigate: (v: View) => void;
  counts: Partial<Record<View, number>>;
}) {
  return (
    <nav className="omp-sidebar" aria-label="Dashboard sections">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          className="omp-nav-btn"
          aria-current={view === v.id ? "page" : undefined}
          onClick={() => onNavigate(v.id)}
        >
          <span aria-hidden="true">{v.icon}</span>
          <span className="omp-nav-label">{v.label}</span>
          {typeof counts[v.id] === "number" && (
            <span className="omp-nav-count">{counts[v.id]}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
