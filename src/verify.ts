/**
 * Pluggable verifiers (plan §9, M5): ordered `command` steps with cwd +
 * timeout + expected-exit 0. Verdict persisted next to the report.
 * Output capped (tail N lines in store, full log to file).
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Verdict, VerdictStep } from "./types.ts";
import { classifyEnvFailure } from "./debug.ts";

export interface VerifyOptions {
  projectDir: string;
  timeoutMs?: number;
  /** Max chars of tail kept per step (default 4000). */
  tailChars?: number;
  /** Absolute path of the full log file to write. */
  logFile?: string;
  /** Live progress line sink (verify start/finish per command). */
  onProgress?: (line: string) => void;
  /** Extra env for gate commands (placeholder injection — scoped to the gate). */
  env?: Record<string, string>;
  /**
   * Grace after process exit before forcing stdio closed (default 10s).
   * A gate whose grandchildren outlive it and hold the pipes open would
   * otherwise wedge `close` forever — the exact stall that pinned a slice
   * in `verifying` with a zombie gate and no verdict. The recorded exit
   * code is preserved, so fail-fast semantics survive the fallback.
   */
  closeGraceMs?: number;
  /** Signs-of-life tick while a gate runs (default 60s; 0 disables). */
  heartbeatMs?: number;
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CLOSE_GRACE_MS = 10 * 1000;
export const DEFAULT_HEARTBEAT_MS = 60 * 1000;

function tail(text: string, n: number): string {
  return text.length > n ? text.slice(-n) : text;
}

/** Cap on streamed transcript bytes; mirrors the verdict's output cap. */
const TRANSCRIPT_MAX = 1_000_000;

/**
 * Live per-gate transcript: header at spawn, stdout/stderr as they arrive,
 * exit footer at the end. The dashboard tails this file while the gate runs,
 * so a verifying slice shows the gate instead of the finished worker's log.
 * Best-effort and byte-capped — a transcript that cannot be written must
 * never fail the gate.
 */
function createTranscript(
  path: string,
  command: string,
): {
  append: (chunk: string) => void;
  finish: (exit: number | null, timedOut: boolean, durationMs: number) => void;
} {
  let written = 0;
  let truncated = false;
  const append = (text: string): void => {
    if (written >= TRANSCRIPT_MAX) return;
    let chunk = text;
    if (written + chunk.length > TRANSCRIPT_MAX) {
      chunk = chunk.slice(0, TRANSCRIPT_MAX - written) + (truncated ? "" : "\n(transcript truncated — verdict holds the tail)\n");
      truncated = true;
    }
    written += chunk.length;
    try {
      appendFileSync(path, chunk);
    } catch {
      /* transcript is observational */
    }
  };
  try {
    writeFileSync(path, `$ ${command}\n`);
  } catch {
    /* transcript is observational */
  }
  return {
    append,
    finish: (exit, timedOut, durationMs) => append(`\n(exit=${exit} timedOut=${timedOut} ${durationMs}ms)\n`),
  };
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
  closeGraceMs: number = DEFAULT_CLOSE_GRACE_MS,
  onData?: (chunk: string) => void,
): Promise<{ exit: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let done = false;
    const finish = (exit: number | null, timedOut: boolean) => {
      if (done) return;
      done = true;
      resolve({ exit, timedOut, output });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* dead */
        }
      }, 3000).unref?.();
      finish(null, true);
    }, timeoutMs);
    timer.unref?.();
    const absorb = (d: Buffer): void => {
      const chunk = d.toString();
      onData?.(chunk);
      output += chunk;
      if (output.length > 1_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
    child.on("error", (err) => {
      clearTimeout(timer);
      clearTimeout(closeTimer);
      output += `\nspawn error: ${String(err)}`;
      if (output.length > 1_000_000) output = output.slice(-1_000_000);
      finish(null, false);
    });
    // `close` waits for stdio EOF, not just process exit: orphaned
    // grandchildren holding the pipes open delay it indefinitely. Once the
    // exit code is known, force the streams closed after a short grace so a
    // lost `close` can never wedge the verdict — resolve with the real code.
    let exitCode: number | null = null;
    let closeTimer: NodeJS.Timeout | undefined;
    child.on("exit", (code) => {
      exitCode = code;
      closeTimer = setTimeout(() => {
        output += `\n(close ${(closeGraceMs / 1000).toFixed(0)}s grace elapsed with pipes held open — forcing stdio closed)`;
        try {
          child.stdout.destroy();
        } catch {
          /* dead */
        }
        try {
          child.stderr.destroy();
        } catch {
          /* dead */
        }
        clearTimeout(timer);
        finish(exitCode, false);
      }, closeGraceMs);
      closeTimer.unref?.();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(closeTimer);
      finish(code, false);
    });
  });
}

/** Run verifier chain; empty chain passes vacuously (verdict records why). */
export async function runVerifiers(
  sliceId: string,
  attempt: number,
  commands: string[],
  logDir: string,
  opts: VerifyOptions,
): Promise<Verdict> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const tailChars = opts.tailChars ?? 4000;
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  mkdirSync(logDir, { recursive: true });
  const steps: VerdictStep[] = [];
  const fullLog: string[] = [];

  if (commands.length === 0) {
    return {
      sliceId,
      attempt,
      pass: true,
      steps: [],
      at: new Date().toISOString(),
    };
  }

  for (const command of commands) {
    const name = command.length > 60 ? command.slice(0, 60) + "…" : command;
    const logRef = join(logDir, `verify-${steps.length}.log`);
    const t0 = Date.now();
    opts.onProgress?.(`verify: $ ${command}`);
    // Truncate before spawning: an earlier attempt's transcript must never
    // read as this gate's live output.
    const transcript = createTranscript(logRef, command);
    // Signs of life for long gates: the verdict phase otherwise goes silent
    // for minutes, and silence is indistinguishable from a wedge on both
    // the TUI and the dashboard. Heartbeat only — no store writes.
    const heartbeat: NodeJS.Timeout | undefined =
      heartbeatMs > 0
        ? setInterval(() => {
            const line = `verify: still running ${name} (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`;
            opts.onProgress?.(line);
            transcript.append(`\n${line}\n`);
          }, heartbeatMs)
        : undefined;
    heartbeat?.unref?.();
    let r: { exit: number | null; timedOut: boolean; output: string };
    try {
      r = await runCommand(command, opts.projectDir, timeoutMs, opts.env, closeGraceMs, transcript.append);
    } finally {
      clearInterval(heartbeat);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const summary =
      r.exit === 0 && !r.timedOut
        ? `verify ok: ${name} (${secs}s)`
        : `verify FAIL: ${name} exit=${r.exit} timedOut=${r.timedOut} (${secs}s)`;
    opts.onProgress?.(summary);
    transcript.append(`\n${summary}\n`);
    transcript.finish(r.exit, r.timedOut, Date.now() - t0);
    const entry =
      `$ ${command}\n(exit=${r.exit} timedOut=${r.timedOut} ${Date.now() - t0}ms)\n${r.output}\n`;
    fullLog.push(entry);
    steps.push({
      name,
      command,
      exit: r.exit,
      timedOut: r.timedOut,
      outputTail: tail(r.output, tailChars),
      logRef,
    });
    if (r.exit !== 0) break; // fail fast; remaining steps unrun
  }

  const pass = steps.length > 0 && steps.every((s) => s.exit === 0);
  if (opts.logFile) writeFileSync(opts.logFile, fullLog.join("\n---\n"), "utf8");

  return { sliceId, attempt, pass, steps, at: new Date().toISOString() };
}

export interface EnvProbe {
  command: string;
  /** Gate output matched an infrastructure signature (port/DB/host/disk). */
  envBlocked: boolean;
  reason?: string;
  fix?: string;
  exit: number | null;
  timedOut: boolean;
}

/**
 * Pre-run env probe (`ompo run --check-env`): run each unique gate command
 * once against the base tree BEFORE any worker spawns, so a dead Postgres
 * or squatted port fails fast with a fix hint instead of burning model
 * calls. Best-effort by design: gates run pre-slice, so NON-env failures
 * (missing code the slices will write) are ignored — only infrastructure
 * signatures block. Never throws; a probe that can't spawn reports its
 * spawn error as output (classify decides).
 */
export async function preflightEnv(
  projectDir: string,
  commands: string[],
  opts?: { timeoutMs?: number; onProgress?: (line: string) => void },
): Promise<EnvProbe[]> {
  const out: EnvProbe[] = [];
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  for (const command of commands) {
    opts?.onProgress?.(`preflight: $ ${command}`);
    const r = await runCommand(command, projectDir, timeoutMs);
    const block = r.exit === 0 && !r.timedOut ? null : classifyEnvFailure([r.output]);
    out.push({
      command,
      envBlocked: block !== null,
      reason: block?.reason,
      fix: block?.fix,
      exit: r.exit,
      timedOut: r.timedOut,
    });
    opts?.onProgress?.(block ? `preflight BLOCKED: ${command} — ${block.reason}` : `preflight: ${command} exit=${r.exit}`);
  }
  return out;
}
