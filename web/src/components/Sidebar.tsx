import type { CSSProperties } from "react";
import { LuBot, LuChartColumn, LuLayers, LuLayoutDashboard, LuRoute } from "react-icons/lu";
import type { IconType } from "react-icons";

export type View = "overview" | "runs" | "roadmap" | "agents" | "stats";

interface ViewDef {
  id: View;
  label: string;
  icon: IconType;
  /** Navigation identity color — per-item, never reused across items. */
  color: string;
  dim: string;
}

export const VIEWS: ViewDef[] = [
  { id: "overview", label: "Overview", icon: LuLayoutDashboard, color: "var(--omp-violet)", dim: "var(--omp-violet-dim)" },
  { id: "runs", label: "Runs", icon: LuLayers, color: "var(--omp-cyan)", dim: "var(--omp-cyan-dim)" },
  { id: "roadmap", label: "Roadmap", icon: LuRoute, color: "var(--omp-teal)", dim: "var(--omp-teal-dim)" },
  { id: "agents", label: "Agents", icon: LuBot, color: "var(--omp-pink)", dim: "var(--omp-pink-dim)" },
  { id: "stats", label: "Stats", icon: LuChartColumn, color: "var(--omp-amber)", dim: "var(--omp-amber-dim)" },
];

/**
 * Quiet run-centric rail: five views, no counts, no decorative cards. The
 * current run stays visible at the rail head so navigation never competes
 * with it. Each item owns one category color via `--item-c` / `--item-c-dim`
 * — a single implementation with a color prop, not five variants. Anything
 * that lives on a page (slice counts, agent counts) is shown there, once.
 */
export default function Sidebar({
  view,
  onNavigate,
  runId,
}: {
  view: View;
  onNavigate: (v: View) => void;
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
        const style = { "--item-c": v.color, "--item-c-dim": v.dim } as CSSProperties;
        return (
          <button
            key={v.id}
            className="omp-nav-btn"
            style={style}
            aria-current={view === v.id ? "page" : undefined}
            onClick={() => onNavigate(v.id)}
          >
            <Icon aria-hidden="true" className="omp-nav-icon size-[15px] shrink-0" strokeWidth={2} />
            <span className="omp-nav-label">{v.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
