#!/usr/bin/env bun
/**
 * E2E fixture server (Playwright `webServer`).
 *
 * Builds a throwaway project whose strings stress container overflow —
 * 200-char titles, 300-char unbroken reasons, 400-char log lines — then
 * serves the real dashboard. The only repo write is nothing: fixtures live
 * in tmp dirs. Usage: `bun tests/e2e/serve.ts --port 4319`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { parseRoadmap } from "../../src/parse.ts";
import { createRun, storeApi } from "../../src/store.ts";
import { startDashboardServer } from "../../src/server.ts";

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4319;

const LONG_TITLE =
  "Refactor the authentication middleware pipeline for multi-tenant session handling " +
  "supercalifragilisticexpialidocious".repeat(3);
const LONG_REASON =
  "worker exited 1 mid-generation: " + "deadbeef".repeat(30) + " — see worker-2-g1.log tail for the full trace";
const LONG_LINE = "token-" + "0123456789abcdef".repeat(25);
const LONG_PATH =
  "src/features/authentication/middleware/session/" + "deeply-nested-module-".repeat(8) + "handler.ts";

const MD = `## [s-alpha] Ship the alpha slice
Effort: lo
Agent: sonic
Verify: bun test
alpha body
## [s-beta] Wire the beta endpoints
Effort: med
Agent: task
Verify: bun lint
beta body
## [longtitle] ${LONG_TITLE}
Effort: hi
Agent: task
Verify: bun test --coverage
longtitle body
## [longreason] Normal title, catastrophic reason
Effort: lo
Agent: sonic
Verify: bun test
longreason body
## [envblock] Environment-gated slice
Effort: med
Agent: task
Verify: bun test
envblock body
## [verifying] Awaiting verdict
Effort: lo
Agent: sonic
Verify: bun test
verifying body
## [running] Currently executing
Effort: lo
Agent: sonic
Verify: bun test
running body
## [p-one] First pending slice
Effort: lo
Agent: sonic
Verify: bun test
pending one
## [p-two] Second pending slice
Effort: lo
Agent: sonic
Verify: bun test
pending two
`;

function sliceFile(dir: string, run: string, slice: string, name: string, text: string): void {
  const d = join(dir, ".omp", "roadmap", "runs", run, "slices", slice);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), text, "utf8");
}

function reportJson(summary: string, filesChanged: string[] = []): string {
  return JSON.stringify({ summary, done: true, filesChanged, testsRun: ["bun test"], deferred: [], followUps: [] });
}

function verdictJson(pass: boolean, outputTail: string): string {
  return JSON.stringify({ pass, steps: [{ name: "bun test", exit: pass ? 0 : 1, timedOut: false, outputTail }] });
}

const dir = mkdtempSync(join(tmpdir(), "ompo-e2e-"));

// Probe run first: listRuns sorts oldest-first, so the matrix run below is
// the default selection while the long id still stresses Runs + run picker.
const probe = "e2e-overflow-probe-run-0123456789";
createRun(dir, parseRoadmap(`## [only] Only slice\nEffort: lo\nAgent: sonic\nVerify: bun test\nbody\n`), probe);
storeApi.claimSlice(dir, probe, "only");
storeApi.workerFinished(dir, probe, "only", "slices/only/report.json", { exit: 0, durationMs: 1000 });
storeApi.verifyPassed(dir, probe, "only", "slices/only/verdict.json");
sliceFile(dir, probe, "only", "report.json", reportJson("only done"));
sliceFile(dir, probe, "only", "verdict.json", verdictJson(true, "ok"));

const run = "e2emain";
createRun(dir, parseRoadmap(MD), run);

storeApi.claimSlice(dir, run, "s-alpha");
storeApi.workerFinished(dir, run, "s-alpha", "slices/s-alpha/report.json", {
  exit: 0,
  durationMs: 65_000,
  stats: { turns: 10, tools: 4, tokens: { input: 1234567, output: 890123, total: 2124690 } },
});
storeApi.verifyPassed(dir, run, "s-alpha", "slices/s-alpha/verdict.json");
sliceFile(dir, run, "s-alpha", "worker-1-g0.log", "alpha log\n");
sliceFile(dir, run, "s-alpha", "report.json", reportJson("alpha done", [LONG_PATH]));
sliceFile(dir, run, "s-alpha", "verdict.json", verdictJson(true, "ok"));

storeApi.claimSlice(dir, run, "s-beta");
storeApi.workerFinished(dir, run, "s-beta", "slices/s-beta/report.json", { exit: 0, durationMs: 5_000 });
storeApi.verifyPassed(dir, run, "s-beta", "slices/s-beta/verdict.json");
sliceFile(dir, run, "s-beta", "report.json", reportJson("beta done"));
sliceFile(dir, run, "s-beta", "verdict.json", verdictJson(true, "ok"));

storeApi.claimSlice(dir, run, "longtitle");
storeApi.claimSlice(dir, run, "longreason");
storeApi.workerFinished(dir, run, "longreason", "slices/longreason/report.json", { exit: 1, durationMs: 9_000 });
storeApi.terminalFail(dir, run, "longreason", LONG_REASON);
storeApi.parkSlice(dir, run, "envblock", LONG_REASON);

storeApi.claimSlice(dir, run, "verifying");
storeApi.workerFinished(dir, run, "verifying", "slices/verifying/report.json", { exit: 0, durationMs: 3_000 });

storeApi.claimSlice(dir, run, "running");
sliceFile(dir, run, "running", "worker-1-g0.log",
  `  [running] turn 1…\n  [running] last observed worker line ${LONG_LINE}\n`);
// Long worker log for the live window: real progress grammar, enough lines to
// scroll, and one catastrophic line so truncation is exercised too.
sliceFile(
  dir, run, "longtitle", "worker-1-g0.log",
  [
    ...Array.from({ length: 40 }, (_, i) => `  [longtitle] tool read: src/${"deeply-nested-module-".repeat(4)}file-${i + 1}.ts`),
    `  [longtitle] tool glob: ${LONG_LINE}`,
    `  [longtitle] turn 1 done (41 tool results)`,
    ...Array.from({ length: 40 }, (_, i) => `  [longtitle] tool edit: src/${"deeply-nested-module-".repeat(4)}file-${i + 1}.ts`),
    `  [longtitle] tool bash: bun test --coverage --filter ${LONG_LINE}`,
    `  [longtitle] tool bash FAILED`,
    `  [longtitle] retrying: provider error 429`,
    `  [longtitle] turn 2 done (42 tool results)`,
  ].join("\n") + "\n",
);
sliceFile(dir, run, "longtitle", "prompt-1-g0.md", `# prompt\n\n${LONG_LINE}\n\n${"ordinary prompt prose ".repeat(40)}\n`);
sliceFile(
  dir, run, "longreason", "report.json",
  JSON.stringify({
    summary: LONG_REASON,
    done: false,
    filesChanged: [LONG_PATH, LONG_PATH],
    testsRun: ["bun test --coverage"],
    deferred: [LONG_REASON],
    followUps: [],
    verificationNotes: LONG_LINE,
  }),
);
sliceFile(
  dir, run, "longreason", "verdict.json",
  JSON.stringify({ pass: false, steps: [{ name: "bun test --coverage", exit: 1, timedOut: false, outputTail: LONG_LINE }] }),
);
sliceFile(
  dir, run, "longreason", "review.json",
  JSON.stringify({ approved: false, findings: [LONG_REASON, LONG_LINE], notes: LONG_REASON }),
);
sliceFile(dir, run, "longreason", "prompt-1-g0.md", `# prompt\n\n${"spec prose ".repeat(60)}\n`);

const server = startDashboardServer({ projectDir: dir, port });
console.log(`e2e-server: ${server.url} (project ${dir}, assets ${server.assetMode})`);
const { promise } = Promise.withResolvers<void>();
await promise;
