# ompo Desktop Deck — 3D Interface Module Roadmap

> Status: proposed roadmap for a spatial (3D) operator surface over the existing ompo core.
>
> This roadmap adds a **deck** — a 3D command surface for a running ompo run — without
> adding a second orchestrator, a second state model, a second transport, or a second
> persistence layer. The deck is a projection of state ompo already produces; the
> existing CLI, Ink TUI, browser dashboard, durable store, event log, and review/verify
> pipeline are untouched except for one additive CLI flag (slice `d11`).

---

# How to read this file

**Everything above the first `## ` heading is design record; everything below it is the
machine-parsed slice region.** ompo's parser (`src/parse.ts`, `splitSections`) treats
every `## ` heading as a slice and every line after it as that slice's body — so the
analysis sections (A–J) are deliberately written with `#`/`###` headings and placed
*before* the slices, where the parser discards them. Slice bodies are therefore
self-contained: a worker assigned `d07` never sees sections A–J and does not need them.

**Read section 0 first.** `d00`–`d03` are not four ordinary slices: they are a *validation gate*
whose only job is to prove or falsify the premise that a 3D surface beats the existing dashboard
for the active-worker workflow. The gate's evidence report (`docs/deck-validation-report.md`,
produced by slice `d03v`) is allowed — expected — to recommend dropping every later slice. Nothing
downstream of the gate may start before the gate's evidence exists.

Run it with an explicit path (this file is **not** the default `ROADMAP.md`):

```bash
ompo plan --roadmap docs/desktop-3d-roadmap.md          # structure + lint, exit 1 when blocked
ompo run --roadmap docs/desktop-3d-roadmap.md --dry-run # dependency order, spawns nothing
ompo run --roadmap docs/desktop-3d-roadmap.md           # execute (bare `ompo` = dashboard)
```

Slice ids (`d00`…`d14`, plus the gate slice `d03v`) are stable. Title text may be renamed freely; **ids may never be
renamed once a run starts** (`Depends:` is id-only, and `ompo replan` keys on ids).

**Measurements in this document were taken on the development machine on 2026-09-12**
(Bun 1.3.14, Node 24.18.0, 4 vCPU, ~10 GB RAM, WSL2 kernel 6.18.33.2, WSLg 1.0.73.2) using
headless and headed Playwright Chromium 1.62 / revision 1234. They are recorded with the
method so any later agent can re-run them rather than trust them.

---

# 0. Validation gate G1 — prove the premise (d00 – d03v)

### 0.1 What the gate is for

This roadmap is a **hypothesis list, not a commitment**. The hypothesis is:

> A spatial (3D) operator surface makes a live multi-worker ompo run easier to monitor than the
> existing dashboard — enough to justify a new subsystem, one new runtime dependency, and a
> desktop shell.

`d00`–`d03` build only the minimum needed to test that hypothesis on the real machine with a real
worker. `d03v` is the gate slice: it runs the measurement protocol, writes the evidence report, and
states a recommendation. **Every slice after the gate is gated on that report**, and the report is
allowed to say "stop".

The gate is explicitly *not* a demo checkpoint. "It renders and looks good" is not a result. The
result is a table of measured numbers plus a decision.

> **Standing mandate for every agent working on `d00`–`d03v`:** do not optimise for preserving this
> roadmap. Optimise for discovering whether this roadmap is correct. A gate that deletes eight
> slices, or stops the project, has done its job correctly; a gate that confirms the plan without
> trying hard to break it has failed. Write the report as if your next slice depends on the
> operator believing the numbers — because it does.

### 0.2 What "real" means (non-negotiable)

By the end of `d03`/`d03v` the following must all be true of the evidence:

| Requirement | Why it matters |
|---|---|
| A **real `omp -p` worker** ran a real slice (not a fixture-only run) and produced real `events.jsonl` and `worker-<n>.log` output | fixtures cannot tell you whether the projection handles reality (handoffs, generations, retries, wedged workers, multi-megabyte transcripts) |
| The deck rendered through the **actual architecture** (real `App.tsx` state → `buildDeckModel` → `applyModel` → WebGL2 → DOM overlay) — no mock renderer, no stubbed model | the point is to falsify the architecture, not a caricature of it |
| Measurements taken on the **actual target machine** (this WSL2 box, tier as classified), with the renderer string recorded | the perf premise is machine-specific (A.6) |
| The **actual constraints** are in force: `minimal` tier budgets, DOM-only text, lazy chunk, existing SSE/poll cadences | a gate run with constraints off proves nothing |
| Every number comes with its **raw artifact** (JSON under `captures/deck-validation/`) and the command that produced it | unverifiable numbers are marketing |

### 0.3 The five failure conditions (kill criteria)

These are the user-visible questions the gate must answer. Each maps to one or more measured
metrics in §0.4. **Any one of them failing blocks every downstream slice** until it is fixed
(within a bounded remediation) or the 3D line is stopped.

| # | Failure condition | Kills |
|---|---|---|
| F1 | The event/state projection is **wrong or duplicated** — the deck derives slice/agent state anywhere other than the existing `web/src/lib/**` helpers + `scene/model.ts`, or any scene value disagrees with the DTO it claims to project | the whole "presentation layer" premise |
| F2 | The live-output model causes **excessive React/DOM churn** — commit rate, mutation rate or long-task count grows with transcript volume | the live-window design (and, if unfixable, the deck) |
| F3 | The renderer **cannot hold responsiveness** on the target machine — frame budget blown, idle frames, or memory growth | the 3D representation itself |
| F4 | The 3D representation makes the **active-worker workflow harder** than the dashboard/TUI on the critical questions | the product premise |
| F5 | The **browser/Tauri boundary** needs architectural changes (the URL-load + `--print-url` contract does not survive contact with a real run) | packaging slices `d11`/`d12`, and possibly the surface contract |

### 0.4 Measurement protocol (what `scripts/deck-validate.ts` must produce)

Two modes, both required: `--fixture` (deterministic, replayable, used for regression) and
`--live` (a real run; the evidence that counts). Sample sizes are minimums, not targets.

| Metric | How measured | Continue threshold | Action if missed |
|---|---|---|---|
| **M1** projection integrity | runtime assertion over a 60 s live window: every `DeckModel` node/edge/station maps 1:1 to a DTO field; plus a source scan proving no second derivation of slice status / agent state outside `web/src/lib/**` and `scene/model.ts` | 0 mismatches, 0 duplicate derivations | **F1 → stop, re-architect the model** |
| **M2** frame cost | frame time p50/p95 over ≥ 3 000 frames while ≥ 1 worker runs, at the operator's tier and at the tier's target resolution | `minimal`: p50 ≤ 33 ms, p95 ≤ 45 ms | **F3 → fix tiers/geometry before `d04`** |
| **M3** idle cost | frames rendered over a 60 s window with the run live and the camera settled | ≤ 3 frames | **F3 → the loop design is wrong; fix first** |
| **M4** event-to-screen latency | for each `RunEvent` seq: event `at` timestamp → the derived text present in the DOM (poll the DOM, not React state) | p50 ≤ 1.2 s, p95 ≤ 3 s | transport/tail cadence revisit (CP-4 trigger) before `d05` |
| **M5** React/DOM churn | React commits/s (instrumented), `MutationObserver` mutation rate attributable to the deck, `PerformanceObserver` long tasks over a 60 s chatty window | commits ≤ 4/s; long tasks > 50 ms ≤ 2/min; mutations ≤ 60/s | **F2 → redesign the live window before `d05`** |
| **M6** log-volume isolation | frames rendered while the transcript grows by ≥ 2 000 lines in 60 s | 0 frames attributable to text | **F2/F3 → fix before `d04`** |
| **M7** memory | JS heap and `renderer.info.memory.{geometries,textures,programs}` sampled every 10 s for ≥ 10 min | heap growth ≤ 10 % after warmup and no monotonic trend; GPU counters constant | leak → fix before any further slice |
| **M8** scene object budget | `renderer.info` + the debug hook, at the live slice count | objects == slices + edges + stations + beacons within tier caps; draw calls ≤ 8 at ≤ 25 slices / ≤ 3 stations | instancing work moves earlier (`d10` content pulled forward) |
| **M9** input responsiveness | `]` (focus switch) and click-select → frames until the correct painted result | selection ≤ 2 frames; live-window source switch ≤ 3 s (tail-poll bound) | input path redesign before `d04` |
| **M10** workflow value | 5 scripted tasks (below) timed on deck vs dashboard vs TUI, 3 repetitions, alternating order, correctness checked against the store first | deck ≥ dashboard on ≥ 3 of 5 **and** not worse on T1/T3 | **F4 → stop the 3D line** |
| **M11** architecture integrity | `bun test` (incl. release-gate), the new boundary assertions, plus a diff audit of out-of-scope edits | 0 violations | fix before anything else |
| **M12** boundary finding | qualitative: did the shell contract survive? does the run's real behaviour match `RunDetail`/`AgentRow` semantics? | recorded finding + a concrete recommended delta (or "no change") | **F5 → redesign `d11`/`d12` before starting them** |
| **M13** CPU/GPU character | browser-process CPU time (CDP `Performance.getMetrics`) + a fill-bound vs CPU-bound discrimination test: frame time at resolution scale 0.5 vs 1.0 | report only; used to attribute the bottleneck | attribution changes which optimisation is allowed (e.g. fewer pixels vs less JS) |

**M10 task list** (the active-worker workflow; correctness first, then median time):

- **T1** Which worker is running right now, and what is it doing? *(critical)*
- **T2** Which slice is blocked or failed, and why?
- **T3** Is the current worker stalled/wedged, and for how long? *(critical)*
- **T4** What did the worker just do — its last five meaningful actions?
- **T5** Which slice runs next, and what is it waiting on?

### 0.5 Verdict rules

| Verdict | Condition | Consequence |
|---|---|---|
| **PASS — continue** | all kill criteria clean, M10 satisfied | proceed as written |
| **PASS WITH CHANGES** | criteria clean but ≥ 1 metric missed fixably | the remediation is folded into the *next* slice (or a bounded `d03r`), and **this roadmap file is amended** before that slice starts |
| **REVISE (scope cut)** | F3 or F2 fails but the workflow evidence (M10) is positive | the 3D line continues in a reduced form: no expression pass (`d13`), fewer stations, flat-mode-first; the roadmap is rewritten, not patched |
| **STOP** | F1 or F4 fails, or F3/F2 remain unfixed after one bounded attempt | the deck stays as an in-repo prototype behind `?surface=deck` (or is reverted to `d01`), `d04`+ are dropped, and the dashboard/TUI remain the operator surfaces. No "phase 2", no re-litigation without new evidence |

Rules that make the verdict meaningful:

1. **The agent does not decide.** `d03v` writes the report and a *recommendation*; the decision block
   is filled in by the operator. A slice that self-approves its own continuation is rejected.
2. **The report must contain at least one thing the deck does worse than the dashboard.** A report
   with no negatives is treated as incomplete and bounced.
3. **Unmeasured ≠ absent.** Any metric that could not be measured is listed as `unmeasured` with the
   reason; silently dropping a metric is a review failure.
4. **Deviations need a cause, not a caveat.** "p95 61 ms — burst of 3 simultaneous status
   transitions at 0.5 scale, traced to N tweens in one frame" is acceptable; "performance is
   acceptable" is not.
5. **`--live` evidence is mandatory.** Fixture-only numbers are supporting material, never the
   basis of a verdict.
6. **Downstream slices are disposable.** The report ends with a per-slice disposition table
   (`keep` / `modify` / `drop` / `defer`) covering `d04`–`d14`. Deleting slices is a success mode of
   this gate, not a failure of the roadmap.

### 0.6 Evidence report contract (`docs/deck-validation-report.md`, written by `d03v`)

Required sections, in order — the ten items the gate exists to answer:

1. **Setup** — machine, tier, renderer string, bundle/chunk sizes, run id + project, worker models,
   commands used.
2. **Measured frame/render performance** — M2/M3/M8 tables (raw JSON referenced).
3. **Event-to-screen latency** — M4 distribution with the pipeline stages attributed
   (store poll → SSE → React → DOM), plus the worst observed case.
4. **CPU/GPU behaviour** — M13, including the fill-bound/CPU-bound discrimination result and what it
   implies for the allowed optimisations.
5. **Memory** — M7 samples with the trend line; explicit statement of leak/no-leak.
6. **Rendered scene objects** — M8 counts versus the tier caps, and what would break at 2× and 4×
   the slice count (measured, not extrapolated).
7. **React/DOM update behaviour** — M5/M6 with the commit/mutation/long-task rates and the
   no-frame-from-text assertion.
8. **Is the active-worker workflow actually better?** — M10 table (correctness + median times for
   deck/dashboard/TUI), plus a short honest paragraph naming at least one task where the dashboard
   or TUI wins.
9. **Architectural problems discovered** — M11/M12 findings, surprises, and anything in the
   projection that turned out to be duplicated, missing or wrong; each with the file that proves it.
10. **Recommended changes to later slices** — the per-slice disposition table (§0.5 rule 6) plus the
    specific amendments required before each surviving slice starts.

The report is short by design (target ≤ 250 lines), numeric, and links its raw artifacts.

---

# A. Repository findings

Facts below are from the tree, with the file that proves them. Inference is marked
`[INFERENCE]`.

### A.1 Runtime, toolchain, layout

| Fact | Evidence |
|---|---|
| Bun-only runtime: `bun install`, `bun test`, `bun build --compile`; `engines.bun >= 1.3.0` | `package.json`, `src/cli.ts:1`, `docs/development-prd.md` §3 |
| TypeScript `ESNext`, `moduleResolution: bundler`, `jsx: react-jsx`, `strict`, `paths` alias `@/* → ./web/src/*`, include covers `src` **and** `web` | `tsconfig.json` |
| ESM with explicit `.ts`/`.tsx` extensions in every import | all of `src/*.ts` |
| 43 modules in `src/`, 48 `tests/*.test.ts` mirroring `src/` areas, 3 Playwright e2e files | `src/`, `tests/`, `tests/e2e/` |
| Web dashboard: 59 files, 7,408 LOC under `web/src` (React 19.2.8, Vite 8, Tailwind 4, shadcn-style `ui/*`) | `web/src/**`, `web/vite.config.ts`, `package.json` |
| One root `package.json` — **no monorepo, no workspaces** | `package.json` |
| Design system already exists as semantic tokens (dark-first, status colors `--success/--info/--warning`) | `web/src/styles/tokens.css`, `theme.css` |

### A.2 Process model — the single most important fact for this roadmap

```
bare `ompo`      → cli.ts cmdDashboard (src/cli.ts:1273)
                 → startDashboardServer (src/server.ts:1469) → Bun.serve(host 127.0.0.1, port 0)
                 → serves SPA + /api/** ; the orchestrator loop NEVER runs in this process
`ompo run|resume`→ runRoadmapLoop in-process, no HTTP server
POST /api/runs/:id/resume        → spawnDetachedResume (src/server.ts:1022): detached `ompo resume --run <id>`
POST /api/runs/:id/restart-loop  → finds same-run loop pids, kills them, respawns detached
```

Consequences a desktop/3D UI must respect:

- The **durable store is the only interface** between the loop and any UI:
  `.omp/roadmap/runs/<runId>/{roadmap.json, events.jsonl, slices/<id>/**}`.
- Run liveness is **observed, never owned**: `lockHeld(projectDir, runId)` drives
  `RunSummary.live` and the SSE `run:` meta event (`src/server.ts`, `arch §4`).
- The dashboard has exactly **four POST surfaces** — `…/control`, `…/resume`,
  `…/restart-loop`, `/api/plan/decision` — and no file/system endpoints.
- A second UI therefore attaches **as an HTTP/SSE client or not at all**. Nothing about
  ompo's architecture rewards a second in-process UI, and the existing one (browser)
  already proves a URL-addressed loopback client is sufficient.

### A.3 Read model already exposed (reuse, do not re-derive)

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /api/health` | `{ ok, version }` | version handshake the SPA already uses for its stale banner |
| `GET /api/runs` | `RunSummary[]` | `{ runId, createdAt, updatedAt, live, counts, tokens?, cost? }` |
| `GET /api/runs/:id` | `RunDetail = RunSummary & { slices: SliceSummary[], loops: LoopProc[] }` | `loops` feeds the double-loop guard |
| `GET /api/runs/:id/slices/:sid` | `SliceDetail` | inspector caps: report ≤ 20 files, verdict steps ≤ 6, tails ≤ 400 chars |
| `GET /api/runs/:id/slices/:sid/log?tail=N` | `{ name, lane, lines[] }` | lane ∈ worker/debug/review/review-fix/verify; default 50, max 500 |
| `GET /api/runs/:id/slices/:sid/diff` | `SliceDiff` | `DIFF_CAP` 20 000 chars |
| `GET /api/runs/:id/events?afterSeq=N&types=a,b&sliceId=X&limit=N` | `{ events, offset }` | `offset` = max seq seen |
| `GET /api/runs/:id/events/stream` | SSE | server polls the store at `POLL_MS = 900` (`src/server.ts:19`), heartbeat 15 s, `idleTimeout: 60` |
| `GET /api/runs/:id/stats` · `/query` · `/replay` | `RunStats` · `RunEvent[]` · `ReplayResult` | never throws; partial body instead of 500 |
| `GET /api/runs/:id/sessions[/:name/log]` | `OperatorSession[]` | unblock rounds + debug sessions |
| `GET /api/plan/preview` · `/raw` | plan preview + lint | roadmap inspection |

DTO field lists that matter to the deck: `RunSummary` (`src/server.ts:72`), `SliceSummary`
(`:94` — includes `attempts`, `generation`, `deps`, `effort`, `agent`, `verify[]`),
`SliceDetail` (`:129` — includes `metrics`, `generations`, `verdictSteps`, `verdictPass`,
`verdictStall`, `review{approved,findings}`, `artifacts{report,verdict,review,workerLog,prompt}`),
`VerdictStall` (`:175`), `LoopProc` (`:185`), `AgentRow` (`:262` — `lane`, `status`,
`attempt`, `generation`, `lastLine`, `metrics`, `wedged`, `staleForMs`), `Counts` (`:63`).

### A.4 Presentation logic that already exists and must not be re-implemented

All of these are **pure, DOM-free, already unit-tested** — they are the deck's real
foundation:

| Concern | Function | File |
|---|---|---|
| Which slice needs eyes (rank 0 = live/failed, then blocked, then done; ties by roadmap order) | `preferredSliceId(slices)` | `web/src/lib/selection.ts:16` |
| One-line "what is it doing" | `heroAction({status,lastLine,lastEvent,reason,deps})` | `web/src/lib/selection.ts:56` |
| 7-stage lifecycle Claim → … → Done + stage index | `buildPipelineStages`, `currentStageIndex` | `web/src/lib/pipeline.ts:34,134` |
| Bounded live window (5 meaningful rows, newest-meaningful + leading raw line) | `compactWindow`, `COMPACT_ROWS = 5` | `web/src/lib/stream.ts:341,23` |
| Transcript line → semantic row (read/run/turn/tool/say/warn/fail/event) | `semanticLine` | `web/src/lib/stream.ts:95` |
| Line identity across polls (stable keys for enter/leave motion) | `alignLineIds` | `web/src/lib/stream.ts:262` |
| Compose the live stream (generation opener, worker output, trailing events) | `buildLiveStream` | `web/src/lib/stream.ts:292` |
| Follow/freeze reducer | `followFromScroll`, `FOLLOW_SLOP = 24` | `web/src/lib/stream.ts:369,26` |
| Roadmap DAG depth + 2D layout (nodes with x/y/depth, edges with endpoints, ghosts, cycles, ready set) | `dagDepths`, `layoutDag` | `web/src/lib/dag.ts:104,182` |
| Event lane classification + concise detail | `eventLane`, `describeEvent`, `conciseControlIntent` | `web/src/lib/events.ts:50,104,80` |
| Attempt segmentation over the event log | `buildTimeline` | `web/src/lib/timeline.ts:131` |
| Live tail polling (2 s) for worker/debug/review/verify lanes, with line identity | `useSliceLog`, `useLiveStream`, `LIVE_TAIL = 400` | `web/src/lib/useSliceLog.ts:83`, `useLiveStream.ts:37,11` |
| Components to reuse verbatim | `LiveFeed` (compact↔expanded live window, follow, jump-to-live), `Inspector` (8 tabs), `ControlPanel`, `SliceTable`, `StatusBadge`/`toneForStatus`, `ui/*` | `web/src/components/` |

### A.5 Architectural constraints that decide this design

1. **The release gate locks `web/src/**` to API-only.** `tests/release-gate.test.ts:401`
   ("architecture lock (engine -> store+events -> Web/TUI/CLI)") walks every `.ts`/`.tsx`
   under `web/src` and asserts: no `node:*` import, no `../src/` import, no `src/store`,
   no `src/control`, **no `new WebSocket`**, and that the client references `/api/`.
   → Any code placed under `web/src/` inherits an enforced "presentation-only" boundary.
   → A separate top-level app would *escape* this lock. This is the strongest argument for
   putting the 3D module **inside** `web/src/`, not beside it.
2. **`connect-src 'self'` + no CORS + cross-origin POST denial.** `src/server.ts:841`
   ships `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
   img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self';
   frame-ancestors 'none'`, and `originAllowed()` rejects cross-origin writes.
   → A desktop shell that loads a *bundled* copy of the SPA and calls
   `http://127.0.0.1:PORT/api` is a **different origin**: CSP blocks the fetch and the
   server blocks the POST. The only shell design that works without weakening the
   security contract is **loading the ompo URL itself in the webview**.
3. **The SPA fallback serves `index.html` for any non-`/api` GET** (`src/server.ts:1420-1433`),
   so `/?surface=deck` needs no server routing change.
4. **Assets are embedded-first.** `scripts/embed-web.ts` base64s **everything** under
   `web/dist/**` into `src/webAssets.generated.ts`; extra chunks (a three.js chunk) are
   embedded automatically. New binary asset types would need a `contentType` entry there.
5. **CI gates:** `.github/workflows/ci.yml` runs `bunx tsc --noEmit` + `bun test`, and a
   second job runs `bunx playwright install --with-deps chromium` + `bun run test:e2e`.
   `bun test` starts no browser; e2e is a separate command.
6. **No global client keymap exists yet.** The web app binds only Enter/Space activation on
   focusable rows (`AgentCard.tsx:47`, `Dag.tsx:216`, `RoadmapPage.tsx:160`,
   `RunsPage.tsx:84`). No router, no `localStorage`, no `URLSearchParams` usage anywhere in
   `web/src` — the deck introduces the first surface selector and the first client-side
   preference store, so both must be introduced deliberately and narrowly.

### A.6 Measured rendering environment (2026-09-12)

Probe: `chromium.launch()` from the repo's Playwright 1.62; `gl.getParameter(UNMASKED_RENDERER_WEBGL)`;
full-screen quad fill with a trivial fragment shader, `gl.finish()` **plus** a 1-pixel
`readPixels` to force completion (a bare `gl.finish()` returned bogus 0.02 ms numbers — it
does not synchronize in this build).

| Probe | Headless | Headed (real WSLg window) |
|---|---|---|
| Renderer string | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` | identical — **software** |
| `--use-angle=vulkan` / `--use-angle=gl` | no WebGL2 context at all | — |
| 1280×720, 1× overdraw | **31–53 ms** (≈19–32 fps) | **37–41 ms** (≈24–27 fps) |
| 1280×720, 4× overdraw | 125–157 ms | 114–120 ms |
| 1280×720, 8× overdraw | 193–216 ms | 213–309 ms |
| 640×360, 1× overdraw | 15–18 ms | 10 ms |
| 2560×1440, 4× overdraw | 451–528 ms | 477–547 ms |
| `MAX_TEXTURE_SIZE` / devicePixelRatio | 8192 / 1 | — |

Ranges are **min–max across two full measurement runs on the same machine** (~40 % spread),
not an error bar from a single run: the software rasterizer's timings are noisy enough that a
budget derived from one sample is meaningless. Two consequences are binding for the rest of this
roadmap: (1) `scripts/deck-probe.ts` (slice `d00`) must repeat each configuration and report
min/median/max, never a single sample; (2) every budget carries at least 1.5× headroom over the
best observed number, and the runtime tier controller (`d10`) exists precisely because a static
threshold cannot hold on this class of machine.

Environment facts: no `/dev/dri`; `/dev/dxg` present; WSLg 1.0.73.2; Mesa `d3d12_dri.so`
present but Chromium still selects SwiftShader; 4 vCPU / ~10 GB RAM; Intel i7-4500U
(Haswell). **No Rust toolchain (`rustc`/`cargo` absent) and no `libwebkit2gtk-4.1`**
(only `libgtk-3` and `libsoup-3` are installed) — so a Tauri Linux/WSL build cannot even
compile here today. On the Windows side, the **WebView2 runtime is installed**
(`/mnt/c/Program Files (x86)/Microsoft/EdgeWebView/Application/152.0.4191.66`).

**What this means:** on this machine every WebGL fragment is rasterized on the CPU at
roughly 44 ns/pixel for even a trivial shader. A full-viewport 3D scene at 1280×720 with
any overdraw cannot hold 30 fps. Therefore the deck must be designed as a **low-resolution,
low-overdraw, DOM-textured scene that renders on demand**, and the quality tier must come
from a runtime probe, not from an assumption. `d00` exists to pin those numbers in-repo.

### A.7 Current roadmap / sprint state

- `docs/web-dashboard-roadmap.md` (775 lines, `w0a`…`w5f`) is the shipped precedent for a
  vertical-slice ompo roadmap: preamble with "Operator notes" + "Explicitly Deferred" +
  "Release principle", then `## [id]` slices with `Depends/Effort/Timeout/Retries/Verify/Files`
  trailers. **This document follows that exact shape.**
- `.omp/roadmap/runs/20260909-kph0as/` is the only run on disk (24 slices, `w0a`…`w5f`,
  96 events, real `worker-1-g0.events.jsonl` up to 1.45 MB) — a genuine fixture for deck
  development and for the perf harness's realistic scene.
- The repo itself has **no `ROADMAP.md`** (dogfood runs live in pilot dirs); `.omp/` here is
  gitignored except the handoffs/ratings convention.

---

# B. Proposed architecture

### B.1 Where the deck sits

```
                          ┌────────────────────────────────────────────────┐
                          │  ompo core — Bun + TypeScript, one process     │
                          │  loop.ts · attempt.ts · store.ts · verify.ts   │
                          │  worker.ts · reviewLane.ts · control.ts        │
                          └───────────────────────┬────────────────────────┘
                                                  │ writes (sync, atomic)
                     .omp/roadmap/runs/<runId>/{roadmap.json, events.jsonl, slices/<id>/**}
                                                  │ reads (the only interface)
                          ┌───────────────────────▼────────────────────────┐
                          │ dashboard server — src/server.ts                │
                          │ Bun.serve 127.0.0.1:<auto|--port>               │
                          │  GET  /api/**           read model (DTOs)       │
                          │  GET  …/events/stream   SSE @ 900 ms poll       │
                          │  POST …/control | …/resume | …/restart-loop     │
                          │  GET  * → embedded SPA shell (web/dist)         │
                          └───┬─────────────────────────────────────────┬───┘
                              │                                         │
              ┌───────────────▼──────────────┐      ┌───────────────────▼───────────────────┐
              │ Ink TUIs                     │      │ web/src (React 19 + Vite 8)           │
              │ watch.tsx · run.tsx ·        │      │  App.tsx  — state + SSE + polling      │
              │ unified.tsx                  │      │  ?surface=dashboard → existing pages   │
              │ (unchanged)                  │      │  ?surface=deck      → scene/** (lazy)  │
              └──────────────────────────────┘      └───────┬───────────────────────────────┘
                                                            │ same origin, same CSP
                                        ┌───────────────────▼───────────────────────────┐
                                        │ Tauri 2 shell (OPTIONAL, packaging only)      │
                                        │ WebviewWindowBuilder → ompo URL, sidecar       │
                                        │ lifecycle, single instance. No data path.      │
                                        └───────────────────────────────────────────────┘
```

**Boundary rule (non-negotiable):** the deck never talks to the store, never spawns a
worker, never mutates `roadmap.json`/`events.jsonl`, and never introduces a transport.
It consumes the same HTTP+SSE read model the browser dashboard consumes, and it is a
*sibling view* of the same React tree — not a second application.

### B.2 Deck data flow

```
 RunEvent[] ─┐                       (SSE, server poll 900 ms, afterSeq replay)
 RunDetail   ├─►  App.tsx state  ──►  props  ──┬─►  DeckOverlay (DOM)   React 19, event-driven
 AgentRow[]  │   (existing)                    │     ├─ LiveFeed        (bounded live window, reuse)
 SliceDetail ┘   useLiveStream/useSliceLog     │     ├─ Inspector       (8 tabs, reuse, on demand)
                 (existing, 2 s tail poll)      │     ├─ alert stack     (text-first, keyboard reachable)
                                                │     └─ HUD             (tier, fps, draw calls)
                                                │
                                                └─►  buildDeckModel(input) → DeckModel      PURE, unit-tested
                                                          │  (node/edge/station/alert arrays only)
                                                          ▼
                                                     applyDeckModel(renderer, model)      diff-applied
                                                          │  (add/remove/update entities)
                                                          ▼
                                                     three.js scene graph → WebGL2 canvas
                                                          ▲
                                                     camera.ts (pure math) ◄─ input intents
                                                          ▲
                                                     loop.ts (dirty-flag scheduler, ≤30 fps, idle = 0 frames)
```

Three properties this buys, each of which is a tested acceptance criterion somewhere below:

1. **The renderer holds no domain knowledge.** It receives `DeckModel` (plain arrays) and
   draws it. All state → visual decisions are in `model.ts`, which runs without a DOM.
2. **React never renders per log line.** Log text flows through the existing polled hooks at
   their existing cadence; the WebGL scene updates only when `DeckModel` changes semantically.
3. **Rendering is interruptible.** Idle tabs stop scheduling frames; a hidden tab never
   renders; the perf budget is enforced by a measurement harness, not by hope.

### B.3 Module map (all paths repo-relative; new files marked ✚)

```
web/src/
  App.tsx                                EDIT  + surface switch (?surface=deck), lazy Deck boundary
  api.ts                                  reuse transport + DTOs (unchanged)
  lib/                                    reuse pure derivations (selection, pipeline, stream, dag, events, timeline)
  components/                             reuse LiveFeed, Inspector, ControlPanel, SliceTable, StatusBadge, ui/*
  scene/                                 ✚ the deck module — the ONLY new subsystem
    types.ts        ✚ (d01) DeckInput, DeckModel, RailNode, RailEdge, DeckAlert, DeckPrefs,
                            QualityTier, DECK_KEYS, DECK_PREFS_KEY
    tier.ts         ✚ (d00) classifyRenderer(string), TIER_BUDGETS                     pure
    instrument.ts   ✚ (d01) frames/frame-times/commits/mutations/long-tasks/heap +
                            event-to-screen latency marks; feeds `window.__ompoDeck` and the gate
    loop.ts         ✚ (d01) createFrameLoop({onFrame,maxFps,isDirty,raf,cancelRaf,isHidden})
    renderer.ts     ✚ (d01) createDeckRenderer(canvas, tier): DeckRenderer
                            — the ONLY module in the repo importing `three`
    model.ts        ✚ (d02) buildDeckModel(DeckInput): DeckModel                      pure
    rail.ts         ✚ (d02) railPositions(DagLayout): Map<id,{x,y,z}>                 pure
    focus.ts        ✚ (d03) liveSliceIds, focusTarget, frameForNode                   pure
    camera.ts       ✚ (d03) CameraState, applyCameraIntent, lerpCamera, visibleSliceIds pure
    lanes.ts        ✚ (d04) stationSlots, overflowCount                               pure
    alerts.ts       ✚ (d05) deriveAlerts, dismissKey, activeAlerts                    pure
    deltas.ts       ✚ (d05) diffModels(prev,next,events): SceneDelta[]                pure
    history.ts      ✚ (d07) buildEventRibbon, attemptSegments                         pure
    fallback.ts     ✚ (d09) deckAvailability, flatRows                                pure
    ambient.ts      ✚ (d13) ambient parameters as data, ambientEnabled(tier,prefs)    pure
    palette.ts      ✚ (d13) the single CSS-token -> scene-colour conversion            pure
    Deck.tsx        ✚ (d01) React boundary: props in, renderer + overlay out; no fetching
    DeckOverlay.tsx ✚ (d03) DOM layer: live window, station label, alert stack, HUD, keymap help
    DeckInspector.tsx ✚ (d06) thin dock wrapping the existing Inspector
    HistoryWall.tsx ✚ (d07) run list (DOM mirror of the history tiles)
    FlatDeck.tsx    ✚ (d09) the no-WebGL / forced-flat projection over the same DeckModel

  lib/ + components/                      REUSE (unchanged): selection.ts preferredSliceId/heroAction,
                                          pipeline.ts buildPipelineStages, stream.ts compactWindow/
                                          buildLiveStream/followFromScroll, useLiveStream/useSliceLog,
                                          dag.ts layoutDag/dagDepths, events.ts eventLane, timeline.ts,
                                          components LiveFeed/Inspector/ControlPanel/SliceTable/StatusBadge

scripts/
  deck-probe.ts     ✚ (d00) rendering-environment probe; JSON + min/median/max; gated evidence
  deck-validate.ts  ✚ (d03v) the G1 protocol runner: --fixture (×1, ×4) and --live; writes
                             captures/deck-validation/*.json
  deck-perf.ts      ✚ (d10) deck frame-budget harness against a fixture scene
  deck-open.ts      ✚ (d11) launcher: --print-url handshake + app-window open
  deck-desktop-check.ts ✚ (d12) static verifier for the Tauri config/capabilities (no Rust needed)
  deck-captures.ts  ✚ (d14) screenshots per tier/mode into captures/
src/
  cli.ts            EDIT (d11) + `--print-url` — the sole core change in this roadmap
desktop/            ✚ (d12) Tauri shell: src-tauri/{src/main.rs, tauri.conf.json, capabilities/}, README
docs/
  deck-performance-budget.md ✚ (d00) measured ranges + tier table + re-measure instructions
  deck-validation-report.md  ✚ (d03v) THE GATE: ten-section evidence report + verdict recommendation
  deck-architecture.md       ✚ (d14) as-built note (sibling of docs/web-dashboard-architecture.md)
captures/
  deck-validation/           ✚ (d03v) raw per-run metric JSON (fixture ×1/×4, live)
tests/
  deck-perf.test.ts, deck-loop.test.ts, deck-model.test.ts, deck-focus.test.ts, deck-lanes.test.ts,
  deck-alerts.test.ts, deck-deltas.test.ts, deck-history.test.ts, deck-fallback.test.ts,
  deck-palette.test.ts, deck-ambient.test.ts ✚ (by slice), plus e2e/{deck,deck-inspector,
  deck-control,deck-a11y}.e2e.ts ✚
  e2e/deck.e2e.ts    ✚  browser behaviour: surface switch, focus, live window, dock, keymap, fallback
```

### B.4 Boundary rules, written down as tests (not conventions)

| Rule | Enforced by |
|---|---|
| `web/src/**` is API-only: no `node:*`, no `../src/`, no `new WebSocket` | existing `tests/release-gate.test.ts:401` (already passing) |
| `scene/**` except `renderer.ts`/`Deck*.tsx` must not import `three` | new assertion added to `tests/release-gate.test.ts` (d01) |
| The deck opens no `EventSource` and calls no `fetch` | new assertion: `scene/**` contains no `fetch(`, no `new EventSource` (d01) |
| The deck imports no store/control module | covered by rule 1 + a path assertion in the same test |
| Scene layout is a pure function of the roadmap, never of status | `test: same slices → identical coordinates across 5 status permutations` (d02) |

---

# C. Technology decisions (architectural checkpoints)

Each checkpoint states the decision, the alternatives, why the decision wins, the evidence,
and the trigger that would make us reconsider. **CP-1…CP-4 are binding for every slice below;
a slice that violates one is rejected in review even if its tests pass.**

### CP-1 — Where the deck lives: `web/src/scene/**` inside the existing web app

- **Decision:** the deck is a module of the existing SPA, lazy-loaded as its own chunk,
  selected by `?surface=deck`. Not a separate app, not a separate package.
- **Alternatives:** (a) a new sibling Vite app `deck/` with its own build; (b) a workspace
  package with the dashboard; (c) a second entry point in the same Vite build.
- **Why:** `tests/release-gate.test.ts:401` walks **`web/src`** and enforces API-only. Code
  there is architecturally incapable of reaching the store — a free, already-enforced
  guarantee. A sibling app escapes that lock and immediately re-opens the question of what a
  UI may import. The dashboard also already owns everything the deck needs: DTOs
  (`api.ts`), pure derivations (`lib/*`), the design system (`tokens.css`), the version
  handshake/stale banner, the CSP, the asset embedding (`scripts/embed-web.ts` globs all of
  `web/dist/**`), and the Playwright harness. A second app would duplicate build, embed,
  version, CSP and test infrastructure for zero functional gain.
- **Evidence:** `tests/release-gate.test.ts:401-440`; `scripts/embed-web.ts` (`collect(DIST)`
  recurses everything); `src/server.ts:1420-1433` (SPA fallback for any non-`/api` path).
- **Reconsider if:** the deck's chunk exceeds ~2 MB gzipped and dominates the dashboard's
  install/first-load for users who never open it (then: keep the module, move the chunk
  behind a runtime `import()` gate that is already planned, or split `renderer.ts` into an
  optional second chunk).

### CP-2 — Renderer: `three` (WebGL2, `WebGLRenderer`), imperative, **no** react-three-fiber

- **Decision:** `three@0.186.0` (pinned) consumed through a thin imperative adapter
  (`renderer.ts`) that diff-applies a pure `DeckModel`. React owns only the DOM overlay and
  the component boundary.
- **Alternatives:** (a) React Three Fiber + drei; (b) Babylon.js; (c) raw WebGL2;
  (d) CSS 3D transforms only.
- **Why:**
  - The scene is a **small, mostly static graph** (one instanced pool for roadmap pads, one
    `LineSegments` for dependency edges, ≤ 8 active stations) whose per-frame work is
    numeric mutation, not composition. A reconciler adds a dependency and an abstraction
    layer to solve a problem we do not have; R3F's value (declarative composition of many
    heterogeneous elements) is maximized where ours is minimized.
  - The scene must be **unit-testable without a DOM**: `DeckModel` + `applyModel` diffing is
    the testable surface. Keeping the renderer imperative keeps `three` confined to one file
    that no test imports — asserted by rule 2 in B.4.
  - Babylon.js is heavier, ships its own GUI/post-processing culture, and buys nothing over
    three for a scene of primitives; raw WebGL2 means hand-writing matrix math, instancing
    and disposal for no benefit; CSS 3D cannot express the instanced rail/edge topology or
    hit-testing at this scale, and would force layout thrash on the main thread.
- **Evidence:** measured fill cost (A.6) — the binding constraint is **pixels and overdraw**,
  not scene-graph expressiveness. `three@0.186.0` has **zero runtime dependencies** (registry
  metadata) and ships `@types/three@0.186.0` for `bunx tsc --noEmit`.
- **Reconsider if:** the deck grows genuinely heterogeneous interactive 3D widgets (in-scene
  forms, drag handles, many independent animated sub-scenes) — then re-evaluate R3F with a
  measured prototype, not on taste. Also reconsider if `three`'s WebGL2 path is deprecated in
  favour of `WebGPURenderer` **and** the target runtime has real hardware acceleration (this
  machine does not).

### CP-3 — All text lives in the DOM; the canvas draws only geometry

- **Decision:** no in-scene text at all: no `TextGeometry`, no SDF/troika labels, no
  `CSS3DRenderer`, no canvas-texture sprites for prose. Station labels, the live window
  (`LiveFeed`), alerts, the inspector dock and the HUD are ordinary React DOM positioned over
  the canvas.
- **Alternatives:** (a) `troika-three-text`/SDF text; (b) `TextGeometry` from fonts;
  (c) a font atlas drawn into the scene; (d) `CSS3DRenderer` hybrid.
- **Why:** (1) measured cost — every rendered pixel is CPU-rasterized here (A.6), and text is
  the highest-pixel-cost, lowest-value thing to rasterize twice; (2) DOM text is crisp at any
  zoom, selectable, screen-reader accessible, keyboard reachable, trivially testable via
  Playwright assertions, and styled by the existing token system; (3) it makes the "3D must
  not obscure operational information" requirement structural rather than aspirational.
- **Evidence:** A.6 fill numbers; `web/src/components/LiveFeed.tsx` already implements the
  bounded live window in DOM; `tokens.css` already defines the status colors.
- **Reconsider if:** a future slice needs labels that must be occluded by geometry (then a
  small set of importance-ordered DOM labels with per-frame projection is still preferable to
  in-canvas text).

### CP-4 — Transport and state: reuse the existing HTTP+SSE read model and existing React state

- **Decision:** no new endpoints, no new persistence, no WebSocket, no client store library.
  `App.tsx` keeps owning fetch/SSE/polling; the deck receives props and returns intent
  callbacks. Deck-specific preferences (tier, reduced-motion, camera preset, frozen slice)
  live in `localStorage` under one key and are **view state only**.
- **Alternatives:** (a) WebSocket channel for worker output; (b) a Tauri IPC command surface
  reading `.omp/` directly; (c) zustand/redux/context store shared by both surfaces;
  (d) a new `/api/deck` aggregate endpoint.
- **Why:** the release gate **forbids `new WebSocket` in `web/src`** — the constraint is
  already encoded in the repo's own tests. The server already solves replay/ordering
  (`afterSeq`, `Last-Event-ID`, monotonic `seq`) and caps (tails ≤ 500 lines, `DIFF_CAP`).
  A store library would duplicate state that `App.tsx` already holds and would need to be
  threaded through both surfaces. A `/api/deck` aggregate would be a second read model to
  keep in sync with `SliceDetail`/`RunDetail` — precisely the duplication this roadmap
  forbids. *(If the deck ever exceeds the 900 ms/2 s cadence's usefulness, the correct change
  is a `types=`- and `sliceId=`-filtered SSE subscription on the existing stream — an
  additive query parameter, not a new transport.)*
- **Evidence:** `tests/release-gate.test.ts` (`expect(text).not.toContain("new WebSocket")`);
  `docs/web-dashboard-architecture.md` §4 (SSE rationale, replay semantics, polling fallback =
  same model); `src/server.ts:19` (`POLL_MS = 900`).
- **Reconsider if:** worker transcript latency demonstrably harms operator decisions
  (> 2 s median lag measured against `worker-<n>.log` mtime), in which case reduce the tail
  poll interval for the focused slice only — still HTTP.

### CP-5 — Desktop shell: Tauri 2 loads the **ompo URL**; it is packaging, not a data path

- **Decision:** the shell creates one window pointing at `http://127.0.0.1:<port>/?surface=deck`,
  optionally spawning `ompo --no-open --print-url` as a sidecar and terminating it on exit.
  Tauri commands are limited to window/app/sidecar lifecycle. No `fs`, no `http`, no `shell`
  plugin beyond the sidecar execution, no Tauri-mediated data fetches.
- **Alternatives:** (a) bundle the SPA in the shell and call the API cross-origin; (b) a Tauri
  IPC layer reading `.omp/` with Rust; (c) skip Tauri, use `chrome --app=`/`msedge --app=`;
  (d) Electron.
- **Why:** (a) is **blocked by existing security design**: the shell's bundle would be a
  different origin, `connect-src 'self'` forbids the fetch, and `originAllowed()` rejects
  cross-origin POSTs — making it work requires weakening both. (b) would create a second
  reader of the store, breaking the architecture lock's intent and duplicating
  `server.ts` DTO logic in Rust. (c) is a real, zero-toolchain fallback and must ship anyway
  (`d11`). (d) Electron is 10× the footprint for the same webview contents.
- **Evidence:** `src/server.ts:838-845` (CSP), `originAllowed()`, `docs/web-dashboard-architecture.md` §7;
  no Rust toolchain and no `libwebkit2gtk-4.1` on this machine (A.6) → **Linux/WSL builds are
  not the first target**; WebView2 runtime 152.0.4191.66 exists on the Windows side.
- **Reconsider if:** the shell cannot demonstrate at least one capability the `--app=` fallback
  lacks (tray/autostart/packaged installer/always-on-top mini-HUD). If it cannot, drop Tauri
  (`d12` becomes a documented recipe, not code).

### CP-6 — Performance: design for a software rasterizer, tier the scene at runtime

- **Decision:** the deck targets three quality tiers selected at runtime from
  `UNMASKED_RENDERER_WEBGL` plus a 250 ms micro-benchmark:
  `minimal` (default when the renderer string matches `swiftshader|llvmpipe|software|basic render`),
  `standard`, `high`. Budgets are pinned in `docs/deck-performance-budget.md` and enforced by
  `scripts/deck-perf.ts`. Rendering is **on demand**: idle = zero frames; hard cap 30 fps
  (minimal) / 60 fps (standard+).
- **Alternatives:** (a) fixed 60 fps loop; (b) always-on post-processing and lighting;
  (c) drop 3D on weak machines entirely.
- **Why:** measured 41 ms/frame for one full-screen trivial layer at 1280×720 (A.6) makes a
  60 fps always-on loop physically impossible here; (c) throws away the product on the exact
  machine it is developed on. Tiering keeps one scene design with parameterized cost.
- **Evidence:** A.6 table (ranges across two runs, ~40 % spread); tier constants pinned in
  `tier.ts` and enforced by `d10`'s harness with ≥ 1.5× headroom.
- **Reconsider if:** a target machine shows hardware acceleration (real GPU renderer string),
  then `standard`/`high` become the defaults — the tier table changes, not the architecture.

### CP-7 — Scene model is pure data; the camera is view state; the layout never reflows

- **Decision:** `buildDeckModel` is a pure function of `(RunDetail, RunEvent[], AgentRow[],
  SliceDetail|null, selection, prefs)`. Roadmap node coordinates derive from `layoutDag`
  (existing) and depend **only on the roadmap** — never on slice status. The camera is a
  separate pure reducer (`camera.ts`) over explicit intents.
- **Alternatives:** (a) let the renderer derive visuals from DTOs directly; (b) re-layout the
  world as statuses change (force-directed / status-sorted columns).
- **Why:** (a) puts product logic in the least testable layer and violates "presentation
  layer, not source of truth"; (b) makes the world move under the operator's cursor exactly
  when they are reading it, and destroys the visual memory that makes a spatial UI valuable.
  Stable positions + state encoded by material/height/beacon is the whole point of a deck.
- **Evidence:** `web/src/lib/dag.ts:182 layoutDag` already returns stable `nodes[].x/y/depth`
  from roadmap structure alone; `web/src/lib/selection.ts:16 preferredSliceId` is the existing
  "which slice matters" rule the deck must reuse rather than reinvent.
- **Reconsider if:** real usage shows operators cannot find a failing slice without a spatial
  reordering (then: an explicit, animated "regroup" command the operator triggers — never a
  silent reflow).

### CP-8 — Dependency budget: one runtime dependency

| Package | Where | Why | Cost | Bun | Tauri | tsc |
|---|---|---|---|---|---|---|
| `three@0.186.0` | root `dependencies` | WebGL2 scene: instancing, math, disposal. Zero transitive deps. | ~600 KB raw in a lazy chunk; ~150 KB gzipped | pure ESM, no native bits | runs in webview like any ES module | types shipped via `@types/three@0.186.0` (devDependency) |
| `@tauri-apps/cli@2.11.4` + `@tauri-apps/api` | `dependencies` (d12 only) | shell build + window/sidecar APIs | dev-time binary in `node_modules`; 1 small runtime pkg | CLI is a native binary, installed via npm; invoked by `bunx` | is Tauri | not imported by `web/src` |
| `@types/three@0.186.0` | root `devDependencies` | `bunx tsc --noEmit` over `web/**/*` | types only | — | — | required |

**Explicitly rejected (do not add):** `@react-three/fiber`, `@react-three/drei`,
`zustand`/`redux`/`jotai`, `react-router`, `troika-three-text`, `postprocessing`,
`three-stdlib`, any glTF/DRACO/KTX2 loader (all geometry is code-generated primitives — no
3D asset pipeline exists in this roadmap), `ws`, `socket.io`, `tauri-plugin-fs`,
`tauri-plugin-http`, `tauri-plugin-shell` beyond sidecar execution, `electron`, `d3`,
`react-force-graph`, `framer-motion` (CSS transitions and the existing token system cover
what the deck needs; re-evaluate only with a measured case).


---

# D. The deck: spatial model and interaction contract

### D.1 The world (five entity types, all data-backed, nothing decorative-by-default)

| Entity | Backed by | Geometry (cheap primitives only) | Interaction |
|---|---|---|---|
| **Roadmap rail** — one pad per slice, laid out by dependency depth | `layoutDag(detail.slices)` → `nodes[].x/y/depth` lifted to the floor plane | one `InstancedMesh` (box pads), 1 draw call for the whole roadmap | click/Enter selects |
| **Dependency edges** | `layoutDag(...)` → `edges[]` (`satisfied`, `unknown`, `inCycle`) | one `LineSegments` (all edges), 1 draw call | hover highlights the two pads |
| **Station** — a live slice (`running`/`verifying`) | `RailNode` + `buildPipelineStages` + `AgentRow` | one mesh per active slice (≤ 8), height = progress in the 7-stage pipeline, emissive = state | click selects; `F` frames it |
| **Beacon** — alert marker attached to a pad/station | `deriveAlerts` (failed, blocked-env, verify-failed, review-rejected, wedged, verdict-stall, double-loop) | ≤ 32 instanced shapes; shape + pulse pattern, never color alone | click opens the dock on that slice |
| **History wall** — past runs | `api.runs()` → `RunSummary[]` | one instanced tile row, 1 draw call | click switches the whole surface to that run (`App.openRun`) |

Ambient (grid floor, fog, slow parallax) is **tier- and motion-gated** and is the last thing
built (`d13`), not the first. Nothing in the world is decoration: every object maps to a DTO
field, which is why the scene model can be unit-tested.

### D.2 Information hierarchy (hard requirement from the brief), and where each level lives

| Priority | Information | Modality | Not in 3D because |
|---|---|---|---|
| 1 | The active worker(s) | 3D station + DOM lane strip | — (the scene's raison d'être) |
| 2 | Current activity / live output | **DOM** docked window (`LiveFeed`, 5 meaningful rows) | text must be crisp, copyable, accessible |
| 3 | Current slice/run status | 3D station state + `RunHeader` hero line | — |
| 4 | Alerts and state transitions | 3D beacons + **DOM** alert stack (text-first) | an alert must be readable and keyboard-reachable |
| 5 | Supporting detail (report, metrics, artifacts) | **DOM** inspector tabs | density |
| 6 | History (previous runs, attempts, sessions) | 3D history wall + **DOM** tables | — |
| 7 | Ambient/exploratory | 3D, tier-gated | — |

**Rule:** the live window and the alert stack are never occluded by 3D geometry and never
depend on camera position (they are screen-space DOM). This is asserted by a layout test in
`d03`/`d05`, not left to visual judgment.

### D.3 What is deliberately 2D (do not put these in the scene)

Diffs, gate output tails, review findings, prompts/handoffs, raw logs, the event query DSL,
run/stat tables, plan preview, *any control confirmation*. These are dense, textual,
often long, and benefit from selection/search — the deck embeds the existing `Inspector` and
`SliceTable` for them (`d06`) rather than modelling them spatially. A 3D diff view is
explicitly out of scope for the entire roadmap.

### D.4 Camera model

- One perspective camera, orbital semantics around a target point: `{ target, distance, azimuth, elevation }`.
- **No free-fly.** Pan (`arrows`/WASD), orbit (drag), zoom (wheel/`+`/`-`), and three presets:
  `command` (over-the-shoulder onto the primary station), `rail` (elevated three-quarter view of
  the whole roadmap), `topology` (top-down DAG). Presets are lerped (`lerpCamera`, ~450 ms,
  disabled under reduced motion).
- `F` frames the selected slice; `Esc` releases the pin and returns the camera to the primary
  worker. **The camera never moves on its own while the operator has pinned a selection** —
  auto-framing is a behavior the operator can always escape, never a fight.
- Camera state is excluded from `DeckModel`, so scene-model tests are deterministic.

### D.5 Interaction contract (keyboard-first; every capability reachable without a mouse)

| Input | Effect |
|---|---|
| Click / `Enter` on focused pad | Select slice (drives the existing single selection system) |
| `F` | Frame the selection (pin) |
| `Esc` | Release pin → primary worker; second `Esc` closes the dock |
| `[` / `]` | Previous / next live worker (never "hunt through the scene") |
| `1`…`8` | Open the dock on inspector tab N (same tab ids as `Inspector.tsx:29`) |
| `Space` | Freeze / resume the live window for the focused slice |
| `E` | Expand the live window to the raw transcript window (same reducer as `LiveFeed`) |
| `C` | Cycle camera preset (`command` → `rail` → `topology`) |
| `0` | Reset camera to the current preset's default framing |
| `T` | Cycle quality tier (`auto` → `minimal` → `standard` → `high`) |
| `M` | Toggle reduced motion |
| `H` / `?` | Keymap + budget HUD |
| `D` | Switch to the dashboard surface (and back) — never traps the operator |
| `Tab` / `Shift+Tab` | Native focus order through the DOM overlay (not hijacked) |

Rules: keys are captured only when focus is inside the deck surface and no text input has
focus; `Esc` is the only sticky-global key; every key has a visible affordance in the HUD;
the keymap is data (`DECK_KEYS` in `scene/types.ts`) so the HUD, the help overlay and the
Playwright keymap test read the same table.

### D.6 Live output policy (bounded, and never lossy)

| Concern | Decision |
|---|---|
| Visible by default | `COMPACT_ROWS = 5` **meaningful** rows, via the existing `compactWindow` (newest meaningful rows + the newest raw line when it is newer than all of them) |
| Grouping | Existing `semanticLine` kinds (`read`/`run`/`turn`/`tool`/`say`/`note`/`warn`/`fail`/`event`); no new grouping rules |
| Repetition | Existing `alignLineIds` gives stable row identity; repeated identical rows coalesce visually via the existing enter/leave motion — no new dedupe heuristic |
| Animation | Row enter/leave is opacity+translate ≤ 150 ms; **disabled entirely** under reduced motion; the animation never delays text (the row is in the DOM before it animates) |
| Pause | `Space` sets a per-slice freeze flag (view state). Frozen = the window stops accepting new entries; a muted "frozen — N new rows" counter appears; resuming replays the newest window instantly (no queue drain animation) |
| History | `E` expands to the raw transcript (`LIVE_TAIL = 400` lines, server cap 500) with live-follow and `Jump to live` — the same component the dashboard uses |
| Forensics | The dock's `Log` tab + `Diff`/`Verify`/`Review`/`Prompt` tabs (existing endpoints, existing caps) |
| Raw logs | Always remain on disk under `.omp/roadmap/runs/<runId>/slices/<id>/` and from `ompo logs`; the deck never owns the canonical record |

### D.7 Multi-worker policy (primary, secondary, awareness)

- **Primary** = the live slice (`running`|`verifying`) that `preferredSliceId` ranks first —
  the same rule the dashboard and TUI already use. The camera defaults to it and the live
  window follows it **until** the operator pins a selection.
- **Secondary** = other live slices, ordered by `AgentRow.lane`, rendered as stations with a
  compact lane strip in the HUD; the HUD always shows `live: N` so the operator knows the
  count without looking at the world.
- **Switching** = `[`/`]` or click; switching never re-creates the scene graph (the model
  diff only changes materials/selection flags) and never resets the camera unless the
  operator asks (`F`).
- **Awareness** = off-screen live stations keep an edge-of-screen marker plus their HUD row;
  the operator can never be in a state where a worker runs unseen.
- **Degenerate case** = zero live slices: the camera relaxes to the `rail` preset and the
  selection falls back to the newest terminal slice (`preferredSliceId` already handles the
  ordering; the deck does not invent a second ranking).

### D.8 Alert policy

| Alert | Source (existing) | Severity | Beacon | Text |
|---|---|---|---|---|
| `failed` / slice terminal failure | `SliceSummary.status === "failed"` + `reason` | high | red shape + steady beacon | reason line in the stack |
| `blocked-env` | `SliceSummary.status === "blocked-env"` | high | amber shape + slow pulse | fix hint from the event detail |
| `verify-failed` (retrying) | `verify_failed` event for the current attempt | medium | amber beacon | failing gate name |
| `review-rejected` | `SliceDetail.review?.approved === false` | medium | violet beacon | first finding |
| `wedged` worker | `AgentRow.wedged` / `staleForMs` (`WORKER_WEDGE_STALE_MS`, 10 min) | high | pulsing beacon | "transcript silent <N>m" |
| `verdict-stall` | `SliceDetail.verdictStall.idleMs` (`VERDICT_STALL_MS`, 10 min) | medium | dim beacon | "gates idle <N>m" — wired as advisory, never as "stuck" |
| `double-loop` | `RunDetail.loops.length > 1` | high | persistent banner (DOM) | pid list — two writers corrupt a run |

Rules: severity is expressed by **shape + motion + text**, never color alone; alerts sort by
severity then recency in the DOM stack; dismissal is per `(runId, sliceId, kind, lastSeq)` and
stored client-side; a dismissed condition that *recurs* re-raises (new seq).

---

# E. Slice index

Slice bodies follow section J at the end of this file (parser constraint: `## ` opens a slice,
so slice bodies are the only `##`-headed content in this document).

| Id | Title | Depends | Effort | Delivers |
|---|---|---|---|---|
| `d00` | Deck rendering probe and performance budget | — | med | measured budgets + tier classifier + probe script |
| `d01` | Deck surface, guarded render loop, HUD, instrumentation | d00 | hi | `?surface=deck` renders a real WebGL canvas on a measured, budgeted loop, with the counters the gate needs |
| `d02` | Scene model and the roadmap rail | d01 | hi | the whole roadmap as an interactive spatial object |
| `d03` | Active-worker focus and the bounded live window | d02 | hi | the running worker is the protagonist, with real live output |
| **`d03v`** | **Gate G1 — validation run and evidence report** | d03 | med | **the measured verdict on whether this roadmap continues** |
| `d04` … `d14` | every later slice | **d03v** (see F) | — | **gated: not startable until the gate's report exists and its verdict permits** |
| `d04` | Multi-worker command centre | d03v | hi | N concurrent workers, focus switching, awareness |
| `d05` | Lifecycle choreography and alerts | d03v | med | state transitions you can see; alerts you can read |
| `d06` | Inspection dock over existing endpoints | d03v | med | Output/Diff/Verify/Review/Prompt/Events/Usage/Log in the deck |
| `d07` | Temporal layer: event ribbon, replay, history wall | d03v | med | where the run has been, and previous runs |
| `d08` | Control from the deck | d06 | med | retry/skip/park/kill/pause/resume/jobs without leaving the deck |
| `d09` | Fallback, accessibility, and the no-WebGL path | d03v | med | the deck degrades instead of failing |
| `d10` | Performance hardening and budget enforcement | d03v | hi | pinned frame/object/draw-call budgets, enforced by a harness |
| `d11` | Launcher and `ompo --print-url` handshake | d03v | med | one command opens the deck in an app window (no Rust needed) |
| `d12` | Tauri 2 desktop shell (Windows-first) | d11 | hi | packaged desktop app; WSL/Linux documented as unsupported-without-prereqs |
| `d13` | Expression pass (ambient, completion, choreography) | d03v | med | the deck becomes a place rather than a diagram |
| `d14` | Operability, docs, evidence, release gate | d12 d13 | med | the deck is shippable and maintainable |

Note on the two rows for `d04`–`d14`: the first row states the gate rule; the second row is the
slice's own technical dependency. A slice is startable only when **both** are satisfied — the
technical dependency (`d10` also needs `d05`, `d13` also needs `d10`, `d14` needs `d12`+`d13`), and
the gate verdict from §0.5.

---

# F. Cross-slice dependency graph

### F.1 Graph

```
                                  d00  (probe + budget + tier classifier)
                                   │
                                  d01  (surface, render loop, HUD, instrumentation)
                                   │
                                  d02  (deck model + roadmap rail)
                                   │
                                  d03  (active-worker focus + live window)
                                   │
                                 d03v  ◄── VALIDATION GATE: measures M1–M13, writes the
                                   │        evidence report, recommends continue/revise/stop
      ═════════════════════════════▼════════════════════════════════════════════════════
       NOTHING BELOW STARTS WITHOUT A VERDICT (§0.5); the gate may drop these slices
                        ┌──────────┼──────────┬───────────────┐
                        │          │          │               │
                       d04        d05        d06             d07
                  (multi-worker) (lifecycle (inspection)  (temporal:
                        │         + alerts)     │          ribbon,
                        │            │          d08        replay,
                        │            │       (control)     history wall)
                       d09           │                        │
                  (fallback,         │                        │
                   a11y)             │                        │
                        └──────┬─────┘                        │
                              d10                             │
                     (perf hardening)                         │
                              │                               │
                              └──────────► d13 ◄──────────────┘   (expression pass)
                                           │
  d01 ──► d11 (launcher + --print-url) ──► d12 (Tauri shell) ──► d14 (operability + release)
                                                                  ▲
                                                                  └── d13
```

### F.2 Schedule waves (what `--jobs N` may parallelize, and what it must not)

| Wave | Slices | Notes |
|---|---|---|
| 0 | `d00` | nothing to parallelize; it produces the numbers everything else budgets against |
| 1 | `d01` → `d02` → `d03` | strict chain: each establishes the contract the next consumes (`Deck` boundary → model → focus) |
| 2 | **`d03v`** | **the gate.** Serial by definition: one live run, one measurement protocol, one report, one verdict. Nothing else may be in flight |
| 3 | `d04` ∥ `d11` | only after a PASS/WITH-CHANGES verdict: `d04` owns `scene/model.ts` + overlay lanes; `d11` owns `src/cli.ts` + `scripts/` + launcher |
| 4 | `d05` → `d10` | `d10` measures what `d05` introduced (transitions/beacons) |
| 5 | `d06` → `d08` | `d08` reuses the dock's selection plumbing |
| 6 | `d07` ∥ `d09` | `d07` is mostly new files; `d09` is `scene/fallback.ts` + a11y wiring |
| 7 | `d12` | needs `d11`'s handshake; heavy, serial |
| 8 | `d13` → `d14` | expression last, then docs/evidence |

**A failing or missing gate verdict makes waves 3–8 undefined.** The gate's disposition table
(§0.6 item 10) is the schedule for everything after it; this table assumes the optimistic verdict
and is explicitly not authoritative in the other two cases.

**Serialization point to respect:** `web/src/App.tsx` and `web/src/scene/Deck.tsx` are the
shared wiring files. Every slice touches them minimally (one import + one prop each) — but
two concurrent slices editing them will conflict on merge. Run `--jobs 1` by default; the only
batch this roadmap recommends parallelizing is `{d04, d11}` and `{d07, d09}`, and even then
only because their `App.tsx` edits are on different lines.

### F.3 File-ownership matrix (the `Files:` trailers, collected)

| Slice | Owns (creates/edits) |
|---|---|
| `d00` | ✚ `scripts/deck-probe.ts`, ✚ `docs/deck-performance-budget.md`, ✚ `web/src/scene/tier.ts`, ✚ `tests/deck-perf.test.ts` |
| `d01` | ✚ `scene/{Deck.tsx,renderer.ts,loop.ts,types.ts,instrument.ts}`, `web/src/App.tsx`, `web/src/components/Header.tsx`, `package.json`, ✚ `tests/e2e/deck.e2e.ts`, `tests/release-gate.test.ts` |
| `d02` | ✚ `scene/{model.ts,rail.ts}`, `scene/Deck.tsx`, ✚ `tests/deck-model.test.ts` |
| `d03` | ✚ `scene/{focus.ts,DeckOverlay.tsx}`, `scene/{model.ts,Deck.tsx}`, ✚ `tests/deck-focus.test.ts` |
| `d04` | `scene/{model.ts,DeckOverlay.tsx,Deck.tsx}`, ✚ `scene/lanes.ts`, ✚ `tests/deck-lanes.test.ts` |
| `d05` | ✚ `scene/alerts.ts`, `scene/model.ts`, `scene/DeckOverlay.tsx`, ✚ `tests/deck-alerts.test.ts` |
| `d03v` | ✚ `scripts/deck-validate.ts`, ✚ `docs/deck-validation-report.md`, ✚ `captures/deck-validation/**`, `scene/instrument.ts` |
| `d06` | ✚ `scene/DeckInspector.tsx`, `scene/Deck.tsx`, ✚ `tests/e2e/deck-inspector.e2e.ts` |
| `d07` | ✚ `scene/history.ts`, ✚ `scene/HistoryWall.tsx`, `scene/Deck.tsx`, ✚ `tests/deck-history.test.ts` |
| `d08` | `scene/DeckInspector.tsx`, `scene/Deck.tsx`, ✚ `tests/e2e/deck-control.e2e.ts` |
| `d09` | ✚ `scene/fallback.ts`, `scene/Deck.tsx`, `scene/DeckOverlay.tsx`, ✚ `tests/e2e/deck-a11y.e2e.ts` |
| `d10` | ✚ `scripts/deck-perf.ts`, `scene/{loop.ts,renderer.ts,tier.ts}`, `docs/deck-performance-budget.md`, ✚ `tests/deck-perf.test.ts` |
| `d11` | `src/cli.ts`, ✚ `scripts/deck-open.ts`, `README.md`, `tests/release-gate.test.ts` (it already spawns `bun src/cli.ts`), ✚ `tests/deck-launch.test.ts` |
| `d12` | ✚ `desktop/src-tauri/**` (crate, config, capabilities), ✚ `desktop/README.md`, ✚ `scripts/deck-desktop-check.ts`, `package.json`, `.gitignore` |
| `d13` | ✚ `scene/ambient.ts`, `scene/{renderer.ts,model.ts}`, ✚ `tests/deck-ambient.test.ts` |
| `d14` | ✚ `docs/deck-architecture.md`, `README.md`, ✚ `scripts/deck-captures.ts`, ✚ `captures/deck-*.png`, `tests/e2e/deck.e2e.ts`, `tests/release-gate.test.ts` |

---

# G. Risk register (ranked by severity × likelihood)

| # | Risk | Sev | Like | Mitigation (encoded where) |
|---|---|---|---|---|
| R1 | **The dev machine is a software rasterizer** — a naive scene runs at 2–8 fps and the whole product feels broken | High | High | measured budget with repeat sampling in `d00`; tier classifier + on-demand loop in `d01`; budget harness with ≥ 1.5× headroom and auto-downgrade in `d10`; DOM text (CP-3) removes the largest pixel cost |
| R2 | **Tauri cannot build on this machine** (no Rust, no `libwebkit2gtk-4.1`) and Linux/WSLg WebKitGTK would be slower than the browser it wraps | High | High | `d11` ships the zero-toolchain launcher first; `d12` targets **Windows/WebView2** explicitly; Linux prerequisites documented, not assumed; `d14` records the fallback |
| R3 | **3D makes the UX worse** — the operator loses the crisp 2D workspace they already have | High | Medium | the deck never replaces the dashboard (`?surface=`), the live window is DOM and always visible, keyboard parity table in §D.5, `d09` proves the 2D fallback, `d14` requires the "is the deck actually better?" comparison in the docs |
| R4 | **Scope creep into "everything in 3D"** (diff views, log walls, shader polish) | High | High | §D.3 names the excluded surfaces; every slice has an explicit non-scope; `d13` is last and effect-gated |
| R5 | **Duplicated orchestration logic sneaks into the UI** | High | Low | release-gate architecture lock (API-only `web/src`), plus the new "no `fetch`/no `EventSource` in `scene/**`" assertion (`d01`); review checklist item |
| R6 | **Renderer lifecycle leaks** (GPU resources, rAF loops, listeners) on surface switching | Medium | High | `dispose()` contract in `renderer.ts`; loop ownership in `d01`; e2e test that switches surfaces 20× and asserts a stable WebGL context count and zero growth in `renderer.info.memory` (`d10`) |
| R7 | **Z-order/input routing between canvas and DOM overlay degrades** (dead zones, keyboard traps) | Medium | Medium | overlay is a sibling with `pointer-events` discipline; `d09` keyboard-only walkthrough; `d03` asserts the live window is never occluded |
| R8 | **Bundle growth** — three.js in a committed, embedded bundle (`src/webAssets.generated.ts`, currently 748 KB) | Medium | Medium | lazy chunk (CP-1); the embedded file grows by ~800 KB → repo + binary weight recorded in `d01`; reconsider trigger in CP-1 |
| R9 | **Polling load** — every deck adds a 2 s tail poll and a 900 ms SSE stream | Low | Medium | reuse the existing cadence; only the focused slice is tailed (`d03`); `d10` measures request rate; the deck must not open a second stream |
| R10 | **Stale fixture realism** — only one real run exists on disk (`.omp/roadmap/runs/20260909-kph0as`, 24 slices) | Medium | Medium | `d02`/`d10` build fixtures from that run's real `events.jsonl` plus synthetic multi-worker states; the e2e fixture server (`tests/e2e/serve.ts`) already manufactures 14/20-slice projects |
| R11 | **Merge conflicts between parallel slices** editing `App.tsx`/`Deck.tsx` | Medium | Medium | §F.2 waves; `--jobs 1` default; tiny, line-disjoint wiring edits |
| R12 | **`three` API churn** (r186 → r190+) breaking the renderer | Low | Medium | `three` pinned exactly; renderer confined to one file; upgrade is a deliberate slice, never a transitive bump |
| R13 | **Accessibility regression** — a 3D surface that is unusable by keyboard/screen reader | Medium | Medium | DOM text (CP-3), §D.5 keymap with visible affordances, `d09` acceptance criteria incl. a text mirror of deck focus state |
| R14 | **Alert fatigue / visual noise** re-making the dashboard's "wall of status" | Medium | Medium | §D.8 severity + dismissal + recurrence rule; beacons capped at 32; alert stack is text-first and collapsible |
| R15 | **Review-gate friction**: `bun run test:e2e` needs Playwright browsers present | Low | Medium | gates name the prerequisite; CI's e2e job already installs chromium |
| R16 | **A slice "polishes" instead of shipping capability** (cosmetic work reaching a functional slice) | Medium | Medium | every slice's non-scope forbids cosmetic work before `d13`; `d13` is the only slice allowed to touch materials/ambient/choreography |
| R17 | **The gate is gamed or hollow** — verdict reached from fixture data, a demo run, or a report with no raw artifacts | High | Medium | §0.2 "what real means"; §0.5 rule 5 (`--live` mandatory); rule 3 (unmeasured must be stated); rule 2 (a report with no negatives is bounced); §0.6 requires linked raw JSON |
| R18 | **A passing gate still hides a product no one uses** — the deck is technically fine and operationally pointless | High | Medium | §0.5's M10 is a *task* comparison, not a vibe check; the report must name where the dashboard/TUI wins; `d14` records the "when is the dashboard the better tool" guidance; a usage-based revisit trigger is added to the final definition (I) |
| R19 | **The gate is treated as a formality and waves 3–8 start early** ("we already know it works") | High | Medium | the gate is encoded in `Depends:` for every downstream slice, so ompo itself refuses to schedule them; the report's disposition table is the only schedule |

---

# H. Architecture red-team

### 1. What is the biggest architectural risk?

**The scene becomes a second source of truth.** Every spatial UI grows this failure mode:
positions, "progress", "selected", "alert" start life as derived values and end life as state
the scene owns and mutates. Mitigations already in the plan: `buildDeckModel` is pure and
takes the existing DTOs verbatim; the camera is a separate reducer; the only persisted deck
state is view preference in `localStorage`; layout depends on roadmap structure only (CP-7);
and `scene/**` is forbidden from importing `three` outside the renderer, which makes the
temptation to "just keep it in the scene" structurally awkward. This is the risk to re-check
in *every* review, not once.

### 2. What part is unnecessary complexity?

`?surface=deck` **plus** a header toggle **plus** a `D` keybinding is three ways to do one
thing. The query param is required (the desktop shell needs a URL); the toggle is required
(discoverability from the dashboard). The `D` key is the one to cut if the keymap grows
crowded — it is listed as the least load-bearing binding in §D.5.
Second candidate: the `H`/`?` keymap overlay could be a static `title` attribute plus the
docs. It survives only because `d09` needs a visible affordance per key for accessibility.

### 3. What part is likely to become a maintenance nightmare?

**The DOM overlay's positioning/responsiveness.** Any screen-space layer that must stay
aligned with a 3D scene across window resizes, DPI changes, sidebar collapse, inspector
open/close, tiers and reduced-motion becomes a pile of magic numbers. The plan's defence is
that the overlay is *not* projected onto the scene: it is a normal docked layout (live window
bottom-left, alert stack top-right, HUD top-left), and 3D objects are framed by the camera
rather than DOM being tracked to geometry. That constraint must not erode — the moment
someone adds "a label pinned to a station", projection math enters the codebase.
If per-station labels are ever needed, they get one small, tested projector module, not
ad-hoc `getBoundingClientRect` math.

### 4. Where are we accidentally rebuilding something ompo already has?

Four places, all called out in the slices: (a) a live-window/scroll model — `lib/stream.ts`
already implements `compactWindow`/`buildLiveStream`/`followFromScroll`; the deck must import
them (`d03`) rather than write a new one. (b) "which slice needs attention" — `preferredSliceId`
(`d03`). (c) "what is it doing" — `heroAction` (`d03`). (d) roadmap layout — `layoutDag`/`dagDepths`
(`d02`); a custom force-directed layout would be new graph logic that the 2D DAG already answers.
(e) The biggest structural one: **file/URL watching and process management.** Tauri tempts you
to spawn/reap ompo and watch `.omp/`. Resist: `server.ts` already does spawn/kill/observe and
`ompo doctor` already does preflight.

### 5. Where could Tauri become an unnecessary dependency?

Everywhere except "the operator wants an app icon, a titleless window, and a packaged
installer." If `d11`'s launcher (`ompo --no-open --print-url` + a browser `--app=` window) is
sufficient in practice, `d12` is 400 lines of Rust, a capability file, a per-platform build
matrix and a Rust toolchain requirement — for window chrome. The plan therefore makes `d12`
**explicitly droppable** and keeps it off the critical path (`d11` → `d14` may skip `d12`
entirely if `d12` is dropped). The evidence that would kill it: if the shell cannot show a
capability the launcher lacks, drop it (CP-5 reconsider trigger).

### 6. Where could 3D make the UX worse?

- **Reading.** Any text placed in the scene loses crispness, selection, search and screen
  readers → CP-3 forbids it.
- **Finding.** If the world rearranges, the operator loses spatial memory → CP-7 forbids
  status-driven layout.
- **Comparing.** A 2D table/board is genuinely better for scanning 24 slices' statuses at once;
  the deck must not pretend otherwise. The roadmap keeps the dashboard one keystroke away and
  requires the deck's pads to *encode the same information* the table shows (status, attempt,
  generation, effort) rather than an abstraction of it.
- **Speed.** Camera moves cost frames on a software rasterizer. Auto-framing is limited to
  selection changes and always escapable (§D.4).

### 7. What happens on a weak GPU?

Measured on the target machine: SwiftShader, ~44 ns/pixel for a trivial shader (A.6).
Consequences, all designed in: the tier probe selects `minimal` (640×360 backing store,
resolution scale 0.5, no antialias, no lighting, no shadows, no post, ≤ 8 ms CPU/frame,
30 fps cap); rendering is on demand so an idle deck costs **zero** frames; DOM overlays
composite in the browser's own rasterizer; overdraw is capped at ~1× by design (flat pads,
no full-screen ground plane filling the viewport, no translucent stacks).
If even `minimal` fails the budget, the deck falls back to the flat 2D projection (`d09`)
rather than shipping something that stutters — and the operator keeps the dashboard, which
never stopped working.

### 8. What happens if 100,000 log events arrive?

Nothing unbounded happens anywhere in the deck, because the deck never materialises the log:
- The **event list** in `App.tsx` is already paged from `/api/events?afterSeq=N&limit=200`;
  the deck consumes the same array the dashboard does.
- The **live window** is `compactWindow(…, 5)` over at most `LIVE_TAIL = 400` transcript lines
  fetched per poll; older lines are simply not fetched.
- The **event ribbon** (`d07`) must aggregate by time bucket (a pure function over the event
  array with an explicit cap), never render per event.
- The **scene** holds one instanced pool sized by slice count (≈ 25), not by event count.
- Raw volume stays on disk (`events.jsonl`) and is reachable through `ompo log`, `ompo query`
  and the existing caps — the UI deliberately shows a bounded projection.
Risk remaining: the server's 900 ms poll re-reads the whole `events.jsonl` (documented as an
accepted trade-off in `docs/development-prd.md` §12 — "no `fs.watch` incremental reads").
A 100k-event run would slow the *server*, not the deck; that is an ompo-core concern and is
out of scope here (explicitly listed in `d14`'s non-scope as a known upstream limit).

### 9. What happens if multiple workers emit events simultaneously?

The store's `seq` is monotonic per run (`cursor.nextSeq`) and the UI dedups on `seq` and
advances to the max seen, so interleaved events from concurrent slices are ordered by seq, not
by arrival. `AgentRow.lane` (board order) and `SliceSummary.id` disambiguate attribution;
every progress line already carries an `[id]`-style prefix (`src/attempt.ts formatProgressLine`).
The deck renders one station per live slice and never merges two slices into one visual entity.
Ordering edge case: two events with the same millisecond timestamp are still totally ordered by
`seq` — tests must assert on `seq`, never on time.

### 10. What happens if the desktop application crashes while ompo continues running?

Nothing is lost, because the shell owns no state: the loop runs out-of-process (`ompo resume`
child or a terminal-run loop), state is durable in `.omp/roadmap/runs/<runId>/`, and the
dashboard server is either inside the shell's own sidecar (then it dies too — harmless: the
loop keeps running, `resume` can reattach) or a separately launched `ompo` (then the deck just
reconnects). Restarting the shell re-reads everything from the store. This is the concrete
payoff of CP-5: a shell with no data path cannot lose data.

Caveat to state honestly: if the shell spawned the sidecar, the sidecar dies with it, and any
*viewing* is gone; a *running loop* is unaffected only because loops are spawned detached
(`spawnDetachedResume`). Killing the sidecar never kills a loop — the lock file is the
single-flight authority, not the shell.

### 11. What happens if ompo crashes while the UI remains open?

The deck is a poller; it shows what the store says. Failure modes already encoded in the
existing UI and reused by the deck:
- SSE connection drops → the existing `es.onerror` path closes and falls back to the 900 ms
  poll (`web/src/App.tsx:14,98-124`); the HUD shows a "stream degraded — polling" badge.
- Run lock lost while slices read `running` → `RunSummary.live === false` and the existing
  wedge/stall signals (`AgentRow.wedged`, `verdictStall`) drive a "loop not holding the lock"
  alert (`d05`).
- Resume is offered only through the existing quiescent-only endpoint, which the dashboard
  already hides/positions correctly (`live === false`).
The deck adds **no** recovery logic of its own; that is the entire point.

### 12. What happens if the UI disconnects and reconnects?

Reconnect replays from the last seen `seq` (`?afterSeq=` / `Last-Event-ID`), and the deck
re-derives everything from the read endpoints — board and slice state are always re-derived,
never accumulated (`docs/web-dashboard-architecture.md` §4). The deck's derived model is a pure
function of the current DTOs, so a reconnect converges to the same scene without a
"resync animation" or a stale ghost entity. `d05` tests precisely this: same DTOs, same model,
regardless of event history.

### 13. What happens if a run is resumed from disk?

Resume is the normal path, not an edge case: `ompo resume` rebuilds from `events.jsonl`,
`running|verifying|aborted` demote to `pending` with attempts preserved, `done` never re-runs.
The deck sees a new `run_resumed` event and statuses moving back from in-flight states; because
layout is status-independent (CP-7), pads stay put and only materials/beacons change. Attempts
and generations advance in the station label (from `SliceSummary.attempts/generation`).
Sessions spawned by unblock/debug appear through the existing `/sessions` endpoint (`d07`
may surface them as a secondary list — not required for the deck to be correct).

### 14. What parts should absolutely remain boring 2D UI?

Diff views, gate/verify output tails, review findings, prompts/handoffs, raw logs, the event
query DSL, run/stat tables, plan preview, control confirmations, the stale-bundle banner, and
every error message. Also: any list longer than ~10 items, anything selectable/copyable, and
anything a screen reader must read. §D.3 is that list; `d14` re-checks it against the shipped
UI and reports where the deck drifted.

### 15. What should NOT be implemented despite sounding cool?

- **Free-fly camera / WASD flying.** Nauseating on a software rasterizer, and it makes
  "where is my worker" a navigation problem.
- **Post-processing** (bloom, SSAO, DOF) — full-screen passes at 40–500 ms/frame here.
- **Particle swarms per log line or per tool call.** Pretty, unreadable, and it makes
  rendering cost proportional to activity.
- **3D diff/log walls.** Worse than the 2D versions at every task they claim to improve.
- **Skinned/GLTF character or decorative models.** Asset pipeline, licensing, loaders, size —
  for zero operational information.
- **Sound effects.** No.
- **Multiple concurrent 3D surfaces/windows.** Doubles the render cost for an operator who has
  one pair of eyes.
- **A second store/index/DB for the deck** ("so it can query history fast"). ompo already
  answers this with `stats`/`query`/`export`.
- **VR/XR.** Explicitly out of scope; the payoff is negative for a text-heavy operator surface.
- **In-browser roadmap editing.** The dashboard already refuses this deliberately; the deck
  must not become the back door.

### 16. What if the gate passes but the premise is still wrong?

A gate can only falsify the *stated* hypothesis. It cannot prove that a spatial surface is worth
its cost in daily use — a deck can pass every metric and still be opened twice a month. So passing
G1 is permission to continue **one** more wave, not a mandate for the whole roadmap: `d04`–`d06`
are the next falsifiable step (does spatial multi-worker monitoring survive real concurrency?), and
the disposition table at the gate is where slices get dropped. The honest revisit trigger is usage,
not opinion: if after `d06` the deck is not the surface the operator reaches for when a run is
live, `d07`–`d13` should be dropped in favour of keeping `d01`–`d06` as a stable view. That
decision point is recorded in `d14` as a required section.

### 17. What if the measurements are fine but the *instrumentation* is the thing we built?

`d01` adds counters (`frames`, commits, mutations, long tasks, heap) and `d03v` consumes them.
There is a real risk that the instrumented deck measures itself rather than the workflow, and that
the numbers look good because the scene is trivially small at gate time (one worker, one station,
25 pads). Mitigation: the gate protocol measures **twice** — once with the live slice set, and once
with a synthetic ×4 scene (100 pads, 4 stations) driven by the `--fixture` mode — and reports both
columns. A metric that passes at ×1 and fails at ×4 is a `REVISE`, not a `PASS`.

---

# I. Definition of the final product

**Everything in this section is conditional on the validation gate (§0) passing.** If G1 returns
`STOP`, the final product of this line is `d00`–`d03v` plus this report, and that is a legitimate,
complete outcome: the dashboard and TUI remain the operator surfaces, and the repository carries an
evidence-backed answer to a real question instead of an unfinished subsystem. If G1 returns
`REVISE`, this definition is edited by that verdict before `d04` starts.

When this roadmap completes, an operator working in a project directory that has a run in
`.omp/roadmap/` can:

1. Run `ompo` (dashboard) and switch to the deck with `?surface=deck` or the header toggle —
   **or** launch it as a desktop app / app-window (`d11`, and `d12` on Windows).
2. See the **whole roadmap as a spatial rail**: one pad per slice at a stable position derived
   from the dependency graph, with dependency edges, and with status/attempt/generation/effort
   readable on the pad and in the HUD.
3. See **every live worker as a station** whose height and material track the seven-stage
   lifecycle, with the **primary worker auto-framed** by the same ranking the TUI uses, and
   off-screen live workers marked at the screen edge plus counted in the HUD.
4. Read **live output** in a bounded DOM window (5 meaningful rows) with freeze/resume,
   expand-to-raw (`LIVE_TAIL` 400), and live-follow — never a wall of stdout, never a lost line.
5. **Inspect** Output/Diff/Verify/Review/Prompt/Events/Usage/Log for the selected slice without
   leaving the deck (existing endpoints, existing caps).
6. **Control** the run through the existing intent path (retry/skip/park/kill/pause/resume/
   set-jobs/restart-loop) with the same confirmations and the same queued-vs-direct feedback.
7. **Move through time**: see per-attempt segments, alert history, and previous runs as a
   history wall, and switch the entire surface to another run (read-only) without reloading.
8. **Never be blind**: alerts for failure, environment block, review rejection, wedged worker,
   stalled verdicts and double-loop runs appear as beacons **and** as readable, dismissible
   text; nothing important is encoded by colour alone.
9. **Degrade cleanly**: no WebGL, weak GPU, reduced motion, or a small window yields a usable
   flat projection / low-tier scene — and the 2D dashboard is always one key away.
10. **Trust the numbers**: the deck's scene is a pure projection of the same DTOs the dashboard
    and TUI use; the same run viewed in the TUI, the dashboard and the deck shows the same
    state, because there is exactly one source of truth and one transport.

Explicitly **not** part of the final product: any orchestration logic, any new persistence,
any new endpoint, any 3D rendering of diffs/logs/prompts, VR, sound, decorative assets, or a
second way to mutate a run.

---

# J. Recommended implementation order

An implementation agent should proceed strictly in this order, stopping at each checkpoint to
run the slice's gates before starting the next:

**Phase 0 — the gate (do not skip, do not rush, do not pre-start Phase 1).**

1. **`d00`** — measure first. Re-run `scripts/deck-probe.ts` on the target machine and confirm the
   tier thresholds in `docs/deck-performance-budget.md` match reality (repeat sampling: the spread
   is ~40 %). Do not start `d01` until the budget exists: every later slice is judged against it.
2. **`d01`** — surface, loop, **and the instrumentation the gate will consume** (frames, React
   commits, DOM mutations, long tasks, heap, `renderer.info`). **Checkpoint:** the deck loads as a
   lazy chunk under the existing CSP, the release-gate lock is extended to `scene/**`, and the
   counters are live *before* any scene code lands.
3. **`d02`** — model + rail. **Checkpoint:** `tests/deck-model.test.ts` proves layout stability
   across status permutations, model purity, and that the model derives nothing the DTOs do not
   provide (M1's source scan).
4. **`d03`** — focus + live window. **Checkpoint:** a real run's active worker, its real output, and
   the M4/M6 instruments (event-to-screen latency, log-volume isolation) producing numbers.
5. **`d03v`** — **the gate.** One real live session, the full M1–M13 protocol, the evidence report
   at `docs/deck-validation-report.md`, and a recommendation with a per-slice disposition table.
   **Stop here.** The gate's verdict — not the roadmap's optimism — decides whether Phase 1 exists.
   If the verdict is `STOP`, delete/close `d04`+ and stop; if `REVISE`, rewrite the affected slices
   in this file before starting them.

**Phase 1 — only after a PASS / PASS-WITH-CHANGES / REVISE verdict, and only the surviving slices.**

6. **`d04` and `d11`** — may run in parallel (`--jobs 2`) if and only if the agent keeps `App.tsx`
   edits line-disjoint. Otherwise serial. If the gate recommended boundary changes (M12), `d11`'s
   contract is amended first.
7. **`d05`** then **`d10`** — transitions/alerts, then measure and pin the budget. Do not let `d05`
   ship without `d10` following: animated beacons are exactly how frame budgets die.
8. **`d06`** then **`d08`** — inspection, then control. Control last among the two: it is the only
   slice that can affect a real run.
9. **`d07` and `d09`** — history/temporal and fallback/a11y, in either order.
10. **`d12`** — the desktop shell, only if CP-5's reconsider trigger was not met.
11. **`d13`** — expression pass. This is the only slice permitted to add ambient/material/
    choreography work, and every effect it adds must have a tier or a motion switch. The gate's
    disposition table may have dropped this slice entirely.
12. **`d14`** — operability, docs, evidence, release. Include the honest "is the deck better than
    the dashboard for X?" section, the "when is the dashboard the better tool" guidance, and the
    usage-based revisit trigger from red-team #16.

**Do not reorder `d00`/`d01`/`d02`/`d03`/`d03v`.** They are the spine: budget, boundary, pure model,
focus rule, and the measured verdict on whether any of it was worth building.

## [d00] Deck rendering probe and performance budget

### Objective

Pin the rendering budget for a 3D surface to measurements taken on the machine that will
actually run it, and ship the pure tier classifier every later slice depends on.

### Why this slice exists

This repository's own development machine has **no hardware GL**: measured WebGL renderer is
`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` in headless
*and* headed Chromium, and a single full-viewport trivial-shader layer costs ~41 ms/frame at
1280×720. A 3D roadmap that starts with shaders and discovers this at slice 8 is a failed
project. Measuring first turns "make it fast" into a threshold every later slice can be
tested against.

### Prerequisites

None. This is the first slice.

### Scope

- ✚ `scripts/deck-probe.ts` — a Playwright-driven probe that reports, as JSON on stdout:
  `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL`, `MAX_TEXTURE_SIZE`, `MAX_SAMPLES`,
  `devicePixelRatio`, and fill benchmarks (trivial fragment shader, full-screen quad) at
  `640×360`, `1280×720`, `1920×1080`, `2560×1440`, each at 1× / 2× / 4× / 8× overdraw, plus a
  20k-instance instanced-draw timing. `--headless` (default) and `--headed` modes; `--json`
  machine output; a human table otherwise; `--repeat N` (default 3) reporting **min/median/max
  per configuration** — single samples are meaningless here (A.6: ~40 % spread between runs).
  **Every timing must force completion with `gl.finish()` *followed by* a 1-pixel `readPixels`**
  — a bare `gl.finish()` returns meaningless sub-millisecond numbers in this Chromium build.
- ✚ `docs/deck-performance-budget.md` — the measurement method, the machine's numbers, the
  tier table, and the decision rules (see below). Re-measurement instructions must be
  copy-pasteable.
- ✚ `web/src/scene/tier.ts` — pure, no `three`, no DOM:
  `classifyRenderer(renderer: string | null): QualityTier`,
  `TIER_BUDGETS: Record<QualityTier, TierBudget>`, `SOFTWARE_RENDERER_RE`.
- ✚ `tests/deck-perf.test.ts` — unit tests for the classifier and the budget table.

Tier table to pin (adjust from measurement, then freeze):

```
minimal : resolutionScale 0.50 · maxFps 30 · antialias false · maxDrawCalls 24 · maxStations  8 · maxBeacons  32 · ambient false
standard: resolutionScale 1.00 · maxFps 60 · antialias false · maxDrawCalls 48 · maxStations 16 · maxBeacons  64 · ambient false
high    : resolutionScale 1.00 · maxFps 60 · antialias true  · maxDrawCalls 96 · maxStations 32 · maxBeacons 128 · ambient true
```

`classifyRenderer` rules: `null`/empty → `standard`; matches
`/swiftshader|llvmpipe|software|basic render|mesa offscreen/i` → `minimal`; otherwise
`standard` initially, with `high` only ever selected by an explicit operator choice (`T` in
`d01`, persisted) — never guessed from a vendor string alone.

### Explicit non-scope

No scene, no canvas in the app, no dependency added, no Tauri, no changes to `src/**`. The probe
is a **dev/evidence tool**, in the same class as `scripts/web-captures.ts` — it is not part of
the shipped dashboard.

### User-visible result

`bun scripts/deck-probe.ts` prints a measured table for this machine and the tier it implies;
`docs/deck-performance-budget.md` states what the deck may spend, with the numbers and the
method in it.

### Architecture changes

- New pure module `scene/tier.ts` — the single source of tier thresholds for every later slice
  (`d01` loop, `d10` harness, `d09` fallback).
- `scripts/deck-probe.ts` depends on the repo's existing `@playwright/test` devDependency
  (Playwright 1.62, chromium revision 1234 installed at `~/.cache/ms-playwright`); it must
  resolve the browser via `chromium.executablePath()` and fail with an actionable message when
  no browser is installed.

### Data flow

```
bun scripts/deck-probe.ts --json
  → Playwright chromium (headless | headed)
  → WebGL2 probe page (no app code; a self-contained HTML string)
  → { renderer, limits, fills: [{res, overdraw, ms}], instanced20k: {ms} }
  → classifyRenderer(renderer) → tier            ← the same function the app will call
  → stdout JSON  +  numbers copied into docs/deck-performance-budget.md
```

### UI/UX behaviour

None in-product. The report is the interface.

### 3D behaviour

None (the probe page is throwaway HTML). This slice exists so the 3D behaviour of every later
slice has a budget.

### Error behaviour

- No browser installed → exit 1, message names `bunx playwright install chromium`.
- Context creation failure (no WebGL2 at all) → JSON `{ "webgl2": false }`, exit 0 — that is a
  legitimate measurement, and it is the signal the `d09` fallback path covers.
- Headed mode without a display: fall back to headless and say so in the JSON
  (`"headed": "unavailable"`), exit 0.

### Performance considerations

This slice *is* the performance work. Keep the probe under ~60 s wall clock: warm up 5 frames,
then average 20; skip combinations that would take minutes on a software rasterizer
(2560×1440 is measured at 1× and 4× only).

### Testing

- `tests/deck-perf.test.ts` (unit): `classifyRenderer("SwiftShader…") === "minimal"`;
  `classifyRenderer("ANGLE (NVIDIA …)") === "standard"`; `classifyRenderer(null) === "standard"`;
  budget monotonicity (`minimal.resolutionScale ≤ standard ≤ high`, `minimal.maxFps ≤ …`,
  `minimal.maxDrawCalls ≤ …`); every tier defines every field; `SOFTWARE_RENDERER_RE` matches
  each of the four software strings.
- Manual/CI-gated evidence: `bun scripts/deck-probe.ts --json` must exit 0 on a machine with
  chromium; the reviewer re-runs it and compares with the doc.

### Acceptance criteria

1. `bun scripts/deck-probe.ts --json` exits 0 and prints valid JSON containing a renderer
   string and a `fills[]` array with at least 12 entries on this machine, each carrying
   `min`/`median`/`max` from ≥ 3 repeats.
2. `docs/deck-performance-budget.md` contains: the machine description, the method (including
   the `readPixels` synchronization requirement and the repeat/min-median-max rule), the measured
   range table, the tier table above, the ≥ 1.5× headroom rule, and a "re-measure" command.
3. The tier table appears **identically** in the doc and in `TIER_BUDGETS`
   (a test asserts the doc contains each numeric value from the table).
4. `bunx tsc --noEmit`, `bun test`, `git diff --check` clean.

### Definition of done

- [ ] probe script committed, JSON-only output under `--json`, human table otherwise
- [ ] budget doc committed with measured numbers + method + re-measure command
- [ ] `scene/tier.ts` pure, tested, no `three`/DOM import
- [ ] doc/code tier tables agree (tested)
- [ ] gates green

Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun scripts/deck-probe.ts --json
Verify: test -f docs/deck-performance-budget.md
Files: scripts/deck-probe.ts docs/deck-performance-budget.md web/src/scene/tier.ts tests/deck-perf.test.ts

## [d01] Deck surface, guarded render loop, and HUD

### Objective

Make `?surface=deck` a real WebGL2 surface in the existing app, with a render loop that obeys
the `d00` budget, a tier probe at runtime, and a HUD that reports the numbers — and lock the
new module's architecture with tests before any scene code lands.

### Why this slice exists

Two things must be true before a single pad is drawn: (1) the boundary is enforced by tests,
not by discipline — `scene/**` is API-free and `three` is confined to the renderer; (2) the
frame loop cannot be written later as an afterthought, because on this machine an
unguarded 60 fps loop is the difference between a usable surface and a slideshow. This slice
establishes both plus the surface selector that the desktop shell will use as its URL.

### Prerequisites

`d00` — tiers and budgets exist.

### Scope

- Add dependencies: `three@0.186.0` (dependencies) and `@types/three@0.186.0` (devDependencies),
  pinned exactly like the repo's other pins.
- ✚ `web/src/scene/types.ts` — `DeckProps`, `DeckPrefs`, `QualityTier` re-export, `DECK_KEYS`
  (the §D.5 keymap as data), `DECK_PREFS_KEY = "ompo.deck.prefs"`.
- ✚ `web/src/scene/loop.ts` — dependency-injected frame scheduler:
  `createFrameLoop({ onFrame, maxFps, isDirty, raf?, cancelRaf?, isHidden? })` returning
  `{ request(), setMaxFps(n), stop(), stats() }`. Idle (`!isDirty()`) stops scheduling;
  hidden (`isHidden()`) stops scheduling and resumes on visibility; `maxFps` is enforced by a
  timestamp gate, not by skipping work mid-frame.
- ✚ `web/src/scene/renderer.ts` — the **only** module importing `three`:
  `createDeckRenderer(canvas, tier): DeckRenderer` with
  `{ applyModel(model), setCamera(state), setSize(cssW, cssH), render(): RenderStats, info(): RenderStats, dispose() }`.
  `RenderStats = { drawCalls, triangles, objects, programs, textures, geometries, fps }`.
  In this slice it renders an empty world: a fade-only grid on the floor plane (no full-screen
  fill) and nothing else. `dispose()` releases geometries/materials/programs and is idempotent.
- ✚ `web/src/scene/Deck.tsx` — the React boundary: reads prefs, probes the tier, owns the
  renderer + loop lifecycle, renders `<canvas>` + `<DeckOverlay>`; it performs **no fetching**
  and imports no store/control module.
- ✚ `web/src/scene/instrument.ts` — **the gate's instruments, built with the thing they measure**
  (retrofitting them at the gate would measure a different program):
  - `createInstrumentation(): Instrumentation` — samples: frames rendered, frame-time histogram
    (ring buffer of the last 3 000), React commit count/s (via a `useSyncExternalStore`-free
    counter incremented in a `useEffect` on the deck subtree), `MutationObserver` mutation rate
    for the deck subtree, `PerformanceObserver("longtask")` count and worst duration,
    `performance.memory` heap samples (`usedJSHeapSize`, when available), and
    `renderer.info` counters;
  - `markEventRendered(seq)` / `eventLatency()` — event-to-screen latency: `App` records the
    `at` timestamp per applied `seq`; the DOM layer calls `markEventRendered(seq)` from a
    `ref` callback once the derived text is in the document, giving M4 without touching React
    render bodies;
  - `snapshot(): ValidationSample` — one JSON-serialisable sample;
  - `window.__ompoDeck = { …, instrument }` — the same hook the e2e suite and `scripts/deck-validate.ts`
    (slice `d03v`) consume. Cheap by construction (no allocation per frame beyond a ring-buffer
    write, no timers beyond one 1 s sampler).
  Instrumentation is **always on** in this roadmap: it is ~0.1 ms/s and the gate needs it on the
  same build the operator uses. It is not a dev-only build flag.
- `web/src/App.tsx` — surface selection: `?surface=deck` (initial) + a `surface` state toggle;
  `React.lazy(() => import("./scene/Deck.tsx"))` inside a `<Suspense>` with a skeleton; pass
  existing state as props. The dashboard path is unchanged when `surface !== "deck"`.
- `web/src/components/Header.tsx` — a "Deck"/"Dashboard" toggle next to the existing
  inspector toggle; toggling updates the URL with `history.replaceState` (no reload).
- ✚ **M1 duplication scan** (added to `tests/release-gate.test.ts`, in the house scanning style):
  assert that no file outside `web/src/lib/**` and `web/src/scene/{model,rail,focus,lanes,alerts,deltas,history,fallback,palette,ambient}.ts`
  derives slice status, agent state, pipeline stage, "needs eyes" ranking, or live-window contents —
  i.e. the deck projects, it does not re-derive. The scan looks for the specific derivation
  primitives (`preferredSliceId`-equivalents, status→rank switches, stage→index computation) rather
  than for import names, so a copy-paste is caught as well as a re-export.
- `tests/release-gate.test.ts` — extend the architecture lock with two assertions:
  (a) every file under `web/src/scene/**` except `renderer.ts` and `Deck*.tsx` must not import
  `three`; (b) no file under `web/src/scene/**` may contain `fetch(`, `new EventSource`, or
  `new WebSocket` (the shell fetches; the deck renders).
- ✚ `tests/e2e/deck.e2e.ts` — Playwright: surface switch, HUD presence, tier cycling, idle
  behaviour, and a surface-switch loop that asserts no leakage.
- `web/src/scene/Deck.tsx` exposes a debug hook `window.__ompoDeck`
  `{ tier, frames, drawCalls, objects, disposed }` (updated per frame from `renderer.info()`),
  which the e2e suite and `d10` assert against. It must be cheap (a plain object write) and must
  not be a public API.

### Explicit non-scope

No data rendering (no pads, no stations, no live output), no interaction beyond tier cycling and
the surface toggle, no keys beyond `T`/`D`/`H`, no Tauri, no changes to `src/**`, no visual
design work beyond the HUD's legibility.

### User-visible result

Appending `?surface=deck` (or clicking "Deck" in the header) shows a working 3D viewport with a
HUD reading `tier · fps · draw calls · objects · resolution`, and the dashboard still works
exactly as before, including when the deck chunk fails to load.

### Architecture changes

- **New subsystem boundary** `web/src/scene/`, enforced by `tests/release-gate.test.ts`.
- **New dependency**: `three` (see CP-2). Bundle effect must be reported: the deck chunk must be
  a separate file under `web/dist/assets/` (the lazy import guarantees it) and its size recorded
  in the slice report.
- **Surface selector** `?surface=dashboard|deck` — the address the desktop shell will load (`d11`).
- **Client preferences** `localStorage["ompo.deck.prefs"]` = `{ tier: "auto"|tier, reducedMotion: boolean }`.
  This is the first client-side persistence in `web/src`; it must contain view preferences only,
  never domain state, and must degrade silently when storage is unavailable (private mode).

### Data flow

```
location.search → surface ("deck" | "dashboard")
Deck -> detectTier(probe GL renderer string) -> QualityTier      (auto) or prefs.tier (explicit)
Deck -> createDeckRenderer(canvas, tier) -> loop.request() on resize/visibility/state/prefs change
loop -> onFrame -> renderer.render() -> RenderStats -> HUD (React state at HUD cadence, not per frame)
```

### UI/UX behaviour

- The HUD is a small, always-visible DOM panel: `tier · fps · draw calls · objects · resolution
  scale`, plus a warning chip when the tier is `minimal` ("software renderer detected").
- `T` cycles `auto → minimal → standard → high` and persists; the HUD shows whether the value is
  auto-selected or pinned.
- `D` returns to the dashboard; the header toggle does the same.
- Window resize debounces (150 ms) into `renderer.setSize` + one frame.
- No layout shift: the deck fills the same content area the dashboard uses; the existing sidebar
  and header stay mounted so switching is instant.

### 3D behaviour

- Camera: a fixed default (`rail` framing of an empty floor grid), orbit disabled in this slice.
- One grid helper-like floor drawn as a **finitely sized** quad or lines (never a viewport-filling
  translucent plane — see the overdraw budget).
- No animation beyond a single opacity fade-in on first frame (≤ 200 ms, skipped under reduced
  motion).

### Error behaviour

- `three` chunk load failure → the `Suspense` boundary renders an inline error card with a
  "Back to dashboard" button; the console gets one error, no white screen.
- WebGL2 context unavailable → render the `d01` inline notice ("3D unavailable on this device —
  the dashboard has everything"), and the full flat-deck fallback arrives in `d09`.
- Zero-size container → do not create a renderer; wait for a non-zero size (avoids a
  divide-by-zero projection matrix).
- `dispose()` must be called on unmount; a second `Deck` mount must not leak the first
  renderer (asserted by the e2e switch-loop test via `window.__ompoDeck.disposed`).

### Performance considerations

- `renderer.setPixelRatio(1)` and a backing store of `cssSize × tier.resolutionScale` — the
  measured ~44 ns/pixel makes pixel count the primary lever.
- `loop` renders **only** when dirty (state change, resize, camera change, prefs change) and
  when the document is visible; an idle deck must report 0 frames over a 2 s window.
- The HUD updates via React at most 4×/s (its own interval), never per frame.
- `powerPreference: "low-power"`, `antialias: tier.antialias`, `preserveDrawingBuffer: false`,
  `stencil: false`, `depth: true`, `alpha: false`.

### Testing

- `tests/deck-loop.test.ts` (unit, injected fakes): idle stops scheduling; `maxFps` gates frames
  (30 fps ⇒ ≤ 31 frames in 1000 ms of fake time); visibility resumes; `stop()` cancels; a
  dirty-flag set after a frame schedules exactly one more frame.
- `tests/release-gate.test.ts` (extended): the two new boundary assertions above, walking the
  real tree (the existing test's walker is reused).
- `tests/e2e/deck.e2e.ts` (Playwright, against `tests/e2e/serve.ts`): `?surface=deck` shows a
  canvas and a HUD with a tier; `T` changes the tier text; the deck renders 0 frames while idle
  (HUD `frames` stable over 2 s); switching surfaces 10× leaves exactly one canvas and reports
  `disposed ≥ 9`; the dashboard's existing e2e suite still passes.
- Manual: `bun run web:build` then check the compiled `./ompo` serves the deck from the embedded
  bundle (asset mode `embedded`), proving the extra chunk embeds.

### Acceptance criteria

1. With `?surface=deck`, a WebGL2 canvas exists, the HUD reports a tier, and
   `window.__ompoDeck.tier` matches the renderer classification from `d00` on this machine
   (`minimal`).
2. Idle for 2 s → `window.__ompoDeck.frames` grows by 0.
3. Ten surface switches → exactly one `<canvas>` in the DOM and `disposed >= 9`.
4. `bun run web:build` emits the deck as a separate chunk; its file name and size are reported
   in the slice's report; `./ompo` (compiled) serves the deck.
5. `bun test` still passes, including the extended release-gate assertions, and `bun run test:e2e`
   passes with the new spec included.
6. `window.__ompoDeck.instrument.snapshot()` returns a sample containing: frames, frame-time
   p50/p95, commits/s, mutations/s, long tasks, heap (or `null` with a reason), and
   `renderer.info` counters; idle sampling for 60 s adds ≤ 5 frames and no measurable CPU (the
   sampler costs < 0.2 ms/s, asserted by a unit test on the pure sampler).
6. No `fetch`, `EventSource`, `WebSocket`, `node:*`, or `../src/` import anywhere under
   `web/src/scene/**` (asserted, not asserted-by-eyeball).

### Definition of done

- [ ] `three` + `@types/three` pinned; `bunx tsc --noEmit` clean with `three` types resolved
- [ ] `scene/{types,loop,renderer,Deck}.tsx` committed; `three` confined to `renderer.ts`
- [ ] `App.tsx` surface switch + `Header.tsx` toggle; dashboard byte-for-byte unchanged in behaviour
- [ ] release-gate assertions extended and passing
- [ ] unit + e2e tests as specified
- [ ] bundle size + chunk name reported
- [ ] gates green

Depends: d00
Effort: hi
Timeout: 60m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Verify: bun run web:build
Files: web/src/scene/types.ts web/src/scene/loop.ts web/src/scene/renderer.ts web/src/scene/instrument.ts web/src/scene/Deck.tsx web/src/App.tsx web/src/components/Header.tsx package.json tests/release-gate.test.ts tests/deck-loop.test.ts tests/deck-instrument.test.ts tests/e2e/deck.e2e.ts

## [d02] Scene model and the roadmap rail

### Objective

Turn the run's roadmap into a stable, interactive spatial object: one pad per slice positioned
by dependency depth, dependency edges between them, state legible per pad — all produced by a
pure `buildDeckModel` that is tested without a browser.

### Why this slice exists

This is where "3D dashboard" becomes "spatial model of a real run", and where the two hardest
architectural rules get proven in code: the scene is a **pure projection of DTOs** (CP-7) and
the world does **not reflow when statuses change** (so the operator's spatial memory survives a
run). Everything after this slice — focus, alerts, history — attaches to this model.

### Prerequisites

`d01` — surface, loop, renderer, boundary tests.

### Scope

- ✚ `web/src/scene/model.ts` — pure, no `three`, no DOM:
  ```
  buildDeckModel(input: DeckInput): DeckModel
  DeckInput  = { runId, detail: RunDetail | null, events: RunEvent[], agents: AgentRow[],
                 selected: string | null, prefs: DeckPrefs, live: boolean }
  DeckModel  = { runId, nodes: RailNode[], edges: RailEdge[], counts: Counts,
                 primaryId: string | null, hud: { runId, live, counts } }
  RailNode   = { id, title, status, attempt, generation, effort?, depth, x, z, deps,
                 selected, ready, blocked, alert: AlertKind | null }
  RailEdge   = { key, from, to, satisfied, unknown, inCycle }
  ```
- ✚ `web/src/scene/rail.ts` — pure geometry: `railPositions(layout: DagLayout): Map<id, {x,z,y}>`
  mapping the existing `layoutDag` x/y into world space with fixed spacing; **must depend on
  roadmap structure only** (ids, deps, depths) and on nothing else.
- `web/src/scene/renderer.ts` — real content: pads as a single `InstancedMesh`
  (one draw call; per-instance colour by status, height by `attempts`/`generation`), edges as a
  single `LineSegments` (one draw call; colour by `satisfied`), plus a selection ring on the
  selected pad (one small mesh). `applyModel` performs a **diff**: it rebuilds nothing unless the
  node/edge id sets change.
- `web/src/scene/Deck.tsx` — pass the real `DeckInput` from props; wire `onSelect` to the app's
  existing selection handler; expose node/edge counts in `window.__ompoDeck`.
- `web/src/scene/DeckOverlay.tsx` — the DOM skeleton: a "selected slice" line (id, title,
  `StatusBadge`, attempt/generation, `heroAction(...)`) mirroring §D.2 level 3.
- Raycast picking: pointer → pad id (`InstancedMesh` instanceId), `Enter` activates the focused
  pad; the DOM mirror of the pads (a visually hidden list, used fully by `d09`) is present from
  this slice so keyboard/AT access exists from the start rather than as a retrofit.
- ✚ `tests/deck-model.test.ts` — the pure tests below.

### Explicit non-scope

No live workers/stations, no live output, no camera presets beyond a static framing, no alerts
rendering (the field exists but only `failed`/`blocked-env` set it), no history, no control, no
animation beyond selection change.

### User-visible result

Opening the deck on a real run shows the whole roadmap laid out spatially: pads at dependency
positions, edges between them, statuses readable on the pad and in the overlay line, and
clicking a pad selects it — the same selection the dashboard's board and the inspector already
share.

### Architecture changes

- `DeckModel` becomes the contract between the pure layer and the renderer; every later slice
  extends it rather than adding a parallel path.
- `rail.ts` is the only place that decides world coordinates; the renderer never computes layout.
- The DOM mirror list is the accessibility backbone introduced with the scene (not later).

### Data flow

```
RunDetail.slices ─► layoutDag(...) ─► DagLayout{nodes[x,y,depth], edges[]}
RunEvent[] ─────────────────────────► (latest per slice: reason/alert source)
AgentRow[] ─────────────────────────► (unused in this slice; focus arrives in d03)
        └──────────────► buildDeckModel(DeckInput) ─► DeckModel
                                                        ├─ railPositions(DagLayout) → {x,z,y}
                                                        └─ applyModel(renderer, DeckModel) → InstancedMesh + LineSegments
click(pad instanceId) → onSelect(sliceId) → App selection state → DeckModel.nodes[].selected
```

### UI/UX behaviour

- Hover: pad highlight + the overlay line shows that slice's id/title/status without changing
  selection.
- Click / `Enter`: select (opens nothing in this slice; `d06` wires the dock).
- Selection is the app's single selection system — clicking a pad must move the dashboard's
  board/graph selection too, and vice versa.
- The overlay line never covers the HUD; both are corner-anchored DOM.

### 3D behaviour

- Pads are flat boxes (cheap, no bevels), instanced, coloured by status using the existing
  `--success`/`--warning`/`--destructive`/`--muted` token values converted once to floats.
- Non-colour encoding is mandatory: pending = low flat pad, active = taller pad, done = capped
  pad with a flat top, failed = pad with a vertical marker, blocked-env = pad with a second
  marker. Shape/height differences must be visible with colour ignored.
- Edges are straight segments at floor level + a small arc offset per edge so crossing edges
  remain distinguishable; satisfied vs pending distinguished by brightness **and** dash pattern.
- Layout stability: the same roadmap yields byte-identical positions across status permutations
  (tested); only materials/heights change.
- Camera: default `rail` framing computed to fit the layout bounds once (no per-frame fitting).

### Error behaviour

- Layout with unknown deps or cycles: `layoutDag` already returns ghosts and cycle ids — render
  them as ghost pads (outline only) rather than dropping them; a roadmap with 0 slices renders
  an empty floor + a centred "no slices in this run" DOM line.
- `detail === null` (run switched while loading): keep the previous model, do not flash an empty
  world; the HUD shows "loading run …".
- > 200 slices: pads remain instanced (fine), but the DOM mirror list must stay virtualised-free
  by rendering only the first 200 with an explicit "N more" row (no silent truncation).

### Performance considerations

- Exactly 3 draw calls for the whole rail (pads, edges, selection ring) regardless of slice
  count; assert `window.__ompoDeck.drawCalls <= 8` on the e2e fixture.
- `applyModel` must not reallocate buffers when only statuses changed (diff by id sets); the e2e
  test asserts a stable `geometries` count across a selection change.
- Colour updates write into the instance colour buffer (`needsUpdate`), never rebuild the mesh.

### Testing

- `tests/deck-model.test.ts` (pure): node count equals `detail.slices.length`; edge count equals
  the union of deps; ghost/cycle survival; `primaryId` uses `preferredSliceId` (same result as
  the helper, not a re-implementation); **position stability** across five status permutations;
  `selected` flag follows input; blocked/ready flags match `dag.ts`'s `readyDagIds`; model is
  `JSON.stringify`-stable for identical inputs (no hidden state).
- `tests/e2e/deck.e2e.ts` (extend): pad count matches the fixture's slice count via
  `window.__ompoDeck.objects`; clicking a pad selects the slice (assert the dashboard's board
  row also becomes selected after switching back); draw calls within budget.
- Manual: load the deck against the real `.omp/roadmap/runs/20260909-kph0as` run (24 slices) and
  eyeball that the dependency structure is recognisable versus the dashboard's DAG view.

### Acceptance criteria

1. On the fixture run, `window.__ompoDeck.objects` reports exactly `slices.length` pads and the
   edge count equals the number of deps; both match `layoutDag`'s output.
2. Changing a slice's status (fixture mutation) leaves every pad's position unchanged
   (asserted by comparing `railPositions` output before/after in a unit test).
3. Clicking pad `X` selects `X`: the deck overlay line and the dashboard's board both show `X`
   after switching surfaces.
4. Draw calls stay ≤ 8 with 24 slices; no buffer rebuild on selection change.
5. `bun test`, `bunx tsc --noEmit`, `git diff --check`, `bun run test:e2e` all clean.
6. The M1 duplication scan passes (no second derivation exists), and its failure message names the
   offending file and the primitive it duplicated.

### Definition of done

- [ ] `model.ts` pure (no `three`, no DOM, no fetch) and fully unit-tested
- [ ] `rail.ts` positions from `layoutDag` only; stability test green
- [ ] instanced pads + single-line edge draw + selection ring in `renderer.ts`
- [ ] selection wired to the app's single selection system (both directions)
- [ ] DOM mirror list present and populated
- [ ] e2e assertions on counts/draw calls
- [ ] gates green

Depends: d01
Effort: hi
Timeout: 60m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Files: web/src/scene/model.ts web/src/scene/rail.ts web/src/scene/renderer.ts web/src/scene/Deck.tsx web/src/scene/DeckOverlay.tsx tests/deck-model.test.ts tests/e2e/deck.e2e.ts

## [d03] Active-worker focus and the bounded live window

### Objective

Make the running worker the protagonist: auto-framed by the existing "which slice needs eyes"
rule, with its real live output in a bounded DOM window that the operator can freeze, expand
and trust — and prove that streaming text costs the 3D scene nothing.

### Why this slice exists

This is the first slice where the deck does something the dashboard cannot: a spatial focus that
follows the work while the operator looks elsewhere. It is also where the brief's hard
requirement ("the active worker and its live output remain the primary focus") becomes a tested
property rather than a layout intention. And it is the slice that proves the cheapest, most
important performance claim in the whole roadmap — **log text never drives the render loop**.

### Prerequisites

`d02` — model, rail, selection.

### Scope

- ✚ `web/src/scene/focus.ts` — pure:
  `liveSliceIds(slices): string[]` (`running`|`verifying`, board order);
  `focusTarget(slices, agents, pinnedId): string | null` (pinned wins; otherwise
  `preferredSliceId` limited to live slices; otherwise `preferredSliceId` overall);
  `frameForNode(node, layoutBounds): CameraState` (the `command` framing).
- `web/src/scene/camera.ts` — pure math: `CameraState`, `applyCameraIntent(state, intent)`,
  `lerpCamera(a, b, t)`, `visibleSliceIds(camera, nodes, aspect)` (used again by `d04`).
- `web/src/scene/Deck.tsx` — focus lifecycle: `pinnedId` (view state, not persisted),
  camera intent dispatch, and the auto-framing effect (only when the focus target changes and
  the operator has not pinned).
- `web/src/scene/DeckOverlay.tsx` — the live window: reuse `useLiveStream(runId, slice, events)`
  (`web/src/lib/useLiveStream.ts`) and the existing `LiveFeed` component
  (`web/src/components/LiveFeed.tsx`) verbatim; add the freeze control and the lane strip.
- `web/src/scene/renderer.ts` — the station mesh for the focused slice: a taller pad variant whose
  height encodes the stage index from `buildPipelineStages`/`currentStageIndex`
  (`web/src/lib/pipeline.ts`) and whose material encodes `running` vs `verifying`.
- Keys wired in this slice: `F` (frame), `Esc` (unpin → re-follow primary), `Space` (freeze),
  `E` (expand raw), `[`/`]` (previous/next live worker), arrow keys / wheel (pan/zoom).
- `web/src/scene/DeckOverlay.tsx` — the freeze indicator: `frozen — N new rows` (N counted from
  the stream since the freeze), and a "resume" affordance.

### Explicit non-scope

No alerts, no multi-worker positioning beyond the focused station, no dock/inspector, no history,
no camera presets beyond `command`/`rail`, no animation beyond the ≤ 150 ms row enter/leave that
`LiveFeed` already provides.

### User-visible result

With a run in progress, the deck frames the slice that is actually running, shows its last five
meaningful worker rows updating live, and lets the operator freeze the window to read, expand it
to the raw transcript, and step between live workers with `[`/`]` — all without touching the
dashboard.

### Architecture changes

- `focus.ts` + `camera.ts` become the deck's only decision points about "what is in front of me";
  the renderer merely applies `CameraState`.
- The live window is **not re-implemented**: `useLiveStream` + `LiveFeed` are imported from the
  existing dashboard code, which is what keeps the two surfaces from drifting.
- Pinning is introduced as explicit view state (not persisted) with a single rule: a pin
  suppresses auto-framing until `Esc`.

### Data flow

```
AgentRow[] + SliceSummary[] ─► focusTarget(...) ─► focusId
                                                  ├─► camera intent { kind: "focus", sliceId } (only if !pinned)
                                                  └─► useLiveStream(runId, slice, events)   (2 s tail poll)
                                                          └─► LiveFeed (compact 5 rows | expanded 400)
status change of the focused slice ─► model change ─► station height/material update (no camera move unless it became the target)
```

### UI/UX behaviour

- Auto-focus changes are **animated once** (≤ 450 ms camera lerp) and are suppressed under reduced
  motion (instant).
- `Esc` while pinned unpins and re-frames the primary; `Esc` while unpinned does nothing in this
  slice (the dock's close arrives in `d06`).
- Freezing does not stop the underlying polling; it stops the window from accepting new entries
  and shows the count of what was skipped, so nothing is silently lost.
- The expanded state is the raw transcript with live-follow and `Jump to live` — the same
  affordances the dashboard already provides.
- The lane strip lists every live worker (id, status, stage) with the focused one highlighted;
  clicking a lane focuses that worker.

### 3D behaviour

- Focused station: taller pad + subtle vertical shaft of ≤ 4 segments (one mesh, no textures) whose
  filled count = stage index (Claim 0 → Done 6).
- Non-focused live slices are rendered but visually recede (lower, dimmer) — they remain present,
  because "never make the user hunt for a running worker" also means never hiding one.
- The camera frames the station plus an 8-unit margin; the framing function is pure and unit-tested
  against a fixed bounds fixture.
- No per-frame camera work when nothing changes (the lerp completes and the loop goes idle).

### Error behaviour

- No live slices: focus falls back to `preferredSliceId` over all slices; the live window shows
  the last terminal slice's transcript tail with a "quiescent run" label; the HUD says
  `live: 0 · showing <slice>`.
- The focused slice's log endpoint 404s (artifact not written yet): the window shows
  "no transcript yet" and keeps polling; it must not throw or clear the deck.
- Freezing while the slice changes: the freeze is keyed to a slice id; switching slices clears it
  (no cross-slice frozen confusion).

### Performance considerations

- **The live window must not touch the render loop.** A log-text update changes React state at the
  poll cadence (2 s (`useSliceLog`) or SSE 900 ms); `DeckModel` is unchanged, so `loop` stays
  idle. The e2e test asserts `window.__ompoDeck.frames` does not grow while the transcript grows.
- Camera lerps are capped at 450 ms and drive the loop only while in flight.
- Station geometry is pooled: ≤ `tier.maxStations` meshes exist from the first frame; focus changes
  mutate them rather than adding/removing meshes (assert `geometries` count stability).

### Testing

- `tests/deck-focus.test.ts` (pure): `liveSliceIds` ordering; `focusTarget` prefers a pin, then
  the live primary, then any slice; `frameForNode` produces a camera whose `visibleSliceIds`
  contains the target and whose distance is within `[minDistance, maxDistance]`;
  `applyCameraIntent` clamps zoom/pan; `lerpCamera(0) === a`, `lerpCamera(1) === b`.
- `tests/e2e/deck.e2e.ts` (extend): with the fixture's live slice, the deck's focused id equals
  the dashboard's `preferredSliceId` result; the live window shows ≤ 5 rows; `Space` freezes and
  the counter appears; `E` expands and the row count grows to the transcript tail; `[`/`]`
  switches workers and the window's source label changes; frames do not advance while only text
  updates.
- Manual: run `ompo run --jobs 1` in a pilot project, open the deck, confirm the camera follows
  the running slice and the window matches `ompo logs <slice> --tail 20`.

### Acceptance criteria

1. With exactly one live slice, `window.__ompoDeck.focused` equals `preferredSliceId(slices)`.
2. The compact live window renders ≤ 5 meaningful rows and the expanded view renders the raw
   transcript (server tail ≤ 500); no row is ever rendered half-animated (text present in the DOM
   on first paint of the row).
3. Freezing shows the skipped-row count; resuming shows the newest window with no queued
   animation (assert the DOM settles within one animation frame).
4. `Esc` after `F` restores follow-the-primary framing (assert camera target id returns to the
   primary's id, not merely a similar position).
5. Render loop: `window.__ompoDeck.frames` unchanged across 3 s of transcript growth; `objects` and
   `geometries` unchanged across focus switches.
6. The gate's instruments produce usable distributions on a real run (this slice is where M4/M6 are
   first exercised): `instrument.eventLatency()` reports ≥ 50 samples with p50/p95 for a slice that
   emitted ≥ 50 events, and the log-volume isolation counter attributes 0 frames to text growth over
   a 60 s window. Failing this is a `d03` failure, not a gate surprise.
6. Gates clean.

### Definition of done

- [ ] `focus.ts`, `camera.ts` pure + tested
- [ ] `LiveFeed` + `useLiveStream` reused, not forked (no new live-window component)
- [ ] focus/pin/freeze/expand/switch keys wired and documented in `DECK_KEYS`
- [ ] station geometry pooled; geometry count stable across focus switches
- [ ] e2e coverage for every acceptance criterion
- [ ] gates green

Depends: d02
Effort: hi
Timeout: 60m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Files: web/src/scene/focus.ts web/src/scene/camera.ts web/src/scene/Deck.tsx web/src/scene/DeckOverlay.tsx web/src/scene/renderer.ts tests/deck-focus.test.ts tests/e2e/deck.e2e.ts

## [d03v] Gate G1 — validation run and evidence report

### Objective

Run the §0 measurement protocol against a real `omp -p` worker on this machine through the real
deck architecture, write `docs/deck-validation-report.md` with the numbers and the raw artifacts,
and recommend a verdict (`PASS` / `PASS WITH CHANGES` / `REVISE` / `STOP`) with a per-slice
disposition table covering `d04`–`d14`. This slice exists to **falsify the roadmap**, not to
justify it.

### Why this slice exists

`d00`–`d03` can all pass their own tests while the premise is still wrong: a deck that renders
correctly, holds its budget on one worker, and is nonetheless slower to answer "is this worker
stuck?" than the dashboard is a failed product that every green test happily ignores. The gate
turns "we think this is better" into a number, and put the number — plus the option to stop — in
front of the operator before another line of scene code is written.

### Prerequisites

`d03` complete: the deck renders a real run's active worker with its real live output, and
`scene/instrument.ts` exposes frames, frame times, commits, mutations, long tasks, heap,
`renderer.info` counters and event-to-screen latency.

### Scope

- ✚ `scripts/deck-validate.ts` — the protocol runner. Two modes:
  - `--fixture` (deterministic, gate-able, no model spend): serves the **built** bundle
    (`bun run web:build` output) against a synthetic fixture project built with the existing
    `parseRoadmap`/`createRun`/`storeApi` helpers (the `tests/e2e/serve.ts` pattern), then drives
    two scenes: **×1** (the live set as configured) and **×4** (≥ 100 slices, 4 simulated live
    slices with synthetic transcript growth of ≥ 2 000 lines in 60 s). Emits one JSON per scene.
  - `--live` (mandatory for the verdict): attaches to a **real run** (`--project DIR --run RUNID`,
    or starts nothing itself — the operator or the harness launches `ompo run` separately), samples
    for ≥ 10 minutes with the real worker(s) running, and emits the same JSON shape plus the run id
    and the observed worker generations.
  - Both modes emit to `captures/deck-validation/<mode>-<timestamp>.json` and print a compact table.
    Percentiles are computed from raw samples (no reservoir sampling without recording it).
- ✚ `docs/deck-validation-report.md` — the §0.6 contract: ten sections in order, each metric
  either measured (with numbers + the artifact that proves it) or explicitly `unmeasured` with the
  reason. Ends with the disposition table (`d04`–`d14`: `keep` / `modify` / `drop` / `defer` with a
  one-line reason each) and an **operator-owned decision block left as `Decision: pending`** —
  the agent must not fill it in.
- **M10 protocol (workflow value)** — two parts, both in the report:
  - *M10a (machine, always run)*: for each of T1–T5, the scripted route to the correct answer on the
    **deck** and the **dashboard** (interactions required, wall-clock ms to the answer text being
    present in the DOM), three repetitions, alternating surface order. The answer key is computed
    from the store (`storeApi`/`readEvents`), never from the UI under test.
  - *M10b (operator, required for a full PASS)*: the same five tasks on the deck, the dashboard and
    the TUI by a human, timed with a prepared sheet the operator fills in. If no operator session
    happens before the slice completes, M10b is reported `unmeasured` and the verdict may be at
    most `PASS WITH CHANGES`, with the operator session listed as a blocking prerequisite of `d04`.
- **Observer-effect measurement**: frame-time p50 with instrumentation enabled vs disabled (a
  `?instrument=off` query flag, deck-internal only) so the report states what the instruments cost.
- **The ×1 / ×4 table** from red-team #17: every metric reported in both scenes.

### Explicit non-scope

No fixes. If the gate finds a defect, the report records it and the fix belongs to a later slice
(or to a bounded remediation this roadmap amends) — a gate slice that "cleans up while it is in
there" produces numbers nobody can attribute. No new features, no scene changes, no roadmap edits
beyond nothing at all: the *report* recommends changes to this file; the operator applies them.
Also out of scope: benchmarking the dashboard's own performance beyond what M10 needs, and any
measurement on hardware other than the target machine (a Windows/WebView2 datapoint is optional
and clearly marked as secondary).

### User-visible result

A short report an operator can read in five minutes: here is what the deck costs on this machine,
here is what it does to the browser, here is how it compares on the five questions that matter,
here is what broke, and here is the recommendation. Plus the raw JSON behind every number.

### Architecture changes

None by design. The slice adds one script and one document; it is the only slice in this roadmap
whose deliverable is a decision rather than behaviour. (`scripts/deck-validate.ts` deliberately
lives outside `web/src` — it is a measuring instrument, not a client.)

### Data flow

```
--fixture:  fixture project (parseRoadmap/createRun/storeApi)
              → startDashboardServer (built bundle, embedded-or-disk)
              → Playwright + scene driver (×1, ×4)
              → window.__ompoDeck.instrument.snapshot() samples (1 Hz) + raw event latency marks
              → captures/deck-validation/fixture-<ts>.json
--live:     operator-launched real run  → same server/browser/sampler path
              → captures/deck-validation/live-<ts>.json (+ run id, generations, worker models)
both:       → aggregation (percentiles, trends) → the report's tables
M10a:       answer key from storeApi → scripted DOM route per surface → interactions + ms
M10b:       operator sheet → medians per task per surface
```

### UI/UX behaviour

None in-product. The report's job is to be readable and self-suspicious: each section states its
sample count, its threshold, and whether the threshold was met. No prose paragraph may claim
something a table does not show.

### 3D behaviour

Measured, not changed. The ×4 scene (≥ 100 pads, 4 stations) is the only 3D variation and it exists
purely to expose what the ×1 scene hides.

### Error behaviour

- No live run available (or the worker dies mid-session): keep and report the partial samples,
  mark the affected metrics `unmeasured` with the observed cause, and cap the verdict at
  `PASS WITH CHANGES`. Never synthesize live numbers from fixture numbers.
- Browser unavailable: exit 1 with the `bunx playwright install chromium` hint (same rule as `d00`).
- Bundle missing/stale: fail fast with the `bun run web:build` hint (measuring a stale bundle is a
  silent lie).
- Sampling gaps (GC pause, tab throttled): record the gap in the artifact; the report must state
  the sampling duty cycle actually achieved, not the intended one.

### Performance considerations

The instrumentation's cost is itself a measured quantity (observer-effect run) and must be reported
even when it is negligible. The harness must not run with the page hidden (visibility assertions,
as in `d10`), must not sample faster than 1 Hz for heap/counters, and must not itself drive the
frame loop (no synthetic mouse jiggling except during the M9 input-latency measurement, where it is
the point).

### Testing

- `tests/deck-validate.test.ts` (unit, pure): percentile computation (nearest-rank correctness,
  single sample, ties), sample merging across gaps, the disposition-table renderer, and the
  `unmeasured` rule (a metric with zero samples cannot render as a number).
- `scripts/deck-validate.ts --fixture --json` (gated): completes both scenes and exits 0 with
  well-formed JSON for each required metric key.
- Manual/recorded: one `--live` session against a real run, with the raw artifact committed and the
  run id + worker models recorded in the report; one operator M10b session (or an explicit
  `unmeasured`).
- Reviewer check: every number in the report is traceable to a committed artifact; the decision
  block is still `pending` (an agent-filled decision is a review rejection).

### Acceptance criteria

1. `docs/deck-validation-report.md` exists with all ten §0.6 sections in order, and states machine,
   tier, renderer string, bundle/chunk sizes, run id, project, worker models and the exact commands.
2. Every metric M1–M13 is either measured (number + sample count + artifact reference) or explicitly
   `unmeasured` with the reason; **no metric is silently missing**, and at least one line names
   something the deck does worse than the dashboard or TUI.
3. `captures/deck-validation/*.json` exists for both fixture scenes and (when a live session was
   run) for the live session; the fixture artifacts come from the built bundle, not a dev server.
4. The disposition table covers `d04`–`d14` with a reason per slice; the recommendation is one of
   the four §0.5 verdicts and is consistent with the metric table (e.g. a failed F1/F4 cannot
   coexist with `PASS`).
5. The observer-effect run is reported (instrumentation cost in ms/s and in frame time).
6. `Decision: pending` is present and unfilled.
7. `bun scripts/deck-validate.ts --fixture --json` exits 0; `bun test`, `bunx tsc --noEmit`,
   `git diff --check` clean.

### Definition of done

- [ ] `scripts/deck-validate.ts` with `--fixture` and `--live`, JSON + table output, percentile
      from raw samples, visibility assertions
- [ ] ×1 and ×4 scenes both measured and reported
- [ ] M10a machine protocol executed and tabulated; M10b scheduled (or recorded as `unmeasured`)
- [ ] observer-effect numbers reported
- [ ] report written to the §0.6 contract, every metric traceable, ≥ 1 negative recorded
- [ ] disposition table + recommendation; decision block left `pending` for the operator
- [ ] raw artifacts committed under `captures/deck-validation/`
- [ ] gates green

Depends: d03
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run web:build
Verify: bun scripts/deck-validate.ts --fixture --json
Verify: test -f docs/deck-validation-report.md
Files: scripts/deck-validate.ts docs/deck-validation-report.md captures/deck-validation web/src/scene/instrument.ts web/src/App.tsx tests/deck-validate.test.ts

## [d04] Multi-worker command centre

### Objective

Render N concurrent workers as N distinct stations with one primary, quick switching, and
guaranteed awareness of every running worker — the state the operator reaches with
`ompo run --jobs N`.

### Why this slice exists

Multi-worker runs are where spatial UI earns its keep (the dashboard's lane strip is dense and
linear; a deck can show concurrency as actual simultaneous presence) and also where it most
easily becomes unusable: N stations, N live streams, N cameras. This slice defines the
policy — one primary, visible secondaries, edge markers for off-screen stations, overflow
handling by tier — and proves that switching focus costs no scene rebuild.

### Prerequisites

`d03` — focus, camera, live window.

### Scope

- ✚ `web/src/scene/lanes.ts` — pure: `stationSlots(nodes, liveIds, maxStations)` assigning each
  live slice a slot (primary first, then `AgentRow.lane` order) with a deterministic offset
  layout; `overflowCount(liveIds, maxStations)`.
- `web/src/scene/model.ts` — stations array on `DeckModel` (id, slot, stage, wedged, lane), plus
  `offScreen: string[]` computed from `visibleSliceIds(camera, nodes, aspect)`.
- `web/src/scene/DeckOverlay.tsx` — the worker switcher: a lane list of all live workers
  (`AgentRow.lastLine` + `heroAction` as the label), keyboard `[`/`]` and click; edge markers for
  off-screen live stations (DOM, positioned at the screen edge nearest the station's projected
  direction).
- `web/src/scene/renderer.ts` — pooled station meshes per slot; wedged stations get a distinct
  static pattern (non-colour); overflow stations stack onto the last slot with a HUD count.
- `web/src/scene/Deck.tsx` — focus switching; the live window follows the focused worker.

### Explicit non-scope

No per-worker split-screen cameras, no multiple simultaneous live windows (one window, one
focus — see red-team #15), no queue/claim prediction, no scheduler decisions, no changes to how
ompo decides which slices run concurrently.

### User-visible result

With `--jobs 3`, three stations stand in the deck; the primary is framed; `[`/`]` or a click
moves focus and the live window with it, without the camera jumping unless asked; the HUD reads
`live: 3`; a worker that scrolls off-screen keeps an edge marker so it is never silently lost.

### Architecture changes

- Station slots are a pure function (`lanes.ts`) — the renderer never decides placement.
- `DeckModel.stations` and `DeckModel.offScreen` are the only multi-worker state; the app's
  existing `agents: AgentRow[]` remains the source.
- No new transport: all live workers come from the existing `/agents` payload plus per-slice
  tails for the focused one only (focused-only tailing keeps request volume flat as jobs grow).

### Data flow

```
AgentRow[] (lane, status, lastLine, wedged) ─┐
SliceSummary[] (status, attempts, generation)┼─► buildDeckModel → stations[] + offScreen[]
camera + aspect ────────────────────────────┘
                                              └─► pooled station meshes (colors/height only)
focus switch ─► focusTarget(pinned=clicked id) ─► useLiveStream(focused slice) + camera intent (only on F)
```

### UI/UX behaviour

- The lane list is ordered by `AgentRow.lane`, shows `● id · status · stage · attempt/g + lastLine`,
  and is the keyboard-accessible equivalent of the stations (the DOM mirror).
- `[`/`]` cycles live workers in lane order and focuses without re-framing the camera (`F` frames).
- Off-screen markers are buttons: activating one focuses that worker and frames it.
- With more live workers than `tier.maxStations`, the HUD shows `live: N · showing M` and the lane
  list remains complete (the DOM list is the source of truth for "how many are running").

### 3D behaviour

- Station slots are laid out along the rail's local normal so concurrent work forms a visible
  cluster rather than overlapping pads.
- Primary station: full brightness + selection ring; secondaries: dimmer, lower.
- Transitions: a station appearing/disappearing is a scale+opacity tween ≤ 200 ms, disabled under
  reduced motion; **no tween runs when nothing changes**.
- Off-screen detection uses `visibleSliceIds` (pure) — no `getBoundingClientRect` heuristics.

### Error behaviour

- `agents` empty while slices read `running` (the server's derivation is interval-based): the deck
  falls back to `SliceSummary.status` and labels the lane `deriving…` rather than showing nothing.
- A live worker whose transcript is missing: station renders with a hollow core + the lane list
  shows "no transcript yet".
- Slot collisions from a malformed lane index: `stationSlots` clamps and the model reports the
  clamp in `DeckModel.warnings` (rendered in the HUD), never silently overlapping.

### Performance considerations

- Station meshes are pooled to `tier.maxStations`; N > budget must not allocate per worker.
- Edge markers are DOM (≤ 8 in practice) and update only when `offScreen` changes, not per frame.
- The lane list re-renders at SSE cadence (≤ ~1.1 Hz) — it must not re-render per frame nor on
  camera movement.

### Testing

- `tests/deck-lanes.test.ts` (pure): slot assignment is stable and deterministic for a given
  `(liveIds, lanes)`; primary is first; overflow counted correctly; clamping reported;
  `offScreen` for a camera looking away from a known node set matches `visibleSliceIds`.
- `tests/e2e/deck.e2e.ts` (extend): a fixture with 3 live slices renders 3 stations and
  `live: 3`; `]` switches the focused worker and the live window's source label changes;
  `objects`/`geometries` counts are identical before and after switching; an off-screen worker
  exposes a marker button that focuses it.
- Manual: `ompo run --jobs 3` in a pilot project with 3 ready slices; confirm the deck shows three
  stations and the dashboard's lane strip agrees on ordering and statuses.

### Acceptance criteria

1. With 3 live slices: exactly 3 stations rendered, HUD `live: 3`, lane list has 3 rows in
   `AgentRow.lane` order.
2. Switching focus to any live worker updates the live window **and** the station highlight, with
   `geometries` and `objects` counts unchanged (no rebuild).
3. Camera moves only on `F`, on primary change while unpinned, or on user input — never on focus
   switching alone (asserted by sampling camera state from `window.__ompoDeck`).
4. Off-screen live workers always have a marker or a lane row (assert: for every live id, either
   `visible` or a marker element exists).
5. With more live workers than the tier budget, the HUD reports the overflow and no allocation
   occurs beyond the pooled meshes.
6. Gates clean.

### Definition of done

- [ ] `lanes.ts` pure + tested; stations on `DeckModel`
- [ ] pooled station meshes; no allocation per worker
- [ ] lane list + edge markers + overflow reporting
- [ ] focus switching proven rebuild-free
- [ ] e2e coverage
- [ ] gates green

Depends: d03v
Effort: hi
Timeout: 60m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Files: web/src/scene/lanes.ts web/src/scene/model.ts web/src/scene/DeckOverlay.tsx web/src/scene/renderer.ts web/src/scene/Deck.tsx tests/deck-lanes.test.ts tests/e2e/deck.e2e.ts

## [d05] Lifecycle choreography and alerts

### Objective

Show state transitions as they happen — claim → worker → verify → review → merge → done, and the
failure branches — with alerts that are obvious but restrained, readable without colour, and
dismissible without hiding a recurrence.

### Why this slice exists

A deck that only shows *current* state is a slower dashboard. The value of a spatial surface is
watching work move: a station rising as it verifies, a slice dropping into failure, a review
rejection arriving. This slice also carries the brief's "important alerts and state transitions"
priority level and must not become a fireworks show — hence the transition budget, the reduced
motion switch, and the alert cap.

### Prerequisites

`d03` — model, focus, stations.

### Scope

- ✚ `web/src/scene/deltas.ts` — pure: `diffModels(prev: DeckModel | null, next: DeckModel, events: RunEvent[]): SceneDelta[]`
  with `SceneDelta = { kind: "status"; id; from: SliceStatus; to: SliceStatus; seq }
                    | { kind: "attempt"; id; attempt; generation }
                    | { kind: "alert"; alert: DeckAlert; seq }
                    | { kind: "alert-cleared"; id; alertKind }`.
- ✚ `web/src/scene/alerts.ts` — pure: `deriveAlerts(input): DeckAlert[]` implementing §D.8 exactly
  (kinds, sources, severity ordering), plus `dismissKey(alert)` = `runId|sliceId|kind|lastSeq` and
  `activeAlerts(alerts, dismissed)`.
- `web/src/scene/DeckOverlay.tsx` — the alert stack: text-first rows (`severity · slice ·
  message`), severity shape icons, keyboard reachable, dismiss button per row; the `double-loop`
  banner (from `RunDetail.loops.length > 1`).
- `web/src/scene/renderer.ts` — beacon instances (≤ `tier.maxBeacons`) and the tween engine consuming
  `SceneDelta[]`: status change → 200–400 ms material/height tween; alert → beacon scale-in;
  cleared → scale-out. Tween duration is 0 when `prefs.reducedMotion` is set.
  (rule: reduced motion ⇒ 0 ms; `minimal` tier keeps ≤ 200 ms tweens; `standard`/`high` ≤ 400 ms).
- `web/src/scene/Deck.tsx` — keeps `prevModel` in a ref, computes deltas on model change, forwards
  them to the renderer; owns the dismissed-alert set in `localStorage["ompo.deck.dismissed"]`.
- `web/src/scene/DeckOverlay.tsx` — `M` toggles reduced motion (persisted in deck prefs).

### Explicit non-scope

No sound, no particles, no post-processing, no per-log-line animation, no alert rules beyond §D.8
(no thresholds invented in the UI), no notification integration, no toasts outside the deck.

### User-visible result

The operator sees a slice move through its phases: the station rises as gates run, a review
rejection drops it with a violet beacon and a readable line ("review rejected — <first finding>"),
a failed slice gets a steady red marker plus a stack row with its reason, a wedged worker pulses
with "transcript silent 12m". Alerts can be dismissed and re-raise if the condition recurs.

### Architecture changes

- Deltas are **pure and testable**: the renderer receives a list of changes, not the whole model, so
  animation logic can be asserted from unit tests without a GPU.
- Alert derivation is a pure function of DTOs — no new endpoints, no new event types, no server work.
- Dismissal state is view state in `localStorage`, keyed by `lastSeq` so recurrence re-raises.

### Data flow

```
prev DeckModel ─┐
next DeckModel ─┼─► diffModels(prev, next, events) ─► SceneDelta[]
RunEvent[]    ──┘                                        ├─► renderer tween queue (beacons, materials, height)
                                                         └─► DeckOverlay alert stack (React, at model cadence)
derived alerts ─► activeAlerts(alerts, dismissed[runId]) ─► stack rows + beacon set
```

### UI/UX behaviour

- Alert stack: newest highest severity first; each row: severity glyph, slice id, one-line message,
  dismiss; `Enter` on a row selects the slice and opens the dock (`d06` defines the dock; until
  then it selects).
- The stack is collapsible; when collapsed it shows `N alerts · highest: <kind>` and is never fully
  hidden while a high-severity alert is active.
- Dismissal is explicit and per-row; there is no "dismiss all".
- `M` toggles reduced motion; the setting is visible in the HUD (`motion: reduced`).

### 3D behaviour

- Beacons: instanced shapes at the pad/station anchor; severity by shape (steady ring = high,
  slow pulse ring = medium, dim ring = advisory) **plus** text. Colour is redundant, never the
  only channel.
- Status tween: material colour/emissive lerp + height lerp; a tween never blocks the next state
  change (a second delta interrupts and re-targets, no queue growth).
- Alert clear: beacon scale-out over ≤ 200 ms.
- Under reduced motion: all tween durations are 0 and beacons appear/disappear instantly; the DOM
  stack is unaffected.
- Total animated instances ≤ `tier.maxBeacons`; overflow degrades to the DOM stack with a HUD
  count, never silently dropped.

### Error behaviour

- Unknown/unmapped transition: the model applies the new state immediately and logs one
  `console.debug` (no exception) — a missing animation must never break a state change.
- Clock/time-based alert sources (`wedged`, `verdictStall`) recompute on every model build, so a
  frozen SSE stream cannot freeze an alert (they are DTO-driven, not timer-driven).
- Dismissed storage unavailable (private mode): dismissal degrades to session-only memory, no throw.

### Performance considerations

- Tween work is bounded: at most `tier.maxBeacons` concurrent beacons and one tween per changed
  station; a burst of N simultaneous status changes (e.g. a resumed run) must coalesce into one
  frame's worth of updates, not N frames.
- Deltas are computed once per model change (SSE cadence), never per frame.
- The alert stack re-renders at model cadence only; dismissal must not rebuild the scene
  (assert: `geometries` count stable).

### Testing

- `tests/deck-alerts.test.ts` (pure): every §D.8 kind derived from a crafted DTO/event fixture;
  a `failed` slice produces exactly one alert (not one per event); severity ordering; dismissal
  key stability and recurrence re-raise (same kind, new seq); `wedged` from `AgentRow.wedged`;
  `verdictStall` wired as advisory (message wording asserted to contain "idle", never "stuck");
  `double-loop` from two `loops`.
- `tests/deck-deltas.test.ts` (pure): `running → verifying → done` yields three ordered deltas;
  `null → model` yields no status deltas (first paint must not animate the whole world);
  a status change with no matching event still produces a delta (DTO is authoritative);
  interruption semantics (two deltas for one id keep the later target).
- `tests/e2e/deck.e2e.ts` (extend): the alert stack renders for a failed fixture slice with the
  slice's reason; dismissing removes the row and re-raising after a new failing event restores it;
  `M` sets `motion: reduced` and a status change applies without a tween (assert the HUD's
  `tweens` counter is 0); the stack's bounding box never intersects the live window's.
- Manual: fixture run with an injected `verify_failed` then `slice_failed_terminal`; observe the
  transition and the stack.

### Acceptance criteria

1. For a fixture event sequence `slice_claimed → worker_finished → verify_failed →
   slice_retried`, the deck applies exactly those visual states in order, and the renderer
   reports 0 queued tweens when the sequence ends.
2. A failed slice produces exactly one high-severity alert row containing its `reason`; dismissing
   it removes the row and the beacon; a subsequent new failure event re-raises it.
3. With reduced motion on, no tween runs (`tweens === 0`) for any transition, and the alert stack
   behaves identically.
4. Beacon instances never exceed `tier.maxBeacons`; overflow is counted in the HUD and the stack
   still lists every alert.
5. The alert stack never overlaps the live window (geometry assertion in e2e).
6. Gates clean.

### Definition of done

- [ ] `alerts.ts`, `deltas.ts` pure + fully tested
- [ ] tween engine bounded, interruptible, disabled under reduced motion
- [ ] alert stack text-first, dismissible, recurrence-aware
- [ ] `double-loop` banner from `RunDetail.loops`
- [ ] e2e coverage; no overlap with the live window
- [ ] gates green

Depends: d03v
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Files: web/src/scene/alerts.ts web/src/scene/deltas.ts web/src/scene/model.ts web/src/scene/renderer.ts web/src/scene/DeckOverlay.tsx web/src/scene/Deck.tsx tests/deck-alerts.test.ts tests/deck-deltas.test.ts tests/e2e/deck.e2e.ts

## [d06] Inspection dock over existing endpoints

### Objective

Make every forensic surface the TUI and dashboard already have reachable from the deck —
Output, Diff, Verify, Review, Prompt, Events, Usage, Log — by embedding the existing
`Inspector` component rather than building a second one.

### Why this slice exists

The brief's requirement "existing TUI concepts must not disappear" is satisfied cheaply and
correctly here: `web/src/components/Inspector.tsx` already implements all eight tabs over the
existing endpoints and caps. Any deck-specific re-implementation would be the exact duplication
this roadmap forbids (red-team #4). This slice is therefore mostly wiring plus the guarantee
that the dock and the live window never fight for the same screen space.

### Prerequisites

`d03` — selection, focus, live window.

### Scope

- ✚ `web/src/scene/DeckInspector.tsx` — a dock that renders the existing `Inspector` with the
  existing props (`runId`, `selected`, `detail`, `onControlDone`, `onClose`, `slices`, `events`,
  `live`, `wedged`) supplied by `App.tsx` exactly as the dashboard supplies them.
- `web/src/scene/Deck.tsx` — dock open/close state; opening on selection (`d01`-era behaviour was
  select-only); `Esc` closes the dock (second `Esc` after unpinning); keys `1`…`8` open the dock on
  a tab (the tab ids come from `Inspector.tsx`'s existing `TABS`).
- `web/src/scene/DeckOverlay.tsx` — dock affordance (a "Inspect" affordance on the overlay line and
  on the focused station's lane row) and the layout rule that the dock occupies the right side and
  never overlaps the live window or the HUD.
- App wiring: pass `sliceDetail` (already fetched on selection change by the existing app) into the
  deck — no new fetching, no new endpoint, no new caps.

### Explicit non-scope

No new tabs, no new endpoints, no in-deck editing, no 3D diff/log rendering, no changes to
`Inspector.tsx` beyond what is strictly required to render it outside the current layout (ideally
nothing), no session-log viewer (the existing `/sessions` data stays in the dashboard for now).

### User-visible result

Selecting a pad and pressing `1`…`8` (or clicking "Inspect") opens the same forensics the
dashboard shows: report summary, diff, gate steps, review findings, prompt tail, events, usage and
the raw transcript — for the selected slice, without leaving the deck.

### Architecture changes

- The deck gains a dependency on existing dashboard components; this is deliberate — the two
  surfaces must not drift, and `Inspector` is the shared implementation.
- **No new API surface**: the e2e test asserts that opening the dock issues requests only to
  paths that already exist (`/api/runs/:id/slices/:sid`, `…/log`, `…/diff`, `…/events`).

### Data flow

```
click pad / lane row ─► App selection (existing) ─► App fetches SliceDetail (existing effect)
                                                   └─► props: detail, slices, events, live, wedged
Dock(1..8 or Inspect) ─► <Inspector …props /> ─► Output | Diff | Verify | Review | Prompt | Events | Usage | Log
Close (Esc / X) ─► dock unmounts ─► scene untouched (assert: geometries/objects unchanged)
```

### UI/UX behaviour

- The dock slides in from the right (≤ 180 ms, instant under reduced motion) with the canvas
  resized to the remaining area (one `setSize` + one frame) — **no per-frame resize**.
- The live window and the dock coexist: live window bottom-left, dock right, HUD top-left. The
  live window narrows rather than disappearing when the dock is wide.
- Tab keys work without opening the dock twice; `Tab`/`Shift+Tab` move focus into the dock
  naturally (no focus trap beyond what `Inspector` already does).
- Closing the dock returns to the same camera state (no reset).

### 3D behaviour

- The selected pad keeps its selection ring while the dock is open; the camera does **not** move
  on dock open/close (the operator chose to inspect, not to fly).
- No new scene objects: the dock is pure DOM.

### Error behaviour

- `SliceDetail` still loading → the dock renders the existing skeleton (`ui/skeleton.tsx`) exactly
  as the dashboard does.
- 404 (artifacts missing) → the existing `Inspector` empty-states; the deck must not substitute its
  own error copy.
- Dock open during a run switch → closes (the selection belongs to the previous run) and reopens
  empty on the new selection.

### Performance considerations

- The dock is DOM and costs nothing on the GPU; the only scene effect is a resize (one frame).
- Opening/closing 20× must not grow `geometries`/`textures` counters (e2e assertion) — the resize
  path must not reallocate buffers.

### Testing

- `tests/e2e/deck-inspector.e2e.ts` (Playwright): select a slice, press `1`…`8` and assert the
  expected tab content renders (reuse the dashboard's existing assertions where possible);
  closing restores the layout; the request log for the whole interaction contains only
  pre-existing `/api/` paths; the live window remains visible; `geometries` unchanged across
  open/close.
- Manual: compare the dock's Output and Verify tabs side-by-side with the dashboard's inspector for
  the same slice — they must be indistinguishable in content.

### Acceptance criteria

1. All eight tabs render for a fixture slice with content identical to the dashboard's inspector
   (same text for report summary, verdict steps, review findings, prompt tail).
2. Opening the dock issues **no** request to a path outside the existing endpoint set (asserted
   from the e2e request log).
3. The live window and the HUD remain fully visible (no intersection with the dock).
4. Open/close 20× leaves `window.__ompoDeck.geometries` constant and the camera state unchanged.
5. Gates clean.

### Definition of done

- [ ] dock renders the existing `Inspector` with existing props (diff to `Inspector.tsx` is empty
      or trivially layout-only)
- [ ] selection → dock wiring; `1`…`8`, `Esc`, close button
- [ ] layout rule: live window + HUD never occluded
- [ ] no new endpoints (asserted)
- [ ] e2e coverage
- [ ] gates green

Depends: d03v
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Files: web/src/scene/DeckInspector.tsx web/src/scene/Deck.tsx web/src/scene/DeckOverlay.tsx web/src/App.tsx tests/e2e/deck-inspector.e2e.ts

## [d07] Temporal layer: event ribbon, replay-aware history, and the history wall

### Objective

Give the deck a time axis: a bounded event ribbon for the current run, and a spatial history wall
of previous runs that switches the whole surface to another run — both strictly read-only.

### Why this slice exists

Two of the brief's priorities are temporal: "events" and "run history". They are also the places
where a client is most tempted to rebuild domain logic (reconstructing statuses, replaying
events). This slice draws that line explicitly: the deck **visualises** the event log and
**delegates** replay to the existing `/replay` endpoint rather than re-implementing
`rebuildStatusesFromEvents` in the browser.

### Prerequisites

`d02` — model, rail (history tiles attach to the rail's world).

### Scope

- ✚ `web/src/scene/history.ts` — pure:
  `buildEventRibbon(events: RunEvent[], opts: { bucketMs: number; maxBuckets: number }): RibbonBucket[]`
  (time-bucketed counts by lane, using `eventLane` from `web/src/lib/events.ts`; explicit caps);
  `attemptSegments(events)` delegating to the existing `buildTimeline`
  (`web/src/lib/timeline.ts:131`) — no second segmentation algorithm.
- `web/src/scene/renderer.ts` — the ribbon as a single instanced row of buckets (1 draw call),
  placed at the rail's edge; the history wall as one instanced tile row (1 draw call) fed by
  `RunSummary[]`.
- ✚ `web/src/scene/HistoryWall.tsx` — DOM mirror: a run list (reuse the dashboard's `RunsPage`
  row semantics: runId, status counts, live marker, updated time), click → `onOpenRun(runId)`.
- `web/src/scene/DeckOverlay.tsx` — ribbon interactions: hover a bucket → tooltip-free text line
  (`t`, `lane`, `count`); click a bucket → select the newest slice touched in that bucket and open
  the Events tab (via the existing dock); the "attempts" strip per selected slice from
  `buildTimeline`.
- Replay: the deck calls the existing `GET /api/runs/:id/replay` only when the operator explicitly
  asks ("verify replay"), and renders its `{ ok, diffs }` as a text panel — it never reconstructs
  statuses locally.

### Explicit non-scope

No client-side status reconstruction, no event editing, no time-travel that changes what the deck
shows (the deck always displays current state; the ribbon is an index, not a second state model),
no cross-run comparison view, no per-event 3D objects (only bucketed instances).

### User-visible result

The operator can see the shape of the run over time (activity buckets coloured by lane), jump from
an interesting moment straight to the slice and its events, see a selected slice's attempt
segments, and switch the whole deck to any previous run from the history wall.

### Architecture changes

- The ribbon is **bucketed and capped**, so the deck's cost is O(buckets) regardless of event count.
- `history.ts` reuses `eventLane` and `buildTimeline`; a second lane classifier or a second attempt
  segmenter would be rejected in review.
- Run switching reuses App's existing `openRun(runId)` path — the same one the dashboard's runs
  table uses.

### Data flow

```
events: RunEvent[] ─► buildEventRibbon(bucketMs=30s, maxBuckets=120) ─► RibbonBucket[] ─► instanced row
events: RunEvent[] ─► buildTimeline(...) ─► segments for the selected slice ─► DOM strip
runs: RunSummary[] ─► history tiles (instanced) + HistoryWall list ─► onOpenRun(runId) ─► App switches run
explicit "verify replay" ─► GET /api/runs/:id/replay ─► { ok, diffs } ─► text panel
```

### UI/UX behaviour

- The ribbon has a fixed width (window-bounded, not data-bounded), bucket size auto-chosen from the
  run's span so it always renders ≤ 120 buckets; a "30s / 5m / 1h" label states the current bucket.
- Selecting a bucket highlights the slices touched in it (pad outline) without changing selection
  until clicked.
- The history wall lists the newest 20 runs by default with a "show all" affordance; the live run
  is marked; quiescent runs show their `Live` state from `RunSummary.live`.
- Switching runs resets the camera to the `rail` preset, clears the pin and the dismissed alerts
  (they are per run).

### 3D behaviour

- The ribbon sits on a shallow rail beside the roadmap (instanced boxes, height ∝ bucket count,
  colour ∝ dominant lane, capped by tier).
- History tiles sit on a back wall plane; the selected run is ring-highlighted; tiles are inert
  geometry with DOM hit areas **not** projected (clicks happen on the DOM list; the tiles are
  visualization) — this deliberately avoids DOM-to-3D projection math (red-team #3).
- No animation on run switch beyond a 300 ms cross-fade (instant under reduced motion).

### Error behaviour

- A run with no events (or a corrupt line): the ribbon renders empty with an explicit
  "no events yet" text; `readEvents` failures surface as the existing error states in `App`.
- `RunSummary` entries missing optional fields: render `—`, never `0` (the repo's existing rule).
- `openRun` failure (run deleted between list and click): the deck keeps the current run and shows
  the existing error banner; no partial switch.

### Performance considerations

- Bucketing is O(events) **once per model build**, not per frame; the e2e fixture includes a
  10 000-event synthetic run to prove the build stays under 16 ms in a unit test (pure function,
  measured with `performance.now()` around the call in Bun).
- Instance counts are capped by `maxBuckets` and by `tier` limits; no per-event geometry.

### Testing

- `tests/deck-history.test.ts` (pure): bucketing correctness (boundaries, empty input, one event,
  events outside the window), bucket count ≤ `maxBuckets` for 100 000 synthetic events, dominant
  lane per bucket, `attemptSegments` delegating to `buildTimeline` (same output for the same input
  as the existing helper — a real equality assertion, not a smoke test), and the 10 000-event
  performance bound.
- `tests/e2e/deck.e2e.ts` (extend): the ribbon renders and a bucket click selects the right slice
  and opens the Events tab; the history wall lists the fixture's runs and switching runs changes
  the deck's run id without a page reload; the request log contains no POST during history
  interactions.
- Manual: on the real `.omp/roadmap/runs/20260909-kph0as` run, verify the ribbon's shape matches
  the event distribution seen in `ompo log`.

### Acceptance criteria

1. 100 000 synthetic events → ribbon buckets ≤ 120, model build ≤ 16 ms, scene instances ≤
   `tier` cap.
2. Clicking a bucket selects the newest slice touched in that bucket and opens the dock on Events;
   no POST is issued by any history/ribbon interaction.
3. The history wall shows one tile and one DOM row per run in `api.runs()`; clicking switches the
   run (`window.__ompoDeck.runId` changes) with no full-page reload.
4. `attemptSegments` output equals `buildTimeline` output for the same events (equality test).
5. Gates clean.

### Definition of done

- [ ] `history.ts` pure, capped, tested (including the 100k-event bound)
- [ ] instanced ribbon + history tiles (2 draw calls total)
- [ ] DOM history list; run switching via the existing `openRun`
- [ ] explicitly no client-side status reconstruction; `/replay` used only on demand
- [ ] e2e coverage
- [ ] gates green

Depends: d03v
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Files: web/src/scene/history.ts web/src/scene/HistoryWall.tsx web/src/scene/renderer.ts web/src/scene/DeckOverlay.tsx web/src/scene/Deck.tsx tests/deck-history.test.ts tests/e2e/deck.e2e.ts

## [d08] Control from the deck

### Objective

Let the operator act on what they are looking at — retry, skip, park, kill, pause, resume,
set-jobs, restart-loop — through the existing control-intent path, with the same guards,
confirmations and queued-vs-direct feedback the dashboard has.

### Why this slice exists

Control is already reachable in the deck through the dock (`Inspector` embeds `ControlPanel`), so
the real work of this slice is (a) making control reachable **from the spatial selection** without
duplicating a single control semantic, and (b) surfacing the intent's lifecycle — queued,
applied, rejected — where the operator is looking, since a spatial surface makes "I pressed retry
and nothing happened" more confusing than a dense table does.

### Prerequisites

`d06` — the dock and the shared `Inspector`/`ControlPanel` wiring.

### Scope

- `web/src/scene/DeckOverlay.tsx` — a contextual action bar for the focused/selected slice and for
  the run: the same actions the dashboard exposes, calling the **same** `App` handlers
  (which call `api.control`), including the destructive arm/confirm behaviour
  (skip/kill confirm inline, exactly as the dashboard does).
- `web/src/scene/Deck.tsx` — intent feedback: a submitted intent is optimistically marked
  `pending (seq N)` in the overlay and cleared when `control_applied`/`control_rejected` arrives on
  the event stream for that seq (the existing correlation rule from
  `docs/web-dashboard-architecture.md` §5). Rejections surface as an alert row (`d05`).
- Quiescent-run handling: `pause`/`resume`/`set-jobs` must be hidden or recast with the restart
  command exactly as the dashboard does (`live === false`), never offered as a guaranteed
  rejection.
- `restart-loop` (the wedged-loop recovery) exposed only when `RunDetail.loops.length >= 1` and the
  run reads live but stalled, with its existing confirmation semantics.

### Explicit non-scope

No new control kinds, no new endpoints, no direct store mutation, no optimistic status changes in
the model (the store's events remain the only source of truth), no keyboard shortcuts that could
fire a destructive action without a confirmation, no control from the history wall (read-only
runs).

### User-visible result

With a slice selected in the deck, the operator can press "retry" and watch the intent queue, apply
and take effect — without switching surfaces, and knowing that what they pressed is exactly what
`ompo ctl` would do.

### Architecture changes

- Control remains a pure delegation: the deck holds `pendingSeq` (view state) and nothing else.
- The action bar's enabled/disabled matrix must be derived from the same status guards the
  dashboard uses; if the dashboard encodes them in `ControlPanel`, the deck reuses that component
  rather than restating the matrix.

### Data flow

```
action bar click ─► App handler (existing) ─► POST /api/runs/:id/control { kind, sliceId, reason? }
                                             └─► 202 { seq } | 200 { ok, applied } | 400 | 404
202 seq ─► overlay marks "retry queued (seq N)"
SSE ─► control_applied | control_rejected (seq N) ─► clear pending; rejection → alert row (d05)
200 direct (quiescent) ─► notepad outcome text, no pending state
```

### UI/UX behaviour

- The action bar shows only actions valid for the selection's status (mirroring the dashboard's
  guard matrix), each with an accessible label and the same confirmation flow.
- Destructive actions require the same explicit confirm step; the confirm is a DOM dialog, never a
  3D affordance.
- Pending intents show `queued (seq N)` with a spinner ≤ 2 s and then either clear or become a
  rejection alert — **never a silent success**.
- When the run is quiescent, the deck shows the dashboard's exact recovery hint (`ompo resume
  --run <id>`) instead of dead buttons.

### 3D behaviour

- An applied intent produces the same transitions `d05` already renders (a retry moves the slice
  back to `pending`, the station falls; a kill drops it to `aborted`) — no special-case visuals.
- A rejected intent pulses the affected station's beacon once (≤ 200 ms) in addition to the alert
  row; the pulse is disabled under reduced motion (the row remains).

### Error behaviour

- 400/404 from the control endpoint: the response's message is shown verbatim in the alert row
  (the server's validator messages are the operator's best explanation).
- Network failure: `POST` failure surfaces as an alert row with a retry affordance; the deck never
  assumes the action happened.
- Stale selection (slice id no longer present after a run switch): actions are disabled until
  selection resolves; the e2e test covers clicking an action immediately after a run switch.

### Performance considerations

- Control interactions do not touch the render loop except through the resulting model change.
- The action bar re-renders on selection/status change only (SSE cadence), not per frame.

### Testing

- `tests/e2e/deck-control.e2e.ts` (Playwright, against the fixture server with a stubbed control
  endpoint that records requests): for each action the deck exposes, assert the POST body is
  byte-identical to the body the dashboard's `ControlPanel` produces for the same action; assert
  the destructive confirm requires two interactions; assert a queued intent shows `queued (seq N)`
  and clears on a synthesised `control_applied`; assert a `control_rejected` produces an alert row
  containing the server message; assert quiescent runs do not offer `pause`/`set-jobs`.
- Manual: run a pilot project with a live loop, use the deck to `retry` a failed slice, and verify
  `ompo log` shows `control_requested` → `control_applied` with the same `detail` JSON.

### Acceptance criteria

1. Every control action available in the dashboard is available in the deck, and produces an
   identical POST body (asserted per action).
2. A queued intent is never reported as success before `control_applied` arrives; a rejection
   always produces a visible, dismissible alert row carrying the server's message.
3. Destructive actions cannot be triggered without the same confirmation the dashboard requires.
4. Quiescent runs offer the recovery command instead of loop-local actions.
5. No new endpoint or intent kind appears (asserted: the control request log contains only the
   existing kinds and path).
6. Gates clean.

### Definition of done

- [ ] action bar wired to existing handlers; guard matrix reuses existing logic
- [ ] pending/rejected/settled feedback from the existing event correlation
- [ ] destructive confirmations preserved
- [ ] quiescent-run recasting preserved
- [ ] e2e coverage incl. body-equality with the dashboard
- [ ] gates green

Depends: d06
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Files: web/src/scene/DeckOverlay.tsx web/src/scene/Deck.tsx web/src/App.tsx tests/e2e/deck-control.e2e.ts

## [d09] Fallback, accessibility, and the no-WebGL path

### Objective

Make the deck degrade instead of failing: a flat 2D projection when WebGL is unavailable or the
budget cannot be met, full keyboard operation, reduced motion honoured by default, and a text
mirror of everything the 3D scene conveys.

### Why this slice exists

The brief is explicit that 3D must be a presentation layer, not the source of truth, and that
important information must not become inaccessible. On this machine the *expected* tier is
`minimal` with a real chance of no WebGL at all — so the fallback is a mainline path, not a
courtesy. This is also the slice that keeps the deck honest under review: if the fallback shows
everything, then the 3D adds legibility rather than gatekeeping.

### Prerequisites

`d04` — multi-worker stations (the fallback must project the same information set).

### Scope

- ✚ `web/src/scene/fallback.ts` — pure: `deckAvailability(input: { webgl2: boolean; tier: QualityTier;
  forced?: "3d" | "flat"; reducedMotion: boolean }): "3d" | "flat"`,
  and `flatRows(model: DeckModel): FlatRow[]` producing the same information the scene encodes
  (status glyph, id, title, attempt/generation, stage, alert kinds, live marker) as an ordered list.
- ✚ `web/src/scene/FlatDeck.tsx` — the flat projection: reuses `SliceTable`/`WorkerLanes`
  (`web/src/components/`) over the same model; renders the live window exactly as the 3D surface does
  (same `LiveFeed`), plus the same alert stack and history list.
- `web/src/scene/Deck.tsx` — availability gate at mount (probe once), the manual override (`T` cycle
  includes `flat`), and an inline notice explaining why the deck is flat (with device detail).
- Accessibility work that must be true on **both** surfaces:
  - a visually hidden, live-updating text mirror of the focus state
    (`aria-live="polite"`: focused slice, status, stage, alert count, live worker count);
  - all pads/stations mirrored as a DOM list with roving `tabindex`, `Enter`/`Space` activation
    (the repo's existing pattern: `AgentCard.tsx:47`, `Dag.tsx:216`, `RoadmapPage.tsx:160`);
  - visible focus rings on every interactive element (existing `--ring` token);
  - no status conveyed by colour alone (glyph + text everywhere; asserted by a DOM test);
  - `prefers-reduced-motion: reduce` respected on mount, with the `M` toggle able to turn motion
    back on;
  - the canvas gets `aria-hidden="true"` and a descriptive label; it never takes focus.
- `web/src/scene/DeckOverlay.tsx` — a "keyboard help" panel generated from `DECK_KEYS`, reachable via
  `H`, listing every binding.

### Explicit non-scope

No screen-reader narration of the 3D scene itself, no full WCAG audit of the existing dashboard
(that is a separate concern and mostly already implemented), no i18n, no high-contrast theme beyond
the existing token system, no mobile/touch layout work.

### User-visible result

On a machine or configuration without WebGL, the deck opens as a legible flat workspace with the
same content and controls, and an explanation. Keyboard-only operation reaches every function of
the 3D surface. Screen-reader users hear the focused slice and its state change.

### Architecture changes

- `deckAvailability` is pure and tested; the 3D and flat surfaces consume the **same** `DeckModel`,
  so the fallback cannot drift from the 3D surface (a divergence would be a model bug, caught by
  tests, not a UI bug discovered by a user).
- The DOM mirror list introduced in `d02` becomes the accessibility backbone; the canvas is
  explicitly decorative to assistive technology.

### Data flow

```
mount ─► probe WebGL2 + renderer string ─► deckAvailability(...) ─► "3d" | "flat"
both paths ◄── DeckModel ◄── buildDeckModel(DeckInput)   (single source for both renderers)
focus/selection/alerts ─► aria-live text mirror (one node, polite)
```

### UI/UX behaviour

- Flat mode keeps: selection, live window (freeze/expand), inspector dock, alerts, control, history.
  It loses: the spatial rail, beacons, camera. The notice says so in one sentence.
- `T` cycling includes `flat` so an operator on a good GPU can still choose it for a smaller window.
- Keyboard help (`H`) is a DOM panel listing `DECK_KEYS` verbatim.
- Every focus change is announced once (polite), never per log line.

### 3D behaviour

None in flat mode. In 3D mode this slice adds no visuals — it removes inaccessible ones: the
selection ring and beacons gain DOM equivalents (already present in the mirror/stack), and the
camera is never the only way to reach information.

### Error behaviour

- WebGL2 unavailable → flat mode + notice; never a blank canvas or a thrown error.
- Context lost during a session (`webglcontextlost`) → switch to flat mode, keep state, show a
  notice with a "retry 3D" affordance; the e2e test dispatches a synthetic context-loss event.
- Storage unavailable → prefs degrade to session defaults (already required by `d01`).
- Unknown `DECK_KEYS` entry (developer error) → help panel renders the raw key; no crash.

### Performance considerations

- Flat mode must be cheaper than 3D: no canvas, no loop; the `loop` is not created at all.
- The availability probe runs once per mount and must not create a context just to test: probe
  with a 1×1 canvas that is immediately disposed, and cache the result for the session.

### Testing

- `tests/deck-fallback.test.ts` (pure): availability matrix (webgl2 false → flat; minimal tier →
  3d unless forced; forced flat wins); `flatRows` covers every `DeckModel` node exactly once and
  carries alert kinds/status/stage; every `DECK_KEYS` entry has a label and a description.
- `tests/e2e/deck-a11y.e2e.ts` (Playwright):
  1. With an init script neutralising `HTMLCanvasElement.prototype.getContext("webgl2")`, the deck
     opens in flat mode and still shows slices, the live window, the alert stack and the dock.
  2. Keyboard-only walkthrough: select a slice, open each inspector tab, freeze/resume, switch
     workers, close the dock, return to the dashboard — no mouse events used.
  3. The `aria-live` mirror text changes when the focused slice's status changes.
  4. Every status-bearing DOM element contains a non-colour indicator (glyph/text) — asserted
     structurally, not by screenshot.
  5. `prefers-reduced-motion: reduce` (Playwright `emulateMedia`) → no tween runs.
- Manual: run with `--use-gl=disabled`-equivalent (or a software-only container) and confirm the
  flat deck is usable.

### Acceptance criteria

1. With WebGL2 unavailable, `?surface=deck` renders the flat deck with slice list, live window,
   alerts, dock and history — no blank state, no thrown error, and a one-sentence explanation.
2. Keyboard-only operation reaches: selection, focus, live freeze/expand, worker switching, all
   eight dock tabs, control actions (with their confirmations), history switching, surface switch.
3. The `aria-live` mirror reports focus changes and status changes; it never updates per log line.
4. Context loss switches to flat mode with state preserved and a "retry 3D" affordance.
5. `M` and `prefers-reduced-motion` both disable tweens (asserted).
6. Gates clean.

### Definition of done

- [ ] `fallback.ts` pure + tested; flat surface consumes the same `DeckModel`
- [ ] DOM mirror + aria-live + focus rings + non-colour status, asserted by tests
- [ ] context-loss handling
- [ ] keyboard help generated from `DECK_KEYS`
- [ ] e2e a11y spec green
- [ ] gates green

Depends: d03v d04
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Files: web/src/scene/fallback.ts web/src/scene/FlatDeck.tsx web/src/scene/Deck.tsx web/src/scene/DeckOverlay.tsx tests/deck-fallback.test.ts tests/e2e/deck-a11y.e2e.ts

## [d10] Performance hardening and budget enforcement

### Objective

Turn the `d00` budgets into enforced limits: a committed harness that measures the real scene,
coalescing and disposal rules that keep the loop honest, and an automatic tier downgrade when the
budget is exceeded on the operator's machine.

### Why this slice exists

Budgets that are not measured degrade within two slices — this is the slice that makes the deck's
performance a property of the repository rather than an intention. It also has to happen *after*
transitions (`d05`) and multi-worker stations (`d04`), because those are the two features that
actually threaten the frame budget.

### Prerequisites

`d04`, `d05`.

### Scope

- ✚ `scripts/deck-perf.ts` — Playwright harness that loads the built dashboard at `?surface=deck`
  against a fixture run (reusing `tests/e2e/serve.ts`'s fixture shape), then measures per tier:
  median/p95 frame time over 300 frames while driving synthetic activity (status churn, log growth,
  worker focus switching, camera moves), plus `renderer.info` counters (draw calls, geometries,
  textures, programs). Output: JSON + a human table; exits non-zero when a budget is violated.
- `web/src/scene/loop.ts` — coalescing rules: at most one frame per `maxFps` tick; state updates
  applied at model cadence; camera updates at most once per frame; a "burst" of N deltas renders in
  one frame.
- `web/src/scene/renderer.ts` — disposal audit: `dispose()` releases geometries/materials/textures/
  programs and is verified by a test that mounts/unmounts 20× and asserts
  `info().geometries`/`textures` return to the mount-time baseline.
- `web/src/scene/tier.ts` + `Deck.tsx` — **auto-downgrade**: if the measured median frame time
  exceeds `tier.frameBudgetMs` for 60 consecutive frames, drop one tier (hysteresis: no auto-upgrade
  without an explicit operator choice), surface it once in the HUD ("downgraded to minimal —
  41 ms/frame"), and record it in `window.__ompoDeck`.
- `docs/deck-performance-budget.md` — updated with the harness numbers (app-level, per tier) and
  the failure thresholds.

### Explicit non-scope

No Web Workers, no WASM, no offscreen-canvas rendering, no GPU-timing queries (`EXT_disjoint_timer_query`
is unavailable under SwiftShader), no changes to the server's polling cadence (that is ompo core;
out of scope), no profiling of the existing dashboard.

### User-visible result

The deck holds its measured budget on this machine: the HUD reports fps within the tier's cap, the
operator is told when the deck downgraded itself and why, and the harness prints the numbers on
demand.

### Architecture changes

- The tier system gains a feedback loop (measure → downgrade) with explicit hysteresis; the
  operator's explicit choice always wins over the automatic one for the session.
- Frame budget, draw-call budget, instance caps and the downgrade thresholds live in one table
  (`TIER_BUDGETS`), referenced by the loop, the renderer and the harness — no duplicated constants.

### Data flow

```
deck-perf.ts → fixture server → ?surface=deck → injected activity driver
             → samples: frame ms (300), renderer.info counters, downgrade events
             → JSON/table  +  exit status vs TIER_BUDGETS
runtime: loop samples frame ms ─► tier controller ─► (downgrade once) ─► HUD + __ompoDeck.autoTier
```

### UI/UX behaviour

- A single, non-modal HUD chip on auto-downgrade; it never interrupts reading and never re-appears
  after dismissal within the session.
- The HUD always shows the *effective* tier (auto or pinned) and the tier's fps cap.
- No user-visible stutter policy: if the budget is violated while the operator is mid-interaction,
  the downgrade happens at the next idle frame (never mid-tween) to avoid a visible hitch.

### 3D behaviour

- No new visuals. Effects are the ones already defined; this slice may *remove* effects at
  `minimal` (e.g. tween length caps, instance caps, ribbon bucket caps) if measurements demand it —
  removal decisions must be recorded in the budget doc.

### Error behaviour

- Harness cannot launch a browser → exit 1 with the install hint (same rule as `d00`).
- Frame-time sampling under a hidden tab is meaningless → the harness keeps the page visible and
  asserts it (`document.visibilityState === "visible"`), failing loudly otherwise.
- Downgrade loop oscillation: prevented by hysteresis (downgrades only, and at most twice per
  session); a unit test covers the controller's state machine.

### Performance considerations

This slice **is** the enforcement. Concrete gates to pin (adjust in the doc if measurement says
otherwise, then freeze). Targets are set with ≥ 1.5× headroom over the best observed number from
`d00`, because observed frame times vary by ~40 % run to run on a software rasterizer:

| Tier | target resolution (css × scale) | median frame ≤ | p95 frame ≤ | fps cap | draw calls ≤ |
|---|---|---|---|---|---|
| minimal | 1280×720 × 0.5 | 33 ms | 45 ms | 30 | 24 |
| standard | 1280×720 × 1.0 | 16 ms | 25 ms | 60 | 48 |
| high | 1600×900 × 1.0 | 12 ms | 20 ms | 60 | 96 |

Idle: 0 frames rendered over any 2 s window with no state change, camera settled, and no pointer
movement.

### Testing

- `tests/deck-perf.test.ts` (unit): the tier controller state machine (downgrade after 60
  over-budget frames, never upgrade automatically, at most 2 downgrades, operator pin wins);
  coalescing math (N deltas in one frame); budget table completeness (every tier defines every
  field; thresholds ordered).
- `scripts/deck-perf.ts` (integration evidence, gated): for each tier, median/p95 within the table
  on this machine, or a recorded, explained deviation in the docs.
- `tests/e2e/deck.e2e.ts` (extend): 20 mount/unmount cycles return `geometries`/`textures` to
  baseline; the auto-downgrade path can be forced (tier pinned to `high` with a synthetic heavy
  fixture) and the HUD chip appears once.
- Manual: run the harness on the target machine, paste the table into the doc.

### Acceptance criteria

1. `bun scripts/deck-perf.ts` exits 0 on this machine with the `minimal` tier within budget, and
   prints the measured table (frame times + counters) as JSON.
2. 20 mount/unmount cycles leave `renderer.info` counters at baseline (no leak).
3. Idle behaviour: 0 frames over 2 s with a settled camera (asserted in the harness).
4. Forcing an over-budget tier triggers exactly one auto-downgrade with a HUD chip, and the
   operator's explicit pin afterwards is not overridden.
5. The budget doc contains the harness numbers and the exact command to reproduce.
6. Gates clean.

### Definition of done

- [ ] `scripts/deck-perf.ts` committed, gated, JSON-capable
- [ ] coalescing + disposal rules implemented and asserted
- [ ] auto-downgrade with hysteresis + HUD reporting
- [ ] budget table shared by loop/renderer/harness (no duplicated constants)
- [ ] doc updated with measured numbers
- [ ] gates green

Depends: d03v d04 d05
Effort: hi
Timeout: 60m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Verify: bun scripts/deck-perf.ts
Files: scripts/deck-perf.ts web/src/scene/loop.ts web/src/scene/renderer.ts web/src/scene/tier.ts web/src/scene/Deck.tsx docs/deck-performance-budget.md tests/deck-perf.test.ts tests/e2e/deck.e2e.ts

## [d11] Launcher and the `ompo --print-url` handshake

### Objective

Make the deck one command away in a chrome-less app window, and give any future desktop shell a
deterministic way to learn the dashboard's URL — with the smallest possible change to ompo core.

### Why this slice exists

Today `ompo --no-open` prints a human banner with the URL and nothing machine-readable, and the
port is auto-selected. Any shell (Tauri `d12`, a script, an editor integration) needs the URL
without screen-scraping. That is a real, small gap in the core; this slice closes it additively
behind a flag, ships the launcher that needs no Rust toolchain, and proves the deck is reachable as
a desktop-style window today.

### Prerequisites

`d01` — the deck surface exists at a URL.

### Scope

- `src/cli.ts` — add `--print-url` for the dashboard path: with the flag, stdout carries **exactly
  one line** `url=<url>` (flush, then nothing else), and the human banner (`ompo dashboard: …`,
  `press Ctrl-C to stop`) goes to **stderr**. Without the flag, behaviour is byte-identical to
  today. Update the `USAGE` block. No new command, no new endpoint.
- ✚ `scripts/deck-open.ts` — the launcher:
  1. spawn `ompo --no-open --print-url` (self-relaunch: compiled binary re-executes itself, source
     run re-invokes `bun src/cli.ts`, mirroring `resumeCommand()`'s existing pattern in
     `src/server.ts`),
  2. read the `url=` line with a bounded timeout (5 s) and a clear failure message,
  3. open `<url>/?surface=deck` in an app window: pure, tested
     `deckLaunchPlan(env, platformIndex) → { cmd, args }` preferring, in order,
     `$OMPO_DECK_BROWSER`, a Chromium-family binary with `--app=<url> --window-size=1600,1000`,
     Windows `msedge.exe` (interop), then a plain `xdg-open`/`open`/`start` fallback (a normal tab),
  4. forward SIGINT/SIGTERM: kill the spawned `ompo` and exit.
- `README.md` — a short "Deck" section: `bun scripts/deck-open.ts`, the `--print-url` contract, and
  the manual equivalent (`ompo --no-open --print-url` + `--app=`).
- `tests/release-gate.test.ts` (extend; it already spawns `bun src/cli.ts`) — assert the flag's
  contract: exactly one stdout line matching `^url=http://127\.0\.0\.1:\d+$`, stderr carrying the
  banner, exit 0 until terminated, and unchanged output when the flag is absent.
- ✚ unit tests for `deckLaunchPlan` (pure, no spawning).

### Explicit non-scope

No Tauri (that is `d12`), no installers, no autostart, no tray, no window-state persistence, no
changes to `ompo run`/`resume`/TUI paths, no new command name, no daemonization.

### User-visible result

`bun scripts/deck-open.ts` starts ompo and opens the deck in a chrome-less window; Ctrl-C in the
terminal (or closing the window) stops both. `ompo --no-open --print-url` prints a single
machine-readable line any script can consume.

### Architecture changes

- One additive CLI flag and one contract line: `url=<url>` on stdout. Everything else about the
  process model is unchanged (the server is still the same in-process `Bun.serve`; the loop still
  runs out-of-process).
- The launcher owns a child process: it must terminate it on every exit path (signal, error,
  browser-launch failure) — no orphaned servers, which is what makes it safe to run repeatedly.

### Data flow

```
scripts/deck-open.ts
  → spawn(ompo --no-open --print-url)            [self-relaunch: ./ompo | bun src/cli.ts]
  → stdout line "url=http://127.0.0.1:41237"     [≤ 5 s; else abort + kill child]
  → deckLaunchPlan(...) → chromium --app=http://127.0.0.1:41237/?surface=deck
  → on SIGINT/child-exit/browser-exit: kill child, exit 0
```

### UI/UX behaviour

- The launcher is quiet on success (one line: the URL) and loud on failure (what it tried, and the
  manual command to run instead).
- If the chosen browser is not an app-window capable one, say so once and open a normal tab rather
  than pretending.
- Closing the app window does not necessarily kill ompo (browser process semantics); the launcher
  therefore prints "stop: Ctrl-C" once. This is documented rather than hidden.

### 3D behaviour

None. The deck's own behaviour is unchanged; this slice only changes how it is opened.

### Error behaviour

- Port collision: the server already auto-selects a free port; `--print-url` reports the resolved
  one (no retry logic needed).
- No browser found: print the URL and the manual command, exit 1.
- `--print-url` combined with `--tui` or a non-dashboard command: the flag is ignored with a
  warning on stderr (documented; no crash).
- Child dies before printing: report the child's stderr tail and exit 1.

### Performance considerations

The launcher adds one process; it must not poll in a loop. It reads one line, then waits.

### Testing

- Unit: `deckLaunchPlan` picks `$OMPO_DECK_BROWSER` when set and executable; falls back through the
  ordered list using an injected "exists" predicate; builds `--app=<url>` args for chromium-family;
  builds a plain-URL fallback otherwise; every plan's `cmd` is absolute.
- `tests/release-gate.test.ts` (extended CLI contract tests described above).
- Manual: run `bun scripts/deck-open.ts` in the repo (a project with a run), confirm the window
  opens on the deck, then Ctrl-C and confirm no `ompo` process remains (`pgrep -f "src/cli.ts"`).

### Acceptance criteria

1. `ompo --no-open --print-url` prints exactly one stdout line matching
   `^url=http://127\.0\.0\.1:\d+$`, exits non-zero only on bind failure, and leaves stdout empty of
   anything else (the banner is on stderr).
2. Without `--print-url`, stdout/stderr are byte-identical to the current behaviour.
3. `bun scripts/deck-open.ts` opens `…/?surface=deck` and, on SIGINT, leaves no `ompo` process
   behind (asserted by the manual check above, which the slice report records).
4. `deckLaunchPlan` unit tests cover the ordered preference list and the args for each family.
5. Gates clean.

### Definition of done

- [ ] `--print-url` implemented, documented in `USAGE`, covered by CLI-level tests
- [ ] `scripts/deck-open.ts` + pure `deckLaunchPlan` + unit tests
- [ ] child-process cleanup on all exit paths
- [ ] README "Deck" section
- [ ] manual no-orphan check recorded in the slice report
- [ ] gates green

Depends: d03v
Effort: med
Timeout: 45m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: test -f scripts/deck-open.ts
Files: src/cli.ts scripts/deck-open.ts README.md tests/release-gate.test.ts tests/deck-launch.test.ts

## [d12] Tauri 2 desktop shell (Windows-first)

### Objective

Ship the deck as a desktop application: a WebView2 window pointed at the ompo URL, with the ompo
server managed as a sidecar, minimal OS permissions, and an honest platform matrix.

### Why this slice exists

The brief asks for a desktop shell and requires the boundary to be justified rather than assumed.
This slice is that justification made concrete: the shell is packaging (window + child process),
not a data path. CP-5 fixes the boundary; the measured environment fixes the first platform —
this WSL has **no Rust toolchain and no `libwebkit2gtk-4.1`**, and its WebGL is software-rendered,
while the Windows side has the WebView2 runtime installed (`152.0.4191.66`). Building the shell
for Linux/WSL first would mean shipping the 3D surface on the slowest available renderer behind a
toolchain that does not exist here.

### Prerequisites

`d11` — the `--print-url` handshake and the launcher (the shell depends on the same contract).

### Scope

- ✚ `desktop/` — the Tauri 2 application:
  - `desktop/src-tauri/Cargo.toml`, `tauri.conf.json`, `build.rs`, `src/main.rs`,
    `capabilities/default.json`, `icons/` (placeholder app icon).
  - `main.rs` responsibilities, in order: resolve the sidecar path; spawn
    `ompo --no-open --print-url` with the project directory as cwd (default: the directory the app
    was launched from, overridable by `OMPO_PROJECT`); read the single `url=` line with a 5 s
    timeout; build one `WebviewWindowBuilder` with `WebviewUrl::External("<url>/?surface=deck")`
    (1600×1000, min 900×600); on window close / app exit, terminate the child and wait for it.
  - **No single-instance plugin.** A second launch is harmless (the server is read-only plus
    lock-guarded control); this is documented instead of adding a dependency.
  - Capabilities are minimal and asserted: `core:default` plus `shell:allow-execute` scoped to the
    sidecar; **no** `fs`, `http`, `dialog`, `process` beyond the sidecar, no remote URL permissions.
  - The shell does **not** bundle the SPA: the webview loads the server's own assets, so there is no
    duplicated build, no second asset pipeline, and no drift between what the shell shows and what
    the browser shows.
- ✚ `scripts/deck-desktop-check.ts` — a dependency-free static verifier (runs in this environment,
  no Rust): parses `tauri.conf.json`, asserts the window/URL settings and the sidecar wiring;
  parses `capabilities/default.json`, asserts the permission allow-list contains no `fs`/`http`/
  `dialog` entries; asserts `main.rs` imports the sidecar URL from the child's stdout (the
  `--print-url` contract) and contains no `.omp/` path handling; exits 1 with a specific message on
  each violation.
- `package.json` scripts: `deck:desktop:dev` and `deck:desktop:build` (thin wrappers over
  `bunx tauri dev|build` with `cwd=desktop`), and `deck:desktop:check` (`bun scripts/deck-desktop-check.ts`).
- ✚ `desktop/README.md` — platform matrix and prerequisites: Windows 11 x64 (WebView2, bundled
  `ompo.exe` sidecar) is the supported target in this slice; Linux requires
  `libwebkit2gtk-4.1-dev` + Rust and is **expected to be software-rendered** under WSLg;
  macOS is untested and says so.
- Root `.gitignore` — `desktop/src-tauri/target/`, `desktop/src-tauri/gen/`.

### Explicit non-scope

No auto-updater, no code signing / notarization, no installers beyond `tauri build` defaults, no
tray, no menus, no deep links, no file associations, no notifications, no Tauri plugins beyond the
core capability set, no Rust-side reading of `.omp/`, no Linux/macOS packaging in this slice, no
auto-installation of the Rust toolchain (the scripts must fail with instructions instead).

### User-visible result

On Windows, `bun run deck:desktop:dev` opens the deck in a desktop window with no browser chrome,
spawns its own ompo server, and leaves no process behind when closed. `deck:desktop:build` produces
an installer/binary via Tauri's defaults.

### Architecture changes

- The shell adds exactly one OS-level capability: spawning and reaping one child process.
- The `--print-url` contract from `d11` becomes load-bearing for two consumers (launcher, shell) —
  its CLI tests are therefore part of this slice's review checklist.
- Zero new web/runtime dependencies in `web/src`; `@tauri-apps/cli` and `@tauri-apps/api` are
  repo-level dev/runtime deps for the desktop package only.

### Data flow

```
desktop app start
  → spawn ./ompo --no-open --print-url            (sidecar; cwd = project dir)
  → stdout "url=http://127.0.0.1:<port>"          (5 s budget)
  → WebviewWindowBuilder(url + "/?surface=deck")  → webview loads the SPA from the server
  → window close → kill child → wait → exit
```

### UI/UX behaviour

- One window, no browser chrome, standard minimise/maximise/close, remembered size is **not**
  implemented (explicitly deferred; window state is a convenience, not a capability).
- If the sidecar fails to start (or prints no `url=` line within 5 s), the app opens a single
  small error window containing the child's stderr tail and the exact terminal command that
  reproduces the failure. The rendering mechanism for that error document is the slice's choice
  (a minimal bundled HTML page or an `initialization_script` overlay) — what is fixed is the
  content: what failed, why, and how to reproduce it outside the shell.
- Closing the window stops the sidecar; if the sidecar was killed externally, the window shows
  "ompo stopped" with a restart affordance (restart = respawn sidecar + reload the URL).

### 3D behaviour

Unchanged from the browser surface: identical bundle, identical tier logic, identical budgets. The
webview is expected to provide hardware acceleration on Windows (WebView2 with D3D11/ANGLE);
under WebKitGTK/WSLg the `minimal` tier and `d09`'s flat mode are the expected outcomes, and the
tier probe will select accordingly without any shell-specific code.

### Error behaviour

- No Rust/`tauri` CLI: `deck:desktop:*` scripts print the prerequisite and exit 1 (never attempt an
  unattended toolchain install).
- Sidecar timeout: error window with stderr tail.
- Sidecar exits later: "ompo stopped" state with restart; no silent dead window.
- Orphan prevention: the child is killed on window close, app exit and panic (Rust `Drop` guard).

### Performance considerations

- The shell adds no rendering work; the only cost is the webview process itself.
- Measured: **not on this machine** — the slice's Windows acceptance must record the renderer string
  and the `d10` harness numbers from the shell's own webview (`window.__ompoDeck.tier` +
  `bun scripts/deck-perf.ts` pointed at the shell's URL) so the tier selection is verified where the
  hardware actually is.

### Testing

- `bun scripts/deck-desktop-check.ts` (gated): the static verification described above.
- Rust: if the toolchain is present, `cargo test` in `desktop/src-tauri` covers the URL-parsing and
  child-cleanup helpers; if it is absent, the slice report must say the Rust tests were not executed
  in this environment and name exactly what a Windows-side operator must run.
- Manual (Windows, required before `d14`): dev run, close-cleanup check (`tasklist` shows no
  `ompo.exe`), sidecar-kill recovery, and the tier/harness numbers recorded in the slice report.
- Regression: `bun run web:build`, `bun test`, `bun run test:e2e` unaffected (the shell does not
  touch `web/`).

### Acceptance criteria

1. `bun scripts/deck-desktop-check.ts` exits 0 on the committed configuration: window URL derived
   from the sidecar's `url=` line, capabilities listing no `fs`/`http`/`dialog`, sidecar wiring
   present, and no `.omp/` path handling in `main.rs`.
2. `deck:desktop:dev` / `deck:desktop:build` fail with actionable instructions when Rust or Tauri is
   missing, and never attempt an install.
3. On Windows: the app opens the deck at `?surface=deck`, the window's renderer string and tier are
   recorded, and closing the window leaves no `ompo` process running (evidence in the slice report).
4. The shell bundles no copy of the SPA: the built app's resources contain no `index.html`/`assets/`
   from `web/dist` (asserted by the static checker against `tauri.conf.json`'s bundle config).
5. The web surface is unchanged: the same tests pass with and without `desktop/` present.
6. Gates clean.

### Definition of done

- [ ] `desktop/` committed with the minimal capability set and the sidecar lifecycle
- [ ] `scripts/deck-desktop-check.ts` gated and passing
- [ ] `desktop/README.md` platform matrix (Windows supported; Linux prerequisites; macOS untested)
- [ ] `.gitignore` entries for `target/` and `gen/`
- [ ] Windows manual evidence recorded, or explicitly reported as not-run in this environment
- [ ] gates green

Depends: d11
Effort: hi
Timeout: 60m
Retries: 2
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun scripts/deck-desktop-check.ts
Verify: test -f desktop/src-tauri/tauri.conf.json
Files: desktop/src-tauri/Cargo.toml desktop/src-tauri/tauri.conf.json desktop/src-tauri/build.rs desktop/src-tauri/src/main.rs desktop/src-tauri/capabilities/default.json desktop/README.md scripts/deck-desktop-check.ts package.json .gitignore

## [d13] Expression pass: ambient world, completion, choreography

### Objective

Make the deck feel like a place rather than a diagram — ambient environment, satisfying completion
states, and camera choreography — without breaking a single budget, without adding a data source,
and with every effect individually switchable.

### Why this slice exists

The brief is explicit that the project should end expressive, not merely functional, and equally
explicit that polish must not come first. This slice is last among the feature slices for that
reason: it is the only slice allowed to touch materials, ambient geometry and choreography, and it
operates entirely on data the earlier slices already model. Nothing here may introduce information.

### Prerequisites

`d05` (transitions/alerts), `d10` (budget enforcement — this slice must be measured against it).

### Scope

- ✚ `web/src/scene/ambient.ts` — pure description of ambient elements as data (grid fade profile,
  fog colour/density from existing tokens, parallax parameters, dust-free "no particles" rule)
  consumed by the renderer; `ambientEnabled(tier, prefs)`.
- `web/src/scene/renderer.ts` — ambient rendering at `high`/`standard` only, using **geometry and
  colour, not shaders or full-screen passes**: a finitely sized floor grid (line segments, 1 draw
  call), distance fog via material parameters, a subtle scene-space parallax driven by camera
  movement (never a continuous idle animation).
- Completion language: a slice reaching `done` gets a short settle animation (pad cap closing,
  ≤ 400 ms), the run reaching all-`done` produces a one-time deck-level state (HUD line
  `run complete · N slices · <duration>`) — derived from `counts`, never a new source.
- Camera choreography: preset transitions eased over ≤ 450 ms; focus framing drift (a slow,
  bounded drift while a worker is live, ≤ 0.5 units, disabled at `minimal` and under reduced
  motion); a camera "return to rail" when the run goes quiescent.
- Material language: one table mapping `SliceStatus` → (colour token, roughness/metalness, height,
  cap shape), replacing any per-slice special-casing introduced earlier; colours derived from
  `tokens.css` values exactly once in `scene/palette.ts` (pure, tested).
- Settings panel (DOM, opened from the HUD): every effect listed with an on/off toggle and its tier
  requirement, persisted in deck prefs; "all effects off" must produce a visually plain but fully
  functional deck.
- Effect budget table appended to `docs/deck-performance-budget.md`: per effect — tier requirement,
  cost class (draw call / triangles / CPU), max concurrent instances, and the measurement that
  justified it.

### Explicit non-scope

**No shaders, no post-processing, no particles, no textures, no imported 3D assets, no sound, no
IK/skeletal animation, no custom GLSL.** Ambient must be expressible with instanced primitives,
lines and material parameters. Also out of scope: any effect that changes layout (CP-7 stands),
any effect that hides information, and any effect without an off switch.

### User-visible result

The deck reads as an operational environment: a quiet floor and fog give the rail depth, a
completed slice visibly settles, finishing a run feels finished, and the camera moves as a
considered transition rather than a jump — with all of it adjustable and none of it required.

### Architecture changes

- `palette.ts` is the single conversion point from CSS tokens to scene colours (used by rail,
  stations, beacons, ambient) — no colour literals anywhere else in `scene/**`.
- Ambient is data (`ambient.ts`), so its parameters are unit-testable and its enablement is a pure
  function of `(tier, prefs)`.
- The settings panel is the first deck UI written from `DECK_KEYS`/prefs rather than from model
  data; it must remain view-only (no domain state).

### Data flow

```
tokens.css (design system) ─► palette.ts (pure) ─► DeckModel colours ─► renderer materials
counts/status ─► completion states (model-derived; no new source)
ambient.ts + tier + prefs ─► ambientEnabled ─► renderer ambient pass (≤ 2 draw calls)
settings panel ─► prefs (localStorage) ─► same gate
```

### UI/UX behaviour

- Every effect has an off switch; toggling one takes effect within one frame and never resets the
  camera or the selection.
- The completion moment is informative, not celebratory: it states slice count, duration and any
  deferred/blocked items (from the existing DTOs), and it disappears on the next run activity.
- Ambient never reduces text contrast: the DOM overlay sits above the canvas with its own
  background; no effect may tint the overlay.

### 3D behaviour

- Idle decks render **zero** frames: ambient parallax responds to camera movement, never to a
  timer. This is the single most important constraint of this slice.
- Draw-call ceiling: ambient adds ≤ 2 draw calls at `standard`, ≤ 0 at `minimal`.
- Completion animation ≤ 400 ms, one object at a time, coalesced when many slices finish together.

### Error behaviour

- Effect errors must degrade to "effect off" (try/catch around optional passes, logged at debug),
  never break the scene.
- A tier downgrade (`d10`) mid-effect disables tier-unsupported effects for the session and says so
  once in the HUD.

### Performance considerations

- Re-run `scripts/deck-perf.ts` with effects on, at every tier; the budget table gains an "effects
  on" row. Any tier that fails its budget with effects on must ship that effect disabled by default
  for that tier.
- No frame-time regression at `minimal` (target: identical numbers to `d10`, since ambient is off).
- Memory: ambient must not allocate per frame (pre-allocated buffers only).

### Testing

- `tests/deck-palette.test.ts` (pure): every `SliceStatus` maps to a palette entry; palette values
  are valid hex/rgb and match the token values (parsed from `tokens.css` at test time — a real
  coupling test, so a token rename cannot silently desync); no colour literal exists in
  `scene/**` outside `palette.ts` (source scan in the release-gate style).
- `tests/deck-ambient.test.ts` (pure): `ambientEnabled` matrix (tier × reduced motion × prefs);
  effect registry completeness (every effect has an id, a tier, an off switch, a description).
- `tests/e2e/deck.e2e.ts` (extend): all effects off → the deck is still fully functional (a scripted
  walkthrough); reduced motion → no tween/ambient motion; the settings panel persists across a
  reload.
- Manual: capture before/after screenshots at each tier (`scripts/deck-captures.ts` lands in `d14`);
  record frame numbers with effects on.

### Acceptance criteria

1. Effects on at the operator's tier change no acceptance criterion of `d03`–`d09`: every
   functionality test still passes with the settings panel set to all-on.
2. Idle with ambient enabled renders 0 frames over 2 s (camera settled).
3. `scripts/deck-perf.ts` passes at every tier with that tier's default effect set.
4. Toggling any single effect never moves the camera, changes the selection, or re-creates scene
   objects (`geometries`/`objects` counters unchanged).
5. No colour literal exists in `scene/**` outside `palette.ts` (asserted).
6. Gates clean.

### Definition of done

- [ ] `ambient.ts`, `palette.ts` pure + tested; effect registry with off switches
- [ ] completion language derived from existing DTOs only
- [ ] choreography bounded and disabled under reduced motion / `minimal`
- [ ] effect budget table appended to the budget doc with measurements
- [ ] all functionality tests pass with effects on
- [ ] gates green

Depends: d03v d05 d10
Effort: med
Timeout: 60m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Verify: bun scripts/deck-perf.ts
Files: web/src/scene/ambient.ts web/src/scene/palette.ts web/src/scene/renderer.ts web/src/scene/model.ts web/src/scene/DeckOverlay.tsx docs/deck-performance-budget.md tests/deck-ambient.test.ts tests/deck-palette.test.ts tests/e2e/deck.e2e.ts

## [d14] Operability, docs, evidence, and release gate

### Objective

Make the deck reviewable, documentable and removable: as-built architecture notes, operator
documentation, captured evidence, a regression sweep across every existing surface, and a proof
that ompo survives without the deck.

### Why this slice exists

Every feature in this repository ships with its operator surface (`docs/development-prd.md` §10) and
with the evidence a reviewer needs. The deck is the largest optional subsystem this project has
ever added; it must therefore ship with (a) a written boundary, (b) reproducible evidence, and
(c) a demonstrated exit — the brief's final quality bar asks explicitly whether ompo survives
cleanly if the 3D experiment fails.

### Prerequisites

`d12`, `d13`.

### Scope

- ✚ `docs/deck-architecture.md` — the as-built sibling of `docs/web-dashboard-architecture.md`:
  module map, the CP-1…CP-8 decisions with their evidence, the data flow, the tier/budget table,
  the endpoint set the deck consumes (and the statement that it adds none), the surface-selector
  contract, deck prefs keys, and the "rules enforced by tests" table from §B.4.
- `README.md` — a "Deck" section: what it is, how to open it (query param, header toggle, launcher,
  desktop shell), the `--print-url` contract, the fallback behaviour, the platform matrix pointer,
  and one honest paragraph on when the dashboard is the better tool.
- ✚ `scripts/deck-captures.ts` — evidence generator mirroring `scripts/web-captures.ts`: screenshots
  of the deck at each tier, flat mode, reduced motion, inspector open, alert stack with a failed
  slice, multi-worker fixture, and the history wall; writes into `captures/` with deterministic
  names (`deck-*.png`) and a `captures/deck-qa.json` summary of the assertions it checked.
- Regression sweep (evidence in the slice report):
  `bunx tsc --noEmit`, `bun test`, `bun run test:e2e`, `bun scripts/deck-perf.ts`,
  `bun scripts/gen-captures.ts` (TUI captures unchanged), `bun run web:build`,
  `bun build --compile src/cli.ts --outfile /tmp/ompo-deck-smoke`, plus a manual pass of
  `ompo --tui`, `ompo run --dry-run`, `ompo status`, `ompo show <slice>`, `ompo log --format tap`.
- **Removability proof** — documented and tested: the deck's entire surface area outside
  `web/src/scene/**` is (1) one lazy import + one prop block in `App.tsx`, (2) one toggle in
  `Header.tsx`, (3) the `?surface=` read, (4) `d11`/`d12` artifacts. A test asserts that no file
  outside that list references `scene/` (source scan), so "delete the deck" is provably a
  three-file revert plus optional deletions.
- Final honesty section in `docs/deck-architecture.md`: for which tasks the deck is better than the
  dashboard (spatial scanning of a live multi-worker run, transitions, history), for which it is
  worse (dense textual forensics, small windows, weak GPUs), and what was deliberately not built.

### Explicit non-scope

No new features, no refactors of existing modules, no changes to the server, no new endpoints, no
performance work beyond re-measurement, no upstream packaging changes, no edits to
`docs/web-dashboard-*.md` beyond cross-links.

### User-visible result

An operator (or a future maintainer) can read what the deck is, open it three ways, see captured
evidence of every state, reproduce the performance numbers, and remove the whole subsystem without
touching ompo's core.

### Architecture changes

None — this slice documents and freezes what exists. Any code change here is a bug fix discovered
by the sweep, and must be reported as such.

### Data flow

Not applicable (documentation and evidence).

### UI/UX behaviour

Not applicable beyond the documentation's accuracy: every claim about a key, a fallback or a
platform must match the shipped behaviour (checked in review against `DECK_KEYS` and the tests).

### 3D behaviour

Captured, not altered: the screenshots in `captures/deck-*.png` are the visual record, and the
budget doc remains the performance record.

### Error behaviour

Not applicable; the sweep exists to catch regressions, and any failure found must be fixed (or
reported as a blocking defect) rather than documented away.

### Performance considerations

Re-run and record: the `d10` harness numbers at each tier on this machine, plus the compiled
binary's size delta caused by the embedded deck chunk (report both numbers in
`docs/deck-architecture.md`).

### Testing

- The full regression sweep listed above, with each command's result recorded in the slice report.
- Source-scan tests: no reference to `scene/` outside the four allowed touchpoints; no colour
  literals outside `palette.ts` (inherited from `d13`); the release-gate architecture lock still
  passes unchanged.
- Review checklist (for the human or agent reviewing this slice): does the deck work, does it
  integrate through existing interfaces, is existing behaviour preserved, is the architecture still
  clean, are tests present, is performance acceptable, did business logic leak into the UI, were
  unnecessary dependencies added, did the TUI/dashboard break.

### Acceptance criteria

1. `docs/deck-architecture.md` exists, states the CP decisions and the enforced rules, lists the
   consumed endpoints, and contains no claim contradicted by the tree.
2. `captures/deck-*.png` + `captures/deck-qa.json` regenerate on demand with documented commands.
3. The full regression sweep passes, and the report records each command's outcome verbatim.
4. The removability test passes: no file outside the four touchpoints references `scene/`.
5. `bun build --compile` produces a working binary that serves both surfaces, with the size delta
   recorded.
6. The honesty section names at least one workflow the deck is worse at, with the reason.

### Definition of done

- [ ] `docs/deck-architecture.md` committed
- [ ] README "Deck" section committed
- [ ] `scripts/deck-captures.ts` + regenerated captures committed
- [ ] regression sweep recorded in the slice report
- [ ] removability assertion added and passing
- [ ] binary size delta + tier measurements recorded
- [ ] gates green

Depends: d12 d13
Effort: med
Timeout: 60m
Retries: 1
Verify: bunx tsc --noEmit
Verify: bun test
Verify: git diff --check
Verify: bun run test:e2e
Verify: bun scripts/deck-perf.ts
Verify: bun run web:build
Verify: test -f docs/deck-architecture.md
Files: docs/deck-architecture.md README.md scripts/deck-captures.ts captures tests/release-gate.test.ts tests/e2e/deck.e2e.ts
