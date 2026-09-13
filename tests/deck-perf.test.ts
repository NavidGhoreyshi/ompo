/**
 * Deck quality tiers (roadmap slices `d00` and `d10`): the classifier that
 * picks a tier from the WebGL renderer string, the budget table every later
 * slice is measured against, the auto-downgrade controller, and the loop's
 * coalescing rules.
 *
 * The last test is the load-bearing one: `docs/deck-performance-budget.md` is
 * the document operators read and `TIER_BUDGETS` is what the scene obeys, so
 * the two are parsed against each other rather than trusted to stay in sync.
 * `scripts/deck-perf.ts` reads the same table.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFrameLoop, type FrameLoop } from "../web/src/scene/loop.ts";
import {
  AUTO_DOWNGRADE_LIMIT,
  classifyRenderer,
  createTierController,
  demoteTier,
  FRAME_WINDOW,
  SOFTWARE_RENDERER_RE,
  TIER_BUDGETS,
  TIER_ORDER,
  type TierBudget,
  type TierController,
} from "../web/src/scene/tier.ts";

const TIERS = ["minimal", "standard", "high"] as const;
const FIELDS: (keyof TierBudget)[] = [
  "resolutionScale",
  "maxFps",
  "antialias",
  "maxDrawCalls",
  "maxStations",
  "maxBeacons",
  "ambient",
  "frameBudgetMs",
  "frameP95Ms",
];

describe("classifyRenderer", () => {
  test("a missing renderer string is the standard tier, not the degraded one", () => {
    expect(classifyRenderer(null)).toBe("standard");
    expect(classifyRenderer("")).toBe("standard");
    expect(classifyRenderer("   ")).toBe("standard");
  });

  test("software rasterizers are minimal", () => {
    // The gate machine (A.6 of the roadmap) and the common CPU rasterizers.
    expect(classifyRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)")).toBe("minimal");
    expect(classifyRenderer("Google SwiftShader")).toBe("minimal");
    expect(classifyRenderer("Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)")).toBe("minimal");
    expect(classifyRenderer("Mesa OffScreen")).toBe("minimal");
    expect(classifyRenderer("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("minimal");
  });

  test("hardware renderers are standard", () => {
    expect(classifyRenderer("ANGLE (NVIDIA Corporation, GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0)")).toBe("standard");
    expect(classifyRenderer("AMD Radeon RX 6800 XT (radeonsi, navi21, LLVM 15.0.7)")).toBe("standard");
    expect(classifyRenderer("Apple M2")).toBe("standard");
  });

  test("high is never guessed from a vendor string", () => {
    for (const renderer of [null, "", "NVIDIA GeForce RTX 4090", "Apple M3 Max", "SwiftShader"]) {
      expect(classifyRenderer(renderer)).not.toBe("high");
    }
  });
});

describe("SOFTWARE_RENDERER_RE", () => {
  test("matches every software pattern the tier rules name", () => {
    for (const name of ["swiftshader", "llvmpipe", "software", "basic render", "mesa offscreen"]) {
      expect(SOFTWARE_RENDERER_RE.test(name)).toBe(true);
    }
    expect(SOFTWARE_RENDERER_RE.test("SWIFTSHADER")).toBe(true);
  });

  test("does not match hardware vendor strings", () => {
    for (const name of ["NVIDIA", "AMD Radeon", "Apple M2", "Intel(R) UHD Graphics", "Adreno (TM) 740"]) {
      expect(SOFTWARE_RENDERER_RE.test(name)).toBe(false);
    }
  });
});

describe("TIER_BUDGETS", () => {
  test("every tier defines every field", () => {
    for (const tier of TIERS) {
      const budget = TIER_BUDGETS[tier];
      for (const field of FIELDS) {
        const value = budget[field];
        expect(value === undefined).toBe(false);
        const expected = field === "antialias" || field === "ambient" ? "boolean" : "number";
        expect(typeof value).toBe(expected);
      }
    }
  });

  test("budgets are monotonic: a cheaper tier never spends more", () => {
    for (const field of ["resolutionScale", "maxFps", "maxDrawCalls", "maxStations", "maxBeacons"] as const) {
      const values = TIERS.map((tier) => TIER_BUDGETS[tier][field]);
      expect(values[0]!).toBeLessThanOrEqual(values[1]!);
      expect(values[1]!).toBeLessThanOrEqual(values[2]!);
    }
    expect(TIER_BUDGETS.minimal.ambient).toBe(false);
    expect(Number(TIER_BUDGETS.minimal.antialias)).toBeLessThanOrEqual(Number(TIER_BUDGETS.high.antialias));
    // Frame budgets run the other way: the cheaper tier is allowed to spend
    // more time per frame — that is what makes it the cheap tier.
    for (const tier of TIERS) {
      const budget = TIER_BUDGETS[tier];
      expect(budget.frameBudgetMs).toBeLessThan(budget.frameP95Ms);
    }
    expect(TIER_BUDGETS.minimal.frameBudgetMs).toBeGreaterThanOrEqual(TIER_BUDGETS.standard.frameBudgetMs);
    expect(TIER_BUDGETS.standard.frameBudgetMs).toBeGreaterThanOrEqual(TIER_BUDGETS.high.frameBudgetMs);
  });

  test("the frame budgets are the gate's pinned M2 numbers", () => {
    // Roadmap §0.4: `minimal` p50 ≤ 33 ms / p95 ≤ 45 ms; the d10 table pins
    // the other two tiers by the same 1.5×-headroom rule.
    expect([TIER_BUDGETS.minimal.frameBudgetMs, TIER_BUDGETS.standard.frameBudgetMs, TIER_BUDGETS.high.frameBudgetMs]).toEqual([33, 16, 12]);
    expect([TIER_BUDGETS.minimal.frameP95Ms, TIER_BUDGETS.standard.frameP95Ms, TIER_BUDGETS.high.frameP95Ms]).toEqual([45, 25, 20]);
  });

  test("the minimal tier is the one that has to survive software rasterization", () => {
    expect(TIER_BUDGETS.minimal.resolutionScale).toBeLessThan(1);
    expect(TIER_BUDGETS.minimal.maxFps).toBeLessThanOrEqual(30);
    expect(TIER_BUDGETS.minimal.antialias).toBe(false);
    expect(TIER_BUDGETS.minimal.ambient).toBe(false);
  });
});

/**
 * The auto-downgrade controller (`d10`). It is fed one frame cost at a time
 * and answers with a demotion; these pin the rules the product promises:
 * evidence over a full window, no upgrade, a bounded number of steps, and an
 * operator choice that ends it.
 */
describe("tier controller", () => {
  const feed = (controller: TierController, ms: number, frames: number): void => {
    for (let i = 0; i < frames; i++) controller.observe(ms);
  };

  test("a full window inside the budget never demotes", () => {
    const controller = createTierController("standard");
    feed(controller, 4, FRAME_WINDOW * 3);
    expect(controller.downgrades()).toBe(0);
    expect(controller.tier()).toBe("standard");
    expect(controller.samples()).toBe(FRAME_WINDOW * 3);
  });

  test("a window exactly at the budget is not over it", () => {
    const controller = createTierController("standard");
    feed(controller, TIER_BUDGETS.standard.frameBudgetMs, FRAME_WINDOW);
    expect(controller.downgrades()).toBe(0);
  });

  test("downgrade after a full window of over-budget frames", () => {
    const controller = createTierController("standard");
    feed(controller, 40, FRAME_WINDOW - 1);
    expect(controller.downgrades()).toBe(0); // one frame short of a window
    const downgrade = controller.observe(40);
    expect(downgrade).toEqual({ from: "standard", to: "minimal", medianMs: 40, frames: FRAME_WINDOW });
    expect(controller.tier()).toBe("minimal");
  });

  test("one slow frame in an otherwise fast window does not demote", () => {
    const controller = createTierController("standard");
    for (let i = 0; i < FRAME_WINDOW; i++) controller.observe(i === 30 ? 500 : 4);
    expect(controller.downgrades()).toBe(0);
  });

  test("the window is evidence about one tier: a demotion starts a fresh one", () => {
    const controller = createTierController("high");
    feed(controller, 30, FRAME_WINDOW); // high → standard
    expect(controller.downgrades()).toBe(1);
    expect(controller.tier()).toBe("standard");
    // The frames that demoted `high` are not evidence about `standard`.
    expect(controller.observe(30)).toBeNull();
    expect(controller.downgrades()).toBe(1);
    feed(controller, 30, FRAME_WINDOW - 1);
    expect(controller.downgrades()).toBe(2);
    expect(controller.tier()).toBe("minimal");
  });

  test("never upgrades, and stops after AUTO_DOWNGRADE_LIMIT demotions", () => {
    const controller = createTierController("high");
    for (let i = 0; i < FRAME_WINDOW * 6; i++) controller.observe(200);
    expect(controller.downgrades()).toBe(AUTO_DOWNGRADE_LIMIT);
    expect(controller.tier()).toBe("minimal");
    feed(controller, 1, FRAME_WINDOW * 3);
    expect(controller.tier()).toBe("minimal");
    expect(controller.downgrades()).toBe(AUTO_DOWNGRADE_LIMIT);
  });

  test("stop() is the operator's word: the controller never fires again", () => {
    const controller = createTierController("standard");
    controller.stop();
    feed(controller, 200, FRAME_WINDOW * 2);
    expect(controller.downgrades()).toBe(0);
    expect(controller.tier()).toBe("standard");
  });

  test("the demotion ladder ends at minimal", () => {
    expect(TIER_ORDER).toEqual(["minimal", "standard", "high"]);
    expect(demoteTier("high")).toBe("standard");
    expect(demoteTier("standard")).toBe("minimal");
    expect(demoteTier("minimal")).toBeNull();
    const controller = createTierController("minimal");
    feed(controller, 500, FRAME_WINDOW * 2);
    expect(controller.downgrades()).toBe(0);
  });

  test("a non-finite or negative sample is not evidence", () => {
    const controller = createTierController("standard");
    controller.observe(Number.NaN);
    controller.observe(-5);
    controller.observe(Number.POSITIVE_INFINITY);
    expect(controller.samples()).toBe(0);
    expect(controller.medianMs()).toBe(0);
  });

  test("medianMs is the window's median, not the last frame", () => {
    const controller = createTierController("standard");
    feed(controller, 4, FRAME_WINDOW - 1);
    controller.observe(100); // 59 × 4 + 100: median still 4
    expect(controller.medianMs()).toBe(4);
    expect(controller.downgrades()).toBe(0);
  });
});

/**
 * The loop's coalescing contract (`d10`): whatever happens between two ticks
 * — a burst of model applications, hovers, camera intents — the scene draws
 * once, and the `maxFps` gate defers the whole frame rather than drawing half
 * of one. The clock and the frame scheduler are injected, so the assertions
 * are exact.
 */
interface LoopHarness {
  loop: FrameLoop;
  readonly frames: number;
  /** Run every queued rAF callback after advancing the clock. */
  flush(advanceMs?: number): void;
}

function loopHarness(options: { maxFps?: number; duringFrame?: (loop: FrameLoop) => void } = {}): LoopHarness {
  let now = 0;
  let nextHandle = 1;
  let frames = 0;
  const queue = new Map<number, (at: number) => void>();
  const harness = {
    loop: undefined as unknown as FrameLoop,
    get frames(): number {
      return frames;
    },
    flush(advanceMs = 250): void {
      const pending = [...queue.values()];
      queue.clear();
      now += advanceMs;
      for (const callback of pending) callback(now);
    },
  };
  harness.loop = createFrameLoop({
    onFrame: () => {
      frames++;
      options.duringFrame?.(harness.loop);
    },
    maxFps: options.maxFps ?? 0,
    now: () => now,
    isHidden: () => false,
    raf: (callback) => {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancelRaf: (handle) => {
      queue.delete(handle);
    },
    onVisibility: () => () => {},
  });
  return harness;
}

describe("frame coalescing", () => {
  test("a burst of requests between ticks draws one frame", () => {
    const harness = loopHarness();
    for (let i = 0; i < 25; i++) harness.loop.request();
    harness.flush();
    expect(harness.frames).toBe(1);
    expect(harness.loop.stats().frames).toBe(1);
    // …and a burst is a burst of state, not of work: nothing redraws until
    // something asks again.
    harness.flush();
    expect(harness.frames).toBe(1);
  });

  test("requests during a frame schedule exactly one more", () => {
    let bursts = 0;
    const harness = loopHarness({
      duringFrame: (loop) => {
        bursts++;
        if (bursts === 1) for (let i = 0; i < 10; i++) loop.request();
      },
    });
    harness.loop.request();
    harness.flush();
    expect(harness.frames).toBe(1);
    harness.flush();
    expect(harness.frames).toBe(2); // the ten requests, in one frame
    harness.flush();
    expect(harness.frames).toBe(2);
  });

  test("at most one frame per maxFps tick: a burst inside the gate defers whole", () => {
    const harness = loopHarness({ maxFps: 30 });
    for (let i = 0; i < 10; i++) harness.loop.request();
    harness.flush(100);
    expect(harness.frames).toBe(1);
    for (let i = 0; i < 10; i++) harness.loop.request();
    harness.flush(10); // inside the 33 ms window: the whole frame is deferred
    expect(harness.frames).toBe(1);
    expect(harness.loop.stats().deferred).toBe(1);
    harness.flush(40);
    expect(harness.frames).toBe(2);
  });
});

describe("docs/deck-performance-budget.md", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "deck-performance-budget.md"), "utf8");

  function cells(line: string): string[] {
    if (!line.trimStart().startsWith("|")) return [];
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  /** The first markdown table whose header carries every budget field. */
  function budgetTable(): { header: string[]; rows: [string, string[]][] } {
    const lines = doc.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const header = cells(lines[i]!);
      if (FIELDS.every((field) => header.includes(field))) {
        const rows: [string, string[]][] = [];
        for (let j = i + 2; j < lines.length; j++) {
          const row = cells(lines[j]!);
          if (row.length === 0) break;
          rows.push([row[0]!, row]);
        }
        return { header, rows };
      }
    }
    throw new Error("docs/deck-performance-budget.md has no table headed by the tier budget fields");
  }

  test("the tier table in the doc matches TIER_BUDGETS exactly", () => {
    const { header, rows } = budgetTable();
    for (const tier of TIERS) {
      const row = rows.find(([id]) => id === tier)?.[1];
      if (!row) throw new Error(`docs/deck-performance-budget.md tier table is missing the ${tier} row`);
      for (const field of FIELDS) {
        const cell = row[header.indexOf(field)];
        expect(`${tier}.${field} = ${cell}`).toBe(`${tier}.${field} = ${String(TIER_BUDGETS[tier][field])}`);
      }
    }
  });

  test("the doc states the method and a re-measure command that exists", () => {
    expect(doc).toContain("readPixels");
    expect(doc).toContain("min/median/max");
    expect(doc).toContain("bun scripts/deck-probe.ts --json");
    expect(doc).toContain("1.5");
  });

  test("the doc names the enforcing harness and its command exists", () => {
    expect(doc).toContain("bun scripts/deck-perf.ts");
    expect(existsSync(join(import.meta.dir, "..", "scripts", "deck-perf.ts"))).toBe(true);
    // The document is where the controller's rule is stated for operators.
    expect(doc).toContain("frameBudgetMs");
    expect(doc).toContain("exit 1");
    expect(doc).toContain("60-frame window");
  });
});
