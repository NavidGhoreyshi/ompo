import type { AgentRow, RunDetail, RunEvent, SliceSummary } from "../api.ts";
import { buildPipelineStages } from "../lib/pipeline.ts";
import LiveFeed from "./LiveFeed.tsx";
import PipelineStepper from "./PipelineStepper.tsx";
import WorkerLanes from "./WorkerLanes.tsx";

/**
 * The active execution region — the Overview's protagonist.
 *
 * One region answers "what is running right now": which worker is focused
 * (compact lanes when several are live), where the slice is in its lifecycle
 * (the execution spine, current phase dominant), and the worker's live output
 * (compact window, expandable). Everything is observed state — the spine only
 * shows stages that actually happened, and the lanes only list workers the
 * server reported.
 *
 * The Inspector stays one click away instead of occupying the region: deeper
 * output, diff, gates, review, and control live there, on demand.
 */
export default function ActiveExecution({
  detail,
  slice,
  agent,
  agents,
  events,
  onInspect,
  onOpenInspector,
}: {
  detail: RunDetail;
  slice: SliceSummary;
  agent?: AgentRow;
  agents: AgentRow[];
  events: RunEvent[];
  onInspect: (sliceId: string) => void;
  onOpenInspector: () => void;
}) {
  const stages = buildPipelineStages(slice, null);

  return (
    <section className="omp-exec" aria-label={`Active execution — ${slice.id}`}>
      <div className="omp-exec-bar">
        <span className="omp-section-label">Active execution</span>
        {agents.length > 1 && (
          <WorkerLanes agents={agents} selected={slice.id} onSelect={onInspect} dense />
        )}
        <button type="button" className="omp-exec-inspect" onClick={onOpenInspector}>
          Inspect slice
        </button>
      </div>
      <PipelineStepper stages={stages} variant="horizontal" label="Execution lifecycle" />
      <LiveFeed runId={detail.runId} slice={slice} agent={agent} events={events} />
    </section>
  );
}
