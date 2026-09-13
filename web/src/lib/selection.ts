import type { SliceSummary } from "../api.ts";

type SliceLike = Pick<SliceSummary, "id" | "status" | "updatedAt">;

/**
 * Browser port of `preferredSel` (src/watch.tsx): the cursor lands on what
 * needs eyes. Rank 0 is live or terminal-failure work (running / verifying /
 * failed), rank 1 is blocked waiting on the operator, rank 2 is done,
 * everything else trails. Tie-break is roadmap order — except among done
 * slices, where the most recently updated (most recently completed) wins so
 * a quiescent run inspects fresh output, not the first slice.
 *
 * Single selection system: App auto-select, Inspector default, and manual
 * clicks all resolve through this function. There is no second ranking.
 */
export function preferredSliceId(slices: SliceLike[]): string | null {
  if (slices.length === 0) return null;
  const rank = (s: SliceLike): number => {
    switch (s.status) {
      case "running":
      case "verifying":
        return 0;
      case "failed":
      case "aborted":
        return 1;
      case "blocked-env":
      case "blocked":
        return 2;
      case "done":
        return 3;
      default:
        return 4;
    }
  };
  let best = 0;
  for (let i = 1; i < slices.length; i++) {
    const a = slices[i]!;
    const b = slices[best]!;
    const ra = rank(a);
    const rb = rank(b);
    if (ra < rb) {
      best = i;
    } else if (ra === rb && ra === 3) {
      // Most recently completed done slice wins over earlier ones.
      if (Date.parse(a.updatedAt) > Date.parse(b.updatedAt)) best = i;
    }
  }
  return slices[best]!.id;
}
/**
 * One-line answer to "waiting/working on what?" for the hero slice.
 * Observed only: live worker line first, then the slice's latest event
 * text, then status-derived fallback (queue needs, failure/block reason).
 * Pure — unit-tested.
 */
export function heroAction(input: {
  status: string;
  lastLine?: string | null;
  lastEvent?: string | null;
  reason?: string | null;
  deps?: readonly string[];
}): string {
  const line = input.lastLine?.trim();
  if (line) return line;
  const ev = input.lastEvent?.trim();
  if (ev) return ev;
  switch (input.status) {
    case "running":
      return "working…";
    case "verifying":
      return "gates running…";
    case "failed":
    case "aborted":
      return input.reason?.trim() || input.status;
    case "blocked-env":
    case "blocked":
      return input.reason?.trim() || "waiting on environment";
    case "pending":
      return input.deps && input.deps.length > 0 ? `queued — needs ${input.deps.join(", ")}` : "queued";
    default:
      return input.status;
  }
}
