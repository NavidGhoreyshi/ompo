# ompo — OMP Roadmap Orchestrator

Long-horizon sequential workflow driver for **stock `omp`** (no core fork).
Implements `OMP_ROADMAP_ORCHESTRATOR_PLAN.md` §§5–6, 11–14 out-of-core:
each slice runs as a fresh `omp -p` worker (clean context by construction),
with a durable store, verifier gates, retries, and crash resume.

## Use in every new project

```bash
cd <project>
ompo init            # scaffold ROADMAP.md + .omp/roadmap.yml
# edit ROADMAP.md — one ## [id] section per slice
ompo run --dry-run   # parse + dependency order, spawns nothing
ompo run             # execute headlessly, slice by slice
ompo status          # read-only progress dump
```

## Model matrix (plan §10, zero resolver code)

| Role         | Where            | Default                          |
|--------------|------------------|----------------------------------|
| Orchestrator | your `omp` shell | your configured default model    |
| Worker       | `.omp/roadmap.yml `workerModel`` | `muse-spark-1.3-contributor-free` (free tier) |
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
Skip: true             # optional
```

## Layout (durable store, plan §13)

```
.omp/roadmap/runs/<runId>/
  roadmap.json        # materialized cursor (atomic tmp+rename writes)
  events.jsonl        # append-only audit + replay source
  slices/<id>/report.json | verdict.json | worker-<n>.log | prompt-<n>.md | logs/
```

## Dev

```bash
bun install
bun test              # 26 unit/integration tests (mocked workers)
bunx tsc --noEmit
```
