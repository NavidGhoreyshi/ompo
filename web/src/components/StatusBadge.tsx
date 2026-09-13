import { StatusSymbol } from "./icons.tsx";
import { Badge } from "./ui/badge.tsx";
import { toneForStatus } from "../lib/status.ts";

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
      <span aria-hidden="true" className="omp-status-sym" data-tone={tone}>
        <StatusSymbol status={status} />
      </span>
      {status}
    </Badge>
  );
}
