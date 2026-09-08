/**
 * ompo watch — read-only TUI over the run store (log output for humans).
 *
 * Layout: header (run picker + summary) → two panes (slice board | detail of
 * the selected slice) → key hints. Pure reader: it never writes to the store,
 * so it costs the orchestrator nothing. Polls roadmap.json/events.jsonl on a
 * throttle (~900ms) and re-renders diffs only — worker trace files are read
 * lazily for the selected slice, never streamed.
 *
 * Keys:
 *   ↑/↓ or j/k   select slice        ←/→ or h/l   switch run
 *   r            force refresh       q            quit
 *
 * Implementation notes (why this stays cheap): state updates come from one
 * interval; per tick we stat/read a handful of small JSONL/JSON files for the
 * current run + the selected slice's artifacts (capped tails). No full-file
 * scans, no tail -f equivalents, no per-event React renders — the verbose
 * worker telemetry files are only touched on demand and only their tail.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listRuns, loadRun, lockHeld } from "./store.ts";
import type { RunEvent, Slice, SliceStatus } from "./types.ts";

const POLL_MS = 900;

// ── semantic state (glyph + word + color; never color alone) ──
// Glyphs stay in the same compatibility class as the existing ●○▸▲◀▶✗:
// hollow ○ = idle/waiting, solid ● = active work, ✓/!/– = outcome.
const STATUS_STYLE: Record<string, { glyph: string; label: string; color: string; bold?: boolean }> = {
  pending: { glyph: "○", label: "pend", color: "gray" },
  running: { glyph: "●", label: "run ", color: "cyan", bold: true },
  verifying: { glyph: "●", label: "gates", color: "yellow", bold: true },
  done: { glyph: "✓", label: "done", color: "green" },
  failed: { glyph: "!", label: "FAIL", color: "red", bold: true },
  aborted: { glyph: "–", label: "stop", color: "gray" },
  blocked: { glyph: "○", label: "wait", color: "magenta" },
  "blocked-env": { glyph: "○", label: "env ", color: "magenta" },
  skipped: { glyph: "○", label: "skip", color: "gray" },
};

/**
 * Running indicator derived from the existing 900ms poll tick — no new
 * render loop. Frozen glyph when idle (pass live=false → always ○).
 */
export function spinnerFrame(nowMs: number, live: boolean): string {
  if (!live) return "○";
  return ["◐", "◓", "◑", "◒"][Math.floor(nowMs / 900) % 4]!;
}
export interface AgentRow {
  id: string;
  tag?: string;
  last: string;
}

/**
 * Live agent states derived from recent `[id] …` / `[id tag] …` worker
 * progress lines — no extra plumbing, computed at render time from the
 * capped log bus. Pure — unit-tested.
 */
export function agentStates(lines: string[]): AgentRow[] {
  const seen = new Map<string, AgentRow>();
  for (const line of lines) {
    const m = line.match(/^\s*\[([^\]\s]+)(?:\s+([^\]]+))?\]\s*(.*)$/);
    if (m) seen.set(m[1]!, { id: m[1]!, tag: m[2]?.trim() || undefined, last: (m[3] ?? "").trim() });
  }
  return [...seen.values()].slice(-8);
}

export interface AgentsOpts {
  agents: AgentRow[];
  statusOf: (id: string) => SliceLine | undefined;
  width?: number;
  /** Ids holding the verify+merge mutex (from mutexHolders). Shown as 🔒 in the header. */
  verifyingIds?: string[];
}

/** Operational agent summary: identity · phase · state + last line. Two-line rows so the state chip survives narrow rails; width-aware clipping keeps every row inside the rail. */
export function AgentsPane({ agents, statusOf, width, verifyingIds }: AgentsOpts) {
  const w = width ?? 32;
  const inner = Math.max(10, w - 2);
  const locks = (verifyingIds ?? []).filter((id) => id.trim());
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" marginTop={1} width={w} flexShrink={0}>
      <Text bold color="white"> agents{locks.length > 0 ? <Text color="yellow"> · 🔒 {locks.join(",")}</Text> : null} </Text>
      {agents.length === 0 ? (
        <Text dimColor>(idle — no agent output yet)</Text>
      ) : (
        agents.map((a, lane) => {
          const s = statusOf(a.id);
          const st = (s && STATUS_STYLE[s.status]) ?? { glyph: "○", label: "?", color: "gray" };
          return (
            <Box key={a.id} flexDirection="column">
              <Text wrap="truncate">
                <Text dimColor>L{lane} </Text>
                <Text color={st.color} bold>{st.glyph}</Text> <Text bold color="white">{clip(a.id, inner - 11)}</Text>
                {s ? <Text color={st.color}> [{st.label.trim()}]</Text> : null}
              </Text>
              <Text dimColor wrap="truncate">
                {" " + clip(`${a.tag ?? "agent"} — ${a.last || "(started)"}`, inner - 2)}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

/** Compact wall-clock duration: 45s · 5m · 2h04m. Pure. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export interface SliceLine {
  id: string;
  title: string;
  status: SliceStatus;
  attempts: number;
  updatedAt: string;
  reason?: string;
  /** Roadmap Depends: ids (absent in old fixtures → treated as no deps). */
  deps?: string[];
}

/** Inspector tabs: 1 Output · 2 Diff · 3 Verify · 4 Review · 5 Prompt · 6 Events. */
export const INSPECTOR_TABS = ["Output", "Diff", "Verify", "Review", "Prompt", "Events"] as const;

/** Clamp a raw tab index into the tab band. Pure. */
export function clampTab(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.floor(n), 0), INSPECTOR_TABS.length - 1);
}

export interface DetailView {
  sliceId: string;
  title: string;
  status: SliceStatus;
  attempts: number;
  reason?: string;
  reportSummary?: string;
  /** Last finished worker run counters (worker_finished event stats). */
  metrics?: { turns: number; tools: number; durationMs?: number };
  /** Newest slice events first (formatted, capped for the LAST EVENT section). */
  recentEvents: string[];
  /** Older slice events, dimmed HISTORY section (formatted, capped). */
  history: string[];
  /** Invalid report block, or a short worker/debug log tail when nothing else explains it. */
  note?: string;
  verdictStep?: { name: string; exit: number | null; timedOut: boolean; tail: string };
  /** All verdict gate steps (Verify tab); verdictStep stays the first failure for compat. */
  verdictSteps?: { name: string; exit: number | null; timedOut: boolean; tail: string }[];
  verdictPass?: boolean;
  /** review.json verdict (Review tab). */
  review?: { approved: boolean; findings: string[]; notes?: string };
  /** review-notes.md tail (feeds the next attempt). */
  reviewNotes?: string;
  /** Newest prompt-*.md tail + its file name (Prompt tab). */
  promptTail?: string;
  promptName?: string;
  /** Newest worker/debug log tail for forensics (capped) + its file name. */
  workerTail?: string;
  workerLogName?: string;
  /** report.json file/change/deferral lists (Diff tab). */
  reportFull?: { filesChanged: string[]; testsRun: string[]; deferred: string[]; done?: boolean; verificationNotes?: string; followUps: string[] };
  /** Absolute slice artifact dir (forensics paths). */
  sliceDir?: string;
}

export interface RunView {
  runs: string[];
  runIdx: number;
  sel: number;
  runId: string;
  createdAt: string;
  updatedAt: string;
  counts: { done: number; active: number; failed: number; skipped: number; blockedEnv: number; pending: number };
  live: boolean;
  slices: SliceLine[];
  detail: DetailView | null;
}

export function hhmmss(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Last terminal-failure reason for a slice, from its own events. */
function reasonsBySlice(events: RunEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const ev of events) {
    if (ev.sliceId && (ev.type === "slice_failed_terminal" || ev.type === "verify_failed") && ev.reason) {
      m.set(ev.sliceId, ev.reason);
    }
  }
  return m;
}
/** One scannable event row: TIME → EVENT → SOURCE → OPTIONAL DETAIL. Pure. */
export function formatEventLine(e: RunEvent, opts?: { source?: boolean }): string {
  const extras: string[] = [];
  if (e.attempt !== undefined) extras.push(`#${e.attempt}`);
  if (e.reason) extras.push(e.reason);
  if (e.stats) extras.push(`${e.stats.turns}t/${e.stats.tools}tl`);
  if (e.durationMs !== undefined && /finished/.test(e.type)) extras.push(formatDuration(e.durationMs));
  const suf = extras.length ? ` ${extras.join(" ")}` : "";
  const src = opts?.source === false || !e.sliceId ? "" : ` ${e.sliceId}`;
  return `${hhmmss(e.at)} ${e.type}${src}${suf}`;
}

/** Counters from the slice's last finished worker run, if any. Pure. */
export function sliceMetrics(events: RunEvent[], sliceId: string): { turns: number; tools: number; durationMs?: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.sliceId === sliceId && e.type === "worker_finished" && e.stats) {
      return e.durationMs !== undefined
        ? { turns: e.stats.turns, tools: e.stats.tools, durationMs: e.durationMs }
        : { turns: e.stats.turns, tools: e.stats.tools };
    }
  }
  return undefined;
}


// ── artifact reads (selected slice only, capped) ───────────────────────
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

function buildDetail(project: string, runId: string, slice: SliceLine, events: RunEvent[]): DetailView | null {
  const dir = join(project, ".omp", "roadmap", "runs", runId, "slices", slice.id);
  if (!existsSync(dir)) return null;
  let files: string[] = [];
  try {
    files = readdirSync(dir).sort();
  } catch {
    /* keep empty */
  }
  const sliceEvents = events.filter((e) => e.sliceId === slice.id);
  const recent = sliceEvents.slice(-2).reverse().map((e) => formatEventLine(e, { source: false }));
  const detail: DetailView = {
    sliceId: slice.id,
    title: slice.title,
    status: slice.status,
    attempts: slice.attempts,
    reason: slice.reason,
    recentEvents: recent,
    history: sliceEvents.slice(0, -2).slice(-8).reverse().map((e) => formatEventLine(e, { source: false })),
    metrics: sliceMetrics(events, slice.id),
    sliceDir: dir,
  };

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
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : []);
    detail.reportFull = {
      filesChanged: strs(report.filesChanged).slice(0, 20),
      testsRun: strs(report.testsRun).slice(0, 10),
      deferred: strs(report.deferred).slice(0, 10),
      done: typeof report.done === "boolean" ? report.done : undefined,
      verificationNotes: typeof report.verificationNotes === "string" ? clip(report.verificationNotes, 300) : undefined,
      followUps: strs(report.followUps).slice(0, 5),
    };
  }


  // Newest attempt's invalid report (worker produced no usable report block).
  const invalid = files
    .filter((f) => /^report-\d+\.invalid\.json$/.test(f))
    .sort()
    .at(-1);
  if (invalid) {
    const rec = readJson<{ error?: string }>(join(dir, invalid));
    if (rec?.error) detail.note = clip(rec.error, 220);
  }

  // Verdict: all gate steps (Verify tab) + first failure kept for compat.
  const verdict = readJson<{ pass?: boolean; steps?: { name: string; exit: number | null; timedOut: boolean; outputTail?: string }[] }>(
    join(dir, "verdict.json"),
  );
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

  // Review verdict + retry-feeding notes (Review tab).
  const review = readJson<{ approved?: boolean; findings?: unknown; notes?: unknown }>(join(dir, "review.json"));
  if (review && typeof review.approved === "boolean") {
    const findings = Array.isArray(review.findings)
      ? review.findings.map((f) => (typeof f === "string" ? f : JSON.stringify(f))).slice(0, 10)
      : [];
    detail.review = {
      approved: review.approved,
      findings,
      notes: typeof review.notes === "string" ? clip(review.notes, 400) : undefined,
    };
  }
  try {
    const notesPath = join(dir, "review-notes.md");
    if (existsSync(notesPath)) detail.reviewNotes = clip(readFileSync(notesPath, "utf8").trim().slice(-800), 800);
  } catch {
    /* advisory only */
  }

  // Newest prompt (Prompt tab): worker, review, or debug prompt.
  const promptFile = files.filter((f) => /^(review-prompt|debug-prompt|prompt)-\d+\.md$/.test(f)).sort().at(-1);
  if (promptFile) {
    detail.promptName = promptFile;
    const tail = tailOf(join(dir, promptFile), 30);
    if (tail.trim()) detail.promptTail = tail;
  }

  // Newest worker/diagnosis log: short tail for Output, longer tail for forensics.
  const workerLog = files.filter((f) => /^(worker|debug)-\d+\.log$/.test(f)).sort().at(-1);
  if (workerLog) {
    detail.workerLogName = workerLog;
    const tail = tailOf(join(dir, workerLog), 60);
    if (tail.trim()) detail.workerTail = tail;
  }
  // A short worker/diagnosis log tail is more useful than nothing.
  if (workerLog && !detail.note) {
    const first = tailOf(join(dir, workerLog), 6);
    if (first.trim()) detail.note = `…${workerLog} tail:\n${first}`;
  }
  return detail;
}

/** Full view for one concrete run id (the live run TUI pins its own run). */
export function viewForRun(project: string, runId: string, sel: number): RunView | null {
  let cursor;
  try {
    cursor = loadRun(project, runId);
  } catch {
    return null;
  }
  const events = readEventsSafe(project, runId);
  const reasons = reasonsBySlice(events);
  const count = (s: SliceStatus) => cursor.doc.slices.filter((x) => x.status === s).length;
  const slices: SliceLine[] = cursor.doc.slices.map((s: Slice) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    attempts: s.attempts,
    updatedAt: s.updatedAt,
    reason: s.status === "failed" ? reasons.get(s.id) : undefined,
    deps: [...s.deps],
  }));
  const selIdx = Math.min(Math.max(sel, 0), Math.max(slices.length - 1, 0));
  const selSlice = slices[selIdx] ?? null;
  const live = lockHeld(project, runId);
  const counts = {
    done: count("done"),
    active: count("running") + count("verifying"),
    failed: count("failed"),
    skipped: count("skipped"),
    blockedEnv: count("blocked-env"),
    pending: cursor.doc.slices.filter((x) => !["done", "failed", "skipped"].includes(x.status)).length,
  };
  const runs = listRuns(project);
  return {
    runs,
    runIdx: Math.max(runs.indexOf(runId), 0),
    sel: selIdx,
    runId,
    createdAt: cursor.createdAt,
    updatedAt: cursor.updatedAt,
    counts,
    live,
    slices,
    detail: selSlice ? buildDetail(project, runId, selSlice, events) : null,
  };
}

function loadView(project: string, runIdx: number, sel: number): RunView | null {
  const runs = listRuns(project);
  if (runs.length === 0) {
    return { runs, runIdx: 0, sel: 0, runId: "", createdAt: "", updatedAt: "", counts: { done: 0, active: 0, failed: 0, skipped: 0, blockedEnv: 0, pending: 0 }, live: false, slices: [], detail: null };
  }
  const idx = Math.min(Math.max(runIdx, 0), runs.length - 1);
  return viewForRun(project, runs[idx]!, sel);
}

function readEventsSafe(project: string, runId: string): RunEvent[] {
  try {
    const path = join(project, ".omp", "roadmap", "runs", runId, "events.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RunEvent)
      .filter((e) => typeof e?.seq === "number");
  } catch {
    return [];
  }
}

/** Statuses that mean "needs eyes" for failure triage. Pure. */
export function isFailureStatus(s: SliceStatus): boolean {
  return s === "failed" || s === "blocked-env";
}

/** Full indexes of failure slices, in board order. Pure. */
export function failureIndices(slices: SliceLine[]): number[] {
  const out: number[] = [];
  slices.forEach((s, i) => {
    if (isFailureStatus(s.status)) out.push(i);
  });
  return out;
}

/** Next failure at/after `from`, wrapping to the first. -1 when none. Pure. */
export function nextFailure(slices: SliceLine[], from: number): number {
  const fails = failureIndices(slices);
  if (fails.length === 0) return -1;
  for (const i of fails) if (i >= from) return i;
  return fails[0]!;
}

/** Prev failure at/before `from`, wrapping to the last. -1 when none. Pure. */
export function prevFailure(slices: SliceLine[], from: number): number {
  const fails = failureIndices(slices);
  if (fails.length === 0) return -1;
  for (let k = fails.length - 1; k >= 0; k--) if (fails[k]! <= from) return fails[k]!;
  return fails[fails.length - 1]!;
}

/** Full indexes visible under the failures-only filter. Pure. */
export function visibleIndices(slices: SliceLine[], failuresOnly: boolean): number[] {
  if (!failuresOnly) return slices.map((_, i) => i);
  return failureIndices(slices);
}

/**
 * Move selection one step within the visible rows (failures-only aware).
 * Clamps at the ends like the existing j/k behavior. Pure.
 */
export function moveSel(slices: SliceLine[], cur: number, dir: 1 | -1, failuresOnly: boolean): number {
  const vis = visibleIndices(slices, failuresOnly);
  if (vis.length === 0) return Math.min(Math.max(cur, 0), Math.max(slices.length - 1, 0));
  const at = vis.indexOf(cur);
  if (at === -1) return dir === 1 ? vis[0]! : vis[vis.length - 1]!;
  return vis[Math.min(Math.max(at + dir, 0), vis.length - 1)]!;
}

/** Narrow terminal: stack board above inspector instead of side-by-side. Pure. */
export function isNarrow(cols: number): boolean {
  return cols < 80;
}

/** Ids currently holding the verify+merge serialization (commit mutex). Pure. */
export function mutexHolders(slices: SliceLine[]): string[] {
  return slices.filter((s) => s.status === "verifying").map((s) => s.id);
}

/**
 * DAG depth per slice id: longest dep chain from a root (roots = 0).
 * Unknown deps count as roots; cycles fall back to first-seen order instead
 * of looping (the parser rejects cycles, this stays total anyway). Pure.
 */
export function dagDepths(slices: SliceLine[]): Map<string, number> {
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

/** Wall-clock since a slice's last store update, compact (`4m`, `""` when unparseable). Pure. */
export function elapsedSince(updatedAt: string, nowMs: number): string {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return "";
  return formatDuration(Math.max(0, nowMs - t));
}

/** Ids that became failed since the last poll (bell on discovery). Pure. */
export function newFailures(prev: readonly string[], cur: readonly string[]): string[] {
  const before = new Set(prev);
  return cur.filter((id) => !before.has(id));
}

/** Terminal bell (failure discovery). Side effect, isolated for tests to skip. */
export function bell(): void {
  try {
    process.stdout.write("");
  } catch {
    /* headless — silent */
  }
}

/** Forensics identity for a slice: artifact dir + worktree branch. Pure. */
export function forensicsPaths(project: string, runId: string, sliceId: string): { dir: string; branch: string } {
  return { dir: join(project, ".omp", "roadmap", "runs", runId, "slices", sliceId), branch: `ompo/${runId}/${sliceId}` };
}

/**
 * Yank the slice dir for mouse-copy / scripting: records it at
 * `.omp/last-slice-path` (gitignored) and returns the path. Best-effort.
 */
export function yankSlicePath(project: string, runId: string, sliceId: string): string {
  const { dir } = forensicsPaths(project, runId, sliceId);
  try {
    writeFileSync(join(project, ".omp", "last-slice-path"), dir + "\n", "utf8");
  } catch {
    /* read-only checkout — caller still shows the path */
  }
  return dir;
}

/** Shared key help, rendered by the `?` overlay and mirrored in footers. */
export const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["↑/↓ j/k", "select slice"],
  ["n/p", "next/prev failure (wraps, bells)"],
  ["F", "failures-only filter"],
  ["g", "board list ↔ DAG"],
  ["1–6", "inspector tab (Output Diff Verify Review Prompt Events)"],
  ["Enter/Esc", "forensics fullscreen open/close (+↑↓ PgUp/PgDn scroll, y yank path)"],
  ["PgUp/PgDn", "scroll activity"],
  ["r", "force refresh"],
  ["?/Esc", "this help open/close"],
  ["q", "quit (run TUIs: abort, exit 2)"],
];

/** Live-loop control keys (run + unified TUIs only — watch stays read-only). */
export const CONTROL_HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["R / S / B / K", "retry-now · skip · park (env) · kill selected slice"],
  ["+ / -", "scale jobs live (1..32)"],
  ["P", "pause / resume the claim loop"],
];

/** Cursor lands on what needs eyes: failed/running first, then done, else top. */
export function preferredSel(slices: SliceLine[]): number {
  const rank = (s: SliceLine) =>
    s.status === "failed" || s.status === "running" || s.status === "verifying" ? 0 : s.status === "done" ? 1 : 2;
  let best = 0;
  for (let i = 1; i < slices.length; i++) if (rank(slices[i]!) < rank(slices[best]!)) best = i;
  return best;
}

/** Compact run-progress line: "done 2 · active 1 · pend 3" (header, all TUIs). */
export function summaryText(view: RunView): string {
  const { counts } = view;
  return [
    counts.done ? `done ${counts.done}` : null,
    counts.active ? `active ${counts.active}` : null,
    counts.failed ? `fail ${counts.failed}` : null,
    counts.blockedEnv ? `env ${counts.blockedEnv}` : null,
    counts.skipped ? `skip ${counts.skipped}` : null,
    counts.pending ? `pend ${counts.pending}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Adaptive board width: ~30% of columns, clamped so ids survive narrow screens. */
export function boardWidth(cols: number): number {
  return Math.max(24, Math.min(38, Math.floor(cols * 0.3)));
}

/**
 * Layout rails shared by watch/run/unified: board width + gutter rule.
 * Wide terminals place the board beside the inspector with a 1-col gutter;
 * narrow ones (<80) stack full-width panes with no gutter. Pure — the
 * structural tests pin this contract instead of rendered pixels.
 */
export function layoutRects(cols: number): { narrow: boolean; board: number; gutter: number } {
  const narrow = isNarrow(cols);
  return { narrow, board: narrow ? Math.max(24, cols - 2) : boardWidth(cols), gutter: narrow ? 0 : 1 };
}

/** DAG row indent prefix for a dep depth (caps at 4 — matches DagChip). Pure. */
export function dagIndent(depth: number): string {
  return depth > 0 ? `${"  ".repeat(Math.min(depth, 4))}└─ ` : "";
}

export interface BoardOpts {
  view: RunView;
  width?: number;
  /** 'list' (roadmap order) or 'dag' (dep-depth indent + needs). Default 'list'. */
  mode?: "list" | "dag";
  /** Show only failed + blocked-env slices. Default false. */
  failuresOnly?: boolean;
  /** Wall-clock for the running-row spinner + elapsed ticker. Default Date.now(). */
  nowMs?: number;
}

function SliceChip({ slice, maxName, selected, spin, elapsed }: { slice: SliceLine; maxName: number; selected: boolean; spin?: string; elapsed?: string }) {
  const c = STATUS_STYLE[slice.status] ?? { glyph: "○", label: slice.status.slice(0, 5), color: "gray" };
  const label = c.label.padEnd(5);
  const name = slice.status === "failed" ? slice.id : `${slice.id}${slice.attempts > 1 ? ` ×${slice.attempts}` : ""}`;
  // Selected rows invert (black on white) so the cursor slice dominates;
  // the status glyph keeps its semantic color so states stay distinct.
  return (
    <Text bold={selected || c.bold} color={selected ? "black" : undefined} wrap="truncate">
      {spin ? <Text color="cyan">{spin} </Text> : null}
      <Text color={c.color} bold={selected || c.bold}>{`${c.glyph} [${label}]`}</Text> {clip(name, maxName)}
      {elapsed ? <Text dimColor> · {elapsed}</Text> : null}
      {slice.status === "failed" && slice.reason ? <Text color={selected ? "black" : "red"}> {clip(slice.reason, maxName)}</Text> : null}
    </Text>
  );
}

/** DAG row: depth indent + status chip + `← dep` suffix. Pure structure, same selection model. */
function DagChip({ slice, maxName, selected, depth, spin, elapsed }: { slice: SliceLine; maxName: number; selected: boolean; depth: number; spin?: string; elapsed?: string }) {
  const deps = slice.deps ?? [];
  const indent = dagIndent(depth);
  const suffix = deps.length > 0 ? ` ← ${deps.join(",")}` : "";
  const c = STATUS_STYLE[slice.status] ?? { glyph: "○", label: slice.status.slice(0, 5), color: "gray" };
  const label = c.label.padEnd(5);
  return (
    <Text bold={selected || c.bold} color={selected ? "black" : undefined} wrap="truncate">
      <Text dimColor>{indent}</Text>
      {spin ? <Text color="cyan">{spin} </Text> : null}
      <Text color={c.color} bold={selected || c.bold}>{`${c.glyph} [${label}]`}</Text> {clip(slice.id, maxName)}
      {elapsed ? <Text dimColor> · {elapsed}</Text> : null}
      {deps.length > 0 ? <Text dimColor>{clip(suffix, maxName)}</Text> : null}
    </Text>
  );
}

/** Left pane: the slice board (shared by watch + live run TUIs). Fixed outer width; never compresses the inspector. */
export function BoardPane({ view, width, mode, failuresOnly, nowMs }: BoardOpts) {
  const w = width ?? 32;
  const dag = mode === "dag";
  const filter = failuresOnly === true;
  const now = nowMs ?? Date.now();
  const maxName = Math.max(8, w - 16);
  const rows = visibleIndices(view.slices, filter);
  const depths = dag ? dagDepths(view.slices) : null;
  const live = (s: SliceLine): boolean => s.status === "running" || s.status === "verifying";
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor="gray" flexShrink={0}>
      <Text bold color="white"> slices{dag ? " · dag" : ""}{filter ? " · failures" : ""} </Text>
      {rows.length === 0 ? (
        <Text dimColor>{filter ? "(no failures — F shows all)" : "(no slices)"}</Text>
      ) : (
        rows.map((i) => {
          const s = view.slices[i]!;
          const active = live(s);
          const spin = active ? spinnerFrame(now, true) : undefined;
          const elapsed = active ? elapsedSince(s.updatedAt, now) || undefined : undefined;
          return (
            <Box key={s.id} backgroundColor={i === view.sel ? "white" : undefined}>
              <Box flexShrink={0}>
                <Text color={i === view.sel ? "black" : "gray"}>{i === view.sel ? "▸ " : "  "}</Text>
              </Box>
              {dag ? (
                <DagChip slice={s} maxName={maxName} selected={i === view.sel} depth={depths!.get(s.id) ?? 0} spin={spin} elapsed={elapsed} />
              ) : (
                <SliceChip slice={s} maxName={maxName} selected={i === view.sel} spin={spin} elapsed={elapsed} />
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
}

/** Subtle horizontal rule + dim label: separates inspector blocks without nested boxes. */
function Section({ title }: { title: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} borderColor="gray" />
      <Text dimColor>{title}</Text>
    </Box>
  );
}

export interface InspectorOpts {
  view: RunView;
  /** 0 Output · 1 Diff · 2 Verify · 3 Review · 4 Prompt · 5 Events. Default 0. */
  tab?: number;
  /** Gutter off the board rail; false stacks flush in narrow terminals. Default true. */
  gutter?: boolean;
}

function InspectorTabBar({ tab }: { tab: number }) {
  return (
    <Box marginTop={1}>
      {INSPECTOR_TABS.map((t, i) => (
        <Box key={t} marginRight={1}>
          {i === tab ? (
            <Text bold color="black" backgroundColor="white"> {i + 1}:{t} </Text>
          ) : (
            <Text dimColor>
              {" "}
              {i + 1}:{t}{" "}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function OutputTab({ d }: { d: DetailView }) {
  return (
    <Box flexDirection="column">
      {d.metrics ? (
        <>
          <Section title="LAST RUN" />
          <Text dimColor>
            {d.metrics.turns} turns · {d.metrics.tools} tools
            {d.metrics.durationMs !== undefined ? ` · ${formatDuration(d.metrics.durationMs)}` : ""}
          </Text>
        </>
      ) : null}
      {d.recentEvents.length > 0 ? (
        <>
          <Section title="LAST EVENT" />
          {d.recentEvents.map((e, i) => (
            <Text key={i} color={i === 0 ? undefined : "gray"} dimColor={i !== 0}>
              {"  " + e}
            </Text>
          ))}
        </>
      ) : null}
      <Section title="OUTPUT" />
      {d.reportSummary ? (
        <Text wrap="wrap" color="green">
          summary: {clip(d.reportSummary, 800)}
        </Text>
      ) : null}
      {d.verdictStep ? (
        <Box flexDirection="column">
          <Text color="red">
            ✗ gate {d.verdictStep.name} exit={String(d.verdictStep.exit)} timedOut={String(d.verdictStep.timedOut)}
          </Text>
          <Text wrap="wrap" color="gray">
            {d.verdictStep.tail}
          </Text>
        </Box>
      ) : null}
      {d.note ? (
        <Text wrap="wrap" color="yellow">
          {d.note}
        </Text>
      ) : null}
      {!d.reportSummary && !d.verdictStep && !d.note ? (
        <Text dimColor>
          {d.status === "running" || d.status === "verifying"
            ? "no output yet — waiting for worker output…"
            : d.status === "pending" || d.status === "blocked" || d.status === "blocked-env"
              ? "no output yet — worker hasn't started"
              : "no output yet"}
        </Text>
      ) : null}
    </Box>
  );
}

function DiffTab({ d }: { d: DetailView }) {
  const full = d.reportFull;
  return (
    <Box flexDirection="column">
      <Section title="FILES CHANGED" />
      {!full || full.filesChanged.length === 0 ? (
        <Text dimColor>no file list yet — the worker reports filesChanged on finish</Text>
      ) : (
        full.filesChanged.map((f) => <Text key={f} color="cyan">  ± {f}</Text>)
      )}
      <Section title="TESTS + DEFERRALS" />
      {!full || (full.testsRun.length === 0 && full.deferred.length === 0 && full.followUps.length === 0) ? (
        <Text dimColor>nothing recorded</Text>
      ) : (
        <>
          {full.testsRun.map((t) => (
            <Text key={t} dimColor>  ✓ {t}</Text>
          ))}
          {full.deferred.map((x) => (
            <Text key={x} color="yellow">  … deferred: {clip(x, 120)}</Text>
          ))}
          {full.followUps.map((x) => (
            <Text key={x} dimColor>  → follow-up: {clip(x, 120)}</Text>
          ))}
          {full.verificationNotes ? <Text dimColor>  notes: {full.verificationNotes}</Text> : null}
        </>
      )}
      {d.sliceDir ? <Text dimColor>artifacts: {d.sliceDir} · branch ompo/…/{d.sliceId} · Enter for forensics</Text> : null}
    </Box>
  );
}

function VerifyTab({ d }: { d: DetailView }) {
  return (
    <Box flexDirection="column">
      <Section title={d.verdictPass === undefined ? "GATES" : d.verdictPass ? "GATES · PASS" : "GATES · FAIL"} />
      {!d.verdictSteps || d.verdictSteps.length === 0 ? (
        <Text dimColor>no verdict yet — gates run after the worker finishes</Text>
      ) : (
        d.verdictSteps.map((s) => (
          <Box key={s.name} flexDirection="column">
            <Text color={s.exit === 0 ? "green" : "red"}>
              {s.exit === 0 ? "✓" : "✗"} {s.name} exit={String(s.exit)} timedOut={String(s.timedOut)}
            </Text>
            {s.tail ? (
              <Text wrap="wrap" color="gray">
                {s.tail}
              </Text>
            ) : null}
          </Box>
        ))
      )}
    </Box>
  );
}

function ReviewTab({ d }: { d: DetailView }) {
  return (
    <Box flexDirection="column">
      <Section title="REVIEWER VERDICT" />
      {!d.review ? (
        <Text dimColor>no review yet — the reviewer audits after merge</Text>
      ) : (
        <>
          <Text color={d.review.approved ? "green" : "red"} bold>
            {d.review.approved ? "✓ approved" : "! rejected — heads the next attempt first"}
          </Text>
          {d.review.findings.map((f, i) => (
            <Text key={i} wrap="wrap" color={d.review!.approved ? "gray" : "yellow"}>
              {"  " + clip(f, 300)}
            </Text>
          ))}
          {d.review.notes ? (
            <Text wrap="wrap" dimColor>
              {"  " + d.review.notes}
            </Text>
          ) : null}
        </>
      )}
      {d.reviewNotes ? (
        <>
          <Section title="PRIOR REJECTION (NEXT ATTEMPT INPUT)" />
          <Text wrap="wrap" color="yellow">
            {d.reviewNotes}
          </Text>
        </>
      ) : null}
    </Box>
  );
}

function PromptTab({ d }: { d: DetailView }) {
  return (
    <Box flexDirection="column">
      <Section title={d.promptName ? `PROMPT · ${d.promptName}` : "PROMPT"} />
      {!d.promptTail ? (
        <Text dimColor>no prompt artifact yet — prompt-N.md lands when the attempt spawns</Text>
      ) : (
        <Text wrap="wrap" dimColor>
          {d.promptTail}
        </Text>
      )}
    </Box>
  );
}

function EventsTab({ d }: { d: DetailView }) {
  return (
    <Box flexDirection="column">
      <Section title="EVENTS" />
      {d.recentEvents.length === 0 && d.history.length === 0 ? (
        <Text dimColor>no events yet</Text>
      ) : (
        <>
          {d.recentEvents.map((e, i) => (
            <Text key={`r${i}`}>{`  ${e}`}</Text>
          ))}
          {d.history.map((e, i) => (
            <Text key={`h${i}`} dimColor>
              {"  " + e}
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}

/** Right pane: attempt inspector for the selected slice (shared). Guttered off the rail; airy single-column detail. */
export function InspectorPane({ view, tab, gutter }: InspectorOpts) {
  const selSlice = view.detail;
  const activeTab = clampTab(tab ?? 0);
  const style = (selSlice && STATUS_STYLE[selSlice.status]) ?? { glyph: "○", label: "?", color: "gray" };
  const border = !selSlice
    ? "gray"
    : selSlice.status === "failed" ? "red" : selSlice.status === "running" || selSlice.status === "verifying" ? "cyan" : "gray";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} flexGrow={1} marginLeft={gutter === false ? 0 : 1} paddingX={1}>
      {selSlice ? (
        <>
          <Text bold color="white">
            {selSlice.title} <Text dimColor>({selSlice.sliceId})</Text>
          </Text>
          <Text>
            <Text color={style.color} bold>{`${style.glyph} ${selSlice.status}`}</Text>
            <Text dimColor> · attempt {selSlice.attempts}</Text>
            {selSlice.reason ? <Text color="red"> · {selSlice.reason}</Text> : null}
          </Text>
          {selSlice.status === "running" || selSlice.status === "verifying" ? (
            <Text dimColor>Worker in progress — live output streams in activity below.</Text>
          ) : null}
          <InspectorTabBar tab={activeTab} />
          {activeTab === 0 ? <OutputTab d={selSlice} /> : null}
          {activeTab === 1 ? <DiffTab d={selSlice} /> : null}
          {activeTab === 2 ? <VerifyTab d={selSlice} /> : null}
          {activeTab === 3 ? <ReviewTab d={selSlice} /> : null}
          {activeTab === 4 ? <PromptTab d={selSlice} /> : null}
          {activeTab === 5 ? <EventsTab d={selSlice} /> : null}
        </>
      ) : (
        <Text color="gray">no artifacts for this slice yet</Text>
      )}
    </Box>
  );
}

/** `?` overlay: the shared keymap (+ live controls in run TUIs). Pure render, no store reads. */
export function HelpOverlay({ controls }: { controls?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" marginTop={1} paddingX={1}>
      <Text bold color="cyan"> keys </Text>
      {HELP_ROWS.map(([k, what]) => (
        <Text key={k}>
          <Text bold color="white">{k.padEnd(11)}</Text>
          <Text dimColor>{what}</Text>
        </Text>
      ))}
      {controls ? (
        <>
          <Text bold color="yellow"> live controls </Text>
          {CONTROL_HELP_ROWS.map(([k, what]) => (
            <Text key={k}>
              <Text bold color="white">{k.padEnd(11)}</Text>
              <Text dimColor>{what}</Text>
            </Text>
          ))}
        </>
      ) : null}
      <Text dimColor>Esc or ? closes · q quits</Text>
    </Box>
  );
}

export interface ForensicsProps {
  project: string;
  runId: string;
  detail: DetailView;
  /** Visual-row scroll margin into the worker tail (0 = live tail). */
  scrollUp: number;
  height: number;
  width: number;
  yanked: string | null;
}

export interface ForensicsLayout {
  /** Content width after pane chrome (matches the pager's clip). */
  cw: number;
  /** Visible body rows after the header/footer chrome. */
  bodyH: number;
  maxScroll: number;
  /** Clamped scroll margin actually applied. */
  offset: number;
  shown: string[];
}

/**
 * Fullscreen pager window over worker-tail lines: clip to the content width,
 * clamp the scroll margin, slice the visible tail window. Pure — ForensicsPane
 * renders exactly this, so the structural tests pin the math, not pixels.
 */
export function forensicsLayout(tailLines: string[], height: number, width: number, scrollUp: number): ForensicsLayout {
  const cw = Math.max(20, width - 6);
  const visual = tailLines.map((line) => (line.length > cw ? line.slice(0, cw) : line));
  const bodyH = Math.max(4, height - 12);
  const maxScroll = Math.max(0, visual.length - bodyH);
  const offset = Math.max(0, Math.min(scrollUp, maxScroll));
  const end = visual.length - offset;
  return { cw, bodyH, maxScroll, offset, shown: visual.slice(Math.max(0, end - bodyH), end) };
}

/**
 * Fullscreen slice forensics: worker tail pager + verdict/review/prompt
 * pointers + copyable artifact paths. Scroll with ↑/↓ PgUp/PgDn, `y` yanks
 * the slice dir to `.omp/last-slice-path`, Esc/Enter closes. Pure render
 * over the already-loaded detail — no extra store reads per keypress.
 */
export function ForensicsPane({ project, runId, detail: d, scrollUp, height, width, yanked }: ForensicsProps) {
  const { dir, branch } = forensicsPaths(project, runId, d.sliceId);
  const tailLines = (d.workerTail ?? "").split("\n").filter((l) => l.trim());
  const { offset, shown } = forensicsLayout(tailLines, height, width, scrollUp);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="white">
        forensics · {d.title} <Text dimColor>({d.sliceId})</Text>
      </Text>
      <Text dimColor>
        dir: {dir} · branch: {branch}
      </Text>
      <Text dimColor>
        {d.workerLogName ? `log: ${d.workerLogName}` : "log: —"}
        {d.promptName ? ` · prompt: ${d.promptName}` : ""}
        {d.verdictSteps ? ` · gates: ${d.verdictSteps.filter((s) => s.exit === 0).length}/${d.verdictSteps.length} pass` : ""}
        {d.review ? (d.review.approved ? " · review: approved" : " · review: rejected") : ""}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {shown.length === 0 ? <Text dimColor>(no worker output yet)</Text> : shown.map((row, i) => <Text key={`${offset}-${i}`}>{row}</Text>)}
      </Box>
      {yanked ? <Text color="green">yanked → .omp/last-slice-path: {yanked}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>
          <Text bold color="white">↑/↓ PgUp/PgDn</Text> scroll {offset > 0 ? <Text color="yellow">▲{offset}</Text> : <Text color="green">● live</Text>} │{" "}
          <Text bold color="white">y</Text> yank path │ <Text bold color="white">Esc/Enter</Text> close · open after quit: $EDITOR {dir}/{d.workerLogName ?? "worker-1.log"}
        </Text>
      </Box>
    </Box>
  );
}

function WatchApp({ project, initialRun, onExit }: { project: string; initialRun?: string; onExit: () => void }) {
  const runs0 = listRuns(project);
  const startIdx = initialRun ? Math.max(runs0.indexOf(initialRun), 0) : runs0.length - 1;
  const [view, setView] = useState<RunView | null>(() => {
    const v = loadView(project, startIdx, 0);
    if (!v) return v;
    const sel = preferredSel(v.slices);
    return sel === 0 ? v : loadView(project, startIdx, sel);
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [tab, setTab] = useState(0);
  const [boardMode, setBoardMode] = useState<"list" | "dag">("list");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [forensicScroll, setForensicScroll] = useState(0);
  const [yanked, setYanked] = useState<string | null>(null);
  const failedRef = useRef<string[]>([]);

  useEffect(() => {
    const t = setInterval(() => {
      const v = viewRef.current;
      setView(loadView(project, v?.runIdx ?? 0, v?.sel ?? 0));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [project]);

  // Bell when a new failure lands (poll discovery, not on every render).
  useEffect(() => {
    if (!view || view.slices.length === 0) return;
    const cur = view.slices.filter((s) => isFailureStatus(s.status)).map((s) => s.id);
    const fresh = newFailures(failedRef.current, cur);
    failedRef.current = cur;
    if (fresh.length > 0 && !fullscreen) bell();
  }, [view, fullscreen]);

  useInput((input, key) => {
    const v = viewRef.current;
    if (!v) return;
    const { sel } = v;
    let { runIdx } = v;
    if (input === "q") {
      onExit();
      return;
    }
    if (key.escape) {
      if (fullscreen) setFullscreen(false);
      else if (showHelp) setShowHelp(false);
      return;
    }
    if (input === "?") {
      setShowHelp((h) => !h);
      return;
    }
    if (showHelp) return;
    if (key.return) {
      if (v.detail) {
        setFullscreen((f) => !f);
        setForensicScroll(0);
        setYanked(null);
      }
      return;
    }
    if (fullscreen) {
      const page = 10;
      if (key.pageUp) {
        setForensicScroll((u) => u + page);
        return;
      }
      if (key.pageDown) {
        setForensicScroll((u) => Math.max(0, u - page));
        return;
      }
      if (key.upArrow) {
        setForensicScroll((u) => u + 1);
        return;
      }
      if (key.downArrow) {
        setForensicScroll((u) => Math.max(0, u - 1));
        return;
      }
      if (input === "y" && v.detail) {
        setYanked(yankSlicePath(project, v.runId, v.detail.sliceId));
        return;
      }
      return;
    }
    if (input === "r") {
      setView(loadView(project, runIdx, sel));
      return;
    }
    if (input === "g") {
      setBoardMode((m) => (m === "dag" ? "list" : "dag"));
      return;
    }
    if (input === "F") {
      setFailuresOnly((f) => !f);
      return;
    }
    if (input === "n" || input === "p") {
      // Strictly after/before sel, wrapping — repeat presses walk the failure list.
      const target = input === "n" ? nextFailure(v.slices, sel + 1) : prevFailure(v.slices, sel - 1);
      if (target >= 0) {
        bell();
        setView(loadView(project, runIdx, target));
      }
      return;
    }
    if (/^[1-6]$/.test(input)) {
      setTab(clampTab(Number(input) - 1));
      return;
    }
    if (input === "k" || key.upArrow || input === "j" || key.downArrow) {
      const s = moveSel(v.slices, sel, input === "k" || key.upArrow ? -1 : 1, failuresOnly);
      setView(loadView(project, runIdx, s));
      return;
    }
    if (input === "h" || key.leftArrow) runIdx = Math.max(runIdx - 1, 0);
    else if (input === "l" || key.rightArrow) runIdx = Math.min(runIdx + 1, Math.max(v.runs.length - 1, 0));
    else return;
    // Run switch: land on the new run's most interesting slice.
    const next = loadView(project, runIdx, 0);
    if (!next) return;
    const p = preferredSel(next.slices);
    setView(p === 0 ? next : loadView(project, runIdx, p));
    return;
  });

  if (!view) return <Text color="red">cannot read run store for {project}</Text>;
  if (view.runs.length === 0) {
    return <Text>no runs yet — start one with `ompo run`</Text>;
  }

  const summary = summaryText(view);
  const locks = mutexHolders(view.slices);
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const narrow = isNarrow(cols);
  const bw = narrow ? Math.max(24, cols - 2) : boardWidth(cols);

  if (fullscreen && view.detail) {
    return (
      <Box flexDirection="column">
        <ForensicsPane project={project} runId={view.runId} detail={view.detail} scrollUp={forensicScroll} height={rows} width={cols} yanked={yanked} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header: run picker */}
      <Box>
        <Text color="cyan">{view.live ? "●" : "○"}</Text>
        <Text> </Text>
        <Text bold>{view.runId}</Text>
        <Text color="gray"> · {summary}</Text>
        {locks.length > 0 ? <Text color="yellow"> · 🔒 {locks.join(",")}</Text> : null}
        <Text color="gray"> · runs {view.runIdx + 1}/{view.runs.length} (◀ ▶)</Text>
      </Box>
      <Box>
        <Text color="gray">updated {hhmmss(view.updatedAt)} · created {view.createdAt.slice(0, 10)}</Text>
      </Box>

      {/* Two panes (stacked when narrow) */}
      {narrow ? (
        <Box flexDirection="column">
          <BoardPane view={view} width={bw} mode={boardMode} failuresOnly={failuresOnly} />
          <Box marginTop={1}>
            <InspectorPane view={view} tab={tab} gutter={false} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row">
          <BoardPane view={view} width={bw} mode={boardMode} failuresOnly={failuresOnly} />
          <InspectorPane view={view} tab={tab} />
        </Box>
      )}
      {showHelp ? <HelpOverlay /> : null}

      {/* Footer: compact keyboard command bar */}
      <Box marginTop={1}>
        <Text dimColor>
          <Text bold color="white">↑/↓</Text> select │ <Text bold color="white">n/p</Text> failure │ <Text bold color="white">F</Text> filter │{" "}
          <Text bold color="white">g</Text> dag │ <Text bold color="white">1-6</Text> tabs │ <Text bold color="white">Enter</Text> forensics │{" "}
          <Text bold color="white">?</Text> help │ <Text bold color="white">q</Text> quit <Text dimColor>· polls {POLL_MS / 1000}s</Text>
        </Text>
      </Box>
    </Box>
  );
}

export interface WatchOptions {
  project: string;
  run?: string;
}

/** Read-only live TUI. Never writes to the store. */
export async function cmdWatch(o: WatchOptions): Promise<number> {
  if (o.run) {
    const runs = listRuns(o.project);
    if (!runs.includes(o.run)) {
      console.error(`unknown run "${o.run}" — use ompo list`);
      return 1;
    }
  }
  // Ink needs a real terminal; under a pipe it would dump a raw-mode stack
  // trace. Point the user at the pipe-safe sibling instead.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("ompo watch needs an interactive terminal (raw-mode TUI).");
    console.error("For pipes/SSH/CI use:  ompo log [--run ID] [--follow]");
    return 0;
  }
  const { render } = await import("ink");
  const instance = render(
    <WatchApp
      project={o.project}
      initialRun={o.run}
      onExit={() => {
        try {
          instance.unmount();
        } catch {
          /* already unmounted */
        }
        setTimeout(() => process.exit(0), 20);
      }}
    />,
  );
  await instance.waitUntilExit().catch(() => {});
  return 0;
}
