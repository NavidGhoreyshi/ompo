# Web dashboard — design and implementation (as built)

Companion to `web-dashboard-architecture.md`, which is the browser API
contract. This note describes how the dashboard is actually implemented:
how it starts, what the server does, how the React app is structured, how
data flows and stays fresh, how it is built and shipped, and which tests
pin it. Paths are repo-relative; backend line references are approximate.

## 1. Running it

Bare `ompo` (no subcommand) serves the dashboard (`src/cli.ts`,
`cmdDashboard`): binds `127.0.0.1` by default on an ephemeral port
(`--port`, `--host`, `--no-open` override), prints the URL plus the asset
mode, opens a browser, and stops on SIGINT/SIGTERM. Binding `0.0.0.0`
prints a no-auth warning. `projectDir` comes from `--project`/cwd — never
from the client.

The dashboard is read-mostly: the mutation surfaces are
`POST /api/runs/:runId/control` (plus the plan accept/abort/edit decision,
§4) and `POST /api/runs/:runId/resume`, which spawns a detached resume loop
for a quiescent run — the explicit consent boundary, since bare `ompo` never
claims slices. There is deliberately no shell, file-write, replan, or
checkout endpoint.

## 2. Backend: `src/server.ts` (Bun.serve)

One file owns HTTP: static SPA serving, the read-model API, the SSE
stream, and control POST. Key constants: `POLL_MS = 900` (SSE store poll,
same cadence as the TUI), `HEARTBEAT_MS = 15_000` with `IDLE_TIMEOUT_S =
60` (Bun's default 10s idle timeout used to kill the stream before the
first heartbeat — the timeout must exceed the heartbeat), `LOG_MAX = 500`
/ `LOG_DEFAULT = 50`, events page default 200 / max 2000.

### 2.1 Static assets: embedded-first

`GET /` serves the SPA shell; `/api/*` is reserved and every other path
falls back to `index.html` (client routes). Asset resolution order:

1. `EMBEDDED_WEB_DIST` from `src/webAssets.generated.ts` (committed,
   base64, produced by `scripts/embed-web.ts` — §6),
2. `web/dist/` on disk (dev flow),
3. neither → `/` returns plain-text 503 naming the build command while
   `/api/*` keeps working. API availability never depends on assets.

The server reports its mode (`embedded` / `disk` / `missing`) at startup.
The App compares its build-time `VITE_OMPO_VERSION` (when set) against
`/api/health` and shows a stale-banner on mismatch.

### 2.2 Read endpoints (all GET, all read-only)

Every endpoint resolves the run through the same guards: `runId` charset
`[A-Za-z0-9_-]+` (else 400), known run (else 404), `sliceId` in the cursor doc
(else 404 `unknown slice "<id>"`). All projections reuse the existing seams —
the server invents no domain model:
| `/api/health` | `{ ok, version }` |
| `/api/runs`, `/runs/latest`, `/runs/:runId` | `listRuns` / `loadRun` shaped into `RunSummary` / `RunDetail`; `live = lockHeld(...)` |
| `…/slices`, `…/slices/:sliceId` | cursor `SliceLine` → `SliceSummary`; `showSlice` → `SliceDetail` (same caps as the TUI inspector) |
| `…/slices/:id/log?tail=N` | `sliceTranscript` → `{ name, lane, lines }` — newest stage transcript (worker/debug/review/review-fix lane file, or a running gate's `logs/verify-<n>.log`) |
| `…/slices/:id/diff` | `diffSliceBranch` (`DIFF_CAP` 20000) |
 | `…/agents` | `agentStates`-style derivation from published lines (point-in-time, never persisted) |
 | `…/sessions` | `listSessions` → run-level unblock rounds + per-slice debug sessions (`running` = prompt without completion footer) |
 | `…/sessions/:name/log?tail=N(&slice=X)` | `tailSessionLog` → `{ name, lines }`; strict name dispatch, no paths |
| `…/events?afterSeq&types&sliceId&limit` | `readEvents` page + `offset` (drain rule: max seq seen) |
| `…/stats`, `…/query?q`, `…/replay` | `computeStats`, `queryEvents`, `replayRun` verbatim |
| `/api/plan/preview`, `/plan/roadmap`, `POST /plan/decision` | `buildPlanPreview` over `ROADMAP.md`; accept/abort/edit validated against current disk state (blocked plans can never be accepted) |

`RunSummary` carries server-derived rollups the header needs without extra
round trips: TUI-shape `counts`, `workers`, `status`, `retries`,
`handoffs`, and authoritative `tokens`/`cost` (sums over
`worker_finished` stats; `null` when unreported — the UI renders "—",
never 0). `SliceDetail` carries capped `reportSummary`/`reportFull`,
verdict steps (≤ 6), review, 30-line `promptTail`, 60-line `workerTail`,
`recentEvents` + `history`, per-generation spend, and artifact presence
flags. Unknown/absent stays absent; endpoints return 200 + partial bodies,
not 500s.

### 2.3 Event stream (SSE, no WebSockets)

`GET /api/runs/:runId/events/stream` (`…/stream` is a legacy alias).
The channel is server→client only; control returns over POST. Semantics:

- `?afterSeq=N` (or `Last-Event-ID`) replays `readEvents` with `seq > N`
  in order, then tails; each message `id:` is the event `seq`.
- The 900ms store poll emits one `event:` frame per `RunEvent` (JSON);
  `: ping` heartbeat every ~15s; a periodic `run:` meta frame carries
  `live = lockHeld` (liveness rides the meta channel, not the event
  channel).
- Clients dedup on `seq` and advance to max-seen; reconnect replays from
  the last seen seq (at-least-once, idempotent apply). Plain
  `GET …/events?afterSeq=N` polling yields identical state — SSE is an
  optimization, not a second model.

### 2.4 Control POST and resume POST (the only mutations)

`POST /api/runs/:runId/control` takes `ControlIntent` verbatim and reuses
exactly the `control.ts` path (`validateIntent` → `requestControl` →
loop drain → `applyIntent`), so CLI, TUI, and browser agree by
construction:

- Validation failures are 400 with the validator message; unknown slice
  is 404.
- Live run (lock held): appends `control_requested`, returns
  `202 { seq, kind, sliceId?, applied: "queued" }`. The client watches its
  outcome (`control_applied` / `control_rejected`) on the event stream by
  correlating `seq`. Nothing is reported as success before the loop
  appends the outcome.
- Quiescent run: drains synchronously (`latestSeq` → `requestControl` →
  `drainIntents` → `applyIntent`) and returns `200 { ok, message,
  applied: "direct" }`.
- Loop-local kinds (`set-jobs`/`pause`/`resume`) need a live loop and are
  rejected *before* appending, so the log never holds an outcome-less
  `control_requested`. The rejection is `quiescentLoopLocalRejection`
  (shared with `ompo ctl`): it names the recovery verbatim —
  ``ompo resume --run <id>`` — because loop-`resume` and run-`resume`
  share a name and a bare "needs a live loop" sends operators back to the
  same doomed button.

`POST /api/runs/:runId/resume` spawns a detached `resume --run <id>` loop
(same `cmdRun` path as the CLI; headless without a TTY, chatter to
`resume-<ts>.log` in the run dir via the exported `runDir` builder). Unknown
run is 404, live run is 409, cross-origin is 403; success is `202 { ok,
applied: "spawned", pid, log }`. Single-flight rides the run lock. The
spawner is a `DashboardOptions.spawnResume` seam so tests stub it and never
launch real workers. Runs table rows (quiescent only) and the inspector Run
group offer it as a Resume button; liveness settles through existing
channels (`live` flips, `run_resumed` lands on SSE).

### 2.5 Security boundary

Loopback-only by default; cross-origin writes denied (`Origin` check on
POST, no wildcard CORS); `nosniff` + restrictive CSP; no cookies or
tokens. Client-supplied ids are charset-checked and all file access goes
through `store.ts`/`forensics.ts` path builders — no client paths, no
`..`. Read endpoints inherit the TUI caps (log tail, diff cap, inspector
caps).

## 3. Frontend: `web/` (React + Vite + Tailwind v4 + shadcn primitives)

Entry: `web/src/main.tsx` mounts `App` with two stylesheets:
`web/src/styles/tokens.css` first (Tailwind v4 + shadcn theme tokens mapped
to the charcoal-navy palette, dark-first via `:root` and `.dark`), then
`web/src/styles/theme.css` (viewport app shell + `omp-` composition
classes). Self-contained bundle: local woff2 fonts, no CDN — the dashboard
works offline like the TUI. `web/components.json` is the shadcn config
(`new-york` style, `neutral` base, `lucide` icons) so future `shadcn add`
commands land in `web/src/components/ui/`; `web/src/lib/utils.ts` is the
`cn()` helper. `web/src/api.ts` is the typed client; its interfaces mirror
§2.2 (`RunSummary`, `SliceDetail` with capped fields, `AgentRow`,
`ControlQueued`/`ControlDirect`, plan envelope). `vite.config.ts` builds to
`web/dist/` (Tailwind v4 vite plugin, `@` → `web/src`); dev proxies `/api`
to a local server on 127.0.0.1:4317. `web/src` has no separate tsconfig —
it ships via the vite build, not `tsc`.

### 3.1 `App.tsx`: state ownership and freshness

`App` owns all shared state: `runs`, `runId` (defaults to the newest
run), `detail`, `events` (capped at the last ~400), `agents`, `stats`,
`sel` (selected slice), `sliceDetail`, `view`, sidebar collapse. Data
flow rules:

- `loadRun(id)` refreshes `detail` + `events` + `stats` + `agents` in
  parallel (agents failure degrades to `[]`).
- One `EventSource` per selected run: `event` frames with `seq` newer
  than `seqRef` append to the buffer and trigger *targeted* refresh —
  the frame only signals *what* changed, board/slice state always
  re-derives from the read endpoints (`api.run`, plus `api.slice` when
  the frame's slice is the selected one). Malformed frames are ignored.
- `run` meta frames trigger a full `loadRun`. SSE error closes the
  stream and a 900ms `events?afterSeq=` poll takes over until reconnect
  (polling and SSE never both apply).
- `onControlDone` (after any control call) reloads the run so counts and
  the live flag settle even before the outcome event lands.
- Active-slice auto-selection: when `sel` is null or stale (initial load,
  run switch), one effect resolves `preferredSliceId(detail.slices)` from
  `web/src/lib/selection.ts` — the browser port of `preferredSel`
  (`src/watch.tsx`): running/verifying first, then failed/aborted, then
  blocked, then most-recently-completed done, else roadmap order. Manual
  clicks always win; the effect only fills an empty selection, so the
  Inspector is never an empty rectangle while slices exist.
- Layout (viewport app shell, no page scroll): `Header` (run picker,
  live/quiescent badge, version, Inspector toggle carrying the selected
  slice) / `Sidebar` (run-first rail, no counts) / `main` (current page) /
  `aside` Inspector (a contextual drawer, closed by default — the grid
  column animates 0 → 384px and the workspace narrows instead of being
  covered) / compact bottom `Activity` bar. `data-inspector` on `.omp-shell`
  drives the column; the closed aside is `inert` + `visibility: hidden`.
  Region scrolls: `.omp-workspace` (fallback), `.omp-modes-body`,
  `.omp-inspector`, `.omp-activity-list`, and the expanded live log;
  secondary pages scroll inside `.omp-page`. Selection changes reset
  tab-local UI state by `runId` / `sliceId` keys.
- Progressive disclosure: the Overview always shows the active worker;
  Inspector (forensics + control) and the full Activity stream are on
  demand. Selection never opens the Inspector implicitly — the auto-select
  effect only fills the selection; `inspect(sliceId)` (board row, lane, DAG
  node, attention chip) selects *and* opens the drawer.

### 3.2 Pages (`web/src/pages/`)

 - `Overview` — a focused operator workspace in three bands, top to bottom:
   1. `RunHeader` run hero: run id + live/quiescent, then the auto-selected
      slice as `● id title STATUS`, then a `generation · attempt · lane ·
      action` line from `heroAction` (live worker line, latest slice event,
      or status fallback), then one muted telemetry line (counts, elapsed,
      tokens, workers). No rail here — the lifecycle lives with the work.
   2. `ActiveExecution` — the protagonist: `WorkerLanes` (compact switcher
      chips, only when more than one worker is live), the `PipelineStepper`
      execution spine (Claim → … → Done; the current phase is the furthest
      observed live stage — a running slice leads with Work, a verifying one
      with Verify, a finished one with Done; completed quiet, unobserved
      stages restrained outlines), and `LiveFeed`.
   3. `omp-modes` — Board | DAG | Agents over the *same* selection and one
      scroll region: `SliceTable` (state symbol, id/title, one
      attempt/gen/lane/deps meta line, blocked/failed reason), `Dag`, or
      `WorkerLanes` + `SessionsPanel` (operator sessions: unblock rounds and
      debug sessions with live tails via `useSessionLog`).
   Failed/blocked-env attention and duplicate-loop banners render between
   hero and execution. No graph in the Board mode: `Dag` appears in the
   workspace mode and in `RoadmapPage`, from one component.
- `AgentsPage` — live-worker rows (`AgentCard`: pure projection over
  server `AgentRow`; `verifying` shows the commit-mutex holder). Empty on
  quiescent runs by design — rows are point-in-time derivations, not
  persisted entities.
- `StatsPage` — `RunStats` verbatim (means, by-effort, top failing
  gates, fallbacks).
### 3.3 Inspector (`components/Inspector.tsx` + tab views)

Contextual drawer (`onClose` + header toggle; App auto-selects the subject,
and the only empty state is "no slices yet"): identity header (id, title, status symbol + word,
attempt/generation/effort/agent/deps, reason), `ExecutionTrace` lifecycle
(Claim → Generation → Work → Handoff → Verify → Review → Done from observed
state only — no predicted progress), underline tabs, contextual
`ControlPanel`, and a collapsed `Raw detail` JSON disclosure. Tabs:

1. `Output` — last-run status/attempt/duration/tokens, report summary,
   verdict signal, handoff history. No report while running: "no report
   yet — worker is active; follow live output on the Log tab".
2. `Diff` — `reportFull` file list plus branch-vs-merge-base hunks with
   terminal-style coloring, no external highlighter (`splitDiffFiles`).
3. `Verify` — gate steps with tails.
4. `Review` — reviewer verdict, findings, fix-lane history.
5. `Prompt` — generation/model metadata, prompt body, handoff briefs.
6. `Events` — slice-scoped event search + type filter, with formatted
   recent/history fallback. (Previously dead: the tab button existed but
   rendered nothing; now wired to `EventsView`.)
7. `Usage` — authoritative per-generation spend; unknown renders "—",
   never estimated or zero-filled.
8. `Log` — live tail of the slice's active stage transcript via
   `api.sliceLog`, polled every 2s while running/verifying and
   tail-pinned; settled otherwise. The server serves the newest lane by
   mtime, so the tab and the Overview's live window follow the worker's
   generation into the verify gates (a running gate streams into
   `logs/verify-<n>.log`) and into the post-merge reviewer's audit
   (`review-<n>.log`) without a slice switch. Added because the event
   stream only advances at stage boundaries (claim/handoff/finish), so a
   running slice otherwise looks dead for the whole attempt. The TUI
   needs no equivalent — it streams every lane to the terminal.

Tab buttons are underline tabs with arrow-key navigation;
`aria-selected` tracks the active tab.

### 3.4 `ControlPanel.tsx`: same contract as `ompo ctl`, no new semantics

Slice actions (retry/skip/park/kill) target the inspector selection (or
a picker when unlocked); skip/kill arm inline two-step confirm; park
requires a reason. Run actions (pause/resume/jobs 1–32) post run-scoped
intents. Outcome state derives from actual outcomes only:

- `202 queued` → pending chip (`#seq kind`) until the matching
  `control_applied`/`control_rejected` lands in the event tail
  (matched on `${kind}: ${message}` detail prefix).
- `200 direct` → applied/rejected badge with the server message. On
  quiescent runs the Run group offers a Resume run button (`POST …/resume`,
  `202 spawned` with pid/log reported inline) beside the restart command
  (``ompo resume --run <id>``) — pause/resume/jobs are guaranteed-rejected
  without a live loop, so those buttons are not offered. Slice intents
  still apply directly.
- Recent control traffic (last 4 in scope) renders from events; with no
  traffic the hint states the mode (queued-vs-direct) from the `live`
  flag.

### 3.5 Bottom strip: `Activity.tsx` + `Terminal.tsx`

`Activity` is a compact bar (46px) by default: event count, live/settled
state, and the newest three events as one-line previews (time, lane glyph,
type, concise detail) with a toggle. Opened (up to `min(46vh, 420px)`) it
becomes the full stream: timestamp, lane, type, slice, and concise detail
per row (`lib/events.ts` classifies worker/verify/review/control/system
lanes; control types always stay control) plus lane chips, text search, and
the raw `Terminal` view (full payloads in tooltips). The list scrolls
internally (newest first); the shell never scrolls for it. Both render
props — no fetching, no clocks.

### 3.6 Pure view helpers (`web/src/lib/`)

`stream.ts` (live worker-output semantics: the progress grammar
`src/worker.ts` writes → concise rows, lifecycle events ordered around the
current generation's output — rows from before the generation opener are
gated out, so a previous attempt never reads as newer than live output —
compact-window selection with a raw-output fallback, line-identity recovery
across polls, follow-from-scroll), plus
`useLiveStream.ts` (one slice's polled log + that derivation, built on
`useSliceLog`), `dag.ts` (Kahn layout + ready computation mirroring `select.ts`),
`timeline.ts` (attempt bars on a wall-clock axis from observed events
only — open attempts end at the last observed event, dashed, never
extrapolated), `events.ts` (lane classification + concise intent
rendering), `format.ts` (durations/tokens shared with TUI compact forms),
`selection.ts` (browser port of `preferredSel`: running/verifying, then
failed/aborted, then blocked, then most-recent done, else roadmap order).
All are pure and unit-tested against their `src/` counterparts
(`surface-consistency.test.ts` asserts web/TUI agreement).
### 3.7 Style, component library, and accessibility

Two layers. `tokens.css` is the shadcn token layer (semantic `background` /
`card` / `primary` / `muted` / `border` / `ring` tokens plus `success` /
`info` / `warning` status extensions, all pointing at the charcoal-navy
workstation values); `theme.css` keeps the viewport app shell and the `omp-`
composition classes the redesign tests pin. `web/src/components/ui/` holds
the shadcn primitives in use (`button`, `badge`, `card`, `tabs`,
`separator`, `input`, `select`, `skeleton`) with `lucide-react` icons —
status pills in tables, control buttons/inputs/selects, the run picker, the
board/graph and inspector tab bars, and loading skeletons. Flat execution
surfaces (board rows, hero, lanes, spine) deliberately stay flat symbol +
word, never color alone. Surfaces come from a four-step tonal ladder
(`--omp-bg` → `--omp-panel` → `--omp-raised`, plus the deeper `--omp-log`
plane the live window sits on) rather than glow, gradient, or glass;
section labels are sentence case, status words are color + glyph + word.
Viewport app shell (`100dvh`, shell clips page scroll; every region scrolls
internally); rail collapses at 1180px, shell stacks and the drawer becomes
an overlay at 900px, and the phone header drops the run label at 600px. Panels use `aria-label`s, tabs are real
`tablist`/`tab`/`tabpanel` roles (radix `Tabs` with free arrow-key nav),
control outcomes use `aria-live="polite"`, and full payloads sit behind
`title` tooltips rather than truncation.

## 4. Freshness model: what is live and what is sparse

Live (sub-second to 2s): event frames, board/detail refresh on frames,
control outcomes, Log-tab lines *while a generation runs* (see below),
plan preview reloads (manual Reload button).

Sparse by design: `events.jsonl` only advances at stage boundaries, so
mid-attempt the Activity strip is still — that is normal, not a stall.
`agents` rows and `metrics` derive from published lines/finished events.

Live worker transcript: the loop appends each rendered progress line to
`worker-<attempt>-g<gen>.log` as it happens (`formatProgressLine` in
`src/attempt.ts` is the single format site for TUI bus and file) and
appends the exit footer at generation end. `tailSliceLog`, `ompo logs
--follow`, and the Log tab all read that file, so all three went from
footer-only to live with the one change. A crashed run leaves a partial
tail; the next resume starts a new attempt file, never clobbering it.

## 5. Plan flow (beyond the run contract)

`PlannerPreview` + `/api/plan/*` implement the unified-flow preview gate
in the browser: Reload re-reads `ROADMAP.md` from disk, Accept/Abort
validate against current disk state (blocked plans can never be
accepted), Open shows raw markdown. No in-browser editing.

## 6. Build, embed, and versioning

`bun run web:build` = `vite build` → `bun scripts/embed-web.ts`, which
base64s every `web/dist/` file (typed by extension) into the committed
`src/webAssets.generated.ts` with `EMBEDDED_WEB_VERSION` pinned to the
package version at embed time. `web/dist/` itself is gitignored. Any
`web/src` change must regenerate the bundle or the served dashboard
(and the compiled `ompo` binary) won't contain it — verify by grepping
`web/dist/assets/*.js` for the new string. The App shows a stale-banner
when the bundle version differs from `/api/health`.

## 7. Tests that pin the dashboard

- `tests/web-server.test.ts` — validation/404s, quiescent direct-apply,
  loop-local rejection message naming `ompo resume --run`, SSE shape,
  stats/query/replay/slice log+diff.
- `tests/control.test.ts` — validator, request/drain round-trip,
  `applyIntent` guards, `quiescentLoopLocalRejection` unit + HTTP
  end-to-end (rejection carries the recovery command, no orphan events),
  live-run queue parity with `ompo ctl` semantics.
- `tests/release-gate.test.ts` — CLI and HTTP agree (direct vs queued,
  identical 400/404s, lock-gated queueing).
- `tests/surface-consistency.test.ts` — control results, event history,
  DAG/ready/depth, and duration formatting agree across CLI, TUI
  helpers, and web helpers; no invented scheduler or display semantics.
- `tests/read-api.test.ts` — slice detail envelope (artifact flags,
  tails, metrics-absent contracts).
- `tests/web-dashboard-redesign.test.ts` — dashboard behavior: the
  `preferredSliceId` order (running/verifying, failed, blocked,
  most-recent done, roadmap order), the `heroAction` line per status, and
  the execution spine's current stage (running → Work, verifying → Verify,
  finished → Done, unclaimed → none). Layout and rendering are e2e's job —
  nothing here asserts CSS or component source text.
- `tests/live-stream.test.ts` — the live window's semantics: the progress
  grammar → semantic rows, line identity across polls, generation-scoped
  event ordering, the ~5-row compact window, raw-line rendering, and
  follow-from-scroll.
- `scripts/web-qa.ts` + `scripts/gen-captures.ts` — structural DOM
  captures under `captures/` (regenerate after UI changes). The narrow
  CSS contract pins the viewport shell (100dvh + hidden page scroll +
  internal panel scroll + 900px stacked breakpoint).
- `scripts/web-captures.ts` — browser screenshots of five Overview states
  (`captures/web-overview-*.png`) for human visual review; run after
  `bun run web:build`, since the fixture server serves the embedded bundle.
- `bun run test:e2e` (`tests/e2e/`, Playwright + Chromium) — real-browser
  suite over a fixture server (`serve.ts`) with overflow-stressing strings
  (200-char titles, unbroken reason/log tokens). `overview.e2e.ts` covers
  the redesigned surface as behavior: the auto-selected worker, the
  ~5-row compact window, expand/collapse, scroll-pauses-follow + Jump to
  live, worker switching, the spine's current phase, Activity
  collapse/expand, the Inspector drawer, Board/DAG/Agents sharing one
  selection, the hero → execution → modes stack, collapsed-rail width, and
  narrow-width stacking. `overflow.e2e.ts` asserts zero client errors on
  boot and no text escaping its container across all five views, all
  modes, and all eight inspector tabs at 1440px and 390px; the detector
  treats designed scrollers as intentional and flags spills, cuts, and
  unintended scroll regions. The config pins `NO_PROXY` for loopback so a
  proxied environment cannot break the readiness probe.
