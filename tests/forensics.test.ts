import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { createRun, sliceDir, storeApi } from "../src/store.ts";
import {
  diffSliceBranch,
  pruneWorktrees,
  renderShowText,
  showSlice,
  sliceActivity,
  sliceWorktreePath,
  tailSliceLog,
} from "../src/forensics.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-forensics-"));
}

const MD = `## [a] First slice\nbody a\nVerify: bun test a\n## [b] Second slice\nDepends: a\nbody b\nVerify: bun test b\n`;

function fixture(): { dir: string; runId: string } {
  const dir = tmpProject();
  const runId = "20260908-abc12";
  createRun(dir, parseRoadmap(MD), runId);
  storeApi.claimSlice(dir, runId, "a");
  const sdir = sliceDir(dir, runId, "a");
  mkdirSync(sdir, { recursive: true });
  writeFileSync(
    join(sdir, "report.json"),
    JSON.stringify({ sliceId: "a", summary: "did the thing", done: true }) + "\n",
    "utf8",
  );
  writeFileSync(
    join(sdir, "verdict.json"),
    JSON.stringify({
      sliceId: "a",
      attempt: 1,
      pass: true,
      steps: [{ name: "gate", command: "bun test a", exit: 0, timedOut: false }],
      at: new Date().toISOString(),
    }) + "\n",
    "utf8",
  );
  writeFileSync(
    join(sdir, "review.json"),
    JSON.stringify({ approved: true, findings: ["nit"], notes: "lgtm" }) + "\n",
    "utf8",
  );
  writeFileSync(join(sdir, "prompt-1.md"), "PROMPT:" + "x".repeat(2500), "utf8");
  writeFileSync(
    join(sdir, "worker-1.models.json"),
    JSON.stringify({ tried: ["task"], accepted: "task" }) + "\n",
    "utf8",
  );
  const logLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(sdir, "worker-1.log"), logLines.join("\n") + "\n", "utf8");
  return { dir, runId };
}

describe("forensics", () => {
  test("showSlice throws on unknown slice", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r1");
    expect(() => showSlice(dir, "r1", "nope")).toThrow('unknown slice "nope"');
    expect(() => showSlice(dir, "missing-run", "a")).toThrow('unknown slice "a"');
  });

  test("showSlice loads report/verdict/review/modelChain/promptTail", () => {
    const { dir, runId } = fixture();
    storeApi.workerFinished(dir, runId, "a", "slices/a/report.json", {
      durationMs: 1234,
      stats: { turns: 7, tools: 9 },
    });
    const s = showSlice(dir, runId, "a");
    expect(s.sliceId).toBe("a");
    expect(s.title).toBe("First slice");
    expect(s.status).toBe("verifying");
    expect(s.attempts).toBe(1);
    expect(s.deps).toEqual([]);
    expect(s.verify).toEqual(["bun test a"]);
    expect((s.report as { summary: string }).summary).toBe("did the thing");
    expect((s.verdict as { pass: boolean }).pass).toBe(true);
    expect((s.review as { approved: boolean }).approved).toBe(true);
    expect((s.modelChain as { accepted: string }).accepted).toBe("task");
    expect(s.promptTail).toBeDefined();
    expect(s.promptTail!.length).toBe(2000);
    expect(s.timing.durationMs).toEqual([1234]);
    expect(s.timing.turns).toBe(7);
    expect(s.timing.tools).toBe(9);
  });

  test("showSlice tolerates missing artifacts", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r1");
    const s = showSlice(dir, "r1", "b");
    expect(s.report).toBeUndefined();
    expect(s.verdict).toBeUndefined();
    expect(s.review).toBeUndefined();
    expect(s.promptTail).toBeUndefined();
    expect(s.modelChain).toBeUndefined();
    expect(s.timing.durationMs).toEqual([]);
    expect(s.timing.turns).toBeNull();
  });

  test("renderShowText contains all section headers, never blank", () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r1");
    const text = renderShowText(showSlice(dir, "r1", "b"));
    for (const h of [
      "## Spec",
      "## Report summary",
      "## Verdict gates",
      "## Review",
      "## Model chain",
      "## Timing",
    ]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("# b — Second slice [pending]");
    expect(text).toContain("(none)");
    // No empty section body.
    for (const part of text.split(/^## /m).slice(1)) {
      expect(part.trim().length).toBeGreaterThan(0);
    }
    const full = renderShowText(showSlice(fixture().dir, fixture().runId, "a"));
    expect(full).toContain("did the thing");
  });

  test("diffSliceBranch no-branch note", () => {
    const d = diffSliceBranch("/tmp/x", "r", "a", () => ({ exit: 1, out: "" }));
    expect(d.branch).toBe("ompo/r/a");
    expect(d.base).toBeNull();
    expect(d.note).toBe("in-place run, no branch");
  });

  test("diffSliceBranch truncates at cap with fake exec", () => {
    const big = "z".repeat(25000);
    const exec = (cmd: string, args: string[]) => {
      if (args[0] === "merge-base") return { exit: 0, out: "abc123\n" };
      if (args.includes("--stat")) return { exit: 0, out: "1 file changed\n" };
      return { exit: 0, out: big };
    };
    const d = diffSliceBranch("/tmp/x", "r", "a", exec);
    expect(d.base).toBe("abc123");
    expect(d.stat).toContain("1 file changed");
    expect(d.diff.length).toBe(20000);
    expect(d.note).toBe("truncated");
  });

  test("diffSliceBranch never throws", () => {
    const d = diffSliceBranch("/tmp/x", "r", "a", () => {
      throw new Error("boom");
    });
    expect(d.note).toContain("boom");
  });

  test("pruneWorktrees keeps running slice dir, prunes terminal one", () => {
    const { dir, runId } = fixture();
    storeApi.verifyPassed(dir, runId, "a", "slices/a/verdict.json");
    const wtA = join(dir, ".omp", "roadmap", "worktrees", `${runId}-a`);
    const wtB = join(dir, ".omp", "roadmap", "worktrees", `${runId}-b`);
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    writeFileSync(join(wtA, "sentinel.txt"), "x", "utf8");
    // b is pending (not terminal) → kept; flip b to running to assert the
    // running case explicitly.
    storeApi.claimSlice(dir, runId, "b");
    const removed: string[] = [];
    const res = pruneWorktrees(dir, {
      exec: () => ({ exit: 0, out: "" }),
      removeDir: (p) => {
        removed.push(p);
        rmSync(p, { recursive: true, force: true });
      },
    });
    expect(res.pruned).toEqual([wtA]);
    expect(res.kept).toEqual([wtB]);
    expect(removed).toEqual([wtA]);
  });

  test("pruneWorktrees removes unknown runs, keeps all when runs unknown", () => {
    const { dir, runId } = fixture();
    const wtA = join(dir, ".omp", "roadmap", "worktrees", `${runId}-a`);
    const wtGhost = join(dir, ".omp", "roadmap", "worktrees", "ghost-x");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtGhost, { recursive: true });
    const res = pruneWorktrees(dir, { exec: () => ({ exit: 0, out: "" }) });
    expect(res.pruned).toEqual([wtGhost]);
    expect(res.kept).toEqual([wtA]);

    mkdirSync(wtGhost, { recursive: true });
    const res2 = pruneWorktrees(dir, {
      exec: () => ({ exit: 0, out: "" }),
      listRuns: () => {
        throw new Error("nope");
      },
    });
    expect(res2.pruned).toEqual([]);
    expect(res2.kept.sort()).toEqual([wtA, wtGhost].sort());
  });

  test("sliceWorktreePath returns wt dir when present, project otherwise", () => {
    const { dir, runId } = fixture();
    expect(sliceWorktreePath(dir, runId, "a")).toBe(dir);
    expect(sliceWorktreePath(dir, runId, "a", () => true)).toBe(
      join(dir, ".omp", "roadmap", "worktrees", `${runId}-a`),
    );
  });

  test("tailSliceLog returns last n lines", () => {
    const { dir, runId } = fixture();
    const tail = tailSliceLog(dir, runId, "a", 10);
    expect(tail.length).toBe(10);
    expect(tail[0]).toBe("line 91");
    expect(tail[9]).toBe("line 100");
    expect(tailSliceLog(dir, runId, "b")).toEqual([]);
  });

  test("sliceActivity reports newest stage artifact staleness", () => {
    const { dir, runId } = fixture();
    const live = sliceActivity(dir, runId, "a", 1_800_000_000_000);
    expect(live.name).toMatch(/\.(log|json|md)$/);
    expect(live.logMtimeMs).toBeGreaterThan(0);
    expect(live.staleForMs).toBeGreaterThanOrEqual(0);
    expect(sliceActivity(dir, runId, "b")).toEqual({ name: null, logMtimeMs: null, staleForMs: null });
  });

  test("sliceActivity math is exact with injected io", () => {
    const { dir, runId } = fixture();
    const mtimes: Record<string, number | null> = {
      "worker-1-g0.log": 1000,
      "review-2.log": 5000,
      "notes.txt": 9000,
    };
    const io = {
      listDir: () => Object.keys(mtimes),
      statMtimeMs: (p: string) => mtimes[p.split("/").pop()!] ?? null,
    };
    // Newest stage artifact wins; non-artifacts never count, however new.
    expect(sliceActivity(dir, runId, "a", 65_000, io)).toEqual({
      name: "review-2.log",
      logMtimeMs: 5000,
      staleForMs: 60_000,
    });
    // Clamped, never negative when the clock runs behind the mtime.
    expect(sliceActivity(dir, runId, "a", 500, io).staleForMs).toBe(0);
    const noStat = { listDir: () => ["worker-1-g0.log"], statMtimeMs: () => null };
    expect(sliceActivity(dir, runId, "a", 65_000, noStat)).toEqual({
      name: null,
      logMtimeMs: null,
      staleForMs: null,
    });
  });
});
