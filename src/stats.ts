/**
 * Run stats / query / export / replay — read-only forensics over the store.
 *
 * Reads the run cursor (roadmap.json), the event log (events.jsonl), and the
 * per-slice artifacts (verdict.json, worker-*.models.json, deferred.md,
 * placeholders.md). Never writes. All file access goes through an injectable
 * `StatsIo` so tests can run against tmp fixtures without mocking node:fs.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rebuildStatusesFromEvents } from "./store.ts";
import type { RoadmapDoc, RunEvent, Slice } from "./types.ts";

export interface StatsIo {
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
}

function defaultIo(): Required<StatsIo> {
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    exists: (p) => existsSync(p),
    listDir: (p) => readdirSync(p),
  };
}

function ioWith(io?: StatsIo): Required<StatsIo> {
  const d = defaultIo();
  return {
    readFile: io?.readFile ?? d.readFile,
    exists: io?.exists ?? d.exists,
    listDir: io?.listDir ?? d.listDir,
  };
}

function runDir(projectDir: string, runId: string): string {
  return join(projectDir, ".omp", "roadmap", "runs", runId);
}

function tryRead(io: Required<StatsIo>, p: string): string | null {
  try {
    if (!io.exists(p)) return null;
    return io.readFile(p);
  } catch {
    return null;
  }
}

function tryJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface EffortStats {
  count: number;
  done: number;
  meanDurationMs: number | null;
  meanTurns: number | null;
  meanTools: number | null;
}

export interface RunStats {
  runId: string;
  totals: Record<string, number>;
  passRate: number | null;
  attempts: { total: number; perSlice: Record<string, number> };
  meanTurns: number | null;
  meanTools: number | null;
  meanDurationMs: number | null;
  byEffort: Record<"lo" | "med" | "hi" | "none", EffortStats>;
  topFailingGates: { command: string; fails: number }[];
  modelFallbacks: Record<string, number>;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

interface CursorShape {
  doc?: { slices?: Slice[] };
}

function loadCursorSlices(io: Required<StatsIo>, projectDir: string, runId: string): Slice[] {
  const text = tryRead(io, join(runDir(projectDir, runId), "roadmap.json"));
  const cursor = tryJson<CursorShape>(text);
  const slices = cursor?.doc?.slices;
  return Array.isArray(slices) ? slices : [];
}

function loadEvents(io: Required<StatsIo>, projectDir: string, runId: string): RunEvent[] {
  const text = tryRead(io, join(runDir(projectDir, runId), "events.jsonl"));
  if (!text || !text.trim()) return [];
  const out: RunEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RunEvent);
    } catch {
      /* skip corrupt lines — forensics stay best-effort */
    }
  }
  return out;
}

function dirEntries(io: Required<StatsIo>, p: string): string[] {
  try {
    if (!io.exists(p)) return [];
    return io.listDir(p);
  } catch {
    return [];
  }
}

function verdictGateCounts(
  io: Required<StatsIo>,
  projectDir: string,
  runId: string,
  slices: Slice[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of slices) {
    const text = tryRead(io, join(runDir(projectDir, runId), "slices", s.id, "verdict.json"));
    const verdict = tryJson<{ steps?: { command?: string; exit?: number | null }[] }>(text);
    if (!verdict || !Array.isArray(verdict.steps)) continue;
    for (const step of verdict.steps) {
      if (typeof step?.command !== "string" || step.command.length === 0) continue;
      if (step.exit === 0) continue;
      counts.set(step.command, (counts.get(step.command) ?? 0) + 1);
    }
  }
  return counts;
}

function countModelValue(into: Record<string, number>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    into[value] = (into[value] ?? 0) + 1;
  } else if (Array.isArray(value)) {
    for (const v of value) countModelValue(into, v);
  }
}

function collectModelFallbacks(
  io: Required<StatsIo>,
  projectDir: string,
  runId: string,
  slices: Slice[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of slices) {
    const dir = join(runDir(projectDir, runId), "slices", s.id);
    // List the slice dir (tolerates runs that never wrote per-slice dirs),
    // plus the run-level slices dir as a fallback for injected io doubles.
    const names = dirEntries(io, dir);
    for (const name of names) {
      if (!name.startsWith("worker-") || !name.endsWith(".models.json")) continue;
      const parsed = tryJson<unknown>(tryRead(io, join(dir, name)));
      if (parsed === null || parsed === undefined) continue;
      if (Array.isArray(parsed)) {
        countModelValue(counts, parsed);
        continue;
      }
      if (typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        for (const key of ["tried", "chain", "fallbacks", "models"]) {
          if (key in rec) countModelValue(counts, rec[key]);
        }
        for (const key of ["accepted", "resolvedModel", "model"]) {
          if (typeof rec[key] === "string") countModelValue(counts, rec[key]);
        }
      } else {
        countModelValue(counts, parsed);
      }
    }
  }
  return counts;
}

/**
 * Aggregate run statistics. Never throws on missing artifacts — absent
 * files yield null means / empty maps instead.
 */
export function computeStats(projectDir: string, runId: string, io?: StatsIo): RunStats {
  const files = ioWith(io);
  const slices = loadCursorSlices(files, projectDir, runId);
  const events = loadEvents(files, projectDir, runId);

  const totals: Record<string, number> = {};
  for (const s of slices) {
    totals[s.status] = (totals[s.status] ?? 0) + 1;
  }
  const done = totals["done"] ?? 0;
  const failed = totals["failed"] ?? 0;
  const passRate = done + failed > 0 ? done / (done + failed) : null;

  const perSlice: Record<string, number> = {};
  let totalAttempts = 0;
  for (const s of slices) {
    const n = typeof s.attempts === "number" ? s.attempts : 0;
    perSlice[s.id] = n;
    totalAttempts += n;
  }

  const finished = events.filter((e) => e.type === "worker_finished");
  const durations = finished
    .map((e) => e.durationMs)
    .filter((v): v is number => typeof v === "number");
  const turns = finished
    .map((e) => e.stats?.turns)
    .filter((v): v is number => typeof v === "number");
  const tools = finished
    .map((e) => e.stats?.tools)
    .filter((v): v is number => typeof v === "number");

  const groups: Record<"lo" | "med" | "hi" | "none", Slice[]> = {
    lo: [],
    med: [],
    hi: [],
    none: [],
  };
  for (const s of slices) groups[(s.effort ?? "none") as keyof typeof groups].push(s);
  const byEffort = {} as RunStats["byEffort"];
  for (const key of ["lo", "med", "hi", "none"] as const) {
    const group = groups[key];
    const ids = new Set(group.map((s) => s.id));
    const fe = finished.filter((e) => e.sliceId !== undefined && ids.has(e.sliceId));
    byEffort[key] = {
      count: group.length,
      done: group.filter((s) => s.status === "done").length,
      meanDurationMs: mean(
        fe.map((e) => e.durationMs).filter((v): v is number => typeof v === "number"),
      ),
      meanTurns: mean(
        fe.map((e) => e.stats?.turns).filter((v): v is number => typeof v === "number"),
      ),
      meanTools: mean(
        fe.map((e) => e.stats?.tools).filter((v): v is number => typeof v === "number"),
      ),
    };
  }
  // (blank — verdict gate counts follow)

  let gateCounts = verdictGateCounts(files, projectDir, runId, slices);
  if (gateCounts.size === 0) {
    // Fallback: no verdict artifacts on disk — group verify_failed details.
    gateCounts = new Map<string, number>();
    for (const e of events) {
      if (e.type !== "verify_failed") continue;
      const key = e.detail ?? e.reason ?? e.type;
      if (!key) continue;
      gateCounts.set(key, (gateCounts.get(key) ?? 0) + 1);
    }
  }
  const topFailingGates = [...gateCounts.entries()]
    .map(([command, fails]) => ({ command, fails }))
    .sort((a, b) => b.fails - a.fails || a.command.localeCompare(b.command))
    .slice(0, 5);

  return {
    runId,
    totals,
    passRate,
    attempts: { total: totalAttempts, perSlice },
    meanTurns: mean(turns),
    meanTools: mean(tools),
    meanDurationMs: mean(durations),
    byEffort,
    topFailingGates,
    modelFallbacks: collectModelFallbacks(files, projectDir, runId, slices),
  };
}

// ---- queryEvents: tiny filter DSL over the event log ----

const VALID_FIELDS = [
  "attempts",
  "attempt",
  "exit",
  "durationMs",
  "turns",
  "tools",
  "slice",
  "id",
  "reason",
  "type",
] as const;

type QueryField = (typeof VALID_FIELDS)[number];

const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  "attempts",
  "attempt",
  "exit",
  "durationMs",
  "turns",
  "tools",
]);

function fieldError(field: string): Error {
  return new Error(`unknown field "${field}" (valid: ${VALID_FIELDS.join(", ")})`);
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

interface Cond {
  field: QueryField;
  op: string;
  raw: string;
}

function parseCond(text: string): Cond {
  const m = text.trim().match(/^([A-Za-z]+)\s*(>=|<=|!=|==|=|>|<|~)\s*(.+)$/);
  if (!m) {
    throw new Error(`bad condition "${text.trim()}" (want <field> <op> <value>; valid: ${VALID_FIELDS.join(", ")})`);
  }
  const field = m[1]!;
  if (!(VALID_FIELDS as readonly string[]).includes(field)) throw fieldError(field);
  return { field: field as QueryField, op: m[2]!, raw: m[3]!.trim() };
}

function numericValue(ev: RunEvent, field: QueryField, attemptsBySlice: Map<string, number>): number | undefined {
  switch (field) {
    case "attempt":
    case "attempts": {
      if (ev.attempt !== undefined) return ev.attempt;
      if (ev.sliceId !== undefined) return attemptsBySlice.get(ev.sliceId);
      return undefined;
    }
    case "exit":
      return ev.exit ?? undefined;
    case "durationMs":
      return ev.durationMs ?? undefined;
    case "turns":
      return ev.stats?.turns;
    case "tools":
      return ev.stats?.tools;
    default:
      return undefined;
  }
}

function stringValue(ev: RunEvent, field: QueryField): string {
  switch (field) {
    case "slice":
    case "id":
      return ev.sliceId ?? "";
    case "reason":
      return ev.reason ?? "";
    case "type":
      return ev.type;
    default:
      return "";
  }
}

function testCond(ev: RunEvent, c: Cond, attemptsBySlice: Map<string, number>): boolean {
  if (NUMERIC_FIELDS.has(c.field)) {
    const n = Number(unquote(c.raw));
    if (!Number.isFinite(n)) throw new Error(`bad number "${c.raw}" for field "${c.field}"`);
    const v = numericValue(ev, c.field, attemptsBySlice);
    if (v === undefined) return c.op === "!=";
    switch (c.op) {
      case "=":
      case "==":
        return v === n;
      case "!=":
        return v !== n;
      case ">":
        return v > n;
      case "<":
        return v < n;
      case ">=":
        return v >= n;
      case "<=":
        return v <= n;
      case "~":
        return String(v).includes(String(n));
      default:
        throw new Error(`bad operator "${c.op}" for numeric field "${c.field}"`);
    }
  }
  const want = unquote(c.raw);
  const v = stringValue(ev, c.field);
  switch (c.op) {
    case "=":
    case "==":
      return v === want;
    case "!=":
      return v !== want;
    case "~":
      return v.includes(want);
    case ">":
      return v > want;
    case "<":
      return v < want;
    case ">=":
      return v >= want;
    case "<=":
      return v <= want;
    default:
      throw new Error(`bad operator "${c.op}" for field "${c.field}"`);
  }
}

/**
 * Tiny DSL: `<selector> [where <cond> (and <cond>)*]`.
 *
 * Selector is `all`, an event-type substring (`failed` matches
 * `verify_failed` + `slice_failed_terminal`), or `slice <id>` / `slices`.
 * Conds compare event fields with `= == != > < >= <= ~` (contains).
 * Pure over loaded data; throws on empty queries or unknown fields.
 */
export function queryEvents(projectDir: string, runId: string, query: string): RunEvent[] {
  if (!query || !query.trim()) throw new Error("empty query");
  const files = ioWith();
  const slices = loadCursorSlices(files, projectDir, runId);
  const events = loadEvents(files, projectDir, runId);
  const attemptsBySlice = new Map(slices.map((s) => [s.id, s.attempts]));

  const whereIdx = query.search(/\bwhere\b/i);
  const selectorText = (whereIdx >= 0 ? query.slice(0, whereIdx) : query).trim();
  const condsText = whereIdx >= 0 ? query.slice(whereIdx + 5).trim() : "";
  if (!selectorText) throw new Error("empty query");

  let base: RunEvent[];
  const lower = selectorText.toLowerCase();
  if (lower === "all") {
    base = events;
  } else if (lower === "slices") {
    base = events.filter((e) => e.sliceId !== undefined);
  } else if (/^slice\s+/i.test(selectorText)) {
    const id = selectorText.replace(/^slice\s+/i, "").trim();
    if (!id) throw new Error("empty query");
    base = events.filter((e) => e.sliceId === id);
  } else {
    base = events.filter((e) => e.type.toLowerCase().includes(lower));
  }

  if (!condsText) return base;
  const conds = condsText
    .split(/\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseCond);
  return base.filter((e) => conds.every((c) => testCond(e, c, attemptsBySlice)));
}

// ---- exportHtml ----

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtStat(v: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * Self-contained HTML report (inline `<style>`, no external deps): run
 * header, slice status table, stats summary, event timeline, and the
 * deferred + placeholders sections when those files exist.
 */
export function exportHtml(projectDir: string, runId: string, io?: StatsIo): string {
  const files = ioWith(io);
  const dir = runDir(projectDir, runId);
  const slices = loadCursorSlices(files, projectDir, runId);
  const events = loadEvents(files, projectDir, runId);
  const stats = computeStats(projectDir, runId, io);
  const deferred = tryRead(files, join(dir, "deferred.md"));
  const placeholders = tryRead(files, join(dir, "placeholders.md"));

  const esc = escapeHtml;
  const statusRows = slices
    .map(
      (s) =>
        `<tr><td>${esc(s.id)}</td><td>${esc(s.title)}</td><td>${esc(s.status)}</td>` +
        `<td>${esc(String(s.attempts))}</td><td>${esc(s.effort ?? "none")}</td></tr>`,
    )
    .join("\n");

  const totalRows = Object.entries(stats.totals)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
    .join("\n");

  const effortRows = (Object.entries(stats.byEffort) as [string, EffortStats][])
    .map(
      ([k, g]) =>
        `<tr><td>${esc(k)}</td><td>${esc(String(g.count))}</td><td>${esc(String(g.done))}</td>` +
        `<td>${esc(fmtStat(g.meanDurationMs))}</td><td>${esc(fmtStat(g.meanTurns))}</td>` +
        `<td>${esc(fmtStat(g.meanTools))}</td></tr>`,
    )
    .join("\n");

  const eventRows = events
    .map(
      (e) =>
        `<tr><td>${esc(String(e.seq))}</td><td>${esc(e.at)}</td><td>${esc(e.type)}</td>` +
        `<td>${esc(e.sliceId ?? "-")}</td><td>${esc(e.detail ?? e.reason ?? "")}</td></tr>`,
    )
    .join("\n");

  const gateRows = stats.topFailingGates
    .map((g) => `<tr><td>${esc(g.command)}</td><td>${esc(String(g.fails))}</td></tr>`)
    .join("\n");

  const fallbackRows = Object.entries(stats.modelFallbacks)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Run ${esc(runId)}</title>
<style>
body { font-family: sans-serif; margin: 2em; color: #222; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
th { background: #f0f0f0; }
pre { background: #f8f8f8; padding: 1em; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>Run ${esc(runId)}</h1>
<h2>Slices</h2>
<table>
<tr><th>id</th><th>title</th><th>status</th><th>attempts</th><th>effort</th></tr>
${statusRows}
</table>
<h2>Stats</h2>
<p>pass rate: ${esc(stats.passRate === null ? "-" : String(stats.passRate))}</p>
<p>attempts: ${esc(String(stats.attempts.total))} mean turns: ${esc(fmtStat(stats.meanTurns))} mean tools: ${esc(fmtStat(stats.meanTools))} mean duration: ${esc(fmtStat(stats.meanDurationMs))}</p>
<h3>Status totals</h3>
<table>
<tr><th>status</th><th>count</th></tr>
${totalRows}
</table>
<h3>By effort</h3>
<table>
<tr><th>effort</th><th>count</th><th>done</th><th>mean duration</th><th>mean turns</th><th>mean tools</th></tr>
${effortRows}
</table>
<h3>Top failing gates</h3>
<table>
<tr><th>command</th><th>fails</th></tr>
${gateRows}
</table>
<h3>Model fallbacks</h3>
<table>
<tr><th>model</th><th>count</th></tr>
${fallbackRows}
</table>
<h2>Events</h2>
<table>
<tr><th>seq</th><th>time</th><th>type</th><th>slice</th><th>detail</th></tr>
${eventRows}
</table>
${deferred !== null ? `<h2>Deferred</h2>\n<pre>${esc(deferred)}</pre>` : ""}
${placeholders !== null ? `<h2>Placeholders</h2>\n<pre>${esc(placeholders)}</pre>` : ""}
</body>
</html>
`;
}

// ---- replayRun ----

export interface ReplayResult {
  expected: Record<string, string>;
  actual: Record<string, string>;
  mismatches: string[];
  events: number;
}

/**
 * Rebuild expected statuses from the event log and diff against the cursor.
 * The replay starts from a pending-reset copy of the current cursor doc
 * (same rule as the store rebuild: skipped stays skipped, else pending) —
 * replaying from the live cursor statuses would be a tautology.
 */
export function replayRun(projectDir: string, runId: string): ReplayResult {
  const files = ioWith();
  const text = tryRead(files, join(runDir(projectDir, runId), "roadmap.json"));
  const cursor = tryJson<CursorShape>(text);
  const slices = cursor?.doc?.slices ?? [];
  const events = loadEvents(files, projectDir, runId);

  const reset: Slice[] = slices.map((s) => ({ ...s, status: (s.skip ? "skipped" : "pending") as Slice["status"] }));
  const initial: RoadmapDoc = { version: 1, sourceHash: "", slices: reset };
  const rebuilt = rebuildStatusesFromEvents(initial, events);

  const expected: Record<string, string> = {};
  const actual: Record<string, string> = {};
  const mismatches: string[] = [];
  for (const s of slices) {
    const exp = rebuilt.get(s.id) ?? "pending";
    expected[s.id] = exp;
    actual[s.id] = s.status;
    if (exp !== s.status) mismatches.push(`${s.id}: expected ${exp} got ${s.status}`);
  }
  return { expected, actual, mismatches, events: events.length };
}
