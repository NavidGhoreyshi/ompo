import { useState } from "react";
import { CircleX, TriangleAlert } from "lucide-react";
import type { AgentRow, RunDetail, RunEvent } from "../api.ts";
import Dag from "../components/Dag.tsx";
import RunHeader from "../components/RunHeader.tsx";
import SliceTable from "../components/SliceTable.tsx";
import WorkerLanes from "../components/WorkerLanes.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";

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
        <div className="flex flex-col gap-2" aria-label="Loading run">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
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
          {attention.slice(0, 4).map((s) => {
            const Icon = s.status === "failed" ? CircleX : TriangleAlert;
            return (
              <button key={s.id} type="button" className="omp-attention-link" onClick={() => onInspect(s.id)} title={s.reason ?? s.title}>
                <Icon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />
                {s.id}
              </button>
            );
          })}
          {attention.length > 4 && <span className="omp-hint">+{attention.length - 4} more</span>}
        </p>
      )}
      <Tabs value={mode} onValueChange={(v) => setMode(v as "board" | "dag")}>
        <div className="omp-board-bar">
          <span className="omp-section-label">Execution board — {detail.slices.length} slices</span>
          <TabsList className="omp-tabs" aria-label="Board mode">
            <TabsTrigger value="board" className="omp-tab">
              Board
            </TabsTrigger>
            <TabsTrigger value="dag" className="omp-tab">
              Graph
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="omp-board-scroll">
          <TabsContent value="board">
            <SliceTable slices={detail.slices} selected={selected} onSelect={onInspect} events={events} />
          </TabsContent>
          <TabsContent value="dag">
            <Dag slices={detail.slices} selected={selected} onSelect={onInspect} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
