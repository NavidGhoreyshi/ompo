/**
 * Post-run checklist (deferred live values + placeholder credentials).
 *
 * Pure aggregation over the durable store: done slices' report.json
 * `deferred` lines plus every loadPlaceholders() entry. `fillChecklist`
 * re-runs Verify gates with operator-supplied values but never writes
 * the store or appends events.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlaceholders } from "./placeholders.ts";
import { loadRun, sliceDir } from "./store.ts";
import type { CompletionReport, Verdict } from "./types.ts";
import { runVerifiers, type VerifyOptions } from "./verify.ts";

export interface ChecklistItem {
  sliceId: string;
  title: string;
  kind: "deferred" | "placeholder";
  what: string;
  needsValue: string | null;
  check: string | null;
  raw: string;
}

export interface ParsedDeferred {
  what: string;
  needsValue: string | null;
  check: string | null;
}

const MANUAL_CHECK_RE = /;\s*manual check\s*:/i;
const DASH_NEEDS_RE = /^(.*)[\u2014\u2013-]\s*needs\s+(.*)$/s;
const BARE_NEEDS_RE = /^(.*?)\bneeds\s+(.*)$/si;

function nullIfEmpty(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

/**
 * Parse a deferred line of the form "<what> — needs <value>; manual check: <how>".
 * Accepts em-dash, en-dash, or hyphen before `needs`, plus a bare `needs`.
 * Never throws: malformed input yields { what: trimmed line, nulls }.
 */
export function parseDeferredLine(line: string): ParsedDeferred {
  const input = line.trim();
  if (input === "") return { what: "", needsValue: null, check: null };
  let left = input;
  let check: string | null = null;
  const mc = left.search(MANUAL_CHECK_RE);
  if (mc !== -1) {
    const m = /;\s*manual check\s*:(.*)$/is.exec(left);
    check = nullIfEmpty(m?.[1] ?? "");
    left = left.slice(0, mc).trim();
  }
  if (left === "") return { what: input, needsValue: null, check };
  let m = DASH_NEEDS_RE.exec(left);
  if (m) {
    return {
      what: (m[1] ?? "").trim() === "" ? left : (m[1] ?? "").trim(),
      needsValue: nullIfEmpty(m[2] ?? ""),
      check,
    };
  }
  m = BARE_NEEDS_RE.exec(left);
  if (m) {
    return {
      what: (m[1] ?? "").trim() === "" ? left : (m[1] ?? "").trim(),
      needsValue: nullIfEmpty(m[2] ?? ""),
      check,
    };
  }
  return { what: left, needsValue: null, check };
}

const PLACEHOLDER_CHECK =
  "export real value, delete placeholders.json, ompo resume";

/**
 * Collect deferred items (done slices only) plus placeholder entries.
 * Order: roadmap order, deferred before placeholders per slice.
 * Unreadable reports and empty/non-string deferred entries are skipped.
 */
export function collectChecklist(projectDir: string, runId: string): ChecklistItem[] {
  const cursor = loadRun(projectDir, runId);
  const doc = cursor.doc;
  const titleOf = new Map(doc.slices.map((s) => [s.id, s.title]));

  // Group placeholder entries by first-seen slice.
  const placeholders = loadPlaceholders(projectDir, runId);
  const bySlice = new Map<string, { name: string; value: string }[]>();
  const orphans: { name: string; value: string; slice: string }[] = [];
  for (const name of Object.keys(placeholders)) {
    const e = placeholders[name]!;
    const list = bySlice.get(e.firstSeenSlice);
    const rec = { name, value: e.value };
    if (list) list.push(rec);
    else bySlice.set(e.firstSeenSlice, [rec]);
  }

  const items: ChecklistItem[] = [];
  const seenPlaceholderSlices = new Set<string>();
  for (const s of doc.slices) {
    if (s.status === "done") {
      let deferred: unknown;
      try {
        const raw = readFileSync(join(sliceDir(projectDir, runId, s.id), "report.json"), "utf8");
        deferred = (JSON.parse(raw) as CompletionReport).deferred;
      } catch {
        deferred = undefined;
      }
      if (Array.isArray(deferred)) {
        for (const d of deferred) {
          if (typeof d !== "string" || d.trim() === "") continue;
          const p = parseDeferredLine(d);
          items.push({
            sliceId: s.id,
            title: s.title,
            kind: "deferred",
            what: p.what,
            needsValue: p.needsValue,
            check: p.check,
            raw: d,
          });
        }
      }
    }
    const ph = bySlice.get(s.id);
    if (ph) {
      seenPlaceholderSlices.add(s.id);
      for (const rec of ph) {
        items.push({
          sliceId: s.id,
          title: s.title,
          kind: "placeholder",
          what: rec.name,
          needsValue: nullIfEmpty(rec.value) ?? `first seen in ${s.id}`,
          check: PLACEHOLDER_CHECK,
          raw: rec.name,
        });
      }
    }
  }
  // Placeholder entries whose slice is unknown (or not in roadmap order context):
  // append in loadPlaceholders() key order.
  for (const [sliceId, list] of bySlice) {
    if (seenPlaceholderSlices.has(sliceId)) continue;
    // Slice exists in doc but was never visited above? Cannot happen (we iterate
    // all doc slices), so this is an unknown-slice orphan.
    for (const rec of list) {
      orphans.push({ ...rec, slice: sliceId });
    }
  }
  for (const o of orphans) {
    items.push({
      sliceId: o.slice,
      title: titleOf.get(o.slice) ?? "",
      kind: "placeholder",
      what: o.name,
      needsValue: nullIfEmpty(o.value) ?? `first seen in ${o.slice}`,
      check: PLACEHOLDER_CHECK,
      raw: o.name,
    });
  }
  return items;
}

export function renderChecklistMd(items: ChecklistItem[], runId: string): string {
  const lines: string[] = [
    `# Checklist — run ${runId}`,
    "",
    "Fill each item with its real value, then run its manual check.",
    "",
  ];
  if (items.length === 0) {
    lines.push("No deferred or placeholder items. Nothing to fill.");
    return lines.join("\n") + "\n";
  }
  let lastSlice = "";
  for (const it of items) {
    const head = `## ${it.sliceId} — ${it.title}`;
    if (head !== lastSlice) {
      lines.push(head);
      lastSlice = head;
    }
    const need = it.needsValue ? `needs ${it.needsValue}` : "needs a real value";
    const check = it.check ? `; manual check: ${it.check}` : "";
    const tag = it.kind === "placeholder" ? " [placeholder]" : "";
    lines.push(`- [ ] ${it.what} — ${need}${check}${tag}`);
  }
  return lines.join("\n") + "\n";
}

export function renderChecklistJson(items: ChecklistItem[]): string {
  return JSON.stringify(items, null, 2);
}

const VAR_TOKEN_RE = /[A-Z][A-Z0-9_]{3,}/g;

/** Uppercase `[A-Z][A-Z0-9_]{3,}` tokens from what+needsValue+raw, deduped, order-stable. */
export function varsForItem(item: ChecklistItem): string[] {
  const hay = [item.what, item.needsValue ?? "", item.raw].join("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of hay.matchAll(VAR_TOKEN_RE)) {
    const tok = m[0];
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

/** Items whose varsForItem tokens intersect the upper-cased provided var names. */
export function affectedSlices(
  items: ChecklistItem[],
  vars: Record<string, string>,
): ChecklistItem[] {
  const provided = new Set(Object.keys(vars).map((k) => k.toUpperCase()));
  if (provided.size === 0) return [];
  return items.filter((it) => varsForItem(it).some((v) => provided.has(v)));
}

export interface FillResult {
  affected: string[];
  passed: string[];
  failed: { sliceId: string; output: string }[];
}

export interface FillOptions {
  runGates?: typeof runVerifiers;
  timeoutMs?: number;
}

/**
 * Re-run Verify gates for slices touched by `vars`. Env for each gate is
 * `{ ...process.env, ...vars }`; logDir is the slice dir. Collects pass/fail
 * from Verdict.pass. Never writes the store or appends events.
 */
export async function fillChecklist(
  projectDir: string,
  runId: string,
  vars: Record<string, string>,
  opts: FillOptions = {},
): Promise<FillResult> {
  const items = collectChecklist(projectDir, runId);
  if (items.length === 0) return { affected: [], passed: [], failed: [] };
  const touched = affectedSlices(items, vars);
  const affected: string[] = [];
  for (const it of touched) {
    if (!affected.includes(it.sliceId)) affected.push(it.sliceId);
  }
  if (affected.length === 0) return { affected: [], passed: [], failed: [] };

  const runGates: typeof runVerifiers = opts.runGates ?? runVerifiers;
  const cursor = loadRun(projectDir, runId);
  const byId = new Map(cursor.doc.slices.map((s) => [s.id, s]));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...vars };
  const verifyOpts: VerifyOptions = {
    projectDir,
    env,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };

  const passed: string[] = [];
  const failed: { sliceId: string; output: string }[] = [];
  for (const sliceId of affected) {
    const slice = byId.get(sliceId);
    if (!slice) continue;
    const logDir = sliceDir(projectDir, runId, sliceId);
    mkdirSync(logDir, { recursive: true });
    let verdict: Verdict;
    try {
      verdict = await runGates(sliceId, slice.attempts, slice.verify, logDir, verifyOpts);
    } catch (err) {
      failed.push({ sliceId, output: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (verdict.pass) passed.push(sliceId);
    else {
      const output = verdict.steps.map((s) => s.outputTail).filter((t) => t !== "").join("\n");
      failed.push({ sliceId, output });
    }
  }
  return { affected, passed, failed };
}
