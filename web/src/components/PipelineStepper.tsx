import type { PipelineStage } from "../lib/pipeline.ts";

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
 * Pipeline stepper: the run's claim → done sequence as a horizontal rail
 * (hero) or a vertical rail (inspector checklist). Same `PipelineStage[]`
 * data, two presentations. Failure differs by icon shape ("!"), not color
 * alone; every node sits next to its word label.
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
      <ol className="omp-trace omp-stepper omp-stepper--vertical" aria-label={label}>
        {stages.map((s) => (
          <li key={s.label} className="omp-trace-step omp-stepper-step" data-state={s.state}>
            <span aria-hidden="true" className="omp-trace-sym omp-stepper-node" data-state={s.state}>
              <NodeGlyph state={s.state} />
            </span>
            <span className="omp-trace-name">{s.label}</span>
            <span className="omp-hint omp-stepper-sub" data-state={s.state}>
              {s.sublabel}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <ol className="omp-stepper omp-stepper--horizontal" aria-label={label}>
      {stages.map((s, i) => {
        const prevDone = i > 0 && stages[i - 1]!.state === "done";
        const filled = s.state === "done" || (s.state === "running" && prevDone);
        return (
          <li key={s.label} className="omp-stepper-step" data-state={s.state}>
            <span className="omp-stepper-top">
              <span aria-hidden="true" className="omp-stepper-node" data-state={s.state}>
                <NodeGlyph state={s.state} />
              </span>
              {i < stages.length - 1 && (
                <span aria-hidden="true" className="omp-stepper-connector" data-filled={filled ? "true" : "false"} />
              )}
            </span>
            <span className="omp-stepper-label">{s.label}</span>
            <span className="omp-stepper-sub omp-hint" data-state={s.state}>
              {s.sublabel}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
