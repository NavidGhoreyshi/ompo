import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMPORT_CLOSE,
  IMPORT_OPEN,
  buildImportPrompt,
  buildInitPrompt,
  collectDocCandidates,
  extractRoadmapFromOutput,
  resolveInitPlan,
  runImport,
  runInitPlanner,
} from "../src/import.ts";
import type { WorkerRunner } from "../src/worker.ts";

const CONVERTED = `## [s0-baseline] Baseline
Done — see qa/s0/report.md.
Skip: true

## [s1-identity] Identity remainder
Resume point: Dockerfile still missing.
Depends: s0-baseline
Verify: npm run build
Retries: 1

## [s2-company] Company shell
Onboarding wizard.
Depends: s1-identity
Verify: npm run test
Retries: 1
`;

function okRunner(stdout: string): WorkerRunner {
  return async () => ({ exit: 0, timedOut: false, stdout, stderr: "", durationMs: 1 });
}

describe("import", () => {
  test("extract: marker block wins", () => {
    const out = `some chatter\n${IMPORT_OPEN}\n${CONVERTED}\n${IMPORT_CLOSE}\ntrailing`;
    expect(extractRoadmapFromOutput(out)).toBe(CONVERTED.trim());
  });

  test("extract: fenced markdown fallback", () => {
    const out = "here:\n```markdown\n" + CONVERTED + "```\ndone";
    expect(extractRoadmapFromOutput(out)).toBe(CONVERTED.trim());
  });

  test("extract: last complete block wins", () => {
    const first = CONVERTED.replace("s2-company", "s2-stale");
    const out = `${IMPORT_OPEN}\n${first}\n${IMPORT_CLOSE}\ncorrected:\n${IMPORT_OPEN}\n${CONVERTED}\n${IMPORT_CLOSE}`;
    expect(extractRoadmapFromOutput(out)).toBe(CONVERTED.trim());
  });

  test("extract: no roadmap → undefined", () => {
    expect(extractRoadmapFromOutput("just prose, no slices")).toBeUndefined();
  });

  test("prompt: format-agnostic, no heading assumption, carries hints", () => {
    const p = buildImportPrompt("/x/ROADMAP-GENERAL.md", { done: ["S0"], active: ["S1"] });
    expect(p).toContain("/x/ROADMAP-GENERAL.md");
    expect(p).toContain("UNKNOWN template");
    expect(p).toContain("S0");
    expect(p).toContain("S1");
    expect(p).toContain("Skip: true");
    expect(p).toContain("never assume");
  });

  test("runImport: worker output → written ROADMAP.md, parsed slices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-import-"));
    const from = join(dir, "FOREIGN.md");
    writeFileSync(from, "# whatever\n\nStep 1: stuff\nStep 2: more\n", "utf8");
    const out = `${IMPORT_OPEN}\n${CONVERTED}\n${IMPORT_CLOSE}`;
    const res = await runImport({
      projectDir: dir,
      fromPath: from,
      roadmapPath: join(dir, "ROADMAP.md"),
      runner: okRunner(out),
      onEvent: () => {},
    });
    expect(res.slices).toEqual(["s0-baseline", "s1-identity", "s2-company"]);
    expect(readFileSync(join(dir, "ROADMAP.md"), "utf8")).toContain("## [s1-identity]");
  });

  test("runImport: missing block → throws, writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-import-"));
    const from = join(dir, "FOREIGN.md");
    writeFileSync(from, "anything", "utf8");
    let err = "";
    try {
      await runImport({
        projectDir: dir,
        fromPath: from,
        roadmapPath: join(dir, "ROADMAP.md"),
        runner: okRunner("no block here"),
        onEvent: () => {},
      });
    } catch (e) {
      err = String(e);
    }
    expect(err).toContain("no roadmap block");
  });

  test("runImport: unparsable output → parse error, writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-import-"));
    const from = join(dir, "FOREIGN.md");
    writeFileSync(from, "anything", "utf8");
    const bad = `${IMPORT_OPEN}\n## [a] A\nNo verify here but parses\n${IMPORT_CLOSE}`;
    const res = await runImport({
      projectDir: dir,
      fromPath: from,
      roadmapPath: join(dir, "ROADMAP.md"),
      runner: okRunner(bad),
      onEvent: () => {},
    });
    expect(res.slices).toEqual(["a"]);
  });

  test("runImport: worker failure → throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-import-"));
    const from = join(dir, "FOREIGN.md");
    writeFileSync(from, "anything", "utf8");
    const failing: WorkerRunner = async () => ({
      exit: 1,
      timedOut: false,
      stdout: "",
      stderr: "boom",
      durationMs: 1,
    });
    let err = "";
    try {
      await runImport({
        projectDir: dir,
        fromPath: from,
        roadmapPath: join(dir, "ROADMAP.md"),
        runner: failing,
        onEvent: () => {},
      });
    } catch (e) {
      err = String(e);
    }
    expect(err).toContain("import worker failed");
  });

  test("runImport: unreadable source → throws before spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-import-"));
    let called = false;
    const spy: WorkerRunner = async () => {
      called = true;
      return { exit: 0, timedOut: false, stdout: "", stderr: "", durationMs: 1 };
    };
    let err = "";
    try {
      await runImport({
        projectDir: dir,
        fromPath: join(dir, "MISSING.md"),
        roadmapPath: join(dir, "ROADMAP.md"),
        runner: spy,
        onEvent: () => {},
      });
    } catch (e) {
      err = String(e);
    }
    expect(err).not.toBe("");
    expect(called).toBe(false);
  });
});

describe("init planner", () => {
  test("collectDocCandidates: newest first, skips dep dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-init-"));
    const oldMd = join(dir, "OLD.md");
    writeFileSync(oldMd, "# old", "utf8");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "IGNORED.md"), "# dep", "utf8");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const planMd = join(dir, "docs", "PLAN.md");
    writeFileSync(planMd, "# plan", "utf8");
    utimesSync(oldMd, new Date(1000), new Date(1000));
    utimesSync(planMd, new Date(2000), new Date(2000));
    const cands = collectDocCandidates(dir);
    expect(cands.map((c) => c.path)).toEqual(["docs/PLAN.md", "OLD.md"]);
    expect(cands[0]!.mtimeMs).toBeGreaterThan(cands[1]!.mtimeMs);
  });

  test("buildInitPrompt: candidates newest-first, strict marker contract", () => {
    const p = buildInitPrompt([
      { path: "PLAN.md", mtimeMs: Date.parse("2026-09-01T00:00:00Z") },
      { path: "OLD.md", mtimeMs: Date.parse("2026-01-01T00:00:00Z") },
    ]);
    expect(p.indexOf("PLAN.md")).toBeLessThan(p.indexOf("OLD.md"));
    expect(p).toContain(IMPORT_OPEN);
    expect(p).toContain(IMPORT_CLOSE);
    expect(p).toContain("## [slice-id]");
    expect(p).toContain("ROADMAP.md");
  });

  test("runInitPlanner: worker output → written ROADMAP.md, parsed slices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-init-"));
    writeFileSync(join(dir, "PLAN.md"), "# plan", "utf8");
    const events: string[] = [];
    const res = await runInitPlanner({
      projectDir: dir,
      runner: okRunner(`${IMPORT_OPEN}\n${CONVERTED}\n${IMPORT_CLOSE}`),
      onEvent: (m) => events.push(m),
    });
    expect(res.slices).toEqual(["s0-baseline", "s1-identity", "s2-company"]);
    expect(readFileSync(join(dir, "ROADMAP.md"), "utf8")).toContain("## [s1-identity]");
    expect(events.some((m) => m.includes("init OK"))).toBe(true);
  });

  test("runInitPlanner: no block → throws, writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-init-"));
    await expect(runInitPlanner({ projectDir: dir, runner: okRunner("prose only") })).rejects.toThrow();
    expect(existsSync(join(dir, "ROADMAP.md"))).toBe(false);
  });
});

describe("resolveInitPlan", () => {
  const BLANK = "# blank\n";
  test("keeps edited roadmaps unless --replan", () => {
    expect(resolveInitPlan({ existing: "# real work\n", blankTemplate: BLANK })).toBe("keep");
    expect(resolveInitPlan({ existing: "# real work\n", replan: true, blankTemplate: BLANK })).toBe("plan");
  });
  test("plans over missing or pristine template", () => {
    expect(resolveInitPlan({ existing: null, blankTemplate: BLANK })).toBe("plan");
    expect(resolveInitPlan({ existing: "  # blank\n  ", blankTemplate: BLANK })).toBe("plan");
  });
  test("--template wins only with --replan or no real work", () => {
    expect(resolveInitPlan({ existing: null, template: true, blankTemplate: BLANK })).toBe("template");
    expect(resolveInitPlan({ existing: "# real\n", template: true, blankTemplate: BLANK })).toBe("keep");
    expect(resolveInitPlan({ existing: "# real\n", template: true, replan: true, blankTemplate: BLANK })).toBe(
      "template",
    );
  });
});

describe("roadmap target file", () => {
  test("prompts default to ROADMAP.md, honor custom targets", () => {
    expect(buildImportPrompt("/x/f.md", {})).toContain("`ROADMAP.md`");
    expect(buildImportPrompt("/x/f.md", {}, "ompo/docs/ROADMAP.md")).toContain("`ompo/docs/ROADMAP.md`");
    expect(buildInitPrompt([])).toContain("`ROADMAP.md`");
    expect(buildInitPrompt([], "ompo/docs/ROADMAP.md")).toContain("`ompo/docs/ROADMAP.md`");
  });

  test("runInitPlanner writes a custom roadmap path (dirs created)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-init-"));
    const target = join(dir, "ompo", "docs", "ROADMAP.md");
    const res = await runInitPlanner({
      projectDir: dir,
      roadmapPath: target,
      runner: okRunner(`${IMPORT_OPEN}\n${CONVERTED}\n${IMPORT_CLOSE}`),
    });
    expect(res.roadmapPath).toBe(target);
    expect(readFileSync(target, "utf8")).toContain("## [s0-baseline]");
  });
});

describe("init planner hardening", () => {
  test("buildInitPrompt forbids Depends:none", () => {
    expect(buildInitPrompt([])).toContain("Depends: none");
  });

  test("runInitPlanner: parse failure retries once with the error quoted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-init-"));
    let calls = 0;
    const runner: WorkerRunner = async (call) => {
      calls++;
      if (calls === 1) {
        return {
          exit: 0,
          timedOut: false,
          stdout: `${IMPORT_OPEN}\n## [s0-baseline] Base\nDepends: none\nVerify: true\n${IMPORT_CLOSE}`,
          stderr: "",
          durationMs: 1,
        };
      }
      expect(call.prompt).toContain("Fix requested");
      expect(call.prompt).toContain("unknown dependency");
      return { exit: 0, timedOut: false, stdout: `${IMPORT_OPEN}\n${CONVERTED}\n${IMPORT_CLOSE}`, stderr: "", durationMs: 1 };
    };
    const res = await runInitPlanner({ projectDir: dir, runner });
    expect(calls).toBe(2);
    expect(res.slices).toEqual(["s0-baseline", "s1-identity", "s2-company"]);
  });
});
