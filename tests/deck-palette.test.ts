/**
 * The scene's colour conversion (roadmap slice `d13`).
 *
 * Two things are load-bearing here and both are couplings, not assertions about
 * taste:
 *
 *  1. `PALETTE_TOKENS` and `web/src/styles/tokens.css` cannot drift. The test
 *     parses the stylesheet and compares, so a renamed or re-valued token fails
 *     the suite instead of quietly changing the scene (and the two blocks —
 *     `:root` and `.dark` — must agree, or the scene would follow only one of
 *     the theme's two declarations).
 *  2. No colour literal exists under `web/src/scene/**` outside `palette.ts`.
 *     That is the rule that makes "the deck uses the operator's palette" a
 *     property of the source rather than a promise in a comment.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  GRID_BORDER_MULTIPLE,
  PALETTE_TOKENS,
  blendOver,
  mixColours,
  paletteFrom,
  parseColour,
  readPalette,
  type PaletteRole,
} from "../web/src/scene/palette.ts";

const repoRoot = join(import.meta.dir, "..");
const sceneRoot = join(repoRoot, "web/src/scene");
const tokensCss = readFileSync(join(repoRoot, "web/src/styles/tokens.css"), "utf8");

/** Every declaration of a custom property in the stylesheet, in file order. */
function cssValues(name: string): string[] {
  const values: string[] = [];
  for (const line of tokensCss.split("\n")) {
    const match = line.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?);\\s*$`));
    if (match) values.push(match[1]!.trim());
  }
  return values;
}

describe("the palette is the design system's", () => {
  test("every role's fallback is the token's value in tokens.css", () => {
    for (const role of Object.keys(PALETTE_TOKENS) as PaletteRole[]) {
      const token = PALETTE_TOKENS[role];
      const values = cssValues(token.cssVar);
      expect(`${token.cssVar}: ${values.length > 0}`).toBe(`${token.cssVar}: true`);
      expect(`${token.cssVar}: ${values[0]}`).toBe(`${token.cssVar}: ${token.fallback}`);
    }
  });

  test("the theme's two blocks agree, so the scene follows either one", () => {
    for (const role of Object.keys(PALETTE_TOKENS) as PaletteRole[]) {
      const values = cssValues(PALETTE_TOKENS[role].cssVar);
      expect(new Set(values).size).toBe(1);
    }
  });

  test("the document read produces the same roles the fallbacks name", () => {
    // No DOM in this process: `readPalette` must fall back, not throw, which is
    // also the behaviour a failed stylesheet gets in the browser.
    const palette = readPalette();
    for (const role of Object.keys(PALETTE_TOKENS) as PaletteRole[]) {
      expect(palette.roles[role]).toBe(PALETTE_TOKENS[role].fallback);
    }
  });
});

describe("colour parsing", () => {
  test("hex, short hex, alpha hex, rgb() and rgba()", () => {
    expect(parseColour("#ff6b6b")).toEqual([255, 107, 107, 1]);
    expect(parseColour("#f66")).toEqual([255, 102, 102, 1]);
    expect(parseColour("#ff6b6b80")).toEqual([255, 107, 107, 128 / 255]);
    expect(parseColour("rgb(18, 24, 32)")).toEqual([18, 24, 32, 1]);
    expect(parseColour("rgba(148, 163, 184, 0.20)")).toEqual([148, 163, 184, 0.2]);
    expect(parseColour("  #121820  ")).toEqual([18, 24, 32, 1]);
  });

  test("anything else is null, never a throw and never a guess", () => {
    for (const value of ["", "  ", "not-a-colour", "#12345", "rgb(1,2)", "hsl(200 40% 50%)", "#gggggg"]) {
      expect(`${value}: ${parseColour(value) === null}`).toBe(`${value}: true`);
    }
  });

  test("a token that cannot be parsed degrades to the other side, not to black", () => {
    // A stylesheet that failed to load must not paint the rail black; the
    // derived colours fall back to the token the caller *did* get.
    expect(blendOver("var(--border)", "#121820")).toBe("#121820");
    expect(mixColours("garbage", "#3ee6a6", 0.5)).toBe("#3ee6a6");
  });
});

describe("derived ambient colours", () => {
  test("the grid is the theme's border over the theme's background", () => {
    const palette = paletteFrom((name) =>
      ({
        "--background": "#121820",
        "--border": "rgba(148, 163, 184, 0.20)",
      })[name] ?? null,
    );
    expect(palette.ambient.gridMinor).toBe(blendOver("rgba(148, 163, 184, 0.20)", "#121820"));
    expect(palette.ambient.gridMajor).toBe(blendOver("rgba(148, 163, 184, 0.20)", "#121820", GRID_BORDER_MULTIPLE));
    // The major lines are the more visible of the two, and neither is opaque
    // white: the floor is a depth cue, not a subject.
    const minor = parseColour(palette.ambient.gridMinor)!;
    const major = parseColour(palette.ambient.gridMajor)!;
    expect(major[1]).toBeGreaterThan(minor[1]);
    expect(major[1]).toBeLessThan(120);
  });

  test("the clear colour and the fog are the panel's own background", () => {
    const palette = paletteFrom((name) => ({ "--background": "#121820", "--foreground": "#f2f6fa" })[name] ?? null);
    expect(palette.ambient.clear).toBe("#121820");
    expect(palette.ambient.fog).toBe("#121820");
    // Fog blends toward the clear colour, so a distinct fog colour would draw a
    // horizon line across the floor.
    expect(palette.ambient.fog).toBe(palette.ambient.clear);
  });

  test("the completion colour is the success token, verbatim", () => {
    const palette = paletteFrom((name) => ({ "--success": "#3ee6a6" })[name] ?? null);
    expect(palette.ambient.settle).toBe("#3ee6a6");
    expect(palette.roles.success).toBe("#3ee6a6");
  });

  test("a missing token falls back to the token file, not to nothing", () => {
    const palette = paletteFrom(() => null);
    expect(palette.roles.info).toBe(PALETTE_TOKENS.info.fallback);
    expect(palette.roles.background).toBe(PALETTE_TOKENS.background.fallback);
    expect(parseColour(palette.ambient.gridMinor)).not.toBeNull();
  });

  test("every derived colour is opaque hex (the renderer parses them as colours)", () => {
    const palette = paletteFrom(() => null);
    for (const value of Object.values(palette.ambient)) {
      const parsed = parseColour(value);
      expect(parsed).not.toBeNull();
      expect(parsed![3]).toBe(1);
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("mixColours is linear and clamped", () => {
    expect(mixColours("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColours("#000000", "#ffffff", -1)).toBe("#000000");
    expect(mixColours("#000000", "#ffffff", 2)).toBe("#ffffff");
  });
});

describe("the scene has no second palette", () => {
  test("no colour literal exists under scene/** outside palette.ts", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    walk(sceneRoot);
    expect(files.length).toBeGreaterThan(10);
    const violations: string[] = [];
    for (const file of files) {
      const name = file.slice(sceneRoot.length + 1);
      if (name === "palette.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/0x[0-9a-fA-F]{6,8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
        // The hex-ish things that are not colours at all: HTML/entity escapes
        // and the model's own unit separators are written as \u0001 escapes, so
        // anything left is a colour decision in the wrong file.
        violations.push(`${name}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
