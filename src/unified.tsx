/**
 * ompo unified TUI — bare `ompo` in a project directory.
 *
 * One frame, three phases: plan (survey docs + planner worker, only when the
 * roadmap is missing or still the blank template) → run (the roadmap loop,
 * resuming the latest unfinished run when the roadmap is untouched) → done.
 * Left shows the slice board with live agent states underneath; right shows
 * major step logs for the selected slice (the watch inspector); bottom shows
 * the scrollable live log. Same 900ms store poll, same capped log bus, same
 * run store as `ompo run` — no extra RAM/disk beyond the existing TUI.
 */

import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROADMAP_TEMPLATE,
  ensureProjectConfig,
  resolveInitPlan,
  runInitPlanner,
} from "./import.ts";
import { parseRoadmap, sha256Hex } from "./parse.ts";
import {
  acquireLock,
  createRun,
  generateRunId,
  listRuns,
  loadRun,
  releaseLock,
  storeApi,
} from "./store.ts";
import { crashedInFlight } from "./types.ts";
import { runRoadmapLoop, type LoopOptions, type LoopResult } from "./loop.ts";
import { createTmuxRunner } from "./tmux.ts";
import { createLogBus, logLineColor, logWindow, type LogBus } from "./run.tsx";
import {
  BoardPane,
  InspectorPane,
  hhmmss,
  preferredSel,
  summaryText,
  viewForRun,
  type RunView,
} from "./watch.tsx";

const POLL_MS = 900;

export interface UnifiedOptions {
  projectDir: string;
  roadmapPath?: string;
  runId?: string;
  model?: string;
  timeoutSec?: number;
  maxRetries?: number;
  jobs?: number;
  template?: boolean;
  replan?: boolean;
  noReview?: boolean;
  reviewModel?: string;
  noDebug?: boolean;
  noPlaceholders?: boolean;
  tmux?: boolean;
  /** Test seams (default: the real planner + loop). */
  planner?: typeof runInitPlanner;
  looper?: (opts: LoopOptions) => Promise<LoopResult>;
}

export interface UnifiedSession {
  phase: "planning" | "ready" | "running" | "done";
  runId: string | null;
  note: string;
}

export interface AgentState {
  id: string;
  last: string;
}

/**
 * Live agent states derived from recent `[id] …` worker progress lines —
 * no extra plumbing, computed at render time from the capped log bus.
 * Pure — unit-tested.
 */
export function agentStates(lines: string[]): AgentState[] {
  const seen = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/^\[([^\]\s]+)\]\s*(.*)$/);
    if (m) seen.set(m[1]!, (m[2] ?? "").trim());
  }
  return [...seen.entries()].map(([id, last]) => ({ id, last })).slice(-8);
}

function abortedResult(): LoopResult {
  return { exitCode: 2, done: 0, failed: 0, skipped: 0, pending: 0, blockedEnv: 0 };
}

/**
 * The three phases as plain async flow over a log sink (public for tests).
 * The TUI passes bus.push; headless mode passes console.log.
 */
export async function driveUnifiedFlow(
  o: UnifiedOptions,
  log: (m: string) => void,
  session: UnifiedSession,
  signal: AbortSignal,
): Promise<LoopResult> {
  const planner = o.planner ?? runInitPlanner;
  const looper = o.looper ?? runRoadmapLoop;
  const roadmapPath = o.roadmapPath ?? join(o.projectDir, "ROADMAP.md");
  ensureProjectConfig(o.projectDir, log);

  // Phase 1: roadmap (plan only when missing/pristine, unless forced).
  session.phase = "planning";
  const existing = existsSync(roadmapPath) ? readFileSync(roadmapPath, "utf8") : null;
  let touched = false;
  switch (
    resolveInitPlan({ existing, template: o.template, replan: o.replan, blankTemplate: ROADMAP_TEMPLATE })
  ) {
    case "keep":
      log(`kept existing ${roadmapPath}`);
      break;
    case "template":
      writeFileSync(roadmapPath, ROADMAP_TEMPLATE, "utf8");
      log(`wrote ${roadmapPath} (blank template)`);
      touched = true;
      break;
    case "plan": {
      if (existing !== null) log(`existing ${roadmapPath} is the untouched blank template — planning from project docs…`);
      try {
        await planner({
          projectDir: o.projectDir,
          roadmapPath,
          workerModel: o.model,
          timeoutMs: o.timeoutSec ? o.timeoutSec * 1000 : undefined,
          signal,
          onEvent: log,
          onProgress: log,
        });
        touched = true;
      } catch (err) {
        if (signal.aborted) return abortedResult();
        log(`planner failed (${String((err as Error).message).slice(0, 300)}); falling back to blank template`);
        writeFileSync(roadmapPath, ROADMAP_TEMPLATE, "utf8");
        touched = true;
      }
      break;
    }
  }
  if (signal.aborted) {
    session.phase = "done";
    session.note = "aborted during planning";
    return abortedResult();
  }
  const markdown = readFileSync(roadmapPath, "utf8");
  const validated = parseRoadmap(markdown);
  log(`roadmap OK: ${validated.slices.length} slices (${validated.slices.map((s) => s.id).join(", ")})`);

  // Phase 2: resume the latest unfinished run, else start fresh. A roadmap
  // written this session never resumes (stale base); a hash mismatch after
  // out-of-band edits also starts fresh instead of refusing.
  session.phase = "ready";
  const runs = listRuns(o.projectDir);
  let runId = o.runId;
  if (!runId && !touched && runs.length > 0) {
    const latest = runs[runs.length - 1]!;
    const cur = loadRun(o.projectDir, latest);
    const drifted = cur.doc.sourceHash !== sha256Hex(markdown);
    const open = cur.doc.slices.some(
      (s) => s.status === "pending" || s.status === "blocked-env" || crashedInFlight(s.status),
    );
    if (open && !drifted) {
      runId = latest;
      storeApi.resumeRun(o.projectDir, runId);
      log(`resumed run ${runId}`);
    } else if (open) {
      log(`latest run ${latest} predates roadmap edits — starting fresh`);
    }
  }
  if (!runId) {
    runId = o.runId ?? generateRunId();
    const doc = parseRoadmap(markdown);
    if (o.maxRetries !== undefined) for (const s of doc.slices) s.maxRetries = o.maxRetries;
    createRun(o.projectDir, doc, runId);
    log(`created run ${runId} (${doc.slices.length} slices)`);
  }
  session.runId = runId;

  // Phase 3: the roadmap loop.
  session.phase = "running";
  acquireLock(o.projectDir, runId);
  try {
    const res = await looper({
      projectDir: o.projectDir,
      runId,
      maxRetriesOverride: o.maxRetries,
      timeoutMsOverride: o.timeoutSec ? o.timeoutSec * 1000 : undefined,
      jobs: o.jobs,
      runner: o.tmux ? createTmuxRunner() : undefined,
      noReview: o.noReview,
      reviewModel: o.reviewModel,
      noDebug: o.noDebug,
      noPlaceholders: o.noPlaceholders,
      signal,
      onEvent: log,
    });
    session.phase = "done";
    session.note = `done=${res.done} failed=${res.failed} blocked-env=${res.blockedEnv}`;
    return res;
  } finally {
    releaseLock(o.projectDir, runId);
  }
}

// ── UI ─────────────────────────────────────────────────────────────────
interface UnifiedAppProps {
  project: string;
  session: UnifiedSession;
  bus: LogBus;
  requestAbort: () => void;
}

function AgentsPane({ lines }: { lines: string[] }): React.JSX.Element {
  const agents = agentStates(lines);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" marginTop={1}>
      <Text bold color="gray"> agents </Text>
      {agents.length === 0 ? (
        <Text color="gray">(idle — no agent output yet)</Text>
      ) : (
        agents.map((a) => (
          <Text key={a.id} color="cyan">
            [{a.id}] <Text color="gray">{a.last.slice(0, 52)}</Text>
          </Text>
        ))
      )}
    </Box>
  );
}

export function UnifiedApp({ project, session, bus, requestAbort }: UnifiedAppProps): React.JSX.Element {
  const [view, setView] = useState<RunView | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Log-panel scroll margin in visual rows (0 = stuck to the live tail).
  const [scrollUp, setScrollUp] = useState(0);

  // Log pushes re-render immediately; board/inspector re-read on the poll.
  useEffect(() => bus.subscribe(bump), [bus]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!session.runId) return;
      const v = viewRef.current;
      if (v && v.runId === session.runId) {
        const next = viewForRun(project, session.runId, v.sel);
        if (next) setView(next);
        return;
      }
      const first = viewForRun(project, session.runId, 0);
      if (!first) return;
      const sel = preferredSel(first.slices);
      setView(sel === 0 ? first : viewForRun(project, session.runId, sel));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [project, session]);

  useInput((input, key) => {
    if (input === "q") {
      requestAbort();
      return;
    }
    if (input === "c" && key.ctrl) {
      requestAbort();
      return;
    }
    if (input === "r" && session.runId) {
      setView(viewForRun(project, session.runId, viewRef.current?.sel ?? 0));
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
    const v = viewRef.current;
    if (!v || !session.runId) return;
    if (input === "k" || key.upArrow || input === "j" || key.downArrow) {
      const s = input === "k" || key.upArrow ? Math.max(v.sel - 1, 0) : Math.min(v.sel + 1, Math.max(v.slices.length - 1, 0));
      setView(viewForRun(project, session.runId, s));
    }
  });

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  // Header (2) + panes + footer (1) leave the rest for the activity pane,
  // clamped so it stays usable on short terminals.
  const logRows = Math.max(4, Math.min(12, rows - 16));
  // One row is the pane's title; the windowed text rows fit the remainder.
  const win = logWindow(bus.lines, logRows - 1, cols, scrollUp);

  const phaseLabel = session.phase === "planning"
    ? "planning — surveying project docs…"
    : session.phase === "ready"
      ? "ready — starting run…"
      : session.phase === "running"
        ? "running"
        : `done ${session.note}`;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">●</Text>
        <Text> </Text>
        <Text bold>ompo</Text>
        <Text color="gray"> · {phaseLabel}</Text>
        {view ? <Text color="gray"> · {view.runId} · {summaryText(view)}</Text> : null}
      </Box>
      <Box>
        {view
          ? <Text color="gray">updated {hhmmss(view.updatedAt)} · created {view.createdAt.slice(0, 10)}</Text>
          : <Text color="gray">no run yet — roadmap first</Text>}
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" width={64}>
          {view ? <BoardPane view={view} /> : (
            <Box flexDirection="column" borderStyle="round" borderColor="gray">
              <Text bold color="gray"> slices </Text>
              <Text color="gray">(roadmap not ready)</Text>
            </Box>
          )}
          <AgentsPane lines={bus.lines} />
        </Box>
        {view ? <InspectorPane project={project} view={view} /> : (
          <Box flexDirection="column" borderStyle="round" borderColor="gray" flexGrow={1}>
            <Text color="gray">major step logs appear here once the run starts</Text>
          </Box>
        )}
      </Box>

      {/* Live activity log: fixed height, scrolled from the inside so the
          frame never exceeds the screen height. */}
      <Box flexDirection="column" borderStyle="round" borderColor="gray" marginTop={1} height={logRows + 2}>
        <Text bold color="gray">
          {win.offset > 0 ? ` activity ▲${win.offset} (PgDn for live) ` : " activity · live "}
        </Text>
        {win.shown.length === 0 ? (
          <Text color="gray">(no activity yet — planner/worker lines stream here live)</Text>
        ) : (
          win.shown.map((line, i) => (
            <Text key={`${win.offset}-${i}`} wrap="wrap" color={logLineColor(line)}>
              {line}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">↑/↓ select slice · PgUp/PgDn scroll log · r refresh · q abort (resume by re-running `ompo`)</Text>
      </Box>
    </Box>
  );
}

// ── entry ──────────────────────────────────────────────────────────────
export type UnifiedRunOptions = UnifiedOptions;

/**
 * Bare `ompo`: full plan → run → done flow. Interactive terminal drives it
 * from inside the unified TUI; pipes/CI get the same phases as a headless
 * log stream. Returns the loop result.
 */
export async function runUnified(opts: UnifiedOptions): Promise<LoopResult> {
  // (planner/looper resolve inside driveUnifiedFlow; tests inject fakes.)
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    const ctrl = new AbortController();
    const onSig = (): void => ctrl.abort();
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    try {
      // eslint-disable-next-line no-console
      return await driveUnifiedFlow(opts, (m) => console.log(m), session, ctrl.signal);
    } finally {
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
    }
  }
  // Lazy ink load: `--help`/headless paths never pay for react (cli.ts convention).
  const { render } = await import("ink");
  const bus = createLogBus();
  const ctrl = new AbortController();
  const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
  const instance = render(
    <UnifiedApp
      project={opts.projectDir}
      session={session}
      bus={bus}
      requestAbort={() => {
        bus.push("abort requested — finishing the in-flight store write, then exiting (re-run `ompo` to resume)");
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
    const result = await driveUnifiedFlow(opts, (m) => bus.push(m), session, ctrl.signal);
    instance.unmount();
    await instance.waitUntilExit().catch(() => {});
    if (result.exitCode === 2) {
      console.log(`\naborted — re-run \`ompo\` to resume`);
    } else {
      console.log(
        `\nrun finished: done=${result.done} failed=${result.failed} blocked-env=${result.blockedEnv} skipped=${result.skipped} pending=${result.pending}`,
      );
    }
    return result;
  } catch (err) {
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
