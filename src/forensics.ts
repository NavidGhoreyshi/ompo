/**
 * Slice forensics — read-only inspection of a finished (or in-flight) slice.
 *
 * Pure viewer over the store layout: the run cursor (roadmap.json) for slice
 * meta, slices/<id>/{report,verdict,review}.json + prompt-*.md +
 * worker-*.models.json for artifacts, and events.jsonl for timing. All
 * artifact reads are best-effort — missing files leave the field undefined,
 * never throw. The only hard error is an unknown run/slice.
 *
 * Filesystem access sits behind optional `io` overrides so tests can inject
 * fakes; the default path uses the real fs against tmp-dir fixtures built
 * with `createRun`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
 import { listRuns, loadRun, readEvents, runDir, sliceDir } from "./store.ts";

export interface SliceShow {
  sliceId: string;
  title: string;
  status: string;
  attempts: number;
  deps: string[];
  verify: string[];
  report?: unknown;
  verdict?: unknown;
  review?: unknown;
  promptTail?: string;
  modelChain?: unknown;
  timing: { durationMs: (number | null)[]; turns: number | null; tools: number | null };
}

export interface ForensicsIo {
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
  /** Override for transcript mtime (tests); default reads the real fs. */
  statMtimeMs?: (p: string) => number | null;
}

function ioRead(io: ForensicsIo | undefined, p: string): string {
  return io?.readFile ? io.readFile(p) : readFileSync(p, "utf8");
}

function ioExists(io: ForensicsIo | undefined, p: string): boolean {
  return io?.exists ? io.exists(p) : existsSync(p);
}

function ioList(io: ForensicsIo | undefined, p: string): string[] {
  if (io?.listDir) return io.listDir(p);
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
}

function tryReadJson(io: ForensicsIo | undefined, p: string): unknown | undefined {
  try {
    if (!ioExists(io, p)) return undefined;
    return JSON.parse(ioRead(io, p)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Load everything known about one slice. Throws
 * `unknown slice "<id>"` when the run or slice does not exist.
 */
export function showSlice(
  projectDir: string,
  runId: string,
  sliceId: string,
  io?: ForensicsIo,
): SliceShow {
  let cursor;
  try {
    cursor = loadRun(projectDir, runId);
  } catch {
    throw new Error(`unknown slice "${sliceId}"`);
  }
  const slice = cursor.doc.slices.find((s) => s.id === sliceId);
  if (!slice) throw new Error(`unknown slice "${sliceId}"`);

  const dir = sliceDir(projectDir, runId, sliceId);
  const report = tryReadJson(io, join(dir, "report.json"));
  const verdict = tryReadJson(io, join(dir, "verdict.json"));
  const review = tryReadJson(io, join(dir, "review.json"));

  // Newest prompt artifact (worker prompt-*.md, review/debug prompts included).
  let promptTail: string | undefined;
  try {
    const files = ioList(io, dir);
    const promptFile = files
      .filter((f) => f.endsWith(".md") && f.includes("prompt"))
      .sort()
      .at(-1);
    if (promptFile) {
      const text = ioRead(io, join(dir, promptFile));
      if (text.trim()) promptTail = text.slice(-2000);
    }
  } catch {
    /* advisory only */
  }

  // Newest model chain record wins.
  let modelChain: unknown;
  try {
    const files = ioList(io, dir);
    const modelsFile = files
      .filter((f) => f.endsWith(".models.json"))
      .sort()
      .at(-1);
    if (modelsFile) modelChain = tryReadJson(io, join(dir, modelsFile));
  } catch {
    /* advisory only */
  }

  // Timing from worker_finished events for this slice.
  const timing: SliceShow["timing"] = { durationMs: [], turns: null, tools: null };
  try {
    const events = readEvents(projectDir, runId);
    for (const e of events) {
      if (e.sliceId !== sliceId || e.type !== "worker_finished") continue;
      timing.durationMs.push(typeof e.durationMs === "number" ? e.durationMs : null);
      if (e.stats && typeof e.stats.turns === "number" && typeof e.stats.tools === "number") {
        timing.turns = e.stats.turns;
        timing.tools = e.stats.tools;
      }
    }
  } catch {
    /* events unreadable — timing stays empty */
  }

  const out: SliceShow = {
    sliceId: slice.id,
    title: slice.title,
    status: slice.status,
    attempts: slice.attempts,
    deps: [...slice.deps],
    verify: [...slice.verify],
    timing,
  };
  if (report !== undefined) out.report = report;
  if (verdict !== undefined) out.verdict = verdict;
  if (review !== undefined) out.review = review;
  if (promptTail !== undefined) out.promptTail = promptTail;
  if (modelChain !== undefined) out.modelChain = modelChain;
  return out;
}

function section(title: string, body: string): string {
  const trimmed = body.trim();
  return `## ${title}\n${trimmed ? body : "(none)"}`;
}

/** Script-friendly multi-section rendering of a SliceShow. */
export function renderShowText(s: SliceShow): string {
  const deps = s.deps.length > 0 ? s.deps.join(", ") : "(none)";
  const verify = s.verify.length > 0 ? s.verify.join("\n") : "(none)";
  const spec = `attempts: ${s.attempts}\ndeps: ${deps}\nverify:\n${verify}`;

  let reportBody = "(none)";
  if (s.report !== undefined) {
    const r = s.report as { summary?: unknown };
    if (r && typeof r === "object" && typeof r.summary === "string" && r.summary.trim()) {
      reportBody = r.summary;
    } else {
      reportBody = JSON.stringify(s.report, null, 2);
    }
  }

  let verdictBody = "(none)";
  if (s.verdict !== undefined) {
    const v = s.verdict as { pass?: unknown; steps?: unknown };
    if (v && typeof v === "object") {
      const lines: string[] = [];
      if (typeof v.pass === "boolean") lines.push(`pass: ${v.pass}`);
      if (Array.isArray(v.steps)) {
        for (const st of v.steps) {
          const step = st as { name?: unknown; exit?: unknown; timedOut?: unknown };
          lines.push(
            `- ${String(step?.name ?? "?")}: exit=${String(step?.exit ?? "?")} timedOut=${String(step?.timedOut ?? "?")}`,
          );
        }
      }
      verdictBody = lines.length > 0 ? lines.join("\n") : JSON.stringify(s.verdict, null, 2);
    } else {
      verdictBody = JSON.stringify(s.verdict);
    }
  }

  let reviewBody = "(none)";
  if (s.review !== undefined) {
    const r = s.review as { approved?: unknown; findings?: unknown; notes?: unknown };
    if (r && typeof r === "object") {
      const lines: string[] = [];
      if (typeof r.approved === "boolean") lines.push(`approved: ${r.approved}`);
      if (Array.isArray(r.findings) && r.findings.length > 0) {
        lines.push("findings:");
        for (const f of r.findings.slice(0, 10)) {
          lines.push(`- ${typeof f === "string" ? f : JSON.stringify(f)}`);
        }
      }
      if (typeof r.notes === "string" && r.notes.trim()) lines.push(`notes: ${r.notes}`);
      reviewBody = lines.length > 0 ? lines.join("\n") : JSON.stringify(s.review, null, 2);
    } else {
      reviewBody = JSON.stringify(s.review);
    }
  }

  const modelBody =
    s.modelChain === undefined ? "(none)" : JSON.stringify(s.modelChain, null, 2);

  const durations =
    s.timing.durationMs.length > 0 ? s.timing.durationMs.map((d) => String(d)).join(", ") : "(none)";
  const timingBody =
    `durationMs: ${durations}\n` +
    `turns: ${s.timing.turns ?? "(none)"}\n` +
    `tools: ${s.timing.tools ?? "(none)"}`;

  return [
    `# ${s.sliceId} — ${s.title} [${s.status}]`,
    section("Spec", spec),
    section("Report summary", reportBody),
    section("Verdict gates", verdictBody),
    section("Review", reviewBody),
    section("Model chain", modelBody),
    section("Timing", timingBody),
  ].join("\n\n");
}

export type ExecFn = (cmd: string, args: string[], cwd: string) => { exit: number; out: string };

function defaultExec(cmd: string, args: string[], cwd: string): { exit: number; out: string } {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { exit: r.status ?? 1, out: String(r.stdout ?? "") };
  } catch (err) {
    return { exit: 1, out: err instanceof Error ? err.message : String(err) };
  }
}

export interface SliceDiff {
  branch: string;
  base: string | null;
  stat: string;
  diff: string;
  note: string;
}

export const DIFF_CAP = 20000;

/**
 * Diff the slice's worktree branch against HEAD. Never throws: git failures
 * surface as a `note`.
 */
export function diffSliceBranch(
  projectDir: string,
  runId: string,
  sliceId: string,
  exec: ExecFn = defaultExec,
): SliceDiff {
  const branch = `ompo/${runId}/${sliceId}`;
  try {
    const baseRes = exec("git", ["merge-base", "HEAD", branch], projectDir);
    if (baseRes.exit !== 0 || !baseRes.out.trim()) {
      return { branch, base: null, stat: "", diff: "", note: "in-place run, no branch" };
    }
    const base = baseRes.out.trim().split("\n")[0]!.trim();
    const range = `${base}...${branch}`;
    const statRes = exec("git", ["diff", "--stat", range], projectDir);
    const diffRes = exec("git", ["diff", range], projectDir);
    let diff = diffRes.exit === 0 ? diffRes.out : "";
    let note = "";
    if (diff.length > DIFF_CAP) {
      diff = diff.slice(0, DIFF_CAP);
      note = "truncated";
    } else if (diffRes.exit !== 0 || statRes.exit !== 0) {
      note = "git diff failed";
    }
    return { branch, base, stat: statRes.exit === 0 ? statRes.out : "", diff, note };
  } catch (err) {
    return {
      branch,
      base: null,
      stat: "",
      diff: "",
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Git worktree path when the dir exists, else the project dir (in-place run).
 */
export function sliceWorktreePath(
  projectDir: string,
  runId: string,
  sliceId: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const wt = join(projectDir, ".omp", "roadmap", "worktrees", `${runId}-${sliceId}`);
  try {
    return exists(wt) ? wt : projectDir;
  } catch {
    return projectDir;
  }
}

export interface PruneOptions {
  exec?: ExecFn;
  removeDir?: (p: string) => void;
  listRuns?: () => string[];
  readdir?: (p: string) => string[];
}

/** Terminal slice statuses whose worktree dirs are safe to remove. */
const PRUNEABLE = new Set(["done", "failed", "skipped"]);

/**
 * `git worktree prune`, then remove worktree dirs whose run is unknown or
 * whose slice is terminal (done/failed/skipped). Dirs for running/verifying
 * slices are always kept, as is everything when the run list is unavailable.
 * Never throws for a single bad entry — it is kept.
 */
export function pruneWorktrees(
  projectDir: string,
  opts: PruneOptions = {},
): { pruned: string[]; kept: string[] } {
  const exec = opts.exec ?? defaultExec;
  const removeDir =
    opts.removeDir ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const pruned: string[] = [];
  const kept: string[] = [];
  try {
    exec("git", ["worktree", "prune"], projectDir);
  } catch {
    /* best-effort */
  }

  const wtRoot = join(projectDir, ".omp", "roadmap", "worktrees");
  let entries: string[];
  try {
    entries = opts.readdir ? opts.readdir(wtRoot) : readdirSync(wtRoot).sort();
  } catch {
    return { pruned, kept };
  }

  let known: string[] | undefined;
  try {
    known = opts.listRuns ? opts.listRuns() : listRuns(projectDir);
  } catch {
    known = undefined;
  }
  if (known === undefined) {
    // Cannot tell unknown runs from live ones — keep everything.
    return { pruned, kept: entries.map((e) => join(wtRoot, e)) };
  }
  const knownSet = new Set(known);
  const longestFirst = [...known].sort((a, b) => b.length - a.length);

  for (const entry of entries) {
    const full = join(wtRoot, entry);
    try {
      // Split "<run>-<slice>": run ids contain a dash, so match the longest
      // known run prefix instead of splitting on the first dash.
      const runHit = longestFirst.find((r) => entry.startsWith(`${r}-`));
      if (!runHit || !knownSet.has(runHit)) {
        removeDir(full);
        pruned.push(full);
        continue;
      }
      const sliceId = entry.slice(runHit.length + 1);
      if (!sliceId) {
        kept.push(full);
        continue;
      }
      const cursor = loadRun(projectDir, runHit);
      const slice = cursor.doc.slices.find((s) => s.id === sliceId);
      if (slice && PRUNEABLE.has(slice.status)) {
        removeDir(full);
        pruned.push(full);
      } else {
        kept.push(full);
      }
    } catch {
      kept.push(full);
    }
  }
  return { pruned, kept };
}

/**
 * Last `n` lines of the newest worker-*.log for a slice. Empty array when
 * there is no log. Never throws.
 */
export function tailSliceLog(
  projectDir: string,
  runId: string,
  sliceId: string,
  n = 50,
  io?: ForensicsIo,
): string[] {
  try {
    const dir = sliceDir(projectDir, runId, sliceId);
    const logFile = ioList(io, dir)
      .filter((f) => /^worker-.*\.log$/.test(f))
      .sort()
      .at(-1);
    if (!logFile) return [];
    return lastLines(ioRead(io, join(dir, logFile)), n);
  } catch {
    return [];
  }
}

/** Last `n` lines of a transcript text, ignoring one trailing newline. */
function lastLines(text: string, n: number): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

/** The lane that wrote a slice transcript. */
export type SliceLane = "worker" | "debug" | "review" | "review-fix" | "verify";

export interface SliceTranscript {
  /** Slice-relative transcript path (browser-facing label); null when none. */
  name: string | null;
  /** Lane that wrote it — the dashboard labels the tail with it. */
  lane: SliceLane | null;
  /** Last `n` lines of the newest transcript. Empty when there is none. */
  lines: string[];
}

/** Root-level lane transcripts; gates live in subdirs and are handled below. */
const TRANSCRIPT_LANES: readonly { re: RegExp; lane: SliceLane }[] = [
  { re: /^worker-\d+(-g\d+)?\.log$/, lane: "worker" },
  { re: /^debug-\d+\.log$/, lane: "debug" },
  { re: /^review-\d+\.log$/, lane: "review" },
  { re: /^review-fix-\d+\.log$/, lane: "review-fix" },
];

/** Gate chains, in the order they can run; each holds verify-<n>.log per step. */
const GATE_LOG_DIRS = ["logs", "logs-reverify"] as const;

/**
 * Newest live transcript for a slice, whichever lane is writing right now:
 * a worker generation, a debug session, the reviewer's audit, or a running
 * verify gate (the gate streams its output into logs/verify-<n>.log as it
 * runs). Selection is by mtime — lanes overwrite each other in real time, so
 * the newest write *is* the active stage. Name breaks ties, so an idle slice
 * never flips files between polls. Never throws.
 */
export function sliceTranscript(
  projectDir: string,
  runId: string,
  sliceId: string,
  n = 50,
  io?: ForensicsIo,
): SliceTranscript {
  let dir: string;
  try {
    dir = sliceDir(projectDir, runId, sliceId);
  } catch {
    return { name: null, lane: null, lines: [] };
  }
  const candidates: { name: string; lane: SliceLane; mtimeMs: number }[] = [];
  const add = (name: string, lane: SliceLane): void => {
    const mtimeMs = ioStatMtimeMs(io, join(dir, name));
    if (mtimeMs !== null) candidates.push({ name, lane, mtimeMs });
  };
  for (const f of ioList(io, dir)) {
    const lane = TRANSCRIPT_LANES.find((l) => l.re.test(f));
    if (lane) add(f, lane.lane);
  }
  for (const sub of GATE_LOG_DIRS) {
    for (const f of ioList(io, join(dir, sub))) {
      if (/^verify-\d+\.log$/.test(f)) add(`${sub}/${f}`, "verify");
    }
  }
  const best = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  if (!best) return { name: null, lane: null, lines: [] };
  try {
    return { name: best.name, lane: best.lane, lines: lastLines(ioRead(io, join(dir, best.name)), n) };
  } catch {
    return { name: best.name, lane: best.lane, lines: [] };
  }
}
/**
 * Liveness of a slice's stage artifacts: the newest loop/worker write in the
 * slice dir (worker/review/debug transcripts, verdict/report/review JSON,
 * prompts, sidecars) and how long ago it landed. A live slice gone quiet for
 * many minutes is the wedged-loop signature (dead worker, starved loop) —
 * the dashboard watchdog reads this, never the process table. Stage-wide by
 * construction: a verifying slice advances through verdict/review files, not
 * the worker log, so worker-only freshness false-positives on every review.
 * Never throws.
 */
export interface SliceActivity {
  /** Newest stage-artifact name, or null when the slice never spawned. */
  name: string | null;
  /** Its mtime epoch ms, or null when unknown. */
  logMtimeMs: number | null;
  /** nowMs - logMtimeMs, or null when the mtime is unknown. */
  staleForMs: number | null;
}

function ioStatMtimeMs(io: ForensicsIo | undefined, p: string): number | null {
  if (io?.statMtimeMs) return io.statMtimeMs(p);
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Stage artifacts: everything the loop/worker/verifier writes mid-stage. */
function isStageArtifact(f: string): boolean {
  return /\.(log|json|md)$/.test(f);
}

export function sliceActivity(
  projectDir: string,
  runId: string,
  sliceId: string,
  nowMs: number = Date.now(),
  io?: ForensicsIo,
): SliceActivity {
  try {
    const dir = sliceDir(projectDir, runId, sliceId);
    let newest = "";
    let mtimeMs = -1;
    for (const f of ioList(io, dir)) {
      if (!isStageArtifact(f)) continue;
      const m = ioStatMtimeMs(io, join(dir, f));
      if (m !== null && m > mtimeMs) {
        newest = f;
        mtimeMs = m;
      }
    }
    if (mtimeMs < 0) return { name: null, logMtimeMs: null, staleForMs: null };
    return { name: newest, logMtimeMs: mtimeMs, staleForMs: Math.max(0, nowMs - mtimeMs) };
  } catch {
    return { name: null, logMtimeMs: null, staleForMs: null };
  }
}

 /**
  * Operator sessions: the loop's own agent sessions (end-of-run unblock
  * rounds, per-slice debug sessions). Same durable-state rule as everything
  * else the dashboard reads: sessions stream their progress transcript into
  * unblock-{round}.log / debug-{attempt}.log as they render (worker parity),
  * so a tail here is live mid-session. `running` means a prompt was recorded
  * without a completion footer — the only honest signal on disk. Never throws.
  */
 export interface OperatorSession {
   /** "unblock-1" (run-level) or "debug-4" (slice-level — see sliceId). */
   name: string;
   kind: "unblock" | "debug";
   /** Debug sessions only; unblock targets ride `targets`. */
   sliceId: string | null;
   /** Blocked slice ids from unblock-{round}.meta.json ([] when absent). */
   targets: string[];
   status: "running" | "done";
   exit: number | null;
   timedOut: boolean;
   durationMs: number | null;
 }

 function parseCompletionFooter(firstLine: string): { exit: number | null; timedOut: boolean; durationMs: number | null } | null {
   const m = firstLine.match(/^exit=(\S+) timedOut=(\S+) durationMs=(\S+)/);
   if (!m) return null;
   const exit = Number(m[1]);
   const durationMs = Number(m[3]);
   return { exit: Number.isFinite(exit) ? exit : null, timedOut: m[2] === "true", durationMs: Number.isFinite(durationMs) ? durationMs : null };
 }

 function sessionCompletion(
   io: ForensicsIo | undefined,
   logPath: string,
 ): Pick<OperatorSession, "status" | "exit" | "timedOut" | "durationMs"> {
   const pending = { status: "running", exit: null, timedOut: false, durationMs: null } as const;
   try {
     const first = ioRead(io, logPath).split("\n", 1)[0] ?? "";
     const parsed = parseCompletionFooter(first);
     return parsed ? { status: "done", ...parsed } : { ...pending };
   } catch {
     return { ...pending };
   }
 }
 export function listSessions(projectDir: string, runId: string, io?: ForensicsIo): OperatorSession[] {
   const out: OperatorSession[] = [];
   let root: string;
   try {
     root = runDir(projectDir, runId);
   } catch {
     return [];
   }
   for (const f of ioList(io, root)) {
     const m = f.match(/^unblock-(\d+)\.prompt\.md$/);
     if (!m) continue;
     const round = m[1]!;
     const meta = tryReadJson(io, join(root, `unblock-${round}.meta.json`)) as { targets?: unknown } | undefined;
     const targets = Array.isArray(meta?.targets) ? meta.targets.filter((t): t is string => typeof t === "string") : [];
     out.push({
       name: `unblock-${round}`,
       kind: "unblock",
       sliceId: null,
       targets,
       ...sessionCompletion(io, join(root, `unblock-${round}.log`)),
     });
   }
  for (const entry of ioList(io, join(root, "slices"))) {
    const dir = sliceDir(projectDir, runId, entry);
    const attempts: string[] = [];
    for (const f of ioList(io, dir)) {
      const m = f.match(/^debug-(?:prompt-)?(\d+)\.(?:md|log)$/);
      if (m?.[1] && !attempts.includes(m[1])) attempts.push(m[1]);
    }
    for (const attempt of attempts) {
      out.push({
        name: `debug-${attempt}`,
        kind: "debug",
        sliceId: entry,
        targets: [],
        ...sessionCompletion(io, join(dir, `debug-${attempt}.log`)),
      });
    }
  }
  const rank = (s: OperatorSession): [number, string, number] => [
    s.kind === "unblock" ? 0 : 1,
    s.sliceId ?? "",
    Number(s.name.match(/(\d+)$/)?.[1] ?? 0),
  ];
  return out.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || (ra[1] < rb[1] ? -1 : ra[1] > rb[1] ? 1 : 0) || ra[2] - rb[2];
  });
 }
 /**
  * Last `n` lines of one operator session log. `name` must be a session id
  * from listSessions (`unblock-{round}`, or `debug-{attempt}` with its
  * sliceId) — anything else resolves to no file. Empty array when there is
  * no log yet. Never throws.
  */
 export function tailSessionLog(
   projectDir: string,
   runId: string,
   name: string,
   sliceId: string | null,
   n = 50,
   io?: ForensicsIo,
 ): string[] {
   try {
     let file = "";
     if (/^unblock-\d+$/.test(name) && sliceId === null) {
       file = join(runDir(projectDir, runId), `${name}.log`);
     } else {
       const dm = name.match(/^debug-(\d+)$/);
       if (dm && sliceId !== null && /^[\w][\w.-]*$/.test(sliceId)) {
         file = join(sliceDir(projectDir, runId, sliceId), `${name}.log`);
       }
     }
     if (!file) return [];
     const lines = ioRead(io, file).split("\n");
     if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
     return lines.slice(-n);
   } catch {
     return [];
   }
 }
