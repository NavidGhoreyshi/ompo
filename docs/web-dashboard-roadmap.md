# OMPO Web Dashboard — Development Roadmap

> Status: proposed roadmap for the `ompo` web operator dashboard.
>
> This roadmap adds a browser-native operator surface to OMPO while preserving
> the existing TUI, CLI, durable store, event log, and orchestration engine.
>
> The browser is a **presentation/control surface**, not a second orchestration engine.
>
> Target product shape:
>
> `ompo` → local web dashboard
> `ompo --tui` → existing terminal UI
> Existing CLI commands remain unchanged and continue to work headlessly.

### Operator notes (alignment with current tree — read before running)

- Run it with an explicit path (this file is not the default `ROADMAP.md`):
  `ompo plan --roadmap docs/web-dashboard-roadmap.md`,
  then `ompo run --roadmap docs/web-dashboard-roadmap.md --dry-run`,
  then `ompo run --roadmap docs/web-dashboard-roadmap.md`.
- Slice ids (`w0a`…) are stable. Rename titles freely, never rename ids after a run starts.
- **Agent trailers:** the original draft specified `Agent: opus` on every slice.
  That is not a valid ompo routing: `Agent:` must be a built-in (`task`, `sonic`),
  an `agentModels:` key from `.omp/roadmap.yml`, or a model pattern containing
  `/`, `:`, `.`, `_`, or `-` (see `src/lint.ts` `unknown-agent`). A bare `opus`
  would only warn and fall back to `workerModel` — which is already the strong
  paid pool (`opencode-go/muse-spark-1.3-contributor` → fallbacks in
  `templates/roadmap.yml.example`). Since every slice named the same agent, it
  carried no per-slice signal, so the trailers are omitted: all slices inherit
  `workerModel`. If a slice later needs a different model, add an `agentModels:`
  entry plus a per-slice `Agent:` key then.
- **Depends trailers** accept only slice ids (space-separated). Prose
  dependencies from the draft ("existing `src/planPreview.ts`", "all core
  dashboard views") are normalized to id-only trailers here; the prose lives in
  the slice bodies. `w5a` fans in from every view-branch leaf so "all core
  views" is structural, not a comment.
- **Verify trailers** must be executable shell gates (exit 0 required) — prose
  such as "build the web client" cannot be a gate. Every slice carries the
  canonical gates plus, where packaging is the point, a real binary-compile
  gate. All other acceptance prose stays in the body for the worker and the
  post-merge reviewer (who re-runs the load-bearing gate on the merged tree).
- **Breaking-default flag:** bare `ompo` currently launches the unified TUI
  (`src/cli.ts`, `src/unified.tsx`). `w0b` redefines bare `ompo` as the web
  dashboard and moves the TUI to `ompo --tui` — a deliberate breaking change to
  the default entry. `w0b` and `w5e` must update help text, the unified flow,
  and `README.md` together; `w5c` proves the old commands still work.
- `w0a` produces exactly one new doc: `docs/web-dashboard-architecture.md`
  (pinned name — do not confuse with this roadmap file). No runtime behavior
  changes outside the new web architecture until `w0b`.
- `Files:` is an advisory allowlist (repo-relative, space-separated, one line).
  Paths that do not exist yet (`src/server.ts`, `src/api/`, `web/`) are
  expected — the slices create them.

### Explicitly Deferred

Do NOT add these as part of the web-dashboard roadmap: remote/shared
dashboard hosting, authentication / multi-user accounts, cloud deployment,
WebSocket infrastructure, Next.js migration, Redis/Postgres just for the
dashboard, automatic model selection/tuning, predictive ETA, predictive cost
forecasting, sophisticated scheduling algorithms, automatic import inference,
per-slice PR automation, secret-scan redesign, fs.watch/incremental store
architecture, browser-based roadmap editing, browser-based terminal shell,
arbitrary filesystem browsing, full remote execution control, multi-run
comparison, advanced activity query DSL. These can be considered later based
on real usage. (Kept here in the preamble so no slice body carries non-slice
spec; enforce by rejecting any slice that pulls these in.)

### Release principle

The browser dashboard is a **new operator surface over the existing OMPO
engine**, not a new engine. The desired product shape is bare `ompo` for the
rich local browser dashboard, `ompo --tui` for the terminal-native operator
interface, and `ompo <existing CLI commands>` for the automation / scripting /
CI interface. All three surfaces must remain projections of the same durable
state and event history.

## [w0a] Web architecture reconnaissance and API contract

### Goal

Before implementing the browser UI, map the current store/query/event/control
seams and define the smallest browser-facing API contract. Do not implement the
dashboard yet.

### Requirements

Survey the owning modules fully before editing. Produce and commit the
architecture needed for later slices:

1. Identify existing functions that can serve browser queries without
   duplicating state reconstruction.
2. Identify which existing structures must remain internal and which need
   browser-safe DTOs.
3. Define the browser read model for runs, run summaries, slices, slice
   detail, agents, events, and stats.
4. Define the control request contract for retry, skip, park, kill, pause,
   resume, and jobs +/-.
5. Confirm that browser mutations reuse the exact existing
   `control_requested` path (see `src/control.ts`).
6. Define the live-update strategy: HTTP for normal reads, HTTP POST for
   control mutations, SSE for live event delivery. No WebSockets unless the
   implementation proves SSE insufficient.

### Decision

The browser must never read `.omp/` directly. The browser must never mutate
`roadmap.json`, `events.jsonl`, or cursor state directly. The server owns
access to the store and artifacts. Do not create duplicate domain models when
an existing type can be reused.

### Required design output

Write `docs/web-dashboard-architecture.md` covering API endpoints, DTO shapes,
event stream semantics, control request semantics, static asset strategy, the
localhost security boundary, and development vs compiled-binary asset loading.

### Acceptance

The architecture note is internally consistent with the durable-store
invariants, `rebuildStatusesFromEvents`, existing control intents, existing
stats/forensics/query paths, and current TUI semantics. No runtime behavior
changes outside the new web architecture.

Effort: hi
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: test -f docs/web-dashboard-architecture.md
Files: src/cli.ts src/store.ts src/log.ts src/stats.ts src/forensics.ts src/control.ts src/runReports.ts src/types.ts src/watch.tsx src/run.tsx src/unified.tsx package.json tsconfig.json

## [w0b] Web build system and local dashboard server

### Goal

Make bare `ompo` start a local browser dashboard. Keep `ompo --tui` as the
existing unified TUI.

### Requirements

Create the browser client using the project's existing React stack. Use Vite
for browser bundling unless the architecture survey (`w0a`) identifies a
concrete reason not to. Do not introduce Next.js, SSR, server components, or a
second Node runtime. Runtime remains Bun.

Add a local HTTP server responsible for serving dashboard assets, serving API
routes, exposing the live event stream, and accepting control POSTs.

Support all of:

```bash
ompo
ompo --port 4317
ompo --no-open
ompo --tui
```

`--no-open` prevents browser launch but still starts the server. Print the
resolved URL clearly. Default host is `127.0.0.1` with an automatically
selected available localhost port.

### Security

Never bind `0.0.0.0` by default. Do not expose arbitrary filesystem access. Do
not create an endpoint equivalent to `GET /api/files/*` that can expose
arbitrary `.omp` contents. Serve only explicitly supported data.

### Binary requirement

The compiled binary must serve the dashboard without relying on the source
tree being present. Choose one explicit asset strategy — embedded assets, or
packaged assets with a deterministic runtime lookup — and test the actual
compiled binary. This slice must update CLI help, the unified flow, and the
entry behavior together: bare `ompo` serves the dashboard, `ompo --tui` keeps
the existing terminal UI, and every non-web command is unchanged.

### Acceptance

`ompo`, `ompo --port 4317`, `ompo --no-open`, and `ompo --tui` all work.
Existing non-web commands remain unchanged.

Depends: w0a
Effort: hi
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun build --compile src/cli.ts --outfile /tmp/ompo-web-smoke
Files: src/cli.ts src/server.ts src/web web package.json tsconfig.json .gitignore

## [w1a] Read API — runs, slices, agents, and events

### Goal

Expose a stable browser read API over the existing durable store and
artifacts.

### Endpoints

Implement the smallest set needed for the first dashboard:

```text
GET /api/runs
GET /api/runs/:runId
GET /api/runs/:runId/slices
GET /api/runs/:runId/slices/:sliceId
GET /api/runs/:runId/agents
GET /api/runs/:runId/events
```

Do not expose raw internal filesystem paths unless already intentionally
surfaced by existing forensics behavior.

### Data

The API must provide enough information to render run status,
completed/running/failed/blocked/pending counts, worker count, selected slice,
attempt, generation, effort, dependencies, verify status, agent/lane,
durations, token usage where available, review status, recent events, and
artifact availability. Reuse existing state reconstruction instead of
reimplementing it in the browser.

### Testing

Use the existing fixture conventions (`mkdtempSync(...)`, `parseRoadmap(...)`,
`createRun(...)`, `storeApi.*`, `readEvents(...)`). Assert observable values.
Do not write source-text tests.

Depends: w0b
Effort: hi
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: src/server.ts src/api src/store.ts src/stats.ts src/forensics.ts src/log.ts web/src/lib

## [w1b] Live event stream with SSE

### Goal

Make the browser react to OMPO activity without polling the entire state from
the browser.

### Requirements

Expose `GET /api/runs/:runId/events/stream` using Server-Sent Events. The
stream carries existing event semantics rather than inventing
browser-specific event names. At minimum support slice claimed, generation
started/completed, worker progress where already represented, verify events,
review events, control requested/applied/rejected, slice
completed/failed/blocked, and run status changes. The browser uses the event
to trigger a targeted state refresh rather than reconstructing the entire run
independently.

### Constraints

Do not change the durable event format just to support the browser. Do not add
a second event bus. Do not introduce WebSockets.

Depends: w1a
Effort: med
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: src/server.ts src/api/events.ts src/log.ts src/store.ts web/src/lib/events.ts

## [w1c] Control API

### Goal

Allow browser operators to use the existing control plane.

### Endpoint

```text
POST /api/runs/:runId/control
```

Supported operations: retry, skip, park, kill, pause, resume, set-jobs.

### Critical invariant

The browser must not apply controls directly. It enqueues through the same
control intent path already used by the TUI and `ompo ctl`:

```text
Web -> control_requested -> existing loop -> control_applied / control_rejected
```

Existing safe points and status guards remain authoritative.

### Acceptance

Demonstrate that browser retry behaves exactly like CLI retry, stale
operations reject, control events remain replayable, no duplicate execution
can occur, and TUI and web operate correctly against the same live run.
Extend `tests/control.test.ts` with the browser-path integration and
stale-intent rejection cases rather than starting a parallel control spec.

Depends: w1a
Effort: med
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: src/api/control.ts src/control.ts src/server.ts tests/control.test.ts web/src/lib/api.ts

## [w2a] Dashboard shell and navigation

### Goal

Establish the browser-native visual system.

### Design direction

Dark, technical, dense-but-readable, with restrained semantic accents: cyan
for active/running, green for done/passed, amber for warning/blocked, red for
failed, muted for pending/secondary. Do not reproduce the TUI literally. The
browser should exploit larger horizontal and vertical space, hover/focus
interactions, expandable detail, rich code display, and graph visualization.

### Global shell

Desktop structure is Header, Sidebar, Main workspace, Inspector, Activity.
Navigation covers Overview, Runs, Roadmap, Agents, Stats. Control stays
accessible from context rather than becoming a permanent giant menu.

### Responsive requirements

Desktop is primary. At narrower browser widths collapse the sidebar, move the
inspector below or over main content, preserve readable tables, and never
create accidental horizontal overflow. This is browser responsiveness, not the
TUI's narrow-terminal behavior.

Depends: w1c
Effort: hi
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/App.tsx web/src/components web/src/pages web/src/styles scripts

## [w2b] Run overview and slice board

### Goal

Create the browser's primary operating view.

### Header

Show real observed values only: total slices, done, running, failed, pending,
active workers, elapsed time, and authoritative token usage where available.
Do not add ETA, slice/hour forecasts, estimated completion percentage,
estimated cost, or model-success prediction unless supported by authoritative
data.

### Board

Columns may include ID, Title, Effort, Depends, Verify, Status, Attempt,
Generation, Agent, Duration, with compact secondary metadata. Rows must remain
visually scannable. Selecting a slice drives the Inspector.

### Status presentation

Use symbol plus text plus semantic styling. Never rely on color alone.

Depends: w2a
Effort: hi
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/pages/Overview.tsx web/src/components/RunHeader.tsx web/src/components/SliceTable.tsx web/src/lib

## [w2c] Inspector — Output / Diff / Verify / Review / Prompt / Events

### Goal

Make the Inspector the strongest part of the web UI. Keep the six concepts
already established by the TUI (Output, Diff, Verify, Review, Prompt, Events)
without copying the terminal presentation.

### Output

Human-readable execution summary: status, attempt, generation, duration,
token usage where authoritative, summary, handoff history. Raw JSON and log
noise must not dominate this view.

### Diff

Render changed files, diff stat, syntax-highlighted unified diff, and
expandable hunks. Reuse existing forensics semantics.

### Verify

Render gates as structured rows of gate, status, and duration, including
failure details and previous-gate context where available.

### Review

Show verdict, severity, findings, touched files, review notes, and fix-lane
history where applicable.

### Prompt

Show generation, model, prompt metadata, expandable prompt, and
continuation/handoff information.

### Events

Searchable and filterable slice-specific events.

### Critical UI rule

Do not turn Output into a raw artifact dump. Human-readable information
belongs in primary presentation. Raw forensic information remains available
through Events and full detail.

Depends: w2b
Effort: hi
Timeout: 60m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/components/Inspector.tsx web/src/components/OutputView.tsx web/src/components/DiffView.tsx web/src/components/VerifyView.tsx web/src/components/ReviewView.tsx web/src/components/PromptView.tsx web/src/components/EventsView.tsx

## [w2d] Live activity and terminal panels

### Goal

Turn Activity into a genuinely useful browser event stream.

### Activity

Display events with timestamp, lane/worker, event type, slice, and concise
event details. Filters: All, Worker, Verify, Review, Control, System. Search
with a `Search events...` input. The stream updates automatically through SSE.

### Terminal

Provide a dedicated raw worker/command view. Keep it secondary to the
structured Activity view.

Depends: w2c
Effort: med
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/components/Activity.tsx web/src/components/Terminal.tsx web/src/lib/events.ts

## [w3a] DAG visualization

### Goal

Render the roadmap dependency graph natively for the browser.

### Requirements

Use the same dependency semantics as `readySlices()`, `depSatisfied()`, and
existing lint/replay logic. Do not create an alternate dependency
interpretation. Nodes show slice ID, title, state, and selected state. Edges
represent `Depends:`. Selecting a node selects the corresponding slice and
Inspector.

### Important

Prefer SVG/HTML rendering before adding a graph library. Only add a
dependency if the actual graph complexity proves it necessary. Cycle and
unknown-dependency states must render safely and visibly.

Depends: w2b
Effort: hi
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/components/Dag.tsx web/src/lib/dag.ts

## [w3b] Agents / concurrency view

### Goal

Make concurrency understandable at a glance. Show lane, slice, state,
generation, duration, usage where available, and mutex holder. Clicking an
agent selects its slice. Do not create a second agent-state model.

Depends: w2b
Effort: med
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/pages/Agents.tsx web/src/components/AgentCard.tsx

## [w3c] Timeline / execution history

### Goal

Expose temporal execution information that is awkward in the TUI: attempt
boundaries, generation boundaries, retries, duration, concurrent execution,
and long-tail slices. Hover or click can reveal attempt, generation, tokens,
and duration. This is observational only. Do not derive fake progress
percentages.

Depends: w2b w1a
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/components/Timeline.tsx web/src/lib/timeline.ts

## [w3d] Usage and generation accounting

### Goal

Expose authoritative model usage without inventing estimates. Per run show
Input, Output, Cache read, Reasoning, Total, and Cost. Per slice/generation
where available show generation token usage, generation duration, and
generation cost. Unknown values render as unavailable.

### Requirements

Build on the existing context-generation and handoff implementation (see
`src/handoffs.ts` and the run artifact layout). Verify exactly what the
underlying `omp --mode json` usage fields represent before labeling them. Do
not invent missing usage, ETA, cost estimates, or projected burn. Use real
`--mode json` usage fixtures where available and generation usage fixtures
otherwise.

Depends: w2c
Effort: med
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/components/Usage.tsx web/src/components/Inspector.tsx

## [w4a] Roadmap view and planner preview

### Goal

Expose planning transparency in the browser. Show files surveyed, slices
proposed, IDs, titles, Effort, Verify, dependencies, warnings, and blocking
errors. Clearly distinguish READY, WARNING, and BLOCKED.

### Actions

Allow Accept, Reload from disk, Open ROADMAP, and Abort. Reuse the existing
plan/lint structures in `src/planPreview.ts` — do not create a separate
roadmap representation. No in-browser editor behavior is required.

Depends: w2a
Effort: hi
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: src/planPreview.ts src/server.ts src/api web/src/pages/Roadmap.tsx web/src/components/PlannerPreview.tsx

## [w4b] Runs history and run selection

### Goal

Create a useful historical run browser. Show run ID, status, started,
duration, slice counts, retries, handoffs, tokens, and cost when
authoritative. Selecting a run switches the entire workspace to that run. Do
not add run comparison yet.

Depends: w2a w1a
Effort: med
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/pages/Runs.tsx

## [w4c] Stats and historical observability

### Goal

Expose existing stats/query functionality through the browser. Show observed
metrics: pass rate, average attempts, average duration, average turns,
average tools, average tokens, top failing gates, model fallback counts, and
handoffs. Do not create a second statistical engine — reuse the existing
stats/query logic in `src/stats.ts`.

Depends: w4b
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/pages/Stats.tsx src/stats.ts

## [w5a] Final control UX

### Goal

Polish control actions without creating new semantics. Contextual actions:
Pause, Resume, Retry, Skip, Park, Kill, Jobs +/-.

### Depends note

The trailer fans in from every view-branch leaf (`w2d`, `w3a`, `w3b`, `w3c`,
`w3d`, `w4c`), which transitively covers the whole dashboard — that fan-in is
the structural form of the draft's "all core dashboard views" dependency.

### Safety

Destructive actions require clear confirmation where appropriate. The
confirmation UI still calls the same control API. Display pending, rejected,
and applied state from actual events. Do not optimistically claim success
before the orchestrator confirms it.

Depends: w2d w3a w3b w3c w3d w4c
Effort: med
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src/components/Controls.tsx web/src/components/SliceActions.tsx

## [w5b] Browser/TUI consistency audit

### Goal

Ensure there is one OMPO system with multiple operator surfaces. Run
identical fixtures through TUI, Web, and CLI, and verify they agree on slice
status, attempt, generation, dependencies, verify result, review status,
control result, run status, and event history. The web UI must not invent
behavior that the TUI/CLI does not understand. Do not duplicate business
logic merely to make the web implementation convenient. Share state and query
helpers where the surfaces diverge.

### Depends note

Depends on `w5a`, which transitively covers every view slice — one edge
carries the draft's "all dashboard implementation slices" dependency without
a fragile ever-growing list.

Depends: w5a
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src src/api src/store.ts src/control.ts tests

## [w5c] Compiled-binary packaging and release hardening

### Goal

Make the web dashboard a real part of the shipped OMPO executable. Verify
`./ompo`, `./ompo --tui`, `./ompo --port 4317`, `./ompo --no-open`, and the
existing commands (`./ompo status`, `./ompo plan`, `./ompo run --dry-run`,
`./ompo stats`, `./ompo doctor`) still work. The binary remains gitignored —
no generated binary is committed.

Depends: w5b
Effort: med
Timeout: 45m
Retries: 1
Verify: bun install
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun build --compile src/cli.ts --outfile /tmp/ompo-web-smoke
Files: package.json src/cli.ts src/server.ts web .gitignore

## [w5d] Web UI visual QA captures and final polish

### Goal

Finish the dashboard based on objective evidence rather than speculative
feature additions. Cover these browser scenarios: running run, completed run,
failed run, blocked dependency, blocked environment, multiple concurrent
workers, multiple generations / context handoff, failed Verify with multiple
gates, minor review fix, major review rejection, populated diff, populated
review, populated events, DAG, timeline, narrow browser width, long output,
empty output, pause/retry/skip/kill control states. Also regenerate existing
TUI captures after any shared-layout change.

### Important

Do not add new product functionality in this slice. Polish and bug-fixing
only. Extend `captures/` only if intentionally adding web captures; TUI
captures regenerate via the existing generator.

Depends: w5c
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: web/src scripts captures

## [w5e] Documentation and operator workflow

### Goal

Document the browser dashboard as a first-class OMPO operator surface. Update
the user manual with `ompo`, `ompo --tui`, `ompo --port 4317`, and
`ompo --no-open`. Document the local-only default, controls, dashboard views,
live updates, TUI fallback, compiled-binary behavior, browser limitations,
and no remote access by default. Do not duplicate the entire architecture
documentation — link `docs/web-dashboard-architecture.md`.

Depends: w5c
Effort: med
Timeout: 30m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Files: README.md docs package.json

## [w5f] Web dashboard release gate

### Goal

Final gate over the whole dashboard. Representative checks: compiled `./ompo`
browser smoke, compiled `./ompo --tui` smoke, representative
`ompo run --dry-run`, representative control path, representative replay path,
representative planner path.

### Acceptance criteria

The following architecture must remain true:

```text
OMPO ENGINE -> durable store + events -> Web / TUI / CLI
```

The web UI does not own orchestration state, does not write the store
directly, does not parse `.omp/` independently, does not duplicate
dependency/retry/review/control semantics, uses the existing control plane,
uses the existing event model, remains localhost-only by default, and works
from the compiled binary. The TUI remains fully usable through `ompo --tui`.
Bare `ompo` opens the browser dashboard. Existing headless/CI workflows
remain intact.

Depends: w5a w5b w5c w5d w5e
Effort: med
Timeout: 30m
Retries: 1
Verify: bun install
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun build --compile src/cli.ts --outfile /tmp/ompo-web-smoke
Files: src/cli.ts src/server.ts web package.json

