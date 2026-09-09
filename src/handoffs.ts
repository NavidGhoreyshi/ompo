/**
 * Context-cap handoff audit trail (fresh-context generations within one attempt).
 *
 * When a worker session reaches the per-session token cap (or declares its
 * context exhausted via a HANDOFF: report), the orchestrator preserves the
 * incomplete work, records the handoff here, and respawns the SAME attempt
 * with generation+1 — no retry consumed. ROADMAP.md is deliberately never
 * touched (human-owned source; worker-never-writes invariant): the audit
 * trail is the run sidecar `handoffs.md` (+ `handoffs.json`) and one
 * `slice_handoff` event per handoff in events.jsonl.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, writeJsonAtomic } from "./store.ts";

/** Why a generation ended: orchestrator cap abort, or the agent's own HANDOFF: report. */
export type HandoffCause = "context-cap" | "agent-declared";

export interface HandoffEntry {
  sliceId: string;
  attempt: number;
  /** Generation that ended (0-based; the respawn runs generation+1). */
  generation: number;
  cause: HandoffCause;
  /** Cumulative session tokens observed for the ended generation (0 when unreported, e.g. tmux). */
  tokens: number;
  /** Effective cap at handoff time (informational for agent-declared ends). */
  cap: number;
  /** Repo-relative ref of the continuation brief (slices/<id>/handoff-<attempt>-g<gen>.md). */
  briefRef: string;
  /** preserveIncompleteWork detail (branch snapshot the next generation resumes from). */
  preserved: string;
  at: string;
}

/** Repo-relative ref of the run's handoff doc (for log lines). */
export function handoffsDocRef(runId: string): string {
  return join(RUNS_DIR, runId, "handoffs.md");
}

/** Repo-relative ref of one generation's continuation brief. */
export function handoffBriefRef(sliceId: string, attempt: number, generation: number): string {
  return join("slices", sliceId, `handoff-${attempt}-g${generation}.md`);
}

/** All handoff entries for a run, oldest first; [] when none recorded yet. */
export function loadHandoffs(projectDir: string, runId: string): HandoffEntry[] {
  try {
    const path = join(projectDir, RUNS_DIR, runId, "handoffs.json");
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as HandoffEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Append one handoff entry and re-render handoffs.md. Sync — callers run
 * between generations (no commit-mutex section active). Never throws for
 * I/O reasons: the event log already carries the handoff; a best-effort
 * sidecar must not fail the respawn.
 */
export function recordHandoff(projectDir: string, runId: string, entry: Omit<HandoffEntry, "at">): void {
  try {
    const dir = join(projectDir, RUNS_DIR, runId);
    mkdirSync(dir, { recursive: true });
    const all = loadHandoffs(projectDir, runId);
    all.push({ ...entry, at: new Date().toISOString() });
    writeJsonAtomic(join(dir, "handoffs.json"), all);
    writeFileSync(join(dir, "handoffs.md"), renderHandoffsDoc(all) + "\n", "utf8");
  } catch {
    /* advisory sidecar; the slice_handoff event is the durable record */
  }
}

function renderHandoffsDoc(all: HandoffEntry[]): string {
  const rows = all.map(
    (e) =>
      `| \`${e.sliceId}\` | ${e.attempt} | g${e.generation} → g${e.generation + 1} | ${e.cause} | ${e.tokens} / ${e.cap} | \`${e.briefRef}\` |`,
  );
  return [
    `# Handoffs — fresh-context continuations`,
    ``,
    `Each row is one ended worker generation: the orchestrator preserved the`,
    `incomplete work on the slice branch and respawned the SAME attempt with`,
    `a fresh context (no retry consumed). The continuation brief for each`,
    `handoff carries what was done, what remains, and the artifact paths.`,
    ``,
    `| Slice | Attempt | Generation | Cause | Tokens (used / cap) | Brief |`,
    `|---|---|---|---|---|---|`,
    ...rows,
    ``,
  ].join("\n");
}
