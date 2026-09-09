/** Semantic status indicator: symbol + word, never color alone. Flat typographic treatment — pills are reserved for genuinely interactive chips. */

export type Tone = "cyan" | "green" | "amber" | "red" | "muted";

export function toneForStatus(status: string): Tone {
  switch (status) {
    case "running":
    case "verifying":
    case "active":
    case "live":
      return "cyan";
    case "done":
    case "passed":
      return "green";
    case "failed":
    case "aborted":
      return "red";
    case "blocked-env":
    case "blocked":
    case "warning":
      return "amber";
    default:
      return "muted";
  }
}

/** Text symbol per status family: status never relies on color alone. */
export function symbolForStatus(status: string): string {
  switch (status) {
    case "done":
    case "passed":
      return "✓";
    case "running":
    case "verifying":
    case "active":
    case "live":
      return "●";
    case "failed":
    case "aborted":
      return "✕";
    case "blocked-env":
    case "blocked":
    case "warning":
      return "▲";
    case "pending":
      return "○";
    case "skipped":
      return "–";
    default:
      return "•";
  }
}

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className="omp-status" data-tone={toneForStatus(status)}>
      <span aria-hidden="true" className="omp-status-sym" data-tone={toneForStatus(status)}>
        {symbolForStatus(status)}
      </span>
      {status}
    </span>
  );
}
