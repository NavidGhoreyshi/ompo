import type { RunSummary } from "../api.ts";

export default function Header({
  runs,
  runId,
  onSelectRun,
  live,
  version,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  runs: RunSummary[];
  runId: string | null;
  onSelectRun: (id: string) => void;
  live: boolean;
  version: string | null;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="omp-header">
      <button
        className="omp-icon-btn"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
        aria-expanded={!sidebarCollapsed}
        title={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
      >
        ☰
      </button>
      <span className="omp-brand">
        <span className="omp-brand-mark" aria-hidden="true">o</span>
        ompo dashboard
      </span>
      <span className="omp-live" data-live={live ? "true" : "false"} title={live ? "Live run (loop holds the lock)" : "Quiescent run"}>
        <span className="omp-live-dot" aria-hidden="true" />
        {live ? "live" : "quiescent"}
      </span>
      <div className="omp-header-run">
        {version && <span className="omp-version">server {version}</span>}
        <label>
          <span className="omp-hint">run </span>
          <select
            className="omp-select"
            value={runId ?? ""}
            onChange={(e) => onSelectRun(e.target.value)}
            aria-label="Select run"
          >
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.runId}{r.live ? " ●live" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}
