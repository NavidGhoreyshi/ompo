import type { SliceDetail, SliceSummary } from "../api.ts";
import { buildPipelineStages } from "../lib/pipeline.ts";
import PipelineStepper from "./PipelineStepper.tsx";

/**
 * Compact execution lifecycle for the active slice — observed state only,
 * never predicted progress:
 * CLAIM → GENERATION → WORK → HANDOFF → VERIFY → REVIEW → DONE.
 * Vertical mirror of the hero's horizontal rail: same `PipelineStage[]`
 * data via `buildPipelineStages`, rendered through the shared
 * `PipelineStepper` so both presentations stay in lockstep.
 */
export default function ExecutionTrace({
  selected,
  detail,
}: {
  selected: SliceSummary;
  detail: SliceDetail | null;
}) {
  const stages = buildPipelineStages(selected, detail);
  return <PipelineStepper stages={stages} variant="vertical" label="Execution lifecycle" />;
}
