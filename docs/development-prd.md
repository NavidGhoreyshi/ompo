# ompo Development PRD — How This Project Is Developed

Status: living spec. Source of truth is the tree; this doc describes the load-bearing conventions.
Audience: any agent or human landing in `/home/navid/ompo` to change code.

## 1. What this project is

`ompo` (OMP Roadmap Orchestrator) is a long-horizon sequential workflow driver for **stock `omp`** (`@oh-my-pi/pi-coding-agent`, no core fork). Each roadmap slice runs as a fresh `omp -p` worker (clean context by construction), with a durable store, verifier gates, retries, review gate, and crash resume.

Canonical entry points (`src/cli.ts`, `README.md`):

```bash
ompo                  # unified TUI: plan (if needed) → run → done
ompo init             # planner session surveys docs → ROADMAP.md (+ .omp/roadmap.yml)
ompo plan             # preview: slices, gates, deps + lint (exit 1 when blocked)
ompo run --dry-run    # parse + dependency order, spawns nothing
ompo run              # live TUI: board + inspector + scrollable log
ompo status           # read-only progress dump
```

This repo (`ompo` itself) has **no `ROADMAP.md`**. Dogfood runs happen in pilot dirs outside the repo; `.omp/` here holds only handoffs/ratings, and is gitignored.

## 2. Non-goals (do not smuggle in)

- No fork of `omp` core. Reuse `omp -p` / `--mode json` workers, `omp --model` routing, session files. Reference analysis: `OMP_ROADMAP_ORCHESTRATOR_PLAN.md` §§1–4.
- No new multi-agent framework. The orchestrator is a rule engine + store + loop around existing primitives (worker spawn, schema enforcement, session persistence, isolation).
- No roadmap-file-driven chaos: `--fault-inject` / `--seed` are CLI-only, never config (`src/faults.ts`).
- No interactive editor flow inside the TUI preview (`e` = reload-from-disk; operator edits elsewhere).
- No weakening of gates to make runs pass: `done=false` is reserved for genuinely broken code; missing live values defer (never-block rule), they never fake green.

## 3. Stack and toolchain

| Layer | Choice | Evidence |
|---|---|---|
| Runtime | Bun only (`#!/usr/bin/env bun`, `bun install`, `bun test`, `bun build --compile`) | `src/cli.ts:1`, `package.json` scripts |
| Language | TypeScript `ESNext`, `moduleResolution: bundler`, `jsx: react-jsx`, `strict: true`, `allowImportingTsExtensions: true` | `tsconfig.json` |
| Imports | ESM with explicit `.ts` extensions (`from "./parse.ts"`) | every `src/*.ts` |
| TUI | React 19 + Ink 7 (`src/watch.tsx`, `src/run.tsx`, `src/unified.tsx`) | `package.json` deps |
| Config parsing | Hand-rolled minimal YAML-subset parser, **no YAML dep** | `src/config.ts:1-30` |
| Git ops | `node:child_process spawnSync` + `node:fs` sync calls, no git library | `src/worktree.ts`, `src/harnessFix.ts` |
| Tests | `bun:test` (`describe/expect/test`), colocated by area under `tests/` mirroring `src/` | `tests/*.test.ts` |
| Binary | `bun build --compile src/cli.ts --outfile ompo`; output `ompo` (92 MB) is **gitignored** | `package.json:build`, `.gitignore:1-2` |
| Version | Single-source in `package.json:version` (currently `0.2.0`), read by CLI | `src/cli.ts:45-47` |

Commands every change must survive:

```bash
bun install
bun test              # 385 pass / 0 fail baseline at sprint-4 handoff
bunx tsc --noEmit     # must be clean
git diff --check      # must be clean
bun scripts/gen-captures.ts   # after any TUI layout change
```

## 4. Repo map

```
src/            40 modules. Kernel + lanes + TUIs + operability (see §5).
tests/          36 files, mirror of src (store.test.ts ↔ store.ts, loop.test.ts ↔ loop.ts …).
templates/      ROADMAP.example.md, roadmap.yml.example — stamped by init/import.
scripts/        gen-captures.ts — regenerates captures/ ASCII fixtures from real layout exports.
captures/       9 tracked ASCII compositions (normal-120, narrow-70, dag-100, failure-state …).
docs/           This PRD (development process). User manual stays in README.md.
.omp/           Gitignored run state + handoffs (handoff-sprint3/4.md) + ratings/. Never commit.
ompo            Compiled binary, gitignored. Rebuild, never check in.
HARP-1.md       Example build spec (debugger harness-fix lane). Pattern for future HARPs.
OMP_ROADMAP_ORCHESTRATOR_PLAN.md  Reconnaissance + architecture plan (§§5–6, 11–14 implemented).
```

`src/` ownership (read these before touching the area):

- **Kernel:** `cli.ts` (45 KB, all commands/flags/help), `loop.ts` (73 KB, claim→attempt→verify→merge→review pipeline), `attempt.ts` (AttemptCtx + progress/outcome kernel, extracted from loop with zero behavior change), `store.ts` (20 KB, durable cursor + events), `types.ts`, `parse.ts` (roadmap md → doc), `select.ts` (ready-selector), `spec.ts` (worker-spec builder), `worker.ts` (spawn `omp -p --mode json`, model fallback chain), `verify.ts` (gate chains, preflight), `config.ts` (`.omp/roadmap.yml`).
- **Resilience lanes:** `debug.ts` (bounded fix session, 30 m default via `debugTimeoutSec`), `harnessFix.ts` (`headFileSet` + `applyHarnessFix`), `review.ts` + `reviewLane.ts` (independent audit, minor/major grading, fix lane), `services.ts` (bring-up + readiness poll + heal), `placeholders.ts` (dev-only credential injection + `placeholders.md`), `unblock.ts` (end-of-run self-unblock, `maxUnblocks: 2`), `faults.ts` (chaos drills), `recovery.ts`/`revalidate.ts` (crash resume, truth-check audit).
- **Concurrency:** `worktree.ts` (git worktree per slice on `ompo/<runId>/<sliceId>`, `node_modules` + `.env` symlinked, merge via commit mutex), `mutex.ts` (verify+merge serialization), `control.ts` (live intents as log events), `replan.ts` (fingerprint merge for edited roadmaps).
- **TUIs:** `watch.tsx` (55 KB, read-only board + tabbed inspector), `run.tsx` (live loop), `unified.tsx` (plan→run→done). Shared testability exports: `layoutRects`, `dagIndent`, `forensicsLayout`.
- **Operability/observability:** `doctor.ts` (`ompo doctor`), `forensics.ts` (`show/diff/shell/logs/worktrees`), `checklist.ts` (`checklist/fill` over `deferred.md` + `placeholders.md`), `stats.ts` (`stats/query/export/replay`), `log.ts` (event labels), `ci.ts` (`--format tap|github|json`), `runReports.ts`, `lint.ts` (`ompo lint`), `planPreview.ts` (`ompo plan`), `secrets.ts` (pre-merge scan), `tmux.ts` (`--tmux` panes), `handoffs.ts`, `import.ts` (foreign-roadmap adopt + planner).
- **Roadmap format** (`README.md` §Roadmap format): `## [id]` sections with `Depends:` / `Agent:` / `Effort: lo|med|hi` / `Verify:` (repeatable, `&&` splits into separately-reported fail-fast steps unless quoted) / `Files:` (advisory allowlist) / `Retries:` (default 1) / `Timeout:` (`1m..8h`, default `15m`, split past `60m`) / `Skip:`.

## 5. Architecture invariants

1. **Core, not extension.** The loop owns `AbortController`/SIGINT, writes outside the transcript, runs headless (`-p`, CI). Shape mirrors the `Cleanse` command; registration in `src/cli-commands.ts` equivalent is `src/cli.ts`. Project-local customization comes from `.omp/` settings (the extension *surface*), never engine forks.
2. **Fresh workers, durable orchestrator.** Workers are one-shot `omp -p` processes (no mid-run model swap, no transcript carry). All memory lives in the store (§6), never in process state.
3. **Import DAG is load-bearing:** `attempt ← {reviewLane, runReports, secrets} ← loop` (sprint-4 extraction). Keep `loop.ts` thin; put stage logic in the lane module, pure helpers beside it.
4. **Verify + merge serialize** on one commit mutex (shared DB/port lock and integration order). A slice is `done` only after its `--no-ff` merge lands. Reviews run **outside** the mutex (read-only) — only approval of `done` serializes.
5. **Worker report is a claim, never trusted.** Post-merge fresh review session (own model/context, no worker transcript) re-checks files/behavior on the merged tree and re-runs the load-bearing gate. `minor` = one bounded fix + re-verify + re-merge + one re-review in-attempt, no retry spent. `major` (default when in doubt) spends budget.
6. **Failure pipeline order is fixed:** gate fail → env triage (infra signatures → `blocked-env`, no retry) → placeholder injection (missing named creds → dev placeholder + note, no retry) → debugger session (one per attempt, never recursive, no retry) → harness-fix rail check (≤40-line diff, base-only files, HEAD-exists, base-clean; apply to worktree + base, re-verify) → retry-or-terminal. `--no-debug` / `--no-placeholders` / `--no-unblock` skip their stage.
7. **Never-block rule:** missing live value (secret/token/account/DNS/approval) must never produce `done=false`. Worker implements everything implementable, verifies with deterministic placeholders/stubs (placeholders only in gitignored env files, never tracked source), lists items in `deferred[]`. Reviewer treats deferred as pre-approved exclusions but still rejects real-looking secrets in tracked files.
8. **Model fallback never stops on 429:** worker/reviewer/debugger walk `workerModel` (or slice/review override) → `modelFallbacks` → omp default. Skip only when spawn fails *as that model* with zero report output. Genuine work failures/timeouts stop the chain. Skips cost no retry; `worker-<n>.models.json` records the chain. Default: `muse-spark-1.3-contributor → mimo-v2.5 → muse-spark-free (zen) → deepseek-v4-flash-free (zen) → omp default`.

## 6. Durable store (plan §13)

Layout — all forensics/CLI read this, no format change without migrating every reader:

```
.omp/roadmap/runs/<runId>/
  roadmap.json        # materialized cursor (atomic tmp+rename writes)
  events.jsonl        # append-only audit + replay source
  slices/<id>/report.json | verdict.json | review.json | worker-<n>.log |
    worker-<n>.events.jsonl | debug-<n>.log | prompt-<n>.md | review-notes.md |
    review-fix-<n>.log | review-minor-<n>.applied | control-park.md | secret-scan-<n>.json | logs/
```

Rules:

- Mutations are **sync read-modify-write** (`storeApi.claimSlice`, `workerFinished`, `verifyPassed`, `operatorRetry`, `skipSlice`, `parkSlice`, `killSlice`, `saveRunDoc`).
- Every mutation appends an event (`run_started`, `slice_skipped`, `slice_killed`, `control_requested/ok/no`, …). New event types **require** a `log.ts` label + replay case (`rebuildStatusesFromEvents`), or `ompo replay`/`resume` diverge.
- Writes are atomic (`writeJsonAtomic`: tmp + rename). Lock file `<runId>.lock`; second `run` exits 3.
- Crash model: `Ctrl-C`/`kill -INT` finishes the in-flight store write, marks slice `aborted`, exits 2. `kill -9`/crash replays from `events.jsonl`; `running|verifying|aborted` demote to `pending` with `attempts` preserved; `done` never re-runs.
- `resume` refuses on `sourceHash` mismatch (roadmap edited mid-run) — adopt via `ompo replan --run ID` first. `replan` keeps `done` + attempts/refs for unchanged slices, resets changed/new to `pending`, drops removed ids (artifacts stay), refuses live runs (exit 3) and changed in-flight slices.
- Exit codes: `0` all done · `1` failures remain · `2` aborted · `3` resume-conflict/lock.

## 7. Development lifecycle (the actual loop used here)

Sprints land as **narrow workstreams** (sprint 4: four items — secret scan, loop extraction, planner preview, TUI hardening), never feature buffets. Each sprint:

1. **Handoff in.** Read `.omp/handoff-sprintN.md` (where things stand, trade-offs marked do-not-fix-unasked, working notes) and `HARP-*.md` if the work has one. HARP-1 is the template: goal, background with file:line proof, constants/functions/tests ready to implement, acceptance (`bun test` + `tsc` + `git diff --check` + live repro), out-of-scope, command reference.
2. **Survey before editing.** Read the owning module + its test mirror fully (sections, not snippets). Reuse existing patterns; a second convention beside an existing one is prohibited. `resolveInitPlan`/`runImport` for init flows, `runRoadmapLoop` for execution, `storeApi` for state, `splitGateChain` for gates.
3. **Implement small, migrate fully.** Clean cutover: every caller migrated, obsolete code/comments/aliases removed. Prefer updating the existing file over adding one. `loop.ts` extractions go to the lane module with the import DAG preserved. No shims, no deprecated paths, no `TODO: implement` left behind.
4. **Prove it.** `bunx tsc --noEmit && bun test`. Regenerate captures after TUI changes (`bun scripts/gen-captures.ts`). Live `ompo run` spawns real model workers — prefer mocked runners + `createRun` fixtures for verification; reserve live runs for the acceptance repro named in the HARP.
5. **Hand off out.** Update/create `.omp/handoff-sprintN+1.md`: HEAD, health line (`bun test X pass / Y fail (N files) · tsc clean`), what landed (files + line counts + behavior), trade-offs/follow-ups explicitly marked do-not-fix, working notes (tool gotchas, fixture-key constraints). Ratings live in `.omp/ratings/` (baseline + re-rate protocol) — re-rate only when the user considers the slate done.
6. **Commit.** Style `feat:` / `fix:` / `polish:` subjects, body explains why. **Never attribute tooling** (no `Generated with…`, no `Co-Authored-By`). Binary, `node_modules/`, `.omp/`, `*.log` never committed (`.gitignore`).

## 8. Testing strategy

- **Runner:** `bun test` only. No other harness. Test files mirror `src/` (`tests/<area>.test.ts`); `tests/loop.test.ts` (37 KB) is the integration pattern: tmp project + mock runners + `reviewAware` fixtures.
- **Fixtures:** `mkdtempSync(join(tmpdir(), "ompo-<area>-"))` tmp projects, inline `MD` roadmaps (`## [a] A…`), `parseRoadmap` → `createRun` → `storeApi.*` → assert cursor + `readEvents` seq (`seq` must equal `1..n`; every prefix must replay consistently — see `tests/store.test.ts` crash-replay test).
- **Style rules (enforced in review):** no `any` (use `WorkerRunner`/domain types); no tautology placeholders (`expect(readFileSync).toBeDefined()` is a smell, not a test); no source-text assertions (assert observable behavior — statuses, verdict tails, files on disk, gate re-runs — not code strings); fixture secrets must satisfy exact patterns (e.g. AWS `AKIA` + 16 chars) and avoid denylist substrings (`123456789`, `EXAMPLE`, `FAKE`…).
- **What earns a test:** behavior, boundaries, invariants, transitions, precedence, real errors. Pure functions get unit tests (`validateHarnessFix`, `splitGateChain`, `mergeRoadmap`, `rebuildStatusesFromEvents`). Store transitions get round-trip + replay tests. Loop lanes get mocked-runner integration (env-park without retry, debug-once-per-attempt, harness-fix apply + re-verify, minor-lane single re-review, secret-scan refusal path).
- **What to delete, not fix:** tests pinning wording, incidental defaults, or implementation (field copies, forwarding, mock echoes). If a change breaks such a test, delete it; never re-pin to the new text.
- **TUI tests** (`tests/tui-structure.test.ts`, 28 tests): geometry invariants over real exports (`layoutRects`, `dagIndent`, `forensicsLayout`), fixture compositions for 14/20 scenarios. Visual quality is **not** asserted — `captures/*.txt` + `scripts/gen-captures.ts` carry that; regenerate after layout math changes. Narrow `<24 cols` keeps the 24-col board floor (asserted, terminal clips) — do not "fix" with virtualization unasked.
- **Chaos drills** (manual, CLI-only): `ompo run --fault-inject fail-verify=s2,crash-after=3 --seed 7` then `kill -INT <pid>; ompo resume`. Same seed replays abort draws (`jobs 1` for exact replay). Fresh chaos run ids gain `-sN`.

## 9. Coding standards

- Strict TS, no `any`, no unused locals left behind (`tsc --noEmit` is the gate).
- Sync `node:fs`/`spawnSync` for store + git paths (deterministic ordering beats throughput here). Never add async wrappers around the store.
- One `Verify:` line may chain with `&&` — split quote-aware (`splitGateChain`), report each step, fail-fast like a shell. `||` never splits (lint error). Timeouts `>60m` are lint errors; heavy retries are lint errors; skips with dependents are lint errors.
- Secret scan (`src/secrets.ts`): 12 high-confidence classes only + benign denylist. Findings refuse the merge through the normal retry path (`secret_found`, redacted `file:line (kind)`); scanner breakage refuses too (`secret_scan_error`), never counts as clean. Exotic/obfuscated formats are the reviewer's job, not the scanner's.
- Control plane: intents (`retry/skip/park/kill/jobs/pause/resume`) travel as `control_requested` events; the loop drains within ~2 s (`controlPollMs`, default 2000) at safe points only (between claims, attempt stage boundaries — never mid-mutation). TUI keys (`R/S/B/K/+/-/P`) and `ompo ctl` share the path; stale intents reject via status guards, never double-run.
- TUI edits: rewire panes to the shared helpers (`layoutRects`, `forensicsLayout`, `DagChip`), keep identical math; mirror keymaps across watch/run/unified. `watch` stays read-only.
- Docs: user-facing behavior goes in `README.md` (the manual). Process goes here. One-line cross-links, no duplication.

## 10. Operability (build it operable or do not ship it)

Every feature ships with its operator surface or it is not done:

- Pre-run: `ompo doctor` (omp, models, tmux, git, tree, gates, disk, config — exit 1 on any FAIL), `ompo config --explain`, `ompo plan` / `lint` / `run --dry-run` / `run --check-env`.
- Live: `watch` board + inspector (Output/Diff/Verify/Review/Prompt/Events, keys `1–6`), forensics fullscreen (`Enter`/`Esc`, `y` yanks path), failure nav (`n/p`, `F` filter), `?` help, DAG board (`g`), `--tmux` per-worker panes, headless `[id]`-prefixed streaming + heartbeat.
- After: `show/diff/shell/logs/retry/skip/worktrees`, `checklist/fill`, `stats/query/export/replay/log`, CI formats (`--format tap|github|json`, progress bar on stderr, `$GITHUB_STEP_SUMMARY`).
- Crash/stall: `resume`, `replan`, `revalidate` (proposal-only `ROADMAP.revalidate.md`, adoption stays human via `replan`).

## 11. Release

- Bump `package.json:version`, keep CLI single-source (`import pkg from "../package.json"`).
- Verify: `bun install && bunx tsc --noEmit && bun test && git diff --check`.
- Build: `bun build --compile src/cli.ts --outfile ompo`. Ship the binary out-of-band; never commit it.

## 12. Risks / known trade-offs (accepted, do not relitigate without a HARP)

- Sequential denylist can mute a real token containing a sequential run — accepted (miss preferred over merge-blocking FP).
- Non-git + no attributable files = scan-clean by definition (no boundary to guard); git-present tool failures are never clean.
- Replan resets on any spec-field change (even `Effort:`) — strict by design.
- `crash-after` ordering with `--jobs N>1` is approximate; exact replay needs `jobs 1`.
- Unified flow has no seed/faults passthrough (CLI-run scoped).
- No `VerifyRetries:` separate from worker retries (deliberately deferred).
- No `fs.watch` incremental reads (900 ms full re-read stands), no `ompo serve` web mirror, no per-slice PRs / cost table / Gantt (see sprint-3 menu for the deferred list).
