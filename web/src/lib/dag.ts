/**
 * DAG model + layered layout for the roadmap dependency graph.
 *
 * Dependency semantics mirror the scheduler exactly — no alternate
 * interpretation:
 * - `depSatisfied` matches `src/select.ts`: a dep no longer blocks when its
 *   status is `done` OR `skipped`. Unknown ids (`byId.get` → undefined) are
 *   NOT satisfied, so they block — same as `isReady`.
 * - Cycle detection is Kahn's algorithm over known deps, same as
 *   `src/parse.ts` (which rejects cycles at parse time). Unknown deps are
 *   ignored for cycle purposes — the parser rejects those separately.
 * - Depth layout is the longest-dep-chain rule from `dagDepths` in
 *   `src/watch.tsx`: unknown deps count as roots, cycles fall back to
 *   first-seen order instead of looping. Always total, never throws.
 *
 * Pure over `{ id, title, status, deps }` slices; no React, no DOM.
 */

export interface DagSlice {
  id: string;
  title: string;
  status: string;
  deps?: readonly string[] | undefined;
}

/** A dependency no longer blocks when done OR intentionally skipped (select.ts). */
export function depSatisfied(s: DagSlice | undefined | null): boolean {
  return s?.status === "done" || s?.status === "skipped";
}

/** Scheduler-ready: pending with every dep satisfied (select.ts `isReady`). */
export function isDagReady(s: DagSlice, byId: Map<string, DagSlice>): boolean {
  if (s.status !== "pending") return false;
  return (s.deps ?? []).every((d) => depSatisfied(byId.get(d)));
}

/** Ids of scheduler-ready slices, in roadmap order (select.ts `readySlices`). */
export function readyDagIds(slices: readonly DagSlice[]): string[] {
  const byId = new Map(slices.map((s) => [s.id, s]));
  return slices.filter((s) => isDagReady(s, byId)).map((s) => s.id);
}

/** Declared deps with no matching slice, first-seen order (lint `unknown dependency`). */
export function unknownDepIds(slices: readonly DagSlice[]): string[] {
  const ids = new Set(slices.map((s) => [s.id, s][0]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of slices) {
    for (const d of s.deps ?? []) {
      if (!ids.has(d) && !seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
  }
  return out;
}

/** Dependents declaring at least one unknown dep (rendered with a warning edge). */
export function slicesWithUnknownDeps(slices: readonly DagSlice[]): Set<string> {
  const ids = new Set(slices.map((s) => s.id));
  const out = new Set<string>();
  for (const s of slices) {
    if ((s.deps ?? []).some((d) => !ids.has(d))) out.add(s.id);
  }
  return out;
}

/**
 * Cycle members via Kahn's algorithm over known deps (parse.ts), tolerant:
 * unknown deps are skipped (they are reported separately), self-deps count.
 * Empty = acyclic.
 */
export function cycleMemberIds(slices: readonly DagSlice[]): string[] {
  const ids = new Set(slices.map((s) => s.id));
  const indeg = new Map<string, number>(slices.map((s) => [s.id, 0]));
  const dependents = new Map<string, string[]>(slices.map((s) => [s.id, []]));
  for (const s of slices) {
    for (const d of s.deps ?? []) {
      if (!ids.has(d)) continue;
      indeg.set(s.id, indeg.get(s.id)! + 1);
      dependents.get(d)!.push(s.id);
    }
  }
  const queue = slices.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.pop()!;
    visited++;
    for (const next of dependents.get(id)!) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (visited === slices.length) return [];
  return slices.filter((s) => indeg.get(s.id)! > 0).map((s) => s.id);
}

/**
 * DAG depth per slice id: longest dep chain from a root (roots = 0).
 * Unknown deps count as roots; cycles fall back to first-seen order instead
 * of looping (watch.tsx `dagDepths`). Always total.
 */
export function dagDepths(slices: readonly DagSlice[]): Map<string, number> {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const hit = depth.get(id);
    if (hit !== undefined) return hit;
    const s = byId.get(id);
    if (!s || visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const dep of s.deps ?? []) {
      if (byId.has(dep)) d = Math.max(d, visit(dep) + 1);
    }
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const s of slices) visit(s.id);
  return depth;
}

export const DAG_NODE_W = 200;
export const DAG_NODE_H = 70;
export const DAG_GAP_X = 76;
export const DAG_GAP_Y = 22;
export const DAG_PAD = 16;

export interface DagNode {
  id: string;
  title: string;
  status: string;
  /** Top-left corner in SVG units. */
  x: number;
  y: number;
  depth: number;
  ghost: boolean;
  inCycle: boolean;
  hasUnknownDep: boolean;
  /** Advisory `blocked`: pending with an unmet dep (select.ts comment). */
  blocked: boolean;
  ready: boolean;
}

export interface DagEdge {
  key: string;
  /** Right-center of the dep node. */
  x1: number;
  y1: number;
  /** Left-center of the dependent node. */
  x2: number;
  y2: number;
  /** Dep id is not in the roadmap (lint error class). */
  unknown: boolean;
  /** Dep status is done/skipped — the scheduler proceeds past it. */
  satisfied: boolean;
  /** Both ends are cycle members. */
  inCycle: boolean;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
  /** Unknown dep ids, first-seen order — rendered as ghost nodes. */
  unknownIds: string[];
  /** Cycle member ids in roadmap order — empty when acyclic. */
  cycleIds: string[];
  /** Ready slice ids in roadmap order (scheduler rule). */
  readyIds: string[];
}

/**
 * Layered layout: one column per depth, roadmap order preserved within a
 * column. Unknown dep ids render as ghost nodes in a leading column so the
 * dangling edges have a visible source. Never throws, even on cycles.
 */
export function layoutDag(slices: readonly DagSlice[]): DagLayout {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const unknownIds = unknownDepIds(slices);
  const unknownSet = new Set(unknownIds);
  const cycleSet = new Set(cycleMemberIds(slices));
  const hasUnknown = slicesWithUnknownDeps(slices);
  const depths = dagDepths(slices);
  const readySet = new Set(readyDagIds(slices));

  // Ghost column shifts every real node one column right when present.
  const colOffset = unknownIds.length > 0 ? 1 : 0;
  let maxDepth = 0;
  for (const s of slices) maxDepth = Math.max(maxDepth, depths.get(s.id) ?? 0);

  // Bucket real slices per column, roadmap order preserved.
  const columns = new Map<number, DagSlice[]>();
  for (const s of slices) {
    const col = (depths.get(s.id) ?? 0) + colOffset;
    const bucket = columns.get(col);
    if (bucket) bucket.push(s);
    else columns.set(col, [s]);
  }

  const nodeById = new Map<string, DagNode>();
  const nodes: DagNode[] = [];

  for (const ghostId of unknownIds) {
    const row = nodes.length;
    const n: DagNode = {
      id: ghostId,
      title: "(not in roadmap)",
      status: "unknown",
      x: DAG_PAD,
      y: DAG_PAD + row * (DAG_NODE_H + DAG_GAP_Y),
      depth: -1,
      ghost: true,
      inCycle: false,
      hasUnknownDep: false,
      blocked: false,
      ready: false,
    };
    nodes.push(n);
    nodeById.set(`ghost:${ghostId}`, n);
  }

  const colCount = maxDepth + 1 + colOffset;
  for (let col = colOffset; col < colCount; col++) {
    const bucket = columns.get(col) ?? [];
    bucket.forEach((s, row) => {
      const deps = s.deps ?? [];
      const blocked = s.status === "pending" && !deps.every((d) => depSatisfied(byId.get(d)));
      const n: DagNode = {
        id: s.id,
        title: s.title,
        status: s.status,
        x: DAG_PAD + col * (DAG_NODE_W + DAG_GAP_X),
        y: DAG_PAD + row * (DAG_NODE_H + DAG_GAP_Y),
        depth: depths.get(s.id) ?? 0,
        ghost: false,
        inCycle: cycleSet.has(s.id),
        hasUnknownDep: hasUnknown.has(s.id),
        blocked,
        ready: readySet.has(s.id),
      };
      nodes.push(n);
      nodeById.set(s.id, n);
    });
  }

  const edges: DagEdge[] = [];
  for (const s of slices) {
    const to = nodeById.get(s.id)!;
    for (const d of s.deps ?? []) {
      const from = nodeById.get(d) ?? nodeById.get(`ghost:${d}`);
      if (!from) continue;
      const dep = byId.get(d);
      edges.push({
        key: `${d}→${s.id}`,
        x1: from.x + DAG_NODE_W,
        y1: from.y + DAG_NODE_H / 2,
        x2: to.x,
        y2: to.y + DAG_NODE_H / 2,
        unknown: unknownSet.has(d),
        satisfied: depSatisfied(dep),
        inCycle: cycleSet.has(d) && cycleSet.has(s.id),
      });
    }
  }

  let height = DAG_PAD * 2 + DAG_NODE_H;
  for (const n of nodes) height = Math.max(height, n.y + DAG_NODE_H + DAG_PAD);
  const width = DAG_PAD * 2 + colCount * DAG_NODE_W + Math.max(0, colCount - 1) * DAG_GAP_X;

  return {
    nodes,
    edges,
    width,
    height,
    unknownIds,
    cycleIds: slices.filter((s) => cycleSet.has(s.id)).map((s) => s.id),
    readyIds: slices.filter((s) => readySet.has(s.id)).map((s) => s.id),
  };
}
