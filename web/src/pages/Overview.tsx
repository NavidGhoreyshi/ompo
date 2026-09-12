import { useState } from "react";
import { LuCircleX, LuTriangleAlert } from "react-icons/lu";
import type { AgentRow, OperatorSession, RunDetail, RunEvent } from "../api.ts";
import ActiveExecution from "../components/ActiveExecution.tsx";
import Dag from "../components/Dag.tsx";
import RunHeader from "../components/RunHeader.tsx";
import SessionsPanel from "../components/SessionsPanel.tsx";
import SliceTable from "../components/SliceTable.tsx";
import WorkerLanes from "../components/WorkerLanes.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { preferredSliceId } from "../lib/selection.ts";

type WorkspaceMode = "board" | "dag" | "agents";

const MODES: readonly { id: WorkspaceMode; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "dag", label: "DAG" },
  { id: "agents", label: "Agents" },
];

/**
 * Overview workspace — one desktop-sized operating surface, top to bottom:
 *
 *   1. run hero (which run, which slice, what it is on, quiet telemetry)
 *   2. active execution (the protagonist: spine + live worker output)
 *   3. supporting workspace (Board | DAG | Agents over the same selection)
 *
 * The page never grows: the workspace fills the viewport, each region scrolls
 * internally. Forensics, activity, and control are one click away in the
 * Inspector drawer and the Activity bar instead of competing with the worker
 * for the primary viewport.
 */
export default function Overview({
  detail,
  events,
  agents,
  sessions,
  selected,
  onInspect,
  onOpenInspector,
}: {
  detail: RunDetail | null;
  events: RunEvent[];
  agents: AgentRow[];
  sessions: OperatorSession[];
  selected?: string | null;
  onInspect: (sliceId: string) => void;
  onOpenInspector: () => void;
}) {
  const [mode, setMode] = useState<WorkspaceMode>("board");

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

  // The live region follows the selection so picking a board row or a lane
  // retargets it; with nothing selected it follows the slice that needs eyes
  // — the same slice the hero leads with. One selection system, no second
  // ranking (see lib/selection.ts).
  const activeId = selected ?? preferredSliceId(detail.slices);
  const active = detail.slices.find((s) => s.id === activeId) ?? null;
  const agent = active ? agents.find((a) => a.id === active.id) : undefined;
  const attention = detail.slices.filter((s) => s.status === "failed" || s.status === "blocked-env");
  const extraLoops = (detail.loops ?? []).filter((l) => !l.lockOwner);
  const loopOwner = detail.loops?.find((l) => l.lockOwner)?.pid;

  return (
    <div className="omp-workspace" aria-label="Overview workspace">
      <RunHeader detail={detail} events={events} agents={agents} activeId={selected} />

      {attention.length > 0 && (
        <p className="omp-attention" role="alert">
          <strong>
            {attention.length} need{attention.length === 1 ? "s" : ""} attention
          </strong>{" "}
          {attention.slice(0, 4).map((s) => {
            const Icon = s.status === "failed" ? LuCircleX : LuTriangleAlert;
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

      {extraLoops.length > 0 && (
        <p className="omp-attention" role="alert">
          <strong>{extraLoops.length + 1} loops own this run</strong>
          <span className="omp-hint">
            lock: {loopOwner !== undefined ? `pid ${loopOwner}` : "none"} · extra: {extraLoops.map((l) => `pid ${l.pid}`).join(", ")} —
            two writers corrupt a run. Kill the extra loop process, then resume if quiescent.
          </span>
        </p>
      )}

      {active ? (
        <ActiveExecution
          detail={detail}
          slice={active}
          agent={agent}
          agents={agents}
          events={events}
          onInspect={onInspect}
          onOpenInspector={onOpenInspector}
        />
      ) : (
        <p className="omp-hint">No slices yet — the run has no roadmap to execute.</p>
      )}

      <section className="omp-modes" aria-label="Supporting workspace">
        <Tabs
          value={mode}
          onValueChange={(v) => setMode(v as WorkspaceMode)}
          className="omp-modes-tabs"
        >
          <div className="omp-modes-bar">
            <TabsList className="omp-modes-list" aria-label="Workspace mode">
              {MODES.map((m) => (
                <TabsTrigger key={m.id} value={m.id} className="omp-mode-tab">
                  {m.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <span className="omp-hint">
              {mode === "board"
                ? `${detail.slices.length} slices · attempt, generation, worker`
                : mode === "dag"
                  ? "dependency order · blocked edges marked"
                  : "live workers · operator sessions"}
            </span>
          </div>
          <TabsContent value="board" className="omp-modes-body">
            <SliceTable slices={detail.slices} selected={selected} onSelect={onInspect} events={events} agents={agents} />
          </TabsContent>
          <TabsContent value="dag" className="omp-modes-body">
            <Dag slices={detail.slices} selected={selected} onSelect={onInspect} />
          </TabsContent>
          <TabsContent value="agents" className="omp-modes-body">
            <WorkerLanes agents={agents} live={detail.live} selected={selected} onSelect={onInspect} />
            <SessionsPanel runId={detail.runId} sessions={sessions} />
          </TabsContent>
        </Tabs>
      </section>
    </div>
  );
}
