# ompo — OMP Roadmap Orchestrator

Long-horizon sequential workflow driver for **stock `omp`** (no core fork).
Implements `OMP_ROADMAP_ORCHESTRATOR_PLAN.md` §§5–6, 11–14 out-of-core:
each slice runs as a fresh `omp -p` worker (clean context by construction),
with a durable store, verifier gates, retries, and crash resume.

## Use in every new project

```bash
cd <project>
ompo                 # unified TUI: plan (if needed) → run → done
# …or step by step:
ompo init            # planner session surveys docs → ROADMAP.md (+ .omp/roadmap.yml)
# review ROADMAP.md — one ## [id] section per slice (--template for blank, --replan to redo)
ompo run --dry-run   # parse + dependency order, spawns nothing
ompo run             # live TUI: board + inspector + scrollable log panel (PgUp/PgDn)
ompo status          # read-only progress dump
```

## Adopt a foreign roadmap (any template, mid-progress)

```bash
cd <project>
ompo import --from ROADMAP-GENERAL.md --done S0 --active S1
# agentic worker reads the foreign file + git log / qa reports / working tree,
# emits strict ROADMAP.md: done slices get Skip: true, the active slice body
# is narrowed to its remainder, futures keep serial Depends: + Verify:
ompo run --dry-run   # confirm order, then ompo run
```

## Parallel slices (`--jobs N`)

```bash
ompo run --jobs 4   # up to 4 slices concurrently (default 1)
```

- Independent slices (deps already done) each get a git worktree on branch
  `ompo/<runId>/<sliceId>` under `.omp/`; workers run with cwd = worktree.
  `node_modules` + `.env` are symlinked in, never committed.
- Verify + merge serialize on one commit mutex (shared DB/port lock and
  integration order). A slice is `done` only after its `--no-ff` merge lands.
- Merge conflict → slice fails terminal, worktree + branch kept for forensics.
- Non-git projects fall back to in-place execution (no isolation).

## Independent review gate

Every slice pays for a second pair of eyes before it is marked `done`: after
verify + merge, a **fresh review session** (its own omp worker, its own model
and context — no worker transcript attached) audits the slice against the
merged tree. It reads the spec, checks each claimed file and behavior on disk,
re-runs the load-bearing gate command itself, and looks for what a worker
would hide (weakened tests, unrelated diffs, missing error paths). The
worker's report is a *claim* the reviewer verifies, never trusted.

- Reviewer model: `.omp/roadmap.yml` `reviewModel` (defaults to `workerModel`)
  or `--review-model M` per run.
- Approve → slice `done`. Reject → findings land in `slices/<id>/review-notes.md`
  and head the *next* attempt's spec ("PRIOR REVIEW REJECTION — address these
  FIRST"), same retry budget as any other failure.
- Runs **outside** the commit mutex — reviews only read and spot-check, so
  they overlap other pipelines' work; only approval of `done` serializes.
- `ompo run --no-review` skips the gate (debugging, or runs that prefer
  speed over the extra model call).
- In `--tmux` mode each review gets its own pane titled `ompo <id> review`.

## Watch it live (`--tmux`, inside a tmux client)

```bash
ompo run --jobs 3 --tmux
# orchestrator keeps your pane (titled ompo run <runId>); every worker gets
# its own tiled pane running the full interactive omp TUI. Completion is read
# from the session file, so panes show everything with no screen-scraping.
# Panes die with their workers; slice logs keep the full record.
# Timeout/abort commits in-flight work to the slice branch, and retries
# resume the prior session (`--resume`) — attempts compound instead of restarting blind.
```

## Headless progress logs (default `ompo run`)

Headless workers run `omp -p --mode json`, so every agent step streams to
your console as it happens — no waiting blind until exit:

```
▸ slice 02-feature — First feature (attempt 1)
  model: muse-spark-1.3-contributor-free worktree: .omp/worktrees/<run>/02-feature budget: 15m
  [02-feature] turn 1…
  [02-feature] tool read: src/index.ts
  [02-feature] tool bash: bun test
  [02-feature] says: wiring up the handler now
  [02-feature] verify: $ bun test
  [02-feature] verify ok: bun test (4.2s)
  worker exited in 96s (3 turns, 8 tools)
```

Each line is prefixed with the slice id (`[id review]` for the audit
session, `[id verify]` for gate commands), so `--jobs N` streams stay
attributable. The heartbeat for long slices now includes the same detail
(`… <id> still running (3m elapsed, 4 turns, 12 tools, last: …)`).
Full forensics per attempt: `worker-<n>.log` (assistant text) plus
`worker-<n>.events.jsonl` (raw agent events).

## When the gate fails: env triage + debugger

A failing gate goes through two deterministic stages before the retry
budget is touched:

1. **Environment triage** — verifier output is scanned for infrastructure
   signatures (port already in use, database unreachable/missing,
   unresolvable host, disk full). On a match the slice parks as
   `blocked-env` with **no retry consumed** and a fix hint:
   ```
   — slice s2b-company-ui: environment blocked: port 3000 already in use (no retry consumed)
     fix: free the port (e.g. stop the holder) or move the gate's server port, then `ompo resume`
   ```
   `ompo resume` re-queues blocked slices once you've fixed the environment.
   This is what saves a dead Postgres or a squatted port from terminal-failing
   correct code.

   Missing **named credentials/URLs** (e.g. `SEED_ADMIN_PASSWORD must be set`)
   take a different path: ompo injects a deterministic dev-only placeholder,
   notes it in `.omp/roadmap/runs/<runId>/placeholders.md`, and re-runs the
   gate — no retry consumed, roadmap keeps moving. Deploy slices inject
   placeholders like any other slice; you fill the real values later, before
   the release goes live. At run end ompo prints the swap report:
   ```
   placeholders: 1 dev-only value(s) — SEED_ADMIN_PASSWORD (see .omp/roadmap/runs/<runId>/placeholders.md)
   only deployment slice(s) left (deploy) — swap real values, exercise the UI/UX, then deploy
   ```
   Opt out with `placeholders: false` (`.omp/roadmap.yml`) or `--no-placeholders`.

2. **Debugger session** — for genuine failures, one bounded fresh worker
   (same worktree, default 10m budget via `debugTimeoutSec`, `[id debug]`
   log prefix) diagnoses and fixes only the failure, re-running the failing
   command itself. If it reports `done`, the gate re-runs; anything else
   falls through to the normal retry-or-terminal path. One debug per
   attempt, never recursive, never consumes a retry.
   Artifacts: `debug-prompt-<n>.md`, `debug-<n>.log`, `debug-<n>.events.jsonl`.

`ompo run --no-debug` skips stage 2 (straight to retry budget).

## Model matrix (plan §10, zero resolver code)

| Role         | Where            | Default                          |
|--------------|------------------|----------------------------------|
| Orchestrator | your `omp` shell | your configured default model    |
| Worker       | `.omp/roadmap.yml `workerModel`` | `muse-spark-1.3-contributor-free` (free tier) |
| Reviewer     | `.omp/roadmap.yml `reviewModel`` | `workerModel` (same matrix)      |
| Hard slice   | `Agent:` trailer + `agentModels:` map | per-slice override |

A slice `Agent:` that already looks like a model pattern (`a/b`, `x:y`)
passes straight through to `omp --model`. Prewalk stays off: workers are
one-shot `omp -p` processes, so no mid-run model swap is possible.

## Recovery runbook (plan §14)

- **Interrupt**: `Ctrl-C` (or `kill -INT`) finishes the in-flight store write,
  marks the slice `aborted`, exits `2`. Resume with `ompo resume` — `done`
  slices are never re-run; `running|verifying|aborted` demote to `pending`
  with `attempts` preserved.
- **Kill -9 / crash**: same as interrupt; `ompo resume` rebuilds from
  `.omp/roadmap/runs/<runId>/events.jsonl`.
- **Blocked environment**: slices parked as `blocked-env` (port taken, DB
  down, deploy gate awaiting real values) re-queue on `ompo resume` after
  you fix the environment / export real values.
- **Roadmap edited mid-run**: resume refuses on `sourceHash` mismatch.
  Finish the run first, then start a new one.
- **Lock held (exit 3)**: another `ompo run` owns the run. Wait or remove
  `.omp/roadmap/runs/<runId>.lock` only if the owner is dead.
- **Exit codes**: `0` all done · `1` failures remain · `2` aborted ·
  `3` resume-conflict.

## Roadmap format

```markdown
## [slice-id] Human title
Body (what the worker must do).
Depends: other-id
Agent: task            # optional: agentModels key or model pattern
Effort: med            # lo|med|hi (advisory)
Verify: bun test       # repeatable; run after the worker, exit 0 required
Files: src/a.ts        # advisory allowlist
Retries: 2             # default 1 (total tries = retries+1)
Timeout: 60m           # worker budget, 1m..8h (default 15m); split instead past 60m
Skip: true             # optional
```

## Layout (durable store, plan §13)

```
.omp/roadmap/runs/<runId>/
  roadmap.json        # materialized cursor (atomic tmp+rename writes)
  events.jsonl        # append-only audit + replay source
  slices/<id>/report.json | verdict.json | review.json | worker-<n>.log |
    worker-<n>.events.jsonl | debug-<n>.log | prompt-<n>.md | review-notes.md | logs/
```

## Dev

```bash
bun install
bun test              # 100 unit/integration tests (mocked workers)
bunx tsc --noEmit
```
