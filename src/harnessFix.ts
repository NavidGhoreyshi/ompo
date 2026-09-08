/**
 * Harness-fix applier (HARP-1 rail terminal — Sprint 4).
 *
 * Verbatim extraction from `loop.ts`: no behavior change. Rail validation
 * lives in `debug.ts:validateHarnessFix`; this module only applies an
 * already-validated fix to the slice worktree (never the base checkout —
 * the slice's own merge lands it on base HEAD) and enumerates the base
 * checkout's tracked files for the rail.
 */

import { spawnSync } from "node:child_process";
import type { HarnessFix } from "./report.ts";

/** Repo-relative tracked paths at the base checkout's HEAD (harness-fix rail). */
export function headFileSet(projectDir: string): Set<string> {
  const r = spawnSync("git", ["-C", projectDir, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" });
  return new Set((r.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
}

/**
 * Apply a rail-validated harness fix (HARP-1). The diff goes into the slice
 * worktree — the gate's cwd — via `git apply --3way`, then the patched paths
 * are staged. Deliberately NOT applied to the base checkout here: a base-side
 * edit would be overwritten-and-refused by the worktree branch's own merge
 * minutes later (git merge aborts on local changes to files it updates), and
 * the sanctioned commit path is exactly that merge — commitWork includes
 * harness files, so the fix lands on base HEAD when the slice merges. Throws
 * on any failure (base dirt on the patched paths, apply/add errors).
 */
export function applyHarnessFix(projectDir: string, wtPath: string, hf: HarnessFix): void {
  // Rail: never clobber real uncommitted work in the base checkout on the
  // patched paths (a later merge of these same files would refuse anyway).
  const status = spawnSync(
    "git",
    ["-C", projectDir, "status", "--porcelain", "--", ...hf.filesPatched],
    { encoding: "utf8" },
  );
  if (status.status !== 0) {
    throw new Error(`cannot check base checkout status (git exit ${status.status})`);
  }
  const dirty = (status.stdout ?? "").trim();
  if (dirty) {
    throw new Error(`base checkout has uncommitted changes to patched files — refusing: ${dirty.split("\n").join("; ")}`);
  }
  // The debugger verifies its fix by editing the file in the worktree, so the
  // patched paths may already carry that exact change. Reset them to HEAD so
  // the emitted diff applies cleanly (filesPatched are never slice-owned, so
  // this discards only the debugger's own harness edit, never slice work).
  const reset = spawnSync("git", ["-C", wtPath, "checkout", "--", ...hf.filesPatched], { encoding: "utf8" });
  if (reset.status !== 0) {
    throw new Error(`git checkout failed in worktree: ${`${reset.stderr ?? ""}${reset.stdout ?? ""}`.trim().slice(-2000)}`);
  }
  const applied = spawnSync("git", ["-C", wtPath, "apply", "--3way", "--"], {
    input: hf.diff,
    encoding: "utf8",
  });
  if (applied.status !== 0) {
    throw new Error(`git apply failed in worktree: ${`${applied.stderr ?? ""}${applied.stdout ?? ""}`.trim().slice(-2000)}`);
  }
  const add = spawnSync("git", ["-C", wtPath, "add", "-A", "--", ...hf.filesPatched], { encoding: "utf8" });
  if (add.status !== 0) {
    throw new Error(`git add failed in worktree: ${`${add.stderr ?? ""}${add.stdout ?? ""}`.trim().slice(-2000)}`);
  }
}
