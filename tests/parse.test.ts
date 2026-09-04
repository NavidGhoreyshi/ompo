import { describe, expect, test } from "bun:test";
import { parseRoadmap, RoadmapParseError } from "../src/parse.ts";
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

  test("multiple Verify lines accumulate", () => {
    const doc = parseRoadmap(
      "## [a] A\nVerify: cmd one\nVerify: cmd two\n",
    );
    expect(doc.slices[0]!.verify).toEqual(["cmd one", "cmd two"]);
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
});
