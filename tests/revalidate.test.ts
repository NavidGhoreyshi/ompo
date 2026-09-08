import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPORT_CLOSE, IMPORT_OPEN } from "../src/import.ts";
import { parseRoadmap } from "../src/parse.ts";
import { buildRevalidatePrompt, runRevalidate } from "../src/revalidate.ts";
import { createRun } from "../src/store.ts";
import type { WorkerRunner } from "../src/worker.ts";

const CURRENT = `## [a] First slice
Do the first thing thoroughly and completely.
Verify: echo hi

## [b] Second slice
Do the second thing thoroughly and completely.
Depends: a
Verify: echo hi
`;

const PROPOSAL = `## [a] First slice
Done — see qa/a/report.md.
Skip: true

## [b] Second slice remainder
Resume point: remaining half only.
Depends: a
Verify: echo hi
`;

function okRunner(stdout: string): WorkerRunner {
  return async () => ({ exit: 0, timedOut: false, stdout, stderr: "", durationMs: 1 });
}

function projectWithRun(): string {
  const dir = mkdtempSync(join(tmpdir(), "ompo-revalidate-"));
  writeFileSync(join(dir, "ROADMAP.md"), CURRENT, "utf8");
  createRun(dir, parseRoadmap(CURRENT), "r1");
  return dir;
}

describe("revalidate", () => {
  test("prompt audits evidence with stable ids and no writes", () => {
    const p = buildRevalidatePrompt("/proj", "r1", "ROADMAP.md");
    expect(p).toContain("r1");
    expect(p).toContain("ROADMAP.md");
    expect(p).toContain("events.jsonl");
    expect(p).toContain("Never rename an id");
    expect(p).toContain("Skip: true");
    expect(p).toContain(`Do NOT write \`ROADMAP.md\``);
    expect(p).toContain(IMPORT_OPEN);
    expect(p).toContain(IMPORT_CLOSE);
  });

  test("runRevalidate writes proposal and returns slices", async () => {
    const dir = projectWithRun();
    const events: string[] = [];
    const res = await runRevalidate({
      projectDir: dir,
      runner: okRunner(`chatter\n${IMPORT_OPEN}\n${PROPOSAL}\n${IMPORT_CLOSE}\ntail`),
      onEvent: (m) => events.push(m),
    });
    expect(res.proposalPath).toBe(join(dir, "ROADMAP.revalidate.md"));
    expect(res.slices).toEqual(["a", "b"]);
    expect(readFileSync(res.proposalPath, "utf8")).toContain("Resume point");
    expect(events.some((m) => m.includes("ompo replan --run r1"))).toBe(true);
    // Current map untouched — adoption stays human.
    expect(readFileSync(join(dir, "ROADMAP.md"), "utf8")).toBe(CURRENT);
  });

  test("blocked proposals are never presented", async () => {
    const dir = projectWithRun();
    const bad = "## [a] First slice\nDo the first thing thoroughly and completely now.\n";
    await expect(runRevalidate({ projectDir: dir, runner: okRunner(`${IMPORT_OPEN}\n${bad}\n${IMPORT_CLOSE}`) })).rejects.toThrow("blocked");
  });

  test("missing block and missing runs fail closed", async () => {
    const dir = projectWithRun();
    await expect(runRevalidate({ projectDir: dir, runner: okRunner("just prose") })).rejects.toThrow("no roadmap block");
    const empty = mkdtempSync(join(tmpdir(), "ompo-revalidate-"));
    writeFileSync(join(empty, "ROADMAP.md"), CURRENT, "utf8");
    await expect(runRevalidate({ projectDir: empty, runner: okRunner("x") })).rejects.toThrow("no runs");
  });

  test("worker failure surfaces", async () => {
    const dir = projectWithRun();
    const failing: WorkerRunner = async () => ({ exit: 1, timedOut: false, stdout: "", stderr: "boom", durationMs: 1 });
    await expect(runRevalidate({ projectDir: dir, runner: failing })).rejects.toThrow("exit=1");
  });
});
