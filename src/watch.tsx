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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listRuns, loadRun, lockHeld } from "./store.ts";
import type { RunEvent, Slice, SliceStatus } from "./types.ts";

const POLL_MS = 900;

// ── semantic state (glyph + word + color; never color alone) ──
// Glyphs stay in the same compatibility class as the existing ●○▸▲◀▶✗:
// hollow ○ = idle/waiting, solid ● = active work, ✓/!/– = outcome.
const STATUS_STYLE: Record<string, { glyph: string; label: string; color: string; bold?: boolean }> = {
  pending: { glyph: "○", label: "pend", color: "gray" },
  running: { glyph: "●", label: "run ", color: "cyan" },
  verifying: { glyph: "●", label: "gates", color: "yellow" },
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

/** Operational agent summary: state glyph + slice status + last line. */
export function AgentsPane({ agents, statusOf }: { agents: AgentRow[]; statusOf: (id: string) => SliceLine | undefined }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" marginTop={1}>
      <Text bold color="gray"> agents </Text>
      {agents.length === 0 ? (
        <Text color="gray">(idle — no agent output yet)</Text>
      ) : (
        agents.map((a) => {
          const s = statusOf(a.id);
          const st = (s && STATUS_STYLE[s.status]) ?? { glyph: "○", label: "?", color: "gray" };
          return (
            <Text key={a.id}>
              <Text color={st.color} bold>{st.glyph}</Text> {a.id}
              {a.tag ? <Text color="gray"> · {a.tag}</Text> : null}
              {s ? <Text color={st.color}> {st.label.trim()}</Text> : null} — {clip(a.last || "(started)", 40)}
            </Text>
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
  };
  void files;

  const report = readJson<{ summary?: string; done?: boolean }>(join(dir, "report.json"));
  if (report?.summary) detail.reportSummary = report.summary;

  // Newest attempt's invalid report (worker produced no usable report block).
  const invalid = files
    .filter((f) => /^report-\d+\.invalid\.json$/.test(f))
    .sort()
    .at(-1);
  if (invalid) {
    const rec = readJson<{ error?: string }>(join(dir, invalid));
    if (rec?.error) detail.note = clip(rec.error, 220);
  }

  // Verdict: first failing gate step + its output tail.
  const verdict = readJson<{ pass?: boolean; steps?: { name: string; exit: number | null; timedOut: boolean; outputTail?: string }[] }>(
    join(dir, "verdict.json"),
  );
  const failedStep = verdict?.steps?.find((s) => s.exit !== 0);
  if (failedStep) {
    detail.verdictStep = {
      name: failedStep.name,
      exit: failedStep.exit,
      timedOut: failedStep.timedOut,
      tail: clip((failedStep.outputTail ?? "").trim().slice(-400), 400),
    };
  }

  // A short worker/diagnosis log tail is more useful than nothing.
  const workerLog = files.filter((f) => /^(worker|debug)-\d+\.log$/.test(f)).sort().at(-1);
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

// ── UI ─────────────────────────────────────────────────────────────────
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

function SliceChip({ slice, maxName, selected }: { slice: SliceLine; maxName: number; selected: boolean }) {
  const c = STATUS_STYLE[slice.status] ?? { glyph: "○", label: slice.status.slice(0, 5), color: "gray" };
  const label = c.label.padEnd(5);
  const name = slice.status === "failed" ? slice.id : `${slice.id}${slice.attempts > 1 ? ` ×${slice.attempts}` : ""}`;
  return (
    <Text bold={selected || c.bold} wrap="truncate">
      <Text color={c.color} bold={selected || c.bold}>{`${c.glyph} [${label}]`}</Text> {clip(name, maxName)}
      {slice.status === "failed" && slice.reason ? <Text color="red"> {clip(slice.reason, maxName)}</Text> : null}
    </Text>
  );
}

/** Adaptive board width: ~30% of columns, clamped so ids survive narrow screens. */
export function boardWidth(cols: number): number {
  return Math.max(24, Math.min(38, Math.floor(cols * 0.3)));
}

/** Left pane: the slice board (shared by watch + live run TUIs). */
export function BoardPane({ view, width }: { view: RunView; width?: number }) {
  const w = width ?? 32;
  const maxName = Math.max(8, w - 16);
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor="gray">
      <Text bold color="gray"> slices </Text>
      {view.slices.map((s, i) => (
        <Box key={s.id}>
          <Box flexShrink={0}>
            <Text color={i === view.sel ? "green" : "gray"}>{i === view.sel ? "▸ " : "  "}</Text>
          </Box>
          <SliceChip slice={s} maxName={maxName} selected={i === view.sel} />
        </Box>
      ))}
    </Box>
  );
}

function Section({ title }: { title: string }) {
  return (
    <Text bold color="gray">
      {" "}{title}{" "}
    </Text>
  );
}

/** Right pane: attempt inspector for the selected slice (shared). */
export function InspectorPane({ view }: { view: RunView }) {
  const selSlice = view.detail;
  const style = (selSlice && STATUS_STYLE[selSlice.status]) ?? { glyph: "○", label: "?", color: "gray" };
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={view.detail && view.detail.status === "failed" ? "red" : "gray"} flexGrow={1}>
      {selSlice ? (
        <>
          <Text bold>
            {selSlice.title} <Text color="gray">({selSlice.sliceId})</Text>
          </Text>
          <Section title="STATUS" />
          <Text>
            <Text color={style.color} bold>{`${style.glyph} ${selSlice.status}`}</Text>
            <Text color="gray"> · attempt {selSlice.attempts}</Text>
            {selSlice.reason ? <Text color="red"> · {selSlice.reason}</Text> : null}
          </Text>
          {selSlice.status === "running" || selSlice.status === "verifying" ? (
            <Text color="gray">Worker in progress — live output streams in activity below.</Text>
          ) : null}
          {selSlice.metrics ? (
            <>
              <Section title="LAST RUN" />
              <Text color="gray">
                {selSlice.metrics.turns} turns · {selSlice.metrics.tools} tools
                {selSlice.metrics.durationMs !== undefined ? ` · ${formatDuration(selSlice.metrics.durationMs)}` : ""}
              </Text>
            </>
          ) : null}
          {selSlice.recentEvents.length > 0 ? (
            <>
              <Section title="LAST EVENT" />
              {selSlice.recentEvents.map((e, i) => (
                <Text key={i} color={i === 0 ? undefined : "gray"}>
                  {"  " + e}
                </Text>
              ))}
            </>
          ) : null}
          <Section title="OUTPUT" />
          {selSlice.reportSummary ? (
            <Text wrap="wrap" color="green">
              summary: {clip(selSlice.reportSummary, 400)}
            </Text>
          ) : null}
          {selSlice.verdictStep ? (
            <Box flexDirection="column">
              <Text color="red">
                ✗ gate {selSlice.verdictStep.name} exit={String(selSlice.verdictStep.exit)} timedOut={String(selSlice.verdictStep.timedOut)}
              </Text>
              <Text wrap="wrap" color="gray">
                {selSlice.verdictStep.tail}
              </Text>
            </Box>
          ) : null}
          {selSlice.note ? (
            <Text wrap="wrap" color="yellow">
              {selSlice.note}
            </Text>
          ) : null}
          {!selSlice.reportSummary && !selSlice.verdictStep && !selSlice.note ? (
            <Text color="gray">
              {selSlice.status === "running" || selSlice.status === "verifying"
                ? "no output yet — waiting for worker output…"
                : selSlice.status === "pending" || selSlice.status === "blocked" || selSlice.status === "blocked-env"
                  ? "no output yet — worker hasn't started"
                  : "no output yet"}
            </Text>
          ) : null}
          {selSlice.history.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Section title="HISTORY" />
              {selSlice.history.map((e, i) => (
                <Text key={i} color="gray">
                  {"  " + e}
                </Text>
              ))}
            </Box>
          ) : null}
        </>
      ) : (
        <Text color="gray">no artifacts for this slice yet</Text>
      )}
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

  useEffect(() => {
    const t = setInterval(() => {
      const v = viewRef.current;
      setView(loadView(project, v?.runIdx ?? 0, v?.sel ?? 0));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [project]);

  useInput((input, key) => {
    const v = viewRef.current;
    if (!v) return;
    const { sel } = v;
    let { runIdx } = v;
    if (input === "q") {
      onExit();
      return;
    }
    if (input === "r") {
      setView(loadView(project, runIdx, sel));
      return;
    }
    if (input === "k" || key.upArrow || input === "j" || key.downArrow) {
      const s = input === "k" || key.upArrow ? Math.max(sel - 1, 0) : Math.min(sel + 1, Math.max(v.slices.length - 1, 0));
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

  return (
    <Box flexDirection="column">
      {/* Header: run picker */}
      <Box>
        <Text color="cyan">{view.live ? "●" : "○"}</Text>
        <Text> </Text>
        <Text bold>{view.runId}</Text>
        <Text color="gray"> · {summary}</Text>
        <Text color="gray"> · runs {view.runIdx + 1}/{view.runs.length} (◀ ▶)</Text>
      </Box>
      <Box>
        <Text color="gray">updated {hhmmss(view.updatedAt)} · created {view.createdAt.slice(0, 10)}</Text>
      </Box>

      {/* Two panes */}
      <Box flexDirection="row">
        <BoardPane view={view} width={boardWidth(process.stdout.columns ?? 80)} />
        <InspectorPane view={view} />
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text color="gray">
          <Text bold color="white">↑/↓</Text> select · <Text bold color="white">◀/▶</Text> run ·{" "}
          <Text bold color="white">r</Text> refresh · <Text bold color="white">q</Text> quit · polls every {POLL_MS / 1000}s
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
