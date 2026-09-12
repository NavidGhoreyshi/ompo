/**
 * Live worker-output semantics for the Overview.
 *
 * The compact live window shows a few *meaningful* entries — tool calls, turn
 * boundaries, lifecycle events — never a transcript. The expanded view keeps
 * the raw log lines, so nothing is lost; this module decides what the compact
 * window is allowed to say and in what order.
 *
 * Ordering is positional, not timestamped: worker-log lines carry no clock, so
 * lifecycle events are placed around the current worker's output by kind —
 * what opens a generation sits above its lines, what lands after the work
 * (finish, verify, review, control) sits below them. Observed state only.
 *
 * Pure, no DOM: parsing, alignment, and window math are unit-tested; the
 * component only renders.
 */

import type { RunEvent } from "../api.ts";
import { formatDurationMs } from "./format.ts";
import { conciseControlIntent, formatEventTime, truncateDetail } from "./events.ts";

/** Rows in the compact live window when it is not expanded. */
export const COMPACT_ROWS = 5;

/** Scroll slack (px from the bottom) that still counts as "following". */
export const FOLLOW_SLOP = 24;

export type StreamKind =
  | "read"
  | "run"
  | "turn"
  | "tool"
  | "say"
  | "note"
  | "warn"
  | "fail"
  | "raw"
  | "event";

export interface StreamEntry {
  /** Stable across polls (event seq, else aligned log-line id) — drives enter/leave motion. */
  key: string;
  kind: StreamKind;
  /** Short left tag: "read", "run", "turn", "verify", "handoff"… */
  tag: string;
  /** Concise semantic line. */
  text: string;
  /** Muted trailing metadata (time, exit, counts). */
  meta?: string;
  /** Log-line ordinal when the entry came from the worker log (ordering only). */
  line?: number;
}

export type SemanticLine = Omit<StreamEntry, "key" | "line">;

/** `  [s2-meta] …` / `  [s4-orders verify] …` → the payload after the prefix. */
const PROGRESS_PREFIX = /^\s*\[[^\]]*\]\s?/;

/** Longest tool/command fragment a compact row renders. */
const TOOL_MAX = 110;
/** Longest opaque output fragment a compact row renders. */
const RAW_MAX = 140;

function toolEntry(name: string, summary: string): SemanticLine {
  const s = truncateDetail(summary.trim(), TOOL_MAX);
  if (!s) return { kind: "tool", tag: name, text: `${name} …` };
  // `tool bash: bun test` renders as the command itself, tagged "run".
  if (name === "bash") return { kind: "run", tag: "run", text: s };
  if (name === "read" || name === "glob" || name === "grep" || name === "ls") {
    return { kind: "read", tag: name, text: `${name} ${s}` };
  }
  return { kind: "tool", tag: name, text: `${name} ${s}` };
}

/**
 * One worker-log line → its semantic row. Recognizes the progress grammar
 * `src/worker.ts` writes (`progressLineForEvent` → `formatProgressLine`);
 * anything else is opaque output and surfaces as `raw` so the compact window
 * can keep it out of the way without dropping the line from the log.
 * Returns null for structure markers that carry no content of their own.
 */
export function semanticLine(line: string): SemanticLine | null {
  const raw = line.replace(PROGRESS_PREFIX, "").trim();
  if (!raw) return null;
  if (/^---\s*(stdout|stderr)\s*---$/i.test(raw)) return null;

  const exit = raw.match(/^exit=(\S+)\s+timedOut=(\S+)\s+durationMs=(\d+)$/);
  if (exit) {
    const ms = Number(exit[3]);
    return {
      kind: "event",
      tag: "worker",
      text: `worker exited ${exit[1]}${exit[2] === "true" ? " · timed out" : ""}`,
      meta: formatDurationMs(ms),
    };
  }

  const turnDone = raw.match(/^turn\s+(\d+)\s+done\s*(?:\((\d+)\s+tool results?\))?$/);
  if (turnDone) {
    return {
      kind: "turn",
      tag: "turn",
      text: `turn ${turnDone[1]} completed`,
      meta: turnDone[2] ? `${turnDone[2]} tool results` : undefined,
    };
  }

  const turnStart = raw.match(/^turn\s+(\d+)\s*…$/);
  if (turnStart) return { kind: "turn", tag: "turn", text: `turn ${turnStart[1]} started` };

  const toolFailed = raw.match(/^tool\s+([^\s:]+)\s+FAILED$/);
  if (toolFailed) return { kind: "fail", tag: toolFailed[1]!, text: `${toolFailed[1]} failed` };

  // `tool bash: bun test` / `tool read: src/a.ts` / `tool edit src/a.ts` —
  // the name never carries the separator colon.
  const tool = raw.match(/^tool\s+([^\s:]+)\s*:?\s*(.*)$/);
  if (tool) return toolEntry(tool[1]!, tool[2] ?? "");

  const says = raw.match(/^says:\s*(.*)$/);
  if (says) return { kind: "say", tag: "agent", text: truncateDetail(says[1]!, 160) };

  const note = raw.match(/^note:\s*(.*)$/);
  if (note) return { kind: "note", tag: "note", text: truncateDetail(note[1]!, 160) };

  const retrying = raw.match(/^retrying:\s*(.*)$/);
  if (retrying) return { kind: "warn", tag: "retry", text: truncateDetail(retrying[1]!, 160) };
  if (raw === "retry recovered") return { kind: "note", tag: "retry", text: "retry recovered" };
  if (raw === "retry failed") return { kind: "fail", tag: "retry", text: "retry failed" };

  const fallback = raw.match(/^model fallback\s+(\S+)\s*->\s*(\S+)$/);
  if (fallback) return { kind: "warn", tag: "model", text: `model fallback ${fallback[1]} → ${fallback[2]}` };

  if (/^report block printed$/i.test(raw)) return { kind: "note", tag: "report", text: "report block printed" };

  const stall = raw.match(/^\(no worker output for (\d+)m — still waiting\)$/);
  if (stall) return { kind: "warn", tag: "wait", text: `no worker output for ${stall[1]}m` };

  return { kind: "raw", tag: "out", text: truncateDetail(raw, RAW_MAX) };
}

/** One row per lifecycle event type: its tag, its verb, and how it orders. */
interface EventRow {
  /** Short left tag: "claim", "verify", "control"… */
  tag: string;
  /** Human verb the row falls back to when the event carries no reason. */
  verb: string;
  /** Opens a generation — placed above the current worker output. */
  opens?: boolean;
  /** Observed failure — the row carries the failure tone. */
  failing?: boolean;
}

/**
 * The lifecycle vocabulary this module renders. One record, so a new event
 * type is one edit instead of four parallel maps drifting apart.
 */
const EVENT_ROWS: Readonly<Record<string, EventRow>> = {
  slice_claimed: { tag: "claim", verb: "claimed", opens: true },
  slice_retried: { tag: "retry", verb: "retried", opens: true },
  slice_handoff: { tag: "handoff", verb: "handoff", opens: true },
  run_started: { tag: "run", verb: "run started", opens: true },
  run_resumed: { tag: "run", verb: "run resumed", opens: true },
  slice_reverified: { tag: "verify", verb: "reverified" },
  slice_done: { tag: "done", verb: "done" },
  slice_failed_terminal: { tag: "fail", verb: "failed", failing: true },
  worker_finished: { tag: "worker", verb: "worker finished" },
  verify_passed: { tag: "verify", verb: "verify passed" },
  verify_failed: { tag: "verify", verb: "verify failed", failing: true },
  control_requested: { tag: "control", verb: "control requested" },
  control_applied: { tag: "control", verb: "control applied" },
  control_rejected: { tag: "control", verb: "control rejected", failing: true },
  run_finished: { tag: "run", verb: "run finished" },
  roadmap_replanned: { tag: "plan", verb: "roadmap replanned" },
};

/** Longest payload fragment the compact window will show. */
const DETAIL_MAX = 90;

/**
 * Payload fragment for one event row. Control intents render as their concise
 * form, and structured payloads are never dumped into the compact window —
 * the Events tab, Activity drawer, and Terminal view keep them verbatim.
 */
function compactDetail(e: RunEvent): string | null {
  const detail = e.detail?.trim();
  if (!detail) return null;
  if (e.type === "control_requested") return conciseControlIntent(detail);
  if (/^[{[]/.test(detail)) return "structured payload";
  return truncateDetail(detail, DETAIL_MAX);
}

/** One run event → its semantic row, or null when it says nothing about the slice. */
export function eventEntry(e: RunEvent): StreamEntry | null {
  const row = EVENT_ROWS[e.type];
  if (row === undefined) return null;
  const kind: StreamKind = row.failing === true ? "fail" : "event";
  // The specific observed fact leads; the verb survives in the tag column.
  const reason = e.reason?.trim();
  const attempt = e.type === "slice_claimed" && typeof e.attempt === "number" ? `attempt ${e.attempt}` : null;
  const text = reason && reason.length > 0 ? truncateDetail(reason, 110) : (attempt ?? row.verb);
  const extras: string[] = [];
  if (e.exit !== undefined && e.exit !== null) extras.push(`exit ${e.exit}`);
  if (typeof e.durationMs === "number") extras.push(formatDurationMs(e.durationMs));
  if (e.stats && typeof e.stats.turns === "number" && typeof e.stats.tools === "number") {
    extras.push(`${e.stats.turns}t/${e.stats.tools}tools`);
  }
  const detail = compactDetail(e);
  if (detail) extras.push(detail);
  const meta = [formatEventTime(e.at), ...extras].filter((p) => p.length > 0).join(" · ");
  return {
    key: `e:${e.seq}`,
    kind,
    tag: row.tag,
    text,
    meta: meta.length > 0 ? truncateDetail(meta, 150) : undefined,
  };
}

/**
 * Line ids across polls. The tail endpoint returns the file's last `n` lines
 * with no ordinals, so identity is recovered by matching the previous window's
 * tail against the new window's head: file logs only append, so unchanged
 * lines keep their ids and new lines continue the counter. When nothing
 * matches (new generation file, truncation, rotation) every line gets a fresh
 * ordinal instead — ids are never reused, so no row silently inherits another
 * line's motion.
 */
export function alignLineIds(prev: { lines: string[]; ids: number[] }, next: string[]): number[] {
  const max = Math.min(prev.lines.length, next.length);
  let overlap = 0;
  for (let k = max; k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (prev.lines[prev.lines.length - k + i] !== next[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      overlap = k;
      break;
    }
  }
  const lastId = prev.ids.length > 0 ? prev.ids[prev.ids.length - 1]! : -1;
  const base = prev.ids.length - overlap;
  const out: number[] = [];
  for (let i = 0; i < next.length; i++) {
    out.push(i < overlap ? prev.ids[base + i]! : lastId + 1 + (i - overlap));
  }
  return out;
}

/**
 * Compose the live stream: what opens the current generation above its worker
 * output, output in file order, what landed after it below — and only what
 * landed after it. Bounded inputs; the compact window only ever reads the tail.
 */
export function buildLiveStream(input: {
  events: RunEvent[];
  sliceId: string | null;
  lines: string[];
  ids: number[];
  logName?: string | null;
}): StreamEntry[] {
  const { events, sliceId, lines, ids, logName } = input;
  if (sliceId === null) return [];

  const before: StreamEntry[] = [];
  const after: { seq: number; entry: StreamEntry }[] = [];
  let openerSeq: number | null = null;
  for (const e of events) {
    if (e.sliceId !== sliceId && !(e.sliceId === undefined && e.type.startsWith("run_"))) continue;
    const entry = eventEntry(e);
    if (!entry) continue;
    if (EVENT_ROWS[e.type]?.opens === true) {
      before.push(entry);
      openerSeq = e.seq;
    } else {
      after.push({ seq: e.seq, entry });
    }
  }

  // Events predating the generation opener belong to an earlier attempt
  // (last attempt's finish, an old control outcome): they must not read as
  // newer than live output. Events are append-ordered, so `seq` gates them;
  // with no opener in the buffer there is nothing to gate against.
  const gate = openerSeq;
  const recent = after.filter((a) => gate === null || a.seq > gate);

  const log: StreamEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = semanticLine(lines[i]!);
    if (!parsed) continue;
    const id = ids[i] ?? i;
    log.push({ key: `l:${logName ?? "log"}:${id}`, line: id, ...parsed });
  }

  return [...before.slice(-2), ...log, ...recent.slice(-6).map((a) => a.entry)];
}

/**
 * The compact window: the newest `size` rows that carry meaning, plus the
 * newest raw output line when it is newer than all of them — so a worker
 * printing machine output is never misrepresented as idle.
 */
export function compactWindow(entries: StreamEntry[], size = COMPACT_ROWS): StreamEntry[] {
  const meaningful = entries.filter((e) => e.kind !== "raw");
  const raw = entries.filter((e) => e.kind === "raw");
  const lastLine = meaningful.length > 0 ? meaningful[meaningful.length - 1]!.line : undefined;
  const trailing =
    lastLine === undefined
      ? raw.slice(-1)
      : raw.filter((e) => e.line !== undefined && e.line > lastLine).slice(-1);
  return [...meaningful, ...trailing].slice(-size);
}

/** One expanded-view row: the log line as written, colored by its semantic kind. */
export function rawLine(line: string, id: number, logName: string | null): StreamEntry {
  const parsed = semanticLine(line);
  const body = line.replace(PROGRESS_PREFIX, "").trim();
  return {
    key: `l:${logName ?? "log"}:${id}`,
    kind: parsed?.kind ?? "raw",
    tag: parsed?.tag ?? "out",
    text: body.length > 0 ? body : line,
  };
}

/**
 * Follow state from a scroll position: within `slop` of the bottom still
 * counts as following, so scrolling back down re-engages live-follow and an
 * intentional scroll up stops it. Pure — the reducer the header badge reads.
 */
export function followFromScroll(distanceFromBottom: number, slop = FOLLOW_SLOP): boolean {
  if (!Number.isFinite(distanceFromBottom)) return true;
  return distanceFromBottom <= slop;
}
