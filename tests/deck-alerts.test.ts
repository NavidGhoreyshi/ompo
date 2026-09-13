/**
 * The alert policy (roadmap slice `d05`, §D.8), tested without a browser.
 *
 * The claims pinned here are the ones that decide whether an operator can
 * trust the stack:
 *
 * 1. **One alert per condition, not one per event.** A slice that failed after
 *    twenty failing gates is one row with one message.
 * 2. **The taxonomy is the DTOs'.** `failed`/`blocked-env` come from
 *    `SliceSummary.status`, `wedged` from `AgentRow.wedged`,
 *    `verdict-stall`/`review-rejected` from `SliceDetail`, `double-loop` from
 *    `RunDetail.loops` — nothing is inferred from a log line the server did not
 *    already derive, and the advisory kind never says "stuck".
 * 3. **Dismissal is per instance and recurrence re-raises.** The key includes
 *    the evidence seq, so acknowledging a condition clears *that* alarm, and
 *    the next failure/wedge is a new key.
 */

import { describe, expect, test } from "bun:test";
import type { RunEvent, SliceDetail } from "../web/src/api.ts";
import {
  activeAlerts,
  alertKey,
  appendDismissed,
  deriveAlerts,
  DISMISSED_CAP,
  dismissKey,
  parseDismissed,
  SEVERITY_RANK,
  type AlertAgent,
  type AlertInput,
  type AlertSlice,
  type DeckAlert,
} from "../web/src/scene/alerts.ts";

const AT = "2026-09-13T00:00:00.000Z";

function slice(id: string, status: string, extra: Partial<AlertSlice> = {}): AlertSlice {
  return { id, status, attempts: 1, ...extra };
}

function event(seq: number, type: string, sliceId: string, extra: Partial<RunEvent> = {}): RunEvent {
  return { seq, at: AT, type, sliceId, ...extra };
}

function input(overrides: Partial<AlertInput> = {}): AlertInput {
  return { slices: [], agents: [], events: [], sliceDetail: null, loops: [], ...overrides };
}

function detail(extra: Partial<SliceDetail> = {}): SliceDetail {
  return {
    sliceId: "a",
    title: "A",
    status: "running",
    attempts: 2,
    generation: 1,
    verify: [],
    deps: [],
    recentEvents: [],
    history: [],
    artifacts: { report: false, verdict: false, review: false, workerLog: false, prompt: false },
    ...extra,
  };
}

const kinds = (alerts: DeckAlert[]): string[] => alerts.map((alert) => alert.kind);

describe("deriveAlerts: one condition, one alert", () => {
  test("a failed slice is one high alert with its reason, however many events it has", () => {
    const events = [
      ...Array.from({ length: 20 }, (_, i) => event(i + 1, "verify_failed", "a", { reason: `gate ${i}` })),
      event(21, "slice_failed_terminal", "a", { reason: "retries exhausted" }),
    ];
    const alerts = deriveAlerts(input({ slices: [slice("a", "failed", { reason: "retries exhausted" })], events }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "failed", severity: "high", sliceId: "a", lastSeq: 21 });
    expect(alerts[0]?.message).toBe("retries exhausted");
  });

  test("a terminal failure never also reads as a retry", () => {
    const events = [event(1, "verify_failed", "a", { reason: "bun test failed" }), event(2, "slice_failed_terminal", "a")];
    const alerts = deriveAlerts(input({ slices: [slice("a", "failed", { reason: "gate bun test" })], events }));
    expect(kinds(alerts)).toEqual(["failed"]);
  });

  test("a slice retrying after a gate failure carries the attempt and the gate reason", () => {
    const events = [event(7, "verify_failed", "a", { attempt: 2, reason: "bun test --coverage" })];
    const alerts = deriveAlerts(input({ slices: [slice("a", "running")], events }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "verify-failed", severity: "medium", lastSeq: 7 });
    expect(alerts[0]?.message).toBe("attempt 2 gate failed — bun test --coverage");
  });

  test("a slice that never failed a gate, and a done slice, raise nothing", () => {
    expect(deriveAlerts(input({ slices: [slice("a", "running"), slice("b", "done")], events: [event(1, "slice_claimed", "b")] }))).toEqual([]);
  });

  test("blocked-env is high and carries the reason the server gives", () => {
    const alerts = deriveAlerts(input({ slices: [slice("e", "blocked-env", { reason: "no OMP_KEY in env" })] }));
    expect(alerts[0]).toMatchObject({ kind: "blocked-env", severity: "high", sliceId: "e" });
    expect(alerts[0]?.message).toBe("no OMP_KEY in env");
  });

  test("a parked slice takes its words from the event that parked it", () => {
    // A `blocked-env` slice has no `reason` in the run record; the event that
    // parked it carries the operator's own detail, which is the same fact one
    // layer down.
    const events: RunEvent[] = [{ ...event(3, "slice_blocked_env", "e"), detail: "port 5432 refused" }];
    const alerts = deriveAlerts(input({ slices: [slice("e", "blocked-env")], events }));
    expect(alerts[0]?.message).toBe("port 5432 refused");
    // With neither, the stack still says something true rather than nothing.
    expect(deriveAlerts(input({ slices: [slice("e", "blocked-env")] }))[0]?.message).toBe("blocked on the environment");
  });

  test("a wedged worker is the server's flag, worded with the silence it reports", () => {
    const agents: AlertAgent[] = [{ id: "b", wedged: true, staleForMs: 12 * 60 * 1000 }];
    const alerts = deriveAlerts(input({ slices: [slice("b", "running")], agents }));
    expect(alerts[0]).toMatchObject({ kind: "wedged", severity: "high", sliceId: "b" });
    expect(alerts[0]?.message).toBe("transcript silent 12m");
    // Not flagged is not an alert: the deck invents no threshold of its own.
    expect(deriveAlerts(input({ slices: [slice("b", "running")], agents: [{ id: "b", wedged: false, staleForMs: 1000 }] }))).toEqual([]);
  });

  test("a rejected review reads as the reviewer's first finding", () => {
    const alerts = deriveAlerts(
      input({ sliceDetail: detail({ review: { approved: false, findings: ["maintains a second state model"], notes: "no" } }) }),
    );
    expect(alerts[0]).toMatchObject({ kind: "review-rejected", severity: "medium", sliceId: "a" });
    expect(alerts[0]?.message).toBe("review rejected — maintains a second state model");
  });

  test("a stale rejection on a slice that is done raises nothing", () => {
    const alerts = deriveAlerts(
      input({ sliceDetail: detail({ status: "done", review: { approved: false, findings: ["nope"] } }) }),
    );
    expect(alerts).toEqual([]);
  });

  test("a verdict stall is advisory, says idle, and never says stuck", () => {
    const alerts = deriveAlerts(input({ sliceDetail: detail({ status: "verifying", verdictStall: { idleMs: 11 * 60 * 1000, lastGate: "bun test", gatesDone: 2 } }) }));
    expect(alerts[0]).toMatchObject({ kind: "verdict-stall", severity: "advisory", sliceId: "a" });
    expect(alerts[0]?.message).toBe("gates idle 11m after bun test");
    expect(alerts[0]?.message).not.toContain("stuck");
  });

  test("two loops on one run is one run-level high alert naming the pids", () => {
    const alerts = deriveAlerts(input({ loops: [{ pid: 41 }, { pid: 42 }] }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "double-loop", severity: "high", sliceId: null, lastSeq: 0 });
    expect(alerts[0]?.message).toBe("2 loop processes on this run — pids 41, 42");
    expect(deriveAlerts(input({ loops: [{ pid: 41 }] }))).toEqual([]);
  });
});

describe("deriveAlerts: ordering", () => {
  test("severity first, then the newest evidence, then board order", () => {
    const slices = [slice("a", "failed"), slice("b", "blocked-env"), slice("c", "running"), slice("d", "running")];
    const events = [
      event(5, "slice_failed_terminal", "a"),
      event(9, "slice_claimed", "b"),
      event(7, "verify_failed", "c", { attempt: 1 }),
      event(8, "verify_failed", "d", { attempt: 1 }),
    ];
    const agents: AlertAgent[] = [{ id: "d", wedged: true, staleForMs: 11 * 60 * 1000 }];
    const alerts = deriveAlerts(input({ slices, events, agents }));
    // High band first, by newest evidence: `b` (9), `d`'s wedge (8), `a` (5).
    // Then the medium band, by evidence. `d` carries two alerts on purpose —
    // "no output for 11m" and "its gate failed last attempt" are different
    // conditions with different remedies, and both are true at once.
    expect(alerts.map((alert) => [alert.kind, alert.sliceId, alert.lastSeq])).toEqual([
      ["blocked-env", "b", 9],
      ["wedged", "d", 8],
      ["failed", "a", 5],
      ["verify-failed", "d", 8],
      ["verify-failed", "c", 7],
    ]);
    expect(alerts.map((alert) => SEVERITY_RANK[alert.severity])).toEqual([0, 0, 0, 1, 1]);
  });

  test("a wedged worker sorts into the high band with the other high alerts", () => {
    const alerts = deriveAlerts(
      input({
        slices: [slice("a", "failed", { reason: "boom" }), slice("b", "running")],
        agents: [{ id: "b", wedged: true, staleForMs: 600_000 }],
        events: [event(1, "slice_failed_terminal", "a"), event(2, "slice_claimed", "b")],
      }),
    );
    expect(alerts.map((alert) => alert.kind)).toEqual(["wedged", "failed"]);
    expect(alerts.every((alert) => alert.severity === "high")).toBe(true);
  });
});

describe("dismissal", () => {
  const alert: DeckAlert = { kind: "failed", severity: "high", sliceId: "a", message: "boom", lastSeq: 12 };

  test("the key is stable for one condition and changes with its evidence", () => {
    expect(dismissKey("run-1", alert)).toBe("run-1|a|failed|12");
    expect(alertKey(alert)).toBe("a|failed|12");
    const recurred: DeckAlert = { ...alert, lastSeq: 13 };
    expect(dismissKey("run-1", recurred)).not.toBe(dismissKey("run-1", alert));
    // A different run dismisses independently.
    expect(dismissKey("run-2", alert)).not.toBe(dismissKey("run-1", alert));
  });

  test("a recurrence re-raises: the dismissed key is not the new key", () => {
    const alerts = [alert];
    const dismissed = new Set([dismissKey("run-1", alert)]);
    expect(activeAlerts(alerts, dismissed, "run-1")).toEqual([]);
    expect(activeAlerts([{ ...alert, lastSeq: 13 }], dismissed, "run-1")).toHaveLength(1);
  });

  test("appending dedupes, keeps the newest last, and stays bounded", () => {
    expect(appendDismissed(["a|1"], "a|1")).toEqual(["a|1"]);
    expect(appendDismissed(["a|1"], "a|2")).toEqual(["a|1", "a|2"]);
    const full = Array.from({ length: DISMISSED_CAP }, (_, i) => `k${i}`);
    const grown = appendDismissed(full, "newest");
    expect(grown).toHaveLength(DISMISSED_CAP);
    expect(grown[grown.length - 1]).toBe("newest");
    expect(grown).not.toContain("k0");
  });

  test("unreadable storage dismisses nothing rather than throwing", () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed("{oops")).toEqual([]);
    expect(parseDismissed('{"a":1}')).toEqual([]);
    expect(parseDismissed('["a|1",7,null]')).toEqual(["a|1"]);
  });
});
