/**
 * Ready-selector (plan §6, M1): deterministic roadmap-order selection.
 * Only `pending` slices whose deps are all `done` or `skipped` are ready.
 * A skipped slice is intentionally not run — downstream must proceed past it.
 * `blocked` is advisory (computed, not stored): pending with unmet deps.
 */

import { resumeDemotes, terminalStatus } from "./types.ts";
import type { RoadmapDoc, Slice } from "./types.ts";

/** A dependency no longer blocks when done OR intentionally skipped. */
export function depSatisfied(s: Slice | undefined): boolean {
  return s?.status === "done" || s?.status === "skipped";
}

export function isReady(s: Slice, byId: Map<string, Slice>): boolean {
  if (s.status !== "pending") return false;
  return s.deps.every((d) => depSatisfied(byId.get(d)));
}

/** First ready slice in roadmap order, or null when the roadmap stalls/ends. */
export function nextReady(doc: RoadmapDoc): Slice | null {
  const byId = new Map(doc.slices.map((s) => [s.id, s]));
  for (const s of doc.slices) {
    if (isReady(s, byId)) return s;
  }
  return null;
}

/** All ready slices in roadmap order (loop uses nextReady; tests/inspect use this). */
export function readySlices(doc: RoadmapDoc): Slice[] {
  const byId = new Map(doc.slices.map((s) => [s.id, s]));
  return doc.slices.filter((s) => isReady(s, byId));
}

/** True when no slice can ever become ready (deadlock beyond plain completion). */
export function stalled(doc: RoadmapDoc): boolean {
  if (nextReady(doc)) return false;
  // Stalled only if pending work remains that no future completion can
  // unblock: every remaining pending slice depends on a failed or
  // blocked-env predecessor. Running/verifying slices may still complete,
  // and done/skipped/failed/aborted are settled — none of those stall.
  const byId = new Map(doc.slices.map((s) => [s.id, s]));
  const pending = doc.slices.filter((s) => s.status === "pending");
  if (pending.length === 0) return false;
  if (doc.slices.some((s) => s.status === "running" || s.status === "verifying")) return false;
  return pending.every((s) =>
    s.deps.some((d) => {
      const dep = byId.get(d);
      return dep !== undefined && !depSatisfied(dep) && dep.status !== "pending";
    }),
  );
}

/** True when resuming would do no work: after resume demotion (in-flight +
 * blocked-env → pending) no slice is runnable. Terminal `failed` slices
 * never demote, so a mid-roadmap failure dead-ends every downstream pending
 * slice and resume would exit instantly. Pure — unit-tested. */
export function resumeStalled(slices: Slice[]): boolean {
  const after = new Map(slices.map((s) => [s.id, resumeDemotes(s.status) ? "pending" : s.status]));
  const satisfied = (id: string): boolean => after.get(id) === "done" || after.get(id) === "skipped";
  const runnable = (s: Slice): boolean => after.get(s.id) === "pending" && s.deps.every(satisfied);
  return slices.some((s) => !terminalStatus(s.status)) && !slices.some(runnable);
}

export function summarize(doc: RoadmapDoc): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of doc.slices) out[s.status] = (out[s.status] ?? 0) + 1;
  return out;
}
