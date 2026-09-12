import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
});
