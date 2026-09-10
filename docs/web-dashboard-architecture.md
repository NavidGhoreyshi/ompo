# Web dashboard architecture (browser UI contract)

Doc-only slice. No runtime behavior changes. This note maps the existing
store / query / event / control seams to the smallest browser-facing API a
later slice can implement. The browser must never read `.omp/` directly and
must never mutate `roadmap.json`, `events.jsonl`, or cursor state directly.
The server owns all store and artifact access.

## 1. Owning modules and reuse map

| Browser need | Existing function(s) | File | Reuse |
|---|---|---|---|
| List runs | `listRuns(projectDir)` | `src/store.ts` | call directly |
| Run cursor (doc + seq) | `loadRun(projectDir, runId)` | `src/store.ts` | call directly; strip internals into DTO (§3) |
| Event log | `readEvents(projectDir, runId)` | `src/store.ts` | call directly; `RunEvent` is already JSON-safe |
| Crash-replay check | `rebuildStatusesFromEvents(initial, events)` | `src/store.ts` | call directly for `/replay` |
| Stats | `computeStats(projectDir, runId, io?)` | `src/stats.ts` | call directly; `RunStats` is the DTO |
| Event filter | `queryEvents(projectDir, runId, query)` | `src/stats.ts` | call directly behind a query endpoint |
| Replay diff | `replayRun(projectDir, runId)` | `src/stats.ts` | call directly for `/replay` |
| Slice forensics | `showSlice(...)`, `tailSliceLog(...)`, `diffSliceBranch(...)`, `sliceWorktreePath(...)` | `src/forensics.ts` | call directly; cap tails via existing `n` / `DIFF_CAP` |
| Run board + inspector | `viewForRun(project, runId, sel)`, `buildDetail(...)` (private), `sliceMetrics`, `reasonsBySlice`, `formatEventLine` | `src/watch.tsx` | port the *projection*, not the file reads: server calls store/forensics, then shapes `RunView`/`DetailView` into DTOs (§3). `buildDetail` reads the slice dir with caps (report summary, verdict steps ≤ 6, tails); the endpoint must apply the same caps |
| Agents pane | `agentStates(lines)` over the `LogBus` | `src/watch.tsx` + `src/run.tsx` | **no store equivalent**: agent identity/phase/state is derived at render time from recent worker progress lines (`[id] …`), not persisted. Browser agents endpoint (if any) must derive from the same source the server exposes (event stream + worker-log tails), never invent a new agent model |
| Control validate/queue/drain/apply | `validateIntent`, `requestControl`, `drainIntents`, `applyIntent`, `queueControl`, `latestSeq`, `parseIntentPayload` | `src/control.ts` | browser mutations reuse **exactly** this path (§5) |
| Run resolution | `resolveRunId(project, run?)` (latest-run fallback) | `src/log.ts` | server resolves bare `/api/runs/latest` the same way |
| Follow semantics | `follow()` in `cmdLog` (poll size, print only new seqs) | `src/log.ts` | SSE is the browser equivalent of `--follow`: same "only new seqs" rule (§4) |
| Deferred checklist | `reportDeferred`, `reportPlaceholders` | `src/runReports.ts` | later slice may expose `GET …/deferred`; not in the minimal contract |

## 2. Internal vs browser-safe

Must remain internal (never serialized to the browser):

- `RunCursor.nextSeq` (consumer offsets are per-client; the cursor seq is a
  write counter, not a read cursor), lock files (`*.lock`), tmp leftovers
  (`roadmap.json.<pid>.tmp`), absolute filesystem paths (`sliceDir`, project
  dir), raw `report.json` / `verdict.json` / `review.json` blobs beyond the
  capped projections, full prompt files (only the capped `promptTail`),
  `TokenUsage` detail beyond the aggregated `turns`/`tools` counters.
- Anything under `.omp/` that is not reached through the functions in §1.

Browser-safe DTOs (§3): reuse `RunEvent`, `RunStats`, `SliceStatus`,
`ControlIntent` verbatim from `src/types.ts` / `src/control.ts`. New DTOs
(`RunSummary`, `RunDetail`, `SliceSummary`, `SliceDetail`, `AgentRow`,
`ControlResult`) are projections, not duplicate domain models: every field
maps to one existing source field or one existing pure derivation
(`sliceMetrics`, `reasonsBySlice`, `summaryText` counts, `lockHeld` live flag).

## 3. Browser read model

All reads are HTTP GET. `projectDir` is server-side configuration (CLI flag /
cwd), never a client parameter. `runId` charset: `[A-Za-z0-9_-]+`; anything
else is 400 (path-traversal guard). `sliceId` must match a slice in the
cursor doc or the endpoint is 404 (same `unknown slice "<id>"` rule as
`showSlice` / `requestControl`).

- `RunSummary`: `{ runId, createdAt, updatedAt, live, counts }` where `live`
  is `lockHeld(project, runId)` and `counts` is the `viewForRun` shape:
  `{ done, active, failed, skipped, blockedEnv, pending }` (`pending` counts
  every non-`done`/non-`failed`/non-`skipped` slice, matching TUI semantics).
- `RunDetail = RunSummary & { slices: SliceSummary[] }`. `SliceSummary` is the
  `SliceLine` shape: `{ id, title, status, attempts, updatedAt, reason?,
  deps }` with `reason` = last terminal-failure reason from the slice's own
  events (only when `status === "failed"`).
- `SliceDetail`: the `DetailView` projection with the existing caps:
  `reportSummary`, `reportFull` (files ≤ 20, tests ≤ 10, deferred ≤ 10,
  followUps ≤ 5, notes clipped), `verdictPass`, `verdictSteps` (≤ 6, tails ≤
  400 chars), `review` (findings ≤ 10, notes ≤ 400), `promptName` +
  `promptTail` (30-line tail), `workerLogName` + `workerTail` (60-line tail),
  `recentEvents` (last 2, formatted) + `history` (prior 8), `metrics`
  (`sliceMetrics`: turns/tools/durationMs from the last `worker_finished`).
  `null` when the slice dir does not exist (same as `buildDetail`).
- `AgentRow`: `{ id, tag?, state, lastLine }` derived by `agentStates` from
  the lines the server publishes. No new agent lifecycle: states are
  point-in-time derivations, not persisted entities.
- `RunEvent` (verbatim): `{ seq, at, type, sliceId?, attempt?, detail?,
  reason?, exit?, timedOut?, durationMs?, stats? }`. Old runs pre-enrichment
  render missing columns as absent/`null` — clients must tolerate absence.
- `RunStats` (verbatim from `computeStats`): `{ runId, totals, passRate,
  attempts, meanTurns, meanTools, meanDurationMs, byEffort, topFailingGates,
  modelFallbacks }`. Never throws on missing artifacts (null means / empty
  maps); the endpoint mirrors that with 200 + partial body, not 500.
- Query result: `RunEvent[]` from `queryEvents` (same DSL, same errors as
  400s). Replay result: `{ ok, diffs }` from `replayRun`.

### Endpoints (minimal)

```text
GET  /api/health                                  # { ok: true, version }
GET  /api/runs                                    # RunSummary[]
GET  /api/runs/latest                             # RunDetail (resolveRunId)
GET  /api/runs/:runId                             # RunDetail
GET  /api/runs/:runId/slices                      # SliceSummary[]
GET  /api/runs/:runId/slices/:sliceId             # SliceDetail | null→404
 GET  /api/runs/:runId/slices/:sliceId/log?tail=N  # { name, lines[] } (tailSliceLog, default 50, max 500)
 GET  /api/runs/:runId/slices/:sliceId/diff        # SliceDiff (DIFF_CAP 20000, git failures → { note })
 GET  /api/runs/:runId/sessions                    # OperatorSession[] (listSessions: unblock rounds + debug sessions)
 GET  /api/runs/:runId/sessions/:name/log?tail=N[&slice=X]  # { name, lines[] } (tailSessionLog; debug needs slice)
GET  /api/runs/:runId/events?afterSeq=N&types=a,b&sliceId=X&limit=N
     # { events: RunEvent[], offset } — offset = max seq seen (drainIntents rule)
GET  /api/runs/:runId/stats                       # RunStats
GET  /api/runs/:runId/query?q=<dsl>               # { events: RunEvent[] }
GET  /api/runs/:runId/replay                      # ReplayResult
GET  /api/runs/:runId/events/stream           # SSE (§4; …/stream is a legacy alias)
POST /api/runs/:runId/control                     # (§5)
POST /api/runs/:runId/resume                      # (§5: spawn detached resume loop, quiescent only)
```

List/detail pagination: runs and slices are small (roadmap scale); full
arrays are fine. Events page by `afterSeq` + `limit` (default 200, max 2000).

## 4. Event stream semantics (SSE, no WebSockets)

- Transport: `GET /api/runs/:runId/events/stream` (`/api/runs/:runId/stream` kept as a legacy alias) as Server-Sent Events
  (`text/event-stream`). No WebSockets: the channel is server→client only
  (control goes over HTTP POST, §5); SSE gives replay, backpressure-free
  text frames, and `Last-Event-ID` resume with zero protocol work. Only if a
  later slice proves SSE insufficient (e.g. bidirectional multiplexing need)
  may this be revisited.
- Resume/replay: client connects with `?afterSeq=N` or `Last-Event-ID: N`;
  server first replays `readEvents` with `seq > N` in seq order, then tails.
  `id:` of each message is the event `seq`. This is the HTTP version of
  `log --follow` ("print only new seqs") and of the drain offset rule
  (`offset` = max seq seen, `drainIntents`).
- Liveness: server polls the store at the TUI cadence (900ms, cf. `POLL_MS`
  in `watch.tsx`/`run.tsx`); on new seqs it emits one `event:` per `RunEvent`
  (JSON payload, scrollback-safe). Heartbeat comment (`: ping`) every ~15s so
  idle connections stay provably alive through proxies. `live: <lockHeld>`
  rides a periodic `run:` meta event, not the event channel.
- Ordering/dedup: seqs are monotonic per run (`cursor.nextSeq`); clients
  dedup on `seq` and advance their cursor to the max seen. Reconnect replays
  from the last seen seq — at-least-once delivery with idempotent apply.
- Fallback: plain `GET …/events?afterSeq=N` polling at the same 900ms
  cadence yields identical state; SSE is an optimization, not a second model.

## 5. Control request semantics (reuse the exact `control_requested` path)

POST body is `ControlIntent` verbatim:

```jsonc
{ "kind": "retry" | "skip" | "park" | "kill" | "set-jobs" | "pause" | "resume",
  "sliceId": "optional — required for retry/skip/park/kill, forbidden otherwise",
  "jobs": "optional — set-jobs integer 1..32",
  "reason": "optional — required for park, audit note elsewhere" }
```

Server handling is `requestControl` → outcome observation, byte-for-byte the
`queueControl` / `ompo ctl` semantics:

1. `validateIntent` first: violations are synchronous `400` with the validator
   message (unknown kind, missing/forbidden `sliceId`, bad `jobs`, park
   without reason). Unknown slice is `404` (`unknown slice "<id>"` — the
   request-time check inside `requestControl`).
2. Valid intents append `control_requested` with `detail = JSON.stringify(intent)`
   and return `202 { seq, kind, sliceId? }`. The server MUST NOT mutate
   `roadmap.json` or apply store transitions inline: the live loop drains via
   `drainIntents` and applies via `applyIntent` within ~2s, appending
   `control_applied` / `control_rejected` (the `ompo log` audit trail). The
   client observes its outcome on the SSE stream by correlating `seq`.
3. Quiescent runs (no live loop holding the lock — `!lockHeld`) apply the
   `cmdCtl`/`cmdDirectControl` pattern instead: `latestSeq` → `requestControl`
   → `drainIntents(before)` → `applyIntent` synchronously, and POST returns
   `200 { ok, message }` (non-ok applies are `200 { ok: false, message }` for
   live-loop parity, except request-time 400/404s). Which mode was used is
   explicit in the response (`{ applied: "queued" | "direct" }`).
4. Per-kind guards (enforced inside `storeApi`, surfaced as rejections, never
   silent): `retry` needs `failed`/`blocked-env` and grants exactly one more
   attempt (raises `maxRetries` to current `attempts` for failed slices);
   `skip`/`park` are quiescent-only (`pending`/`failed`/`blocked-env` — kill
   in-flight work first); `kill` takes `pending`/`running`/`verifying`/
   `blocked-env` to `aborted` (loop drops post-kill output at the next stage
  boundary); `set-jobs`/`pause`/`resume` are loop-local effects reported back
  by `applyIntent`. `resume` on the store (`resumeRun`) is a separate,
  quiescent-only CLI path — not part of the live control contract. Both names
  collide, so the quiescent loop-local rejection (`quiescentLoopLocalRejection`,
  shared by `cmdCtl` and POST …/control) names the recovery verbatim
  (``ompo resume --run <id>``), and the dashboard hides the Run pause/resume/jobs
  buttons on quiescent runs (`live === false`) behind that same restart command —
  never offer a button whose intent is guaranteed-rejected.

5. Run resume is a separate endpoint, not a control intent: `POST
   /api/runs/:runId/resume` spawns a detached `resume --run <id>` loop (the
   same `cmdRun` path as the CLI — headless without a TTY, loop chatter to a
   `resume-<ts>.log` file in the run dir). Guards: unknown run is 404, live
   run (`lockHeld`) is 409, cross-origin writes are 403 like …/control;
   success is `202 { ok, applied: "spawned", pid, log }`. Single-flight rides
   the run lock (a spawn race is settled by the child's own `acquireLock`).
   No new outcome protocol: liveness flips via `lockHeld` and `resumeRun`
   appends `run_resumed`, both already on the SSE stream. Bare `ompo` never
   claims — viewing stays free; this endpoint is the explicit consent to
   spend. The dashboard offers it as a Resume button per quiescent run (runs
   table) and in the inspector Run group (replacing the restart-command hint
   as the primary action, command kept as fallback text).

## 6. Static asset strategy

- One self-contained bundle (single JS + CSS, no external CDN/fonts): the
  dashboard must work offline on a plane like the TUI does. `/api/*` is
  reserved; everything else serves the SPA shell (`index.html` fallback for
  client routes).
- No build-tool coupling to the CLI contract: the API is versioned by the
  `ompo` package version surfaced at `/api/health`; the bundle carries the
  version it was built against and shows a stale-banner on mismatch.

## 7. Localhost security boundary

- Bind `127.0.0.1` (or `::1`) only by default; `0.0.0.0` requires an explicit
  flag and prints a warning. No auth on loopback (same-user local tool, same
  trust as the TUI pressing `R`/`S`/`B`), but: deny cross-origin writes
  (`Origin` check on POST, no `Access-Control-Allow-Origin: *`), `nosniff` +
  restrictive CSP on the shell, no cookies/auth tokens to steal.
- `projectDir` never comes from the client (server CLI flag/cwd). `runId` /
  `sliceId` are charset-validated; all file access goes through `store.ts` /
  `forensics.ts` path builders (no client-supplied paths, no `..`).
- Read endpoints are capped like their TUI counterparts (`tailSliceLog` max
  500 lines here, `DIFF_CAP` 20000, inspector caps in §3). There is deliberately
  NO generic shell/exec, file-write, replan, import, or checkout endpoint:
  the only mutation surface is `POST …/control` (§5).

## 8. Development vs compiled-binary asset loading

- Dev (`bun src/cli.ts …`): serve static assets from the working tree
  (`web/dist/` or equivalent build output dir) on disk so `vite`/bundler
  watch + reload works; missing build dir yields a plain-text 503 naming the
  build command, not a blank page.
- Compiled binary (`bun build --compile src/cli.ts --outfile ompo`, cf.
  `package.json`): embed the built assets into the binary (Bun embedded
  files) so the dashboard works with no sibling files; the server resolves
  assets embedded-first, working-tree second. If neither exists (e.g. custom
  build without the web bundle), `/` returns the same explanatory 503 while
  `/api/*` keeps working — API availability must never depend on assets.
- Both modes serve identical bytes for `/` and identical semantics for
  `/api/*`; mode detection is server-startup logging only.

## 9. Consistency ledger (what this note pins)

- Durable-store invariants honored: append-only `events.jsonl` + atomic
  cursor writes (tmp + rename); synchronous read-modify-write per mutation
  (single-process atomicity; cross-process excluded by the run lock — one
  orchestrator per run); conditional claim guards (stale claims error, never
  double-run); `seq = cursor.nextSeq` monotonic; `resumeDemotes`
  (`running`/`verifying`/`aborted`/`blocked-env` → `pending`) and
  `crashedInFlight` unchanged.
- `rebuildStatusesFromEvents` semantics preserved: cursor-skipped slices start
  `skipped`; `verify_failed` is transient (a later `slice_retried` returns to
  `pending`); terminal `failed` comes only from `slice_failed_terminal`;
  control/audit event types (`control_*`, `run_*`, `roadmap_replanned`,
  `slice_reverified`, `slice_handoff`) do not move slice status.
- Control kinds are exactly the seven in `src/control.ts`; no new kinds, no
  renamed fields, no parallel mutation path.
- Stats/forensics/query paths are read-only today (`computeStats`,
  `queryEvents`, `exportHtml`, `replayRun`, `showSlice`, `tailSliceLog`,
  `diffSliceBranch`) and stay read-only behind GET.
- TUI parity targets: 900ms refresh cadence, board counts, failure-triage
  helpers (`isFailureStatus`, `failureIndices`), six inspector tabs
  (Output/Diff/Verify/Review/Prompt/Events — the `SliceDetail` fields cover
  each), and the read-only-`watch` vs live-`run`/`unified` split (mirrored by
  GET vs POST + queued/direct control here).
