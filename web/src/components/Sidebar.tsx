import { Bot, ChartColumn, Layers, LayoutDashboard, Route, type LucideIcon } from "lucide-react";

export type View = "overview" | "runs" | "roadmap" | "agents" | "stats";

export const VIEWS: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "runs", label: "Runs", icon: Layers },
  { id: "roadmap", label: "Roadmap", icon: Route },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "stats", label: "Stats", icon: ChartColumn },
];

/**
 * Light run-centric rail: five views, no decorative cards. Overview is the
 * control room; Runs/Roadmap/Agents/Stats are secondary. The current run
 * stays visible at the rail head so navigation never competes with it.
 */
export default function Sidebar({
  view,
  onNavigate,
  counts,
  runId,
}: {
  view: View;
  onNavigate: (v: View) => void;
  counts: Partial<Record<View, number>>;
  runId?: string | null;
}) {
  return (
    <nav className="omp-sidebar" aria-label="Dashboard sections">
      {runId && (
        <p className="omp-sidebar-run" title={`current run ${runId}`}>
          <span className="omp-section-label">Run</span>
          <code className="omp-ellipsis">{runId}</code>
        </p>
      )}
      {VIEWS.map((v) => {
        const Icon = v.icon;
        return (
          <button
            key={v.id}
            className="omp-nav-btn"
            aria-current={view === v.id ? "page" : undefined}
            onClick={() => onNavigate(v.id)}
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="omp-nav-label">{v.label}</span>
            {typeof counts[v.id] === "number" && (
              <span className="omp-nav-count">{counts[v.id]}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
