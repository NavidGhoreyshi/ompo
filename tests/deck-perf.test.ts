/**
 * Deck quality tiers (roadmap slice `d00`): the classifier that picks a tier
 * from the WebGL renderer string, and the budget table every later slice is
 * measured against.
 *
 * The last test is the load-bearing one: `docs/deck-performance-budget.md` is
 * the document operators read and `TIER_BUDGETS` is what the scene obeys, so
 * the two are parsed against each other rather than trusted to stay in sync.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyRenderer, SOFTWARE_RENDERER_RE, TIER_BUDGETS, type TierBudget } from "../web/src/scene/tier.ts";

const TIERS = ["minimal", "standard", "high"] as const;
const FIELDS: (keyof TierBudget)[] = [
  "resolutionScale",
  "maxFps",
  "antialias",
  "maxDrawCalls",
  "maxStations",
  "maxBeacons",
  "ambient",
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
  });

  test("the minimal tier is the one that has to survive software rasterization", () => {
    expect(TIER_BUDGETS.minimal.resolutionScale).toBeLessThan(1);
    expect(TIER_BUDGETS.minimal.maxFps).toBeLessThanOrEqual(30);
    expect(TIER_BUDGETS.minimal.antialias).toBe(false);
    expect(TIER_BUDGETS.minimal.ambient).toBe(false);
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
});
