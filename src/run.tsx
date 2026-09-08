/**
 * ompo run — live TUI (the watch board fused with the orchestrator loop).
 *
 * In an interactive terminal `ompo run` no longer prints its 1-line progress
 * log over stdout: it renders the same board + attempt inspector `ompo watch`
 * shows, and routes the loop's `onEvent` lines into a scrolling activity pane
 * at the bottom of the frame (newlines split into rows, ANSI stripped, colored
 * by outcome) so nothing interleaves with the redraw. The board/inspector
 * poll the store the loop writes (watch's `viewForRun`), the log pane is fed
 * directly by the loop — no polling, no tailing files.
 *
 * The loop runs *inside* this process, so the TUI is not read-only: `q` or
 * Ctrl-C aborts the run through the loop's AbortController (same semantics as
 * the headless Ctrl-C path — in-flight store write finishes, slices mark
 * `aborted`, exit 2), and SIGINT/SIGTERM do the same with a notice line in
 * the activity pane. When the loop ends the TUI unmounts and the outcome line
 * (matching the headless scrollback) is printed so the terminal isn't left
 * blank. Piped/non-TTY stdout keeps the plain headless log stream (see
 * cli.ts), because a raw-mode ink frame needs a real terminal.
 */

import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { runRoadmapLoop, type LoopOptions, type LoopResult } from "./loop.ts";
import {
  AgentsPane,
  agentStates,
  boardWidth,
  BoardPane,
  clip,
  hhmmss,
  InspectorPane,
  preferredSel,
  spinnerFrame,
  summaryText,
  viewForRun,
  type RunView,
} from "./watch.tsx";

const POLL_MS = 900;
const MAX_LOG_LINES = 600;

// ── activity log plumbing ──────────────────────────────────────────────
/** Mutable log sink shared by the loop (writer) and the TUI (reader). */
export interface LogBus {
  /** One string per display row (already split on newlines, ANSI stripped). */
  lines: string[];
  /** Append a message; newlines become separate rows. Notifies the TUI. */
  push(msg: string): void;
  /** Subscribe to pushes (the TUI force-rerenders on each). Returns unsubscribe. */
  subscribe(fn: () => void): () => void;
}

export function createLogBus(maxLines = MAX_LOG_LINES): LogBus {
  const lines: string[] = [];
  let sub: (() => void) | null = null;
  const push = (msg: string): void => {
    for (const raw of msg.split("\n")) {
      const line = raw.replace(/\r/g, "").replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
      if (!line.trim()) continue;
      lines.push(line);
    }
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    sub?.();
  };
  return {
    lines,
    push,
    subscribe(fn) {
      sub = fn;
      return () => {
        if (sub === fn) sub = null;
      };
    },
  };
}

/** Best-effort ANSI strip (color codes only; guard for pre-existing content). */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Pick an ink color for a log line so failures pop in the live stream. */
export function logLineColor(line: string): string | undefined {
  if (/verify ok|review approved|run finished|done=/.test(line)) return "green";
  if (/FAIL|failed|rejected|terminal|aborted|invalid|error/i.test(line)) return "red";
  if (/blocked|environment blocked|fix:/.test(line)) return "magenta";
  if (/^…|^  /.test(line)) return "gray"; // heartbeat / continuation rows
  if (/retrying|still running|worker exited|timed ?out|timeout/.test(line)) return "yellow";
  if (/^\[[^\]]+\]/.test(line)) return "cyan"; // worker progress: [id] turn/tool…
  return undefined;
}
/** Middle-truncate a long command: keep head + tail, total ≤ n chars. Pure. */
export function truncateMiddle(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= n || n <= 2) return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "…";
  const tail = Math.floor((n - 1) * 0.35);
  const head = n - 1 - tail;
  return `${t.slice(0, head)}…${t.slice(t.length - tail)}`;
}

const ACT_PREFIX_RE = /^\s*\[([^\]\s]+)(?:\s+([^\]]+))?\]\s*(.*)$/;

/**
 * Structured single-line summary for a raw bus row (TIME→EVENT→SOURCE has no
 * timestamps in the bus stream, so rows lead with the event kind instead):
 * `[id] tool bash: <cmd>` → `$ bash <cmd…>`, `[id] turn 12…` → `· id turn 12`.
 * Long commands middle-truncate to the pane width; everything else truncates
 * at the end. Full text stays in the slice worker logs + `ompo log`. Pure.
 */
export function formatActivityLine(line: string, width: number): string {
  const cw = Math.max(20, width - 6);
  const m = line.match(ACT_PREFIX_RE);
  if (m) {
    const id = m[1]!;
    const tag = m[2] ? ` ${m[2]}` : "";
    const rest = (m[3] ?? "").trim();
    const tool = rest.match(/^tool\s+([^:]+):\s*(.*)$/);
    if (tool) {
      const kind = tool[1]!.trim();
      const tagPart = tag ? ` [${tag.trim()}]` : "";
      const cmd = truncateMiddle(tool[2] ?? "", Math.max(10, cw - kind.length - tagPart.length - 4));
      return cmd ? `$ ${kind}${tagPart} ${cmd}` : `$ ${kind}${tagPart}`;
    }
    const turn = rest.match(/^turn\s+(.*)$/);
    if (turn) return clip(`· ${id}${tag} turn ${turn[1]!.trim()}`, cw);
    const says = rest.match(/^says:\s*(.*)$/);
    if (says) return clip(`» ${id}${tag} ${says[1]!.trim()}`, cw);
    return clip(line.trim(), cw);
  }
  return clip(line.trim(), cw);
}

/** Color for a *formatted* activity row (logLineColor still owns raw lines). */
export function activityColor(row: string): string | undefined {
  if (/^· /.test(row)) return "gray";
  return logLineColor(row);
}

/**
 * Activity pane text rows for a terminal height: fixed (never shrunk to
 * fit idle content — that would jitter the frame as lines stream) but
 * capped low so the inspector keeps the larger share. Pure.
 */
export function activityRows(totalRows: number): number {
  return Math.max(3, Math.min(9, totalRows - 18));
}

/**
 * Scannable live activity: bus rows are summarized to single lines
 * (formatActivityLine) before windowing, so the wrap math is exact and long
 * commands never dominate the pane. Shared by run + unified TUIs.
 */
export function ActivityPane({ lines, cols, logRows, scrollUp, emptyHint }: {
  lines: string[];
  cols: number;
  logRows: number;
  scrollUp: number;
  emptyHint: string;
}) {
  const texts = lines.map((l) => formatActivityLine(l, cols));
  const win = logWindow(texts, logRows - 1, cols, scrollUp);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" marginTop={1} height={logRows + 2}>
      <Text>
        <Text bold color="white"> activity </Text>
        {win.offset > 0
          ? <Text color="yellow">▲{win.offset} · PgDn for live</Text>
          : <Text color="green">● live</Text>}
      </Text>
      {win.shown.length === 0 ? (
        <Text dimColor>{emptyHint}</Text>
      ) : (
        win.shown.map((row, i) => (
          <Text
            key={`${win.offset}-${i}`}
            bold={row.startsWith("$ ")}
            color={row.startsWith("$ ") ? undefined : row.startsWith("» ") ? "cyan" : activityColor(row)}
          >
            {row}
          </Text>
        ))
      )}
    </Box>
  );
}

/**
 * Newest log rows whose wrapped display height fits `height` rows at `width`
 * columns (conservative char-per-cell estimate so the pane never overflows
 * the terminal). Oldest overflow is dropped — the pane is a live tail.
 */
export function fitLogTail(lines: string[], height: number, width: number): string[] {
  const cw = Math.max(1, width - 6); // borders + slack
  const out: string[] = [];
  let rows = 0;
  for (let i = lines.length - 1; i >= 0 && rows < height; i--) {
    const t = stripAnsi(lines[i]!);
    if (!t.trim()) continue;
    const wraps = Math.max(1, Math.ceil(t.length / cw));
    if (rows + wraps > height) break;
    out.unshift(t);
    rows += wraps;
  }
  return out;
}

/** Split one logical line into visual rows at the pane width (same estimate as fitLogTail). */
export function wrapLogLine(line: string, width: number): string[] {
  const cw = Math.max(1, width - 6);
  const t = stripAnsi(line);
  if (!t.trim()) return [];
  const out: string[] = [];
  for (let i = 0; i < t.length; i += cw) out.push(t.slice(i, i + cw));
  return out;
}

export interface LogWindow {
  /** Visual rows to render (exactly ≤ height). */
  shown: string[];
  /** Total visual rows in the buffer. */
  totalRows: number;
  /** Largest meaningful scrollUp. */
  maxScroll: number;
  /** Clamped scrollUp actually applied. */
  offset: number;
}

/**
 * Bottom-anchored window with scroll margin: scrollUp=0 shows the live tail;
 * scrollUp=N lifts the window N visual rows into history. The pane keeps a
 * fixed height, so scrolled content never pushes the frame past the screen.
 * Pure — unit-tested.
 */
export function logWindow(lines: string[], height: number, width: number, scrollUp: number): LogWindow {
  const visual: string[] = [];
  for (const line of lines) visual.push(...wrapLogLine(line, width));
  const totalRows = visual.length;
  const maxScroll = Math.max(0, totalRows - height);
  const offset = Math.max(0, Math.min(scrollUp, maxScroll));
  const end = totalRows - offset;
  const shown = visual.slice(Math.max(0, end - height), end);
  return { shown, totalRows, maxScroll, offset };
}

// ── UI ─────────────────────────────────────────────────────────────────
interface LiveRunAppProps {
  project: string;
  runId: string;
  bus: LogBus;
  /** User asked to quit (q / Ctrl-C): abort the loop, mirroring SIGINT. */
  requestAbort: () => void;
}

export function LiveRunApp({ project, runId, bus, requestAbort }: LiveRunAppProps) {
  const [view, setView] = useState<RunView | null>(() => {
    const v = viewForRun(project, runId, 0);
    if (!v) return v;
    const sel = preferredSel(v.slices);
    return sel === 0 ? v : viewForRun(project, runId, sel);
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Log-panel scroll margin in visual rows (0 = stuck to the live tail).
  const [scrollUp, setScrollUp] = useState(0);

  // Log pushes re-render immediately; board/inspector re-read on the poll.
  useEffect(() => bus.subscribe(bump), [bus]);

  useEffect(() => {
    const t = setInterval(() => {
      const v = viewRef.current;
      if (!v) return;
      const next = viewForRun(project, runId, v.sel);
      if (next) setView(next);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [project, runId]);

  useInput((input, key) => {
    const v = viewRef.current;
    if (!v) return;
    if (input === "q") {
      requestAbort();
      return;
    }
    if (input === "c" && key.ctrl) {
      requestAbort();
      return;
    }
    if (input === "r") {
      setView(viewForRun(project, runId, v.sel));
      return;
    }
    const page = 10;
    if (key.pageUp) {
      setScrollUp((u) => u + page);
      return;
    }
    if (key.pageDown) {
      setScrollUp((u) => Math.max(0, u - page));
      return;
    }
    if (key.shift && key.upArrow) {
      setScrollUp((u) => u + 3);
      return;
    }
    if (key.shift && key.downArrow) {
      setScrollUp((u) => Math.max(0, u - 3));
      return;
    }
    if (input === "k" || key.upArrow || input === "j" || key.downArrow) {
      const s = input === "k" || key.upArrow ? Math.max(v.sel - 1, 0) : Math.min(v.sel + 1, Math.max(v.slices.length - 1, 0));
      setView(viewForRun(project, runId, s));
    }
  });

  if (!view) return <Text color="red">cannot read run store for {project}</Text>;

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  // Header (2) + panes + footer (1) leave the rest for the activity pane.
  const logRows = activityRows(rows);
  const bw = boardWidth(cols);
  const statusOf = (id: string) => view.slices.find((s) => s.id === id);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={view.live ? "cyan" : "gray"}>{spinnerFrame(Date.now(), view.live)}</Text>
        <Text> </Text>
        <Text bold color="white">ompo</Text>
        {view.live
          ? <Text bold color="green"> · RUNNING</Text>
          : <Text dimColor> · IDLE</Text>}
        <Text dimColor> · {summaryText(view)}</Text>
      </Box>
      <Box>
        <Text dimColor>run {view.runId} · updated {hhmmss(view.updatedAt)}</Text>
      </Box>

      {/* Slice board + agents | attempt inspector (1-col gutter via inspector margin) */}
      <Box flexDirection="row">
        <Box flexDirection="column" width={bw} flexShrink={0}>
          <BoardPane view={view} width={bw} />
          <AgentsPane agents={agentStates(bus.lines)} statusOf={statusOf} width={bw} />
        </Box>
        <InspectorPane view={view} />
      </Box>

      <ActivityPane
        lines={bus.lines}
        cols={cols}
        logRows={logRows}
        scrollUp={scrollUp}
        emptyHint="(no activity yet — worker lines stream here live)"
      />

      <Box marginTop={1}>
        <Text dimColor>
          <Text bold color="white">↑/↓</Text> select │ <Text bold color="white">PgUp/PgDn</Text> scroll │{" "}
          <Text bold color="white">r</Text> refresh │ <Text bold color="yellow">q</Text> abort <Text dimColor>· finishes store write, exit 2</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ── entry ──────────────────────────────────────────────────────────────
export type RunTuiLoopOptions = Omit<LoopOptions, "onEvent" | "signal">;

/** Outcome line in the scrollback, matching what headless mode would print. */
function printOutcome(runId: string, result: LoopResult): void {
  if (result.exitCode === 2) {
    console.log(`\nrun ${runId} aborted — in-flight slices marked aborted; resume later with \`ompo resume\``);
    return;
  }
  console.log(
    `\nrun finished: done=${result.done} failed=${result.failed} blocked-env=${result.blockedEnv} skipped=${result.skipped} pending=${result.pending}`,
  );
}

/**
 * Drive one roadmap loop from inside the watch-style TUI. The loop's
 * `onEvent` lines are pushed into the bottom activity pane (never printed
 * over the frame). The run lock stays owned by the caller; SIGINT/SIGTERM
 * and the TUI's quit keys abort through the loop's own controller. Returns
 * the loop result once the run is over and the frame has been torn down.
 */
export async function runRoadmapLoopTui(opts: RunTuiLoopOptions): Promise<LoopResult> {
  const { render } = await import("ink");
  const bus = createLogBus();
  const ctrl = new AbortController();
  const instance = render(
    <LiveRunApp
      project={opts.projectDir}
      runId={opts.runId}
      bus={bus}
      requestAbort={() => {
        bus.push("abort requested — finishing the in-flight store write, then exiting (resume with `ompo resume`)");
        ctrl.abort();
      }}
    />,
    { exitOnCtrlC: false },
  );
  const onSignal = (): void => {
    bus.push("received interrupt — finishing in-flight store write, then aborting…");
    ctrl.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const result = await runRoadmapLoop({ ...opts, signal: ctrl.signal, onEvent: (m) => bus.push(m) });
    instance.unmount();
    await instance.waitUntilExit().catch(() => {});
    printOutcome(opts.runId, result);
    return result;
  } catch (err) {
    // Never leave the raw-mode frame up if the loop itself throws.
    try {
      instance.unmount();
    } catch {
      /* already unmounted */
    }
    throw err;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
