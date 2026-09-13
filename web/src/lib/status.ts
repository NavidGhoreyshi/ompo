/**
 * Status language shared by every surface: the tone a status maps to for
 * colour, and the text symbol that carries the same fact without colour
 * (`d09`: no status may be conveyed by colour alone). Pure: no React, no DOM,
 * so the deck's flat projection (`scene/fallback.ts`) can use the glyphs
 * without importing a component module.
 */

export type Tone = "cyan" | "green" | "amber" | "red" | "muted";

export function toneForStatus(status: string): Tone {
  switch (status) {
    case "running":
    case "verifying":
    case "active":
    case "live":
      return "cyan";
    case "done":
    case "passed":
      return "green";
    case "failed":
    case "aborted":
      return "red";
    case "blocked-env":
    case "blocked":
    case "warning":
      return "amber";
    default:
      return "muted";
  }
}

/** Text symbol per status family: status never relies on color alone. */
export function symbolForStatus(status: string): string {
  switch (status) {
    case "done":
    case "passed":
      return "✓";
    case "running":
    case "verifying":
    case "active":
    case "live":
      return "●";
    case "failed":
    case "aborted":
      return "✕";
    case "blocked-env":
    case "blocked":
    case "warning":
      return "▲";
    case "pending":
      return "○";
    case "skipped":
      return "–";
    default:
      return "•";
  }
}
