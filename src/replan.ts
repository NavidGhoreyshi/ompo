/**
 * Replan --merge: adopt an edited ROADMAP.md into an existing run without
 * losing finished work. `resume` refuses on sourceHash drift (correct — a
 * silent roadmap swap under a running orchestrator would strand pipelines);
 * replan is the sanctioned path across that refusal for QUIESCENT runs:
 *
 * - Unchanged slices (by content fingerprint) keep status, attempts, and
 *   report/verdict refs — `done` is never re-run, `failed` keeps its history.
 * - Changed or new slices go `pending` with attempts preserved (attempt
 *   artifacts keep numbering, never overwritten).
 * - Removed ids drop from the cursor (their artifact dirs stay on disk).
 * - Refuses when the run is live (lock held) or an in-flight slice
 *   (running/verifying/aborted) changed body — its worker is executing the
 *   old spec; finish or kill first.
 */

import { createHash } from "node:crypto";
import type { RoadmapDoc, Slice } from "./types.ts";

function fingerprintOf(s: Slice): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: s.title,
        body: s.body,
        deps: s.deps,
        workerAgent: s.workerAgent ?? null,
        effort: s.effort ?? null,
        verify: s.verify,
        files: s.files,
        maxRetries: s.maxRetries,
        maxRetriesExplicit: s.maxRetriesExplicit ?? false,
        timeoutMs: s.timeoutMs ?? null,
        skip: s.skip ?? false,
      }),
      "utf8",
    )
    .digest("hex");
}

/** Content fingerprint per slice id (exported for tests). Pure. */
export function fingerprints(doc: RoadmapDoc): Map<string, string> {
  return new Map(doc.slices.map((s) => [s.id, fingerprintOf(s)]));
}

export interface ReplanMerge {
  doc: RoadmapDoc;
  kept: string[];
  reset: string[];
  added: string[];
  dropped: string[];
}

/**
 * Merge a freshly parsed roadmap into a run's cursor doc. Pure — the caller
 * persists via saveRunDoc + a roadmap_replanned event.
 */
export function mergeRoadmap(oldDoc: RoadmapDoc, newDoc: RoadmapDoc, now = new Date().toISOString()): ReplanMerge {
  const oldById = new Map(oldDoc.slices.map((s) => [s.id, s]));
  const oldPrints = fingerprints(oldDoc);
  const kept: string[] = [];
  const reset: string[] = [];
  const added: string[] = [];
  const slices: Slice[] = newDoc.slices.map((fresh) => {
    const prior = oldById.get(fresh.id);
    if (!prior) {
      added.push(fresh.id);
      return fresh;
    }
    if (oldPrints.get(fresh.id) === fingerprintOf(fresh)) {
      kept.push(fresh.id);
      return {
        ...fresh,
        status: prior.status,
        attempts: prior.attempts,
        reportRef: prior.reportRef,
        verdictRef: prior.verdictRef,
        updatedAt: prior.updatedAt,
      };
    }
    reset.push(fresh.id);
    return {
      ...fresh,
      status: fresh.skip ? "skipped" : "pending",
      attempts: prior.attempts,
      reportRef: undefined,
      verdictRef: undefined,
      updatedAt: now,
    };
  });
  const freshIds = new Set(newDoc.slices.map((s) => s.id));
  const dropped = oldDoc.slices.filter((s) => !freshIds.has(s.id)).map((s) => s.id);
  return { doc: { ...newDoc, slices }, kept, reset, added, dropped };
}

const INFLIGHT = new Set(["running", "verifying", "aborted"]);

/**
 * Merge guards: null when safe, else a human refusal reason. Pure.
 * `locked` = another `ompo run` owns the run (same rule as resume-conflict).
 */
export function replanGuards(oldDoc: RoadmapDoc, newDoc: RoadmapDoc, locked: boolean): string | null {
  if (locked) return "run is live (lock held) — replan only a quiescent run";
  const oldById = new Map(oldDoc.slices.map((s) => [s.id, s]));
  const oldPrints = fingerprints(oldDoc);
  const freshPrints = fingerprints(newDoc);
  const changedInflight = newDoc.slices
    .filter((s) => oldById.has(s.id) && oldPrints.get(s.id) !== freshPrints.get(s.id) && INFLIGHT.has(oldById.get(s.id)!.status))
    .map((s) => `${s.id} (${oldById.get(s.id)!.status})`);
  if (changedInflight.length > 0) {
    return `in-flight slice(s) changed spec: ${changedInflight.join(", ")} — finish, kill, or revert those sections first`;
  }
  return null;
}
