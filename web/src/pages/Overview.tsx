 import { LuCircleX, LuTriangleAlert } from "react-icons/lu";
 import type { AgentRow, OperatorSession, RunDetail, RunEvent } from "../api.ts";
 import LiveFeed from "../components/LiveFeed.tsx";
 import RunHeader from "../components/RunHeader.tsx";
 import SessionsPanel from "../components/SessionsPanel.tsx";
 import SliceTable from "../components/SliceTable.tsx";
 import WorkerLanes from "../components/WorkerLanes.tsx";
 import { Skeleton } from "../components/ui/skeleton.tsx";
 import { preferredSliceId } from "../lib/selection.ts";

/**
 * Overview workspace: RUN STATUS / LIVE FEED / LANES + BOARD (aside owned
 * by App: Inspector; footer owned by App: Activity). The live worker feed
 * sits front and center under the hero — the TUI-equivalent stream of what
 * the current worker is doing turn by turn. The board below is slice
 * execution states, not a second roadmap: the dependency graph, slice
 * table, and plan preview live in exactly one place (Roadmap view).
 */
 export default function Overview({
   detail,
   events,
   agents,
   sessions,
   selected,
   onInspect,
 }: {
   detail: RunDetail | null;
   events: RunEvent[];
   agents: AgentRow[];
   sessions: OperatorSession[];
   selected?: string | null;
   onInspect: (sliceId: string) => void;
   onNavigate: (v: "overview" | "runs" | "roadmap" | "agents" | "stats") => void;
 }) {
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

  // The feed follows the selection so clicking a board row or lane retargets
  // it; with nothing selected it follows the slice that needs eyes — the
  // same slice the hero leads with.
  const activeId = selected ?? preferredSliceId(detail.slices);
  const active = detail.slices.find((s) => s.id === activeId) ?? null;
  const agent = active ? agents.find((a) => a.id === active.id) : undefined;
  const attention = detail.slices.filter((s) => s.status === "failed" || s.status === "blocked-env");
  const extraLoops = (detail.loops ?? []).filter((l) => !l.lockOwner);
  const loopOwner = detail.loops?.find((l) => l.lockOwner)?.pid;
  return (
    <div className="omp-workspace" aria-label="Overview workspace">
      <RunHeader detail={detail} events={events} agents={agents} activeId={selected} />
      <LiveFeed runId={detail.runId} slice={active} agent={agent} live={detail.live} />
      <SessionsPanel runId={detail.runId} sessions={sessions} />
      <WorkerLanes agents={agents} live={detail.live} selected={selected} onSelect={onInspect} />
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
      <section className="omp-board-panel" aria-label={`Slice board — ${detail.slices.length} slices`}>
        <div className="omp-board-bar">
          <span className="omp-section-label">Board — {detail.slices.length} slices</span>
          <span className="omp-hint">roadmap graph + plan live under Roadmap</span>
        </div>
        <div className="omp-board-scroll">
          <SliceTable slices={detail.slices} selected={selected} onSelect={onInspect} events={events} />
        </div>
      </section>
    </div>
  );
}
