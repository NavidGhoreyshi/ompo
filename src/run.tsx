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
  BoardPane,
  hhmmss,
  InspectorPane,
  preferredSel,
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
  // Header (2) + panes (~11) + footer (1) leave the rest for the activity
  // pane, clamped so it stays usable on short terminals.
  const logRows = Math.max(4, Math.min(12, rows - 16));
  // One row is the pane's title; the windowed text rows fit the remainder.
  const win = logWindow(bus.lines, logRows - 1, cols, scrollUp);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">●</Text>
        <Text> </Text>
        <Text bold>{view.runId}</Text>
        <Text color="gray"> · {summaryText(view)}</Text>
      </Box>
      <Box>
        <Text color="gray">updated {hhmmss(view.updatedAt)} · created {view.createdAt.slice(0, 10)}</Text>
      </Box>

      {/* Slice board + attempt inspector (same panes as ompo watch) */}
      <Box flexDirection="row">
        <BoardPane view={view} />
        <InspectorPane project={project} view={view} />
      </Box>

      {/* Live activity log: fixed height, scrolled from the inside (PgUp/PgDn
          or Shift+↑/↓) so the frame never exceeds the screen height. */}
      <Box flexDirection="column" borderStyle="round" borderColor="gray" marginTop={1} height={logRows + 2}>
        <Text bold color="gray">
          {win.offset > 0 ? ` activity ▲${win.offset} (PgDn for live) ` : " activity · live "}
        </Text>
        {win.shown.length === 0 ? (
          <Text color="gray">(no activity yet — worker lines stream here live)</Text>
        ) : (
          win.shown.map((line, i) => (
            <Text key={`${win.offset}-${i}`} wrap="wrap" color={logLineColor(line)}>
              {line}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">↑/↓ select slice · PgUp/PgDn scroll log · r refresh · q or Ctrl-C abort run (finish store write, exit 2)</Text>
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
