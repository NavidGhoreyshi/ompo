import { describe, expect, test } from "bun:test";
import { resumeStalled } from "../src/select.ts";
import type { Slice, SliceStatus } from "../src/types.ts";

function s(id: string, status: SliceStatus, deps: string[] = []): Slice {
  return {
    id,
    title: id,
    body: "",
    deps,
    verify: [],
    files: [],
    maxRetries: 1,
    status,
    attempts: 1,
    updatedAt: "2026-09-07T08:00:00.000Z",
  };
}

describe("resumeStalled", () => {
  test("mid-roadmap failure dead-ends downstream pending slices", () => {
    expect(resumeStalled([s("a", "done"), s("b", "failed"), s("c", "pending", ["b"])])).toBe(true);
  });

  test("failed slice with independent runnable work still resumes", () => {
    expect(resumeStalled([s("a", "done"), s("b", "failed"), s("c", "pending", ["a"])])).toBe(false);
  });

  test("healthy runs never count as stalled", () => {
    expect(resumeStalled([s("a", "done"), s("b", "pending", ["a"])])).toBe(false);
    expect(resumeStalled([s("a", "done")])).toBe(false);
  });

  test("in-flight and blocked-env slices demote to runnable work", () => {
    expect(resumeStalled([s("a", "done"), s("b", "running", ["a"]), s("c", "failed")])).toBe(false);
    expect(resumeStalled([s("a", "done"), s("b", "aborted", ["a"]), s("c", "failed")])).toBe(false);
    expect(resumeStalled([s("a", "done"), s("b", "blocked-env", ["a"]), s("c", "failed")])).toBe(false);
  });

  test("blocked-env behind a failed dep stays stalled", () => {
    expect(resumeStalled([s("a", "done"), s("b", "failed"), s("c", "blocked-env", ["b"])])).toBe(true);
  });

  test("pending on an unknown dep is wedged with no runnable work", () => {
    expect(resumeStalled([s("a", "pending", ["ghost"])])).toBe(true);
  });
});
