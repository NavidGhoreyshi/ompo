/**
 * Station slots: where the deck's live workers stand (roadmap slice `d04`) — pure.
 *
 * One rule decides which live workers are drawn as stations and which pool
 * entry each one uses. It reads two DTO facts — the live set (`liveIds`, in
 * board order) and each worker's `AgentRow.lane` — and nothing else.
 *
 * A slot is a **pool index, not a world position**: a station's coordinates are
 * its own pad's (`rail.ts` computes those from the roadmap alone), so a worker
 * that joins or leaves the live set can never move another worker in the scene.
 * That is the stability `d02`/`d03` measured, extended to N workers: the deck's
 * spatial memory survives a changing live set because the live set never owns a
 * coordinate.
 *
 * `AgentRow.lane` is the server's dense index over the live set in board order
 * (`src/server.ts`, `agentsForRun`), and `liveIds` is that same board order —
 * so ordering by lane is ordering by board order, not a second ranking. A lane
 * that is missing (a claim the `/agents` poll has not caught up with yet) falls
 * back to the next free slot; a malformed one is clamped, and both are reported
 * in `warnings` rather than silently overlapping two workers on one mesh.
 *
 * Pure module: no `three`, no DOM, no state.
 */

/** The DTO facts a slot decision may read. */
export interface StationNode {
  id: string;
  /**
   * `AgentRow.lane` — the live set's dense index in board order, or `null`
   * when the server has not reported this worker yet.
   */
  lane: number | null;
}

/** One live worker's place in the station pool. */
export interface StationSlot {
  id: string;
  /** Pool entry the station is drawn from; `0 … maxStations-1`. */
  slot: number;
  /** `0` for a pooled station; `1 … n` when the pool was full (overflow). */
  stack: number;
}

export interface StationLayout {
  /** Every live worker, in station order: pooled first, then overflow. */
  stations: StationSlot[];
  /** Workers drawn from the pool (`≤ maxStations`). */
  pooled: number;
  /** Workers beyond the pool — counted in the HUD, listed in the lane list. */
  overflow: number;
  /** Inputs the policy had to repair, in the operator's words (HUD-visible). */
  warnings: string[];
}

/** Lanes are compared as whole numbers; "no lane" sorts last, ties keep board order. */
function laneRank(lane: number | null): number {
  return lane !== null && Number.isFinite(lane) ? Math.floor(lane) : Number.POSITIVE_INFINITY;
}

/**
 * Assign every live worker a station slot.
 *
 * The pool holds `maxStations` stations. Workers are placed in station order
 * (lane order, ties in `liveIds` order) at their own lane when it is free, else
 * at the next free slot; a worker that finds no free slot at all becomes an
 * overflow entry (`stack` > 0) instead of overwriting another worker's mesh.
 * A `maxStations` of 0 is legal and means "no stations" (everyone overflows).
 */
export function stationSlots(
  nodes: readonly StationNode[],
  liveIds: readonly string[],
  maxStations: number,
): StationLayout {
  const cap = Math.max(0, Math.floor(maxStations));
  const laneOf = new Map<string, number | null>();
  for (const node of nodes) laneOf.set(node.id, node.lane);

  const warnings: string[] = [];
  const stations: StationSlot[] = [];
  const seen = new Set<string>();
  const taken = new Set<number>();
  let pooled = 0;
  let overflow = 0;

  // `liveIds` is board order; a stable sort by lane keeps that order for ties
  // (and for workers the server has not given a lane yet).
  const order = [...liveIds].sort((a, b) => laneRank(laneOf.get(a) ?? null) - laneRank(laneOf.get(b) ?? null));

  for (const id of order) {
    if (seen.has(id)) {
      warnings.push(`${id}: listed twice in the live set — placed once`);
      continue;
    }
    seen.add(id);

    if (pooled >= cap) {
      overflow += 1;
      stations.push({ id, slot: Math.max(0, cap - 1), stack: overflow });
      continue;
    }

    const lane = laneOf.get(id) ?? null;
    const desired = laneRank(lane) === Number.POSITIVE_INFINITY ? pooled : Math.floor(lane as number);
    const clamped = Math.min(cap - 1, Math.max(0, desired));
    if (clamped !== desired) warnings.push(`${id}: lane ${desired} clamped to slot ${clamped}`);

    let slot = clamped;
    if (taken.has(slot)) {
      let free = -1;
      for (let step = 1; step < cap; step++) {
        const candidate = (clamped + step) % cap;
        if (!taken.has(candidate)) {
          free = candidate;
          break;
        }
      }
      if (free < 0) {
        overflow += 1;
        stations.push({ id, slot: Math.max(0, cap - 1), stack: overflow });
        continue;
      }
      warnings.push(`${id}: slot ${clamped} already taken — placed at slot ${free}`);
      slot = free;
    }

    taken.add(slot);
    pooled += 1;
    stations.push({ id, slot, stack: 0 });
  }

  return { stations, pooled, overflow, warnings };
}

/** Live workers the pool cannot hold: `live - maxStations`, floored at 0. */
export function overflowCount(liveIds: readonly string[], maxStations: number): number {
  return Math.max(0, liveIds.length - Math.max(0, Math.floor(maxStations)));
}

/**
 * The HUD's station phrase: `live: N` while every worker is drawn, and
 * `live: N · stations M` the moment one is not — the count an operator needs
 * when the tier (not the run) is what is hiding a worker.
 */
export function stationCountLabel(liveCount: number, pooled: number): string {
  return pooled >= liveCount ? `live: ${liveCount}` : `live: ${liveCount} · stations ${pooled}`;
}
