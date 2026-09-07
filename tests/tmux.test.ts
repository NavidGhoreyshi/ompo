import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_CLOSE, REPORT_OPEN } from "../src/report.ts";
import { REVIEW_CLOSE, REVIEW_OPEN } from "../src/review.ts";
import { createTmuxRunner, type TmuxExec } from "../src/tmux.ts";

function baseExec(seen: string[][]): TmuxExec {
  return (args) => {
    seen.push(args);
    if (args[0] === "split-window") return { exit: 0, out: "%1" };
    if (args[0] === "display-message") return { exit: 0, out: "@1" };
    return { exit: 0, out: "" };
  };
}
function reportJson(sliceId: string, done: boolean): string {
  return JSON.stringify({
    sliceId,
    summary: "did the thing",
    filesChanged: ["a.ts"],
    testsRun: ["bun test"],
    testsPassed: true,
    verificationNotes: "ran it",
    followUps: [],
    deferred: [],
    done,
  });
}

function sessionLine(text: string): string {
  return (
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

describe("tmux TUI runner", () => {
  test("missing $TMUX_PANE fails fast with guidance", async () => {
    const saved = process.env.TMUX_PANE;
    delete process.env.TMUX_PANE;
    try {
      const run = createTmuxRunner({ exec: baseExec([]) });
      let err = "";
      try {
        await run({ prompt: "do it", sliceId: "a", attempt: 1 }, { projectDir: "/tmp/x" });
      } catch (e) {
        err = String(e);
      }
      expect(err).toContain("$TMUX_PANE");
    } finally {
      if (saved !== undefined) process.env.TMUX_PANE = saved;
    }
  });

  test("interactive launch, session-file completion, pane killed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-tui-"));
    const seen: string[][] = [];
    const exec: TmuxExec = (args) => {
      seen.push(args);
      if (args[0] === "split-window") {
        // worker launches and its session file appears
        writeFileSync(
          join(dir, "sess.jsonl"),
          sessionLine("working on it") +
            sessionLine(`${REPORT_OPEN}\n${reportJson("a", true)}\n${REPORT_CLOSE}`),
          "utf8",
        );
        return { exit: 0, out: "%1" };
      }
      if (args[0] === "display-message") return { exit: 0, out: "@1" };
      return { exit: 0, out: "" };
    };
    const run = createTmuxRunner({ exec, homePane: "%0", pollMs: 1 });
    const res = await run(
      { prompt: "do the thing", sliceId: "a", attempt: 1 },
      { projectDir: "/tmp/wt", sessionDir: dir },
    );
    expect(res.exit).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain("did the thing");

    const first = (cmd: string) => seen.find((a) => a[0] === cmd)!;
    const respawn = first("respawn-pane");
    // interactive omp: no -p flag, session persists to the slice dir
    expect(respawn).not.toContain("-p");
    expect(respawn).toContain("omp");
    expect(respawn).toContain("--session-dir");
    expect(respawn).toContain(dir);
    expect(respawn.join(" ")).toContain("do the thing");
    // no pipe-pane screen-scraping in TUI mode
    expect(seen.some((a) => a[0] === "pipe-pane")).toBe(false);
    const kills = seen.filter((a) => a[0] === "kill-pane");
    expect(kills.length).toBeGreaterThanOrEqual(1);
    expect(kills.every((a) => a.includes("%1"))).toBe(true);
  });

  test("done=false keeps watching; later done=true completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-tui-"));
    const sess = join(dir, "sess.jsonl");
    const seen: string[][] = [];
    const exec: TmuxExec = (args) => {
      seen.push(args);
      if (args[0] === "split-window") {
        writeFileSync(sess, sessionLine(`${REPORT_OPEN}\n${reportJson("a", false)}\n${REPORT_CLOSE}`), "utf8");
        // Genuine-delay exception: simulates a live worker appending its
        // report mid-watch. Assertion is eventual completion before the run
        // deadline, not the 10ms itself — no timing dependence.
        setTimeout(() => {
          const prev = readFileSync(sess, "utf8");
          writeFileSync(sess, prev + sessionLine(`${REPORT_OPEN}\n${reportJson("a", true)}\n${REPORT_CLOSE}`), "utf8");
        }, 10);
        return { exit: 0, out: "%1" };
      }
      if (args[0] === "display-message") return { exit: 0, out: "@1" };
      return { exit: 0, out: "" };
    };
    const run = createTmuxRunner({ exec, homePane: "%0", pollMs: 1 });
    const res = await run(
      { prompt: "slow thing", sliceId: "a", attempt: 1 },
      { projectDir: "/tmp/wt", sessionDir: dir },
    );
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain("did the thing");
  });

  test("timeout kills the pane and reports timedOut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-tui-"));
    writeFileSync(join(dir, "sess.jsonl"), sessionLine("still thinking"), "utf8");
    const seen: string[][] = [];
    const run = createTmuxRunner({ exec: baseExec(seen), homePane: "%0", pollMs: 1 });
    const res = await run(
      { prompt: "hang", sliceId: "b", attempt: 1 },
      { projectDir: "/tmp/wt", sessionDir: dir, timeoutMs: 5 },
    );
    expect(res.timedOut).toBe(true);
    expect(res.exit).toBeNull();
    expect(seen.some((a) => a[0] === "kill-pane" && a.includes("%1"))).toBe(true);
  });

  test("review session ends at its verdict block and titles the pane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-tui-"));
    const seen: string[][] = [];
    const exec: TmuxExec = (args) => {
      seen.push(args);
      if (args[0] === "split-window") {
        // reviewer launches and prints a rejection verdict
        writeFileSync(
          join(dir, "review-sess.jsonl"),
          sessionLine(`${REVIEW_OPEN}\n${JSON.stringify({
            sliceId: "a",
            approved: false,
            findings: ["src/a.ts is missing"],
            notes: "claim does not match the tree",
          })}\n${REVIEW_CLOSE}`),
          "utf8",
        );
        return { exit: 0, out: "%1" };
      }
      if (args[0] === "display-message") return { exit: 0, out: "@1" };
      return { exit: 0, out: "" };
    };
    const run = createTmuxRunner({ exec, homePane: "%0", pollMs: 1 });
    const res = await run(
      { prompt: "audit the slice", sliceId: "a", attempt: 1, label: "a review" },
      { projectDir: "/tmp/wt", sessionDir: dir },
    );
    // Session ends on the verdict block (approval is the loop's call).
    expect(res.exit).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain("approved\":false");
    const titled = seen.find((a) => a[0] === "select-pane" && a.includes("-T"))!;
    expect(titled.join(" ")).toContain("ompo a review a1");
  });

  test("stale session files from prior attempts are ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-tui-"));
    // attempt 1's file already contains a done report for the same slice
    writeFileSync(
      join(dir, "old.jsonl"),
      sessionLine(`${REPORT_OPEN}\n${reportJson("a", true)}\n${REPORT_CLOSE}`),
      "utf8",
    );
    const seen: string[][] = [];
    const run = createTmuxRunner({ exec: baseExec(seen), homePane: "%0", pollMs: 1 });

    const res = await run(
      { prompt: "hang", sliceId: "a", attempt: 2 },
      { projectDir: "/tmp/wt", sessionDir: dir, timeoutMs: 5 },
    );
    // must NOT complete off the stale file → times out instead
    expect(res.timedOut).toBe(true);
  });
  test("attempt 2 resumes the prior session instead of starting blind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-tui-"));
    writeFileSync(join(dir, "2026-09-05T08-36-16-587Z_01a070b6-164b-7000-8635-6b343d641300.jsonl"), "", "utf8");
    const seen: string[][] = [];
    const run = createTmuxRunner({ exec: baseExec(seen), homePane: "%0", pollMs: 1 });
    const res = await run(
      { prompt: "full original spec", sliceId: "a", attempt: 2 },
      { projectDir: "/tmp/wt", sessionDir: dir, timeoutMs: 5 },
    );
    expect(res.timedOut).toBe(true); // no new report; argv is the assertion
    const respawn = seen.find((a) => a[0] === "respawn-pane")!;
    expect(respawn).toContain("--resume");
    expect(respawn).toContain("01a070b6-164b-7000-8635-6b343d641300");
    expect(respawn.join(" ")).toContain("Continue the in-progress slice");
    expect(respawn.join(" ")).not.toContain("full original spec");
  });
});
