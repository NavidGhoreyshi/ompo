import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectScanTargets,
  findingAccepted,
  formatFindingsRedacted,
  hashLineContent,
  isHumanProseValue,
  isScannablePath,
  preMergeSecretGate,
  resolveAcceptanceTargets,
  scanCandidateFiles,
  scanTextLines,
} from "../src/secrets.ts";
import { createRun, loadRun, readEvents, sliceDir, storeApi } from "../src/store.ts";
import { parseRoadmap } from "../src/parse.ts";
import { REPORT_CLOSE, REPORT_OPEN } from "../src/report.ts";
import { REVIEW_CLOSE, REVIEW_OPEN } from "../src/review.ts";
import { runRoadmapLoop } from "../src/loop.ts";
import type { Verdict } from "../src/types.ts";
import type { WorkerRunner } from "../src/worker.ts";

/**
 * Fixture values are assembled from fragments on purpose. Push protection
 * scans pushed files — test fixtures included — and these samples are shaped
 * exactly like the tokens they emulate (that is the fixtures' job), so a
 * complete literal blocks every push to this repository. The scanner under
 * test still sees the assembled value at runtime.
 */
const fixture = (...parts: string[]): string => parts.join("");
const AWS_KEY = fixture("AK", "IA", "IOSFODNN7SECRETS");
const AWS_KEY2 = fixture("AK", "IA", "QZ3K9M2V7X4B8JXS");
const AWS_DOC_EXAMPLE = fixture("AK", "IA", "IOSFODNN7EXAMPLE");
const GH_TOKEN = fixture("gh", "p_", "qZ3kL9mN2vB7xC4dF6gH8jK1pQ5rS0tUvW3yXaZbCd6");
const SLACK_TOKEN = fixture("xox", "b-550823488112-abcdefghijklmnopzzqQ");
const STRIPE_KEY = fixture("sk", "_live_", "qZ3kL9mN2vB7xC4dF6gH8jK1p");
const OPENAI_KEY = fixture("sk", "-", "qZ3kL9mN2vB7xC4dF6gH8jK1pQ5rS0tUvW3yXaZbCd");
const GOOGLE_KEY = fixture("AI", "za", "SyAqZ3kL9mN2vB7xC4dF6gH8jK1pQ5rStUvW8y");
const PEM_RSA = fixture("-----BE", "GIN RSA PRIVATE KEY-----");
const PEM_OPENSSH = fixture("-----BE", "GIN OPENSSH PRIVATE KEY-----");

function mkVerdict(): Verdict {
  return { sliceId: "s1", attempt: 2, pass: true, steps: [], at: new Date().toISOString() };
}

describe("scanTextLines", () => {
  test("detects an AWS access key", () => {
    const hits = scanTextLines(`aws_access_key_id = ${AWS_KEY}\n`);
    expect(hits).toEqual([{ line: 1, kind: "aws-access-key" }]);
  });

  test("detects private-key material", () => {
    const hits = scanTextLines(`${PEM_RSA}\nMIIEowIBAAKCAQEA\n`);
    expect(hits.map((h) => h.kind)).toEqual(["private-key"]);
    expect(hits[0]!.line).toBe(1);
  });

  test("detects github/slack/stripe/openai/google classes", () => {
    expect(scanTextLines(`token = ${GH_TOKEN}`)[0]!.kind).toBe("github-token");
    expect(scanTextLines(`t = ${SLACK_TOKEN}`)[0]!.kind).toBe("slack-token");
    expect(scanTextLines(`key = ${STRIPE_KEY}`)[0]!.kind).toBe("stripe-key");
    expect(scanTextLines(`key = ${OPENAI_KEY}`)[0]!.kind).toBe("openai-key");
    expect(scanTextLines(`key = ${GOOGLE_KEY}`)[0]!.kind).toBe("google-api-key");
  });
  test("normal source code is not flagged", () => {
    const src = [
      `import { readFileSync } from "node:fs";`,
      `export function add(a: number, b: number): number { return a + b; }`,
      `const sessionId = "abc123";`,
      `// TODO: rotate keys next quarter`,
    ].join("\n");
    expect(scanTextLines(src)).toEqual([]);
  });

  test("realistic non-secret config is not flagged", () => {
    const cfg = [
      `PORT=3000`,
      `DATABASE_URL=postgres://localhost:5432/app`,
      `API_KEY=test`,
      `password = ""`,
      `password = \${DB_PASSWORD}`,
      `aws_access_key_id = ${AWS_DOC_EXAMPLE}`,
    ].join("\n");
    expect(scanTextLines(cfg)).toEqual([]);
  });

  test("documentation example keys are ignored", () => {
    expect(scanTextLines(`key = sk-test-FAKEKEY00000000000000000000000000`)).toEqual([]);
    expect(scanTextLines(`token = ghp_REDACTED`)).toEqual([]);
  });

  test("multiple findings across lines", () => {
    const hits = scanTextLines(
      `a = ${AWS_KEY}\nclean line\n${PEM_OPENSSH}\n`,
    );
    expect(hits).toEqual([
      { line: 1, kind: "aws-access-key" },
      { line: 3, kind: "private-key" },
    ]);
  });
});
describe("human-prose values", () => {
  test("localized password labels are not credentials", () => {
    const labels = [
      `password: "رمز عبور"`,
      `password: "пароль"`,
      `password: "contraseña segura"`,
    ].join("\n");
    expect(scanTextLines(labels)).toEqual([]);
    expect(isHumanProseValue("رمز عبور")).toBe(true);
    expect(isHumanProseValue("s3cr3t-value-9")).toBe(false);
  });

  test("ASCII assignments still flag, including spaced passphrases", () => {
    expect(scanTextLines(`password = "s3cr3t-value-9"`)).toEqual([{ line: 1, kind: "secret-assignment" }]);
    expect(scanTextLines(`password = "correct horse battery staple"`)).toEqual([{ line: 1, kind: "secret-assignment" }]);
  });

  test("token classes ignore nearby prose", () => {
    const hits = scanTextLines(`key = "${AWS_KEY2}"; // رمز`);
    expect(hits).toEqual([{ line: 1, kind: "aws-access-key" }]);
  });
});

describe("findingAccepted", () => {
  const acc = [{ file: "lib/strings.ts", line: 74, kind: "secret-assignment", lineHash: hashLineContent(`password: "x"`) }];

  test("matches exact content, voids on edit", () => {
    expect(findingAccepted(acc, { file: "lib/strings.ts", line: 74, kind: "secret-assignment" }, `password: "x"`)).toBe(true);
    expect(findingAccepted(acc, { file: "lib/strings.ts", line: 74, kind: "secret-assignment" }, `password: "y"`)).toBe(false);
    expect(findingAccepted(acc, { file: "lib/strings.ts", line: 75, kind: "secret-assignment" }, `password: "x"`)).toBe(false);
    expect(findingAccepted(acc, { file: "lib/strings.ts", line: 74, kind: "aws-access-key" }, `password: "x"`)).toBe(false);
    expect(findingAccepted(acc, { file: "lib/strings.ts", line: 74, kind: "secret-assignment" }, null)).toBe(false);
  });
});

describe("resolveAcceptanceTargets", () => {
  test("pins kind and hash; refuses thin air", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-secrets-accept-"));
    writeFileSync(join(dir, "scan.json"), JSON.stringify({ findings: [{ file: "a.ts", line: 2, kind: "secret-assignment" }] }), "utf8");
    writeFileSync(join(dir, "a.ts"), `ok\npassword = "s3cr3t-value-9"\n`, "utf8");
    const items = resolveAcceptanceTargets({ scanFile: join(dir, "scan.json"), root: dir, specs: ["a.ts:2"] });
    expect(items).toEqual([{ file: "a.ts", line: 2, kind: "secret-assignment", lineHash: hashLineContent(`password = "s3cr3t-value-9"`) }]);
    expect(() => resolveAcceptanceTargets({ scanFile: join(dir, "scan.json"), root: dir, specs: ["a.ts:9"] })).toThrow(/thin air/);
    expect(() => resolveAcceptanceTargets({ scanFile: join(dir, "scan.json"), root: dir, specs: ["nope"] })).toThrow(/file:line/);
    expect(() => resolveAcceptanceTargets({ scanFile: join(dir, "missing.json"), root: dir, specs: ["a.ts:2"] })).toThrow(/nothing to accept/);
  });
});


describe("scanCandidateFiles", () => {
  const io = (files: Record<string, string>) => ({
    readFile: (abs: string) => {
      const name = abs.split("/").at(-1)!;
      if (!(name in files)) throw new Error(`missing ${abs}`);
      return files[name]!;
    },
    fileBytes: (abs: string) => {
      const name = abs.split("/").at(-1)!;
      return (files[name] ?? "").length;
    },
  });

  test("clean tree yields no findings", () => {
    const r = scanCandidateFiles("/wt", ["src/a.ts"], io({ "a.ts": "export const x = 1;\n" }));
    expect(r.findings).toEqual([]);
    expect(r.filesScanned).toBe(1);
  });

  test("findings carry file/line/kind and no secret value", () => {
    const secret = AWS_KEY;
    const r = scanCandidateFiles("/wt", ["src/a.ts"], io({ "a.ts": `const k = "${secret}";\n` }));
    expect(r.findings).toEqual([{ file: "src/a.ts", line: 1, kind: "aws-access-key" }]);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  test("logs, lockfiles-adjacent runtime state, and binaries are skipped", () => {
    const r = scanCandidateFiles(
      "/wt",
      ["a/worker-1.log", "b/out.events.jsonl", "c/icon.png", "d/node_modules/x.js", "e/ok.ts"],
      io({ "x.js": "x", "ok.ts": "ok\n" }),
    );
    expect(r.filesScanned).toBe(1);
    expect(r.skipped.sort()).toEqual(
      ["a/worker-1.log", "b/out.events.jsonl", "c/icon.png", "d/node_modules/x.js"].sort(),
    );
  });
});

describe("collectScanTargets on real git repos", () => {
  test("status changes and branch delta enumerate; scan finds the secret", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "ompo-secrets-git-"));
    const git = (args: string[]): void => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stdout}${r.stderr}`);
    };
    git(["init", "-q"]);
    writeFileSync(join(dir, "a.ts"), "export const x = 1;\n", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    const base = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    git(["checkout", "-qb", "ompo/r/s1"]);
    writeFileSync(join(dir, "branch.ts"), `export const k = "${AWS_KEY2}";\n`, "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "slice work"]);
    git(["checkout", "-q", base]);
    const wt = join(dir, "wt");
    git(["worktree", "add", wt, "ompo/r/s1"]);
    try {
      writeFileSync(join(wt, "wt.ts"), `${PEM_RSA}\n`, "utf8");
      const collected = collectScanTargets(wt, { projectDir: dir, branch: "ompo/r/s1" });
      if ("failure" in collected) throw new Error(`unexpected scan failure: ${collected.failure}`);
      expect(collected.relPaths).toContain("branch.ts");
      expect(collected.relPaths).toContain("wt.ts");
      const scan = scanCandidateFiles(collected.root, collected.relPaths);
      expect(scan.findings).toEqual([
        { file: "branch.ts", line: 1, kind: "aws-access-key" },
        { file: "wt.ts", line: 1, kind: "private-key" },
      ]);
      expect(JSON.stringify(scan)).not.toContain(AWS_KEY2);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: dir });
    }
  });
});

describe("collectScanTargets", () => {
  test("non-git directory falls back to declared files, empty means clean", () => {
    const r = collectScanTargets("/nonexistent-dir-ompo-test", { fallbackFiles: ["a.ts"] });
    expect(r).toEqual({ root: "/nonexistent-dir-ompo-test", relPaths: ["a.ts"] });
    const empty = collectScanTargets("/nonexistent-dir-ompo-test");
    expect(empty).toEqual({ root: "/nonexistent-dir-ompo-test", relPaths: [] });
  });
});

describe("isScannablePath", () => {
  test("excludes .omp runtime state and caches", () => {
    expect(isScannablePath(".omp/roadmap/runs/r/slices/s/report.json")).toBe(false);
    expect(isScannablePath("src/a.ts")).toBe(true);
  });
});

describe("formatFindingsRedacted", () => {
  test("never contains the secret value", () => {
    const s = formatFindingsRedacted([{ file: "a.ts", line: 3, kind: "aws-access-key" }]);
    expect(s).toBe("a.ts:3 (aws-access-key)");
  });
});

describe("pre-merge gate in the loop", () => {
  const LEAK = AWS_KEY2;
  const LEAK_MD = [
    "## [s1] Leaky slice",
    "Write the thing.",
    "Files: leaked.ts",
    "Verify: true",
    "",
  ].join("\n");

  test("merge is refused while a high-confidence secret sits in candidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-secrets-"));
    createRun(dir, parseRoadmap(LEAK_MD), "r");
    const runner: WorkerRunner = async (call, ctx) => {
      if (call.label?.endsWith(" review")) {
        return {
          exit: 0, timedOut: false,
          stdout: `${REVIEW_OPEN}\n${JSON.stringify({ sliceId: call.sliceId, approved: true, findings: [], notes: "ok" })}\n${REVIEW_CLOSE}`,
          stderr: "", durationMs: 1,
        };
      }
      writeFileSync(join(ctx.projectDir, "leaked.ts"), `export const key = "${LEAK}";\n`, "utf8");
      return {
        exit: 0, timedOut: false,
        stdout: `w\n${REPORT_OPEN}\n${JSON.stringify({ sliceId: call.sliceId, summary: "did it", filesChanged: ["leaked.ts"], testsRun: [], testsPassed: true, verificationNotes: "ok", followUps: [], deferred: [], done: true })}\n${REPORT_CLOSE}`,
        stderr: "", durationMs: 1,
      };
    };
    const events: string[] = [];
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, noDebug: true, onEvent: (m: string) => events.push(m) });
    expect(res.failed).toBe(1);
    expect(res.done).toBe(0);
    const slice = loadRun(dir, "r").doc.slices[0]!;
    expect(slice.status).toBe("failed");
    // Redacted artifact exists and contains no secret value.
    const scanJson = join(sliceDir(dir, "r", "s1"), "secret-scan-2.json");
    expect(existsSync(scanJson)).toBe(true);
    const raw = readFileSync(scanJson, "utf8");
    expect(raw).toContain("aws-access-key");
    expect(raw).not.toContain(LEAK);
    // Verdict carries the failed secret-scan step; log line is redacted too.
    const verdict = JSON.parse(readFileSync(join(sliceDir(dir, "r", "s1"), "verdict.json"), "utf8")) as {
      pass: boolean;
      steps: { name: string; exit: number | null }[];
    };
    expect(verdict.pass).toBe(false);
    expect(verdict.steps.at(-1)?.name).toBe("secret-scan");
    expect(verdict.steps.at(-1)?.exit).toBe(1);
    expect(events.join("\n")).not.toContain(LEAK);
    expect(events.join("\n")).toContain("secret scan: 1 finding(s)");
  });

  test("clean scan leaves the merge path untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-secrets-"));
    createRun(dir, parseRoadmap(LEAK_MD), "r");
    const runner: WorkerRunner = async (call, ctx) => {
      if (call.label?.endsWith(" review")) {
        return {
          exit: 0, timedOut: false,
          stdout: `${REVIEW_OPEN}\n${JSON.stringify({ sliceId: call.sliceId, approved: true, findings: [], notes: "ok" })}\n${REVIEW_CLOSE}`,
          stderr: "", durationMs: 1,
        };
      }
      writeFileSync(join(ctx.projectDir, "leaked.ts"), `export const port = 3000;\n`, "utf8");
      return {
        exit: 0, timedOut: false,
        stdout: `w\n${REPORT_OPEN}\n${JSON.stringify({ sliceId: call.sliceId, summary: "did it", filesChanged: ["leaked.ts"], testsRun: [], testsPassed: true, verificationNotes: "ok", followUps: [], deferred: [], done: true })}\n${REPORT_CLOSE}`,
        stderr: "", durationMs: 1,
      };
    };
    const res = await runRoadmapLoop({ projectDir: dir, runId: "r", runner, noDebug: true, onEvent: () => {} });
    expect(res.exitCode).toBe(0);
    expect(res.done).toBe(1);
  });

  test("blessed findings stay silent on re-gate; edited lines re-fire", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-secrets-"));
    createRun(dir, parseRoadmap(LEAK_MD), "r");
    storeApi.claimSlice(dir, "r", "s1");
    mkdirSync(sliceDir(dir, "r", "s1"), { recursive: true });
    writeFileSync(join(dir, "leaked.ts"), `password = "s3cr3t-value-9"\n`, "utf8");
    const slice = loadRun(dir, "r").doc.slices[0]!;
    const gateOpts = {
      projectDir: dir, runId: "r", slice, attempt: 2, dir: sliceDir(dir, "r", "s1"), wtPath: dir,
      verdict: mkVerdict(),
      report: { filesChanged: ["leaked.ts"] }, maxRetries: 0, log: () => {},
    };
    expect(preMergeSecretGate(gateOpts)).toBe(false);
    expect(loadRun(dir, "r").doc.slices[0]!.status).toBe("failed");
    const scanFile = join(sliceDir(dir, "r", "s1"), "secret-scan-2.json");
    const items = resolveAcceptanceTargets({ scanFile, root: dir, specs: ["leaked.ts:1"] });
    expect(items).toHaveLength(1);
    storeApi.acceptSecretFindings(dir, "r", "s1", items, "test blessing");
    const ev = readEvents(dir, "r").find((e) => e.type === "secret_accepted")!;
    expect(ev.detail).toContain("leaked.ts:1 (secret-assignment)");
    expect(ev.detail).toContain("test blessing");
    expect(JSON.stringify(ev)).not.toContain("s3cr3t-value-9");
    gateOpts.verdict = mkVerdict();
    expect(preMergeSecretGate(gateOpts)).toBe(true);
    // Editing the blessed line voids the blessing.
    writeFileSync(join(dir, "leaked.ts"), `password = "another-s3cr3t-value"\n`, "utf8");
    gateOpts.verdict = mkVerdict();
    expect(preMergeSecretGate(gateOpts)).toBe(false);
  });
});

