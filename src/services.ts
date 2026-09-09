/**
 * Shared-service auto-heal (self-sufficient loop).
 *
 * Projects declare how to bring their world up in `.omp/roadmap.yml`:
 * `serviceUp` (idempotent bring-up), `serviceReady` (readiness probes),
 * `serviceEnv` (extra env for worker + gate commands). When a gate fails
 * with healable infra output (DB down, port taken, host unresolvable) the
 * loop runs bring-up + ready-poll once and re-runs the gate instead of
 * parking as blocked-env. Only healable infra heals — disk-full and
 * missing-creds still park (placeholders own the creds path).
 */

import { spawn } from "node:child_process";
import type { RoadmapConfig } from "./config.ts";

/** Ready-poll budget default (serviceTimeoutSec override, seconds). */
export const DEFAULT_SERVICE_TIMEOUT_MS = 120_000;
/** Per-command budget for bring-up / probe commands. */
export const SERVICE_CMD_TIMEOUT_MS = 60_000;
/** Delay between readiness polls. */
export const SERVICE_POLL_MS = 2000;

export function hasServices(cfg: Pick<RoadmapConfig, "serviceUp" | "serviceReady" | "serviceEnv">): boolean {
  return (cfg.serviceUp?.length ?? 0) > 0
    || (cfg.serviceReady?.length ?? 0) > 0
    || Object.keys(cfg.serviceEnv ?? {}).length > 0;
}

export function serviceEnvOf(cfg: Pick<RoadmapConfig, "serviceEnv">): Record<string, string> {
  return { ...(cfg.serviceEnv ?? {}) };
}

export function serviceTimeoutMs(cfg: Pick<RoadmapConfig, "serviceTimeoutSec">): number {
  return (cfg.serviceTimeoutSec ?? 120) * 1000;
}

/** True when the triage reason describes infra the bring-up path can fix. */
export function isHealableBlock(reason: string): boolean {
  const r = reason.toLowerCase();
  if (r.includes("database unreachable")) return true;
  if (r.includes("database \"") && r.includes("missing")) return true;
  if (r.includes("database role")) return true;
  if (r.includes("already in use")) return true;
  if (r.includes("host unresolvable")) return true;
  return false;
}

function exec(cmd: string, cwd: string, timeoutMs: number): Promise<{ exit: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let done = false;
    const finish = (exit: number | null) => {
      if (done) return;
      done = true;
      resolve({ exit, output });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* dead */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* dead */
        }
      }, 3000).unref?.();
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString();
      if (output.length > 200_000) output = output.slice(-200_000);
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString();
      if (output.length > 200_000) output = output.slice(-200_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      output += `\nspawn error: ${String(err)}`;
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface HealResult {
  ok: boolean;
  env: Record<string, string>;
  detail: string;
}

/**
 * Run bring-up commands, then poll readiness until green or budget spent.
 * Idempotent by contract (safe to re-run per attempt). Never throws.
 */
export async function healServices(opts: {
  projectDir: string;
  cfg: Pick<RoadmapConfig, "serviceUp" | "serviceReady" | "serviceEnv" | "serviceTimeoutSec">;
  onEvent?: (msg: string) => void;
}): Promise<HealResult> {
  const env = serviceEnvOf(opts.cfg);
  const up = opts.cfg.serviceUp ?? [];
  const ready = opts.cfg.serviceReady ?? [];
  const log = (m: string): void => {
    (opts.onEvent ?? ((x) => console.log(x)))(m);
  };
  for (const cmd of up) {
    log(`  services: $ ${cmd}`);
    const r = await exec(cmd, opts.projectDir, SERVICE_CMD_TIMEOUT_MS);
    if (r.exit !== 0) {
      const tail = r.output.trim().slice(-500);
      log(`  services FAIL: ${cmd.slice(0, 80)} exit=${r.exit}${tail ? ` — ${tail.split("\n").pop()}` : ""}`);
      return { ok: false, env, detail: `serviceUp failed: ${cmd.slice(0, 120)}` };
    }
    log(`  services ok: ${cmd.slice(0, 80)}`);
  }
  if (ready.length === 0) return { ok: true, env, detail: "bring-up ran, no readiness probes" };
  const deadline = Date.now() + serviceTimeoutMs(opts.cfg);
  for (;;) {
    let allOk = true;
    let failing = "";
    for (const probe of ready) {
      const r = await exec(probe, opts.projectDir, SERVICE_CMD_TIMEOUT_MS);
      if (r.exit !== 0) {
        allOk = false;
        failing = probe;
        break;
      }
    }
    if (allOk) {
      log(`  services ready: ${ready.length} probe(s) green`);
      return { ok: true, env, detail: "ready" };
    }
    if (Date.now() >= deadline) {
      log(`  services FAIL: readiness probe still red after budget: ${failing.slice(0, 120)}`);
      return { ok: false, env, detail: `readiness timeout: ${failing.slice(0, 120)}` };
    }
    log(`  services waiting: ${failing.slice(0, 80)} not ready yet…`);
    await sleep(SERVICE_POLL_MS);
  }
}
