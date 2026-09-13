/**
 * Log/event churn (roadmap slice `d03`): who pays for 100 000 events.
 *
 * The brief's hard question is "100 000 events must remain cheap". The honest
 * answer has three parts, and this file measures all of them:
 *
 * 1. **The browser never holds them.** The SSE transport is a `seq` cursor, the
 *    shell keeps the last 400 events, and the window keeps ≤ `COMPACT_ROWS`
 *    rows (≤ `LIVE_TAIL` when expanded). This file measures the derivation at
 *    both ends: at the caps the app actually applies, and at a pathological
 *    100 000-row input that only a test can produce.
 * 2. **The scene cannot see any of it.** `buildDeckModel`'s digest and nodes are
 *    byte-identical with and without a 100 000-event history, so no amount of
 *    log text can reach the GPU (CP-3).
 * 3. **Someone does pay, and it is not the deck.** `readEvents` parses the whole
 *    log per call and the SSE poll calls it every tick: the *transport* grows
 *    with the log, the deck does not. That number is recorded so the review can
 *    name the next bottleneck instead of claiming there is none.
 *
 * Numbers are printed; the assertions are the bounds that must not regress.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../src/types.ts";
import { readEvents } from "../src/store.ts";
import { alignLineIds, buildLiveStream, compactWindow, COMPACT_ROWS } from "../web/src/lib/stream.ts";
import { LIVE_TAIL } from "../web/src/lib/useLiveStream.ts";
import { buildDeckModel } from "../web/src/scene/model.ts";
import { DEFAULT_DECK_PREFS, type DeckInput } from "../web/src/scene/types.ts";

/** The brief's number; `DECK_CHURN` lowers it when a machine is busy. */
const CHURN = Number(process.env.DECK_CHURN ?? 100_000);
/** What the shell keeps and what the tail endpoint returns. */
const APP_EVENT_CAP = 400;
const SLICE = "s-focus";

function eventAt(seq: number): RunEvent {
  // The shape the orchestrator writes: lifecycle events for the focused slice
  // interleaved with other slices' events (only the focused slice's events are
  // eligible for the live window, so the filter is part of the cost).
  const mine = seq % 3 === 0;
  return {
    seq,
    at: new Date(Date.UTC(2026, 8, 13) + seq * 1000).toISOString(),
    type: mine ? "slice_handoff" : "worker_finished",
    sliceId: mine ? SLICE : `other-${seq % 7}`,
    detail: mine ? `handoff ${seq}` : `report=${seq}`,
  };
}

/** Real progress grammar, as `src/worker.ts` writes it. */
function transcriptLines(count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 4;
    lines.push(
      kind === 0
        ? `  [${SLICE}] turn ${i}…`
        : kind === 1
          ? `  [${SLICE}] tool bash: bun test --filter case-${i}`
          : kind === 2
            ? `  [${SLICE}] says: step ${i} of the plan`
            : `  [${SLICE}] turn ${i} done (2 tool results)`,
    );
  }
  return lines;
}

function countLines(n: number, events: RunEvent[]): { entries: number; compact: number; ms: number } {
  const lines = transcriptLines(n);
  const ids = alignLineIds({ lines: [], ids: [] }, lines);
  const started = performance.now();
  const entries = buildLiveStream({ events, sliceId: SLICE, lines, ids, logName: "worker-1-g0.log", lane: "worker" });
  const compact = compactWindow(entries);
  return { entries: entries.length, compact: compact.length, ms: Math.round((performance.now() - started) * 100) / 100 };
}

describe("the live window is a window at any input size", () => {
  test("100 000 events and 100 000 lines still produce ≤ 5 rendered rows", () => {
    const events = Array.from({ length: CHURN }, (_, i) => eventAt(i));
    const measured = countLines(CHURN, events);
    console.log(`deck-churn-100k ${JSON.stringify({ churn: CHURN, ...measured })}`);

    // The window is what the operator sees, and it is bounded by construction.
    expect(measured.compact).toBeLessThanOrEqual(COMPACT_ROWS);
    // Recorded, not asserted: the *derivation* is linear in the rows it is
    // given (it maps every line into an entry), so a 100 000-row input costs
    // this many ms. That is exactly why the inputs are capped — the shell keeps
    // the last 400 events and the tail endpoint returns 400 lines — and the
    // e2e churn spec measures the DOM that results from the real caps.
  });

  test("at the caps the app enforces, the derivation costs a frame fraction", () => {
    // The real inputs: the shell's 400-event window and the tail endpoint's
    // 400 lines (server cap 500, `LIVE_TAIL` = 400).
    const events = Array.from({ length: APP_EVENT_CAP }, (_, i) => eventAt(i));
    const measured = countLines(LIVE_TAIL, events);
    console.log(`deck-churn-capped ${JSON.stringify({ events: APP_EVENT_CAP, lines: LIVE_TAIL, ...measured })}`);

    expect(measured.compact).toBeLessThanOrEqual(COMPACT_ROWS);
    expect(measured.ms).toBeLessThan(50);
  });
});

describe("the scene cannot see the history", () => {
  test("a 100 000-event array leaves the model byte-identical", () => {
    const detail = {
      runId: "run-1",
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
      live: true,
      counts: { done: 0, active: 1, failed: 0, skipped: 0, blockedEnv: 0, pending: 0 },
      workers: 1,
      total: 1,
      status: "running",
      retries: 0,
      handoffs: 0,
      tokens: null,
      cost: null,
      slices: [
        { id: SLICE, title: "Focus", status: "running", attempts: 1, updatedAt: "2026-09-13T00:00:00.000Z", deps: [], generation: 0, verify: [] },
      ],
    };
    const base: DeckInput = {
      runId: "run-1",
      detail,
      events: [],
      agents: [],
      selected: null,
      sliceDetail: null,
      pinnedId: null,
      prefs: DEFAULT_DECK_PREFS,
      live: true,
      maxStations: 8,
    };
    const history = Array.from({ length: CHURN }, (_, i) => eventAt(i));
    const quiet = buildDeckModel(base);
    const started = performance.now();
    const chatty = buildDeckModel({ ...base, events: history });
    const ms = Math.round((performance.now() - started) * 100) / 100;

    console.log(`deck-churn-model ${JSON.stringify({ events: history.length, ms })}`);
    expect(chatty.digest).toBe(quiet.digest);
    expect(JSON.stringify(chatty.nodes)).toBe(JSON.stringify(quiet.nodes));
    expect(ms).toBeLessThan(50); // the model does not read the array at all
  });
});

describe("what a 100 000-event log costs the server", () => {
  test("readEvents parses the whole log per call — the transport is the bottleneck", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-churn-"));
    const run = "churn-run";
    mkdirSync(join(dir, ".omp", "roadmap", "runs", run), { recursive: true });
    const lines = Array.from({ length: CHURN }, (_, i) => JSON.stringify(eventAt(i)));
    writeFileSync(join(dir, ".omp", "roadmap", "runs", run, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");

    const started = performance.now();
    const events = readEvents(dir, run);
    const elapsed = Math.round((performance.now() - started) * 100) / 100;
    console.log(`deck-churn-store ${JSON.stringify({ events: events.length, ms: elapsed, pollBudgetMs: 900 })}`);

    expect(events.length).toBe(CHURN);
    // Recorded, never asserted: the read is linear in the file and its absolute
    // cost depends on how busy the machine is, which this measurement cannot
    // control. The review quotes it with its caveat; the deck contributes
    // nothing to it, and the SSE tick (900 ms) is what it competes with.
  });
});
