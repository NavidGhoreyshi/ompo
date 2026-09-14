/**
 * Deck instrumentation (roadmap slice `d01`).
 *
 * The gate's numbers are only as good as the sampler that produces them, so
 * this pins the sample's shape and semantics: a window that resets on
 * `snapshot()`, percentiles over the frame ring, event→visible latency walked
 * from `noteEvent` to `markEventRendered`, that same latency split into its
 * transport/model/DOM/scene stages, mutation/long-task counters, and a heap
 * reading that says *why* it is unavailable instead of reporting zero.
 * The last test is the cost guard the slice asks for: the 1 Hz sampler is
 * cheap enough to leave on in the build the operator uses.
 */

import { describe, expect, test } from "bun:test";
import {
  computeSample,
  createInstrumentation,
  frameTimeStats,
  INTERACTION_RING,
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
    latencyStages: { transport: [], dom: [], model: [], scene: [], samples: 0 },
    interactions: {},
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
      stations: 3,
      stationMarks: 7,
      markers: 3,
      beacons: 0,
      settles: 0,
      fogFar: 1e6,
      floorVisible: 1,
      parallax: 0,
      ribbon: 0,
      tiles: 0,
      tweens: 0,
      animatedEntities: 0,
      sceneWrites: 1,
      stationSegments: 4,
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

  test("start() re-attaches to the element the deck promised to watch", () => {
    // A deck that rebuilds its renderer (pressing `M`, a tier's MSAA bit)
    // stops and starts the instrument. The element it watches does not change,
    // so the mutation and element counters must keep counting — otherwise the
    // evidence silently reads `mutations: 0` for the rest of the session.
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.observeDom({} as Element);
    h.instrument.stop();
    h.instrument.start();
    h.fireMutations(3);
    h.tickSampler();
    const sample = h.instrument.snapshot();
    expect(sample.mutations).toBe(3);
    expect(sample.domElements).toBe(42);
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

describe("event pipeline stages", () => {
  test("transport, model, scene and dom medians come from their own stage clocks", () => {
    const h = instrumentHarness();
    h.instrument.start();
    // The event's own timestamp was produced slightly before it reached the
    // browser; `rx` is the moment it was applied to React state.
    h.instrument.noteEvent(1, 999_995);
    h.advance(12);
    h.instrument.noteStage("model");
    h.advance(8);
    h.instrument.noteStage("scene");
    h.advance(30);
    h.instrument.markEventRendered(1);

    const sample = h.instrument.snapshot();
    expect(sample.latencyStages.transport).toEqual({ p50: 5, p95: 5, worst: 5, samples: 1 });
    expect(sample.latencyStages.model).toEqual({ p50: 12, p95: 12, worst: 12, samples: 1 });
    expect(sample.latencyStages.scene).toEqual({ p50: 20, p95: 20, worst: 20, samples: 1 });
    expect(sample.latencyStages.dom).toEqual({ p50: 50, p95: 50, worst: 50, samples: 1 });
    expect(sample.latencyStages.samples).toBe(1);
    // `latencyMs` keeps its at→dom meaning alongside the split.
    expect(sample.latencyMs).toEqual({ p50: 55, p95: 55, worst: 55, samples: 1 });
  });

  test("a stage mark is attributed to the newest record, never retroactively", () => {
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.noteEvent(1, 1_000_000);
    h.advance(100);
    h.instrument.noteEvent(2, 1_000_100);
    h.advance(10);
    h.instrument.noteStage("model");

    // `noteStage` carries no seq: the deck's model update follows the event it
    // was applied for and precedes the next one, so the newest record owns it.
    const stages = h.instrument.snapshot().latencyStages;
    expect(stages.transport.samples).toBe(2);
    expect(stages.model.samples).toBe(1);
    expect(stages.model.p50).toBe(10);
    expect(stages.samples).toBe(2);
  });

  test("a record with no dom mark contributes to model/scene but not dom, and samples counts records", () => {
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.noteEvent(1, 1_000_000);
    h.advance(10);
    h.instrument.noteStage("model");
    h.advance(10);
    h.instrument.noteStage("scene");
    h.advance(10);
    h.instrument.noteEvent(2, 1_000_030);
    h.advance(10);
    h.instrument.noteStage("model");
    h.advance(10);
    h.instrument.markEventRendered(2);

    const stages = h.instrument.snapshot().latencyStages;
    expect(stages.transport.samples).toBe(2);
    expect(stages.model).toEqual({ p50: 10, p95: 10, worst: 10, samples: 2 });
    expect(stages.scene).toEqual({ p50: 20, p95: 20, worst: 20, samples: 1 });
    expect(stages.dom).toEqual({ p50: 20, p95: 20, worst: 20, samples: 1 });
    expect(stages.samples).toBe(2);
  });

  test("a dom mark matches its own seq, even after a later event opened", () => {
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.noteEvent(1, 1_000_000);
    h.advance(10);
    h.instrument.noteEvent(2, 1_000_010);
    h.advance(40);
    h.instrument.markEventRendered(1);

    const stages = h.instrument.snapshot().latencyStages;
    expect(stages.dom.samples).toBe(1);
    expect(stages.dom.p50).toBe(50);
    expect(stages.model.samples).toBe(0);
  });

  test("snapshot() resets the stage window, and a later mark cannot revive a consumed record", () => {
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.noteEvent(1, 1_000_000);
    h.instrument.noteStage("model");
    expect(h.instrument.snapshot().latencyStages.samples).toBe(1);

    h.instrument.noteStage("scene");
    const next = h.instrument.snapshot().latencyStages;
    expect(next.samples).toBe(0);
    expect(next.model).toEqual({ p50: 0, p95: 0, worst: 0, samples: 0 });
    expect(next.scene.samples).toBe(0);
  });

  test("markEventRendered for an unknown seq is a miss and opens no record", () => {
    const h = instrumentHarness();
    h.instrument.start();
    h.instrument.markEventRendered(42);

    const sample = h.instrument.snapshot();
    expect(sample.events.markMisses).toBe(1);
    expect(sample.latencyStages.samples).toBe(0);
    expect(sample.latencyStages.dom.samples).toBe(0);
  });

  test("computeSample reduces the stage sets independently", () => {
    const sample = computeSample(
      input({ latencyStages: { transport: [4, 6], dom: [30], model: [10, 20], scene: [], samples: 2 } }),
    );
    expect(sample.latencyStages.transport).toEqual({ p50: 4, p95: 6, worst: 6, samples: 2 });
    expect(sample.latencyStages.dom).toEqual({ p50: 30, p95: 30, worst: 30, samples: 1 });
    expect(sample.latencyStages.model).toEqual({ p50: 10, p95: 20, worst: 20, samples: 2 });
    // An unmarked stage is absent (zero samples), not a zero-valued sample.
    expect(sample.latencyStages.scene).toEqual({ p50: 0, p95: 0, worst: 0, samples: 0 });
    expect(sample.latencyStages.samples).toBe(2);
  });

  test("dock interactions reduce per name, and an unmeasured one is absent", () => {
    const sample = computeSample(
      input({
        interactions: {
          "inspection-open": [12, 40],
          "inspection-tab": [8],
          // `inspection-close` never happened: no samples, not a zero.
        },
      }),
    );
    expect(sample.interactions.open).toEqual({ p50: 12, p95: 40, worst: 40, samples: 2 });
    expect(sample.interactions.tab).toEqual({ p50: 8, p95: 8, worst: 8, samples: 1 });
    expect(sample.interactions.close.samples).toBe(0);
    expect(sample.interactions.samples).toBe(3);
  });
});

describe("recordInteraction", () => {
  test("keeps a bounded ring per name and clears with the window", () => {
    const h = instrumentHarness();
    h.instrument.start();
    for (let i = 0; i < INTERACTION_RING + 7; i++) h.instrument.recordInteraction("inspection-open", i);
    h.instrument.recordInteraction("inspection-close", 5);
    h.instrument.recordInteraction("inspection-open", Number.NaN); // ignored, not a sample

    const first = h.instrument.snapshot();
    // The 7 oldest samples were dropped; NaN never entered the ring.
    expect(first.interactions.open.samples).toBe(INTERACTION_RING);
    expect(first.interactions.open.worst).toBe(INTERACTION_RING + 6);
    expect(first.interactions.close).toEqual({ p50: 5, p95: 5, worst: 5, samples: 1 });
    expect(first.interactions.samples).toBe(INTERACTION_RING + 1);

    // Snapshot consumes the window: the latencies measured in it do not leak
    // into the next one.
    const second = h.instrument.snapshot();
    expect(second.interactions.samples).toBe(0);
    expect(second.interactions.open.samples).toBe(0);
  });
});

describe("sampler cost", () => {
  test("the 1 Hz sampler stays cheap enough to leave on", () => {
    // A full window: 3 000 frame times, 512 latencies, 400 layouts.
    const frameTimes = Array.from({ length: 3000 }, (_, i) => 8 + (i % 25));
    const latencies = Array.from({ length: 512 }, (_, i) => 200 + (i % 900));
    const layouts = Array.from({ length: 400 }, (_, i) => 0.2 + (i % 5) * 0.1);
    const sampleInput = input({ now: 1_000_000, frameTimes, latencies, layouts, frames: 3000 });
    const iterations = 200;
    // Wall clock measures the machine, not the sampler: on a box carrying
    // several agents it reported 1.0–6.3 ms per call while the sampler burned a
    // steady 1.2 ms of CPU (0.2 ms idle). CPU time is the honest metric, three
    // runs take the minimum, and 5 ms still fails an accidentally quadratic
    // sampler by an order of magnitude.
    let cpuMs = Infinity;
    for (let run = 0; run < 3; run++) {
      const before = process.cpuUsage();
      for (let i = 0; i < iterations; i++) computeSample(sampleInput);
      const used = process.cpuUsage(before);
      cpuMs = Math.min(cpuMs, (used.user + used.system) / 1000 / iterations);
    }
    expect(cpuMs).toBeLessThan(5);
  });
});
