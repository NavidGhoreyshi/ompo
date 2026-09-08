/**
 * `ompo doctor` — pre-run environment scan (read-only, never mutates).
 *
 * Every check funnels all I/O through {@link DoctorProbes} so tests inject
 * fakes and never spawn subprocesses. Each check catches its own errors and
 * reports `ok: false` instead of throwing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRoadmapYml, type RoadmapConfig } from "./config.ts";
import { listRuns, loadRun, lockHeld, sliceDir } from "./store.ts";
import { parseRoadmap, splitGateChain } from "./parse.ts";
import { crashedInFlight } from "./types.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** True when every check passed. */
  ok: boolean;
}

export interface DoctorProbes {
  exec?: (cmd: string, args: string[]) => { exit: number; out: string };
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  env?: Record<string, string | undefined>;
  diskFreeMb?: () => number | null;
}

interface ResolvedProbes {
  exec: (cmd: string, args: string[]) => { exit: number; out: string };
  exists: (p: string) => boolean;
  readFile: (p: string) => string;
  env: Record<string, string | undefined>;
  diskFreeMb: () => number | null;
}

function defaultExec(
  cmd: string,
  args: string[],
): { exit: number; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return { exit: r.status ?? 1, out };
  } catch {
    return { exit: 127, out: "" };
  }
}

function defaultDiskFreeMb(dir: string): number | null {
  try {
    const r = spawnSync("df", ["-k", dir], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return null;
    const lines = r.stdout.trim().split("\n");
    const last = lines[lines.length - 1] ?? "";
    const cols = last.trim().split(/\s+/);
    const availKb = Number(cols[3]);
    if (!Number.isFinite(availKb)) return null;
    return Math.floor(availKb / 1024);
  } catch {
    return null;
  }
}

function resolveProbes(
  projectDir: string,
  probes?: DoctorProbes,
): ResolvedProbes {
  return {
    exec: probes?.exec ?? defaultExec,
    exists: probes?.exists ?? existsSync,
    readFile: probes?.readFile ?? ((p) => readFileSync(p, "utf8")),
    env: probes?.env ?? process.env,
    diskFreeMb: probes?.diskFreeMb ?? (() => defaultDiskFreeMb(projectDir)),
  };
}

const YML_NAME = join(".omp", "roadmap.yml");

function ymlPath(projectDir: string): string {
  return join(projectDir, YML_NAME);
}

function roadmapPath(projectDir: string): string {
  return join(projectDir, "ROADMAP.md");
}

/** Read a file through probes; null when absent/unreadable. */
function tryRead(p: ResolvedProbes, path: string): string | null {
  try {
    if (!p.exists(path)) return null;
  } catch {
    // A throwing exists() tells us nothing — fall through to the read.
  }
  try {
    return p.readFile(path);
  } catch {
    return null;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstLine(out: string): string {
  return out.split("\n")[0]?.trim() ?? "";
}

/** Tolerant yml load: parse errors yield an empty config + message. */
function loadYmlTolerant(
  projectDir: string,
  p: ResolvedProbes,
): { cfg: RoadmapConfig; present: boolean; error?: string } {
  const text = tryRead(p, ymlPath(projectDir));
  if (text === null) return { cfg: {}, present: false };
  try {
    return { cfg: parseRoadmapYml(text), present: true };
  } catch (e) {
    return { cfg: {}, present: true, error: errText(e) };
  }
}

function checkOmp(p: ResolvedProbes): DoctorCheck {
  const r = p.exec("omp", ["--version"]);
  if (r.exit !== 0) {
    return {
      name: "omp",
      ok: false,
      detail: firstLine(r.out) || "omp not found",
      fix: "install omp and ensure it is on PATH",
    };
  }
  return { name: "omp", ok: true, detail: firstLine(r.out) || "ok" };
}

function checkModels(
  p: ResolvedProbes,
  cfg: RoadmapConfig,
): DoctorCheck {
  const models = [
    ...(cfg.workerModel ? [cfg.workerModel] : []),
    ...(cfg.reviewModel && cfg.reviewModel !== cfg.workerModel
      ? [cfg.reviewModel]
      : []),
    ...(cfg.modelFallbacks ?? []),
  ].filter((m, i, all) => m.trim() !== "" && all.indexOf(m) === i);
  if (models.length === 0) {
    return {
      name: "models",
      ok: true,
      detail: "no model overrides (omp default)",
    };
  }
  // Reachability probe: `omp --model <M> --help` exits 0 when omp accepts
  // the model id (auth/network reachable); anything else marks it suspect.
  const reachable: string[] = [];
  const unreachable: string[] = [];
  for (const m of models) {
    const r = p.exec("omp", ["--model", m, "--help"]);
    if (r.exit === 0) reachable.push(m);
    else unreachable.push(m);
  }
  if (unreachable.length === 0) {
    return {
      name: "models",
      ok: true,
      detail: `reachable: ${reachable.join(", ")}`,
    };
  }
  const parts = [
    ...(reachable.length ? [`reachable: ${reachable.join(", ")}`] : []),
    `unreachable: ${unreachable.join(", ")}`,
  ];
  return {
    name: "models",
    ok: false,
    detail: parts.join("; "),
    fix: `model "${unreachable[0]}" unreachable — check the model id, omp auth, or network`,
  };
}

function checkTmux(p: ResolvedProbes): DoctorCheck {
  const r = p.exec("tmux", ["-V"]);
  if (r.exit !== 0) {
    return {
      name: "tmux",
      ok: false,
      detail: "absent",
      fix: "install tmux for ompo run --tmux",
    };
  }
  return { name: "tmux", ok: true, detail: firstLine(r.out) || "ok" };
}

function checkGit(p: ResolvedProbes, projectDir: string): DoctorCheck {
  const top = p.exec("git", ["-C", projectDir, "rev-parse", "--show-toplevel"]);
  if (top.exit !== 0) {
    return {
      name: "git",
      ok: false,
      detail: firstLine(top.out) || "not a git repo",
      fix: "git init (or run inside a git repo)",
    };
  }
  const wt = p.exec("git", ["-C", projectDir, "worktree", "list"]);
  if (wt.exit !== 0) {
    return {
      name: "git",
      ok: false,
      detail: firstLine(wt.out) || "git worktree list failed",
      fix: "upgrade git to a version with worktree support",
    };
  }
  const branch = p.exec("git", [
    "-C",
    projectDir,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const topLevel = firstLine(top.out);
  const detail =
    branch.exit === 0 && firstLine(branch.out)
      ? `${firstLine(branch.out)} @ ${topLevel}`
      : topLevel;
  return { name: "git", ok: true, detail };
}

function checkTree(p: ResolvedProbes, projectDir: string): DoctorCheck {
  const r = p.exec("git", ["-C", projectDir, "status", "--porcelain"]);
  if (r.exit !== 0) {
    return {
      name: "tree",
      ok: false,
      detail: firstLine(r.out) || "git status failed",
      fix: "commit or stash before ompo run",
    };
  }
  const dirty = r.out.split("\n").filter((l) => l.trim() !== "");
  if (dirty.length === 0) return { name: "tree", ok: true, detail: "clean" };
  return {
    name: "tree",
    ok: false,
    detail: `${dirty.length} dirty file(s)`,
    fix: "commit or stash before ompo run",
  };
}

/** Env vars a gate command needs but the env lacks. */
function missingVarsFor(
  cmd: string,
  env: Record<string, string | undefined>,
): string[] {
  const missing: string[] = [];
  if (
    (cmd.includes("localhost:PORT") || /localhost:\$[{]?PORT\b/.test(cmd)) &&
    !env["PORT"]
  ) {
    missing.push("PORT");
  }
  if (/DATABASE_URL/.test(cmd) && !env["DATABASE_URL"]) {
    missing.push("DATABASE_URL");
  }
  return missing;
}

function checkGates(
  p: ResolvedProbes,
  projectDir: string,
  cfg: RoadmapConfig,
): DoctorCheck {
  const text = tryRead(p, roadmapPath(projectDir));
  if (text === null) {
    return {
      name: "gates",
      ok: false,
      detail: "missing ROADMAP.md",
      fix: "create ROADMAP.md with Verify: gates, or run ompo init",
    };
  }
  let gates: string[];
  try {
    const doc = parseRoadmap(text);
    gates = doc.slices.flatMap((s) => s.verify);
  } catch (e) {
    return {
      name: "gates",
      ok: false,
      detail: errText(e),
      fix: "fix ROADMAP.md parse errors",
    };
  }
  for (const d of cfg.verifyDefaults ?? []) gates.push(...splitGateChain(d));
  if (gates.length === 0) {
    return { name: "gates", ok: true, detail: "no verify gates" };
  }
  const dead: string[] = [];
  for (const g of gates) {
    const missing = missingVarsFor(g, p.env);
    if (missing.length > 0) dead.push(`"${g}" needs $${missing.join(", $")}`);
  }
  if (dead.length > 0) {
    return {
      name: "gates",
      ok: false,
      detail: `dead ref(s): ${dead.join("; ")}`,
      fix: "export the var, then ompo run --check-env",
    };
  }
  return {
    name: "gates",
    ok: true,
    detail: `${gates.length} gate(s), no dead refs`,
  };
}

function checkDisk(p: ResolvedProbes): DoctorCheck {
  const mb = p.diskFreeMb();
  if (mb === null) return { name: "disk", ok: true, detail: "unknown" };
  if (mb < 100) {
    return {
      name: "disk",
      ok: false,
      detail: `${mb} MB free`,
      fix: "free disk space",
    };
  }
  return { name: "disk", ok: true, detail: `${mb} MB free` };
}

function checkConfig(yml: {
  present: boolean;
  error?: string;
}): DoctorCheck {
  if (!yml.present) return { name: "config", ok: true, detail: "defaults" };
  if (yml.error !== undefined) {
    return { name: "config", ok: false, detail: yml.error };
  }
  return { name: "config", ok: true, detail: "ok" };
}

/**
 * Crash-triage check (read-only): the latest run's interrupted slices
 * (running/verifying/aborted after a WSL kill, SIGKILL, or net-drop death).
 * Live runs report ok (in-flight is normal there); a quiescent latest run
 * with interrupted slices fails with the resume fix. Real-fs reads (the
 * probes have no readdir seam) but never throws — the run() wrapper contains
 * errors, and missing dirs simply mean "no runs".
 */
function checkRecovery(projectDir: string): DoctorCheck {
  let runs: string[];
  try {
    runs = listRuns(projectDir);
  } catch {
    return { name: "recovery", ok: true, detail: "no runs" };
  }
  if (runs.length === 0) return { name: "recovery", ok: true, detail: "no runs" };
  const runId = runs[runs.length - 1]!;
  let crashed: string[];
  let withReport = 0;
  try {
    const cursor = loadRun(projectDir, runId);
    const stuck = cursor.doc.slices.filter((s) => crashedInFlight(s.status));
    if (stuck.length === 0) return { name: "recovery", ok: true, detail: `run ${runId}: no interrupted slices` };
    if (lockHeld(projectDir, runId)) {
      return { name: "recovery", ok: true, detail: `run ${runId}: live (${stuck.length} in flight)` };
    }
    crashed = stuck.map((s) => s.id);
    withReport = stuck.filter((s) => existsSync(join(sliceDir(projectDir, runId, s.id), "report.json"))).length;
  } catch {
    return { name: "recovery", ok: true, detail: `run ${runId} unreadable` };
  }
  return {
    name: "recovery",
    ok: false,
    detail:
      `run ${runId}: ${crashed.length} interrupted slice(s) (${crashed.join(", ")})` +
      (withReport > 0 ? ` — ${withReport} with saved reports, resume replays them with no new worker` : ""),
    fix: "`ompo resume` to re-queue (saved reports replay verify+merge+review)",
  };
}

export async function runDoctor(
  projectDir: string,
  probes?: DoctorProbes,
): Promise<DoctorResult> {
  const p = resolveProbes(projectDir, probes);
  const yml = loadYmlTolerant(projectDir, p);
  const checks: DoctorCheck[] = [];
  const run = (fn: () => DoctorCheck, name: string) => {
    try {
      const c = fn();
      checks.push({ ...c, name });
    } catch (e) {
      checks.push({ name, ok: false, detail: errText(e) });
    }
  };
  run(() => checkOmp(p), "omp");
  run(() => checkModels(p, yml.cfg), "models");
  run(() => checkTmux(p), "tmux");
  run(() => checkGit(p, projectDir), "git");
  run(() => checkTree(p, projectDir), "tree");
  run(() => checkGates(p, projectDir, yml.cfg), "gates");
  run(() => checkRecovery(projectDir), "recovery");
  run(() => checkDisk(p), "disk");
  run(() => checkConfig(yml), "config");
  return { checks, ok: checks.every((c) => c.ok) };
}

function fmtValue(v: unknown, fallback = "(default)"): string {
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : fallback;
  return String(v);
}

/**
 * Human-readable dump of the resolved config plus each slice's effective
 * worker model (`slice.workerAgent ?? workerModel ?? (omp default)`).
 * Never throws on missing files — reports defaults instead.
 */
export function explainConfig(
  projectDir: string,
  probes?: Pick<DoctorProbes, "readFile" | "exists">,
): string {
  try {
    const full: ResolvedProbes = resolveProbes(projectDir, probes);
    const yml = loadYmlTolerant(projectDir, full);
    const cfg = yml.cfg;
    const lines: string[] = [];
    lines.push(`ompo config for ${projectDir}:`);
    lines.push(
      `  source: ${yml.present ? ymlPath(projectDir) : "(absent, defaults)"}`,
    );
    if (yml.error !== undefined) lines.push(`  parse error: ${yml.error}`);
    lines.push(`  workerModel: ${fmtValue(cfg.workerModel, "(omp default)")}`);
    lines.push(
      `  reviewModel: ${fmtValue(cfg.reviewModel ?? cfg.workerModel, "(omp default)")}`,
    );
    lines.push(`  maxRetries: ${fmtValue(cfg.maxRetries)}`);
    lines.push(`  specBudget: ${fmtValue(cfg.specBudget)}`);
    lines.push(`  workerTimeoutSec: ${fmtValue(cfg.workerTimeoutSec)}`);
    lines.push(`  debugTimeoutSec: ${fmtValue(cfg.debugTimeoutSec)}`);
    lines.push(`  placeholders: ${fmtValue(cfg.placeholders, "(default true)")}`);
    if (cfg.agentModels && Object.keys(cfg.agentModels).length > 0) {
      lines.push(`  agentModels:`);
      for (const [agent, model] of Object.entries(cfg.agentModels)) {
        lines.push(`    ${agent}: ${model}`);
      }
    } else {
      lines.push(`  agentModels: (none)`);
    }
    lines.push(`  modelFallbacks: ${fmtValue(cfg.modelFallbacks, "(none)")}`);
    if (cfg.verifyDefaults && cfg.verifyDefaults.length > 0) {
      lines.push(`  verifyDefaults:`);
      for (const d of cfg.verifyDefaults) lines.push(`    - ${d}`);
    } else {
      lines.push(`  verifyDefaults: (none)`);
    }

    const text = tryRead(full, roadmapPath(projectDir));
    if (text === null) {
      lines.push(`slices: (no ROADMAP.md)`);
    } else {
      try {
        const doc = parseRoadmap(text);
        lines.push(`slices (${doc.slices.length}):`);
        for (const s of doc.slices) {
          const effective =
            s.workerAgent ?? cfg.workerModel ?? "(omp default)";
          lines.push(`  ${s.id}: ${effective}`);
        }
      } catch (e) {
        lines.push(`slices: (parse error: ${errText(e)})`);
      }
    }
    return lines.join("\n");
  } catch (e) {
    return `ompo config for ${projectDir}: (unavailable: ${errText(e)})`;
  }
}
