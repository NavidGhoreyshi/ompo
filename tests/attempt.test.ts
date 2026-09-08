import { describe, expect, test } from "bun:test";
import { classifyFailure, maxRetriesFor } from "../src/attempt.ts";
import type { Slice } from "../src/types.ts";

function slice(over: Partial<Slice> = {}): Slice {
  return {
    id: "s1",
    title: "S",
    body: "Do S.",
    deps: [],
    files: [],
    verify: [],
    maxRetries: 1,
    attempts: 1,
    status: "pending",
    ...over,
  } as Slice;
}

describe("maxRetriesFor precedence", () => {
  test("CLI flag beats explicit trailer beats yml default beats parser default", () => {
    const explicit = slice({ maxRetries: 2, maxRetriesExplicit: true });
    expect(maxRetriesFor(explicit, { maxRetriesOverride: 5, cfg: { maxRetries: 3 } })).toBe(5);
    expect(maxRetriesFor(explicit, { cfg: { maxRetries: 3 } })).toBe(2);
    expect(maxRetriesFor(slice(), { cfg: { maxRetries: 3 } })).toBe(3);
    expect(maxRetriesFor(slice(), {})).toBe(1);
  });
});

describe("classifyFailure", () => {
  test("maps artifact refs to machine-readable causes", () => {
    expect(classifyFailure("slices/a/worker-1.log")).toBe("worker_failed");
    expect(classifyFailure("slices/a/report-1.invalid.json")).toBe("report_missing");
    expect(classifyFailure("slices/a/review-1.log")).toBe("review_rejected");
    expect(classifyFailure("slices/a/merge-1.conflict.txt")).toBe("merge_conflict");
    expect(classifyFailure("slices/a/unexpected-1.error.txt")).toBe("unexpected");
    expect(classifyFailure("slices/a/verdict.json")).toBe("failed");
  });
});
