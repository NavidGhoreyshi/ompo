import { describe, expect, test } from "bun:test";
import { parseRoadmap, RoadmapParseError, splitGateChain } from "../src/parse.ts";
import { nextReady, readySlices } from "../src/select.ts";

const VALID = `# Demo roadmap

## [a] First slice
Do the thing.

## [b] Second slice
Do the next thing.
Depends: a
Agent: task
Effort: hi
Verify: bun test -- scope
Files: src/a.ts, src/b.ts
Retries: 2
`;

describe("parseRoadmap", () => {
  test("parses ids, trailers, defaults", () => {
    const doc = parseRoadmap(VALID);
    expect(doc.slices).toHaveLength(2);
    expect(doc.slices[0]!.id).toBe("a");
    expect(doc.slices[0]!.status).toBe("pending");
    expect(doc.slices[0]!.deps).toEqual([]);
    expect(doc.slices[0]!.maxRetries).toBe(1);
    const b = doc.slices[1]!;
    expect(b.deps).toEqual(["a"]);
    expect(b.workerAgent).toBe("task");
    expect(b.effort).toBe("hi");
    expect(b.verify).toEqual(["bun test -- scope"]);
    expect(b.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(b.maxRetries).toBe(2);
    expect(b.body).toContain("Do the next thing.");
    expect(b.body).not.toContain("Depends:");
  });

  test("slugifies headings without explicit ids", () => {
    const doc = parseRoadmap("## Hello, World!\nbody\n");
    expect(doc.slices[0]!.id).toBe("hello-world");
    expect(doc.slices[0]!.title).toBe("Hello, World!");
  });

  test("rejects duplicate ids", () => {
    expect(() =>
      parseRoadmap("## [a] One\nx\n## [a] Two\ny\n"),
    ).toThrow(RoadmapParseError);
  });

  test("rejects unknown deps", () => {
    expect(() =>
      parseRoadmap("## [a] One\nDepends: nope\n"),
    ).toThrow(/unknown dependency/);
  });

  test("rejects cycles", () => {
    expect(() =>
      parseRoadmap("## [a] A\nDepends: b\n## [b] B\nDepends: a\n"),
    ).toThrow(/cycle/);
  });

  test("rejects bad effort and retries", () => {
    expect(() => parseRoadmap("## [a] A\nEffort: ultra\n")).toThrow(
      /Effort must be/,
    );
    expect(() => parseRoadmap("## [a] A\nRetries: 99\n")).toThrow(
      /Retries must be/,
    );
  });

  test("Skip trailer marks skipped", () => {
    const doc = parseRoadmap("## [a] A\nSkip: true\n");
    expect(doc.slices[0]!.status).toBe("skipped");
  });

  test("Timeout trailer parses durations to ms", () => {
    const doc = parseRoadmap("## [a] A\nTimeout: 60m\n");
    expect(doc.slices[0]!.timeoutMs).toBe(3600000);
    expect(parseRoadmap("## [a] A\nTimeout: 90\n").slices[0]!.timeoutMs).toBe(90000);
    expect(parseRoadmap("## [a] A\nTimeout: 2h\n").slices[0]!.timeoutMs).toBe(7200000);
    expect(parseRoadmap("## [a] A\nDo it.\n").slices[0]!.timeoutMs).toBeUndefined();
  });

  test("Timeout rejects garbage and out-of-range", () => {
    expect(() => parseRoadmap("## [a] A\nTimeout: soon\n")).toThrow(/Timeout/);
    expect(() => parseRoadmap("## [a] A\nTimeout: 10s\n")).toThrow(/1m\.\.8h/);
    expect(() => parseRoadmap("## [a] A\nTimeout: 24h\n")).toThrow(/1m\.\.8h/);
  });

  test("multiple Verify lines accumulate", () => {
    const doc = parseRoadmap(
      "## [a] A\nVerify: cmd one\nVerify: cmd two\n",
    );
    expect(doc.slices[0]!.verify).toEqual(["cmd one", "cmd two"]);
  });

  test("trailer-like lines in fenced blocks stay in the body", () => {
    const doc = parseRoadmap(
      "## [a] A\nBody line.\n```\nVerify: not a command\nDepends: nope\n```\nVerify: bun test\n",
    );
    const a = doc.slices[0]!;
    expect(a.verify).toEqual(["bun test"]);
    expect(a.deps).toEqual([]);
    expect(a.body).toContain("Verify: not a command");
  });

  test("Retries trailer records explicitness", () => {
    const doc = parseRoadmap("## [a] A\nRetries: 0\n## [b] B\nBody\n");
    expect(doc.slices[0]!.maxRetries).toBe(0);
    expect(doc.slices[0]!.maxRetriesExplicit).toBe(true);
    expect(doc.slices[1]!.maxRetriesExplicit).toBeUndefined();
  });

  test("Verify lines split on top-level && into separately-reported gates", () => {
    const doc = parseRoadmap("## [a] A\nVerify: bun test && bun lint\n");
    expect(doc.slices[0]!.verify).toEqual(["bun test", "bun lint"]);
  });
});

describe("splitGateChain", () => {
  test("single commands pass through untouched", () => {
    expect(splitGateChain("bun test -- scope")).toEqual(["bun test -- scope"]);
  });

  test("quoted && never splits (the state-sharing escape hatch)", () => {
    expect(splitGateChain(`sh -c 'cd e2e && bunx playwright test'`)).toEqual([`sh -c 'cd e2e && bunx playwright test'`]);
    expect(splitGateChain(`echo "a && b" && echo done`)).toEqual([`echo "a && b"`, "echo done"]);
  });

  test("|| never splits and empties drop", () => {
    expect(splitGateChain("test || true")).toEqual(["test || true"]);
    expect(splitGateChain("a &&  && b")).toEqual(["a", "b"]);
  });
});

describe("selector", () => {
  test("gates on deps in roadmap order", () => {
    const doc = parseRoadmap(VALID);
    expect(nextReady(doc)!.id).toBe("a");
    doc.slices[0]!.status = "done";
    expect(nextReady(doc)!.id).toBe("b");
    doc.slices[1]!.status = "done";
    expect(nextReady(doc)).toBeNull();
  });

  test("skips non-pending slices", () => {
    const doc = parseRoadmap(
      "## [a] A\n## [b] B\nDepends: a\n## [c] C\n",
    );
    doc.slices[0]!.status = "failed";
    // b blocked (dep not done), c ready
    expect(readySlices(doc).map((s) => s.id)).toEqual(["c"]);
  });

  test("skipped dep satisfies downstream", () => {
    const doc = parseRoadmap(
      "## [a] A\nSkip: true\n## [b] B\nDepends: a\n",
    );
    expect(readySlices(doc).map((s) => s.id)).toEqual(["b"]);
  });

  test("failed dep still blocks downstream", () => {
    const doc = parseRoadmap(
      "## [a] A\n## [b] B\nDepends: a\n",
    );
    doc.slices[0]!.status = "failed";
    expect(nextReady(doc)).toBeNull();
  });
});
