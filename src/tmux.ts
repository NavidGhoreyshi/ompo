/**
 * tmux TUI runner — the real omp UI in worker panes.
 *
 * Each worker launches as interactive `omp` (no `-p`) in its own tiled pane:
 * full streaming output, tool calls, spinners — everything the user would see
 * running omp by hand. Implements WorkerRunner, so the loop needs no changes.
 *
 * Completion is detected from the session JSONL (`--session-dir` = slice
 * dir), never by screen-scraping: assistant text parts are concatenated and
 * run through the standard report extractor. Only a structurally valid
 * `done=true` report ends the run — invalid/done=false blocks keep the pane
 * alive so the worker can self-correct, a dynamic headless `-p` lacks.
 * The pane is killed after extraction (or on timeout/abort).
 *
 * Requires $TMUX_PANE (i.e. `ompo run --tmux` from inside a tmux client).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPORT_CLOSE, REPORT_OPEN, validateCompletionReport } from "./report.ts";
import { REVIEW_CLOSE, REVIEW_OPEN } from "./review.ts";
import { DEFAULT_WORKER_TIMEOUT_MS, type WorkerRunner, type WorkerResult } from "./worker.ts";

/** Sync tmux control-call seam (fake in tests). */
export type TmuxExec = (args: string[]) => { exit: number; out: string };

export const realTmuxExec: TmuxExec = (args) => {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return { exit: r.status ?? 1, out: `${r.stdout ?? ""}`.trim() };
};

export interface TmuxRunnerOptions {
  exec?: TmuxExec;
  /** Pane to split (default: $TMUX_PANE). */
  homePane?: string;
  /** Poll interval for session completion (default 2000ms). */
  pollMs?: number;
}

const TUI_SUFFIX = [
  "",
  "[Session note: you are running inside a visible interactive terminal pane",
  "the user is watching. Work normally. When the slice is fully done AND you",
  "have verified it yourself, print exactly one report block and then stop",
  "and wait — do not exit; the orchestrator will close this pane.]",
].join("\n");

/**
 * Last complete block between `open`/`close` wins. Workers may print
 * done=false while still working, then done=true when finished; reviewers
 * print exactly one verdict block, so the first parseable one ends the pane.
 * (Headless -p emits exactly one block, so the shared first-match
 * extractor is left untouched for that path.)
 */
function extractLastBlock(texts: string, open: string, close: string): unknown | undefined {
  const start = texts.lastIndexOf(open);
  if (start < 0) return undefined;
  const end = texts.indexOf(close, start + open.length);
  if (end < 0) return undefined;
  try {
    return JSON.parse(texts.slice(start + open.length, end).trim());
  } catch {
    return undefined;
  }
}

/** Assistant text of sessions created after `baseline` (current attempt only). */
function scanSessionTexts(sessionDir: string, baseline: ReadonlySet<string>): string {
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl") && !baseline.has(f));
  } catch {
    return "";
  }
  const texts: string[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(join(sessionDir, f), "utf8");
      if (content.length > 500_000) content = content.slice(-500_000);
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.includes('"assistant"')) continue;
      try {
        const ev = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
        };
        if (ev.type !== "message" || ev.message?.role !== "assistant") continue;
        for (const part of ev.message.content ?? []) {
          if (part.type === "text" && part.text) texts.push(part.text);
        }
      } catch {
        /* partial line mid-write; next poll */
      }
    }
  }
  return texts.join("\n");
}

function listSessions(sessionDir: string): Set<string> {
  try {
    return new Set(readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")));
  } catch {
    return new Set();
  }
}
/**
 * Newest prior-attempt session id for `--resume`, or null on first attempt.
 * Lets retries continue with full context instead of starting blind.
 */
function priorSessionId(sessionDir: string, baseline: ReadonlySet<string>): string | null {
  let newest: { file: string; mtime: number } | null = null;
  for (const f of baseline) {
    try {
      const mtime = statSync(join(sessionDir, f)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file: f, mtime };
    } catch {
      continue;
    }
  }
  if (!newest) return null;
  const id = newest.file.replace(/\.jsonl$/, "").split("_").slice(1).join("_");
  return id.includes("-") ? id : null;
}

export function createTmuxRunner(opts: TmuxRunnerOptions = {}): WorkerRunner {
  const exec = opts.exec ?? realTmuxExec;
  const pollMs = opts.pollMs ?? 2000;

  const call = (args: string[]): string => {
    const r = exec(args);
    if (r.exit !== 0) throw new Error(`tmux ${args.join(" ").slice(0, 80)} failed: ${r.out.slice(-500)}`);
    return r.out;
  };

  return async (wcall, ctx): Promise<WorkerResult> => {
    const started = Date.now();
    const home = opts.homePane ?? process.env.TMUX_PANE;
    if (!home) throw new Error("tmux mode needs $TMUX_PANE — run `ompo run --tmux` from inside a tmux client");
    const sessionDir = ctx.sessionDir ?? ctx.projectDir;
    const baseline = listSessions(sessionDir);

    const resumeId = wcall.attempt > 1 ? priorSessionId(sessionDir, baseline) : null;
    const launchPrompt = resumeId
      ? `Continue the in-progress slice "${wcall.sliceId}" from the loaded session to done. ` +
        `When fully done AND verified, print exactly one report block and wait.${TUI_SUFFIX}`
      : wcall.prompt + TUI_SUFFIX;
    const launchArgv = ["omp", "--cwd", ctx.projectDir, "--session-dir", sessionDir, "--no-title", "--auto-approve"];
    if (ctx.workerModel) launchArgv.push("--model", ctx.workerModel);
    if (ctx.extraArgs) launchArgv.push(...ctx.extraArgs);
    if (resumeId) launchArgv.push("--resume", resumeId);
    launchArgv.push(launchPrompt);

    const pane = call(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", home]);
    try {
      call(["select-pane", "-t", pane, "-T", `ompo ${wcall.label ?? wcall.sliceId} a${wcall.attempt}`]);
      const window = call(["display-message", "-p", "-t", pane, "#{window_id}"]);
      // Replace the placeholder shell with interactive omp directly
      // (argv, no shell: the prompt needs no quoting).
      call(["respawn-pane", "-k", "-c", ctx.projectDir, "-t", pane, ...launchArgv]);
      call(["select-layout", "-t", window, "tiled"]);

      // Review sessions (label set) close their pane on the first parseable
      // verdict block — approved or not is the loop's call, not the pane's.
      const isReview = wcall.label !== undefined;
      const blockOpen = isReview ? REVIEW_OPEN : REPORT_OPEN;
      const blockClose = isReview ? REVIEW_CLOSE : REPORT_CLOSE;

      const deadline = started + (ctx.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
      for (;;) {
        if (ctx.signal?.aborted) {
          exec(["kill-pane", "-t", pane]);
          return { exit: null, timedOut: false, stdout: "", stderr: "", durationMs: Date.now() - started };
        }
        const texts = scanSessionTexts(sessionDir, baseline);
        const extracted = extractLastBlock(texts, blockOpen, blockClose);
        if (extracted !== undefined) {
          if (isReview) {
            const tail = texts.length > 500_000 ? texts.slice(-500_000) : texts;
            return { exit: 0, timedOut: false, stdout: tail, stderr: "", durationMs: Date.now() - started };
          }
          try {
            const report = validateCompletionReport(extracted, wcall.sliceId);
            // done=false means "still working" in an interactive session —
            // keep watching instead of killing the pane.
            if (report.done) {
              const tail = texts.length > 500_000 ? texts.slice(-500_000) : texts;
              return { exit: 0, timedOut: false, stdout: tail, stderr: "", durationMs: Date.now() - started };
            }
          } catch {
            /* invalid yet — worker may self-correct; keep watching */
          }
        }
        if (Date.now() > deadline) {
          exec(["kill-pane", "-t", pane]);
          return { exit: null, timedOut: true, stdout: "", stderr: "", durationMs: Date.now() - started };
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } finally {
      exec(["kill-pane", "-t", pane]);
    }
  };
}
