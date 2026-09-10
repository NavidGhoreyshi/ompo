import { LuChevronDown, LuPanelLeft } from "react-icons/lu";
import type { RunSummary } from "../api.ts";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

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
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
        aria-expanded={!sidebarCollapsed}
        title={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
      >
        <LuPanelLeft aria-hidden="true" />
      </Button>
      <span className="omp-brand">
        <span className="omp-brand-mark" aria-hidden="true">
          <svg viewBox="0 0 14 14" focusable="false" aria-hidden="true">
            <path
              d="M4 2.5 9.5 7 4 11.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="omp-brand-name">ompo dashboard</span>
      </span>
      <span className="omp-live" data-live={live ? "true" : "false"} title={live ? "Live run (loop holds the lock)" : "Quiescent run"}>
        <span className="omp-live-dot" aria-hidden="true" />
        {live ? "live" : "quiescent"}
      </span>
      <div className="omp-header-run">
        {version && <span className="omp-version">server {version}</span>}
        <label className="omp-run-picker-label flex items-center gap-1.5">
          <span className="omp-hint">run </span>
          <Select value={runId ?? ""} onValueChange={onSelectRun}>
            <SelectTrigger size="sm" className="omp-run-picker w-44" aria-label="Select run">
              <span aria-hidden="true" className="omp-run-picker-dot" data-live={live ? "true" : "false"} />
              <SelectValue placeholder="select run" />
              <LuChevronDown aria-hidden="true" className="omp-run-picker-chevron size-3.5 shrink-0" />
            </SelectTrigger>
            <SelectContent>
              {runs.map((r) => (
                <SelectItem key={r.runId} value={r.runId}>
                  <span className="flex items-center gap-1.5">
                    {r.live && (
                      <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-info" />
                    )}
                    <span className="font-mono text-xs">{r.runId}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
    </header>
  );
}
