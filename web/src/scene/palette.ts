/**
 * The scene's colour vocabulary (roadmap slice `d13`): the **single** place
 * where a design token becomes a scene colour.
 *
 * Before this module the renderer carried two sets of literals — the six
 * status tokens it read from `tokens.css`, and a handful of hard-coded hex
 * values (the clear colour, the floor grid's two line colours, the beacon
 * fade target) that no designer could find. Both live here now: the semantic
 * roles are read from the document once at renderer creation, and everything
 * derived is a pure function of those reads, so a theme change moves the
 * scene with it and `tests/deck-palette.test.ts` can assert the coupling
 * against `tokens.css` itself.
 *
 * Pure module: no DOM (the caller injects the token reader), no `three`. The
 * values are CSS colour strings — `renderer.ts` is the only module that turns
 * them into `THREE.Color`, which is what keeps `three` out of this file
 * (release gate: `scene/ambient.ts` and `scene/palette.ts` are the module map's
 * pure entries).
 *
 * The scene is a projection of the dashboard's design system, never a second
 * palette (CP-3): if a token is missing or unreadable, the fallback here is
 * the literal in `tokens.css` — a failed stylesheet must not paint the rail
 * black, and it must not silently invent a colour either.
 */

/**
 * The token-bearing roles. `PALETTE_TOKENS[role].fallback` is the value
 * `tokens.css` defines, and the test parses that file to prove it — a token
 * rename or a dark/light divergence fails the suite rather than changing the
 * scene quietly.
 */
export type PaletteRole =
  | "info"
  | "success"
  | "warning"
  | "destructive"
  | "muted"
  | "ring"
  | "background"
  | "foreground"
  | "card"
  | "border";

export interface PaletteToken {
  /** The CSS custom property, as `tokens.css` spells it. */
  cssVar: string;
  /** Its value in `tokens.css` — the fallback when the document has none. */
  fallback: string;
}

export const PALETTE_TOKENS: Record<PaletteRole, PaletteToken> = {
  info: { cssVar: "--info", fallback: "#35d6f2" },
  success: { cssVar: "--success", fallback: "#3ee6a6" },
  warning: { cssVar: "--warning", fallback: "#ffb838" },
  destructive: { cssVar: "--destructive", fallback: "#ff6b6b" },
  muted: { cssVar: "--muted-foreground", fallback: "#8595a8" },
  ring: { cssVar: "--ring", fallback: "#8f86ff" },
  background: { cssVar: "--background", fallback: "#121820" },
  foreground: { cssVar: "--foreground", fallback: "#f2f6fa" },
  card: { cssVar: "--card", fallback: "#1a222e" },
  border: { cssVar: "--border", fallback: "rgba(148, 163, 184, 0.20)" },
};

/** The scene's own derived roles (no token of their own — see `paletteFrom`). */
export type AmbientRole = "clear" | "fog" | "gridMinor" | "gridMajor" | "settle";

export interface ScenePalette {
  /** Semantic token values, verbatim as the document reports them. */
  roles: Record<PaletteRole, string>;
  /** Derived scene colours, all opaque `#rrggbb`. */
  ambient: Record<AmbientRole, string>;
}

/**
 * The floor's line strengths: `--border` composited over `--background` at its
 * own alpha (minor) and at this multiple of it (major). One knob, so the floor
 * follows the theme's own border colour instead of a second opinion about what
 * "quiet grid" means.
 */
export const GRID_BORDER_MULTIPLE = 1.7;

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` → `[r, g, b, a]`. */
export function parseColour(value: string): [number, number, number, number] | null {
  const text = value.trim().toLowerCase();
  if (text.length === 0) return null;
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    const short = hex.length === 3 || hex.length === 4;
    if (!short && hex.length !== 6 && hex.length !== 8) return null;
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const parts = short ? [...hex].map((digit) => digit + digit) : (hex.match(/../g) ?? []);
    const [r, g, b, a] = parts.map((part) => parseInt(part, 16));
    if (r === undefined || g === undefined || b === undefined) return null;
    return [r, g, b, a === undefined ? 1 : a / 255];
  }
  const fn = text.match(/^rgba?\(([^)]+)\)$/);
  if (!fn) return null;
  const parts = fn[1]!
    .split(/[\s,/]+/)
    .filter((part) => part.length > 0);
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 4).map((part) => (part.endsWith("%") ? (parseFloat(part) / 100) * 255 : parseFloat(part)));
  const [r, g, b, a] = channels;
  if (r === undefined || g === undefined || b === undefined) return null;
  if ([r, g, b].some((channel) => !Number.isFinite(channel))) return null;
  const alpha = a === undefined ? 1 : Number.isFinite(a) ? a : 1;
  return [clamp255(r), clamp255(g), clamp255(b), Math.min(1, Math.max(0, alpha))];
}

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => clamp255(channel).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Composite `top` over `bottom` with the top's own alpha (times `strength`).
 * Both inputs are CSS colour strings; an unparseable input falls back to the
 * other side rather than throwing — a broken token degrades, it does not
 * crash the scene.
 */
export function blendOver(top: string, bottom: string, strength = 1): string {
  const front = parseColour(top);
  const back = parseColour(bottom);
  if (!front) return back ? hex(back[0], back[1], back[2]) : bottom;
  if (!back) return hex(front[0], front[1], front[2]);
  const alpha = Math.min(1, Math.max(0, front[3] * strength));
  return hex(
    front[0] * alpha + back[0] * (1 - alpha),
    front[1] * alpha + back[1] * (1 - alpha),
    front[2] * alpha + back[2] * (1 - alpha),
  );
}

/** Linear blend `from` → `to` at `t` (0 = from, 1 = to), opaque result. */
export function mixColours(from: string, to: string, t: number): string {
  const a = parseColour(from);
  const b = parseColour(to);
  if (!a) return b ? hex(b[0], b[1], b[2]) : from;
  if (!b) return hex(a[0], a[1], a[2]);
  const amount = Math.min(1, Math.max(0, t));
  return hex(a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount);
}

/**
 * Build the palette from a token reader (`cssVar → value | null`). The reader
 * is injected so the whole conversion is a unit test with a fixed token map —
 * the DOM read is one line at the bottom of this file.
 *
 * The ambient derivations, and why each is not a new colour:
 *
 *  - `clear`/`fog`: the document's own background. The floor's vanishing point
 *    must be the panel the deck sits in, or the depth cue reads as a seam.
 *  - `gridMinor`/`gridMajor`: the theme's border colour composited over that
 *    background — the floor is "a quieter border", not a second palette.
 *  - `settle`: the success token, which is what a completed slice already
 *    means; the settle plate is that colour arriving and fading, never a new
 *    one.
 */
export function paletteFrom(read: (cssVar: string) => string | null): ScenePalette {
  const roles = {} as Record<PaletteRole, string>;
  for (const role of Object.keys(PALETTE_TOKENS) as PaletteRole[]) {
    const token = PALETTE_TOKENS[role];
    const raw = read(token.cssVar)?.trim() ?? "";
    roles[role] = raw.length > 0 ? raw : token.fallback;
  }
  return {
    roles,
    ambient: {
      clear: blendOver(roles.background, roles.background),
      // Fog is the background exactly: what recedes dissolves into the panel,
      // so the deck's edges never show a horizon line.
      fog: blendOver(roles.background, roles.background),
      gridMinor: blendOver(roles.border, roles.background),
      gridMajor: blendOver(roles.border, roles.background, GRID_BORDER_MULTIPLE),
      settle: roles.success,
    },
  };
}

/** Read the palette from the live document (`document.documentElement`). */
export function readPalette(): ScenePalette {
  const computed = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
  return paletteFrom((cssVar) => computed?.getPropertyValue(cssVar) ?? null);
}
