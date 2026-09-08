import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightEnv } from "../src/verify.ts";

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
