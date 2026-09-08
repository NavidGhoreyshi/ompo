/**
 * Deterministic secret scan — pre-merge safety gate (Sprint 4).
 *
 * The reviewer prompt asks models to reject real-looking secrets in tracked
 * files, but that is judgment, not a guarantee. This module is the backstop:
 * a small set of high-confidence patterns (credential/private-key/API-token
 * classes recognizable without heuristics) scanned over the slice's merge
 * candidates before the branch merges.
 *
 * Deliberately NOT a universal detector: no "long random string" heuristics,
 * so false positives stay near zero at the cost of missing exotic formats.
 * What it misses, the reviewer may still catch; what it catches never
 * reaches the base checkout.
 *
 * Findings carry file + line + class ONLY — never the matched value, never
 * a snippet. Scan output must not become a new source of secrets.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeApi } from "./store.ts";
import type { Slice, Verdict } from "./types.ts";

export interface SecretFinding {
  /** Worktree/project-relative path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Pattern class, e.g. "aws-access-key". No secret value, ever. */
  kind: string;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  filesScanned: number;
  /** Relative paths skipped (binary, oversize, excluded). */
  skipped: string[];
}

interface Pattern {
  kind: string;
  /** Single-line test; MUST NOT match redacted/placeholder values (see below). */
  re: RegExp;
}

/**
 * Values that look scary but are documentation/placeholder/test fixtures.
 * Any match whose surrounding value contains one of these (case-insensitive)
 * is ignored. Kept deliberately broad: a missed example key costs nothing,
 * a false positive blocks a merge.
 */
const BENIGN_VALUE_RE =
  /EXAMPLE|TESTKEY|TEST_KEY|SAMPLE|FAKE|REDACTED|PLACEHOLDER|CHANGEME|YOUR[_-]?KEY|XXX+|123456789|\$\{|<[^>]*>|\*+/i;

/** Skip scanning these: runtime state, logs, caches, generated bundles, media. */
const SKIP_SUFFIX_RE =
  /\.(log|jsonl|map|png|jpe?g|gif|webp|ico|svg|mp4|mov|pdf|zip|tar|gz|tgz|wasm|ttf|woff2?|lock)$/i;

/** Skip these top-level entries anywhere in the tree. */
const SKIP_SEGMENT = new Set([".git", "node_modules", ".omp", "dist", "build", "coverage", ".next"]);

/** Files over this size are skipped (generated bundles hide here). */
const MAX_SCAN_BYTES = 512 * 1024;

const PATTERNS: Pattern[] = [
  // AWS access key id: AKIA + 16 uppercase alphanumerics.
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 36+, or the newer pat_ format.
  { kind: "github-token", re: /\bgh[opu]_[A-Za-z0-9]{36,}\b/ },
  { kind: "github-token", re: /\bghs_[A-Za-z0-9]{36,}\b/ },
  { kind: "github-token", re: /\bghr_[A-Za-z0-9]{36,}\b/ },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  // Slack tokens: xoxb/xoxp/xoxa/xoxr/xoxs + secret body.
  { kind: "slack-token", re: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/ },
  // Stripe restricted/live/test secret keys.
  { kind: "stripe-key", re: /\b[rs]k_(live|test)_[A-Za-z0-9]{16,}\b/ },
  // OpenAI-style keys: sk- + long body (distinct from sk_live_ by the dash).
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  // Google API keys: AIza + 35+ base64ish chars.
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z\-_]{35,}\b/ },
  // PEM private-key blocks (content, not the secret itself, triggers).
  { kind: "private-key", re: /BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY/ },
  // Named-secret assignments: a known secret name given a substantial value.
  // Quoted or bare, `=`/`:` separated. Value must be 12+ non-space chars so
  // `password = test` / `api_key = ""` / `${VAR}` never match.
  {
    kind: "secret-assignment",
    re: /\b(?:aws_secret_access_key|secret_access_key|api[_-]?secret|client[_-]?secret)\b\s*[:=]\s*['"]?[^\s'"]{12,}['"]?/i,
  },
  {
    kind: "secret-assignment",
    re: /\bpassword\s*[:=]\s*['"][^'"]{8,}['"]/i,
  },
];

function benign(line: string): boolean {
  return BENIGN_VALUE_RE.test(line);
}

/** Scan one text's lines. Pure — the unit-test seam. */
export function scanTextLines(content: string): { line: number; kind: string }[] {
  const out: { line: number; kind: string }[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (benign(line)) continue;
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        out.push({ line: i + 1, kind: p.kind });
        break; // one finding per line: class is what matters, not count
      }
    }
  }
  return out;
}

/** True when the relative path is never worth scanning. */
export function isScannablePath(rel: string): boolean {
  if (SKIP_SUFFIX_RE.test(rel)) return false;
  for (const seg of rel.split("/")) {
    if (SKIP_SEGMENT.has(seg)) return false;
  }
  return true;
}

export interface ScanIo {
  readFile?: (abs: string) => string;
  fileBytes?: (abs: string) => number;
}

/**
 * Scan candidate files under `root`. `relPaths` are root-relative merge
 * candidates (see `collectScanTargets`). Binary (NUL-containing) and oversize
 * files are skipped, never failed. Never throws on unreadable files — they
 * land in `skipped` so the caller can decide (the loop treats an unreadable
 * candidate list as a tool failure, but a single unreadable file as skip).
 */
export function scanCandidateFiles(
  root: string,
  relPaths: string[],
  io?: ScanIo,
): SecretScanResult {
  const findings: SecretFinding[] = [];
  const skipped: string[] = [];
  let filesScanned = 0;
  for (const rel of relPaths) {
    if (!isScannablePath(rel)) {
      skipped.push(rel);
      continue;
    }
    const abs = join(root, rel);
    let bytes = -1;
    try {
      bytes = io?.fileBytes ? io.fileBytes(abs) : statSync(abs).size;
    } catch {
      skipped.push(rel);
      continue;
    }
    if (bytes > MAX_SCAN_BYTES) {
      skipped.push(rel);
      continue;
    }
    let content: string;
    try {
      content = io?.readFile ? io.readFile(abs) : readFileSync(abs, "utf8");
    } catch {
      skipped.push(rel);
      continue;
    }
    if (content.includes("\0")) {
      skipped.push(rel);
      continue;
    }
    filesScanned += 1;
    for (const hit of scanTextLines(content)) {
      findings.push({ file: rel, line: hit.line, kind: hit.kind });
    }
  }
  return { findings, filesScanned, skipped };
}

function git(cwd: string, ...args: string[]): { exit: number; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { exit: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * Merge candidates for a slice worktree: the branch delta vs merge-base
 * PLUS uncommitted worktree changes (the loop scans after verify but before
 * `merge()`, which runs `git add -A` — uncommitted files would merge too).
 * Untracked-but-ignored files are excluded (`!!` porcelain entries drop).
 *
 * Non-git projects (in-place ops) fall back to the slice's declared +
 * reported files — possibly empty, which means nothing attributable to scan
 * (the in-place merge is a no-op, so there is no merge boundary to guard).
 * Only a git checkout whose own commands fail reports `{ failure }`, which
 * the caller must treat as a tool failure, NOT as clean.
 */
export function collectScanTargets(
  worktreePath: string,
  opts?: { projectDir?: string; branch?: string; fallbackFiles?: string[] },
): { root: string; relPaths: string[] } | { failure: string } {
  if (git(worktreePath, "rev-parse", "--is-inside-work-tree").exit !== 0) {
    const fb = [...new Set((opts?.fallbackFiles ?? []).map((f) => f.trim()).filter(Boolean))].sort();
    return { root: worktreePath, relPaths: fb };
  }
  const status = git(worktreePath, "status", "--porcelain", "--untracked-files=normal");
  if (status.exit !== 0) {
    return { failure: `git status failed in ${worktreePath}: ${status.out.trim().slice(-500)}` };
  }
  const targets = new Set<string>();
  for (const line of status.out.split("\n")) {
    if (!line.trim()) continue;
    // `XY <path>`; `!!` = ignored (drop), `??` = untracked candidate (keep).
    if (line.startsWith("!!")) continue;
    const rel = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
    if (rel) targets.add(rel);
  }
  // Branch delta: files the slice branch adds over the base checkout.
  const { projectDir, branch } = opts ?? {};
  if (projectDir && branch) {
    const base = git(projectDir, "merge-base", "HEAD", branch);
    if (base.exit === 0 && base.out.trim()) {
      const diff = git(projectDir, "diff", "--name-only", `${base.out.trim()}...${branch}`);
      if (diff.exit !== 0) {
        return { failure: `git diff failed for ${branch}: ${diff.out.trim().slice(-500)}` };
      }
      for (const rel of diff.out.split("\n").map((l) => l.trim()).filter(Boolean)) {
        targets.add(rel);
      }
    }
    // No base (branch not yet committed — first attempt pre-commit): the
    // status sweep above already covers everything. Not a failure.
  }
  return { root: worktreePath, relPaths: [...targets].sort() };
}

/**
 * Pre-merge secret gate — the loop's single call site (used by both the
 * first pass and the review-fix re-merge so neither can bypass it).
 *
 * Appends a redacted `secret-scan` step to `verdict` (pass flips to false on
 * findings) and records the outcome through the ordinary verify-failed /
 * retry-or-terminal path: findings use cause `secret_found`, scanner tool
 * failures use `secret_scan_error`. No new event types, no parallel status.
 *
 * Findings deliberately skip the debugger lane (the caller returns straight
 * to retry-or-terminal): model sessions must never be pointed at secrets,
 * not even as redacted file:line pointers paired with a fix request.
 *
 * Returns true when the slice is clean and may proceed to merge.
 */
export function preMergeSecretGate(opts: {
  projectDir: string;
  runId: string;
  slice: Slice;
  attempt: number;
  /** Slice artifact dir (receives `secret-scan-<attempt>.{json,error.txt}`). */
  dir: string;
  wtPath: string;
  branch?: string;
  verdict: Verdict;
  /** Worker-reported changed files (non-git fallback scan targets). */
  report?: { filesChanged?: unknown };
  maxRetries: number;
  log: (msg: string) => void;
}): boolean {
  const { projectDir, runId, slice, attempt, dir, wtPath, verdict, maxRetries } = opts;
  const sliceId = slice.id;
  const collected = collectScanTargets(wtPath, {
    projectDir,
    branch: opts.branch,
    fallbackFiles: [...slice.files, ...reportFilesChanged(opts.report)],
  });
  if ("failure" in collected) {
    const ref = join("slices", sliceId, `secret-scan-${attempt}.error.txt`);
    writeFileSync(join(dir, `secret-scan-${attempt}.error.txt`), collected.failure + "\n", "utf8");
    storeApi.verifyFailed(projectDir, runId, sliceId, ref, "secret_scan_error");
    if (attempt <= maxRetries) {
      storeApi.retrySlice(projectDir, runId, sliceId);
      opts.log(`— slice ${sliceId}: secret scanner failed (${collected.failure.slice(0, 200)}) — retrying (${attempt}/${maxRetries} retries used)`);
    } else {
      storeApi.terminalFail(projectDir, runId, sliceId, "secret_scan_error");
      opts.log(`— slice ${sliceId}: secret scanner failed (${collected.failure.slice(0, 200)}) — terminal (retries exhausted)`);
    }
    return false;
  }
  const scan = scanCandidateFiles(collected.root, collected.relPaths);
  if (scan.findings.length === 0) {
    if (process.env.OMPO_DEBUG_SECRETS) {
      opts.log(`  secret scan clean (${scan.filesScanned} file(s))`);
    }
    return true;
  }
  writeFileSync(
    join(dir, `secret-scan-${attempt}.json`),
    JSON.stringify({ filesScanned: scan.filesScanned, skipped: scan.skipped, findings: scan.findings }, null, 2) + "\n",
    "utf8",
  );
  const summary = `secret scan: ${scan.findings.length} finding(s) — ${formatFindingsRedacted(scan.findings)}`;
  verdict.steps.push({
    name: "secret-scan",
    command: "ompo secret-scan (deterministic pre-merge gate)",
    exit: 1,
    timedOut: false,
    outputTail: summary,
    logRef: join("slices", sliceId, `secret-scan-${attempt}.json`),
  });
  verdict.pass = false;
  writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
  const ref = join("slices", sliceId, `secret-scan-${attempt}.json`);
  storeApi.verifyFailed(projectDir, runId, sliceId, ref, "secret_found");
  if (attempt <= maxRetries) {
    storeApi.retrySlice(projectDir, runId, sliceId);
    opts.log(`— slice ${sliceId}: ${summary} (merge refused, retrying ${attempt}/${maxRetries})`);
  } else {
    storeApi.terminalFail(projectDir, runId, sliceId, "secret_found");
    opts.log(`— slice ${sliceId}: ${summary} (merge refused — terminal, retries exhausted)`);
  }
  return false;
}

/** Report-declared changed files (non-git fallback targets). Never throws. */
function reportFilesChanged(report: { filesChanged?: unknown } | undefined): string[] {
  if (!report || !Array.isArray(report.filesChanged)) return [];
  return report.filesChanged.filter((f): f is string => typeof f === "string");
}

/** Render redacted findings for logs/verdict tails: file:line (kind), no values. */
export function formatFindingsRedacted(findings: SecretFinding[], max = 10): string {
  const shown = findings.slice(0, max).map((f) => `${f.file}:${f.line} (${f.kind})`);
  const rest = findings.length > max ? ` (+${findings.length - max} more)` : "";
  return shown.join("; ") + rest;
}
