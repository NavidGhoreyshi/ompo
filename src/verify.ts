/**
 * Pluggable verifiers (plan §9, M5): ordered `command` steps with cwd +
 * timeout + expected-exit 0. Verdict persisted next to the report.
 * Output capped (tail N lines in store, full log to file).
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Verdict, VerdictStep } from "./types.ts";

export interface VerifyOptions {
  projectDir: string;
  timeoutMs?: number;
  /** Max chars of tail kept per step (default 4000). */
  tailChars?: number;
  /** Absolute path of the full log file to write. */
  logFile?: string;
  /** Live progress line sink (verify start/finish per command). */
  onProgress?: (line: string) => void;
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

function tail(text: string, n: number): string {
  return text.length > n ? text.slice(-n) : text;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exit: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
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
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString();
      if (output.length > 1_000_000) output = output.slice(-1_000_000);
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString();
      if (output.length > 1_000_000) output = output.slice(-1_000_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(null, false);
      output += `\nspawn error: ${String(err)}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
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
    const r = await runCommand(command, opts.projectDir, timeoutMs);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.exit === 0 && !r.timedOut) opts.onProgress?.(`verify ok: ${name} (${secs}s)`);
    else opts.onProgress?.(`verify FAIL: ${name} exit=${r.exit} timedOut=${r.timedOut} (${secs}s)`);
    const entry =
      `$ ${command}\n(exit=${r.exit} timedOut=${r.timedOut} ${Date.now() - t0}ms)\n${r.output}\n`;
    fullLog.push(entry);
    writeFileSync(logRef, entry, "utf8");
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
