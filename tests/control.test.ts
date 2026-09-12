import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { startDashboardServer } from "../src/server.ts";
import { replayRun } from "../src/stats.ts";
import { acquireLock, createRun, loadRun, readEvents, releaseLock, storeApi } from "../src/store.ts";
import {
  applyIntent,
  drainIntents,
  latestSeq,
  parseIntentPayload,
  queueControl,
  quiescentLoopLocalRejection,
  requestControl,
  validateIntent,
} from "../src/control.ts";
// The sandbox sets HTTP(S)_PROXY without NO_PROXY; loopback test traffic
// must not go through the proxy.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

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
    expect(validateIntent({ kind: "restart-loop", reason: "wedged: no output 20m" })).toBeNull();
  });

  test("rejects missing fields and out-of-range jobs", () => {
    expect(validateIntent({ kind: "retry" })).not.toBeNull();
    expect(validateIntent({ kind: "park", sliceId: "a" })).not.toBeNull();
    expect(validateIntent({ kind: "set-jobs", jobs: 0 })).not.toBeNull();
    expect(validateIntent({ kind: "set-jobs", jobs: 33 })).not.toBeNull();
    expect(validateIntent({ kind: "pause", sliceId: "a" })).not.toBeNull();
    expect(validateIntent({ kind: "restart-loop" })).not.toBeNull();
    expect(validateIntent({ kind: "restart-loop", sliceId: "a", reason: "x" })).not.toBeNull();
  });
});
describe("quiescentLoopLocalRejection", () => {
  test("slice intents need no live loop", () => {
    for (const kind of ["retry", "skip", "park", "kill"] as const) {
      expect(quiescentLoopLocalRejection(kind, "r")).toBeNull();
    }
  });

  test("loop-local intents name the run-resume recovery", () => {
    for (const kind of ["set-jobs", "pause", "resume"] as const) {
      const msg = quiescentLoopLocalRejection(kind, "r")!;
      expect(msg).toContain("needs a live loop");
      expect(msg).toContain("ompo resume --run r");
    }
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
  test("restart-loop never applies through the loop itself", () => {
    const dir = tmpProject();
    const { runId } = createRun(dir, parseRoadmap(MD), "r");
    const res = applyIntent(dir, runId, { kind: "restart-loop", reason: "wedged", seq: 1, at: "" }, holder());
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/replaces the loop itself/);
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

async function postControl(url: string, runId: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}/api/runs/${runId}/control`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function bodyMessage(body: unknown): string {
  if (body !== null && typeof body === "object" && "message" in body) {
    const message = body.message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

function bodySeq(body: unknown): number {
  if (body !== null && typeof body === "object" && "seq" in body) {
    const seq = body.seq;
    if (typeof seq === "number") return seq;
  }
  throw new Error("control response has no numeric seq");
}

/** Fail slice a once so operator retry has a terminal slice to re-queue. */
function failSliceA(dir: string, runId: string): void {
  storeApi.claimSlice(dir, runId, "a");
  storeApi.terminalFail(dir, runId, "a", "gate red");
}

describe("browser control path (POST /api/runs/:runId/control)", () => {
  test("browser retry behaves exactly like CLI retry on a quiescent run", async () => {
    // Browser side: POST retry through the dashboard server.
    const browserDir = tmpProject();
    createRun(browserDir, parseRoadmap(MD), "r");
    failSliceA(browserDir, "r");
    const server = startDashboardServer({ projectDir: browserDir });
    try {
      const res = await postControl(server.url, "r", { kind: "retry", sliceId: "a" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, applied: "direct" });
    } finally {
      server.stop();
    }
    const browserSlice = loadRun(browserDir, "r").doc.slices.find((s) => s.id === "a")!;
    expect(browserSlice.status).toBe("pending");
    // Failed slices get exactly one more attempt: budget raised to attempts.
    expect(browserSlice.maxRetries).toBe(browserSlice.attempts);
    const browserKinds = readEvents(browserDir, "r").map((e) => e.type);
    expect(browserKinds).toContain("control_requested");
    expect(browserKinds).toContain("control_applied");
    expect(browserKinds).toContain("slice_retried");

    // CLI side: the cmdDirectControl sequence (request → drain → apply).
    const cliDir = tmpProject();
    createRun(cliDir, parseRoadmap(MD), "r");
    failSliceA(cliDir, "r");
    const before = latestSeq(cliDir, "r");
    requestControl(cliDir, "r", { kind: "retry", sliceId: "a" });
    const { intents } = drainIntents(cliDir, "r", before);
    expect(intents.map((i) => i.kind)).toEqual(["retry"]);
    const outcome = applyIntent(cliDir, "r", intents[0]!, holder());
    expect(outcome.ok).toBe(true);
    const cliSlice = loadRun(cliDir, "r").doc.slices.find((s) => s.id === "a")!;
    expect(cliSlice.status).toBe(browserSlice.status);
    expect(cliSlice.maxRetries).toBe(browserSlice.maxRetries);
    expect(cliSlice.attempts).toBe(browserSlice.attempts);
    expect(readEvents(cliDir, "r").map((e) => e.type)).toEqual(browserKinds);
  });

  test("stale browser intents reject without duplicate execution", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    failSliceA(dir, "r");
    const server = startDashboardServer({ projectDir: dir });
    try {
      const first = await postControl(server.url, "r", { kind: "retry", sliceId: "a" });
      expect(first.body).toMatchObject({ ok: true, applied: "direct" });
      const attemptsAfterRetry = loadRun(dir, "r").doc.slices.find((s) => s.id === "a")!.attempts;
      // The slice is pending again: a second retry is stale (needs failed/blocked-env).
      const stale = await postControl(server.url, "r", { kind: "retry", sliceId: "a" });
      expect(stale.status).toBe(200);
      expect(stale.body).toMatchObject({ ok: false, applied: "direct" });
      expect(bodyMessage(stale.body)).toMatch(/cannot operator-retry/);
      const cur = loadRun(dir, "r").doc.slices.find((s) => s.id === "a")!;
      expect(cur.status).toBe("pending");
      expect(cur.attempts).toBe(attemptsAfterRetry);
      // Exactly one slice_retried: the stale intent appended control_rejected, never re-ran.
      const events = readEvents(dir, "r");
      expect(events.filter((e) => e.type === "slice_retried")).toHaveLength(1);
      expect(events.filter((e) => e.type === "control_rejected")).toHaveLength(1);
      // Kill on a terminal-adjacent slice is stale too: skip b, then kill b rejects.
      expect((await postControl(server.url, "r", { kind: "skip", sliceId: "b" })).body).toMatchObject({ ok: true });
      const killSkipped = await postControl(server.url, "r", { kind: "kill", sliceId: "b" });
      expect(killSkipped.body).toMatchObject({ ok: false, applied: "direct" });
      expect(bodyMessage(killSkipped.body)).toMatch(/cannot kill/);
      expect(loadRun(dir, "r").doc.slices.find((s) => s.id === "b")!.status).toBe("skipped");
    } finally {
      server.stop();
    }
  });

  test("control events stay replayable and visible on the browser read path", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    failSliceA(dir, "r");
    const server = startDashboardServer({ projectDir: dir });
    try {
      await postControl(server.url, "r", { kind: "retry", sliceId: "a" });
      await postControl(server.url, "r", { kind: "retry", sliceId: "a" });
      // control_* audit events never move slice status: replay stays clean.
      const replay = replayRun(dir, "r");
      expect(replay.mismatches).toEqual([]);
      // The browser observes its own outcomes by replaying the event log.
      const res = await fetch(`${server.url}/api/runs/r/events?types=control_requested,control_applied,control_rejected&limit=50`);
      expect(res.status).toBe(200);
      const page: unknown = await res.json();
      if (page === null || typeof page !== "object" || !("events" in page) || !("offset" in page)) {
        throw new Error("events page has no events/offset");
      }
      const { events: pageEvents, offset } = page;
      if (!Array.isArray(pageEvents) || typeof offset !== "number") throw new Error("malformed events page");
      const kinds: unknown[] = pageEvents.map((e: unknown) => {
        if (e !== null && typeof e === "object" && "type" in e) return e.type;
        return undefined;
      });
      expect(kinds).toContain("control_requested");
      expect(kinds).toContain("control_applied");
      expect(kinds).toContain("control_rejected");
      expect(offset).toBe(readEvents(dir, "r").at(-1)!.seq);
    } finally {
      server.stop();
    }
  });

  test("live run: web and TUI share one intent log, the loop applies both", async () => {
    const dir = tmpProject();
    createRun(dir, parseRoadmap(MD), "r");
    failSliceA(dir, "r");
    acquireLock(dir, "r");
    const server = startDashboardServer({ projectDir: dir });
    try {
      const queued = await postControl(server.url, "r", { kind: "retry", sliceId: "a" });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ kind: "retry", sliceId: "a", applied: "queued" });
      expect(bodySeq(queued.body)).toBe(readEvents(dir, "r").at(-1)!.seq);
      expect(loadRun(dir, "r").doc.slices.find((s) => s.id === "a")!.status).toBe("failed");
      expect(readEvents(dir, "r").map((e) => e.type)).not.toContain("control_applied");
      // TUI enqueues on the same log through queueControl (ompo ctl semantics).
      const lines: string[] = [];
      queueControl((m) => lines.push(m), dir, "r", { kind: "skip", sliceId: "b" });
      expect(lines.some((l) => l.includes("queued"))).toBe(true);
      // The existing loop drains after its offset and applies in seq order.
      const offset = bodySeq(queued.body) - 1;
      const { intents } = drainIntents(dir, "r", offset);
      expect(intents.map((i) => `${i.kind}:${i.sliceId}:${i.seq}`)).toEqual([
        `retry:a:${bodySeq(queued.body)}`,
        `skip:b:${bodySeq(queued.body) + 1}`,
      ]);
      const h = holder();
      for (const intent of intents) expect(applyIntent(dir, "r", intent, h).ok).toBe(true);
      expect(loadRun(dir, "r").doc.slices.find((s) => s.id === "a")!.status).toBe("pending");
      expect(loadRun(dir, "r").doc.slices.find((s) => s.id === "b")!.status).toBe("skipped");
      // Quiescent loop-local controls stay rejected without orphan events (cmdCtl parity).
      releaseLock(dir, "r");
      const eventsBefore = readEvents(dir, "r").length;
      const pause = await postControl(server.url, "r", { kind: "pause" });
      expect(pause.body).toMatchObject({ ok: false, applied: "direct" });
      expect(bodyMessage(pause.body)).toContain("ompo resume --run r");
      expect(readEvents(dir, "r")).toHaveLength(eventsBefore);
    } finally {
      releaseLock(dir, "r");
      server.stop();
    }
  });
});
