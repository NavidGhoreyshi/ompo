/**
 * Orchestrator loop (plan §8, M5):
 * load → select → spawn → verify → persist → repeat, with retries + abort.
 * Each step is a separate store write (crash-safe at every boundary).
 *
 * Exit codes: 0 all done · 1 failures remain · 2 aborted · 3 resume-conflict.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoadmapConfig } from "./config.ts";
import { nextReady } from "./select.ts";
import { buildWorkerSpec } from "./spec.ts";
import { sliceDir, storeApi, loadRun } from "./store.ts";
import type { CompletionReport, RoadmapDoc, Slice } from "./types.ts";
import { extractReportFromOutput, validateCompletionReport } from "./report.ts";
import { runVerifiers } from "./verify.ts";
import { resolveWorkerModel, runOmpWorker, type WorkerRunner } from "./worker.ts";

export interface LoopOptions {
  projectDir: string;
  runId: string;
  runner?: WorkerRunner;
  /** Run only this slice id (must be ready). */
  onlySlice?: string;
  maxRetriesOverride?: number;
  signal?: AbortSignal;
  onEvent?: (msg: string) => void;
}

export interface LoopResult {
  exitCode: 0 | 1 | 2 | 3;
  done: number;
  failed: number;
  skipped: number;
  pending: number;
}

function log(opts: LoopOptions, msg: string): void {
  (opts.onEvent ?? ((m) => console.log(m)))(msg);
}

function depSummaries(projectDir: string, runId: string, slice: Slice): Map<string, string> {
  const out = new Map<string, string>();
  for (const dep of slice.deps) {
    const reportPath = join(sliceDir(projectDir, runId, dep), "report.json");
    try {
      if (existsSync(reportPath)) {
        const r = JSON.parse(readFileSync(reportPath, "utf8")) as CompletionReport;
        if (r.summary) out.set(dep, r.summary);
      }
    } catch {
      /* missing/unreadable → spec notes "(no summary recorded)" */
    }
  }
  return out;
}

function maxRetriesFor(slice: Slice, opts: LoopOptions): number {
  return opts.maxRetriesOverride ?? slice.maxRetries;
}

function summarize5(
  slice: Slice,
  outcome: string,
  report?: CompletionReport,
  verdictPass?: boolean,
): string {
  const lines = [
    `— slice ${slice.id}: ${outcome}`,
    `  title: ${slice.title}`,
    `  attempt: ${slice.attempts}`,
  ];
  if (report) lines.push(`  summary: ${report.summary.slice(0, 200)}`);
  if (verdictPass !== undefined) lines.push(`  verify: ${verdictPass ? "pass" : "FAIL"}`);
  return lines.join("\n");
}

export async function runRoadmapLoop(opts: LoopOptions): Promise<LoopResult> {
  const runner: WorkerRunner = opts.runner ?? runOmpWorker;
  const cfg = loadRoadmapConfig(opts.projectDir);
  const finish = (): LoopResult => {
    const cursor = loadRun(opts.projectDir, opts.runId);
    const count = (s: string) => cursor.doc.slices.filter((x) => x.status === s).length;
    const done = count("done");
    const failed = count("failed");
    const skipped = count("skipped");
    const pending = cursor.doc.slices.filter((x) => !["done", "failed", "skipped"].includes(x.status)).length;
    const exitCode = failed > 0 || pending > 0 ? 1 : 0;
    return { exitCode, done, failed, skipped, pending };
  };

  for (;;) {
    if (opts.signal?.aborted) {
      storeApi.abortRun(opts.projectDir, opts.runId);
      log(opts, "aborted by signal");
      const r = finish();
      return { ...r, exitCode: 2 };
    }

    let cursor = loadRun(opts.projectDir, opts.runId);
    const doc: RoadmapDoc = cursor.doc;

    let slice: Slice | null;
    if (opts.onlySlice) {
      const found = doc.slices.find((s) => s.id === opts.onlySlice) ?? null;
      if (!found) throw new Error(`unknown slice "${opts.onlySlice}"`);
      if (["done", "failed", "skipped"].includes(found.status)) {
        log(opts, `slice ${found.id} already ${found.status} — nothing to do`);
        const r = finish();
        return r;
      }
      const depsMet = found.deps.every(
        (d) => doc.slices.find((s) => s.id === d)?.status === "done",
      );
      if (!depsMet) throw new Error(`slice "${found.id}" is blocked: deps not done`);
      if (found.status !== "pending") {
        throw new Error(`slice "${found.id}" is ${found.status}; resume the run first`);
      }
      slice = found;
    } else {
      slice = nextReady(doc);
    }

    if (!slice) {
      const r = finish();
      storeApi.finishRun(
        opts.projectDir,
        opts.runId,
        `done=${r.done} failed=${r.failed} skipped=${r.skipped} pending=${r.pending}`,
      );
      log(opts, `run finished: done=${r.done} failed=${r.failed} skipped=${r.skipped} pending=${r.pending}`);
      return r;
    }

    const sliceId = slice.id;
    const dir = sliceDir(opts.projectDir, opts.runId, sliceId);
    mkdirSync(dir, { recursive: true });

    // 1. Claim fence.
    cursor = storeApi.claimSlice(opts.projectDir, opts.runId, sliceId);
    const claimed = cursor.doc.slices.find((s) => s.id === sliceId)!;
    const attempt = claimed.attempts;
    const maxRetries = maxRetriesFor(claimed, opts);
    log(opts, `▸ slice ${sliceId} — ${claimed.title} (attempt ${attempt})`);

    // 2. Compile worker spec.
    const spec = buildWorkerSpec(claimed, cursor.doc, attempt, {
      depSummaries: depSummaries(opts.projectDir, opts.runId, claimed),
      maxChars: cfg.specBudget,
      projectDir: opts.projectDir,
    });
    writeFileSync(join(dir, `prompt-${attempt}.md`), spec.prompt, "utf8");

    if (opts.signal?.aborted) {
      storeApi.abortSlice(opts.projectDir, opts.runId, sliceId);
      storeApi.abortRun(opts.projectDir, opts.runId);
      const r = finish();
      return { ...r, exitCode: 2 };
    }

    // 3. Spawn worker (clean context: fresh `omp -p` process, spec only).
    const workerModel = resolveWorkerModel(claimed.workerAgent, cfg);
    const workerTimeoutMs = cfg.workerTimeoutSec ? cfg.workerTimeoutSec * 1000 : undefined;
    let workerOut = "";
    try {
      const res = await runner(
        { prompt: spec.prompt, sliceId, attempt },
        { projectDir: opts.projectDir, workerModel, timeoutMs: workerTimeoutMs },
      );
      workerOut = `exit=${res.exit} timedOut=${res.timedOut} durationMs=${res.durationMs}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`;
      writeFileSync(join(dir, `worker-${attempt}.log`), workerOut, "utf8");
      if (res.timedOut) {
        throw new Error(`worker timed out`);
      }
      if (res.exit !== 0) {
        // Non-zero exit: still try to extract a report (worker may have
        // printed one before failing); else worker failure.
        const maybe = extractReportFromOutput(res.stdout);
        if (maybe === undefined) throw new Error(`worker exited ${res.exit} with no report`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeFileSync(join(dir, `worker-${attempt}.log`), workerOut + `\nSPAWN ERROR: ${msg}\n`, "utf8");
      log(opts, summarize5(claimed, `worker failure: ${msg}`));
      if (attempt <= maxRetries) {
        storeApi.retrySlice(opts.projectDir, opts.runId, sliceId);
        log(opts, `  retrying (${attempt}/${maxRetries} retries used)`);
      } else {
        storeApi.verifyFailed(opts.projectDir, opts.runId, sliceId, `worker-${attempt}.log`);
        storeApi.terminalFail(opts.projectDir, opts.runId, sliceId);
        log(opts, `  terminal failure (retries exhausted)`);
      }
      if (opts.onlySlice) return finish();
      continue;
    }

    if (opts.signal?.aborted) {
      storeApi.abortSlice(opts.projectDir, opts.runId, sliceId);
      storeApi.abortRun(opts.projectDir, opts.runId);
      const r = finish();
      return { ...r, exitCode: 2 };
    }

    // 4. Extract + validate strict report.
    const rawStdout = workerOut.split("--- stdout ---\n")[1]?.split("\n--- stderr ---")[0] ?? "";
    const extracted = extractReportFromOutput(rawStdout);
    let report: CompletionReport;
    try {
      if (extracted === undefined) throw new Error("no <<<OMPO_REPORT>>> block found in worker output");
      report = validateCompletionReport(extracted, sliceId);
      if (!report.done) throw new Error(`worker reported done=false: ${report.verificationNotes.slice(0, 300)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeFileSync(join(dir, `report-${attempt}.invalid.json`), JSON.stringify({ error: msg, raw: extracted === undefined ? null : extracted }, null, 2), "utf8");
      log(opts, summarize5(claimed, `invalid report: ${msg}`));
      if (attempt <= maxRetries) {
        storeApi.retrySlice(opts.projectDir, opts.runId, sliceId);
        log(opts, `  retrying (${attempt}/${maxRetries} retries used)`);
      } else {
        storeApi.verifyFailed(opts.projectDir, opts.runId, sliceId, `report-${attempt}.invalid.json`);
        storeApi.terminalFail(opts.projectDir, opts.runId, sliceId);
        log(opts, `  terminal failure (retries exhausted)`);
      }
      if (opts.onlySlice) return finish();
      continue;
    }

    // 5. Persist report → verifying.
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    storeApi.workerFinished(opts.projectDir, opts.runId, sliceId, join("slices", sliceId, "report.json"));

    // 6. Verify.
    const verifyCommands = [...(cfg.verifyDefaults ?? []), ...claimed.verify];
    const verdict = await runVerifiers(sliceId, attempt, verifyCommands, join(dir, "logs"), {
      projectDir: opts.projectDir,
    });
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");

    if (verdict.pass) {
      storeApi.verifyPassed(opts.projectDir, opts.runId, sliceId, join("slices", sliceId, "verdict.json"));
      log(opts, summarize5(claimed, "done", report, true));
    } else {
      const reason = verdict.steps.length === 0
        ? "no verifiers"
        : `verify failed: ${verdict.steps.filter((s) => s.exit !== 0).map((s) => s.command).join("; ").slice(0, 300)}`;
      // verify_failed (transient) then either retry or terminal.
      storeApi.verifyFailed(opts.projectDir, opts.runId, sliceId, join("slices", sliceId, "verdict.json"));
      if (attempt <= maxRetries) {
        storeApi.retrySlice(opts.projectDir, opts.runId, sliceId);
        log(opts, summarize5(claimed, reason, report, false));
        log(opts, `  retrying (${attempt}/${maxRetries} retries used)`);
      } else {
        storeApi.terminalFail(opts.projectDir, opts.runId, sliceId);
        log(opts, summarize5(claimed, `${reason} — terminal (retries exhausted)`, report, false));
      }
    }

    if (opts.onlySlice) return finish();
  }
}
