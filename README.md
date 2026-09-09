# ompo — OMP Roadmap Orchestrator

Long-horizon sequential workflow driver for **stock `omp`** (no core fork).
Implements `OMP_ROADMAP_ORCHESTRATOR_PLAN.md` §§5–6, 11–14 out-of-core:
each slice runs as a fresh `omp -p` worker (clean context by construction),
with a durable store, verifier gates, retries, and crash resume.

## Use in every new project

```bash
cd <project>
ompo                 # local dashboard: web UI + API on 127.0.0.1 (auto port)
ompo --tui           # unified TUI: plan (if needed) → run → done
# …or step by step:
ompo init            # planner session surveys docs → ROADMAP.md (+ .omp/roadmap.yml)
# review ROADMAP.md — one ## [id] section per slice (--template for blank, --replan to redo)
ompo plan             # preview: slices, gates, deps + lint (exit 1 when blocked)
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
- **Minor lane**: rejections graded `minor` (right shape, needs polish — lint,
  naming, a missing edge test) earn one bounded fix session + gate re-run +
  re-merge + exactly one re-review inside the same attempt, no retry spent.
  `major` (wrong behavior, weakened tests, unrelated diffs) spends budget
  like any other failure. When in doubt reviewers grade major.
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
  model: opencode-go/muse-spark-1.3-contributor worktree: .omp/worktrees/<run>/02-feature budget: 15m
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

   Declare shared services and the loop heals itself instead of parking.
   `.omp/roadmap.yml` (all optional):
   `serviceUp` (idempotent bring-up, e.g. `docker compose up -d db`),
   `serviceReady` (readiness probes, e.g. `pg_isready -h localhost -p 5432`),
   `serviceEnv` (extra env for worker + gates, e.g. `DATABASE_URL`),
   `serviceTimeoutSec` (ready-poll budget, default 120). On a healable block
   (DB/port/host — never disk-full or creds) the loop runs bring-up, polls
   readiness, and re-runs the gate once in the same attempt — no retry
   consumed. Workers use the provided env as-is and never start a disposable
   database on another port. Heal failure falls through to the park path above.

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

## End-of-run unblock: the loop unblocks itself before giving up

When the loop is about to stop with pre-deployment slices still blocked
(`blocked-env`, or terminal `failed`), it spends one bounded fresh agent
sessions doing the operator's `resume` job — diagnose the block at host +
worktree level, fix it persistently, and re-run the blocking commands green
in a fresh shell itself. The loop then re-runs each recorded failing command
in its worktree and only re-queues recheck-green slices (failed slices get
exactly one extra attempt, attempts keep counting). Deploy slices are never
targets; claims without a green recheck end the run as before, and `ompo
resume` still works afterwards.

Bounds: `maxUnblocks: 2` (`.omp/roadmap.yml`, `0` disables) or per run
`--max-unblocks N` (0..5) / `--no-unblock`. Budget spent? The run ends with
`unblock budget spent (N round(s))` and the usual resume hint.
   Opt out with `placeholders: false` (`.omp/roadmap.yml`) or `--no-placeholders`.

2. **Debugger session** — for genuine failures, one bounded fresh worker
   (same worktree, default 10m budget via `debugTimeoutSec`, `[id debug]`
   log prefix) diagnoses and fixes only the failure, re-running the failing
   command itself. If it reports `done`, the gate re-runs; anything else
   falls through to the normal retry-or-terminal path. One debug per
   attempt, never recursive, never consumes a retry.
   Artifacts: `debug-prompt-<n>.md`, `debug-<n>.log`, `debug-<n>.events.jsonl`.

`ompo run --no-debug` skips stage 2 (straight to retry budget).

## Never-block rule: live values defer, the roadmap never stops

Standing worker contract (in every slice prompt, overrides slice wording):
a missing live value — secret/token/key, account action, phone step,
DNS/domain, external approval or publish — must **never** produce
`done=false`. The worker implements everything implementable, verifies
with deterministic placeholders or stubs (placeholders only in gitignored
env files, never in tracked source), reports `done=true`, and lists each
live-only item in its report's `deferred` array as
`<what> — needs <value>; manual check: <how>`. `done=false` is reserved
for genuinely broken code. The reviewer treats deferred items as
pre-approved exclusions (but still rejects a real-looking secret committed
to a tracked file).

At run end ompo aggregates every done slice's deferred list into one
checklist for your post-run manual pass:
```
deferred: 3 live check(s) across 2 slice(s) (see .omp/roadmap/runs/<runId>/deferred.md)
```
Future roadmaps need no manual deferral sections — write the slice as if
live values exist; the worker defers what it cannot prove.

## Model matrix (plan §10, zero resolver code)

| Role         | Where            | Default                          |
|--------------|------------------|----------------------------------|
| Orchestrator | your `omp` shell | your configured default model    |
| Worker       | `.omp/roadmap.yml `workerModel`` | `opencode-go/muse-spark-1.3-contributor` (paid pool) |
| Reviewer     | `.omp/roadmap.yml `reviewModel`` | `workerModel` (same matrix)      |
| Hard slice   | `Agent:` trailer + `agentModels:` map | per-slice override |

A slice `Agent:` that already looks like a model pattern (`a/b`, `x:y`)
passes straight through to `omp --model`. Prewalk stays off: workers are
one-shot `omp -p` processes, so no mid-run model swap is possible.

## Model fallback chain (never stops on 429)

Every spawn — worker, reviewer, debugger — walks an ordered chain within the
same attempt: `workerModel` (or the slice/review override), then each
`modelFallbacks` entry, then omp's configured default model as the last
resort. A model is skipped only when the spawn fails *as that model* (rate
limit / free-tier exhaustion / unknown id, read off the `--mode json`
events) **and** produced no report block. Genuine work failures and timeouts
stop the chain immediately — no fallback burns on broken code. Skipped
models cost no retry and preserve partial work to the slice branch
(`worker-<n>.models.json` records which models were tried).

Default chain (also stamped into new projects by `init`/`import`):
`opencode-go/muse-spark-1.3-contributor` → `opencode-go/mimo-v2.5` →
`muse-spark-1.3-contributor-free` (zen) → `deepseek-v4-flash-free` (zen) →
omp default. Tune via `modelFallbacks:` (dedupe is automatic).

## Live control plane (TUI keys + `ompo ctl`)

Intents travel as events on the run's own log, so TUI keys and a second
shell share one path: the loop drains them within ~2s at safe points
(between claims, at attempt stage boundaries — never mid-mutation).
Applied and rejected intents land in `ompo log` as `control ok/no`.

```bash
ompo ctl retry --slice s2 --run 20260908-ab12cd   # one more attempt (failed/blocked-env only)
ompo ctl skip --slice s9 --run 20260908-ab12cd    # quiescent slices leave the roadmap
ompo ctl park --slice s3 --run 20260908-ab12cd --reason "db down, ETA 10m"
ompo ctl kill --slice s4 --run 20260908-ab12cd    # in-flight drops at the next boundary, work preserved
ompo ctl jobs --jobs 4 --run 20260908-ab12cd      # scale the claim loop live (needs a live loop)
ompo ctl pause --run 20260908-ab12cd              # in-flight finishes, nothing new claims
ompo ctl resume --run 20260908-ab12cd
```

TUI twins (run + unified TUIs): `R` retry · `S` skip · `B` park · `K` kill ·
`+`/`-` jobs · `P` pause/resume. Against a quiescent run `ctl` applies
slice intents immediately; `jobs`/`pause`/`resume` need a live loop.
Stale intents reject instead of double-running (status guards).

## Replan an edited roadmap (`ompo replan`)

```bash
ompo replan --run 20260908-ab12cd   # adopt ROADMAP.md edits into a quiescent run
ompo resume --run 20260908-ab12cd
```

Unchanged slices keep status, attempts, and refs — `done` is never re-run.
Changed/new slices reset to `pending` (attempts preserved, refs cleared).
Removed ids drop (artifacts stay on disk). Refuses live runs (exit 3) and
runs whose in-flight slices changed spec — finish, kill, or revert those
sections first.

## Revalidate a distrusted map (`ompo revalidate`)

Resume trusts structure (drift → replan, lost merges → demote) but never
judges whether the map describes reality. After a crashy stretch, an
explicit agent audit proposes a revised map from run evidence + tree:

```bash
ompo revalidate --run 20260908-ab12cd   # → ROADMAP.revalidate.md (proposal only)
diff ROADMAP.md ROADMAP.revalidate.md    # review
cp ROADMAP.revalidate.md ROADMAP.md && ompo plan && ompo replan --run 20260908-ab12cd
```

Blocked proposals are never presented (same lint gate as the preview).
The worker never writes ROADMAP.md — adoption stays human, via replan.

## Planner preview (`ompo plan`, unified gate)

Execution is more mature than planning, so the plan shows itself before
spending model calls. `ompo plan` prints slice ids/titles, Effort, gate
counts, Depends, and the same lint findings `ompo lint` reports — exit 1
when blocking errors (unknown deps, cycles, missing gates) exist. No
forecasts: no ETA, cost, or success estimates, only computable structure.

The unified TUI (`ompo`) gates on the same preview: `y` accepts, `e`
reloads ROADMAP.md from disk after you edit it elsewhere, `q` aborts.
Blocked plans cannot be accepted — fix the roadmap and reload.

## Gates: chains, preflight, lint

- One `Verify:` line may chain gates with `&&` — each runs as a separately
  reported step and the chain fail-fasts like a shell. Quote to keep one
  gate: `Verify: sh -c 'cd e2e && bunx playwright test'` (quoted `&&`
  never splits; split gates each run in their own shell, so keep
  state-sharing chains quoted). `||` never splits.
- `ompo run --check-env` probes every unique gate once against the base
  tree before spawning: infrastructure blocks fail fast with a fix hint
- `ompo lint` validates the roadmap statically (exit 1 on errors):
  vacuous gates, state-only split gates, `||` fallbacks, >60m timeouts,
  heavy retries, unknown agents, skips with dependents. `run --dry-run`
  prints the same findings alongside the dependency order.
- Pre-merge secret scan: after verify passes and before the branch merges,
  a deterministic scanner sweeps the slice's merge candidates (branch delta
  + uncommitted worktree files; declared/reported files on non-git projects).
  High-confidence classes only — AWS keys, GitHub/Slack/Stripe/OpenAI/Google
  tokens, PEM private-key blocks, named-secret assignments. Findings refuse
  the merge through the normal retry path (`secret_found`, redacted
  `file:line (kind)` in `secret-scan-<n>.json` + verdict tail — values never
  printed). Scanner breakage refuses too (`secret_scan_error`), never counts
  as clean. This is a backstop, not complete protection: exotic formats and
  obfuscated secrets still rely on the reviewer's judgment.

## Chaos drills (`--fault-inject`, `--seed`)

CLI-only (never config — a roadmap file can't smuggle chaos into a real
run). `fail-verify=` injects red gates, `abort-attempt=` draws seeded
aborts, `crash-after=` dies 137 mid-run so `resume` proves recovery:

```bash
ompo run --fault-inject fail-verify=s2,crash-after=3 --seed 7
kill -INT <pid>; ompo resume   # the honest version of the same drill
```

Same seed replays the same abort draws (`jobs 1` for exact replay).
FRESH run ids gain a `-sN` suffix so chaos runs correlate in `ompo list`.

## Slice forensics (`show/diff/shell/logs/retry/skip/worktrees`)

The inspector tabs, for scripts — all read the existing
`.omp/roadmap/runs/<run>/slices/<id>/` layout, no format change:

```bash
ompo show s2        # report, verdict gates, review, prompt tail, model chain, timing
ompo diff s2        # slice branch vs merge-base (stat + hunks; "in-place run, no branch" otherwise)
ompo shell s2       # $SHELL with cwd=slice worktree (project dir when in-place)
ompo logs s2 --tail 100 --follow
ompo retry s2 --reason "flaky gate"   # quiescent: applies now; live: queued like ctl
ompo skip s9 --reason "deferred"      # downstream proceeds past skips
ompo worktrees prune                  # git worktree prune + drop dirs for terminal/unknown runs
```

## Post-run checklist (`checklist/fill`)

`deferred.md` + `placeholders.md` already aggregate at run end; these make
them actionable:

```bash
ompo checklist              # merged what — needs value; manual check, with file refs
ompo checklist --json       # same list for scripts
ompo fill --var SEED_ADMIN_PASSWORD=real --var PORT=4000
                            # re-run gates of slices mentioning those vars (never writes the store)
```

## Operability (`doctor/config`)

```bash
ompo doctor                 # omp, models, tmux, git, tree, gates, disk, config — exit 1 on any FAIL
ompo config --explain       # resolved .omp/roadmap.yml + per-slice effective models
```

## Observability (`stats/query/export/replay/log`)

```bash
ompo stats                  # pass rate, mean turns/tools/duration, per-Effort, top failing gates, fallbacks
ompo query "failed where attempts>1"      # tiny DSL: all|<type-substr>|slice ID [where <field><op><value> ...]
ompo query "slice s2 where exit!=0" --json
ompo export --html --out report.html      # self-contained run report (stdout without --out)
ompo replay                 # rebuild statuses from events.jsonl, diff vs cursor
ompo log --format tap       # pretty|json|tap|github (also: ompo run --format github in CI)
```

CI: `ompo run --format tap|github|json` streams loop chatter to stderr
with a progress bar (`████░░░░ 4/12`) so stdout stays parseable, then
prints the formatted event stream plus `deferred.md`/`placeholders.md`
as the job summary (`$GITHUB_STEP_SUMMARY` appended when set).

- **Interrupt**: `Ctrl-C` (or `kill -INT`) finishes the in-flight store write,
  marks the slice `aborted`, exits `2`. Resume with `ompo resume` — `done`
  slices are never re-run; `running|verifying|aborted` demote to `pending`
  with `attempts` preserved.
- **Kill -9 / crash**: same as interrupt; `ompo resume` rebuilds from
  `.omp/roadmap/runs/<runId>/events.jsonl`.
- **Blocked environment**: slices parked as `blocked-env` (port taken, DB
  down, deploy gate awaiting real values) re-queue on `ompo resume` after
  you fix the environment / export real values.
- **Roadmap edited mid-run**: resume refuses on `sourceHash` mismatch —
  adopt with `ompo replan --run ID`, then resume.
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
Verify: bun lint && echo lint-ok   # && splits into separately-reported gates (fail-fast);
                       # quote to keep one shell: sh -c 'cd e2e && test e2e'
Files: src/a.ts        # advisory allowlist
Retries: 2             # default 1 (total tries = retries+1)
Timeout: 60m           # worker budget, 1m..8h (default 15m); split instead past 60m
Skip: true             # optional

## Layout (durable store, plan §13)
```
.omp/roadmap/runs/<runId>/
  roadmap.json        # materialized cursor (atomic tmp+rename writes)
  events.jsonl        # append-only audit + replay source (claims, gates, controls, replans)
  slices/<id>/report.json | verdict.json | review.json | worker-<n>.log |
    worker-<n>.events.jsonl | debug-<n>.log | prompt-<n>.md | review-notes.md |
    review-fix-<n>.log | review-minor-<n>.applied | control-park.md | logs/
```

## Dev

```bash
bun install
bun test              # unit/integration tests (mocked workers)
bunx tsc --noEmit
```
