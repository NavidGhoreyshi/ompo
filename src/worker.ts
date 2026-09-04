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
}

export interface WorkerContext {
  projectDir: string;
  /** Model pattern for `omp --model` (resolves orchestrator↔worker split, plan §10). */
  workerModel?: string;
  timeoutMs?: number;
  /** Extra argv appended after `omp` (e.g. ["--thinking","low"]). */
  extraArgs?: string[];
}

export interface WorkerResult {
  exit: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  resolvedModel?: string;
}

export const DEFAULT_WORKER_TIMEOUT_MS = 15 * 60 * 1000;

export type WorkerRunner = (call: WorkerCall, ctx: WorkerContext) => Promise<WorkerResult>;

/** Real runner: `omp -p --cwd <dir> --no-session --auto-approve [--model m] <prompt>`. */
export const runOmpWorker: WorkerRunner = (call, ctx) =>
  new Promise((resolve) => {
    const started = Date.now();
    const args = ["-p", "--cwd", ctx.projectDir, "--no-session", "--auto-approve"];
    if (ctx.workerModel) args.push("--model", ctx.workerModel);
    if (ctx.extraArgs) args.push(...ctx.extraArgs);
    args.push(call.prompt);

    // NOTE: stdin MUST be "ignore". Node/Bun default stdio pipes stdin, and
    // `omp -p` then blocks forever in its readPipedInput startup phase
    // waiting for piped input that never arrives (observed: 600s hang).
    const child = spawn("omp", args, {
      cwd: ctx.projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (partial: Partial<WorkerResult>) => {
      if (done) return;
      done = true;
      resolve({
        exit: null,
        timedOut: false,
        stdout,
        stderr,
        durationMs: Date.now() - started,
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
      stdout += d.toString();
      if (stdout.length > 500_000) stdout = stdout.slice(-500_000);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
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
