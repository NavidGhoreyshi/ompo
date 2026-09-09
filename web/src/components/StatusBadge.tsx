import { Badge } from "./ui/badge.tsx";

/** Semantic status indicator: symbol + word, never color alone. */

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

const BADGE_BY_TONE = {
  cyan: "info",
  green: "success",
  amber: "warning",
  red: "destructive",
  muted: "secondary",
} as const;

/**
 * Table/cell status pill: the same symbol + word language as the flat board
 * rows, set as a shadcn Badge so dense surfaces (runs, roadmap, verify
 * gates, output meta) scan without widening their columns.
 */
export default function StatusBadge({ status }: { status: string }) {
  const tone = toneForStatus(status);
  return (
    <Badge variant={BADGE_BY_TONE[tone]} data-tone={tone}>
      <span aria-hidden="true">{symbolForStatus(status)}</span>
      {status}
    </Badge>
  );
}
