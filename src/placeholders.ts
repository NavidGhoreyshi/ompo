/**
 * Dev-only placeholder credentials (default behavior).
 *
 * When a verifier gate fails ONLY because a named credential/URL env var is
 * unset (see classifyEnvFailure), the loop injects a deterministic dev-only
 * placeholder, notes it in the run's placeholders.md, and re-runs the gate —
 * so the roadmap keeps moving without the operator. Infrastructure failures
 * (port taken, DB down, DNS, disk) still park as blocked-env: those cannot
 * be papered over with a string.
 *
 * Placeholders are deterministic per var name (resume-safe: a fresh process
 * re-derives the same value) and live only in process.env + the run dir —
 * never in the slice branch or base checkout. Values the operator already
 * exported are never recorded. Before deploy / the final UI-UX pass the
 * operator swaps every entry for its real value (see the swap report at
 * run end). Deploy slices (`deploy` in id/title) never auto-inject: they
 * park as blocked-env so real values gate the release.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, writeJsonAtomic } from "./store.ts";

export interface PlaceholderEntry {
  name: string;
  value: string;
  firstSeenSlice: string;
  firstSeenAttempt: number;
  at: string;
}

/** Slices that own the final deploy wait for real values (no auto-inject). */
export function isDeploySlice(id: string, title: string): boolean {
  return /deploy/i.test(id) || /deploy/i.test(title);
}

const QUOTED_VAR_RE = /"([A-Z][A-Z0-9_]{2,})"/;
const NAME_SCANNERS: RegExp[] = [
  /\b([A-Z][A-Z0-9_]{2,})\s+must be set\b/,
  /([A-Z][A-Z0-9_]{2,}):\s*(parameter null or not set|unbound variable)/,
  /environment variables?:?\s+"?([A-Z][A-Z0-9_]{2,})"?/i,
];

/**
 * Recover the unset var's name from the triage reason + failing output.
 * Returns null when no name is identifiable (caller parks as blocked-env).
 * Pure — unit-tested.
 */
export function extractMissingVar(reason: string, outputs: string[]): string | null {
  const q = reason.match(QUOTED_VAR_RE);
  if (q?.[1]) return q[1];
  for (const text of outputs) {
    if (!text) continue;
    for (const re of NAME_SCANNERS) {
      const m = text.match(re);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

/**
 * Deterministic dev-only value per var name (resume-safe: no randomness,
 * same name always yields the same value). Password-shaped vars carry
 * upper/lower/digit/symbol so typical policy checks pass.
 * Pure — unit-tested.
 */
export function placeholderFor(name: string): string {
  const upper = name.toUpperCase();
  if (upper === "DATABASE_URL") return "postgresql://localhost:5432/ompo_dev";
  if (/(^|_)PORT($|_)/.test(upper)) return "3000";
  if (/URL|ORIGIN/.test(upper)) return "http://localhost:3000";
  if (/(^|_)HOST($|_)/.test(upper)) return "localhost";
  if (/PASSWORD|SECRET|TOKEN|KEY/.test(upper)) return `Ompo-Dev-${upper}-aB3!xQ9`;
  return `ompo-dev-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Repo-relative ref of the run's placeholder doc (for log lines). */
export function placeholdersDocRef(runId: string): string {
  return join(RUNS_DIR, runId, "placeholders.md");
}

export function loadPlaceholders(projectDir: string, runId: string): Record<string, PlaceholderEntry> {
  try {
    const p = join(projectDir, RUNS_DIR, runId, "placeholders.json");
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, PlaceholderEntry>;
  } catch {
    return {};
  }
}

/**
 * Note one injected placeholder. Idempotent: first write wins (values are
 * deterministic anyway). Sync — runs inside the commit mutex. Only call
 * with values this process generated; never record operator-exported ones.
 */
export function recordPlaceholder(
  projectDir: string,
  runId: string,
  entry: PlaceholderEntry,
): void {
  const dir = join(projectDir, RUNS_DIR, runId);
  mkdirSync(dir, { recursive: true });
  const all = loadPlaceholders(projectDir, runId);
  if (!all[entry.name]) {
    all[entry.name] = entry;
    writeJsonAtomic(join(dir, "placeholders.json"), all);
  }
  writeFileSync(join(dir, "placeholders.md"), renderPlaceholdersDoc(all) + "\n", "utf8");
}

function renderPlaceholdersDoc(all: Record<string, PlaceholderEntry>): string {
  const names = Object.keys(all).sort();
  const rows = names.map(
    (n) => `| \`${all[n]!.name}\` | \`${all[n]!.value}\` | ${all[n]!.firstSeenSlice} (attempt ${all[n]!.firstSeenAttempt}) |`,
  );
  return [
    `# Placeholders — DEV-ONLY, swap before deploy`,
    ``,
    `ompo auto-injected these values so the roadmap could proceed without`,
    `real credentials. They are **not production values**. Before the deploy`,
    `slice / final UI-UX pass:`,
    ``,
    `1. Export the real value for each name below (shell or hosting env).`,
    `2. Delete this file + \`placeholders.json\`, or leave them — real exported`,
    `   values take precedence over placeholders on the next run.`,
    `3. \`ompo resume\` to re-verify the deploy gate against real services.`,
    ``,
    `| Variable | Injected value | First seen in |`,
    `|---|---|---|`,
    ...rows,
    ``,
    `## Shell export block (dev only)`,
    ``,
    `\`\`\`sh`,
    ...names.map((n) => `export ${all[n]!.name}='${all[n]!.value}'`),
    `\`\`\``,
  ].join("\n");
}
