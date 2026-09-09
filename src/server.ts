/**
 * Local dashboard server — browser UI over the run store.
 *
 * Serves the built SPA (`web/dist/`, embedded-first so the compiled `ompo`
 * binary works with no sibling files), the read-model API, the SSE event
 * stream, and the control POST — all per docs/web-dashboard-architecture.md.
 *
 * Security boundary (§7 of that note): binds loopback only by default,
 * `projectDir` is server-side config (never a client parameter), run/slice
 * ids are validated (no client-supplied paths), reads are capped like their
 * TUI counterparts, and the only mutation surface is POST …/control.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, normalize } from "node:path";
import {
  applyIntent,
  drainIntents,
  requestControl,
  validateIntent,
  type ControlIntent,
} from "./control.ts";
import { diffSliceBranch, tailSliceLog } from "./forensics.ts";
import { collectDocCandidates } from "./import.ts";
import { resolveRunId } from "./log.ts";
import { computeStats, queryEvents, replayRun } from "./stats.ts";
import { listRuns, loadRun, lockHeld, readEvents } from "./store.ts";
import type { Effort, RunEvent, SliceStatus } from "./types.ts";
import { loadRoadmapConfig } from "./config.ts";
import { loadHandoffs, type HandoffEntry } from "./handoffs.ts";
import { buildPlanPreview, formatPreviewSummary } from "./planPreview.ts";
import { sha256Hex } from "./parse.ts";
import { usageForEvent, type TokenUsage } from "./worker.ts";
import { EMBEDDED_WEB_DIST, EMBEDDED_WEB_VERSION } from "./webAssets.generated.ts";
import pkg from "../package.json";

const VERSION: string = pkg.version;

export const DEFAULT_HOST = "127.0.0.1";
/** TUI-equivalent refresh cadence for the SSE tail. */
const POLL_MS = 900;
/** SSE heartbeat so idle connections stay provably alive through proxies. */
export const HEARTBEAT_MS = 15_000;
/**
 * Bun.serve idle timeout (seconds). MUST exceed HEARTBEAT_MS: Bun's default
 * is 10s, which killed the SSE stream before the first heartbeat ever fired
 * (`request timed out after 10 seconds`, dead live-updates on the dashboard).
 */
export const IDLE_TIMEOUT_S = 60;
/** `tailSliceLog` cap for the log endpoint (arch §7). */
const LOG_MAX = 500;
const LOG_DEFAULT = 50;
/** Events page cap (arch §3). */
const EVENTS_DEFAULT_LIMIT = 200;
const EVENTS_MAX_LIMIT = 2000;

const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

// ---- browser-safe DTOs (arch §3; projections, never raw cursors/paths) ----

export interface Counts {
  done: number;
  active: number;
  failed: number;
  skipped: number;
  blockedEnv: number;
  pending: number;
}

export interface RunSummary {
  runId: string;
  createdAt: string;
  updatedAt: string;
  live: boolean;
  counts: Counts;
  /** Live workers (slices with status running/verifying). Mirrors counts.active. */
  workers: number;
  /** Total slices in the run cursor. */
  total: number;
  /** Overall run status: running while live, else failed/blocked-env/done/pending. */
  status: string;
  /** Extra attempts beyond the first per slice (sum of max(0, attempts-1)). */
  retries: number;
  /** Fresh-context handoffs recorded in handoffs.json (0 when none). */
  handoffs: number;
  /** Authoritative token spend (sum of worker_finished stats.tokens.total); null when none reported. */
  tokens: number | null;
  /** Authoritative USD cost (sum of stats.tokens.cost.total); null when no envelope reported cost. */
  cost: number | null;
}

export interface SliceSummary {
  id: string;
  title: string;
  status: SliceStatus;
  attempts: number;
  updatedAt: string;
  reason?: string;
  deps: string[];
  effort?: Effort;
  /** Worker agent/lane selector from the roadmap (e.g. "task", "sonic"). */
  agent?: string;
  /** Fresh-context generation within the current attempt (handoffs, 0-based). */
  generation: number;
  /** Verifier gate commands declared by the slice. */
  verify: string[];
}

export type RunDetail = RunSummary & { slices: SliceSummary[] };

/**
 * One fresh-context generation's authoritative spend. `usage` is the full
 * `--mode json` breakdown (sidecar first, per-generation events.jsonl
 * fallback); `tokensTotal` is the total-only fallback from handoffs.json for
 * ended generations with no observed envelope (e.g. tmux runs, which have no
 * JSON stream). Absent usage AND absent tokensTotal means unknown — the UI
 * renders "—", never 0.
 */
export interface GenerationUsage {
  attempt: number;
  generation: number;
  usage?: TokenUsage;
  tokensTotal?: number;
  durationMs?: number;
}

export interface SliceDetail {
  sliceId: string;
  title: string;
  status: SliceStatus;
  attempts: number;
  reason?: string;
  effort?: Effort;
  agent?: string;
  generation: number;
  verify: string[];
  deps: string[];
  reportSummary?: string;
  metrics?: { turns: number; tools: number; durationMs?: number; tokens?: TokenUsage };
  /** Per-generation spend, oldest first; [] when no generation ran yet. */
  generations?: GenerationUsage[];
  recentEvents: string[];
  history: string[];
  note?: string;
  verdictStep?: { name: string; exit: number | null; timedOut: boolean; tail: string };
  verdictSteps?: { name: string; exit: number | null; timedOut: boolean; tail: string }[];
  verdictPass?: boolean;
  review?: { approved: boolean; findings: string[]; notes?: string };
  reviewNotes?: string;
  promptTail?: string;
  promptName?: string;
  workerTail?: string;
  workerLogName?: string;
  /** Artifact availability (booleans only — never filesystem paths). */
  artifacts: { report: boolean; verdict: boolean; review: boolean; workerLog: boolean; prompt: boolean };
  reportFull?: {
    filesChanged: string[];
    testsRun: string[];
    deferred: string[];
    done?: boolean;
    verificationNotes?: string;
    followUps: string[];
  };
}

/**
 * Live-worker row derived from the cursor + event log + worker-log tails
 * (arch §1: no persisted agent model — point-in-time derivation like
 * `agentStates` in watch.tsx, but over durable state the server can read).
 * Browser-safe: ids and formatted lines only, never filesystem paths.
 */
export interface AgentRow {
  /** Slice id this worker is (or was most recently) attached to. */
  id: string;
  /** Lane index among the live workers in board order (0-based). */
  lane: number;
  status: SliceStatus;
  attempt: number;
  generation: number;
  agent?: string;
  effort?: Effort;
  /** Last formatted event line for the slice ("" when no events yet). */
  lastLine: string;
  /** Last finished worker counters where available (turns/tools/durationMs/tokens). */
  metrics?: { turns: number; tools: number; durationMs?: number; tokens?: TokenUsage };
}

// ---- small pure projections (ported from watch.tsx — no ink import here) ----

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function hhmmss(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Compact wall-clock duration: 45s · 5m · 2h04m. Shared with watch.tsx formatDuration — keep in sync. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** One scannable event row: TIME → EVENT → SOURCE → OPTIONAL DETAIL. Shared with watch.tsx — keep in sync. */
function formatEventLine(e: RunEvent, opts?: { source?: boolean }): string {
  const extras: string[] = [];
  if (e.attempt !== undefined) extras.push(`#${e.attempt}`);
  if (e.reason) extras.push(e.reason);
  if (e.stats) extras.push(`${e.stats.turns}t/${e.stats.tools}tl`);
  if (e.durationMs !== undefined && /finished/.test(e.type)) extras.push(formatDuration(e.durationMs));
  const suf = extras.length ? ` ${extras.join(" ")}` : "";
  const src = opts?.source === false || !e.sliceId ? "" : ` ${e.sliceId}`;
  return `${hhmmss(e.at)} ${e.type}${src}${suf}`;
}

/** Last terminal-failure reason per slice, from its own events. */
function reasonsBySlice(events: RunEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const ev of events) {
    if (ev.sliceId && (ev.type === "slice_failed_terminal" || ev.type === "verify_failed") && ev.reason) {
      m.set(ev.sliceId, ev.reason);
    }
  }
  return m;
}

function sliceMetrics(events: RunEvent[], sliceId: string): SliceDetail["metrics"] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.sliceId === sliceId && e.type === "worker_finished" && e.stats) {
      const m: NonNullable<SliceDetail["metrics"]> = { turns: e.stats.turns, tools: e.stats.tools };
      if (e.durationMs !== undefined) m.durationMs = e.durationMs;
      if (e.stats.tokens) m.tokens = { ...e.stats.tokens };
      return m;
    }
  }
  return undefined;
}

/** Last usage envelope in one generation's raw `--mode json` NDJSON stream. */
function lastUsageInEventsJsonl(projectDir: string, runId: string, sliceId: string, attempt: number, generation: number): TokenUsage | undefined {
  const path = join(projectDir, ".omp", "roadmap", "runs", runId, "slices", sliceId, `worker-${attempt}-g${generation}.events.jsonl`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let last: TokenUsage | undefined;
  // Envelopes are cumulative per session, so the last one wins; cap the scan
  // so a pathological stream cannot stall the dashboard read path.
  const lines = text.split("\n");
  const start = Math.max(0, lines.length - 2000);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || (!line.includes("message_end") && !line.includes("turn_end"))) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = usageForEvent(event);
    if (usage) last = usage;
  }
  return last;
}

/**
 * Per-generation spend for a slice, oldest first. Sources, best first:
 * `worker-<a>-g<g>.usage.json` sidecars (written by the loop with the full
 * envelope + duration), the raw per-generation events.jsonl tail (older runs
 * that predate sidecars), and handoffs.json totals for ended generations
 * with no observed envelope (tmux runs never report usage). Generations seen
 * only as log files with no usage anywhere still get a row so the chain is
 * complete — every unknown cell renders "—". Never throws.
 */
function sliceGenerations(
  projectDir: string,
  runId: string,
  sliceId: string,
  files: string[],
  events: RunEvent[],
): GenerationUsage[] {
  const keys = new Map<string, { attempt: number; generation: number }>();
  const add = (attempt: number, generation: number): void => {
    if (!Number.isInteger(attempt) || !Number.isInteger(generation) || attempt < 1 || generation < 0) return;
    keys.set(`${attempt}:g${generation}`, { attempt, generation });
  };
  for (const f of files) {
    const m = f.match(/^worker-(\d+)-g(\d+)\.(log|events\.jsonl|usage\.json)$/);
    if (m) add(Number(m[1]), Number(m[2]));
  }
  let handoffs: HandoffEntry[] = [];
  try {
    handoffs = loadHandoffs(projectDir, runId).filter((h) => h.sliceId === sliceId);
  } catch {
    /* sidecar absent — usage falls back to envelopes */
  }
  for (const h of handoffs) add(h.attempt, h.generation);
  if (keys.size === 0) return [];
  const handoffTotal = new Map<string, number>();
  for (const h of handoffs) {
    if (h.tokens > 0) handoffTotal.set(`${h.attempt}:g${h.generation}`, h.tokens);
  }
  // Final-generation duration/usage: the newest worker_finished event per attempt.
  const finishedByAttempt = new Map<number, RunEvent>();
  for (const e of events) {
    if (e.sliceId === sliceId && e.type === "worker_finished" && typeof e.attempt === "number") {
      finishedByAttempt.set(e.attempt, e);
    }
  }
  const dir = join(projectDir, ".omp", "roadmap", "runs", runId, "slices", sliceId);
  const rows = [...keys.values()].sort((a, b) => a.attempt - b.attempt || a.generation - b.generation);
  return rows.map(({ attempt, generation }) => {
    const row: GenerationUsage = { attempt, generation };
    try {
      const raw = readFileSync(join(dir, `worker-${attempt}-g${generation}.usage.json`), "utf8");
      const parsed = JSON.parse(raw) as { usage?: unknown; durationMs?: unknown };
      if (parsed && typeof parsed === "object") {
        if (parsed.usage && typeof parsed.usage === "object") {
          const u = parsed.usage as Record<string, unknown>;
          if (typeof u["input"] === "number" && typeof u["output"] === "number" && typeof u["total"] === "number") {
            row.usage = u as unknown as TokenUsage;
          }
        }
        if (typeof parsed.durationMs === "number" && Number.isFinite(parsed.durationMs) && parsed.durationMs >= 0) {
          row.durationMs = parsed.durationMs;
        }
      }
    } catch {
      /* no sidecar — fall through to the envelope scan */
    }
    if (!row.usage) {
      const envelope = lastUsageInEventsJsonl(projectDir, runId, sliceId, attempt, generation);
      if (envelope) row.usage = envelope;
    }
    if (!row.usage) {
      const total = handoffTotal.get(`${attempt}:g${generation}`);
      if (total !== undefined) row.tokensTotal = total;
    }
    if (row.durationMs === undefined) {
      const finished = finishedByAttempt.get(attempt);
      if (finished && typeof finished.durationMs === "number") {
        // worker_finished lands after the attempt's final generation ran:
        // attribute its duration only to that generation (the max gen seen
        // for the attempt), never to handed-off predecessors.
        let maxGen = generation;
        for (const k of keys.values()) if (k.attempt === attempt && k.generation > maxGen) maxGen = k.generation;
        if (generation === maxGen) row.durationMs = finished.durationMs;
      }
    }
    return row;
  });
}

/**
 * Current fresh-context generation within an attempt, from worker log names
 * (`worker-<attempt>-g<gen>.log`). 0 when no log exists yet for the attempt
 * (claimed but not spawned) or the slice dir is absent. Never throws.
 */
function generationFromFiles(files: string[], attempt: number): number {
  let gen = 0;
  let found = false;
  for (const f of files) {
    const m = f.match(/^worker-(\d+)-g(\d+)\.log$/);
    if (!m || Number(m[1]) !== attempt) continue;
    found = true;
    if (Number(m[2]) > gen) gen = Number(m[2]);
  }
  return found ? gen : 0;
}

function sliceGeneration(projectDir: string, runId: string, sliceId: string, attempt: number): number {
  try {
    const dir = join(projectDir, ".omp", "roadmap", "runs", runId, "slices", sliceId);
    return generationFromFiles(readdirSync(dir), attempt);
  } catch {
    return 0;
  }
}

/**
 * Live-worker rows: one per running/verifying slice in board order.
 * Derived from the cursor + event log (arch §1: point-in-time derivation,
 * never a new agent model). Null when the run cursor is missing.
 */
function agentsForRun(projectDir: string, runId: string): AgentRow[] | null {
  let cursor;
  try {
    cursor = loadRun(projectDir, runId);
  } catch {
    return null;
  }
  let events: RunEvent[] = [];
  try {
    events = readEvents(projectDir, runId);
  } catch {
    events = [];
  }
  const active = cursor.doc.slices.filter((s) => s.status === "running" || s.status === "verifying");
  return active.map((s, lane) => {
    const sliceEvents = events.filter((e) => e.sliceId === s.id);
    const last = sliceEvents.at(-1);
    const metrics = sliceMetrics(events, s.id);
    const row: AgentRow = {
      id: s.id,
      lane,
      status: s.status,
      attempt: s.attempts,
      generation: sliceGeneration(projectDir, runId, s.id, s.attempts),
      lastLine: last ? formatEventLine(last) : "",
    };
    if (s.workerAgent) row.agent = s.workerAgent;
    if (s.effort) row.effort = s.effort;
    if (metrics) row.metrics = metrics;
    return row;
  });
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function tailOf(path: string, lines: number): string {
  try {
    const s = readFileSync(path, "utf8").split("\n");
    return s.slice(-lines).join("\n").slice(-1200);
  } catch {
    return "";
  }
}

function summarizeRun(projectDir: string, runId: string): RunSummary | null {
  let cursor;
  try {
    cursor = loadRun(projectDir, runId);
  } catch {
    return null;
  }
  const count = (s: SliceStatus) => cursor.doc.slices.filter((x) => x.status === s).length;
  const active = count("running") + count("verifying");
  const counts: Counts = {
    done: count("done"),
    active,
    failed: count("failed"),
    skipped: count("skipped"),
    blockedEnv: count("blocked-env"),
    pending: cursor.doc.slices.filter((x) => !["done", "failed", "skipped"].includes(x.status)).length,
  };
  const total = cursor.doc.slices.length;
  const live = lockHeld(projectDir, runId);
  let retries = 0;
  for (const s of cursor.doc.slices) {
    if (typeof s.attempts === "number" && s.attempts > 1) retries += s.attempts - 1;
  }
  let handoffs = 0;
  try {
    handoffs = loadHandoffs(projectDir, runId).length;
  } catch {
    handoffs = 0;
  }
  let tokens: number | null = null;
  let cost: number | null = null;
  try {
    for (const e of readEvents(projectDir, runId)) {
      if (e.type !== "worker_finished" || !e.stats?.tokens) continue;
      const t = e.stats.tokens.total;
      if (typeof t === "number" && Number.isFinite(t) && t >= 0) tokens = (tokens ?? 0) + t;
      const c = e.stats.tokens.cost?.total;
      if (typeof c === "number" && Number.isFinite(c) && c >= 0) cost = (cost ?? 0) + c;
    }
  } catch {
    /* events unreadable — tokens/cost stay unknown */
  }
  return {
    runId,
    createdAt: cursor.createdAt,
    updatedAt: cursor.updatedAt,
    live,
    counts,
    workers: active,
    total,
    status: live ? "running" : counts.failed > 0 ? "failed" : counts.blockedEnv > 0 ? "blocked-env" : counts.active > 0 ? "running" : total > 0 && counts.done + counts.skipped === total ? "done" : "pending",
    retries,
    handoffs,
    tokens,
    cost,
  };
}

function detailForRun(projectDir: string, runId: string): RunDetail | null {
  const summary = summarizeRun(projectDir, runId);
  if (!summary) return null;
  let cursor;
  try {
    cursor = loadRun(projectDir, runId);
  } catch {
    return null;
  }
  const events = readEvents(projectDir, runId);
  const reasons = reasonsBySlice(events);
  return {
    ...summary,
    slices: cursor.doc.slices.map((s) => {
      const row: SliceSummary = {
        id: s.id,
        title: s.title,
        status: s.status,
        attempts: s.attempts,
        updatedAt: s.updatedAt,
        reason: s.status === "failed" ? reasons.get(s.id) : undefined,
        deps: [...s.deps],
        generation: sliceGeneration(projectDir, runId, s.id, s.attempts),
        verify: [...s.verify],
      };
      if (s.effort) row.effort = s.effort;
      if (s.workerAgent) row.agent = s.workerAgent;
      return row;
    }),
  };
}

/** Inspector projection with the TUI caps (arch §3). Null when the slice dir is absent. */
function sliceDetailFor(projectDir: string, runId: string, sliceId: string): SliceDetail | null {
  const run = detailForRun(projectDir, runId);
  const slice = run?.slices.find((s) => s.id === sliceId);
  if (!run || !slice) return null;
  const dir = join(projectDir, ".omp", "roadmap", "runs", runId, "slices", sliceId);
  if (!existsSync(dir)) return null;
  let files: string[] = [];
  try {
    files = readdirSync(dir).sort();
  } catch {
    /* keep empty */
  }
  const events = readEvents(projectDir, runId);
  const sliceEvents = events.filter((e) => e.sliceId === sliceId);
  const promptFile = files.filter((f) => /^(review-fix-prompt|review-prompt|debug-prompt|prompt)-\d+(-g\d+)?\.md$/.test(f)).sort().at(-1);
  const workerLog = files.filter((f) => /^(worker|debug)-\d+(-g\d+)?\.log$/.test(f)).sort().at(-1);
  const detail: SliceDetail = {
    sliceId: slice.id,
    title: slice.title,
    status: slice.status,
    attempts: slice.attempts,
    reason: slice.reason,
    generation: slice.generation,
    verify: [...slice.verify],
    deps: [...slice.deps],
    recentEvents: sliceEvents.slice(-2).reverse().map((e) => formatEventLine(e, { source: false })),
    history: sliceEvents.slice(0, -2).slice(-8).reverse().map((e) => formatEventLine(e, { source: false })),
    metrics: sliceMetrics(events, sliceId),
    generations: sliceGenerations(projectDir, runId, sliceId, files, events),
    artifacts: {
      report: files.includes("report.json"),
      verdict: files.includes("verdict.json"),
      review: files.includes("review.json"),
      workerLog: workerLog !== undefined,
      prompt: promptFile !== undefined,
    },
  };
  if (slice.effort) detail.effort = slice.effort;
  if (slice.agent) detail.agent = slice.agent;

  const report = readJson<{
    summary?: string;
    done?: boolean;
    filesChanged?: unknown;
    testsRun?: unknown;
    deferred?: unknown;
    verificationNotes?: unknown;
    followUps?: unknown;
  }>(join(dir, "report.json"));
  if (report?.summary) detail.reportSummary = report.summary;
  if (report) {
    const strs = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
    detail.reportFull = {
      filesChanged: strs(report.filesChanged).slice(0, 20),
      testsRun: strs(report.testsRun).slice(0, 10),
      deferred: strs(report.deferred).slice(0, 10),
      done: typeof report.done === "boolean" ? report.done : undefined,
      verificationNotes: typeof report.verificationNotes === "string" ? clip(report.verificationNotes, 300) : undefined,
      followUps: strs(report.followUps).slice(0, 5),
    };
  }

  const verdict = readJson<{
    pass?: boolean;
    steps?: { name: string; exit: number | null; timedOut: boolean; outputTail?: string }[];
  }>(join(dir, "verdict.json"));
  if (verdict) {
    if (typeof verdict.pass === "boolean") detail.verdictPass = verdict.pass;
    if (Array.isArray(verdict.steps)) {
      detail.verdictSteps = verdict.steps.slice(0, 6).map((s) => ({
        name: s.name,
        exit: s.exit,
        timedOut: s.timedOut,
        tail: clip((s.outputTail ?? "").trim().slice(-400), 400),
      }));
      const failedStep = verdict.steps.find((s) => s.exit !== 0);
      if (failedStep) {
        detail.verdictStep = {
          name: failedStep.name,
          exit: failedStep.exit,
          timedOut: failedStep.timedOut,
          tail: clip((failedStep.outputTail ?? "").trim().slice(-400), 400),
        };
      }
    }
  }

  const review = readJson<{ approved?: boolean; findings?: unknown; notes?: unknown }>(join(dir, "review.json"));
  if (review && typeof review.approved === "boolean") {
    detail.review = {
      approved: review.approved,
      findings: Array.isArray(review.findings)
        ? review.findings.map((f) => (typeof f === "string" ? f : JSON.stringify(f))).slice(0, 10)
        : [],
      notes: typeof review.notes === "string" ? clip(review.notes, 400) : undefined,
    };
  }
  try {
    const notesPath = join(dir, "review-notes.md");
    if (existsSync(notesPath)) detail.reviewNotes = clip(readFileSync(notesPath, "utf8").trim().slice(-800), 800);
  } catch {
    /* advisory only */
  }

  if (promptFile) {
    detail.promptName = promptFile;
    const tail = tailOf(join(dir, promptFile), 30);
    if (tail.trim()) detail.promptTail = tail;
  }
  if (workerLog) {
    detail.workerLogName = workerLog;
    const tail = tailOf(join(dir, workerLog), 60);
    if (tail.trim()) detail.workerTail = tail;
  }
  if (workerLog && !detail.note) {
    const first = tailOf(join(dir, workerLog), 6);
    if (first.trim()) detail.note = `…${workerLog} tail:\n${first}`;
  }
  return detail;
}

function newestWorkerLog(projectDir: string, runId: string, sliceId: string): string | null {
  try {
    const dir = join(projectDir, ".omp", "roadmap", "runs", runId, "slices", sliceId);
    // Same generation-aware pattern as sliceDetailFor/workerLog (watch.tsx parity): worker/debug attempt logs with optional -gN.
    return readdirSync(dir).sort().filter((f) => /^(worker|debug)-\d+(-g\d+)?\.log$/.test(f)).at(-1) ?? null;
  } catch {
    return null;
  }
}

// ---- static assets: embedded-first, working-tree second (arch §8) ----

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function diskDistFile(rel: string): { type: string; bytes: Uint8Array } | null {
  const candidates = [
    join(import.meta.dir, "..", "web", "dist", rel),
    join(process.cwd(), "web", "dist", rel),
  ];
  for (const p of candidates) {
    const norm = normalize(p);
    const root = normalize(join(import.meta.dir, "..", "web", "dist"));
    const cwdRoot = normalize(join(process.cwd(), "web", "dist"));
    if (!norm.startsWith(root) && !norm.startsWith(cwdRoot)) continue;
    try {
      if (!existsSync(norm)) continue;
      const ext = norm.slice(norm.lastIndexOf("."));
      return { type: MIME[ext] ?? "application/octet-stream", bytes: readFileSync(norm) };
    } catch {
      continue;
    }
  }
  return null;
}

function assetResponse(rel: string): Response | null {
  const embedded = EMBEDDED_WEB_DIST[rel];
  if (embedded) {
    const bytes = Buffer.from(embedded.base64, "base64");
    return new Response(bytes, { headers: assetHeaders(embedded.type) });
  }
  const disk = diskDistFile(rel);
  if (disk) return new Response(Buffer.from(disk.bytes), { headers: assetHeaders(disk.type) });
  return null;
}

function assetHeaders(type: string): HeadersInit {
  return {
    "content-type": type,
    "x-content-type-options": "nosniff",
    // No external CDN/fonts: everything is same-origin, so lock it down.
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "cache-control": "no-cache",
  };
}

function missingBuildResponse(): Response {
  return new Response(
    "dashboard bundle not built — run `bun run web:build`, then restart ompo (API routes still work)",
    { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } },
  );
}

// ---- HTTP helpers ----

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

function bad(msg: string): Response {
  return json({ error: msg }, 400);
}

/** 404 when the run cursor is missing; null (caller continues) when present. */
function requireRun(projectDir: string, runId: string): Response | null {
  try {
    loadRun(projectDir, runId);
    return null;
  } catch {
    return json({ error: `unknown run "${runId}"` }, 404);
  }
}

/** 404 when the slice id is not in the cursor doc; null when known. */
function requireSlice(projectDir: string, runId: string, sliceId: string): Response | null {
  try {
    const doc = loadRun(projectDir, runId).doc;
    if (!doc.slices.some((s) => s.id === sliceId)) return json({ error: `unknown slice "${sliceId}"` }, 404);
    return null;
  } catch {
    return json({ error: `unknown slice "${sliceId}"` }, 404);
  }
}

/** Deny cross-origin writes; same-origin and non-browser clients pass. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const h = req.headers.get("host") ?? "";
    return o.host === h;
  } catch {
    return false;
  }
}

// ---- SSE stream (arch §4) ----

function streamResponse(projectDir: string, runId: string, afterSeq: number): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastSeq = afterSeq;
  let lastLive = lockHeld(projectDir, runId);
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          /* client gone */
        }
      };
      // Replay first (HTTP version of `log --follow`: only new seqs).
      try {
        for (const ev of readEvents(projectDir, runId)) {
          if (ev.seq > lastSeq) {
            lastSeq = ev.seq;
            send(`id: ${ev.seq}\nevent: event\ndata: ${JSON.stringify(ev)}\n\n`);
          }
        }
      } catch {
        /* empty store reads as no replay */
      }
      send(`event: run\ndata: ${JSON.stringify({ runId, live: lastLive })}\n\n`);
      timer = setInterval(() => {
        let fresh: RunEvent[] = [];
        try {
          fresh = readEvents(projectDir, runId).filter((e) => e.seq > lastSeq);
        } catch {
          fresh = [];
        }
        for (const ev of fresh) {
          lastSeq = ev.seq;
          send(`id: ${ev.seq}\nevent: event\ndata: ${JSON.stringify(ev)}\n\n`);
        }
        const live = lockHeld(projectDir, runId);
        if (live !== lastLive) {
          lastLive = live;
          send(`event: run\ndata: ${JSON.stringify({ runId, live })}\n\n`);
        }
      }, POLL_MS);
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
    },
    cancel() {
      clearInterval(timer);
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-content-type-options": "nosniff",
    },
  });
}

// ---- control POST (arch §5: exactly the control_requested path) ----

async function handleControl(projectDir: string, runId: string, req: Request): Promise<Response> {
  if (!originAllowed(req)) return json({ error: "cross-origin control writes are forbidden" }, 403);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("control body must be JSON (a ControlIntent)");
  }
  const raw = body as Partial<ControlIntent>;
  const intent: ControlIntent = { kind: raw.kind as ControlIntent["kind"], sliceId: raw.sliceId, jobs: raw.jobs, reason: raw.reason };
  const invalid = validateIntent(intent);
  if (invalid) return bad(invalid);
  // Quiescent loop-local intents need a live loop (cmdCtl parity): reject
  // before appending so the log never holds an outcome-less control_requested.
  const loopLocal = intent.kind === "set-jobs" || intent.kind === "pause" || intent.kind === "resume";
  if (loopLocal && !lockHeld(projectDir, runId)) {
    return json({ ok: false, message: `${intent.kind} needs a live loop (no lock on run ${runId})`, applied: "direct" }, 200);
  }
  let requested;
  try {
    requested = requestControl(projectDir, runId, intent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/^unknown slice /.test(msg)) return json({ error: msg }, 404);
    return bad(msg);
  }

  if (lockHeld(projectDir, runId)) {
    return json({ seq: requested.seq, kind: intent.kind, ...(intent.sliceId ? { sliceId: intent.sliceId } : {}), applied: "queued" }, 202);
  }
  // Quiescent run: cmdCtl pattern — drain what we just queued and apply now.
  // `requestControl` already appended; drain everything up to our seq and apply it.
  const { intents } = drainIntents(projectDir, runId, requested.seq - 1);
  const target = intents.find((i) => i.seq === requested.seq) ?? intents[intents.length - 1];
  if (!target) return json({ ok: false, message: "intent vanished before apply", applied: "direct" }, 200);
  const res = applyIntent(projectDir, runId, target, { jobs: { value: 0 }, paused: false });
  return json({ ok: res.ok, message: res.message, applied: "direct" }, 200);
}
// ---- plan preview (roadmap inspection boundary; arch §3) ----
//
// Project-scoped (no runId): reads ROADMAP.md from disk and runs it through
// the single roadmap schema + lint implementation (`buildPlanPreview`), the
// same seam as `ompo plan` and the unified-flow preview gate. The dashboard
// holds no live preview bridge — Accept/Abort validate against the current
// disk state (blocked plans can never be accepted, mirroring
// `defaultPreviewDecision`/unified flow); Reload re-reads the file; Open
// shows the raw markdown. No in-browser editing.

/** Browser-facing roadmap filename only — never an absolute path (§7). */
const ROADMAP_FILE = "ROADMAP.md";

function planPreviewEnvelope(projectDir: string): Response {
  // Same newest-first markdown candidates `runInitPlanner` surveys (capped there).
  let surveyed: { path: string; mtimeMs: number }[] = [];
  try {
    surveyed = collectDocCandidates(projectDir);
  } catch {
    surveyed = [];
  }
  let markdown: string | null = null;
  try {
    markdown = readFileSync(join(projectDir, ROADMAP_FILE), "utf8");
  } catch {
    markdown = null;
  }
  if (markdown === null) {
    const errors = [
      {
        level: "error",
        code: "missing-roadmap",
        message: `${ROADMAP_FILE} not found — run ompo init to plan from project docs`,
      },
    ];
    return json({
      roadmapPath: ROADMAP_FILE,
      exists: false,
      status: "blocked",
      summary: "plan preview: 0 slice(s) — blocked (1 error(s))",
      rows: [],
      errors,
      warnings: [],
      surveyed,
    });
  }
  const cfg = loadRoadmapConfig(projectDir);
  const preview = buildPlanPreview(markdown, {
    verifyDefaults: cfg.verifyDefaults,
    agentModels: cfg.agentModels,
  });
  return json({
    roadmapPath: ROADMAP_FILE,
    exists: true,
    sourceHash: sha256Hex(markdown),
    status: preview.status,
    summary: formatPreviewSummary(preview),
    rows: preview.rows,
    errors: preview.errors,
    warnings: preview.warnings,
    surveyed,
  });
}

function planRoadmapRaw(projectDir: string): Response {
  try {
    const markdown = readFileSync(join(projectDir, ROADMAP_FILE), "utf8");
    return json({ path: ROADMAP_FILE, markdown });
  } catch {
    return json({ error: `${ROADMAP_FILE} not found` }, 404);
  }
}

async function handlePlanDecision(projectDir: string, req: Request): Promise<Response> {
  if (!originAllowed(req)) return json({ error: "cross-origin plan writes are forbidden" }, 403);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('decision body must be JSON ({ decision: "accept" | "abort" | "edit" })');
  }
  const decision = body && typeof body === "object" && "decision" in body ? body.decision : undefined;
  if (decision !== "accept" && decision !== "abort" && decision !== "edit") {
    return bad('decision must be "accept", "abort", or "edit"');
  }
  let markdown: string;
  try {
    markdown = readFileSync(join(projectDir, ROADMAP_FILE), "utf8");
  } catch {
    return json({ error: `${ROADMAP_FILE} not found` }, 404);
  }
  const cfg = loadRoadmapConfig(projectDir);
  const preview = buildPlanPreview(markdown, {
    verifyDefaults: cfg.verifyDefaults,
    agentModels: cfg.agentModels,
  });
  if (decision === "accept" && preview.status === "blocked") {
    return json(
      {
        error: `cannot accept: roadmap has ${preview.errors.length} blocking error(s) — fix ${ROADMAP_FILE} and reload`,
      },
      409,
    );
  }
  return json({
    ok: true,
    decision,
    status: preview.status,
    summary: formatPreviewSummary(preview),
  });
}

// ---- router ----

async function route(projectDir: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/health") return json({ ok: true, version: VERSION });

  if (path === "/api/runs" && req.method === "GET") {
    const runs = listRuns(projectDir);
    return json(runs.map((runId) => summarizeRun(projectDir, runId)).filter(Boolean));
  }

  if (path === "/api/runs/latest" && req.method === "GET") {
    const runId = resolveRunId(projectDir);
    if (!runId) return json({ error: "no runs yet" }, 404);
    return json(detailForRun(projectDir, runId));
  }

  const m = path.match(/^\/api\/runs\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const runId = decodeURIComponent(m[1]!);
    const rest = m[2] ?? "";
    if (!RUN_ID_RE.test(runId)) return bad(`invalid run id ${JSON.stringify(runId)}`);
    if (req.method === "GET" && rest === "") {
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      return json(detailForRun(projectDir, runId));
    }
    if (req.method === "GET" && rest === "slices") {
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      return json(detailForRun(projectDir, runId)?.slices ?? []);
    }
    const sliceMatch = rest.match(/^slices\/([^/]+)(?:\/(log|diff))?$/);
    if (sliceMatch) {
      const sliceId = decodeURIComponent(sliceMatch[1]!);
      const tail = sliceMatch[2];
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      const unknown = requireSlice(projectDir, runId, sliceId);
      if (unknown) return unknown;
      if (req.method === "GET" && !tail) {
        const detail = sliceDetailFor(projectDir, runId, sliceId);
        if (!detail) return json({ error: `unknown slice "${sliceId}"` }, 404);
        return json(detail);
      }
      if (req.method === "GET" && tail === "log") {
        const n = url.searchParams.has("tail") ? Number(url.searchParams.get("tail")) : LOG_DEFAULT;
        if (!Number.isInteger(n) || n < 1 || n > LOG_MAX) return bad(`tail must be an integer 1..${LOG_MAX}`);
        return json({ name: newestWorkerLog(projectDir, runId, sliceId), lines: tailSliceLog(projectDir, runId, sliceId, n) });
      }
      if (req.method === "GET" && tail === "diff") {
        return json(diffSliceBranch(projectDir, runId, sliceId));
      }
    }
    if (req.method === "GET" && rest === "agents") {
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      return json(agentsForRun(projectDir, runId) ?? []);
    }
    if (req.method === "GET" && rest === "events") {
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      const afterSeq = url.searchParams.has("afterSeq") ? Number(url.searchParams.get("afterSeq")) : -1;
      if (!Number.isInteger(afterSeq)) return bad("afterSeq must be an integer");
      const limitRaw = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : EVENTS_DEFAULT_LIMIT;
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > EVENTS_MAX_LIMIT) {
        return bad(`limit must be an integer 1..${EVENTS_MAX_LIMIT}`);
      }
      const types = new Set((url.searchParams.get("types") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      const onlySlice = url.searchParams.get("sliceId") ?? undefined;
      const all = readEvents(projectDir, runId);
      let offset = -1;
      for (const ev of all) if (ev.seq > offset) offset = ev.seq;
      const events = all
        .filter((e) => e.seq > afterSeq)
        .filter((e) => types.size === 0 || types.has(e.type))
        .filter((e) => onlySlice === undefined || e.sliceId === onlySlice)
        .slice(0, limitRaw);
      return json({ events, offset });
    }
    if (req.method === "GET" && rest === "stats") {
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      return json(computeStats(projectDir, runId));
    }
    if (req.method === "GET" && rest === "query") {
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      const q = url.searchParams.get("q") ?? "";
      try {
        return json({ events: queryEvents(projectDir, runId, q) });
      } catch (err) {
        return bad(err instanceof Error ? err.message : String(err));
      }
    }
    if (req.method === "GET" && rest === "replay") {
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      return json(replayRun(projectDir, runId));
    }
    // Canonical live tail is …/events/stream (arch §4); …/stream is the legacy alias older bundles use.
    if (req.method === "GET" && (rest === "stream" || rest === "events/stream")) {
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      const q = url.searchParams.get("afterSeq");
      const headerId = req.headers.get("last-event-id");
      const raw = q ?? headerId ?? "-1";
      const afterSeq = Number(raw);
      if (!Number.isInteger(afterSeq)) return bad("afterSeq must be an integer");
      return streamResponse(projectDir, runId, afterSeq);
    }
    if (req.method === "POST" && rest === "control") {
      const missing = requireRun(projectDir, runId);
      if (missing) return missing;
      return handleControl(projectDir, runId, req);
    }
  }
  if (path === "/api/plan/preview" && req.method === "GET") return planPreviewEnvelope(projectDir);
  if (path === "/api/plan/roadmap" && req.method === "GET") return planRoadmapRaw(projectDir);
  if (path === "/api/plan/decision" && req.method === "POST") return handlePlanDecision(projectDir, req);

  // `/api/*` is reserved: unknown API paths are 404, never the SPA shell.
  if (path === "/api" || path.startsWith("/api/")) return json({ error: "not found" }, 404);
  if (req.method === "GET") {
    if (path === "/") {
      return assetResponse("index.html") ?? missingBuildResponse();
    }
    const rel = decodeURIComponent(path.slice(1));
    if (rel && !rel.includes("..") && !rel.startsWith("/")) {
      const hit = assetResponse(rel);
      if (hit) return hit;
    }
    // Client routes fall back to the shell; no bundle at all → 503, never a blank page.
    return assetResponse("index.html") ?? missingBuildResponse();
  }

  return json({ error: "not found" }, 404);
}

// ---- lifecycle ----

export interface DashboardOptions {
  projectDir: string;
  /** Explicit port; omitted/0 → automatically selected available localhost port. */
  port?: number;
  host?: string;
}

export interface DashboardServer {
  url: string;
  host: string;
  port: number;
  /** Embedded bundle, working-tree files, or missing (API-only with 503 shell). */
  assetMode: "embedded" | "disk" | "missing";
  stop: () => void;
}

export function dashboardAssetMode(): DashboardServer["assetMode"] {
  if (Object.keys(EMBEDDED_WEB_DIST).length > 0) return "embedded";
  if (
    existsSync(join(import.meta.dir, "..", "web", "dist", "index.html")) ||
    existsSync(join(process.cwd(), "web", "dist", "index.html"))
  ) {
    return "disk";
  }
  return "missing";
}

export function startDashboardServer(opts: DashboardOptions): DashboardServer {
  const host = opts.host ?? DEFAULT_HOST;
  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? 0,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: (req) => route(opts.projectDir, req),
  });
  const port = server.port ?? opts.port ?? 0;
  return {
    url: `http://${host}:${port}`,
    host,
    port,
    assetMode: dashboardAssetMode(),
    stop: () => server.stop(),
  };
}

/** Bundle version embedded at build time ("" before the first web build). */
export function embeddedWebVersion(): string {
  return EMBEDDED_WEB_VERSION;
}
