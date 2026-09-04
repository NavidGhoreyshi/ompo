import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOmpWorker } from "../src/worker.ts";

describe("worker spawn stdio (regression: readPipedInput hang)", () => {
  test("child stdin is /dev/null, not an open pipe", async () => {
    // Fake `omp` that reports what fd 0 points at, then exits.
    const dir = mkdtempSync(join(tmpdir(), "ompo-fakeomp-"));
    const fake = join(dir, "omp");
    writeFileSync(
      fake,
      `#!/bin/bash\nif [ "$(readlink /proc/self/fd/0)" = "/dev/null" ]; then echo "STDIN_DEVNULL"; else echo "STDIN_$(readlink /proc/self/fd/0)"; fi\n`,
      "utf8",
    );
    chmodSync(fake, 0o755);
    const prevPath = process.env.PATH ?? "";
    process.env.PATH = `${dir}:${prevPath}`;
    try {
      const res = await runOmpWorker(
        { prompt: "hello", sliceId: "x", attempt: 1 },
        { projectDir: dir, timeoutMs: 10_000 },
      );
      expect(res.exit).toBe(0);
      expect(res.stdout).toContain("STDIN_DEVNULL");
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
