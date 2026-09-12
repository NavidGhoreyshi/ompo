import type { SliceDetail, SliceSummary } from "../api.ts";
import { formatDurationMs, formatTokens } from "./format.ts";

export type StageState = "done" | "running" | "fail" | "pending";

export interface PipelineStage {
  /** "Claim" */
  label: string;
  /** "attempt 4" — the stage's own detail, keeps top-level labels uncluttered. */
  sublabel: string;
  state: StageState;
}

type TraceState = "done" | "active" | "failed" | "waiting";

function toStageState(s: TraceState): StageState {
  switch (s) {
    case "done":
      return "done";
    case "active":
      return "running";
    case "failed":
      return "fail";
    default:
      return "pending";
  }
}

/**
 * Single derivation for the slice pipeline, shared by the hero's horizontal
 * rail and the inspector's vertical checklist. Observed state only — never
 * predicted progress. Mirrors the CLAIM → … → DONE sequence.
 */
export function buildPipelineStages(
  selected: SliceSummary,
  detail: SliceDetail | null,
): PipelineStage[] {
  const claimed = selected.attempts > 0;
  const active = selected.status === "running" || selected.status === "verifying";
  const gens = detail?.generations ?? [];
  const genCount = Math.max(selected.generation + (claimed ? 1 : 0), gens.length, claimed ? 1 : 0);
  const handoffs = Math.max(0, genCount - 1);
  const metrics = detail?.metrics;
  const tokens = metrics?.tokens?.total;
  const steps = detail?.verdictSteps ?? [];
  const failedStep = steps.find((s) => s.exit !== 0);
  const verifyState: TraceState =
    detail?.verdictPass === true
      ? "done"
      : failedStep || detail?.verdictPass === false
        ? "failed"
        : steps.length > 0
          ? "active"
          : selected.status === "verifying"
            ? "active"
            : "waiting";
  const reviewState: TraceState = detail?.review
    ? detail.review.approved
      ? "done"
      : "failed"
    : "waiting";
  const doneState: TraceState =
    selected.status === "done"
      ? "done"
      : selected.status === "failed" || selected.status === "aborted"
        ? "failed"
        : "waiting";

  const raw: { name: string; state: TraceState; note: string }[] = [
    {
      name: "Claim",
      // Claiming is atomic: observed once, it is behind us. Its own detail
      // keeps the attempt number; the halo belongs to the live phases.
      state: claimed ? "done" : "waiting",
      note: claimed ? `attempt ${selected.attempts}` : "unclaimed",
    },
    {
      name: "Generation",
      // A generation is in flight only while the slice is: a finished slice
      // must never show its generation still running.
      state: genCount > 1 ? "done" : active ? "active" : claimed ? "done" : "waiting",
      note: `gen ${selected.generation}${handoffs > 0 ? ` · ${handoffs} handoff${handoffs === 1 ? "" : "s"}` : ""}`,
    },
    {
      name: "Work",
      state: metrics ? "done" : active ? "active" : "waiting",
      note: metrics
        ? `${metrics.turns} turns · ${metrics.tools} tools · ${formatDurationMs(metrics.durationMs)}${typeof tokens === "number" ? ` · ${formatTokens(tokens)}` : ""}`
        : active
          ? "working…"
          : "no worker yet",
    },
    {
      name: "Handoff",
      state: handoffs > 0 ? "done" : active && selected.generation > 0 ? "active" : "waiting",
      note: handoffs > 0 ? `${handoffs} context handoff${handoffs === 1 ? "" : "s"}` : "no handoff",
    },
    {
      name: "Verify",
      state: verifyState,
      note:
        detail?.verdictPass === true
          ? "all gates passed"
          : failedStep
            ? `! ${failedStep.name}`
            : steps.length > 0
              ? `${steps.length} gate${steps.length === 1 ? "" : "s"} ran`
              : selected.status === "verifying"
                ? "gates running…"
                : "gates pending",
    },
    {
      name: "Review",
      state: reviewState,
      note: detail?.review
        ? detail.review.approved
          ? `approved${detail.review.findings.length > 0 ? ` · ${detail.review.findings.length} nit${detail.review.findings.length === 1 ? "" : "s"}` : ""}`
          : `${detail.review.findings.length} finding${detail.review.findings.length === 1 ? "" : "s"}`
        : "no review yet",
    },
    { name: "Done", state: doneState, note: selected.status },
  ];

  return raw.map((s) => ({ label: s.name, sublabel: s.note, state: toStageState(s.state) }));
}

/**
 * The stage the slice is in: the furthest observed live stage — the last
 * running one, else the last failure, else the last completed stage. Taking
 * the *last* active stage matters: Claim/Generation/Work can all read as live
 * at once while a worker runs, and the spine must lead with Work (or Verify),
 * not with the phase the slice entered first. -1 means no observed phase.
 */
export function currentStageIndex(stages: PipelineStage[]): number {
  for (let i = stages.length - 1; i >= 0; i--) if (stages[i]!.state === "running") return i;
  for (let i = stages.length - 1; i >= 0; i--) if (stages[i]!.state === "fail") return i;
  let lastDone = -1;
  stages.forEach((s, i) => {
    if (s.state === "done") lastDone = i;
  });
  return lastDone;
}
