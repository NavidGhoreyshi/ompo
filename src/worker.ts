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
  /**
   * Fresh-context generation within one attempt (context-cap handoff loop).
   * 0 = first spawn; each handoff respawns the same attempt with gen+1.
   * Generations never consume retry budget.
   */
  generation?: number;
  /** Pane title override (e.g. review sessions). */
  label?: string;
}

/** Cumulative per-session token counts from `--mode json` usage envelopes. */
export interface TokenUsage {
  input: number;
  output: number;
  /** totalTokens when reported, else input + output. */
  total: number;
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
  /**
   * Live token-usage sink (cumulative per-session totals, at most one call
   * per assistant message_end / turn_end carrying a usage envelope).
   * Advisory like onProgress; never fail the worker. Headless only — the
   * tmux runner has no JSON stream and never calls this.
   */
  onUsage?: (u: TokenUsage) => void;
  /**
   * Extra env for the worker (placeholder injection — scoped to the attempt).
   * Honored by the headless runner; tmux panes inherit the server env instead.
   */
  env?: Record<string, string>;
}

export interface WorkerResult {
  exit: number | null;
  timedOut: boolean;
  /** Assistant text (reconstructed from --mode json events; report extraction reads this). */
  stdout: string;
  stderr: string;
  durationMs: number;
  resolvedModel?: string;
  /** Latest cumulative usage observed on the stream (absent when unreported). */
  usage?: TokenUsage;
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

/**
 * Extract cumulative token usage from one `--mode json` event.
 * Assistant `message_end` / `turn_end` events carry
 * `message.usage = {input, output, cacheRead, cacheWrite, totalTokens, …}`
 * (verified against omp 18.1.14 output). Pure (no I/O) — unit-tested.
 */
export function usageForEvent(event: unknown): TokenUsage | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const ev = event as Record<string, unknown>;
  if (ev["type"] !== "message_end" && ev["type"] !== "turn_end") return undefined;
  const msg = ev["message"] as Record<string, unknown> | undefined;
  if (!msg || msg["role"] !== "assistant") return undefined;
  const usage = msg["usage"] as Record<string, unknown> | undefined;
  if (!usage || typeof usage["input"] !== "number" || typeof usage["output"] !== "number") {
    return undefined;
  }
  const input = usage["input"] as number;
  const output = usage["output"] as number;
  const total = typeof usage["totalTokens"] === "number" ? (usage["totalTokens"] as number) : input + output;
  return { input, output, total };
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
      env: ctx.env ? { ...process.env, ...ctx.env } : process.env,
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
    let latestUsage: TokenUsage | undefined;
    const progressState: ProgressState = { turn: 0, cwd: ctx.projectDir };
    const emit = (line: string) => {
      if (done) return;
      try {
        ctx.onProgress?.(line);
      } catch {
        /* progress is advisory; never fail the worker */
      }
    };
    const handleLine = (line: string): void => {
      if (done) return;
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
        const usage = usageForEvent(event);
        if (usage) {
          latestUsage = usage;
          if (!done) {
            try {
              ctx.onUsage?.(usage);
            } catch {
              /* usage is advisory; never fail the worker */
            }
          }
        }
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
        usage: latestUsage,
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

/** Display name for a chain entry (undefined = omp's configured default). */
export function displayModel(model: string | undefined): string {
  return model ?? "(omp default)";
}

/**
 * Ordered model chain for one spawn: primary first, then configured
 * fallbacks, then omp's default model as the last resort. Deduped
 * (first occurrence wins), so a chain that already names the default
 * never tries it twice. Pure — unit-tested.
 */
export function buildModelChain(
  primary: string | undefined,
  fallbacks: readonly string[] = [],
): (string | undefined)[] {
  const chain: (string | undefined)[] = [];
  const push = (m: string | undefined): void => {
    const v = m?.trim() ? m!.trim() : undefined;
    if (!chain.includes(v)) chain.push(v);
  };
  push(primary);
  for (const f of fallbacks) push(f);
  push(undefined);
  return chain;
}

export interface SpawnProbe {
  exit: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  eventsJsonl?: string;
}

/**
 * True when a spawn failed because the MODEL was unavailable — rate limit,
 * free-tier exhaustion, unknown model id — rather than because of the work.
 * Consult only when no valid report/review block was produced: a spawn that
 * yielded a block used a working model by definition. Timeouts are budgets,
 * not availability signals. Pure — unit-tested.
 */
export function isModelUnavailable(res: SpawnProbe): boolean {
  if (res.timedOut) return false;
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const events = res.eventsJsonl ?? "";
  if (/"errorStatus"\s*:\s*429/.test(events)) return true;
  if (/FreeUsageLimitError/.test(events)) return true;
  if (/429\s+Rate limit exceeded/i.test(events)) return true;
  if (/exceeds retry\.maxDelayMs/.test(events)) return true;
  if (/"auto_retry_end"[\s\S]{0,400}?"success"\s*:\s*false/.test(events)) return true;
  if (/unknown model|model .* not found|model not found|MODEL_NOT_FOUND/i.test(out)) return true;
  return false;
}

export interface FallbackOutcome extends WorkerResult {
  /** Model that produced the returned result. */
  model: string | undefined;
  /** Every model tried, in order (display names). */
  tried: string[];
  /** True when at least one fallback engaged. */
  fellBack: boolean;
}

/**
 * Spawn through the model chain: try each model in order until one's output
 * is accepted. A model counts as failed only when its output is rejected AND
 * {@link isModelUnavailable} blames the model — genuine work failures stop
 * the chain immediately so no fallback burns on broken code. Timeouts also
 * stop the chain (budgets, not availability). The caller owns forensics and
 * logging; per-iteration progress flows through `onModelAttempt` /
 * `onFallback`, partial-work preservation through `preserve`.
 */
export async function runWithModelFallbacks(
  runner: WorkerRunner,
  call: WorkerCall,
  base: Omit<WorkerContext, "workerModel">,
  chain: (string | undefined)[],
  opts: {
    /** Accept this stdout as the spawn's answer (e.g. block extraction). */
    accept: (stdout: string) => boolean;
    /** Commit partial work before moving to the next model. */
    preserve?: () => void;
    /** Observe each attempt (logging). */
    onModelAttempt?: (model: string | undefined, index: number, total: number) => void;
    /** Observe each fallback (logging). */
    onFallback?: (from: string | undefined, to: string | undefined) => void;
  },
): Promise<FallbackOutcome> {
  const tried: string[] = [];
  let last: WorkerResult | undefined;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    opts.onModelAttempt?.(model, i, chain.length);
    const res = await runner(call, { ...base, workerModel: model });
    tried.push(displayModel(model));
    last = res;
    if (!res.timedOut && opts.accept(res.stdout)) {
      return { ...res, model, tried, fellBack: i > 0 };
    }
    const more = i < chain.length - 1;
    if (!res.timedOut && more && isModelUnavailable(res)) {
      opts.preserve?.();
      opts.onFallback?.(model, chain[i + 1]!);
      continue;
    }
    return { ...res, model, tried, fellBack: i > 0 };
  }
  // Unreachable (chain always non-empty) — satisfies the type checker.
  throw new Error("empty model chain");
}
