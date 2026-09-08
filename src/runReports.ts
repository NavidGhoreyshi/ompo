/**
 * End-of-run reporters (Sprint 4).
 *
 * Verbatim extraction from `loop.ts`: no behavior change. The placeholder
 * swap report and the deferred-manifest writer run at loop finish; they are
 * reporting, not orchestration, so they live outside the core.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./attempt.ts";
import { isDeploySlice, loadPlaceholders, placeholdersDocRef } from "./placeholders.ts";
import { loadRun, RUNS_DIR, sliceDir } from "./store.ts";
import type { CompletionReport, RoadmapDoc } from "./types.ts";

/**
 * End-of-run swap report: var names (never values — those live in the doc)
 * plus the deploy-gate call to action when only deployment slices remain.
 */
export function reportPlaceholders(opts: { projectDir: string; runId: string; onEvent?: (msg: string) => void }): void {
  const all = loadPlaceholders(opts.projectDir, opts.runId);
  const names = Object.keys(all);
  if (names.length === 0) return;
  const ref = placeholdersDocRef(opts.runId);
  log(opts, `placeholders: ${names.length} dev-only value(s) — ${names.join(", ")} (see ${ref})`);
  const doc = loadRun(opts.projectDir, opts.runId).doc;
  const remaining = doc.slices.filter((s) => !["done", "failed", "skipped"].includes(s.status));
  if (remaining.length > 0 && remaining.every((s) => isDeploySlice(s.id, s.title))) {
    log(opts, `only deployment slice(s) left (${remaining.map((s) => s.id).join(", ")}) — swap real values, exercise the UI/UX, then deploy`);
  } else {
    log(opts, `swap real values before the deploy slice / final UI-UX pass`);
  }
}

/**
 * End-of-run deferred manifest (never-block rule): every done slice's
 * report.json `deferred` list lands in one checklist with the values needed
 * plus the manual check, so the operator's post-run pass is a single doc.
 * Best-effort: unreadable reports are skipped, never fatal.
 */
export function reportDeferred(opts: { projectDir: string; runId: string; onEvent?: (msg: string) => void }): void {
  let doc: RoadmapDoc;
  try {
    doc = loadRun(opts.projectDir, opts.runId).doc;
  } catch {
    return;
  }
  const sections: string[] = [];
  let items = 0;
  for (const s of doc.slices) {
    if (s.status !== "done") continue;
    let deferred: unknown;
    try {
      deferred = (JSON.parse(readFileSync(join(sliceDir(opts.projectDir, opts.runId, s.id), "report.json"), "utf8")) as CompletionReport).deferred;
    } catch {
      continue;
    }
    if (!Array.isArray(deferred)) continue;
    const lines = deferred.filter((d): d is string => typeof d === "string" && d.trim() !== "");
    if (lines.length === 0) continue;
    items += lines.length;
    sections.push(`## ${s.id} — ${s.title}\n${lines.map((d) => `- ${d}`).join("\n")}`);
  }
  if (sections.length === 0) return;
  try {
    mkdirSync(join(opts.projectDir, RUNS_DIR, opts.runId), { recursive: true });
    writeFileSync(
      join(opts.projectDir, RUNS_DIR, opts.runId, "deferred.md"),
      `# Deferred live values — run ${opts.runId}\n\nFill these with real values after the run, then run each manual check.\n\n${sections.join("\n\n")}\n`,
      "utf8",
    );
  } catch {
    return;
  }
  log(opts, `deferred: ${items} live check(s) across ${sections.length} slice(s) (see ${join(RUNS_DIR, opts.runId, "deferred.md")})`);
}
