import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { createRun, storeApi } from "../src/store.ts";

const MD =
  "## [a] Alpha\nDo A.\nVerify: test \"$SMOKE_VAR\" = yes\nRetries: 0\n\n" +
  "## [b] Beta\nDo B.\nDepends: a\nVerify: true\n";

function tmpProject(roadmap = MD): string {
  const dir = mkdtempSync(join(tmpdir(), "ompo-sprint3-"));
  writeFileSync(join(dir, "ROADMAP.md"), roadmap, "utf8");
  return dir;
}

function cli(dir: string, ...args: string[]): { exit: number; out: string } {
  const r = spawnSync("bun", ["src/cli.ts", ...args, "--project", dir], {
    encoding: "utf8",
  });
  return { exit: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Fresh run with no artifacts (1 run_started event). */
function freshRun(dir: string, runId = "r1"): string {
  createRun(dir, parseRoadmap(readFileSync(join(dir, "ROADMAP.md"), "utf8")), runId);
  return runId;
}

/** Run where slice a is done with a deferred item mentioning SMOKE_VAR. */
function deferredRun(dir: string, runId = "fill-run"): string {
  createRun(dir, parseRoadmap(readFileSync(join(dir, "ROADMAP.md"), "utf8")), runId);
  storeApi.claimSlice(dir, runId, "a");
  const sdir = join(dir, ".omp", "roadmap", "runs", runId, "slices", "a");
  mkdirSync(sdir, { recursive: true });
  writeFileSync(
    join(sdir, "report.json"),
    JSON.stringify({
      sliceId: "a",
      summary: "did it",
      filesChanged: [],
      testsPassed: true,
      followUps: [],
      deferred: ["API key — needs SMOKE_VAR; manual check: hit /health"],
      done: true,
    }),
    "utf8",
  );
  storeApi.workerFinished(dir, runId, "a", "slices/a/report.json");
  storeApi.verifyPassed(dir, runId, "a", "slices/a/verdict.json");
  return runId;
}

describe("sprint3 forensics commands", () => {
  test("show renders inspector sections, unknown slice exits 1", () => {
    const dir = tmpProject();
    freshRun(dir);
    const ok = cli(dir, "show", "a");
    expect(ok.exit).toBe(0);
    expect(ok.out).toContain("# a — Alpha [pending]");
    expect(ok.out).toContain("## Report summary");
    expect(ok.out).toContain("## Verdict gates");
    const bad = cli(dir, "show", "zz");
    expect(bad.exit).toBe(1);
    expect(bad.out).toContain('unknown slice "zz"');
  });

  test("diff falls back to in-place note outside git", () => {
    const dir = tmpProject();
    freshRun(dir);
    const r = cli(dir, "diff", "a");
    expect(r.exit).toBe(0);
    expect(r.out).toContain("in-place run, no branch (ompo/r1/a)");
  });

  test("retry rejects pending, skip applies now on quiescent runs", () => {
    const dir = tmpProject();
    freshRun(dir);
    expect(cli(dir, "retry", "a").exit).toBe(1);
    const skip = cli(dir, "skip", "a", "--reason", "test");
    expect(skip.exit).toBe(0);
    expect(skip.out).toContain("control skip a");
    const status = cli(dir, "status");
    expect(status.out).toContain("[skipped ] a");
  });

  test("worktrees prune is a safe no-op with no worktrees", () => {
    const dir = tmpProject();
    freshRun(dir);
    const r = cli(dir, "worktrees", "prune");
    expect(r.exit).toBe(0);
    expect(r.out).toContain("pruned 0 worktree(s)");
  });
});

describe("sprint3 checklist + fill", () => {
  test("empty checklist reports nothing to fill", () => {
    const dir = tmpProject();
    freshRun(dir);
    const md = cli(dir, "checklist");
    expect(md.exit).toBe(0);
    expect(md.out).toContain("Nothing to fill");
    const js = cli(dir, "checklist", "--json");
    expect(js.exit).toBe(0);
    expect(js.out).toContain("[]");
  });

  test("fill re-runs only the affected slice gates with the given env", () => {
    const dir = tmpProject();
    deferredRun(dir);
    const list = cli(dir, "checklist");
    expect(list.out).toContain("SMOKE_VAR");
    const pass = cli(dir, "fill", "--var", "SMOKE_VAR=yes");
    expect(pass.exit).toBe(0);
    expect(pass.out).toContain("pass: a");
    const fail = cli(dir, "fill", "--var", "SMOKE_VAR=no");
    expect(fail.exit).toBe(1);
    expect(fail.out).toContain("FAIL: a");
    const none = cli(dir, "fill", "--var", "UNRELATED=1");
    expect(none.exit).toBe(0);
    expect(none.out).toContain("nothing re-verified");
  });
});

describe("sprint3 stats / query / export / replay", () => {
  test("stats json totals match the cursor", () => {
    const dir = tmpProject();
    freshRun(dir);
    const r = cli(dir, "stats", "--json");
    expect(r.exit).toBe(0);
    const s = JSON.parse(r.out) as { totals: Record<string, number> };
    expect(s.totals).toEqual({ pending: 2 });
  });

  test("query filters and rejects bad fields", () => {
    const dir = tmpProject();
    freshRun(dir);
    const all = cli(dir, "query", "all");
    expect(all.exit).toBe(0);
    expect(all.out).toContain("run_started");
    const bad = cli(dir, "query", "all where bogus=1");
    expect(bad.exit).toBe(1);
    expect(bad.out).toContain('unknown field "bogus"');
  });

  test("export needs --html; with --out it writes a shareable report", () => {
    const dir = tmpProject();
    freshRun(dir);
    expect(cli(dir, "export").exit).toBe(1);
    const out = join(dir, "report.html");
    const r = cli(dir, "export", "--html", "--out", out);
    expect(r.exit).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("Run r1");
  });

  test("replay is clean on a fresh run", () => {
    const dir = tmpProject();
    freshRun(dir);
    const r = cli(dir, "replay");
    expect(r.exit).toBe(0);
    expect(r.out).toContain("ok: cursor matches event-log replay");
  });
});

describe("sprint3 CI formats + doctor", () => {
  test("log renders tap and rejects unknown formats", () => {
    const dir = tmpProject();
    freshRun(dir);
    const tap = cli(dir, "log", "--format", "tap");
    expect(tap.exit).toBe(0);
    expect(tap.out).toContain("ok 1 run_started");
    expect(cli(dir, "log", "--format", "bogus").exit).toBe(1);
  });

  test("doctor + config report without throwing", () => {
    const dir = tmpProject();
    freshRun(dir);
    const doctor = cli(dir, "doctor");
    expect([0, 1]).toContain(doctor.exit);
    expect(doctor.out).toContain("omp");
    const cfg = cli(dir, "config");
    expect(cfg.exit).toBe(0);
    expect(cfg.out).toContain("workerModel");
  });
});
