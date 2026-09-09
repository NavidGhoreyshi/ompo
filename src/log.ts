/**
 * ompo log — human/JSON rendering of a run's event stream.
 *
 * Reads only (never writes): the store's events.jsonl + roadmap.json are the
 * audit trail, and this command is a passive viewer over them, so it costs
 * the orchestrator nothing. Meant as the first step toward `ompo watch`
 * (same data, interactive surface).
 *
 *   ompo log                          # latest run, pretty
 *   ompo log --run 20260906-bw44p5    # a specific run
 *   ompo log --follow                 # tail the (possibly live) run
 *   ompo log --json                   # raw events, one JSON object per line
 *
 * Event lines render the fields ompo persists: seq, time, type, slice id,
 * attempt, plus the enrichment fields added later (exit/timedOut/durationMs/
 * reason/stats) when present. Old runs (before enrichment) render the same
 * columns with "-" for the missing fields, so history stays readable.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listRuns, loadRun, readEvents } from "./store.ts";
import { formatCiEvent, parseCiFormat, type CiFormat } from "./ci.ts";
import type { RunEvent } from "./types.ts";
const TYPES: Record<RunEvent["type"], { color: number; label: string }> = {
  run_started: { color: 36, label: "started" }, // cyan
  slice_claimed: { color: 36, label: "claimed" }, // cyan
  worker_finished: { color: 33, label: "worker" }, // yellow
  verify_passed: { color: 32, label: "verify ok" }, // green
  verify_failed: { color: 31, label: "verify FAIL" }, // red
  slice_retried: { color: 33, label: "retried" }, // yellow
  slice_handoff: { color: 36, label: "handoff" }, // cyan
  slice_done: { color: 32, label: "done" }, // green
  slice_reverified: { color: 36, label: "reverified" }, // cyan
  slice_failed_terminal: { color: 31, label: "TERMINAL" }, // red
  slice_blocked_env: { color: 35, label: "env blocked" }, // magenta
  slice_skipped: { color: 90, label: "skipped" }, // gray
  slice_killed: { color: 31, label: "killed" }, // red
  secret_accepted: { color: 33, label: "secret ok" }, // yellow: operator-blessed finding
  run_aborted: { color: 31, label: "ABORTED" }, // red
  run_resumed: { color: 36, label: "resumed" }, // cyan
  run_finished: { color: 90, label: "finished" }, // gray
  control_requested: { color: 36, label: "control?" }, // cyan
  control_applied: { color: 32, label: "control ok" }, // green
  control_rejected: { color: 33, label: "control no" }, // yellow
  roadmap_replanned: { color: 35, label: "replanned" }, // magenta
};

const tty = process.stdout.isTTY === true;
function paint(code: number, s: string): string {
  return tty ? `\u001b[${code}m${s}\u001b[0m` : s;
}
function dim(s: string): string {
  return paint(90, s);
}

function hhmmss(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Compact "why" suffix from the enriched fields (all optional). */
function extraSuffix(ev: RunEvent): string {
  const parts: string[] = [];
  if (ev.reason) parts.push(`reason=${ev.reason}`);
  if (ev.exit !== undefined && ev.exit !== null) parts.push(`exit=${ev.exit}`);
  if (ev.timedOut !== undefined) parts.push(`timedOut=${ev.timedOut}`);
  if (ev.durationMs !== undefined && ev.durationMs !== null) {
    parts.push(`duration=${(ev.durationMs / 1000).toFixed(1)}s`);
  }
  if (ev.stats) {
    parts.push(`${ev.stats.turns}turns ${ev.stats.tools}tools`);
    if (ev.stats.tokens) parts.push(`tok in=${ev.stats.tokens.input} out=${ev.stats.tokens.output} total=${ev.stats.tokens.total}`);
  }
  return parts.length > 0 ? dim(parts.join(" ")) : "";
}

function formatDetail(ev: RunEvent): string {
  const base = ev.detail ? ` ${dim(ev.detail)}` : "";
  const extra = extraSuffix(ev);
  return `${base}${extra ? ` ${extra}` : ""}`;
}

function humanLine(ev: RunEvent): string {
  const t = TYPES[ev.type] ?? { color: 90, label: ev.type };
  const type = paint(t.color, ev.type.padEnd(22));
  const slice = (ev.sliceId ?? "").padEnd(26);
  const att = ev.attempt !== undefined ? `#${ev.attempt}` : "-";
  return (
    ` ${String(ev.seq).padStart(3)} ${dim(hhmmss(ev.at))} ${type} ${slice} ${att.padStart(2)}` +
    formatDetail(ev)
  );
}

export function resolveRunId(project: string, run?: string): string | null {
  if (run) return run;
  const runs = listRuns(project);
  return runs.length > 0 ? runs[runs.length - 1]! : null;
}

export interface LogOptions {
  project: string;
  run?: string;
  follow: boolean;
  json: boolean;
  /** pretty|json|tap|github (default pretty; --json forces json). */
  format?: string;
}

/** Print the header line describing the run (pretty mode only). */
function header(project: string, runId: string): void {
  const cursor = loadRun(project, runId);
  console.log(
    `${dim("run")} ${runId} — ${cursor.doc.slices.length} slices · ${dim("created")} ` +
      `${dim(cursor.createdAt)} · ${dim("updated")} ${dim(cursor.updatedAt)}`,
  );
}

/** Tail the events file for `--follow`: poll size, print only new seqs. */
async function follow(project: string, runId: string, format: CiFormat): Promise<number> {
  const path = join(project, ".omp", "roadmap", "runs", runId, "events.jsonl");
  let lastSize = 0;
  let lastSeq = 0;
  const tick = async (): Promise<void> => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size === lastSize) return;
    const text = readFileSync(path, "utf8");
    lastSize = size;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let ev: RunEvent;
      try {
        ev = JSON.parse(line) as RunEvent;
      } catch {
        continue; // torn write — retry next poll
      }
      if (ev.seq <= lastSeq) continue;
      lastSeq = ev.seq;
      if (format === "pretty") console.log(`${paint(90, ">")}${humanLine(ev)}`);
      else console.log(formatCiEvent(ev, format, { n: ev.seq, total: ev.seq + 1 }));
    }
  };
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, 400));
  }
}

export async function cmdLog(o: LogOptions): Promise<number> {
  const runId = resolveRunId(o.project, o.run);
  if (!runId) {
    console.log("no runs yet");
    return 0;
  }
  let format: CiFormat = "pretty";
  try {
    if (o.format !== undefined) format = parseCiFormat(o.format);
    else if (o.json) format = "json";
  } catch (err) {
    console.error(String((err as Error).message));
    return 1;
  }
  const events = readEvents(o.project, runId);
  if (format === "pretty") header(o.project, runId);
  if (!o.follow) {
    if (format === "pretty" && events.length === 0) console.log(dim("(no events)"));
    events.forEach((ev, i) => {
      if (format === "pretty") console.log(humanLine(ev));
      else console.log(formatCiEvent(ev, format, { n: i + 1, total: events.length }));
    });
    return 0;
  }
  // Follow: print what exists, then tail.
  events.forEach((ev, i) => {
    if (format === "pretty") console.log(humanLine(ev));
    else console.log(formatCiEvent(ev, format, { n: i + 1, total: events.length }));
  });
  console.log(dim("— following (Ctrl-C to stop) —"));
  return follow(o.project, runId, format);
}
