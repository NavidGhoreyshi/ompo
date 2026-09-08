import { describe, expect, test } from "bun:test";
import { formatFinding, lintFailed, lintRoadmap } from "../src/lint.ts";

const CLEAN = "## [a] Alpha\nDo the alpha thing thoroughly and completely.\nEffort: med\nVerify: bun test\nFiles: src/a.ts\nAgent: task\n";

describe("lintRoadmap", () => {
  test("clean roadmap passes silent", () => {
    const r = lintRoadmap(CLEAN);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(lintFailed(r)).toBe(false);
  });

  test("missing gates are errors unless verifyDefaults cover them", () => {
    const missing = lintRoadmap("## [a] Alpha\nDo the alpha thing thoroughly.\nEffort: med\n");
    expect(lintFailed(missing)).toBe(true);
    expect(missing.errors.map((e) => e.code)).toContain("no-verify");
    const covered = lintRoadmap("## [a] Alpha\nDo the alpha thing thoroughly.\nEffort: med\n", { verifyDefaults: ["bun test"] });
    expect(lintFailed(covered)).toBe(false);
  });

  test("state-only gates prove an && split changed meaning", () => {
    const r = lintRoadmap("## [a] Alpha\nDo the alpha thing thoroughly.\nEffort: med\nVerify: cd e2e && bunx playwright test\n");
    expect(r.errors.map((e) => e.code)).toContain("state-split");
    // The quoted escape hatch stays one gate and passes.
    const ok = lintRoadmap("## [a] Alpha\nDo the alpha thing thoroughly.\nEffort: med\nVerify: sh -c 'cd e2e && bunx playwright test'\n");
    expect(ok.errors.map((e) => e.code)).not.toContain("state-split");
  });

  test("|| fallbacks, big budgets, and missing effort warn", () => {
    const r = lintRoadmap(
      "## [a] Alpha\nDo the alpha thing thoroughly and completely.\nVerify: bun test || true\nTimeout: 61m\nRetries: 4\n",
    );
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain("or-gate");
    expect(codes).toContain("big-timeout");
    expect(codes).toContain("big-retries");
    expect(codes).toContain("no-effort");
    expect(lintFailed(r)).toBe(false);
  });

  test("unknown agents warn; patterns, built-ins, and mapped names pass", () => {
    const bad = lintRoadmap(`${CLEAN.replace("Agent: task", "Agent: wizard")}`);
    expect(bad.warnings.map((w) => w.code)).toContain("unknown-agent");
    const mapped = lintRoadmap(CLEAN, { agentModels: { wizard: "some/model" } });
    expect(mapped.warnings.map((w) => w.code)).not.toContain("unknown-agent");
    const pattern = lintRoadmap(CLEAN.replace("Agent: task", "Agent: opus/model:x"));
    expect(pattern.warnings.map((w) => w.code)).not.toContain("unknown-agent");
  });

  test("skips warn when dependents or skipped deps are involved", () => {
    const r = lintRoadmap(
      "## [a] Alpha\nDo the alpha thing thoroughly and completely.\nEffort: med\nVerify: bun test\nSkip: true\n\n## [b] Beta\nDo the beta thing thoroughly and completely.\nEffort: med\nDepends: a\nVerify: bun test\n",
    );
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain("skip-with-dependents");
    expect(codes).toContain("dep-on-skipped");
  });
  test("skipped slices need no Verify (importer convention, check-env parity)", () => {
    const r = lintRoadmap("## [a] Alpha\nDone — see qa/a/report.md for evidence.\nSkip: true\n");
    expect(r.errors.map((e) => e.code)).not.toContain("no-verify");
    expect(lintFailed(r)).toBe(false);
  });

  test("thin bodies and escaping files warn; parse failures are errors", () => {
    const thin = lintRoadmap("## [a] A\nDo it.\nEffort: lo\nVerify: true\nFiles: /etc/passwd\n");
    expect(thin.warnings.map((w) => w.code)).toContain("thin-body");
    expect(thin.warnings.map((w) => w.code)).toContain("files-escape");
    const broken = lintRoadmap("## [a] A\nDepends: ghost\nVerify: true\n");
    expect(lintFailed(broken)).toBe(true);
    expect(broken.errors[0]!.code).toBe("parse");
  });

  test("findings format for humans", () => {
    expect(formatFinding({ level: "error", slice: "a", code: "no-verify", message: "add a gate" })).toBe(
      "error [no-verify] a: add a gate",
    );
  });
});
