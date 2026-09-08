#!/usr/bin/env bun
/**
 * Capture generator (Sprint 4) — deterministic ASCII fixture compositions for
 * later HUMAN visual inspection of TUI states.
 *
 * These are NOT real terminal renders: they compose the same pure helpers the
 * TUIs use (layoutRects, dagDepths, dagIndent, forensicsLayout,
 * renderPreviewLines) into text frames. Ink borders/colors/ellipsizing are
 * approximated with ASCII. Every file is labeled as such.
 *
 * Run: `bun scripts/gen-captures.ts` — writes `captures/*.txt` (tracked: .omp/ is gitignored).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPlanPreview,
  formatPreviewSummary,
  renderPreviewLines,
} from "../src/planPreview.ts";
import { activityRows } from "../src/run.tsx";
import {
  dagDepths,
  dagIndent,
  forensicsLayout,
  layoutRects,
  type SliceLine,
} from "../src/watch.tsx";

const OUT = join(import.meta.dir, "..", "captures");
mkdirSync(OUT, { recursive: true });

const HEAD = (name: string): string =>
  [
    `# ${name}`,
    `# FIXTURE COMPOSITION — not a real terminal render.`,
    `# Composed from the TUI pure helpers (layoutRects/dagDepths/forensicsLayout/…);`,
    `# Ink borders, colors, and wrapping are approximated in ASCII.`,
    `# STRUCTURAL MODEL ONLY — VISUAL QUALITY NOT VERIFIED.`,
    ``,
  ].join("\n");

function emit(name: string, body: string): void {
  writeFileSync(join(OUT, name), HEAD(name) + body.replace(/\s+$/, "") + "\n", "utf8");
  console.log(`wrote captures/${name}`);
}

type S = Pick<SliceLine, "id" | "status" | "attempts" | "deps">;
const GLYPH: Record<string, string> = {
  pending: "○", running: "●", verifying: "●", done: "✓",
  failed: "!", aborted: "–", blocked: "○", "blocked-env": "○", skipped: "○",
};

function boardRows(slices: S[], sel: number, dag: boolean, width: number): string[] {
  const depths = dag ? dagDepths(slices as SliceLine[]) : null;
  const maxName = Math.max(8, width - 16);
  return slices.map((s, i) => {
    const cursor = i === sel ? "▸" : " ";
    const name = s.id.length > maxName ? `${s.id.slice(0, maxName - 1)}…` : s.id;
    const att = s.attempts > 1 ? ` ×${s.attempts}` : "";
    const indent = dag ? dagIndent(depths!.get(s.id) ?? 0) : "";
    const suffix = dag && (s.deps?.length ?? 0) > 0 ? ` ← ${s.deps!.join(",")}` : "";
    return `${cursor} ${GLYPH[s.status] ?? "?"} [${s.status.padEnd(5)}] ${indent}${name}${att}${suffix}`;
  });
}

const MIXED: S[] = [
  { id: "s1-scaffold", status: "done", attempts: 1, deps: [] },
  { id: "s2-api", status: "done", attempts: 2, deps: ["s1-scaffold"] },
  { id: "s3-ui", status: "running", attempts: 1, deps: ["s2-api"] },
  { id: "s4-gates", status: "verifying", attempts: 3, deps: ["s2-api"] },
  { id: "s5-deploy", status: "pending", attempts: 1, deps: ["s3-ui", "s4-gates"] },
];
const FAILED: S[] = [
  { id: "s1-scaffold", status: "done", attempts: 1, deps: [] },
  { id: "s2-api", status: "failed", attempts: 2, deps: ["s1-scaffold"] },
  { id: "s3-ui", status: "blocked-env", attempts: 1, deps: ["s2-api"] },
  { id: "s4-gates", status: "failed", attempts: 4, deps: ["s2-api"] },
];

function frame(cols: number, rows: number, title: string, panes: string[]): string {
  const bar = "═".repeat(Math.min(cols, 110));
  return [`${title} (${cols}×${rows})`, bar, ...panes].join("\n");
}

// 1. Normal width board + inspector skeleton.
{
  const cols = 120, rows = 30;
  const r = layoutRects(cols);
  emit("normal-120.txt", frame(cols, rows, "watch — mixed run", [
    `board rail w=${r.board} gutter=${r.gutter} | inspector takes the rest`,
    ...boardRows(MIXED, 2, false, r.board),
    ``,
    `inspector [Output] s3-ui — Title s3-ui (s3-ui)`,
    `● running · attempt 1`,
    `worker tail: [s3-ui] turn 4…  [s3-ui] tool bash: bun test`,
    ``,
    `activity rows=${activityRows(rows)}: … s3-ui still running (2m elapsed, 4 turns, 12 tools)`,
  ]));
}

// 2. Narrow stacked.
{
  const cols = 70, rows = 30;
  const r = layoutRects(cols);
  emit("narrow-70.txt", frame(cols, rows, "watch — narrow stacked", [
    `narrow=${r.narrow} board w=${r.board} (stacked, no gutter)`,
    ...boardRows(MIXED, 2, false, r.board),
    `--- inspector (stacked below) ---`,
    `inspector [Verify] s4-gates · gates: 1/2 pass`,
  ]));
}

// 3. DAG mode.
{
  const cols = 100, rows = 30;
  const r = layoutRects(cols);
  emit("dag-100.txt", frame(cols, rows, "watch — DAG board (g)", [
    ...boardRows(MIXED, 4, true, r.board),
  ]));
}

// 4. Populated inspector tabs.
{
  emit("inspector-populated.txt", [
    `inspector tabs: 1:Output 2:Diff 3:Verify 4:Review 5:Prompt 6:Events`,
    `--- [Output] ---`, `report: did s4-gates · worker exited in 96s (3 turns, 8 tools)`,
    `--- [Diff] ---`, `filesChanged: src/gates.ts (+120/-8)`,
    `--- [Verify] ---`, `✓ bun test (4.2s) · FAIL bun lint exit=1`,
    `--- [Review] ---`, `rejected (minor): rename helper; missing edge test`,
    `--- [Prompt] ---`, `prompt-3.md tail (30 lines)…`,
    `--- [Events] ---`, `12:00:01 verify_failed s4-gates · 12:00:02 slice_retried s4-gates`,
  ].join("\n"));
}

// 5. Concurrent agents.
{
  emit("concurrent-agents.txt", [
    `agents · 🔒 s4-gates`,
    `L0 ● s3-ui [run ] — agent — turn 4…`,
    `L1 ● s4-gates [gates] — verify — verify: $ bun lint`,
  ].join("\n"));
}

// 6. Failure state + filter.
{
  const cols = 120;
  const r = layoutRects(cols);
  emit("failure-state.txt", frame(cols, 30, "watch — failures (F filters)", [
    `all:`, ...boardRows(FAILED, 1, false, r.board),
    ``, `failures-only (F):`,
    ...boardRows(FAILED.filter((s) => s.status === "failed" || s.status === "blocked-env"), 0, false, r.board),
  ]));
}

// 7. Fullscreen forensics.
{
  const tail = Array.from({ length: 60 }, (_, i) => `[s4-gates] worker line ${i + 1}: some output with detail ${"x".repeat(40)}`);
  const w = forensicsLayout(tail, 30, 120, 0);
  emit("forensics-fullscreen.txt", [
    `forensics · Title s4-gates (s4-gates)`,
    `dir: .omp/roadmap/runs/<run>/slices/s4-gates · branch: ompo/<run>/s4-gates`,
    `log: worker-3.log · gates: 1/2 pass · review: rejected`,
    `cw=${w.cw} bodyH=${w.bodyH} offset=${w.offset}`,
    ...w.shown.slice(-8),
    `↑/↓ PgUp/PgDn scroll ● live │ y yank path │ Esc/Enter close`,
  ].join("\n"));
}

// 8/9. Planner preview ready + blocked.
{
  const md = [
    "## [s1] First slice work item here", "Do A thoroughly and completely now.", "Effort: lo", "Verify: bun test", "",
    "## [s2] Second work item here", "Do B thoroughly and completely now.", "Effort: med", "Depends: s1", "Verify: bun test",
  ].join("\n");
  const p = buildPlanPreview(md);
  emit("preview-ready.txt", [...renderPreviewLines(p), formatPreviewSummary(p)].join("\n"));
  const bad = buildPlanPreview("## [s1] First slice work item here\nDo A thoroughly and completely now.\nDepends: nope\nVerify: true\n");
  emit("preview-blocked.txt", [...renderPreviewLines(bad), formatPreviewSummary(bad)].join("\n"));
}
