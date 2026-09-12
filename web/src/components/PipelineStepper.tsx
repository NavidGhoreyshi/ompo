import { currentStageIndex, type PipelineStage } from "../lib/pipeline.ts";

function NodeGlyph({ state }: { state: PipelineStage["state"] }) {
  if (state === "done") {
    return (
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path
          d="M2.5 6.2 5 8.5 9.5 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === "fail") {
    return (
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d="M6 2.2v4.4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
        <circle cx={6} cy={9.2} r={1} fill="currentColor" stroke="none" />
      </svg>
    );
  }
  // running + pending: small centered dot — halo (running) vs quiet outline
  // (pending) is carried by the node CSS, shape stays a dot in both.
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx={6} cy={6} r={state === "running" ? 2.6 : 1.6} fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Execution lifecycle: CLAIM → GENERATION → WORK → HANDOFF → VERIFY → REVIEW
 * → DONE, observed state only.
 *
 * Horizontal (Overview): an execution spine — one inline sequence where the
 * current phase carries the weight (filled node, bright label, its own
 * detail), completed phases sit quiet behind it, and phases that have not
 * happened are restrained outlines. No stage implies progress it has not
 * observed.
 *
 * Vertical (Inspector): the same stages as a checklist, one per row with
 * every detail visible.
 */
export default function PipelineStepper({
  stages,
  variant,
  label = "Execution pipeline",
}: {
  stages: PipelineStage[];
  variant: "horizontal" | "vertical";
  label?: string;
}) {
  if (variant === "vertical") {
    return (
      <ol className="omp-trace omp-trace--rail" aria-label={label}>
        {stages.map((s) => (
          <li key={s.label} className="omp-trace-step" data-state={s.state}>
            <span aria-hidden="true" className="omp-trace-sym" data-state={s.state}>
              <NodeGlyph state={s.state} />
            </span>
            <span className="omp-trace-name">{s.label}</span>
            <span className="omp-hint omp-trace-sub" data-state={s.state}>
              {s.sublabel}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  const current = currentStageIndex(stages);
  return (
    <ol className="omp-spine" aria-label={label}>
      {stages.map((s, i) => {
        const isCurrent = i === current;
        return (
          <li
            key={s.label}
            className="omp-spine-step"
            data-state={s.state}
            data-current={isCurrent ? "true" : "false"}
          >
            <span aria-hidden="true" className="omp-spine-node" data-state={s.state}>
              <NodeGlyph state={s.state} />
            </span>
            <span className="omp-spine-label">{s.label}</span>
            {isCurrent && s.sublabel && <span className="omp-spine-sub">{s.sublabel}</span>}
          </li>
        );
      })}
    </ol>
  );
}
