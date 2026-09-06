/**
 * Worker spawn (plan §7, M3/M4) — out-of-core edition.
 *
 * In-core the worker is runStructuredSubagent({keepAlive:false, strict}).
 * Here the worker is a stock `omp -p` subprocess with a clean context
 * (fresh process, only the spec prompt is visible — the §1.2 invariant
 * holds trivially): no transcript is attached, only the compiled spec.
 */

import { spawn } from "node:child_process";

export interface WorkerCall {
  prompt: string;
  sliceId: string;
  attempt: number;
  /** Pane title override (e.g. review sessions). */
  label?: string;
}

export interface WorkerContext {
  projectDir: string;
  /** Model pattern for `omp --model` (resolves orchestrator↔worker split, plan §10). */
  workerModel?: string;
  timeoutMs?: number;
  /** Extra argv appended after `omp` (e.g. ["--thinking","low"]). */
  extraArgs?: string[];
  /** Slice dir for session persistence (tmux-TUI completion source). */
  sessionDir?: string;
  /** Abort: worker is SIGTERMed when this fires (loop passes its signal). */
  signal?: AbortSignal;
  /** Live progress line sink (one concise line per agent step). */
  onProgress?: (line: string) => void;
}

export interface WorkerResult {
  exit: number | null;
  timedOut: boolean;
  /** Assistant text (reconstructed from --mode json events; report extraction reads this). */
  stdout: string;
  stderr: string;
  durationMs: number;
  resolvedModel?: string;
  /** Raw NDJSON event stream (for worker-<n>.events.jsonl forensics). */
  eventsJsonl?: string;
}

export const DEFAULT_WORKER_TIMEOUT_MS = 15 * 60 * 1000;

export type WorkerRunner = (call: WorkerCall, ctx: WorkerContext) => Promise<WorkerResult>;

/** Single-line, capped at n chars (newlines → spaces). */
function oneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** Strip a cwd/worktree prefix so absolute paths read as repo-relative. */
export function relativize(s: string, cwd?: string): string {
  if (!cwd) return s;
  if (s === cwd) return ".";
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return s.split(prefix).join("");
}

/** Pick a human-meaningful summary out of a tool's args object. */
export function summarizeToolArgs(args: unknown, cwd?: string): string {
  if (typeof args === "string") return oneLine(relativize(args, cwd), 80);
  if (typeof args !== "object" || args === null) return "";
  const a = args as Record<string, unknown>;
  // Edit-style tools carry the target as `[path#id]` at the head of `input`.
  const input = a["input"];
  if (typeof input === "string") {
    const m = input.match(/^\[([^\]#]+)/);
    if (m) return oneLine(relativize(m[1]!.trim(), cwd), 80);
  }
  for (const key of ["command", "cmd", "path", "file", "filePath", "pattern", "query", "url", "prompt"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) return oneLine(relativize(v, cwd), 80);
  }
  // Fall back to the first short string value, else truncated JSON.
  for (const v of Object.values(a)) {
    if (typeof v === "string" && v.trim() && v.length <= 120) return oneLine(relativize(v, cwd), 80);
  }
  try {
    return oneLine(relativize(JSON.stringify(args), cwd), 80);
  } catch {
    return "";
  }
}

interface ProgressState {
  turn: number;
  /** Worker cwd (worktree): stripped from tool paths for readability. */
  cwd?: string;
}

/**
 * Translate one `--mode json` event into a concise progress line.
 * Returns undefined for high-volume / uninteresting events.
 * Pure (no I/O) — unit-tested.
 */
export function progressLineForEvent(event: unknown, state: ProgressState): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const ev = event as Record<string, unknown>;
  switch (ev["type"]) {
    case "turn_start":
      state.turn += 1;
      return `turn ${state.turn}…`;
    case "tool_execution_start": {
      const name = typeof ev["toolName"] === "string" ? ev["toolName"] : "tool";
      const summary = summarizeToolArgs(ev["args"], state.cwd);
      return summary ? `tool ${name}: ${summary}` : `tool ${name}…`;
    }
    case "tool_execution_end": {
      if (ev["isError"] === true) {
        const name = typeof ev["toolName"] === "string" ? ev["toolName"] : "tool";
        return `tool ${name} FAILED`;
      }
      return undefined;
    }
    case "message_end": {
      const msg = ev["message"] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
      if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return undefined;
      const text = msg.content
        .filter((p) => p.type === "text" && p.text && p.text.trim())
        .map((p) => p.text as string)
        .join(" ")
        .trim();
      if (!text) return undefined;
      if (text.includes("<<<OMPO_REPORT") || text.includes("<<<OMPO_REVIEW")) {
        return "report block printed";
      }
      return `says: ${oneLine(text, 160)}`;
    }
    case "auto_retry_start":
      return `retrying: ${oneLine(String(ev["errorMessage"] ?? "provider error"), 120)}`;
    case "auto_retry_end":
      return ev["success"] === true ? "retry recovered" : "retry failed";
    case "retry_fallback_applied":
      return `model fallback ${String(ev["from"] ?? "?")} -> ${String(ev["to"] ?? "?")}`;
    case "notice": {
      if (ev["level"] === "info") return undefined;
      return `note: ${oneLine(String(ev["message"] ?? ""), 140)}`;
    }
    case "turn_end": {
      const results = Array.isArray(ev["toolResults"]) ? ev["toolResults"].length : 0;
      return results > 0 ? `turn ${state.turn} done (${results} tool results)` : undefined;
    }
    default:
      return undefined;
  }
}

/** Append assistant text parts of a message_end event to the collector. */
function collectAssistantText(event: unknown, out: string[]): void {
  if (typeof event !== "object" || event === null) return;
  const ev = event as Record<string, unknown>;
  if (ev["type"] !== "message_end") return;
  const msg = ev["message"] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;
  for (const part of msg.content) {
    if (part.type === "text" && part.text) out.push(part.text);
  }
}

/** Real runner: `omp -p --mode json --cwd <dir> --no-session --auto-approve [--model m] <prompt>`. */
export const runOmpWorker: WorkerRunner = (call, ctx) =>
  new Promise((resolve) => {
    const started = Date.now();
    const args = ["-p", "--mode", "json", "--cwd", ctx.projectDir, "--no-session", "--auto-approve"];
    if (ctx.workerModel) args.push("--model", ctx.workerModel);
    if (ctx.extraArgs) args.push(...ctx.extraArgs);
    args.push(call.prompt);

    // NOTE: stdin MUST be "ignore". Node/Bun default stdio pipes stdin, and
    // `omp -p` then blocks forever in its readPipedInput startup phase
    // waiting for piped input that never arrives (observed: 600s hang).
    // detached: own process group, so terminal Ctrl-C (foreground pgid) hits
    // only the orchestrator. Abort cleanup is explicit via `signal` below —
    // without detach, Ctrl-C kills the worker with 130 and the loop logs a
    // bogus "worker failure … retrying" on the way to aborting.
    const child = spawn("omp", args, {
      cwd: ctx.projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    // --mode json streams NDJSON events on stdout. stdout (the WorkerResult
    // field) is the reconstructed assistant text so report extraction keeps
    // working; rawLines keeps the event stream for forensics. Non-JSON lines
    // (older omp, crash traces) fall back to plain-text capture.
    const assistantParts: string[] = [];
    let assistantChars = 0;
    const rawLines: string[] = [];
    let rawChars = 0;
    let lineBuf = "";
    let stderr = "";
    let done = false;
    const progressState: ProgressState = { turn: 0, cwd: ctx.projectDir };
    const emit = (line: string) => {
      try {
        ctx.onProgress?.(line);
      } catch {
        /* progress is advisory; never fail the worker */
      }
    };
    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      if (rawChars < 2_000_000) {
        rawLines.push(line);
        rawChars += line.length + 1;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        // Plain-text fallback: keep it for the report extractor.
        if (assistantChars < 500_000) {
          assistantParts.push(line);
          assistantChars += line.length + 1;
        }
        return;
      }
      if (typeof event === "object" && event !== null) {
        collectAssistantText(event, assistantParts);
        // Recompute cheaply: parts are small; cap the joined tail.
        assistantChars = 0;
        for (const p of assistantParts) assistantChars += p.length + 1;
        if (assistantChars > 500_000) {
          let excess = assistantChars - 500_000;
          while (excess > 0 && assistantParts.length > 0) {
            const first = assistantParts.shift()!;
            excess -= first.length + 1;
          }
          assistantChars = 0;
          for (const p of assistantParts) assistantChars += p.length + 1;
        }
        const progress = progressLineForEvent(event, progressState);
        if (progress) emit(progress);
      }
    };
    const finish = (partial: Partial<WorkerResult>) => {
      if (done) return;
      done = true;
      ctx.signal?.removeEventListener("abort", onAbort);
      // Flush a trailing partial line (no trailing newline on kill).
      if (lineBuf.trim()) handleLine(lineBuf);
      resolve({
        exit: null,
        timedOut: false,
        stdout: assistantParts.join("\n"),
        stderr,
        durationMs: Date.now() - started,
        eventsJsonl: rawLines.join("\n"),
        ...partial,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 5000).unref?.();
      finish({ timedOut: true });
    }, ctx.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (d: Buffer) => {
      lineBuf += d.toString();
      // Parse complete lines incrementally so progress is live.
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        handleLine(line);
      }
      if (lineBuf.length > 1_000_000) lineBuf = lineBuf.slice(-1_000_000);
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
      // Forward terse stderr hints live (extension errors, warnings).
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t) emit(`stderr: ${oneLine(t, 140)}`);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ exit: null, stderr: stderr + `\nspawn error: ${String(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ exit: code });
    });
  });

/** Model-resolution helper (plan §10, zero new resolver code out-of-core). */
export function resolveWorkerModel(
  sliceAgent: string | undefined,
  defaults: { workerModel?: string; agentModels?: Record<string, string> },
): string | undefined {
  if (sliceAgent && defaults.agentModels?.[sliceAgent]) {
    return defaults.agentModels[sliceAgent];
  }
  // A slice Agent: that already looks like a model pattern passes through.
  if (sliceAgent && /[/:._-]/.test(sliceAgent)) return sliceAgent;
  return defaults.workerModel;
}
