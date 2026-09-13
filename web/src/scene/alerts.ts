/**
 * The deck's alert policy (roadmap slice `d05`, `docs/desktop-3d-roadmap.md` §D.8) — pure.
 *
 * One function decides which conditions are alerts, how severe they are, and
 * what one line of text says about them. It reads DTOs and the event log and
 * invents nothing: `failed`/`blocked-env` are `SliceSummary.status`, `wedged`
 * is `AgentRow.wedged`, `verdict-stall`/`review-rejected` are `SliceDetail`
 * fields the server already derives, `verify-failed` is the run's own
 * `verify_failed` event, and `double-loop` is `RunDetail.loops.length > 1`.
 *
 * Two properties matter more than the taxonomy:
 *
 *  - **One alert per condition, not one per event.** A slice that failed after
 *    three failing gates is one row, keyed by the newest event it has.
 *  - **Dismissal is per instance, and recurrence re-raises.** `dismissKey`
 *    includes the newest evidence seq, so a condition that comes back after a
 *    dismissal (a re-failure, a second wedge) is a new alarm and re-raises,
 *    while a dismissal of a static condition sticks.
 *
 * Severity is expressed in the scene by shape (ring count/size) *and* in the
 * DOM by a glyph and words: colour is redundant, never the only channel.
 *
 * Pure module: no DOM, no `three`, no clock.
 */

import type { RunEvent, SliceDetail } from "../api.ts";
import { truncateDetail } from "../lib/events.ts";
import { isLiveStatus } from "../lib/selection.ts";

/**
 * Alert kinds. The union is the whole taxonomy — no rule lives in the UI, and
 * a new kind is a change here plus a test, never a component.
 */
export type DeckAlertKind =
  | "failed"
  | "blocked-env"
  | "verify-failed"
  | "review-rejected"
  | "wedged"
  | "verdict-stall"
  | "double-loop";

export type AlertSeverity = "high" | "medium" | "advisory";

/** Sort order: high first. The DOM stack and the beacon set share it. */
export const SEVERITY_RANK: Record<AlertSeverity, number> = { high: 0, medium: 1, advisory: 2 };

/** How many rings a severity draws (the scene's non-colour channel). */
export const SEVERITY_RINGS: Record<AlertSeverity, number> = { high: 2, medium: 1, advisory: 1 };

const SEVERITY_BY_KIND: Record<DeckAlertKind, AlertSeverity> = {
  failed: "high",
  "blocked-env": "high",
  wedged: "high",
  "double-loop": "high",
  "verify-failed": "medium",
  "review-rejected": "medium",
  "verdict-stall": "advisory",
};

/** One active condition, ready for the stack and the scene. */
export interface DeckAlert {
  kind: DeckAlertKind;
  severity: AlertSeverity;
  /** The slice the alert is about; `null` for a run-level condition. */
  sliceId: string | null;
  /** One line, in the operator's words, already truncated. */
  message: string;
  /**
   * Seq of the newest event this alert's slice has produced (the run's newest
   * for a run-level alert) — `0` when the condition has no event evidence.
   * Part of the dismissal key, so new activity is a new alarm instance.
   */
  lastSeq: number;
}

/** Storage key for the dismissed-alert keys (view state, client-side only). */
export const DISMISSED_KEY = "ompo.deck.dismissed";
/** Dismissed keys kept: past this the oldest are dropped (storage stays bounded). */
export const DISMISSED_CAP = 200;

/** Identity of one alarm instance, without the run. */
export function alertKey(alert: DeckAlert): string {
  return `${alert.sliceId ?? "-"}|${alert.kind}|${alert.lastSeq}`;
}

/**
 * The key a dismissal is stored under: `runId|sliceId|kind|lastSeq`. A
 * re-raised condition has a new evidence seq and therefore a new key.
 */
export function dismissKey(runId: string | null, alert: DeckAlert): string {
  return `${runId ?? ""}|${alertKey(alert)}`;
}

/** Parsed at the storage boundary: unreadable storage dismisses nothing. */
export function parseDismissed(raw: string | null): string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Append one dismissal, deduped, oldest dropped past `DISMISSED_CAP`. */
export function appendDismissed(list: readonly string[], key: string): string[] {
  const next = list.filter((entry) => entry !== key);
  next.push(key);
  return next.length > DISMISSED_CAP ? next.slice(next.length - DISMISSED_CAP) : next;
}

/**
 * The alerts the operator has not dismissed. `dismissed` holds full dismissal
 * keys (`dismissKey`), so a run switch cannot inherit another run's dismissals.
 */
export function activeAlerts(
  alerts: readonly DeckAlert[],
  dismissed: ReadonlySet<string>,
  runId: string | null,
): DeckAlert[] {
  if (dismissed.size === 0) return [...alerts];
  return alerts.filter((alert) => !dismissed.has(dismissKey(runId, alert)));
}

/** The DTO facts an alert decision may read — all of them `SliceSummary` fields. */
export interface AlertSlice {
  id: string;
  status: string;
  reason?: string;
  attempts: number;
}

/** `AgentRow`'s wedge signal (the server's own staleness derivation). */
export interface AlertAgent {
  id: string;
  wedged?: boolean;
  staleForMs?: number | null;
}

/** `RunDetail.loops` — more than one is two writers on one run. */
export interface AlertLoop {
  pid: number;
}

export interface AlertInput {
  slices: readonly AlertSlice[];
  agents: readonly AlertAgent[];
  events: readonly RunEvent[];
  /** The shell's slice detail — it fetches for the selection, so this is one slice's. */
  sliceDetail: SliceDetail | null;
  loops: readonly AlertLoop[];
}

/** `12m` — a whole-minute figure for a duration in ms (never `0m`). */
function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60000))}m`;
}

/**
 * One pass over the log, indexing everything the alert policy and the model's
 * evidence stamps need: the newest seq per slice, the newest seq overall, and
 * the newest `verify_failed` per slice. One pass matters — this runs on every
 * model build, and the shell hands the deck up to its 400-event window.
 */
export interface EventIndex {
  bySlice: Map<string, number>;
  run: number;
  /** Newest `verify_failed` per slice: the evidence a retry is running again. */
  verifyFailed: Map<string, RunEvent>;
  /** Newest event per slice, whatever its type — the fallback reason source. */
  newest: Map<string, RunEvent>;
}

export function scanEvents(events: readonly RunEvent[]): EventIndex {
  const bySlice = new Map<string, number>();
  const verifyFailed = new Map<string, RunEvent>();
  const newest = new Map<string, RunEvent>();
  let run = 0;
  for (const event of events) {
    if (event.seq > run) run = event.seq;
    const sliceId = event.sliceId;
    if (sliceId === undefined) continue;
    const previous = bySlice.get(sliceId);
    if (previous === undefined || event.seq > previous) bySlice.set(sliceId, event.seq);
    const latest = newest.get(sliceId);
    if (latest === undefined || event.seq > latest.seq) newest.set(sliceId, event);
    if (event.type !== "verify_failed") continue;
    const failed = verifyFailed.get(sliceId);
    if (failed === undefined || event.seq > failed.seq) verifyFailed.set(sliceId, event);
  }
  return { bySlice, run, verifyFailed, newest };
}

/**
 * One line of "why" for a terminal condition. `SliceSummary.reason` is the
 * server's own derivation and wins; when it is absent (a `blocked-env` slice
 * has no reason field in the run record) the newest event's own words are the
 * same fact one layer down — read, never composed.
 */
function conditionReason(slice: AlertSlice, event: RunEvent | undefined, fallback: string): string {
  const fromSlice = slice.reason === undefined ? "" : slice.reason.trim();
  const fromEvent = event === undefined ? "" : (event.reason ?? event.detail ?? "").trim();
  const text = fromSlice.length > 0 ? fromSlice : fromEvent;
  return text.length > 0 ? truncateDetail(text, 120) : fallback;
}

/**
 * Every active alert, severity first, then recency, then board order. Pure: a
 * function of the DTOs, the events and the focused slice's detail only.
 */
export function deriveAlerts(input: AlertInput): DeckAlert[] {
  const index = scanEvents(input.events);
  const { bySlice, run } = index;
  const alerts: DeckAlert[] = [];
  const push = (kind: DeckAlertKind, sliceId: string | null, message: string, lastSeq: number): void => {
    alerts.push({ kind, severity: SEVERITY_BY_KIND[kind], sliceId, message, lastSeq });
  };

  for (const slice of input.slices) {
    const seq = bySlice.get(slice.id) ?? 0;
    const latest = index.newest.get(slice.id);
    if (slice.status === "failed") {
      push("failed", slice.id, conditionReason(slice, latest, "terminal failure (no reason recorded)"), seq);
      continue;
    }
    if (slice.status === "blocked-env") {
      // A parked slice has no `reason` in the run record; the event that parked
      // it carries the operator's own words.
      push("blocked-env", slice.id, conditionReason(slice, latest, "blocked on the environment"), seq);
      continue;
    }
    if (isLiveStatus(slice.status) || slice.status === "pending") {
      // Retrying after a failed gate: the newest `verify_failed` this slice
      // produced is the reason it is running again. A terminal failure never
      // reaches here — `failed` above is the whole story then.
      const failed = index.verifyFailed.get(slice.id) ?? null;
      if (failed !== null) {
        const attempt = failed.attempt === undefined ? slice.attempts : failed.attempt;
        const detail = failed.reason ?? failed.detail ?? "";
        push(
          "verify-failed",
          slice.id,
          `attempt ${attempt} gate failed${detail.length > 0 ? ` — ${truncateDetail(detail, 100)}` : ""}`,
          seq,
        );
      }
    }
  }

  // Wedged workers: live but silent past the server's threshold. The deck adds
  // no rule of its own — `AgentRow.wedged` is the server's derivation.
  for (const agent of input.agents) {
    if (agent.wedged !== true) continue;
    const stale = typeof agent.staleForMs === "number" && Number.isFinite(agent.staleForMs) ? agent.staleForMs : null;
    push("wedged", agent.id, stale === null ? "transcript silent" : `transcript silent ${minutes(stale)}`, bySlice.get(agent.id) ?? 0);
  }

  // Slice-detail conditions. The shell fetches detail for the *selection*, so
  // these two kinds cover the slice the operator has open — the others arrive
  // when the dock fetches their detail (`d06`).
  const detail = input.sliceDetail;
  if (detail !== null) {
    const seq = bySlice.get(detail.sliceId) ?? 0;
    if (detail.review !== undefined && detail.review.approved === false && detail.status !== "done" && detail.status !== "skipped") {
      const finding = detail.review.findings.length > 0 ? truncateDetail(detail.review.findings[0]!, 100) : "no findings recorded";
      push("review-rejected", detail.sliceId, `review rejected — ${finding}`, seq);
    }
    if (detail.verdictStall !== undefined) {
      const gate = detail.verdictStall.lastGate === undefined ? "" : ` after ${detail.verdictStall.lastGate}`;
      // Advisory, and worded as advisory: gates idle, never "stuck".
      push("verdict-stall", detail.sliceId, `gates idle ${minutes(detail.verdictStall.idleMs)}${gate}`, seq);
    }
  }

  if (input.loops.length > 1) {
    const pids = input.loops.map((loop) => loop.pid).join(", ");
    push("double-loop", null, `${input.loops.length} loop processes on this run — pids ${pids}`, run);
  }

  const boardOrder = new Map(input.slices.map((slice, index) => [slice.id, index]));
  return alerts.sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    if (a.lastSeq !== b.lastSeq) return b.lastSeq - a.lastSeq;
    const order = (boardOrder.get(a.sliceId ?? "") ?? Number.MAX_SAFE_INTEGER) - (boardOrder.get(b.sliceId ?? "") ?? Number.MAX_SAFE_INTEGER);
    if (order !== 0) return order;
    return a.kind.localeCompare(b.kind);
  });
}

