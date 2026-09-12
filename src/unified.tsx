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
import { loadEffectiveConfig } from "./globalConfig.ts";
import { parseRoadmap, sha256Hex } from "./parse.ts";
import {
  buildPlanPreview,
  defaultPreviewDecision,
  formatPreviewSummary,
  renderPreviewLines,
  type PlanPreview,
  type PreviewDecision,
  type PreviewHandler,
} from "./planPreview.ts";
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
  activityH,
  AgentsPane,
  agentStates,
  bell,
  BoardPane,
  boardWidth,
  clampTab,
  ForensicsPane,
  HelpOverlay,
  hhmmss,
  InspectorPane,
  isFailureStatus,
  isNarrow,
  middleRows,
  moveSel,
  mutexHolders,
  narrowSplit,
  newFailures,
  nextFailure,
  preferredSel,
  prevFailure,
  railSplit,
  spinnerFrame,
  summaryText,
  viewForRun,
  visibleIndices,
  yankSlicePath,
  type RunView,
} from "./watch.tsx";
import { queueControl } from "./control.ts";
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
  noUnblock?: boolean;
  maxUnblocks?: number;
  noHandoff?: boolean;
  contextCap?: number;
  reverify?: boolean;
  tmux?: boolean;
  /** Test seams (default: the real planner + loop). */
  planner?: typeof runInitPlanner;
  looper?: (opts: LoopOptions) => Promise<LoopResult>;
  /**
   * Preview approval (default: accept valid plans, refuse blocked ones).
   * The TUI passes an interactive accept/edit/abort resolver; headless mode
   * and tests use the default or a fake. An "accept" for a blocked plan
   * always throws — invalid roadmaps never silently proceed.
   */
  preview?: PreviewHandler;
}

export interface UnifiedSession {
  phase: "planning" | "preview" | "ready" | "running" | "done";
  runId: string | null;
  note: string;
}

export type { AgentRow } from "./watch.tsx";
export { agentStates } from "./watch.tsx";

const POLL_MS = 900;

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
  let markdown = readFileSync(roadmapPath, "utf8");
  // Preview gate: slice ids/titles/effort/gates/deps + lint findings surface
  // before anything runs. Accept proceeds, abort stops, edit re-reads the
  // file (edited externally) and revalidates — same parser, same lint, no
  // second representation. Blocked plans can never be accepted.
  session.phase = "preview";
  const cfg = loadEffectiveConfig(o.projectDir);
  for (;;) {
    const preview = buildPlanPreview(markdown, { verifyDefaults: cfg.verifyDefaults, agentModels: cfg.agentModels });
    log(formatPreviewSummary(preview));
    for (const line of renderPreviewLines(preview)) log(line);
    const decision = await (o.preview ?? defaultPreviewDecision)(preview);
    if (decision === "abort") {
      session.phase = "done";
      session.note = "preview aborted by operator";
      return abortedResult();
    }
    if (decision === "edit") {
      log(`reloading ${roadmapPath} after external edit…`);
      markdown = readFileSync(roadmapPath, "utf8");
      continue;
    }
    if (preview.status === "blocked") {
      throw new Error(`cannot accept: roadmap has ${preview.errors.length} blocking error(s) — fix ${roadmapPath} and re-run`);
    }
    break;
  }
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
      maxUnblocksOverride: o.maxUnblocks,
      noHandoff: o.noHandoff,
      contextCapOverride: o.contextCap,
      reverify: o.reverify,
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
/**
 * Mutable cell shared by the preview handler (writer, inside
 * driveUnifiedFlow) and the TUI (reader/resolver, via useInput). Fields are
 * replaced per preview round (accept/edit/abort clears them).
 */
export interface PreviewBridge {
  preview: PlanPreview | null;
  resolve: ((d: PreviewDecision) => void) | null;
}

interface UnifiedAppProps {
  project: string;
  session: UnifiedSession;
  bus: LogBus;
  requestAbort: () => void;
  /** Claim-loop width at loop start (mirrors jobs; +/- sends absolute values). */
  initialJobs?: number;
  /** Planner-preview gate state (set while session.phase === "preview"). */
  bridge?: PreviewBridge;
  /** Roadmap path shown in the preview pane (defaults to <project>/ROADMAP.md). */
  roadmapPath?: string;
}

export function PlanPreviewPane({ preview, roadmapPath, maxRows }: { preview: PlanPreview; roadmapPath?: string; maxRows?: number }): React.JSX.Element {
  const color = preview.status === "blocked" ? "red" : preview.status === "warnings" ? "yellow" : "green";
  const lines = renderPreviewLines(preview);
  const shown = maxRows === undefined ? lines : lines.slice(0, Math.max(0, maxRows));
  const more = lines.length - shown.length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text bold color="white" wrap="truncate"> plan preview <Text color={color}>· {preview.status}</Text>{more > 0 ? <Text dimColor> · +{more} more (see ROADMAP.md)</Text> : null} </Text>
      {preview.rows.length === 0
        ? <Text dimColor>(unparseable — see errors below)</Text>
        : shown.map((l, i) => (
          <Text key={i} dimColor={l.startsWith("  warn") || l.startsWith("  error")} wrap="truncate">{l}</Text>
        ))}
      <Box marginTop={1}>
        <Text dimColor wrap="truncate">
          <Text bold color="white">y</Text> accept │ <Text bold color="white">e</Text> reload {roadmapPath ?? "ROADMAP.md"} after editing │{" "}
          <Text bold color="white">q</Text> abort{preview.status === "blocked" ? <Text color="red"> · blocked plans cannot be accepted</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}

export function UnifiedApp({ project, session, bus, requestAbort, initialJobs, bridge, roadmapPath }: UnifiedAppProps): React.JSX.Element {
  const [view, setView] = useState<RunView | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Log-panel scroll margin in visual rows (0 = stuck to the live tail).
  const [scrollUp, setScrollUp] = useState(0);
  const [tab, setTab] = useState(0);
  const [boardMode, setBoardMode] = useState<"list" | "dag">("list");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [forensicScroll, setForensicScroll] = useState(0);
  const [yanked, setYanked] = useState<string | null>(null);
  const failedRef = useRef<string[]>([]);
  // Live-control mirrors (loop is source of truth; activity lines confirm).
  const [jobsVal, setJobsVal] = useState(Math.max(1, Math.floor(initialJobs ?? 1)));
  const [pausedMirror, setPausedMirror] = useState(false);

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
    // Planner preview gate (swallows everything except help + decisions so
    // a blocked plan cannot be run by accident).
    const pv = session.phase === "preview" ? bridge?.preview : null;
    const presolve = session.phase === "preview" ? bridge?.resolve : null;
    if (pv && presolve) {
      if (input === "?") {
        setShowHelp((h) => !h);
        return;
      }
      if (key.escape) {
        if (showHelp) setShowHelp(false);
        return;
      }
      if (showHelp) return;
      if (input === "y" || key.return) {
        if (pv.status === "blocked") {
          bus.push("plan is blocked — edit ROADMAP.md externally, press e to reload, or q to abort");
          return;
        }
        presolve("accept");
        return;
      }
      if (input === "e" || input === "E") {
        bus.push("reloading ROADMAP.md from disk — edit the file in another shell first, then press e again if needed");
        presolve("edit");
        return;
      }
      if (input === "q") {
        presolve("abort");
        return;
      }
      return;
    }
    if (input === "q") {
      requestAbort();
      return;
    }
    if (input === "c" && key.ctrl) {
      requestAbort();
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
      const v = viewRef.current;
      if (v?.detail) {
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
      if (input === "y") {
        const v = viewRef.current;
        if (v?.detail) setYanked(yankSlicePath(project, v.runId, v.detail.sliceId));
        return;
      }
      return;
    }
    if (input === "r" && session.runId) {
      setView(viewForRun(project, session.runId, viewRef.current?.sel ?? 0));
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
      const v = viewRef.current;
      if (!v || !session.runId) return;
      // Strictly after/before sel, wrapping — repeat presses walk the failure list.
      const target = input === "n" ? nextFailure(v.slices, v.sel + 1) : prevFailure(v.slices, v.sel - 1);
      if (target >= 0) {
        bell();
        setView(viewForRun(project, session.runId, target));
      }
      return;
    }
    if (/^[1-6]$/.test(input)) {
      setTab(clampTab(Number(input) - 1));
      return;
    }
    // Live operator controls (run phase only): same intent queue as run TUI.
    if (input === "R" || input === "S" || input === "B" || input === "K" || input === "+" || input === "=" || input === "-" || input === "P") {
      const v = viewRef.current;
      if (!v || !session.runId || session.phase !== "running") return;
      const push = bus.push;
      if (input === "R" || input === "S" || input === "B" || input === "K") {
        const target = v.slices[v.sel];
        if (!target) return;
        if (input === "R") queueControl(push, project, session.runId, { kind: "retry", sliceId: target.id });
        else if (input === "S") queueControl(push, project, session.runId, { kind: "skip", sliceId: target.id });
        else if (input === "B") {
          queueControl(push, project, session.runId, { kind: "park", sliceId: target.id, reason: "operator park from TUI — fix the environment, then resume or press R" });
        } else queueControl(push, project, session.runId, { kind: "kill", sliceId: target.id });
      } else if (input === "P") {
        const next = !pausedMirror;
        setPausedMirror(next);
        queueControl(push, project, session.runId, next ? { kind: "pause" } : { kind: "resume" });
      } else {
        const next = Math.min(32, Math.max(1, jobsVal + (input === "-" ? -1 : 1)));
        setJobsVal(next);
        queueControl(push, project, session.runId, { kind: "set-jobs", jobs: next });
      }
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
      const s = moveSel(v.slices, v.sel, input === "k" || key.upArrow ? -1 : 1, failuresOnly);
      setView(viewForRun(project, session.runId, s));
    }
  });

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const narrow = isNarrow(cols);
  // Fixed frame: header (2) + middle band + activity + footer (2) == rows,
  // so the frame never spills under the screen; panes window/clip inside it.
  const logRows = activityRows(rows);
  const actH = activityH(logRows);
  const mid = middleRows(rows, actH);
  const phaseLabel = session.phase === "planning"
    ? "planning — surveying project docs…"
    : session.phase === "preview"
      ? `preview — ${bridge?.preview?.status ?? "loading"} (y accept · e reload · q abort)`
      : session.phase === "ready"
        ? "ready — starting run…"
        : session.phase === "running"
          ? view && view.live ? "RUNNING" : "running"
          : `done ${session.note}`;
  const live = session.phase === "planning" || session.phase === "preview" || session.phase === "ready" || (session.phase === "running" && (!view || view.live));
  const bw = narrow ? Math.max(24, cols - 2) : boardWidth(cols);
  const statusOf = (id: string) => view?.slices.find((s) => s.id === id);
  const agents = agentStates(bus.lines);
  const locks = view ? mutexHolders(view.slices) : [];
  const visibleCount = view ? visibleIndices(view.slices, failuresOnly).length : 0;
  const rail = railSplit(mid, visibleCount, agents.length);
  const nsplit = narrowSplit(mid, visibleCount, agents.length);
  const previewing = session.phase === "preview" && bridge?.preview != null;
  // Preview chrome inside the middle band: borders + title + hint ≈ 5 rows.
  const previewRows = Math.max(1, mid - 5);

  if (fullscreen && view?.detail) {
    return (
      <Box flexDirection="column" height={rows} overflow="hidden">
        <ForensicsPane project={project} runId={view.runId} detail={view.detail} scrollUp={forensicScroll} height={rows} width={cols} yanked={yanked} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows} overflowY="hidden">
      <Box>
        <Text color={live ? "cyan" : "gray"}>{spinnerFrame(Date.now(), live)}</Text>
        <Text> </Text>
        <Text bold color="white">ompo</Text>
        <Text color={live ? "cyan" : "gray"} bold={live} wrap="truncate"> · {phaseLabel}</Text>
        {view ? <Text dimColor wrap="truncate"> · {summaryText(view)}</Text> : null}
      </Box>
      <Box>
        {view
          ? <Text dimColor wrap="truncate">run {view.runId} · updated {hhmmss(view.updatedAt)}</Text>
          : <Text dimColor>no run yet — roadmap first</Text>}
      </Box>
      {showHelp ? (
        <Box flexDirection="column" height={mid + actH} overflowY="hidden">
          <HelpOverlay controls />
        </Box>
      ) : previewing ? (
        <Box flexDirection="column" height={mid} overflowY="hidden">
          <PlanPreviewPane preview={bridge!.preview!} roadmapPath={roadmapPath ?? join(project, "ROADMAP.md")} maxRows={previewRows} />
        </Box>
      ) : narrow ? (
        <Box flexDirection="column" height={mid} overflowY="hidden">
          {view ? <BoardPane view={view} width={bw} mode={boardMode} failuresOnly={failuresOnly} maxRows={nsplit.boardRows} /> : (
            <Box flexDirection="column" borderStyle="round" borderColor="gray">
              <Text bold color="white"> slices </Text>
              <Text dimColor>(roadmap not ready)</Text>
            </Box>
          )}
          {view ? (
            <Box marginTop={1} height={nsplit.inspectorH} overflowY="hidden">
              <InspectorPane view={view} tab={tab} gutter={false} height={nsplit.inspectorH} />
            </Box>
          ) : (
            <Box flexDirection="column" borderStyle="round" borderColor="gray" marginTop={1} paddingX={1} height={nsplit.inspectorH} overflowY="hidden">
              <Text dimColor>major step logs appear here once the run starts</Text>
            </Box>
          )}
          <AgentsPane agents={agents} statusOf={statusOf} width={bw} verifyingIds={locks} max={nsplit.agentsShown} />
        </Box>
      ) : (
        <Box flexDirection="row" height={mid} overflowY="hidden">
          <Box flexDirection="column" width={bw} flexShrink={0}>
            {view ? <BoardPane view={view} width={bw} mode={boardMode} failuresOnly={failuresOnly} maxRows={rail.boardRows} /> : (
              <Box flexDirection="column" borderStyle="round" borderColor="gray">
                <Text bold color="white"> slices </Text>
                <Text dimColor>(roadmap not ready)</Text>
              </Box>
            )}
            <AgentsPane agents={agents} statusOf={statusOf} width={bw} verifyingIds={locks} max={rail.agentsShown} />
          </Box>
          {view ? <InspectorPane view={view} tab={tab} height={mid} /> : (
            <Box flexDirection="column" borderStyle="round" borderColor="gray" marginLeft={1} paddingX={1} height={mid} overflowY="hidden">
              <Text dimColor>major step logs appear here once the run starts</Text>
            </Box>
          )}
        </Box>
      )}
      {!showHelp ? (
        <ActivityPane
          lines={bus.lines}
          cols={cols}
          logRows={logRows}
          scrollUp={scrollUp}
          emptyHint="(no activity yet — planner/worker lines stream here live)"
        />
      ) : null}
      <Box marginTop={1}>
        {previewing ? (
          <Text dimColor wrap="truncate">
            <Text bold color="white">y</Text> accept │ <Text bold color="white">e</Text> reload after editing │{" "}
            <Text bold color="white">q</Text> abort │ <Text bold color="white">?</Text> help
          </Text>
        ) : (
          <Text dimColor wrap="truncate">
            <Text bold color="white">↑/↓</Text> select │ <Text bold color="white">n/p</Text> failure │ <Text bold color="white">g</Text> dag │{" "}
            <Text bold color="white">1-6</Text> tabs │ <Text bold color="white">Enter</Text> forensics │ <Text bold color="white">?</Text> help │{" "}
            <Text bold color="white">R/S/B/K</Text> ctl · <Text bold color="white">+/-</Text> jobs{pausedMirror ? <Text color="yellow"> · PAUSED</Text> : null} │{" "}
            <Text bold color="yellow">q</Text> abort <Text dimColor>· resume by re-running `ompo`</Text>
          </Text>
        )}
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
    process.on("SIGHUP", onSig);
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    try {
      // eslint-disable-next-line no-console
      return await driveUnifiedFlow(opts, (m) => console.log(m), session, ctrl.signal);
    } finally {
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      process.off("SIGHUP", onSig);
    }
  }
  // Lazy ink load: `--help`/headless paths never pay for react (cli.ts convention).
  const { render } = await import("ink");
  const bus = createLogBus();
  const ctrl = new AbortController();
  const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
  // Preview bridge: the flow's preview handler parks the plan here and waits
  // for a y/e/q keypress; Ctrl-C aborts the wait like any other phase.
  const bridge: PreviewBridge = { preview: null, resolve: null };
  const preview: PreviewHandler = (p) => new Promise<PreviewDecision>((resolve) => {
    const onAbort = (): void => {
      bridge.preview = null;
      bridge.resolve = null;
      resolve("abort");
    };
    if (ctrl.signal.aborted) {
      onAbort();
      return;
    }
    bridge.preview = p;
    bus.push(`plan preview: ${p.rows.length} slice(s) — ${p.status} — y accept · e reload after editing · q abort`);
    ctrl.signal.addEventListener("abort", onAbort, { once: true });
    bridge.resolve = (d) => {
      ctrl.signal.removeEventListener("abort", onAbort);
      bridge.preview = null;
      bridge.resolve = null;
      resolve(d);
    };
  });
  const instance = render(
    <UnifiedApp
      project={opts.projectDir}
      session={session}
      bus={bus}
      initialJobs={opts.jobs}
      bridge={bridge}
      roadmapPath={opts.roadmapPath ?? join(opts.projectDir, "ROADMAP.md")}
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
  process.on("SIGHUP", onSignal);
  try {
    const result = await driveUnifiedFlow({ ...opts, preview: opts.preview ?? preview }, (m) => bus.push(m), session, ctrl.signal);
    instance.unmount();
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
    process.off("SIGHUP", onSignal);
  }
}
