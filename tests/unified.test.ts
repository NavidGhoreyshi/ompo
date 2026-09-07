import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { createRun } from "../src/store.ts";
import { agentStates, driveUnifiedFlow, type UnifiedSession } from "../src/unified.tsx";
import type { LoopOptions, LoopResult } from "../src/loop.ts";

const MINI = "## [a] A\nDo A.\nVerify: true\nRetries: 0\n";
const okLoop = (seen: { opts: LoopOptions | null }): ((o: LoopOptions) => Promise<LoopResult>) =>
  (async (o) => {
    seen.opts = o;
    return { exitCode: 0, done: 1, failed: 0, skipped: 0, pending: 0, blockedEnv: 0 };
  });

describe("agentStates", () => {
  test("last action per bracketed id, capped at 8", () => {
    const lines = ["▸ slice a — X", "[a] turn 1…", "[b] turn 1…", "[a] turn 2…", "plain"];
    expect(agentStates(lines)).toEqual([
      { id: "a", last: "turn 2…" },
      { id: "b", last: "turn 1…" },
    ]);
  });

  test("empty when no progress lines", () => {
    expect(agentStates(["hi", "  indented", ""])).toEqual([]);
  });
});

describe("driveUnifiedFlow", () => {
  test("plans when missing, then runs (headless log sink)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-uni-"));
    const logs: string[] = [];
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    const seen: { opts: LoopOptions | null } = { opts: null };
    const res = await driveUnifiedFlow(
      {
        projectDir: dir,
        planner: (async (o) => {
          const p = o.roadmapPath ?? join(dir, "ROADMAP.md");
          writeFileSync(p, MINI, "utf8");
          return { roadmapPath: p, slices: ["a"] };
        }),
        looper: okLoop(seen),
      },
      (m: string) => logs.push(m),
      session,
      new AbortController().signal,
    );
    expect(res.exitCode).toBe(0);
    expect(session.phase).toBe("done");
    expect(session.runId).not.toBeNull();
    expect(seen.opts?.runId).toBe(session.runId ?? undefined);
    expect(existsSync(join(dir, ".omp", "roadmap.yml"))).toBe(true);
    expect(readFileSync(join(dir, "ROADMAP.md"), "utf8")).toContain("## [a]");
    expect(logs.some((m) => m.includes("roadmap OK: 1 slices"))).toBe(true);
  });

  test("resumes latest unfinished run without planning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-uni-"));
    writeFileSync(join(dir, "ROADMAP.md"), MINI, "utf8");
    createRun(dir, parseRoadmap(MINI), "r1");
    const logs: string[] = [];
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    const seen: { opts: LoopOptions | null } = { opts: null };
    let planned = false;
    const res = await driveUnifiedFlow(
      {
        projectDir: dir,
        planner: (async () => {
          planned = true;
          throw new Error("must not plan");
        }),
        looper: okLoop(seen),
      },
      (m: string) => logs.push(m),
      session,
      new AbortController().signal,
    );
    expect(planned).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(session.runId).toBe("r1");
    expect(seen.opts?.runId).toBe("r1");
    expect(logs.some((m) => m.includes("resumed run r1"))).toBe(true);
  });
});

describe("stalled latest run", () => {
  test("terminal failure dead-ending the roadmap starts fresh instead of resuming", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-uni-"));
    const two = `${MINI}## [b] B\nDo B.\nDepends: a\nVerify: true\nRetries: 0\n`;
    writeFileSync(join(dir, "ROADMAP.md"), two, "utf8");
    createRun(dir, parseRoadmap(two), "r1");
    const cursorPath = join(dir, ".omp", "roadmap", "runs", "r1", "roadmap.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      doc: { slices: { id: string; status: string }[] };
    };
    cursor.doc.slices.find((s) => s.id === "a")!.status = "failed";
    writeFileSync(cursorPath, JSON.stringify(cursor), "utf8");
    const logs: string[] = [];
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    const seen: { opts: LoopOptions | null } = { opts: null };
    const res = await driveUnifiedFlow(
      { projectDir: dir, looper: okLoop(seen) },
      (m: string) => logs.push(m),
      session,
      new AbortController().signal,
    );
    expect(res.exitCode).toBe(0);
    expect(session.runId).not.toBe("r1");
    expect(seen.opts?.runId).toBe(session.runId ?? undefined);
    expect(logs.some((m) => m.includes("stalled") && m.includes("starting fresh"))).toBe(true);
    expect(existsSync(join(dir, ".omp", "roadmap", "runs", session.runId ?? ""))).toBe(true);
  });
});
