/** Semantic status badge: cyan running/active, green done, amber blocked, red failed, muted rest. */

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

/** Text symbol per status family: badge never relies on color alone. */
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
    <span className="omp-badge" data-tone={toneForStatus(status)}>
      <span aria-hidden="true" className="omp-badge-sym">{symbolForStatus(status)}</span>
      {status}
    </span>
  );
}
