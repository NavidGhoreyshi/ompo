import { describe, expect, test } from "bun:test";
import { parseRoadmap } from "../src/parse.ts";
import {
  buildDebugPrompt,
  classifyEnvFailure,
  DEFAULT_DEBUG_TIMEOUT_MS,
  MAX_HARNESS_DIFF_LINES,
  validateHarnessFix,
} from "../src/debug.ts";
import { DEFAULT_WORKER_TIMEOUT_MS } from "../src/worker.ts";
import { extractHarnessFix, HARNESS_CLOSE, HARNESS_OPEN, REPORT_CLOSE, REPORT_OPEN, type HarnessFix } from "../src/report.ts";

describe("classifyEnvFailure", () => {
  test("port in use, with and without port number", () => {
    const hit = classifyEnvFailure(["[WebServer] Error: listen EADDRINUSE: address already in use 0.0.0.0:3000"]);
    expect(hit?.reason).toBe("port 3000 already in use");
    expect(hit?.fix).toContain("ompo resume");
    const bare = classifyEnvFailure(["Error: EADDRINUSE"]);
    expect(bare?.reason).toBe("port already in use");
  });

  test("database unreachable variants", () => {
    expect(classifyEnvFailure(["Can't reach database server at `localhost:5433`"])?.reason).toBe("database unreachable");
    expect(classifyEnvFailure(["connect ECONNREFUSED 127.0.0.1:5432"])?.reason).toBe("database unreachable");
    expect(classifyEnvFailure(["connection refused"])?.reason).toBe("database unreachable");
  });

  test("missing database / role", () => {
    expect(classifyEnvFailure(['database "general_wms" does not exist'])?.reason).toBe('database "general_wms" missing');
    expect(classifyEnvFailure(['role "navid" does not exist'])?.reason).toBe('database role "navid" missing');
  });

  test("dns and disk", () => {
    expect(classifyEnvFailure(["getaddrinfo ENOTFOUND registry.example"])?.reason).toBe("host unresolvable");
    expect(classifyEnvFailure(["write failed: no space left on device"])?.reason).toBe("disk full");
  });

  test("missing env var / secret parks as env, lowercase app validation does not", () => {
    const hit = classifyEnvFailure(["Error: SEED_ADMIN_PASSWORD must be set to run the s3 spec"]);
    expect(hit?.reason).toBe('missing env var "SEED_ADMIN_PASSWORD"');
    expect(hit?.fix).toContain("ompo resume");
    expect(classifyEnvFailure(["missing required environment variable FOO"])?.reason).toBe('missing env var "FOO"');
    expect(classifyEnvFailure(["environment variable BAR is not set"])?.reason).toBe('missing env var "BAR"');
    expect(classifyEnvFailure(["FOO: parameter null or not set"])?.reason).toContain("required env var missing");
    expect(classifyEnvFailure(["Error: username must be set"]) ?? null).toBeNull();
  });

  test("genuine code failures are not env", () => {
    expect(classifyEnvFailure(["AssertionError: expected 1 to equal 2"])?.reason ?? null).toBeNull();
    expect(classifyEnvFailure(["TypeError: Cannot read properties of undefined", "at foo (bar.ts:1:2)"])).toBeNull();
    expect(classifyEnvFailure([])).toBeNull();
    expect(classifyEnvFailure([""])).toBeNull();
  });

  test("first match wins across steps", () => {
    const hit = classifyEnvFailure(["ok output", "EADDRINUSE"]);
    expect(hit?.reason).toBe("port already in use");
  });
});

describe("buildDebugPrompt", () => {
  test("contains failure context, worktree, and report contract", () => {
    const doc = parseRoadmap("## [a] First\nDo X.\nVerify: bun test\nFiles: src/a.ts\n");
    const prompt = buildDebugPrompt(doc.slices[0]!, {
      verifyCommands: ["bun test"],
      failingTail: "AssertionError: boom",
      worktree: "/tmp/wt-a",
      attempt: 1,
    });
    expect(prompt).toContain("Debug session: a");
    expect(prompt).toContain("$ bun test");
    expect(prompt).toContain("AssertionError: boom");
    expect(prompt).toContain("/tmp/wt-a");
    expect(prompt).toContain(REPORT_OPEN);
    expect(prompt).toContain("environmental");
    expect(prompt).toContain(HARNESS_OPEN); // rule 5b harness lane documented
    expect(prompt).toContain("5b");
  });
});

describe("harness fix", () => {
  function block(filesPatched: string[], diff: string, summary = "proxy not bypassed in gate"): string {
    return `${HARNESS_OPEN}\n${JSON.stringify({ sliceId: "a", filesPatched, diff, summary })}\n${HARNESS_CLOSE}`;
  }

  const head = new Set(["e2e/playwright.config.ts", "src/a.ts", "README.md"]);
  const valid: HarnessFix = {
    sliceId: "a",
    filesPatched: ["e2e/playwright.config.ts"],
    diff: "--- a/e2e/playwright.config.ts\n+++ b/e2e/playwright.config.ts\n",
    summary: "webServer polls through an un-bypassed proxy",
  };

  test("extractHarnessFix finds the block among verbose stdout", () => {
    const out = [
      "turn 1…",
      "tool bash: bun test",
      "says: investigating the proxy 502…",
      block(["e2e/playwright.config.ts"], "@@ -1 +1 @@\n-http\n+http+no_proxy\n"),
      "turn 2 done",
    ].join("\n");
    expect(extractHarnessFix(out)).toEqual({
      sliceId: "a",
      filesPatched: ["e2e/playwright.config.ts"],
      diff: "@@ -1 +1 @@\n-http\n+http+no_proxy\n",
      summary: "proxy not bypassed in gate",
    });
  });

  test("extractHarnessFix returns undefined when absent or malformed", () => {
    expect(extractHarnessFix(`prose ${REPORT_OPEN}\n{}\n${REPORT_CLOSE} prose`)).toBeUndefined();
    expect(extractHarnessFix(`${HARNESS_OPEN}\nnot json\n${HARNESS_CLOSE}`)).toBeUndefined();
    expect(extractHarnessFix(`${HARNESS_OPEN}\n[]\n${HARNESS_CLOSE}`)).toBeUndefined();
    expect(extractHarnessFix(`${HARNESS_OPEN}\n{"a":1}`)).toBeUndefined(); // unclosed
  });

  test("validateHarnessFix accepts a valid base-only fix and ignores extra keys", () => {
    expect(validateHarnessFix(valid, [], head)).toEqual([]);
    const extra = { ...valid, sliceId: "x", notes: "ignored", ok: true } as HarnessFix;
    expect(validateHarnessFix(extra, [], head)).toEqual([]);
  });

  test("validateHarnessFix rejects empty filesPatched", () => {
    const hf = { ...valid, filesPatched: [] } as HarnessFix;
    const v = validateHarnessFix(hf, [], head);
    expect(v).toContain("filesPatched required");
  });

  test("validateHarnessFix rejects a file in the slice files list", () => {
    const v = validateHarnessFix(valid, ["e2e/playwright.config.ts"], head);
    expect(v).toContain("cannot patch slice-owned files: e2e/playwright.config.ts");
  });

  test("validateHarnessFix rejects a file not at HEAD", () => {
    const hf = { ...valid, filesPatched: ["e2e/nope.ts"] } as HarnessFix;
    const v = validateHarnessFix(hf, [], head);
    expect(v).toContain("file not at HEAD: e2e/nope.ts");
  });

  test("validateHarnessFix collects all scope violations, not just the first", () => {
    const hf = {
      ...valid,
      filesPatched: ["e2e/playwright.config.ts", "e2e/missing.ts"],
    } as HarnessFix;
    const v = validateHarnessFix(hf, ["e2e/playwright.config.ts"], head);
    expect(v).toContain("cannot patch slice-owned files: e2e/playwright.config.ts");
    expect(v).toContain("file not at HEAD: e2e/missing.ts");
    expect(v.length).toBe(2);
  });

  test("validateHarnessFix rejects a diff over 40 lines, accepts exactly 40", () => {
    const big = {
      ...valid,
      diff: Array.from({ length: MAX_HARNESS_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join("\n"),
    } as HarnessFix;
    const v = validateHarnessFix(big, [], head);
    expect(v).toContain(`diff exceeds ${MAX_HARNESS_DIFF_LINES} lines`);

    const ok = {
      ...valid,
      diff: Array.from({ length: MAX_HARNESS_DIFF_LINES }, (_, i) => `line ${i}`).join("\n"),
    } as HarnessFix;
    expect(validateHarnessFix(ok, [], head)).toEqual([]);
  });

  test("validateHarnessFix rejects missing required fields", () => {
    const missing = {} as HarnessFix;
    const v = validateHarnessFix(missing, [], head);
    expect(v).toContain("sliceId required");
    expect(v).toContain("filesPatched required");
    expect(v).toContain("diff required");
    expect(v).toContain("summary required");
    const noSummary = { sliceId: "a", filesPatched: ["src/a.ts"], diff: "d" } as HarnessFix;
    expect(validateHarnessFix(noSummary, [], head)).toContain("summary required");
  });
});

describe("debug budget", () => {
  test("default covers a worker generation with headroom", () => {
    // A debug/unblock/review-fix session diagnoses AND fixes AND re-verifies
    // (often a full build plus suites) — strictly more than the worker turn
    // it follows. A default below the worker budget murders productive
    // sessions mid-diagnosis (observed: 29-turn unblock killed at 10m).
    expect(DEFAULT_DEBUG_TIMEOUT_MS).toBeGreaterThan(DEFAULT_WORKER_TIMEOUT_MS);
  });
});
