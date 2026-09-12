/**
 * Live worker-output semantics: what the compact window is allowed to say,
 * how raw lines keep their identity across polls, and how follow behaves.
 *
 * These are the objective guarantees behind the Overview's live region:
 * ~5 meaningful rows by default, full history one click away, following
 * until the operator scrolls. Aesthetics need human eyes (captures/); the
 * behavior below does not.
 */

import { describe, expect, test } from "bun:test";
import { formatProgressLine } from "../src/attempt.ts";
import { progressLineForEvent } from "../src/worker.ts";
import type { RunEvent } from "../web/src/api.ts";
import {
  alignLineIds,
  buildLiveStream,
  compactWindow,
  eventEntry,
  followFromScroll,
  rawLine,
  semanticLine,
  COMPACT_ROWS,
  FOLLOW_SLOP,
} from "../web/src/lib/stream.ts";

function ev(partial: Partial<RunEvent> & { seq: number; type: string }): RunEvent {
  return { at: "2026-09-12T10:00:00.000Z", ...partial } as RunEvent;
}

describe("worker log line semantics", () => {
  test("the progress grammar renders as a concise action", () => {
    expect(semanticLine("  [s2-meta] tool read: src/api/webhook.ts")).toEqual({
      kind: "read",
      tag: "read",
      text: "read src/api/webhook.ts",
    });
    expect(semanticLine("  [s2-meta] tool glob: src/**/*.ts")).toEqual({
      kind: "read",
      tag: "glob",
      text: "glob src/**/*.ts",
    });
    // A shell call reads as the command itself.
    expect(semanticLine("  [s2-meta] tool bash: bun typecheck")).toEqual({
      kind: "run",
      tag: "run",
      text: "bun typecheck",
    });
    // Tagged (review/verify) transcripts strip the whole prefix.
    expect(semanticLine("  [s4-orders verify] tool bash: bun lint")).toEqual({
      kind: "run",
      tag: "run",
      text: "bun lint",
    });
  });

  test("turn boundaries keep their counts", () => {
    expect(semanticLine("  [s1] turn 9 done (2 tool results)")).toEqual({
      kind: "turn",
      tag: "turn",
      text: "turn 9 completed",
      meta: "2 tool results",
    });
    expect(semanticLine("  [s1] turn 10…")).toEqual({ kind: "turn", tag: "turn", text: "turn 10 started" });
    expect(semanticLine("  [s1] turn 3 done")).toEqual({ kind: "turn", tag: "turn", text: "turn 3 completed", meta: undefined });
  });

  test("attention lines are marked, not hidden", () => {
    expect(semanticLine("  [s1] tool edit FAILED")).toEqual({ kind: "fail", tag: "edit", text: "edit failed" });
    expect(semanticLine("  [s1] retrying: provider error 429")?.kind).toBe("warn");
    expect(semanticLine("  [s1] model fallback deep-a -> deep-b")).toEqual({
      kind: "warn",
      tag: "model",
      text: "model fallback deep-a → deep-b",
    });
    expect(semanticLine("  [s1] (no worker output for 7m — still waiting)")?.kind).toBe("warn");
  });

  test("the worker trailer becomes one exit row", () => {
    expect(semanticLine("exit=1 timedOut=false durationMs=65000")).toEqual({
      kind: "event",
      tag: "worker",
      text: "worker exited 1",
      meta: "1m 5s",
    });
    // Structural markers carry no content of their own.
    expect(semanticLine("--- stdout ---")).toBeNull();
    expect(semanticLine("   ")).toBeNull();
  });

  test("long commands and paths stay compact rows, not transcript lines", () => {
    const long = "x".repeat(400);
    expect(semanticLine(`  [s1] tool bash: bun test --filter ${long}`)?.text.length).toBeLessThanOrEqual(110);
    expect(semanticLine(`  [s1] tool read: src/${long}.ts`)?.text.length).toBeLessThanOrEqual(115);
    expect(semanticLine(long)?.text.length).toBeLessThanOrEqual(140);
  });

  test("unrecognized output stays raw so the compact window can set it aside", () => {
    const raw = semanticLine('{"type":"message","content":"hello"}');
    expect(raw?.kind).toBe("raw");
    expect(raw?.text.length).toBeGreaterThan(0);
  });
});

describe("line identity across polls", () => {
  test("appended lines continue the numbering", () => {
    const first = { lines: ["a", "b"], ids: [0, 1] };
    expect(alignLineIds(first, ["a", "b", "c"])).toEqual([0, 1, 2]);
  });

  test("a shifted window keeps ids for surviving lines", () => {
    const first = { lines: ["a", "b", "c", "d"], ids: [0, 1, 2, 3] };
    // The tail window slid by two: "c"/"d" survive, "e" is new.
    expect(alignLineIds(first, ["c", "d", "e"])).toEqual([2, 3, 4]);
  });

  test("identical window is stable, first poll starts at zero", () => {
    expect(alignLineIds({ lines: [], ids: [] }, ["a", "b"])).toEqual([0, 1]);
    expect(alignLineIds({ lines: ["a"], ids: [7] }, ["a"])).toEqual([7]);
  });

  test("a rotated file never reuses an ordinal", () => {
    // New generation log: nothing matches, ids continue rather than collide.
    expect(alignLineIds({ lines: ["a", "b"], ids: [0, 1] }, ["x", "y"])).toEqual([2, 3]);
  });

  test("repeated lines inside a window do not confuse alignment", () => {
    const first = { lines: ["same", "same"], ids: [4, 5] };
    expect(alignLineIds(first, ["same", "same", "same"])).toEqual([4, 5, 6]);
  });
});

describe("live stream composition", () => {
  const lines = ["  [s1] turn 1…", "  [s1] tool read: src/a.ts", "  [s1] tool bash: bun test"];
  const ids = [0, 1, 2];

  test("what opens a generation sits above its output, what follows sits below", () => {
    const events = [
      ev({ seq: 1, type: "slice_claimed", sliceId: "s1", attempt: 2 }),
      ev({ seq: 2, type: "worker_finished", sliceId: "s1", exit: 0, durationMs: 5000 }),
      ev({ seq: 3, type: "verify_passed", sliceId: "s1" }),
    ];
    const stream = buildLiveStream({ events, sliceId: "s1", lines, ids, logName: "worker-1-g0.log" });
    expect(stream.map((e) => e.text)).toEqual([
      "attempt 2",
      "turn 1 started",
      "read src/a.ts",
      "bun test",
      "worker finished", // reason absent → the verb is the text
      "verify passed",
    ]);
    expect(stream[0]!.tag).toBe("claim");
    expect(stream.at(-1)!.kind).toBe("event");
  });

  test("other slices stay out; run-level events stay in", () => {
    const events = [
      ev({ seq: 1, type: "slice_claimed", sliceId: "other" }),
      ev({ seq: 2, type: "run_resumed" }),
      ev({ seq: 3, type: "slice_claimed", sliceId: "s1" }),
    ];
    const stream = buildLiveStream({ events, sliceId: "s1", lines: [], ids: [], logName: null });
    expect(stream.map((e) => e.key)).toEqual(["e:2", "e:3"]);
  });

  test("a failure reason leads the row", () => {
    const events = [ev({ seq: 9, type: "verify_failed", sliceId: "s1", reason: "gate bun test failed" })];
    const stream = buildLiveStream({ events, sliceId: "s1", lines: [], ids: [], logName: null });
    expect(stream[0]!.kind).toBe("fail");
    expect(stream[0]!.tag).toBe("verify");
    expect(stream[0]!.text).toBe("gate bun test failed");
    expect(stream[0]!.meta).toContain("10:00:00");
  });

  test("log rows keep stable keys derived from line identity", () => {
    const stream = buildLiveStream({ events: [], sliceId: "s1", lines, ids, logName: "worker-1-g0.log" });
    expect(stream.map((e) => e.key)).toEqual([
      "l:worker-1-g0.log:0",
      "l:worker-1-g0.log:1",
      "l:worker-1-g0.log:2",
    ]);
  });

  test("events from before the current generation never rank below live output", () => {
    // Attempt 1 failed, the slice was retried (an opener), and attempt 2 is
    // producing output. The old failure rows must not read as newer than it.
    const events = [
      ev({ seq: 1, type: "verify_failed", sliceId: "s1", reason: "gate bun test failed" }),
      ev({ seq: 2, type: "worker_finished", sliceId: "s1", exit: 1 }),
      ev({ seq: 3, type: "slice_retried", sliceId: "s1" }),
      ev({ seq: 4, type: "verify_failed", sliceId: "s1", reason: "gate lint failed" }),
    ];
    const stream = buildLiveStream({ events, sliceId: "s1", lines, ids, logName: "worker-1-g1.log" });
    expect(stream.map((e) => e.text)).toEqual([
      "retried",
      "turn 1 started",
      "read src/a.ts",
      "bun test",
      "gate lint failed",
    ]);
  });

  test("with no generation opener in the buffer, recent events still stand", () => {
    const events = [ev({ seq: 7, type: "control_applied", sliceId: "s1", reason: "skip w1a" })];
    const stream = buildLiveStream({ events, sliceId: "s1", lines: [], ids: [], logName: null });
    expect(stream.map((e) => e.key)).toEqual(["e:7"]);
  });

  test("no slice means no stream", () => {
    expect(buildLiveStream({ events: [], sliceId: null, lines, ids, logName: null })).toEqual([]);
  });
});

describe("compact window", () => {
  const entry = (key: string, kind: string, line?: number) => ({
    key,
    kind: kind as never,
    tag: "t",
    text: key,
    line,
  });

  test("shows only the newest meaningful rows", () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry(`l${i}`, "read", i));
    const window = compactWindow(entries);
    expect(window.length).toBe(COMPACT_ROWS);
    expect(window.map((e) => e.key)).toEqual(["l7", "l8", "l9", "l10", "l11"]);
  });

  test("raw output newer than every meaningful row is still shown", () => {
    const entries = [
      entry("l0", "read", 0),
      entry("l1", "turn", 1),
      entry("l2", "raw", 2),
      entry("l3", "raw", 3),
    ];
    expect(compactWindow(entries).map((e) => e.key)).toEqual(["l0", "l1", "l3"]);
  });

  test("raw output older than the newest action does not crowd it out", () => {
    const entries = [entry("l0", "raw", 0), entry("l1", "read", 1), entry("l2", "read", 2), entry("l3", "turn", 3)];
    expect(compactWindow(entries).map((e) => e.key)).toEqual(["l1", "l2", "l3"]);
  });

  test("a window of nothing is empty", () => {
    expect(compactWindow([])).toEqual([]);
  });
});

describe("the web parser reads what the worker writes", () => {
  // One grammar, two readers (TUI bus and this browser parser). The worker's
  // emitter is the source of truth: every line it can produce must land as a
  // semantic row, never as opaque "raw" output the compact window sets aside.
  test("every progress line the worker emits parses as a semantic row", () => {
    const state = { turn: 0 };
    const events: unknown[] = [
      { type: "turn_start" },
      { type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } },
      { type: "tool_execution_start", toolName: "bash", args: { command: "bun test" } },
      { type: "tool_execution_start", toolName: "weird" },
      { type: "tool_execution_end", toolName: "bash", isError: true },
      { type: "auto_retry_start", errorMessage: "provider error 429" },
      { type: "auto_retry_end", success: true },
      { type: "auto_retry_end", success: false },
      { type: "retry_fallback_applied", from: "model-a", to: "model-b" },
      { type: "notice", level: "warn", message: "careful" },
      { type: "turn_end", toolResults: [{}, {}] },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello world" }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<<<OMPO_REPORT" }] } },
    ];
    for (const event of events) {
      const emitted = progressLineForEvent(event, state);
      if (emitted === undefined) continue;
      const row = semanticLine(formatProgressLine("s1", undefined, emitted));
      expect({ emitted, kind: row?.kind }).toEqual({ emitted, kind: expect.not.stringMatching(/^raw$/) });
    }
  });
});

describe("expanded rows keep the raw line", () => {
  test("the written text survives, colored by its kind", () => {
    const row = rawLine("  [s1] tool bash: bun test", 4, "worker-1-g0.log");
    expect(row).toEqual({ key: "l:worker-1-g0.log:4", kind: "run", tag: "run", text: "tool bash: bun test" });
  });

  test("structure markers and opaque output are rendered as written", () => {
    expect(rawLine("--- stdout ---", 0, "w.log").text).toBe("--- stdout ---");
    expect(rawLine('{"json":true}', 1, "w.log").kind).toBe("raw");
  });
});

describe("follow behavior", () => {
  test("at the bottom keeps following", () => {
    expect(followFromScroll(0)).toBe(true);
    expect(followFromScroll(FOLLOW_SLOP)).toBe(true);
  });

  test("scrolling away from the bottom stops following", () => {
    expect(followFromScroll(FOLLOW_SLOP + 1)).toBe(false);
    expect(followFromScroll(4000)).toBe(false);
  });

  test("an unmeasurable scroll box never claims the operator left", () => {
    expect(followFromScroll(Number.NaN)).toBe(true);
  });
});

describe("lifecycle event rows", () => {
  test("unknown event types are left out entirely", () => {
    expect(eventEntry(ev({ seq: 1, type: "something_else", sliceId: "s1" }))).toBeNull();
  });

  test("control outcomes carry their concise intent", () => {
    const applied = eventEntry(
      ev({ seq: 3, type: "control_applied", sliceId: "s1", detail: "retry: re-queued slice s1" }),
    );
    expect(applied?.tag).toBe("control");
    expect(applied?.text).toBe("control applied");
    expect(applied?.meta).toContain("retry: re-queued slice s1");
    // A requested intent arrives as JSON; the compact window shows its
    // concise form, never the blob.
    const requested = eventEntry(
      ev({
        seq: 4,
        type: "control_requested",
        sliceId: "s1",
        detail: JSON.stringify({ kind: "park", sliceId: "s1", reason: "waiting on deploy freeze" }),
      }),
    );
    expect(requested?.meta).toContain("park s1 — waiting on deploy freeze");
    expect(requested?.meta).not.toContain("{");
  });

  test("other structured payloads are summarized, never dumped", () => {
    const row = eventEntry(ev({ seq: 5, type: "roadmap_replanned", detail: '{"slices":[1,2,3]}' }));
    expect(row?.meta).toContain("structured payload");
    expect(row?.meta).not.toContain("slices");
  });
});
