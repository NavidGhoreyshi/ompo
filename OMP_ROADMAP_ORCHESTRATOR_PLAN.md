# OMP Roadmap Orchestrator — Architecture Plan

> Reconnaissance phase only. No implementation. Target: omp `@oh-my-pi/pi-coding-agent` v18.1.10.

## 0. Sources and method

- Package inspected: `@oh-my-pi/pi-coding-agent` v18.1.10 at
  `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/` (`src/` = 1713 files).
- Sibling runtime: `@oh-my-pi/pi-agent-core` (`agent-loop.ts`, `agent.ts`, `replay-policy.ts`).
- No GitHub checkout was available; the published npm artifact ships `src/` but no
  `test/` (only collocated test: `src/edit/auto-repair.test.ts`). Test-layout claims about
  the monorepo are marked UNKNOWN below.
- Rule followed: every capability claim cites `file:line` + symbol. Anything not found is
  marked `UNKNOWN — requires further investigation`.

## 1. Current architecture findings

### 1.1 Child task/session creation (Q1)

- Entry point: `TaskTool.execute()` in `src/task/index.ts:678`.
- Sync path: `#runSpawn()` (`index.ts:1446`) → `#executeSync()` (`index.ts:1421`) →
  `runStructuredSubagent()` (`src/task/structured-subagent.ts:575`) →
  `runSubprocess()` (`src/task/executor.ts:2909`) →
  `createAgentSession(buildSubagentSessionOptions())` (`executor.ts:3429`) →
  `driveSessionToYield(session, monitor, task)` → `session.prompt(task)` (`executor.ts:1992`).
- Async path: `#registerSpawnJob()` (`index.ts:1080`) registers on `AsyncJobManager`
  (`src/async/job-manager.ts:53`, job types `bash|task|eval`) and runs the same `#executeSync`.
- Fan-out helpers: `#executeSyncFanout()` (`index.ts:1270`), `#runSyncSpawns()` (`index.ts:1351`),
  `mergeSyncPayloads()` (`index.ts:326`), concurrency via `mapWithConcurrencyLimit(AllSettled)`
  (`src/task/parallel.ts:26,98`) bounded by a per-`TaskTool` `Semaphore` (`parallel.ts:140`,
  `index.ts:632`) sized from `task.maxConcurrency` (`src/config/settings-schema.ts:5000`).
- Preflight: `resolveEffectiveSubagentPolicy()` (`structured-subagent.ts:262`),
  `reserveStructuredSubagentId()` (`structured-subagent.ts:348`),
  `leaseArtifacts()` (`structured-subagent.ts:365`); isolated spawns go through
  `prepareIsolationContext()` / `runIsolatedSubprocess()` (`src/task/isolation-runner.ts:104,197`).
- Agent selection: `discoverAgents()` + `getAgent()` (`src/task/discovery.ts:72,146`),
  normalized per spawn by `resolveSpawnItems()` / `spawnParamsFor()` (`index.ts:266,288`).

### 1.2 Child context: clean session (Q2)

- Yes, clean. `runSubprocess` opens a **fresh `AgentSession`**; the parent transcript is never
  copied. `executor.ts:3235-3240`: `SessionManager.open(sessionFile)` when an artifacts dir
  implies a session file, else `SessionManager.inMemory(effectiveCwd)`. Revive only replays the
  child's own `.jsonl` via `replaceMessages` (`executor.ts:3446-3450`).
- Parent→child transfer is explicit prompt assembly:
  - user turn: `renderSubagentPrompt()` (`structured-subagent.ts:175`, template
    `subagent-user-prompt.md`) from `assignment`; batch `context` only if `task.batch`
    (`index.ts:1459`); `planReference` via `loadPlanReference/loadOverallPlanReference`
    (`structured-subagent.ts:480`).
  - system prompt: `subagent-system-prompt.md` rendered with `{agent.systemPrompt, context,
    planReference, worktree, outputSchema, workPoolYieldItems, ircPeers}` (`executor.ts:3361`).
  - forwarded environment: `contextFiles` (filtered `agents.md`), skills/autoload, rules,
    extension roots + preloaded extensions/tools, `workspaceTree`, `promptTemplates`,
    `parentArtifactManager`, `parentHindsight/Mnemopi`, `parentEvalSessionId`, `parentAgentId`,
    `parentTelemetry`, `parentServiceTier`, tool allowlist from `AgentDefinition.tools` plus auto
    `task/hub` (`executor.ts:3007-3023`), `spawnsEnv` string.
- Child IDs: `generateTaskName()` (`src/task/name-generator.ts:1537`),
  `sanitizeAgentId()` (`structured-subagent.ts:184`), `AgentOutputManager.allocate()`
  (`src/task/output-manager.ts:111`).

### 1.3 Child model selection, heterogeneity (Q3, Q4)

- The `task` tool wire has **no `model` field**:
  `TaskItem{agent, task, effort, outputSchema, schemaMode, tools, isolated}`
  (`src/task/types.ts:135`). Model is chosen **via agent type**.
- Resolution: `task.agentModelOverrides[agentName]` + `parentActiveModelPattern` +
  `agent.model` + `getModelString()` → `resolveAgentModelSelection()`
  (`structured-subagent.ts:299-312`, `src/config/model-resolver.ts:1322`), applied with auth
  fallback in `resolveModelOverrideWithAuthFallback()` / `installSubagentRetryFallbackChain()`
  (`executor.ts:3170,3193`, inherited chain `executor.ts:3156`). The resolved model is visible as
  `AgentProgress.resolvedModel` / `SingleResult.resolvedModel` (`types.ts:417,493`).
- Bundled defaults prove heterogeneity: `task` agent → `model: "@task"`, `sonic` agent →
  `model: "@smol"` (`src/task/agents.ts:50-67`); `DEFAULT_SPAWN_AGENT="task"`
  (`src/task/spawn-policy.ts:2`); override key `task.agentModelOverrides`
  (`src/config/settings-schema.ts:5131`).
- `effort: lo|med|hi` (`TaskEffort`) feeds `resolveTaskEffortLevel()` (`executor.ts:3217`) and
  overrides `thinkingLevel`. So: per-slice model = pick `agent:` per `TaskItem` (or
  `task.agentModelOverrides` per agent name) — exactly the orchestrator↔worker model split.

### 1.4 Parent receives result (Q5), structured output (Q6)

- Return value: `StructuredSubagentResult{result, policy, mergeSummary, changesApplied,
  artifactsDir}` (`structured-subagent.ts:153`) → `SingleResult` (`types.ts:493`) →
  `#buildResultPayload()` (`index.ts:1534`) → `AgentToolResult<TaskToolDetails{results, usage,
  outputPaths, progress, async}>` (`types.ts:563`). Human text via `formatTaskResultSummary()`
  (`src/task/result-summary.ts:41`, `<task-result>` envelope, 5000-char full-output threshold,
  `agent://<id>` pointer).
- Live events: `TASK_SUBAGENT_EVENT / PROGRESS / LIFECYCLE_CHANNEL` (`types.ts:59`) via
  `emitSubagentFrame` (`executor.ts:3498,2393`); `AgentProgress` stream
  (`onProgress/createSubagentRunMonitor`, `types.ts:417`).
- Files: `<artifactsDir>/<id>.md` + `<id>.json` sidecar with `structured.data`
  (`executor.ts:2293,2310`), `<id>.jsonl` (`executor.ts:2960`), `outputMeta/outputPath`;
  isolation yields `patchPath/branchName omp/task/<id>/nestedPatches`
  (`isolation-runner.ts:197`); `AgentRegistry.setHistory()` (`executor.ts:3819`).
- Structured output **is enforced today**:
  - modes `permissive|strict` (`types.ts:17`); `StructuredSubagentOutput{source: caller|agent|
    session|none, mode, status: valid|invalid|unavailable, data, error}` (`types.ts:32`).
  - priority `resolveSchema()` (`structured-subagent.ts:190`): caller `outputSchema` >
    `agent.output` > `session.outputSchema` > none; strict caller-schema preflight rejects
    invalid schemas (`StructuredSubagentError`, `structured-subagent.ts:291`).
  - pipeline: `normalizeSchema()/isJTDSchema()` (`src/tools/jtd-to-json-schema.ts:311,151`) →
    `buildOutputValidator()` (`src/tools/output-schema-validator.ts:66`) → child-side
    `YieldTool` with `MAX_SCHEMA_RETRIES=3` (`src/tools/yield.ts:244,234`) →
    `assembleYieldResult()` (`src/task/yield-assembly.ts:130`) →
    `finalizeSubprocessOutput()` / `buildSchemaViolationOutcome()` (`executor.ts:666,642`;
    strict invalid → exit 1). Workpool demonstrates strict use:
    `buildWorkPoolOutputSchema()` (`src/task/workpool-yield.ts:8`, `schemaMode:"strict"`).

### 1.5 Termination, ephemeral children (Q7, Q8)

- `finalizeSubagentLifecycle()` (`executor.ts:2665`): aborted+non-resumable → dispose +
  tombstone/release/unregister; `!keepAlive` → dispose + unregister (eval one-shots set
  `keepAlive:false`); isolated → parked + dispose + detach; else idle-adopted by
  `AgentLifecycleManager` (`idleTtlMs` from `task.agentIdleTtlMs`, ~420s) with revive support.
- Ephemeral/in-memory: yes. `SessionManager.inMemory()` when `sessionFile==null`
  (`executor.ts:3235-3240`); `leaseArtifacts()` falls back to `os.tmpdir()/omp-task-<Snowflake>`
  with `temporary:true` (`structured-subagent.ts:365`); retention gate
  `shouldRetainArtifacts = detached || (retainArtifacts && (success || validStructured)) || …`
  (`executor.ts:691`, cf. `index.ts:1490`), otherwise `rm -rf`; abort grace
  `TASK_ABORT_CLEANUP_GRACE_MS=10s` (`task/index.ts:98`).

### 1.6 Session lifecycle and persistence

- `SessionManager` (`src/session/session-manager.ts:477`): `create()` (`:2805`),
  `createEmptySessionFile()` (`:2818`), `forkFrom()` (`:2843`), `open()` (`:2913`),
  `continueRecent()` (`:3021`), `inMemory()` (`:3103`). Default dir computation:
  `computeDefaultSessionDir()` / `getDefaultSessionDirName()`
  (`src/session/session-paths.ts:185,62`). `--session-dir` wired in
  `src/commands/launch-help.ts:59` → `main.ts:379,420`.
- Storage backends present: `session-storage.ts` (+ `FileSessionStorage`),
  `indexed-session-storage.ts`, `sql-session-storage.ts`, `redis-session-storage.ts`,
  `agent-storage.ts`, `history-storage.ts`, `session-persistence.ts`,
  `turn-persistence.ts`, plus recovery: `turn-recovery.ts`, `checkpoint-entries.ts`,
  `inline-edit-recovery.ts`. `--no-session` = ephemeral (`SessionManager.inMemory`, no save).
- Agent definitions: bundled `task`/`sonic`/`scout`/`reviewer`… in `src/task/agents.ts`
  (`EMBEDDED_AGENT_DEFS`), unpackable via `omp agents unpack [--project]`
  (`src/commands/agents.ts`); discovery `discoverAgents/getAgent` (`task/discovery.ts:72,146`).
- Project-local `.omp`: `CONFIG_DIR_NAME` (`.omp`) in `discovery/helpers.ts:47`;
  loaders in `discovery/builtin.ts` (commands `*.md:340`, skills:282, tools:732, extensions:462,
  hooks:673, settings:848, `AGENTS.md`:907, `SYSTEM.md`:242, rules:462ff); walk-up monorepo
  search `findAllNearestProjectConfigDirs` (`config.ts:218`); extension roots
  `listOmpExtensionRoots()` (`discovery/omp-extension-roots.ts:283`).
- Model flags: `--model/--smol/--slow/--plan`, `--prewalk`, `--plan-yolo*` (CLI help);
  role models `src/session/role-models.ts`, controls `src/session/model-controls.ts`,
  resolver `src/config/model-resolver.ts`, roles `src/config/model-roles.ts`.
  `PI_SMOL_MODEL / PI_SLOW_MODEL / PI_PLAN_MODEL` env overrides documented in CLI help.

### 1.7 Swarm / persisted execution state / sequential jobs (Q9, Q10, Q11)

- **No swarm.** Glob `**/*swarm*` under `src/` finds nothing; case-insensitive grep for
  `swarm` hits one unrelated UI-overflow comment
  (`src/modes/controllers/event-controller.ts:66`). No swarm runner, job model, or persisted
  swarm state exists. No `orchestrator`/`roadmap` class either (`orchestrate.ts`,
  `workflow.ts` in `src/modes/` are prompt-notice renderers only; `src/task/commands.ts`
  expands slash-command workflows, not a runner).
- Closest existing primitives (all reusable, none sufficient alone):
  - `WorkPool` (`src/task/workpool.ts:103`): `WorkPoolItem{queued|running|completed|failed|
    cancelled}` (`:20`), `WorkPoolAgent{running|idle|dead}` (`:30`), `push()/ #dispatch()/
    #drain()/#startTurn()/#settleTurn()`; first turn `runStructuredSubagent(keepAlive:true,
    retainArtifacts:true, strict schema)`, later turns `runSubagentFollowUpTurn()` (`:349-423`).
    **Process-local only** (`WorkPoolRegistry`, `:584`), no disk persistence, no dynamic
    next-task choice beyond queue drain; `freshAgents` flag from `eval.workpool.freshAgents`
    (`:132`) selects fresh-vs-reused agents.
  - `runCleanseLoop()` (`src/cleanse/loop.ts:71`): streaming collect→route→dispatch→followUp→
    verify cycle with weight budgeting (`balance.ts:10`), `CleanseLoopResult{clean|stalled|
    cancelled}` (`cleanse/types.ts:85`). Reference fan-out+verify pattern, but single
    collect→dispatch→verify pass, no persistent queue, `maxAgents` default 32.
  - `VibeSessionRegistry` (`src/vibe/runtime.ts:303`): `VibeRecord{starting|running|idle|dead,
    queue, turn}` with `spawn/send/wait/kill/rehydrate()` (`:729`); persistence = parent JSONL
    lifecycle entries (`vibe/lifecycle.ts:14`) + child `<id>.jsonl`; `rehydrate` restores idle
    workers but does **not** resume in-flight work. Closest persistence idiom to copy.
  - `TodoTool` (`src/tools/todo.ts:798`, phases/tasks `pending|in_progress|completed|
    abandoned|blocked`) + `TodoTracker` (`src/session/todo-tracker.ts:66`): transcript-persisted
    only, single `in_progress`, no worker assignment.
  - `GoalRuntime` (`src/goals/runtime.ts:117`, `GoalStatus active|paused|…|complete|dropped`):
    single-objective budget accounting, not a task queue.
  - `AsyncJobManager` (`src/async/job-manager.ts:53`, types `bash|task|eval`): ephemeral
    in-memory gate, no durability.
  - `persisted-revive.ts` (`createPersistedSubagentReviverFactory()`, `:58`): cold-revive of an
    idle child from its `session_init` contract — reuse for resume, not a queue.

### 1.8 Commands, TUI/runtime, tests (Q13, Q17, Q18)

- CLI extension point: `commands: CommandEntry[]` (`src/cli-commands.ts:22`); lifecycle
  `runCli()` (`src/cli.ts:351`) → `resolveCliArgv` → dynamic `load()` → `Command.run()`
  (one-shot process). Canonical long-running pattern: `Cleanse` command
  (`src/commands/cleanse.ts:7`, flags `agents/model/tests/all`) → `runCleanse()` /
  `runCleanseCommand()` (`src/cleanse/index.ts:50,231`, `AbortController` on SIGINT/SIGTERM)
  → `postmortem.quit(exitCode)`.
- Extension API (alternative to core): `ExtensionAPI.registerTool/registerCommand`
  (`extensibility/extensions/types.ts:1299,1363`), `HookAPI.registerCommand`
  (`extensibility/hooks/types.ts:573`); file slash commands `<cwd>/.omp/commands/<name>.md`;
  TS commands `…/commands/<name>/index.ts`; skills `…/skills/<name>/SKILL.md`
  (see `extensibility/*`, `discovery/builtin.ts`). Extensions run **in-process** — same
  process-local limits as `WorkPoolRegistry`.
- TUI is presentational only (`src/tui/`); real loops: `InteractiveMode`
  (`src/modes/interactive-mode.ts:558`), `runPrintMode()` (`src/modes/print-mode.ts:93`),
  RPC/ACP variants; startup chain in `src/main.ts` (`createSessionManager →
  buildSessionOptions → createAgentSession (sdk.ts) → runInteractiveMode`).
- Tests: published artifact ships no `test/` dir and a single collocated
  `src/edit/auto-repair.test.ts`; `package.json:35 test` points at monorepo harness
  `bun ../../scripts/ci-test-ts.ts coding-agent-heavy --full` (not shipped).
  Monorepo layout is therefore `UNKNOWN — requires further investigation` in a repo
  checkout; by convention expect `packages/coding-agent/test/<area>/*.test.ts` or collocated
  `src/<area>/*.test.ts`.

## 2. The 18 questions — direct answers

| # | Question | Answer (evidence) |
|---|---|---|
| 1 | Child creation? | `TaskTool.execute` → `runStructuredSubagent` → `runSubprocess` → `createAgentSession` + `session.prompt` (§1.1) |
| 2 | Clean context? | Yes — fresh `AgentSession`, no transcript copy; explicit prompt assembly (§1.2) |
| 3 | Child model selection? | Via agent type + `task.agentModelOverrides` → `resolveAgentModelSelection` (§1.3) |
| 4 | Heterogeneous models? | Yes — `task:@task` vs `sonic:@smol` today; per-slice agent choice (§1.3) |
| 5 | Parent receives result? | `SingleResult` → `TaskToolDetails`; live `AgentProgress`; artifact files (§1.4) |
| 6 | Structured output enforced? | Yes — JTD→validator→`YieldTool` (3 retries)→finalize; `strict` fails exit 1 (§1.4) |
| 7 | Termination? | `finalizeSubagentLifecycle`: dispose / idle-adopt (TTL ~420s) / park isolated (§1.5) |
| 8 | Ephemeral/in-memory? | Yes — `SessionManager.inMemory` + tmp artifacts + retention gate (§1.5) |
| 9 | Swarm persisted state? | None — no swarm exists (§1.7) |
| 10 | Sequential jobs? | No queue; `WorkPool` drains a static list process-locally (§1.7) |
| 11 | Dynamic next-task? | No — nothing selects next work from roadmap state (§1.7) |
| 12 | What must change? | §3 (gaps) + §4/§5 (new state machine, selector, CLI, verification) |
| 13 | Extension or core? | §4: rule engine + state as **extension-capable core module** + thin **core CLI command**; ship behind a command flag |
| 14 | Reuse? | §2.1 below |
| 15 | Genuinely new? | §3 + §5: roadmap model/store/selector, worker-spec builder, verifier hook, resume |
| 16 | Risks? | §7 (section 16 in deliverable numbering — see Risks) |
| 17 | Existing tests? | None shipped for task/session; harness `ci-test-ts.ts` (unverified locally) (§1.8) |
| 18 | Where new tests live? | Collocated `src/roadmap/*.test.ts` mirroring `edit/auto-repair.test.ts`, plus monorepo `test/` mirror — confirm in checkout |

## 2.1 Existing capabilities to reuse (Q14)

1. `runStructuredSubagent()` + strict `outputSchema` — the worker primitive (fresh session,
   enforced completion report). No new agent runner needed.
2. Agent-type model routing (`task.agentModelOverrides`, `resolveAgentModelSelection`) —
   the orchestrator↔worker model split with zero resolver changes.
3. `YieldTool` + `buildOutputValidator` + JTD normalization — report-schema enforcement.
4. `AgentOutputManager` + artifacts dir (`<id>.md/.json/.jsonl`) — evidence files.
5. `SessionManager.open/inMemory`, `FileSessionStorage`, JSONL transcript — durability idiom
   (copy `vibe/lifecycle.ts` custom-entry pattern for orchestrator events).
6. `AgentLifecycleManager` idle-adopt + `persisted-revive.ts` cold revive — worker handle reuse.
7. `WorkPool` dispatch/settle structure — template for the orchestrator loop (do not subclass;
   extract or imitate; it is process-local and queue-static).
8. `runCleanseLoop` collect→dispatch→verify — template for worker→verification sequencing.
9. Isolation (`isolation-runner.ts`, `worktree.ts` `omp/task/<id>` branches, `mergeTaskBranches`)
   — optional per-slice isolation for risky workers.
10. `TodoTool`/`TodoTracker` phase model — in-roadmap progress display inside the orchestrator
    session transcript (not the durable store).
11. `Cleanse` CLI command shape + `cli-commands.ts` registration — the new command's skeleton.
12. `.omp/` discovery (`commands/`, `skills/`, `tools/`, `settings.json`) — project-local
    roadmap + worker-spec overrides without code changes.

## 3. Gaps between current omp and the desired workflow

- G1 No durable roadmap store. `WorkPool` items, `AsyncJobManager` jobs, `TodoTool` phases are
  process-local or transcript-only. Crash loses everything except child `.jsonl` fragments.
- G2 No sequential selector. Nothing picks "next slice" from dependency/state; `WorkPool`
  drains a static list; `cleanse` runs one pass.
- G3 No worker-spec (context-bundle) builder. Prompt assembly exists but is per-call, not a
  versioned slice→prompt compiler with token budget and file allowlist.
- G4 No verification stage. `verify` in cleanse = re-run checkers; no generic
  build/test/lint gate with structured verdict that feeds back into slice state.
- G5 No orchestrator lifecycle. No long-running command owning: load roadmap → select → spawn
  (`keepAlive:false`, ephemeral) → await `SingleResult` → verify → persist → repeat, with
  SIGINT/abort handling and resume.
- G6 No cross-process resume. `rehydrate`/`persisted-revive` restore idle handles in-process;
  nothing re-enters a roadmap from disk in a new `omp` process.
- G7 History carriage. The orchestrator session transcript would accumulate per-slice summaries
  unless summaries are compacted to the store and the transcript kept pointer-thin.

## 4. Recommended architecture (Q12, Q13)

**Orchestration layer around existing primitives — not a new multi-agent framework.**

```
                 ┌─────────────────────────────────────┐
                 │  omp roadmap (core CLI command)     │
                 │  src/commands/roadmap.ts            │
                 └──────────────┬──────────────────────┘
                                │ owns loop, owns store writes
                 ┌──────────────▼──────────────────────┐
                 │  src/roadmap/ orchestrator          │
                 │  store → selector → spec-builder →  │
                 │  runStructuredSubagent → verifier → │
                 │  store                              │
                 └──┬──────────────┬────────────┬──────┘
            reuses  │      reuses  │   reuses   │  reuses
         TaskTool ──┘   Session/ ──┘  Yield/ ──┘  isolation
         strict spawn   JSONL store   validator   (opt-in)
```

- **Core, not extension.** The loop must survive TUI lifetimes, own `AbortController`/SIGINT,
  write outside the transcript, and be invocable headless (`-p`, CI). Extensions/hooks run
  in-process with no lifecycle ownership (`extensibility/*`), so an extension cannot own
  resume. Ship as `src/roadmap/*` + `src/commands/roadmap.ts` registered in
  `src/cli-commands.ts:22`, mirroring `cleanse` (§1.8). Project-local customization (roadmap
  file location, verification commands, worker agent names) comes from `.omp/` settings —
  the extension *surface*, not the engine.
- **New code is genuinely small:** roadmap model + JSONL/disk store + ready-selector +
  spec-builder + verifier + loop + CLI. Worker execution, model routing, schema enforcement,
  session persistence, and isolation are all reused (§2.1).
- **Out of scope:** swarm/parallel DAG execution (sequential first; `task.maxConcurrency`
  semaphore already bounds any later parallelism), daemonization (`src/launch/` untouched),
  new model providers.

## 5. Proposed modules/files

| File | Purpose | Reuses |
|---|---|---|
| `src/roadmap/types.ts` | `Slice{…}`, `SliceStatus`, `RoadmapDoc`, `RunEvent`, `CompletionReport` schema | `task/types.ts` idioms |
| `src/roadmap/parse.ts` | Markdown→`RoadmapDoc` parser + validator | UNKNOWN parser to reuse — check `markit/` first |
| `src/roadmap/store.ts` | Durable store: `roadmap.json` + `runs/<runId>/events.jsonl`, atomic writes, file lock | `session-persistence.ts`, `vibe/lifecycle.ts` entry pattern |
| `src/roadmap/select.ts` | Ready-selector: deps satisfied + status `pending` → next slice (deterministic order) | none (new, ~100 lines) |
| `src/roadmap/spec.ts` | Slice→worker-spec compiler: prompt + file allowlist + budget cap + agent/model choice | `renderSubagentPrompt`, `structured-subagent.ts:175-480` |
| `src/roadmap/worker.ts` | One call: `runStructuredSubagent({keepAlive:false, strict report schema})`, returns `SingleResult` + parsed report | `structured-subagent.ts:575`, `workpool-yield.ts` strict pattern |
| `src/roadmap/verify.ts` | Pluggable verifiers: `command` (shell exit) + `eval` backends; `Verdict{pass,fail}` | `tools/eval.ts`, `cleanse/checkers.ts` pattern |
| `src/roadmap/loop.ts` | `runRoadmapLoop()`: load→select→spawn→verify→persist→repeat; abort/resume | `cleanse/loop.ts:71` structure, `async/job-manager.ts` |
| `src/commands/roadmap.ts` | CLI: `omp roadmap --roadmap X --run Y [--resume] [--slice N] [--dry-run]` | `commands/cleanse.ts:7` shape |
| `src/roadmap/*.test.ts` | Unit tests collocated (mirrors `edit/auto-repair.test.ts`) | — |

## 6. State-machine design

```
pending ──▶ running ──▶ verifying ──▶ done
   ▲            │             │
   │            │             ▼
   │            │         failed ──▶ pending (retry++, if retries left)
   │            ▼             │
   │        aborted ──────────┘ (requeue; resumes as pending)
   └──── blocked (deps unmet; auto-leaves when deps done)
                    skipped (explicit --slice filter or manual mark)
```

- Slice record: `{id, title, body, deps: string[], status, attempts, maxRetries,
  workerAgent, reportRef, verdictRef, updatedAt}`.
- Transitions append `RunEvent`s (`slice_claimed|worker_finished|verify_passed|verify_failed|
  slice_retried|run_aborted|run_resumed`) to `events.jsonl`; `roadmap.json` holds the
  materialized cursor (idempotent replay from events — UNKNOWN whether omp has an event-sourcing
  helper; assume plain JSON read-modify-write with lock file, verify in M1).
- Terminal states: `done`, `failed` (retries exhausted), `skipped`. Non-terminal everything else.
- Selector only returns `pending` slices whose `deps ⊆ done`. Deterministic: roadmap order.
  Dynamic re-prioritization is explicitly deferred (static order + dep gating = sufficient).

## 7. Worker lifecycle

1. Selector yields slice → `spec.ts` compiles worker-spec (prompt, files, budget, agent).
2. `worker.ts` calls `runStructuredSubagent({agent: slice.workerAgent, assignment: specPrompt,
   outputSchema: CompletionReportSchema, schemaMode: "strict", keepAlive: false,
   retainArtifacts: on-success-only})` — mirrors `WorkPool.#startTurn` first-turn call
   (`workpool.ts:376`) minus keep-alive.
3. Child starts with **clean context** (§1.2); only spec files + assignment + referenced plan
   excerpt are visible. Parent history never attached.
4. Child works, calls `yield` (validated, 3 retries), exits. Strict-invalid → exit 1 →
   treated as worker failure → retry path.
5. `finalizeSubagentLifecycle` disposes the session (ephemeral; §1.5). Artifacts
   `<id>.md/.json` retained under `runs/<runId>/slices/<sliceId>/`.
6. Parsed `CompletionReport` returned to loop; raw `SingleResult` archived alongside.

## 8. Orchestrator lifecycle

1. `omp roadmap --roadmap ROADMAP.md [--run <id>|--resume]`: `commands/roadmap.ts` parses args,
   `store.ts` loads or creates `runs/<runId>/` (`roadmap.json` snapshot + `events.jsonl`).
2. `runRoadmapLoop()`: while selector returns a slice and no abort: claim (persist
   `slice_claimed`) → `worker.ts` → persist `worker_finished` → `verify.ts` → persist verdict →
   advance status. Each step is a separate store write — crash-safe at every boundary.
3. Abort (SIGINT/SIGTERM/TUI Esc → `AbortController`, per `cleanse/index.ts:231`): finish the
   in-flight store write, mark slice `aborted`, `postmortem.quit(exitCode)`.
4. Orchestrator transcript hygiene: per-slice, write a 5-line summary + `reportRef` pointer
   into its own session transcript; full reports live on disk. Prevents the context-exhaustion
   failure the whole project exists to solve (§G7).
5. Exit codes: `0` all done; `1` failures remain; `2` aborted; `3` resume-conflict (lock held).

## 9. Verification lifecycle

1. Trigger: every `worker_finished` with a schema-valid report enters `verifying`.
2. Verifier chain from `.omp/roadmap.yml` (or flags): ordered `command` steps
   (`npm test -- <scope>`, `tsc --noEmit`, lint) with cwd + timeout + expected-exit 0.
   `eval`-backend steps deferred to a later milestone (reuse `tools/eval.ts`).
3. `Verdict{pass: bool, steps: [{name, exit, outputRef}]}` persisted next to the report.
4. `pass` → `done`. `fail` → `failed`; retry (fresh worker, `attempts++`) while
   `attempts <= maxRetries`, else terminal `failed` and loop continues to next ready slice
   (never blocks the roadmap on one slice).
5. Verifier output is capped (tail N lines in store, full log to file) to bound disk + context.

## 10. Model-routing strategy

- Zero new resolver code. Worker model = agent-type mapping that already exists (§1.3):
  - orchestrator runs on the invocation model (e.g. Muse Spark 1.3 via `--model`).
  - each slice declares `workerAgent` (default e.g. `roadmap-worker`, `model: "@smol"` or an
    explicit DeepSeek pattern), resolved through `resolveAgentModelSelection()` with
    `task.agentModelOverrides` as the operator escape hatch.
- Concretely: ship one bundled agent def `roadmap-worker.md` (mechanical implementer,
  cheap model) + allow per-slice `workerAgent: task` for hard slices (strong model).
  Effort knob: `effort: lo|med|hi` per slice → `resolveTaskEffortLevel()` (`executor.ts:3217`).
- Prewalk caution: `task.prewalk` / `task.agentPrewalk` (`agents.ts:50-67` comments) can
  silently swap models mid-run — default it OFF for roadmap workers and assert in M4 tests.
- UNKNOWN — requires further investigation: exact `@smol` binding mechanics for a custom
  provider model string (DeepSeek V4 Flash pattern) — verify against `model-resolver.ts`
  + `model-roles.ts` during M4 with the real config.

## 11. Roadmap parsing strategy

- Input: human-authored Markdown (`ROADMAP.md`, checkbox sections) + optional
  `.omp/roadmap.yml` (verifiers, defaults, retries, worker agent names).
- Parser (`parse.ts`): headings → slices (id = slug, stable), `Depends:` trailer → `deps`,
  `Agent:`/`Effort:` trailers → overrides; validator rejects duplicate ids, unknown deps,
  cycles (Kahn check, ~30 lines).
- Before writing a parser, check `src/markit/` for an existing Markdown AST to reuse —
  UNKNOWN whether it fits; fallback is a line-scanner (roadmap format is constrained).
- Snapshot the parsed doc into `runs/<runId>/roadmap.json` at start; drift detection: re-parse
  hash compared per run, abort with message if the source changed mid-run (operator re-runs
  with `--rebase` — deferred to post-MVP).

## 12. Context-bundle (worker-spec) strategy

- Per slice, `spec.ts` compiles: (a) slice title+body, (b) `deps` slices' *summaries only*
  (never full transcripts), (c) explicit file allowlist (slice-declared paths + repo
  conventions like `AGENTS.md`), (d) completion-report schema reminder, (e) token-budget cap
  (truncate (b)→(c)→(a) in that order; fail closed if (a) alone exceeds cap).
- Mechanism: `assignment` string + `contextFiles` allowlist via existing
  `buildExecutorOptions` path (`structured-subagent.ts:391`) — no executor changes.
- Completion report schema (strict, JTD): `{sliceId, summary, filesChanged[],
  testsRun[], testsPassed, verificationNotes, followUps[], done: bool}`.
  Reuses the `workpool-yield.ts:8` strict pattern.
- Anti-exhaustion invariant: worker input size is O(slice + dep-summaries), never O(history).

## 13. Persistence strategy

- Layout (project-local, checkable):
  ```
  .omp/roadmap/
    runs/<runId>/
      roadmap.json      # parsed snapshot + slice states (materialized cursor)
      events.jsonl      # append-only RunEvents (audit + replay)
      slices/<id>/report.json | verdict.json | worker-<n>.jsonl | logs/
    runs/<runId>.lock   # exclusive run lock (pid + timestamp)
  ```
- Mirrors `vibe/lifecycle.ts` custom-entry idiom (parent transcript gets pointers, disk gets
  truth) and `cleanse/agent.ts:89-98` `ensureOnDisk` pattern.
- Atomicity: write tmp + rename per store mutation; lock file with stale-pid reclamation
  (UNKNOWN whether omp has a lock helper — check `task/worktree.ts withRepoLock` /
  `mergeTaskBranches:937` first; else ~40 lines with `O_EXCL`).
- Session transcripts (orchestrator's own `.jsonl` via `FileSessionStorage`) remain the
  secondary log; the store is authoritative for resume.

## 14. Resume / crash-recovery strategy

- Resume = new process, same run dir: `omp roadmap --resume [--run <id>]` → `store.ts` loads
  `roadmap.json` + replays `events.jsonl` (event count must match materialized cursor, else
  rebuild cursor from events) → any `running|verifying` slice at crash is demoted to
  `pending` with `attempts` preserved (workers are `keepAlive:false` + ephemeral, so no
  half-session can usefully revive — deliberately *not* using `persisted-revive.ts` for
  workers; the unit of recovery is the slice, not the session).
- In-flight child `.jsonl` (if `sessionFile` was on disk) is archived, never re-attached.
- Idempotency: `slice_claimed` is the claim fence; double-claim (stale lock) resolves by
  run-id ordering — newer run wins, older aborts with exit 3.
- Operator tools: `--slice <id>` (run one slice), `--dry-run` (parse+select without spawning),
  `omp roadmap status` (read-only store dump). Status subcommand is M6 scope.

## 15. Testing strategy

- Location: collocated `src/roadmap/*.test.ts` (only in-artifact precedent:
  `src/edit/auto-repair.test.ts`), mirroring into monorepo `packages/coding-agent/test/`
  per harness `scripts/ci-test-ts.ts` — confirm exact path in a repo checkout (M1 task).
- Unit (no LLM): parser (golden Markdown→doc, dup/cycle rejection), selector (dep gating,
  order determinism, retry demotion), store (crash-replay equivalence: random event prefix +
  rebuild ≡ cursor), spec builder (budget truncation order, fail-closed).
- Integration (mocked `runSubprocess`): loop happy path, verify-fail→retry→terminal-fail,
  abort mid-slice → resume re-runs slice, strict-invalid report → worker-failure path.
- Live (opt-in, real models, small fixtures): one 2-slice fixture roadmap behind an env flag
  (`OMP_ROADMAP_LIVE=1`), asserting end-to-end `done+done` with capped cost; never in CI default.
- Prewalk-off assertion (M4): worker spawn test fails if model-transition/prewalk mutates the
  worker model.

## 16. Incremental implementation milestones

### M1 — Roadmap model, parser, selector (no execution)

- Objective: parse `ROADMAP.md` → validated `RoadmapDoc`; deterministic ready-selector.
- Files: NEW `src/roadmap/types.ts`, `src/roadmap/parse.ts`, `src/roadmap/select.ts`,
  `src/roadmap/*.test.ts`. Touch nothing else. Check `src/markit/` for AST reuse first.
- Dependencies: none.
- Tasks: define `Slice/SliceStatus/RoadmapDoc`; line-scanner or markit-backed parser
  (headings, `Depends:`/`Agent:`/`Effort:` trailers); cycle/unknown-dep/duplicate validation;
  `nextReady(doc)` (pending + deps⊆done, roadmap order); golden-file tests.
- Tests: parser goldens (valid, dup-id, unknown-dep, cycle); selector order/gating tests.
- Acceptance: `parse(fixture) → select → slice-A`, mark done, → `slice-B`; all unit tests pass.
- Gate to M2: frozen `types.ts` (M2+ depend on it; changes after M2 require updating store tests).

### M2 — Durable store + crash replay

- Objective: `runs/<runId>/{roadmap.json,events.jsonl}` with atomic writes, lock, replay.
- Files: NEW `src/roadmap/store.ts` (+ tests). Reuse: `session-persistence.ts` idioms,
  `withRepoLock` if suitable (`task/worktree.ts:937`).
- Dependencies: M1 types.
- Tasks: store layout (§13); `claim/finish/verdict` writers (tmp+rename); `O_EXCL` lock with
  stale-pid reclaim; `load()` with event-replay verification (cursor ≡ replay).
- Tests: write→load round-trip; kill-simulation (event prefix → rebuild ≡ cursor);
  lock contention (second opener gets exit-3 condition).
- Acceptance: random-prefix replay property test passes; stale lock reclaimed.
- Gate to M3: store API frozen (`appendEvent`, `loadRun`, `claimSlice`, `settleSlice`).

### M3 — Worker spawn (strict report, ephemeral, mocked loop)

- Objective: one slice → strict-schema ephemeral worker → parsed `CompletionReport`.
- Files: NEW `src/roadmap/spec.ts`, `src/roadmap/worker.ts` (+ tests); NEW bundled agent
  `roadmap-worker.md` (model `@smol`, minimal tools). Reuse: `runStructuredSubagent`,
  `buildWorkPoolOutputSchema` strict pattern, `AgentOutputManager` dirs.
- Dependencies: M1 (spec input), M2 (artifact paths).
- Tasks: spec compiler (slice + dep-summaries + file allowlist + budget cap, §12);
  `CompletionReport` JTD schema; `worker.ts` (`keepAlive:false`, `schemaMode:"strict"`,
  `retainArtifacts` on-success); dep-summary renderer.
- Tests: spec truncation order + fail-closed; mocked-`runSubprocess` valid/invalid-report
  paths (strict-invalid → worker failure); prewalk-off assertion placeholder.
- Acceptance: mocked worker returns parsed report; artifacts land under `slices/<id>/`.
- Gate to M4: report schema frozen (verifier + loop depend on it).

### M4 — Model routing + live single-slice proof

- Objective: prove orchestrator↔worker model split with a real spawn.
- Files: EDIT `src/task/agents.ts` (add `roadmap-worker` def), `src/roadmap/worker.ts`
  (agent choice per slice); optional EDIT settings-schema docs for `task.agentModelOverrides`
  example. Tests: model-resolution unit test.
- Dependencies: M3.
- Tasks: register `roadmap-worker` (`model:"@smol"`); slice `workerAgent` override;
  resolve DeepSeek V4 Flash pattern question against `model-resolver.ts`/`model-roles.ts`;
  force `task.prewalk` off for roadmap workers; run ONE live slice behind `OMP_ROADMAP_LIVE=1`.
- Tests: `resolveAgentModelSelection` returns distinct orchestrator vs worker models;
  live single-slice run reaches `worker_finished` with valid report.
- Acceptance: live run evidence (report + resolved models logged) on the 1-slice fixture.
- Gate to M5: model matrix documented (which agent → which model, override examples).

### M5 — Verifier + orchestrator loop (headless, mocked workers)

- Objective: `runRoadmapLoop()`: claim→spawn→verify→persist→repeat with retries + abort.
- Files: NEW `src/roadmap/verify.ts`, `src/roadmap/loop.ts` (+ tests). Reuse:
  `cleanse/loop.ts:71` structure, `tools/eval.ts` later, `TodoTracker` for transcript display.
- Dependencies: M2 (store), M3 (worker), M4 (agent).
- Tasks: command-step verifier (cwd/timeout/exit-0, capped logs); `Verdict` persistence;
  fail→retry (`attempts<=maxRetries`)→terminal-fail-continue; `AbortController` wiring;
  transcript-thin summaries (§8.4); exit codes 0/1/2/3.
- Tests: mocked-worker loop: all-pass; fail-then-pass on retry; exhausted-fail continues;
  abort mid-slice → `aborted`; resume preamble demotes `running→pending`.
- Acceptance: 3-slice mocked fixture ends `done/done/failed-terminal` with correct events.
- Gate to M6: loop semantics frozen (CLI is a thin wrapper after this).

### M6 — CLI command + resume + status

- Objective: `omp roadmap` usable end-to-end by a human.
- Files: NEW `src/commands/roadmap.ts`; EDIT `src/cli-commands.ts:22` (register);
  NEW `.omp/roadmap.yml` support in `store.ts`/`verify.ts`; `status` subcommand.
- Dependencies: M5.
- Tasks: flags `--roadmap/--run/--resume/--slice/--dry-run/--max-retries`;
  `--resume` crash-recovery path (§14); `status` read-only dump; help text +
  `launch-help.ts`-style flag docs; SIGINT/SIGTERM handling per `cleanse/index.ts:231`.
- Tests: CLI arg parsing; `--dry-run` spawns nothing; `--resume` on M5's aborted fixture
  completes; `status` output matches store.
- Acceptance: abort-then-`--resume` live (mocked) run finishes; `status` correct.
- Gate to M7: command UX frozen.

### M7 — Live 3-slice pilot + hardening

- Objective: full live pilot on a real repo fixture; fix what reality breaks.
- Files: EDIT anywhere `roadmap/` per findings; NEW fixture roadmap + `.omp/roadmap.yml`
  example; docs snippet (usage, model matrix, recovery runbook).
- Dependencies: M6.
- Tasks: run 3-slice live pilot (`OMP_ROADMAP_LIVE=1`): implement→verify→resume-after-kill;
  measure orchestrator transcript growth (assert sublinear); tune budget caps/retries;
  drift-detection (`--rebase` still deferred — document the limitation).
- Tests: live pilot script (manual gate, not CI); regression tests for every bug found.
- Acceptance: pilot reaches all-`done` (or honest terminal-`failed` with evidence);
  kill-mid-run + `--resume` completes without re-doing `done` slices; transcript stays thin.
- Project exit: this plan's STOP condition lifts only here — and only by explicit instruction.

## 17. Risks

1. **Prompt-injection via roadmap file** — roadmap is human-authored but becomes worker system
   content; sanitize trailers, never interpolate raw bodies into privileged scopes.
2. **Isolation default** — M1–M7 run workers in-place (like `WorkPool` default); file damage
   from a bad worker is real. Mitigate with small slices + verify gates; isolation backend
   (`isolation-runner.ts`) is opt-in per slice later.
3. **Cost overrun** — live workers × retries × strong-model fallback chains; cap with
   `maxRetries` default 1, budget caps, `--dry-run` default-first docs.
4. **Store corruption** — concurrent runs; mitigated by `O_EXCL` lock + tmp+rename, but NFS or
   editors touching `.omp/roadmap/` can still surprise. Status command must detect mismatch.
5. **Upstream drift** — omp is pre-1.0-ish fast-moving (`v18.1.10`); `runStructuredSubagent` /
   settings keys may rename. Pin version in plan header; re-grep symbols at each milestone.
6. **Transcript growth** — the failure mode being solved; enforce §8.4 summaries + a CI-style
   assertion on orchestrator context usage in M7.
7. **Monorepo unknowns** — test harness path, `markit/` AST fit, lock-helper existence, custom
   model-string binding all flagged UNKNOWN; each has a named milestone tasked to resolve it.

*End of plan. STOP — no implementation without explicit instruction.*

