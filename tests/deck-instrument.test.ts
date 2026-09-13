/**
 * Deck instrumentation (roadmap slice `d01`).
 *
 * The gate's numbers are only as good as the sampler that produces them, so
 * this pins the sample's shape and semantics: a window that resets on
 * `snapshot()`, percentiles over the frame ring, event→visible latency walked
 * from `noteEvent` to `markEventRendered`, mutation/long-task counters, and a
 * heap reading that says *why* it is unavailable instead of reporting zero.
 * The last test is the cost guard the slice asks for: the 1 Hz sampler is
 * cheap enough to leave on in the build the operator uses.
 */

import { describe, expect, test } from "bun:test";
import {
  computeSample,
  createInstrumentation,
  frameTimeStats,
  SHADER_NS_PER_PIXEL,
  type Instrumentation,
  type SampleInput,
} from "../web/src/scene/instrument.ts";

function input(overrides: Partial<SampleInput> = {}): SampleInput {
  return {
    now: 1000,
    windowStart: 0,
    tier: "minimal",
    frames: 0,
    commits: 0,
    mutations: 0,
    events: 0,
    markMisses: 0,
    domElements: 0,
    longTasks: { count: 0, worstMs: 0 },
    heap: { supported: true, usedBytes: 0, reason: "" },
    frameTimes: [],
    latencies: [],
    layouts: [],
    renderer: null,
    loop: { frames: 0, deferred: 0, idleStops: 0, hiddenDrops: 0, maxFps: 30 },
    ...overrides,
  };
}

/** A DOM-free instrument with a controllable clock and timer. */
function instrumentHarness(): {
  instrument: Instrumentation;
  advance(ms: number): void;
  tickSampler(): void;
  fireMutations(count: number): void;
  fireLongTask(durationMs: number): void;
} {
  let time = 0;
  let sampler: (() => void) | null = null;
  let mutationsCb: ((count: number) => void) | null = null;
  let longTaskCb: ((durationMs: number) => void) | null = null;
  const instrument = createInstrumentation({
    now: () => time,
    wallClock: () => 1_000_000 + time,
    setInterval: (cb) => {
      sampler = cb;
      return 1;
    },
    clearInterval: () => {
      sampler = null;
    },
    observeMutations: (_root, onRecords) => {
      mutationsCb = onRecords;
      return () => {
        mutationsCb = null;
      };
    },
    observeLongTasks: (onTask) => {
      longTaskCb = onTask;
      return () => {
        longTaskCb = null;
      };
    },
    countElements: () => 42,
    readHeap: () => ({ supported: false, usedBytes: null, reason: "test: no performance.memory" }),
  });
  return {
    instrument,
    advance: (ms) => {
      time += ms;
    },
    tickSampler: () => sampler?.(),
    fireMutations: (count) => mutationsCb?.(count),
    fireLongTask: (durationMs) => longTaskCb?.(durationMs),
  };
}

describe("frameTimeStats", () => {
  test("nearest-rank percentiles and the worst sample", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(frameTimeStats(samples)).toEqual({ p50: 50, p95: 95, worst: 100, samples: 100 });
    expect(frameTimeStats([])).toEqual({ p50: 0, p95: 0, worst: 0, samples: 0 });
    expect(frameTimeStats([7])).toEqual({ p50: 7, p95: 7, worst: 7, samples: 1 });
    // Input is not mutated: the caller's ring buffer stays in write order.
    const values = [3, 1, 2];
    frameTimeStats(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("computeSample", () => {
  test("rates are per second over the window", () => {
    const sample = computeSample(input({ now: 2000, frames: 30, commits: 4, mutations: 61, events: 3, frameTimes: [10, 20, 30], latencies: [800, 900, 1000] }));
    expect(sample.windowMs).toBe(2000);
    expect(sample.framesPerSec).toBe(15);
    expect(sample.commitsPerSec).toBe(2);
    expect(sample.mutationsPerSec).toBe(30.5);
    expect(sample.latencyMs.samples).toBe(3);
    expect(sample.latencyMs.p50).toBe(900);
    expect(sample.surface).toBe("deck");
  });

  test("the shaded-pixel estimate uses the measured d00 fill cost", () => {
    const renderer = {
      drawCalls: 1,
      triangles: 0,
      lines: 18,
      objects: 1,
      instances: 0,
      programs: 1,
      textures: 0,
      geometries: 1,
      vertices: 36,
      pixels: 230_400,
      fullScreenLayers: 2,
      linePixels: 13_000,
      shadedPixels: 473_800,
      fps: 30,
    };
    const sample = computeSample(input({ renderer }));
    expect(sample.estimate.shadedPixels).toBe(473_800);
    expect(sample.estimate.shaderMs).toBeCloseTo((473_800 * SHADER_NS_PER_PIXEL) / 1e6, 3);
    expect(sample.estimate.basis).toContain("9 ns/px");
    expect(sample.renderer).toEqual(renderer);
  });

  test("an unavailable heap reading carries its reason instead of a zero", () => {
    const sample = computeSample(input({ heap: { supported: false, usedBytes: null, reason: "nope" } }));
    expect(sample.heap.supported).toBe(false);
    expect(sample.heap.usedBytes).toBeNull();
    expect(sample.heap.reason).toBe("nope");
  });
});

describe("instrumentation", () => {
  test("snapshot() reports the window and then starts a new one", () => {
    const h = instrumentHarness();
    h.instrument.start();
    for (let i = 0; i < 5; i++) h.instrument.recordFrame(10 + i);
    h.instrument.recordCommit();
    h.instrument.recordCommit();
    h.instrument.recordLayout(0.4);
    h.instrument.recordLayout(0.6);

    const first = h.instrument.snapshot();
    expect(first.frames).toBe(5);
    expect(first.frameMs).toEqual({ p50: 12, p95: 14, worst: 14, samples: 5 });
    expect(first.commits).toBe(2);
    expect(first.layoutMs).toBe(0.4);
    expect(first.heap.supported).toBe(false);

    const second = h.instrument.snapshot();
    expect(second.frames).toBe(0);
    expect(second.frameMs.samples).toBe(0);
  });

  test("event→visible latency is measured from the event's own timestamp", () => {
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.noteEvent(1, 1_000_000);
    h.instrument.noteEvent(2, 1_000_000);
    h.advance(120);
    h.instrument.markEventRendered(1);
    h.advance(80);
    h.instrument.markEventRendered(2);
    h.instrument.markEventRendered(99); // never noted: a miss, not a sample

    const sample = h.instrument.snapshot();
    expect(sample.latencyMs.samples).toBe(2);
    expect(sample.latencyMs.p50).toBe(120);
    expect(sample.latencyMs.worst).toBe(200);
    expect(sample.events).toEqual({ applied: 2, perSec: expect.any(Number), markMisses: 1 });
    expect(h.instrument.snapshot().latencyMs.samples).toBe(0);
  });

  test("an ISO event timestamp is parsed against the same wall clock", () => {
    // `RunEvent.at` is an ISO string: it must be measured on the wall clock, not
    // against `performance.now()`, which would report every mark as zero.
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.noteEvent(7, new Date(1_000_000).toISOString());
    h.advance(50);
    h.instrument.markEventRendered(7);

    const sample = h.instrument.snapshot();
    expect(sample.events).toMatchObject({ applied: 1, markMisses: 0 });
    expect(sample.latencyMs.samples).toBe(1);
    expect(sample.latencyMs.p50).toBe(50);
  });

  test("mutations, long tasks and the element census are counted for the window", () => {
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.observeDom({} as Element);
    h.fireMutations(3);
    h.fireMutations(2);
    h.fireLongTask(120);
    h.fireLongTask(70);
    h.tickSampler();

    const sample = h.instrument.snapshot();
    expect(sample.mutations).toBe(5);
    expect(sample.longTasks).toEqual({ count: 2, worstMs: 120 });
    expect(sample.domElements).toBe(42);
    // Long tasks are windowed like every other counter: page-load jank must not
    // sit in the max forever.
    h.fireLongTask(300);
    expect(h.instrument.snapshot().longTasks).toEqual({ count: 1, worstMs: 300 });
  });

  test("stop() detaches the sampler and the observers", () => {
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.observeDom({} as Element);
    h.instrument.stop();
    h.fireMutations(4);
    h.tickSampler();
    const sample = h.instrument.snapshot();
    expect(sample.mutations).toBe(0);
    expect(sample.domElements).toBe(0);
  });

  test("latest() reads the window without consuming it", () => {
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.recordFrame(5);
    expect(h.instrument.latest().frames).toBe(1);
    expect(h.instrument.latest().frames).toBe(1);
    expect(h.instrument.snapshot().frames).toBe(1);
    expect(h.instrument.latest().frames).toBe(0);
  });
});

describe("sampler cost", () => {
  test("the 1 Hz sampler stays far under 1 ms per second of runtime", () => {
    // A full window: 3 000 frame times, 512 latencies, 400 layouts.
    const frameTimes = Array.from({ length: 3000 }, (_, i) => 8 + (i % 25));
    const latencies = Array.from({ length: 512 }, (_, i) => 200 + (i % 900));
    const layouts = Array.from({ length: 400 }, (_, i) => 0.2 + (i % 5) * 0.1);
    const sampleInput = input({ now: 1_000_000, frameTimes, latencies, layouts, frames: 3000 });
    const iterations = 200;
    const started = performance.now();
    for (let i = 0; i < iterations; i++) computeSample(sampleInput);
    const elapsed = performance.now() - started;
    // The real cost is ~0.2 ms per call; the bound leaves a wide margin for a
    // loaded CI box while still failing an accidentally quadratic sampler.
    expect(elapsed / iterations).toBeLessThan(1);
  });
});
