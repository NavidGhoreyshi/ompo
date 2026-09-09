import type { SliceDetail, SliceSummary } from "../api.ts";
import { TraceSymbol } from "./icons.tsx";
import { formatDurationMs, formatTokens } from "../lib/format.ts";

/**
 * Compact execution lifecycle for the active slice — observed state only,
 * never predicted progress:
 * CLAIM → GENERATION → WORK → HANDOFF → VERIFY → REVIEW → DONE.
 * Each stage shows done (✓), active (●), or waiting (○) derived from the
 * selected slice summary plus its capped detail (metrics, generations,
 * verdict steps, review). Handoff/generation counts come from the
 * authoritative per-generation spend list.
 */
export default function ExecutionTrace({
  selected,
  detail,
}: {
  selected: SliceSummary;
  detail: SliceDetail | null;
}) {
  const claimed = selected.attempts > 0;
  const active = selected.status === "running" || selected.status === "verifying";
  const gens = detail?.generations ?? [];
  const genCount = Math.max(selected.generation + (claimed ? 1 : 0), gens.length, claimed ? 1 : 0);
  const handoffs = Math.max(0, genCount - 1);
  const metrics = detail?.metrics;
  const tokens = metrics?.tokens?.total;
  const steps = detail?.verdictSteps ?? [];
  const failedStep = steps.find((s) => s.exit !== 0);
  const verifyState = detail?.verdictPass === true ? "done" : failedStep || detail?.verdictPass === false ? "failed" : steps.length > 0 ? "active" : selected.status === "verifying" ? "active" : "waiting";
  const reviewState = detail?.review ? (detail.review.approved ? "done" : "failed") : "waiting";
  const doneState = selected.status === "done" ? "done" : selected.status === "failed" || selected.status === "aborted" ? "failed" : "waiting";

  const stages: { name: string; state: string; note: string }[] = [
    { name: "Claim", state: claimed ? (active && selected.attempts <= 1 && genCount <= 1 ? "active" : "done") : "waiting", note: claimed ? `attempt ${selected.attempts}` : "unclaimed" },
    { name: "Generation", state: genCount > 1 ? "done" : claimed ? "active" : "waiting", note: `gen ${selected.generation}${handoffs > 0 ? ` · ${handoffs} handoff${handoffs === 1 ? "" : "s"}` : ""}` },
    {
      name: "Work",
      state: metrics ? "done" : active ? "active" : "waiting",
      note:
        metrics
          ? `${metrics.turns} turns · ${metrics.tools} tools · ${formatDurationMs(metrics.durationMs)}${typeof tokens === "number" ? ` · ${formatTokens(tokens)}` : ""}`
          : active
            ? "working…"
            : "no worker yet",
    },
    { name: "Handoff", state: handoffs > 0 ? "done" : active && selected.generation > 0 ? "active" : "waiting", note: handoffs > 0 ? `${handoffs} context handoff${handoffs === 1 ? "" : "s"}` : "no handoff" },
    {
      name: "Verify",
      state: verifyState,
      note: detail?.verdictPass === true ? "all gates passed" : failedStep ? `✕ ${failedStep.name}` : steps.length > 0 ? `${steps.length} gate${steps.length === 1 ? "" : "s"} ran` : selected.status === "verifying" ? "gates running…" : "gates pending",
    },
    {
      name: "Review",
      state: reviewState,
      note: detail?.review ? (detail.review.approved ? `approved${detail.review.findings.length > 0 ? ` · ${detail.review.findings.length} nit${detail.review.findings.length === 1 ? "" : "s"}` : ""}` : `${detail.review.findings.length} finding${detail.review.findings.length === 1 ? "" : "s"}`) : "no review yet",
    },
    { name: "Done", state: doneState, note: selected.status },
  ];

  return (
    <ol className="omp-trace" aria-label="Execution lifecycle">
      {stages.map((s) => (
        <li key={s.name} className="omp-trace-step" data-state={s.state}>
          <span aria-hidden="true" className="omp-trace-sym">
            <TraceSymbol state={s.state} />
          </span>
          <span className="omp-trace-name">{s.name}</span>
          <span className="omp-hint">{s.note}</span>
        </li>
      ))}
    </ol>
  );
}
