import { describe, expect, test } from "bun:test";
import { parseRoadmap } from "../src/parse.ts";
import {
  REVIEW_CLOSE,
  REVIEW_OPEN,
  ReviewValidationError,
  buildReviewFixPrompt,
  buildReviewPrompt,
  extractReviewFromOutput,
  formatReviewFinding,
  reviewBlockSkeleton,
  validateReviewVerdict,
} from "../src/review.ts";
import type { CompletionReport, Slice } from "../src/types.ts";

function sampleSlice(): Slice {
  const doc = parseRoadmap("## [a] A\nDo the slice thing.\nVerify: bun test\n");
  return doc.slices[0]!;
}

function sampleReport(): CompletionReport {
  return {
    sliceId: "a",
    summary: "implemented the slice thing",
    filesChanged: ["src/a.ts"],
    testsRun: ["bun test"],
    testsPassed: true,
    verificationNotes: "ran bun test, green",
    followUps: [],
    deferred: [],
    done: true,
  };
}

function verdictBlock(overrides: Record<string, unknown> = {}): string {
  return `${REVIEW_OPEN}\n${JSON.stringify({
    sliceId: "a",
    approved: true,
    findings: [],
    notes: "checked the tree, holds",
    ...overrides,
  })}\n${REVIEW_CLOSE}`;
}

describe("extractReviewFromOutput", () => {
  test("finds a verdict block in surrounding prose", () => {
    const out = `auditing now…\n${verdictBlock()}\nall done`;
    const parsed = extractReviewFromOutput(out) as { approved: boolean };
    expect(parsed).not.toBeUndefined();
    expect(parsed.approved).toBe(true);
  });

  test("last complete block wins (self-correcting reviewers)", () => {
    const out = `${verdictBlock({ approved: false, findings: ["wip"] })}\n` +
      `re-checked the file, it is there\n${verdictBlock({ approved: true })}`;
    const parsed = extractReviewFromOutput(out) as { approved: boolean };
    expect(parsed.approved).toBe(true);
  });

  test("malformed or absent block → undefined", () => {
    expect(extractReviewFromOutput("no markers at all")).toBeUndefined();
    expect(extractReviewFromOutput(`${REVIEW_OPEN}\n{not json}\n${REVIEW_CLOSE}`)).toBeUndefined();
    expect(extractReviewFromOutput(`${REVIEW_OPEN}\n${JSON.stringify({ ok: 1 })}`)).toBeUndefined();
  });
});

describe("validateReviewVerdict", () => {
  test("accepts a well-formed verdict and normalizes it", () => {
    const v = validateReviewVerdict(
      { sliceId: "a", approved: false, findings: ["x is wrong"], notes: "see finding" },
      "a",
    );
    expect(v.sliceId).toBe("a");
    expect(v.approved).toBe(false);
    expect(v.findings).toEqual(["x is wrong"]);
    expect(v.notes).toBe("see finding");
  });

  test("rejects wrong sliceId", () => {
    expect(() => validateReviewVerdict({ sliceId: "b", approved: true, findings: [], notes: "" }, "a")).toThrow(
      ReviewValidationError,
    );
  });

  test("rejects malformed fields with reasons", () => {
    let reasons: string[] = [];
    try {
      validateReviewVerdict({ sliceId: "a", approved: "yes", findings: "nope", notes: 7 }, "a");
    } catch (err) {
      reasons = (err as ReviewValidationError).reasons;
    }
    expect(reasons).toContain("approved must be boolean");
    expect(reasons).toContain("findings must be string[]");
    expect(reasons).toContain("notes must be a string");
  });

  test("rejects non-object payloads", () => {
    expect(() => validateReviewVerdict("a", "a")).toThrow(/verdict must be a JSON object/);
  });

  test("normalizes structured {file, behavior, spec} findings to strings", () => {
    const v = validateReviewVerdict(
      {
        sliceId: "a",
        approved: false,
        findings: [{ file: "qa/s1/report.md", behavior: "file does not exist", spec: "restore evidence required" }],
        notes: "checked the tree",
      },
      "a",
    );
    expect(v.approved).toBe(false);
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]).toContain("qa/s1/report.md");
    expect(v.findings[0]).toContain("file does not exist");
    expect(v.findings[0]).toContain("restore evidence required");
  });

  test("rejects approved=false with empty findings", () => {
    expect(() =>
      validateReviewVerdict({ sliceId: "a", approved: false, findings: [], notes: "no reason given" }, "a"),
    ).toThrow(/at least one entry in findings/);
  });

  test("formatReviewFinding renders objects without [object Object]", () => {
    const s = formatReviewFinding({ file: "f.ts", behavior: "missing", spec: "spec line" });
    expect(s).not.toContain("[object Object]");
    expect(s).toContain("f.ts");
    expect(formatReviewFinding(42)).toBeUndefined();
    expect(formatReviewFinding("  ")).toBeUndefined();
  });
});

describe("reviewBlockSkeleton", () => {
  test("round-trips through extract + validate as an approval", () => {
    const block = reviewBlockSkeleton("a");
    const parsed = extractReviewFromOutput(block);
    expect(parsed).not.toBeUndefined();
    const v = validateReviewVerdict(parsed, "a");
    expect(v.approved).toBe(true);
  });
});

describe("verdict severity", () => {
  test("minor parses as minor; absent or unknown parses as major (safe default)", () => {
    expect(validateReviewVerdict({ sliceId: "a", approved: false, findings: ["lint"], notes: "", severity: "minor" }, "a").severity).toBe("minor");
    expect(validateReviewVerdict({ sliceId: "a", approved: false, findings: ["wrong"], notes: "" }, "a").severity).toBe("major");
    expect(validateReviewVerdict({ sliceId: "a", approved: false, findings: ["wrong"], notes: "", severity: "critical" }, "a").severity).toBe("major");
    expect(validateReviewVerdict({ sliceId: "a", approved: true, findings: [], notes: "ok" }, "a").severity).toBe("major");
  });

  test("prompt teaches the minor/major rubric", () => {
    const prompt = buildReviewPrompt(sampleSlice(), sampleReport(), ["bun test"]);
    expect(prompt).toContain("minor");
    expect(prompt).toContain("one bounded fix");
    expect(prompt).toContain("When in doubt, major");
  });

  test("fix prompt scopes to the findings with the report contract", () => {
    const prompt = buildReviewFixPrompt(sampleSlice(), ["fix the name", "add the edge test"], 2);
    expect(prompt).toContain("fix the name");
    expect(prompt).toContain("add the edge test");
    expect(prompt).toContain("Fix ONLY the findings");
    expect(prompt).toContain('"a"');
    expect(prompt).toContain("done=false");
  });
});

describe("buildReviewPrompt", () => {
  test("presents spec, the worker claim, and gate commands to an independent auditor", () => {
    const slice = sampleSlice();
    const report = sampleReport();
    const prompt = buildReviewPrompt(slice, report, ["bun test"]);
    expect(prompt).toContain("Review slice: a — A");
    expect(prompt).toContain("Do the slice thing.");
    expect(prompt).toContain("implemented the slice thing");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("- bun test");
    expect(prompt).toContain("verify, do not trust");
    // Contract: exactly one verdict block, sliceId pinned.
    expect(prompt).toContain("print EXACTLY one verdict block");
    expect(prompt).toContain('"sliceId": "a"');
    expect(prompt).toContain("approved=false requires at least one\nentry in findings");
  });
  test("deferred live items are pre-approved exclusions, never findings", () => {
    const slice = sampleSlice();
    const report = { ...sampleReport(), deferred: ["Real KEY — needs owner key; manual check: one live call"] };
    const prompt = buildReviewPrompt(slice, report, ["bun test"]);
    expect(prompt).toContain("Real KEY");
    expect(prompt).toContain("pre-approved exclusions, NOT findings");
    expect(prompt).toContain("never reject for a deferred live value");
  });

});
