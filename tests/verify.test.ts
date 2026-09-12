import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightEnv, runVerifiers } from "../src/verify.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-preflight-"));
}

describe("preflightEnv", () => {
  test("clean gates probe green without blocking", async () => {
    const probes = await preflightEnv(tmpProject(), ["true"]);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.envBlocked).toBe(false);
    expect(probes[0]!.exit).toBe(0);
  });

  test("genuine code failures probe red but never env-block", async () => {
    const probes = await preflightEnv(tmpProject(), ["exit 3"]);
    expect(probes[0]!.envBlocked).toBe(false);
    expect(probes[0]!.exit).toBe(3);
  });

  test("infrastructure signatures block with a reason and fix", async () => {
    const dir = tmpProject();
    const probes = await preflightEnv(dir, [
      `node -e "console.error('listen EADDRINUSE: address already in use 0.0.0.0:3999'); process.exit(1)"`,
    ]);
    expect(probes[0]!.envBlocked).toBe(true);
    expect(probes[0]!.reason).toMatch(/3999|in use/);
    expect(probes[0]!.fix).toBeTruthy();
  });
});

describe("runVerifiers resilience", () => {
  test("exit without close still resolves with the real code", async () => {
    // Grandchild holds the pipes open after the gate exits: `close` would
    // wait out the full sleep. The grace fallback must resolve with exit 0
    // instead of wedging the verdict.
    const t0 = Date.now();
    const verdict = await runVerifiers("s", 1, ["(sleep 30 &)"], join(tmpProject(), "logs"), {
      projectDir: tmpProject(),
      closeGraceMs: 300,
      heartbeatMs: 0,
    });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(verdict.pass).toBe(true);
    expect(verdict.steps[0]!.exit).toBe(0);
    expect(verdict.steps[0]!.outputTail).toContain("forcing stdio closed");
  }, 30_000);

  test("long gates emit heartbeat signs of life", async () => {
    const lines: string[] = [];
    const verdict = await runVerifiers("s", 1, ["sleep 2"], join(tmpProject(), "logs"), {
      projectDir: tmpProject(),
      heartbeatMs: 400,
      onProgress: (l) => lines.push(l),
    });
    expect(verdict.pass).toBe(true);
    expect(lines.some((l) => l.includes("still running sleep 2"))).toBe(true);
  }, 15_000);

  test("gate output streams to its transcript while the gate runs", async () => {
    const dir = tmpProject();
    const logs = join(dir, "logs");
    const release = join(dir, "release");
    // The gate blocks on a marker file the test creates: "late" provably
    // cannot exist until the test has already read the mid-flight transcript.
    const command = `printf 'early\\n'; while [ ! -f '${release}' ]; do sleep 0.02; done; printf 'late\\n'`;
    const gate = runVerifiers("s", 1, [command], logs, { projectDir: dir, heartbeatMs: 0 });
    const logPath = join(logs, "verify-0.log");
    // The header quotes the command (so it contains the sentinels); the body
    // is the gate's own output.
    const body = (text: string): string => text.split("\n").slice(1).join("\n");
    // Event-driven, not timed: resolve when the transcript first carries the
    // gate's early output. A file written only at gate end never resolves.
    const { promise: streamed, resolve } = Promise.withResolvers<void>();
    const watcher = watch(logs, (_event, name) => {
      if (name !== "verify-0.log") return;
      try {
        if (body(readFileSync(logPath, "utf8")).includes("early")) resolve();
      } catch {
        /* header not written yet */
      }
    });
    try {
      await streamed;
      const midFlight = readFileSync(logPath, "utf8");
      expect(midFlight.split("\n")[0]).toBe(`$ ${command}`);
      expect(body(midFlight)).toContain("early");
      expect(body(midFlight)).not.toContain("late");
    } finally {
      watcher.close();
      writeFileSync(release, "");
    }
    const verdict = await gate;
    expect(verdict.pass).toBe(true);
    const final = body(readFileSync(logPath, "utf8"));
    expect(final).toContain("late");
    expect(final).toContain("verify ok:");
    expect(final).toMatch(/\(exit=0 timedOut=false \d+ms\)/);
  }, 15_000);
});
