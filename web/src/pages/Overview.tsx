import { useState } from "react";
import type { AgentRow, RunDetail, RunEvent } from "../api.ts";
import Dag from "../components/Dag.tsx";
import RunHeader from "../components/RunHeader.tsx";
import SliceTable from "../components/SliceTable.tsx";
import WorkerLanes from "../components/WorkerLanes.tsx";

/**
 * Overview workspace: RUN STATUS / BOARD-or-DAG + INSPECTOR (aside, owned
 * by App) / LIVE ACTIVITY (footer, owned by App). This column owns the run
 * strip, worker lanes, and the board — the execution itself, not its
 * accounting. Attention items render as one inline banner, not a side
 * panel competing with the board. The board panel scrolls internally; the
 * page shell never scrolls.
 */
export default function Overview({
  detail,
  events,
  agents,
  selected,
  onInspect,
}: {
  detail: RunDetail | null;
  events: RunEvent[];
  agents: AgentRow[];
  selected?: string | null;
  onInspect: (sliceId: string) => void;
  onNavigate: (v: "overview" | "runs" | "roadmap" | "agents" | "stats") => void;
}) {
  const [mode, setMode] = useState<"board" | "dag">("board");

  if (!detail) {
    return (
      <div className="omp-workspace" aria-label="Overview workspace">
        <p className="omp-hint">Loading run…</p>
      </div>
    );
  }

  const attention = detail.slices.filter((s) => s.status === "failed" || s.status === "blocked-env");

  return (
    <div className="omp-workspace" aria-label="Overview workspace">
      <RunHeader detail={detail} events={events} agents={agents} activeId={selected} />
      <WorkerLanes agents={agents} live={detail.live} selected={selected} onSelect={onInspect} />
      {attention.length > 0 && (
        <p className="omp-attention" role="alert">
          <strong>
            {attention.length} need{attention.length === 1 ? "s" : ""} attention
          </strong>{" "}
          {attention.slice(0, 4).map((s) => (
            <button key={s.id} type="button" className="omp-attention-link" onClick={() => onInspect(s.id)} title={s.reason ?? s.title}>
              {s.status === "failed" ? "✕" : "▲"} {s.id}
            </button>
          ))}
          {attention.length > 4 && <span className="omp-hint">+{attention.length - 4} more</span>}
        </p>
      )}
      <div className="omp-board-bar">
        <span className="omp-section-label">Execution board — {detail.slices.length} slices</span>
        <div className="omp-tabs" role="tablist" aria-label="Board mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "board"}
            className="omp-tab"
            data-active={mode === "board" ? "true" : "false"}
            onClick={() => setMode("board")}
          >
            Board
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "dag"}
            className="omp-tab"
            data-active={mode === "dag" ? "true" : "false"}
            onClick={() => setMode("dag")}
          >
            Graph
          </button>
        </div>
      </div>
      <div className="omp-board-scroll">
        {mode === "board" ? (
          <SliceTable slices={detail.slices} selected={selected} onSelect={onInspect} events={events} />
        ) : (
          <Dag slices={detail.slices} selected={selected} onSelect={onInspect} />
        )}
      </div>
    </div>
  );
}
