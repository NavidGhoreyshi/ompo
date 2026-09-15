/**
 * Slice worktree isolation (parallel prerequisite #1).
 *
 * Each in-flight slice works on its own `ompo/<runId>/<sliceId>` branch in a
 * dedicated worktree under `.omp/` (gitignored, invisible to the main
 * checkout). The worker runs with cwd = worktree; on verify-pass the branch
 * merges --no-ff back into the main checkout. A slice is `done` only after
 * its merge lands, so dependents always branch off merged state.
 *
 * Non-git projects (and tests) get in-place ops: same interface, no
 * isolation. The loop picks via `supported()`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export interface MergeOutcome {
  merged: boolean;
  detail: string;
  /** True when the worktree held no committable change (not a conflict). */
  nothingToCommit?: boolean;
}

export interface WorktreeOps {
  supported(projectDir: string): boolean;
  /** Create (or reuse on resume/retry) the slice worktree; returns its path. */
  ensure(projectDir: string, runId: string, sliceId: string): string;
  /** Commit slice work (if any) and merge the branch into the main checkout. */
  merge(projectDir: string, runId: string, sliceId: string, attempt: number): MergeOutcome;
  /** Commit in-flight work to the slice branch without merging (timeout/abort preservation). */
  commitWork(projectDir: string, runId: string, sliceId: string, attempt: number, reason: string): MergeOutcome;
  /** Drop the worktree after a successful merge (branch kept for audit). */
  remove(projectDir: string, runId: string, sliceId: string): void;
}

function branchOf(runId: string, sliceId: string): string {
  return `ompo/${runId}/${sliceId}`;
}

/**
 * Branch a slice pipeline commits to (the merge source). Exported for the
 * pre-merge secret scan's branch-delta candidate sweep. Pure.
 */
export function sliceBranchOf(runId: string, sliceId: string): string {
  return branchOf(runId, sliceId);
}

function pathOf(projectDir: string, runId: string, sliceId: string): string {
  return join(projectDir, ".omp", "roadmap", "worktrees", `${runId}-${sliceId}`);
}

function git(projectDir: string, ...args: string[]): { exit: number; out: string } {
  const r = spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
  return { exit: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Heavy/secret local state a fresh worktree lacks; share from the main checkout. */
const SHARED_LINKS = ["node_modules", ".env"];

function linkSharedState(projectDir: string, wt: string): void {
  for (const name of SHARED_LINKS) {
    const src = join(projectDir, name);
    const dst = join(wt, name);
    try {
      if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst);
    } catch {
      /* best-effort: verify will fail loudly if the state is truly needed */
    }
  }
}

export const gitWorktreeOps: WorktreeOps = {
  supported(projectDir: string): boolean {
    return git(projectDir, "rev-parse", "--is-inside-work-tree").exit === 0;
  },

  ensure(projectDir: string, runId: string, sliceId: string): string {
    const wt = pathOf(projectDir, runId, sliceId);
    const branch = branchOf(runId, sliceId);
    mkdirSync(join(projectDir, ".omp", "roadmap", "worktrees"), { recursive: true });
    // Git prints worktree paths with its own separators; on a Windows checkout
    // driven through WSL interop the same dir can read `C:/…` from one git and
    // `C:\…` (or a /mnt/c/… mount alias) from another. Compare normalized, or
    // a registered worktree is invisible and the re-add fails "already exists".
    const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\/mnt\/([a-z])\//, (_, d: string) => `${d.toUpperCase()}:/`);
    const listed = git(projectDir, "worktree", "list", "--porcelain");
    const registered = listed.exit === 0 && listed.out.split("\n").some((l) => l.startsWith("worktree ") && norm(l.slice(9).trim()) === norm(wt));
    if (registered) {
      // A previous attempt that died between `worktree add` and first use can
      // leave a registered-but-contentless worktree behind (observed on
      // Windows: admin gitdir entry exists, checkout dir has only `.git` +
      // ROADMAP.md — `rev-parse` still passes there, so entry count is the
      // probe. Repair once: drop the stale registration and re-add below; a
      // healthy worktree returns early.
      const probe = git(wt, "rev-parse", "--show-toplevel");
      let entries: string[] = [".git", "x"];
      try {
        entries = readdirSync(wt);
      } catch {
        entries = [".git", "x"];
      }
      const content = entries.filter((e) => e !== ".git");
      const contentless = probe.exit === 0 && (content.length === 0 || (content.length === 1 && content[0] === "ROADMAP.md"));
      if (probe.exit !== 0 || contentless) {
        git(projectDir, "worktree", "remove", "--force", wt);
        rmSync(wt, { recursive: true, force: true });
      } else {
        linkSharedState(projectDir, wt);
        return wt; // resume/retry: worktree already registered
      }
    }
    let r = git(projectDir, "worktree", "add", "-b", branch, wt, "HEAD");
    if (r.exit !== 0) {
      // Branch exists (retry/resume after crash): attach to it.
      r = git(projectDir, "worktree", "add", wt, branch);
    }
    if (r.exit !== 0) throw new Error(`git worktree add for "${sliceId}" failed: ${r.out.slice(-2000)}`);
    linkSharedState(projectDir, wt);
    return wt;
  },
  commitWork(projectDir: string, runId: string, sliceId: string, attempt: number, reason: string): MergeOutcome {
    const wt = pathOf(projectDir, runId, sliceId);
    if (git(wt, "status", "--porcelain").out.trim() === "") {
      return { merged: true, detail: "nothing to commit", nothingToCommit: true };
    }
    // Shared state links (node_modules, .env) are committed neither here
    // nor anywhere: git would store the symlink blob itself.
    const exclude = SHARED_LINKS.map((n) => `:!${n}`);
    // NOTE: `git add` exits 1 with an "ignored files" warning when an
    // exclusion matches an ignored path (our own node_modules/.env links).
    // Judge by staged content, not the exit code.
    git(wt, "add", "-A", "--", ...exclude);
    if (git(wt, "diff", "--cached", "--quiet").exit === 0) {
      return { merged: true, detail: `nothing to commit`, nothingToCommit: true };
    }
    const commit = git(
      wt,
      "-c",
      "user.name=ompo",
      "-c",
      "user.email=ompo@local",
      "commit",
      "-m",
      `ompo: ${sliceId} (run ${runId} attempt ${attempt} ${reason})`,
    );
    if (commit.exit !== 0) return { merged: false, detail: `git commit failed: ${commit.out.slice(-1000)}` };
    return { merged: true, detail: `committed ${branchOf(runId, sliceId)} (${reason})` };
  },

  merge(projectDir: string, runId: string, sliceId: string, attempt: number): MergeOutcome {
    const branch = branchOf(runId, sliceId);
    const c = gitWorktreeOps.commitWork(projectDir, runId, sliceId, attempt, "done");
    if (!c.merged) return c;
    // Nothing new on the branch (worker changed no files): already merged.
    if (git(projectDir, "merge-base", "--is-ancestor", branch, "HEAD").exit === 0) {
      return { merged: true, detail: `merged ${branch} (no new commits)` };
    }
    const m = git(projectDir, "merge", "--no-ff", "--no-commit", branch);
    if (m.exit !== 0) {
      // Read unmerged paths BEFORE --abort clears them.
      const files = git(projectDir, "diff", "--name-only", "--diff-filter=U").out.trim();
      git(projectDir, "merge", "--abort");
      return {
        merged: false,
        detail: `merge conflict merging ${branch} (files: ${files || "see output"}): ${m.out.slice(-2000)}`,
      };
    }
    const commit = git(
      projectDir,
      "-c",
      "user.name=ompo",
      "-c",
      "user.email=ompo@local",
      "commit",
      "--no-edit",
    );
    if (commit.exit !== 0) {
      git(projectDir, "merge", "--abort");
      return { merged: false, detail: `merge commit failed: ${commit.out.slice(-1000)}` };
    }
    return { merged: true, detail: `merged ${branch}` };
  },

  remove(projectDir: string, runId: string, sliceId: string): void {
    const wt = pathOf(projectDir, runId, sliceId);
    const r = git(projectDir, "worktree", "remove", "--force", wt);
    if (r.exit !== 0) throw new Error(`git worktree remove for "${sliceId}" failed: ${r.out.slice(-1000)}`);
  },
};

/** Non-git fallback: everything runs in-place in the project dir. */
export const inPlaceWorktreeOps: WorktreeOps = {
  supported(_projectDir: string): boolean {
    return true;
  },
  ensure(projectDir: string, _runId: string, _sliceId: string): string {
    return projectDir;
  },
  merge(_projectDir: string, _runId: string, _sliceId: string, _attempt: number): MergeOutcome {
    return { merged: true, detail: "in-place (non-git project, nothing to merge)" };
  },
  commitWork(): MergeOutcome {
    return { merged: true, detail: "in-place (non-git project, nothing to commit)", nothingToCommit: true };
  },
  remove(_projectDir: string, _runId: string, _sliceId: string): void {},
};

export function worktreeOpsFor(projectDir: string): WorktreeOps {
  return gitWorktreeOps.supported(projectDir) ? gitWorktreeOps : inPlaceWorktreeOps;
}
