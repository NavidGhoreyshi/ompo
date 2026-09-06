import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMPORT_CLOSE,
  IMPORT_OPEN,
  buildImportPrompt,
  extractRoadmapFromOutput,
  runImport,
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
