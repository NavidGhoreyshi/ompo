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
import { resumeStalled } from "./select.ts";
import { crashedInFlight } from "./types.ts";
import { runRoadmapLoop, type LoopOptions, type LoopResult } from "./loop.ts";
import { createTmuxRunner } from "./tmux.ts";
import { ActivityPane, activityRows, createLogBus, type LogBus } from "./run.tsx";
import {
  AgentsPane,
  agentStates,
  BoardPane,
  boardWidth,
  hhmmss,
  InspectorPane,
  preferredSel,
  spinnerFrame,
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

export type { AgentRow } from "./watch.tsx";
export { agentStates } from "./watch.tsx";

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
    if (open && !drifted && !resumeStalled(cur.doc.slices)) {
      runId = latest;
      storeApi.resumeRun(o.projectDir, runId);
      log(`resumed run ${runId}`);
    } else if (open && drifted) {
      log(`latest run ${latest} predates roadmap edits — starting fresh`);
    } else if (open) {
      log(`latest run ${latest} is stalled (resume would do no work) — starting fresh`);
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
  // Header (2) + panes + footer (1) leave the rest for the activity pane.
  const logRows = activityRows(rows);
  const phaseLabel = session.phase === "planning"
    ? "planning — surveying project docs…"
    : session.phase === "ready"
      ? "ready — starting run…"
      : session.phase === "running"
        ? view && view.live ? "RUNNING" : "running"
        : `done ${session.note}`;
  const live = session.phase === "planning" || session.phase === "ready" || (session.phase === "running" && (!view || view.live));
  const bw = boardWidth(cols);
  const statusOf = (id: string) => view?.slices.find((s) => s.id === id);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={live ? "cyan" : "gray"}>{spinnerFrame(Date.now(), live)}</Text>
        <Text> </Text>
        <Text bold color="white">ompo</Text>
        <Text color={live ? "cyan" : "gray"} bold={live}> · {phaseLabel}</Text>
        {view ? <Text dimColor> · {summaryText(view)}</Text> : null}
      </Box>
      <Box>
        {view
          ? <Text dimColor>run {view.runId} · updated {hhmmss(view.updatedAt)}</Text>
          : <Text dimColor>no run yet — roadmap first</Text>}
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" width={bw} flexShrink={0}>
          {view ? <BoardPane view={view} width={bw} /> : (
            <Box flexDirection="column" borderStyle="round" borderColor="gray">
              <Text bold color="white"> slices </Text>
              <Text dimColor>(roadmap not ready)</Text>
            </Box>
          )}
          <AgentsPane agents={agentStates(bus.lines)} statusOf={statusOf} width={bw} />
        </Box>
        {view ? <InspectorPane view={view} /> : (
          <Box flexDirection="column" borderStyle="round" borderColor="gray" flexGrow={1} marginLeft={1} paddingX={1}>
            <Text dimColor>major step logs appear here once the run starts</Text>
          </Box>
        )}
      </Box>

      <ActivityPane
        lines={bus.lines}
        cols={cols}
        logRows={logRows}
        scrollUp={scrollUp}
        emptyHint="(no activity yet — planner/worker lines stream here live)"
      />

      <Box marginTop={1}>
        <Text dimColor>
          <Text bold color="white">↑/↓</Text> select │ <Text bold color="white">PgUp/PgDn</Text> scroll │{" "}
          <Text bold color="white">r</Text> refresh │ <Text bold color="yellow">q</Text> abort <Text dimColor>· resume by re-running `ompo`</Text>
        </Text>
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
