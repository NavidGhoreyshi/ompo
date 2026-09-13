import type { RunEvent } from "../api.ts";
import { formatDurationMs, formatTokens } from "./format.ts";

/**
 * Shared Activity-stream helpers: lane classification, concise details, and
 * search matching. Pure, no DOM — the Activity panel and the Terminal raw
 * view both build on these so the two views never disagree.
 */

/** Filter lanes for the Activity stream (chip labels are Title-case). */
export type ActivityLane = "worker" | "verify" | "review" | "control" | "system";

export type ActivityFilter = "All" | "Worker" | "Verify" | "Review" | "Control" | "System";

export const ACTIVITY_FILTERS: readonly ActivityFilter[] = [
  "All",
  "Worker",
  "Verify",
  "Review",
  "Control",
  "System",
];

const CONTROL_TYPES: ReadonlySet<string> = new Set([
  "control_requested",
  "control_applied",
  "control_rejected",
]);

const VERIFY_TYPES: ReadonlySet<string> = new Set([
  "verify_passed",
  "verify_failed",
  "slice_reverified",
]);

const WORKER_TYPES: ReadonlySet<string> = new Set([
  "slice_claimed",
  "worker_finished",
  "slice_handoff",
  "slice_retried",
]);

/**
 * Lane for one event. There is no `review_*` event type — review outcomes
 * land as `slice_done` (approval) or terminal/review-rejected reasons — so
 * `slice_done` plus any event whose reason/detail mentions review reads as
 * the review lane. Control types always stay control. Unknown types fall
 * through to system rather than vanishing from every filter.
 */
export function eventLane(e: Pick<RunEvent, "type" | "reason" | "detail">): ActivityLane {
  if (CONTROL_TYPES.has(e.type)) return "control";
  const hay = `${e.reason ?? ""} ${e.detail ?? ""}`.toLowerCase();
  if (e.type === "slice_done" || hay.includes("review")) return "review";
  if (VERIFY_TYPES.has(e.type)) return "verify";
  if (WORKER_TYPES.has(e.type)) return "worker";
  return "system";
}

/** Lane/worker cell: lane plus the attempt when the event carries one. */
export function eventLaneLabel(e: Pick<RunEvent, "type" | "reason" | "detail" | "attempt">): string {
  const lane = eventLane(e);
  return e.attempt !== undefined ? `${lane} #${e.attempt}` : lane;
}

/** HH:MM:SS local timestamp; raw ISO passthrough when unparseable. */
export function formatEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Collapse whitespace and cap length for one-line rendering. */
export function truncateDetail(s: string, max = 180): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Concise `control_requested` JSON intent: `skip w2d — no longer needed`. */
export function conciseControlIntent(detail: string): string | null {
  try {
    const raw = JSON.parse(detail) as { kind?: unknown; sliceId?: unknown; jobs?: unknown; reason?: unknown };
    if (typeof raw !== "object" || raw === null || typeof raw.kind !== "string") return null;
    const parts = [raw.kind, typeof raw.sliceId === "string" ? raw.sliceId : null]
      .filter(Boolean)
      .join(" ");
    const extra = [
      typeof raw.jobs === "number" ? `jobs=${raw.jobs}` : null,
      typeof raw.reason === "string" && raw.reason ? raw.reason : null,
    ]
      .filter(Boolean)
      .join(" — ");
    return extra ? `${parts} — ${extra}` : parts;
  } catch {
    return null;
  }
}

/**
 * Concise one-line event details: reason, exit/timing enrichment, agent
 * counters, then the (truncated) detail payload. Empty string when the event
 * carries nothing beyond type/slice.
 */
export function describeEvent(e: RunEvent): string {
  const parts: string[] = [];
  if (e.reason) parts.push(e.reason);
  if (e.exit !== undefined && e.exit !== null) parts.push(`exit=${e.exit}`);
  if (e.timedOut) parts.push("timedOut");
  if (typeof e.durationMs === "number") parts.push(formatDurationMs(e.durationMs));
  if (e.stats && typeof e.stats.turns === "number" && typeof e.stats.tools === "number") {
    const tokens = e.stats.tokens && typeof e.stats.tokens.total === "number"
      ? `/${formatTokens(e.stats.tokens.total)} tok`
      : "";
    parts.push(`${e.stats.turns}t/${e.stats.tools}tools${tokens}`);
  }
  if (e.detail) {
    parts.push(
      e.type === "control_requested"
        ? (conciseControlIntent(e.detail) ?? truncateDetail(e.detail))
        : truncateDetail(e.detail),
    );
  }
  return parts.join(" · ");
}

/**
 * Statuses whose "on what?" is live information. Terminal states answer with
 * their outcome (done / reason), so an event line would be stale noise.
 */
const LIVE_ACTIVITY_STATUSES = new Set(["running", "verifying", "pending", "blocked", "blocked-env"]);

/**
 * The newest event text for a slice — the hero line's live fallback, shared by
 * the dashboard's `RunHeader` and the deck's overlay so the two surfaces cannot
 * disagree about what "current activity" means. `null` for a terminal status.
 */
export function liveSliceEvent(status: string, events: readonly RunEvent[], sliceId: string): string | null {
  if (!LIVE_ACTIVITY_STATUSES.has(status)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.sliceId !== sliceId) continue;
    const text = describeEvent(e).trim();
    return text ? `${e.type} — ${text}` : e.type;
  }
  return null;
}

/** Case-insensitive substring match across type, lane, slice, payload, seq. */
export function eventMatchesQuery(e: RunEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [e.type, eventLane(e), e.sliceId ?? "", e.reason ?? "", e.detail ?? "", String(e.seq)]
    .join(" ")
    .toLowerCase()
    .includes(q);
}
