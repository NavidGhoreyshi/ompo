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

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className="omp-badge" data-tone={toneForStatus(status)}>
      {status}
    </span>
  );
}
