import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { createRun, loadRun, readEvents } from "../src/store.ts";
import {
  applyIntent,
  drainIntents,
  latestSeq,
  parseIntentPayload,
  queueControl,
  requestControl,
  validateIntent,
} from "../src/control.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "ompo-ctl-"));
}

const MD = "## [a] A\nDo A.\nVerify: true\nRetries: 0\n\n## [b] B\nDo B.\nDepends: a\nVerify: true\n";

function holder(): { jobs: { value: number }; paused: boolean } {
  return { jobs: { value: 1 }, paused: false };
}

describe("validateIntent", () => {
  test("accepts every kind with its required fields", () => {
    expect(validateIntent({ kind: "retry", sliceId: "a" })).toBeNull();
    expect(validateIntent({ kind: "skip", sliceId: "a" })).toBeNull();
    expect(validateIntent({ kind: "park", sliceId: "a", reason: "db down" })).toBeNull();
    expect(validateIntent({ kind: "kill", sliceId: "a" })).toBeNull();
    expect(validateIntent({ kind: "set-jobs", jobs: 4 })).toBeNull();
    expect(validateIntent({ kind: "pause" })).toBeNull();
    expect(validateIntent({ kind: "resume" })).toBeNull();
  });

  test("rejects missing fields and out-of-range jobs", () => {
    expect(validateIntent({ kind: "retry" })).not.toBeNull();
    expect(validateIntent({ kind: "park", sliceId: "a" })).not.toBeNull();
    expect(validateIntent({ kind: "set-jobs", jobs: 0 })).not.toBeNull();
    expect(validateIntent({ kind: "set-jobs", jobs: 33 })).not.toBeNull();
    expect(validateIntent({ kind: "pause", sliceId: "a" })).not.toBeNull();
    expect(validateIntent({ kind: "nope" as never })).not.toBeNull();
  });
});

describe("request + drain", () => {
  test("round-trips through the event log with a moving offset", () => {
    const dir = tmpProject();
    const { runId } = createRun(dir, parseRoadmap(MD), "r");
    const start = latestSeq(dir, runId);
    const ev = requestControl(dir, runId, { kind: "skip", sliceId: "b" });
    expect(ev.type).toBe("control_requested");
    const first = drainIntents(dir, runId, start);
    expect(first.intents.map((i) => i.kind)).toEqual(["skip"]);
    const second = drainIntents(dir, runId, first.offset);
    expect(second.intents).toEqual([]);
    expect(second.offset).toBe(first.offset);
  });

  test("unknown slice fails at request time, not drain time", () => {
    const dir = tmpProject();
    const { runId } = createRun(dir, parseRoadmap(MD), "r");
    expect(() => requestControl(dir, runId, { kind: "kill", sliceId: "ghost" })).toThrow(/unknown slice/);
  });

  test("malformed payloads never surface from drain", () => {
    expect(parseIntentPayload({ seq: 0, at: "", type: "slice_done" })).toBeUndefined();
  });

  test("queueControl reports queued and failed on the sink", () => {
    const dir = tmpProject();
    const { runId } = createRun(dir, parseRoadmap(MD), "r");
    const lines: string[] = [];
    queueControl((m) => lines.push(m), dir, runId, { kind: "pause" });
    expect(lines.some((l) => l.includes("queued"))).toBe(true);
    queueControl((m) => lines.push(m), dir, runId, { kind: "pause", sliceId: "x" });
    expect(lines.some((l) => l.includes("failed"))).toBe(true);
  });
});

describe("applyIntent", () => {
  test("skip parks downstream-relevant slices without running", () => {
    const dir = tmpProject();
    const { runId } = createRun(dir, parseRoadmap(MD), "r");
    const res = applyIntent(dir, runId, { kind: "skip", sliceId: "b", seq: 1, at: "" }, holder());
    expect(res.ok).toBe(true);
    expect(loadRun(dir, runId).doc.slices.find((s) => s.id === "b")!.status).toBe("skipped");
  });

  test("kill on pending aborts; kill on done rejects without touching", () => {
    const dir = tmpProject();
    const { runId } = createRun(dir, parseRoadmap(MD), "r");
    const ok = applyIntent(dir, runId, { kind: "kill", sliceId: "a", seq: 1, at: "" }, holder());
    expect(ok.ok).toBe(true);
    const bad = applyIntent(dir, runId, { kind: "kill", sliceId: "a", seq: 2, at: "" }, holder());
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/cannot kill/);
  });

  test("park needs a reason and lands blocked-env; retry re-queues it as-is", () => {
    const dir = tmpProject();
    const { runId } = createRun(dir, parseRoadmap(MD), "r");
    const parked = applyIntent(dir, runId, { kind: "park", sliceId: "a", reason: "db down", seq: 1, at: "" }, holder());
    expect(parked.ok).toBe(true);
    const cur = loadRun(dir, runId).doc.slices.find((s) => s.id === "a")!;
    expect(cur.status).toBe("blocked-env");
    expect(cur.verdictRef).toContain("control-park.md");
    const retried = applyIntent(dir, runId, { kind: "retry", sliceId: "a", seq: 2, at: "" }, holder());
    expect(retried.ok).toBe(true);
    const back = loadRun(dir, runId).doc.slices.find((s) => s.id === "a")!;
    expect(back.status).toBe("pending");
    expect(back.maxRetries).toBe(0);
  });

  test("loop-local intents install on the holder", () => {
    const dir = tmpProject();
    const { runId } = createRun(dir, parseRoadmap(MD), "r");
    const h = holder();
    expect(applyIntent(dir, runId, { kind: "set-jobs", jobs: 4, seq: 1, at: "" }, h).ok).toBe(true);
    expect(h.jobs.value).toBe(4);
    expect(applyIntent(dir, runId, { kind: "pause", seq: 2, at: "" }, h).ok).toBe(true);
    expect(h.paused).toBe(true);
    expect(applyIntent(dir, runId, { kind: "resume", seq: 3, at: "" }, h).ok).toBe(true);
    expect(h.paused).toBe(false);
  });

  test("every outcome appends an applied/rejected audit event", () => {
    const dir = tmpProject();
    const { runId } = createRun(dir, parseRoadmap(MD), "r");
    applyIntent(dir, runId, { kind: "skip", sliceId: "b", seq: 1, at: "" }, holder());
    applyIntent(dir, runId, { kind: "skip", sliceId: "b", seq: 2, at: "" }, holder());
    const kinds = readEvents(dir, runId).map((e) => e.type);
    expect(kinds).toContain("control_applied");
    expect(kinds).toContain("control_rejected");
  });
});
