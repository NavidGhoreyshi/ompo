/**
 * End-of-run unblock lane (self-sufficient loop).
 *
 * When the loop is about to stop with pre-deployment slices still blocked
 * (`blocked-env`, or terminal `failed`), it spawns one bounded fresh agent
 * session to unblock the run instead of exiting for the operator — the same
 * diagnose → fix → verify job an operator would do on `ompo resume`.
 *
 * Trust-but-verify: the agent's done=true claim means nothing until the loop
 * re-runs each target's recorded failing command in its worktree itself.
 * Only recheck-green targets demote (via operatorRetry, so failed slices get
 * exactly one extra attempt with attempts still counting). Deploy slices are
 * never targets: they wait for real values and a human.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./store.ts";
import { isDeploySlice } from "./placeholders.ts";
import { reportBlockSkeleton } from "./report.ts";
import type { RoadmapDoc, Slice, Verdict } from "./types.ts";
/** Statuses that block the run when everything else is settled. */
export function stallTargets(doc: RoadmapDoc): Slice[] {
  return doc.slices.filter(
    (s) =>
      (s.status === "blocked-env" || s.status === "failed") &&
      !isDeploySlice(s.id, s.title),
  );
}

/** True when the run still owns pre-deployment work (unblock is worthwhile). */
export function hasPredeployWork(doc: RoadmapDoc): boolean {
  return doc.slices.some(
    (s) =>
      (s.status === "pending" || s.status === "blocked-env" || s.status === "failed") &&
      !isDeploySlice(s.id, s.title),
  );
}

export interface UnblockTarget {
  sliceId: string;
  title: string;
  status: string;
  /** Triage reason or terminal class (best-effort, may be empty). */
  reason: string;
  /** First failing gate command from the recorded verdict, if parseable. */
  failingCommand?: string;
  /** Clipped tail of the failing step (for the prompt). */
  failingTail: string;
  /** Slice worktree the agent must work in. */
  worktree: string;
}

function readVerdict(projectDir: string, runId: string, s: Slice): Verdict | null {
  try {
    if (!s.verdictRef) return null;
    const raw = readFileSync(join(projectDir, RUNS_DIR, runId, s.verdictRef), "utf8");
    const v = JSON.parse(raw) as Verdict;
    if (!Array.isArray((v as Verdict).steps)) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Enrich stall targets with verdict evidence + worktree paths.
 * `worktreeOf` resolves the slice's kept worktree (idempotent ensure).
 */
export function collectUnblockInfo(
  projectDir: string,
  runId: string,
  doc: RoadmapDoc,
  worktreeOf: (sliceId: string) => string,
): UnblockTarget[] {
  const out: UnblockTarget[] = [];
  for (const s of stallTargets(doc)) {
    let wtPath = "";
    try {
      wtPath = worktreeOf(s.id);
    } catch {
      wtPath = "";
    }
    const verdict = readVerdict(projectDir, runId, s);
    const failedStep = verdict?.steps.find((st) => st.exit !== 0);
    // Terminal-failed slices without a gate verdict (bad report, merge
    // conflict) carry their reason in the event log, not verdict.json —
    // the agent diagnoses from the worktree + slice body instead.
    let reason = "";
    try {
      const tail = failedStep?.outputTail?.trim() ?? "";
      const firstLine = tail.split("\n").find((l) => l.trim()) ?? "";
      reason = firstLine.slice(0, 200);
    } catch {
      reason = "";
    }
    out.push({
      sliceId: s.id,
      title: s.title,
      status: s.status,
      reason,
      failingCommand: failedStep?.command,
      failingTail: (failedStep?.outputTail ?? "").trim().slice(-3000),
      worktree: wtPath,
    });
  }
  return out;
}

/**
 * Compile the unblock session prompt: host-env + worktree-code diagnosis.
 * The agent fixes whatever blocks the run and proves it by re-running the
 * blocking commands green in a fresh shell itself. The loop re-verifies
 * before demoting anything — the report is advisory.
 */
export function buildUnblockPrompt(targets: UnblockTarget[], round: number, maxRounds: number): string {
  const head = targets[0]!;
  const lines = [
    `# Unblock session (round ${round}/${maxRounds}): the roadmap run stalled with ${targets.length} blocked slice(s) and no runnable work. Unblock it.`,
    ``,
    `You are the run unblocker: diagnose whatever blocks these slices (dead service, missing system dependency, broken gate plumbing, or slice code a previous session could not fix) and fix it. This is an operator-grade session — the run resumes when you genuinely unblock it.`,
    ``,
    `## Blocked slices`,
  ];
  for (const t of targets) {
    lines.push(
      ``,
      `### ${t.sliceId} — ${t.title} (status ${t.status})`,
      t.reason ? `Block evidence: ${t.reason}` : `Block evidence: (see worktree + verdict below)`,
      t.worktree ? `Worktree: ${t.worktree}` : `Worktree: (unavailable — work from the base checkout)`,
      t.failingCommand ? `Failing gate: $ ${t.failingCommand}` : `Failing gate: (no recorded gate command)`,
      t.failingTail ? `Output tail:\n${t.failingTail.slice(-1500)}` : ``,
    );
  }
  lines.push(
    ``,
    `## Contract (STRICT)`,
    `1. Reproduce: re-run each failing gate command yourself, in the slice worktree when one is listed, in a FRESH shell (no exports from your current shell carry over — the orchestrator re-runs the same commands in its own environment before resuming).`,
    `2. Fix ONLY what blocks the run. Prefer persistent host fixes (start the service via the project's compose/Docker setup, create the missing DB/role, install the missing system tool, free the squatted port). Shell exports and other session-local state do NOT count as fixed.`,
    `3. Do NOT touch .omp/** (run bookkeeping belongs to the orchestrator), do NOT write to the base branch (slice work goes in the worktree; the run merges it), do NOT force-push, do NOT delete data volumes or drop databases to "make red green".`,
    `4. Re-run every failing gate command until each passes in a fresh shell.`,
    `5. When finished, print EXACTLY one report block (sliceId must equal "${head.sliceId}"):`,
    ``,
    `${reportBlockSkeleton(head.sliceId)}`,
    ``,
    `Rules: done=true only when every listed failing command now passes by your own fresh-shell run. done=false with the cause in verificationNotes when the block needs a human (deploy values, external approvals, destructive recovery). filesChanged lists repo-relative paths you touched.`,
  );
  return lines.join("\n");
}

/** Run-relative ref of the round's prompt artifact (for log lines). */
export function unblockPromptRef(runId: string, round: number): string {
  return join(RUNS_DIR, runId, `unblock-${round}.prompt.md`);
}

function exec(cmd: string, cwd: string, timeoutMs: number, env?: Record<string, string>): Promise<{ exit: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
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

/**
 * Deterministic recheck: re-run each target's recorded failing command in
 * its worktree. Returns the ids that are green now. Targets without a
 * recorded command or worktree are never green (agent claim unverifiable).
 * Never throws; failures are just not-green.
 */
export async function recheckUnblockTargets(opts: {
  projectDir: string;
  targets: UnblockTarget[];
  env?: Record<string, string>;
  timeoutMs?: number;
  onEvent?: (msg: string) => void;
}): Promise<string[]> {
  const green: string[] = [];
  for (const t of opts.targets) {
    if (!t.failingCommand || !t.worktree || !existsSync(t.worktree)) continue;
    try {
      const r = await exec(t.failingCommand, t.worktree, opts.timeoutMs ?? 5 * 60 * 1000, opts.env);
      if (r.exit === 0) {
        green.push(t.sliceId);
        opts.onEvent?.(`  unblock recheck ${t.sliceId}: green`);
      } else {
        opts.onEvent?.(`  unblock recheck ${t.sliceId}: still red (exit=${r.exit})`);
      }
    } catch {
      opts.onEvent?.(`  unblock recheck ${t.sliceId}: still red (spawn error)`);
    }
  }
  return green;
}
