import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitWorktreeOps, inPlaceWorktreeOps } from "../src/worktree.ts";

function git(dir: string, ...args: string[]): { exit: number; out: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return { exit: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ompo-wt-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.env\n", "utf8");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "stub.txt"), "deps", "utf8");
  writeFileSync(join(dir, ".env"), "SECRET=x\n", "utf8");
  writeFileSync(join(dir, "base.txt"), "base\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}

describe("worktree (git)", () => {
  test("supported only inside a work tree", () => {
    expect(gitWorktreeOps.supported(initRepo())).toBe(true);
    expect(gitWorktreeOps.supported(mkdtempSync(join(tmpdir(), "ompo-plain-")))).toBe(false);
  });

  test("ensure → write → merge lands the file in main", () => {
    const dir = initRepo();
    const wt = gitWorktreeOps.ensure(dir, "r1", "a");
    expect(wt).toBe(join(dir, ".omp", "roadmap", "worktrees", "r1-a"));
    // shared state linked, not copied
    expect(existsSync(join(wt, "node_modules", "stub.txt"))).toBe(true);
    writeFileSync(join(wt, "feat.txt"), "hi\n", "utf8");
    const m = gitWorktreeOps.merge(dir, "r1", "a", 1);
    expect(m.merged).toBe(true);
    expect(readFileSync(join(dir, "feat.txt"), "utf8")).toBe("hi\n");
    // shared links never committed
    expect(git(dir, "ls-files").out.split("\n")).not.toContain("node_modules");
    gitWorktreeOps.remove(dir, "r1", "a");
    expect(existsSync(wt)).toBe(false);
  });

  test("commitWork preserves in-flight work without merging", () => {
    const dir = initRepo();
    const wt = gitWorktreeOps.ensure(dir, "r1", "a");
    writeFileSync(join(wt, "wip.txt"), "half done\n", "utf8");
    const c = gitWorktreeOps.commitWork(dir, "r1", "a", 1, "timeout");
    expect(c.merged).toBe(true);
    expect(c.detail).toContain("ompo/r1/a");
    // committed on the branch, NOT merged into main
    expect(git(dir, "log", "--format=%s", "ompo/r1/a", "-1").out).toContain("timeout");
    expect(existsSync(join(dir, "wip.txt"))).toBe(false);
    // clean tree second time → no-op
    expect(gitWorktreeOps.commitWork(dir, "r1", "a", 1, "timeout").detail).toContain("nothing to commit");
  });

  test("ensure is idempotent (resume/retry reuse)", () => {
    const dir = initRepo();
    const first = gitWorktreeOps.ensure(dir, "r1", "a");
    expect(gitWorktreeOps.ensure(dir, "r1", "a")).toBe(first);
  });

  test("empty branch merges as a no-op", () => {
    const dir = initRepo();
    gitWorktreeOps.ensure(dir, "r1", "a");
    const m = gitWorktreeOps.merge(dir, "r1", "a", 1);
    expect(m.merged).toBe(true);
    expect(m.detail).toContain("no new commits");
  });

  test("conflicting change fails closed, main untouched, worktree kept", () => {
    const dir = initRepo();
    const wt = gitWorktreeOps.ensure(dir, "r1", "a");
    writeFileSync(join(wt, "base.txt"), "slice version\n", "utf8");
    writeFileSync(join(dir, "base.txt"), "main version\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "main moves");
    const m = gitWorktreeOps.merge(dir, "r1", "a", 1);
    expect(m.merged).toBe(false);
    expect(m.detail).toContain("base.txt");
    expect(readFileSync(join(dir, "base.txt"), "utf8")).toBe("main version\n");
    expect(existsSync(wt)).toBe(true); // kept for forensics
  });
});

describe("worktree (in-place fallback)", () => {
  test("non-git projects run in the project dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-plain-"));
    expect(inPlaceWorktreeOps.ensure(dir, "r", "a")).toBe(dir);
    expect(inPlaceWorktreeOps.merge(dir, "r", "a", 1).merged).toBe(true);
    expect(() => inPlaceWorktreeOps.remove(dir, "r", "a")).not.toThrow();
  });
});
