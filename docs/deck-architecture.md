# Deck architecture (as-built, roadmap `d14`)

Doc-only slice. No runtime behaviour changes. This note is the sibling of
`docs/web-dashboard-architecture.md`: it maps what the deck is, where it
lives, what it may read, what it may never do, and how to remove it. Every
claim names the file that proves it; anything without a file is marked
`[INFERENCE]`.

The deck is a **projection** of state ompo already produces. It adds no
orchestrator, no state model, no transport, no persistence, no endpoint, and
no server route. The durable store stays the only interface between the loop
and any UI (`docs/web-dashboard-architecture.md` §1); the deck reads it
through the same HTTP+SSE read model the dashboard reads.

## 1. What the deck is, and is not

- A spatial operator surface over a running ompo run: a roadmap rail (one pad
  per slice), live-worker stations, dependency edges, an event ribbon, a run
  wall, a bounded live window, alerts, an inspection dock, and control at the
  selection — at `?surface=deck` (`web/src/App.tsx:43-45`).
- A **lazy chunk**. `App.tsx:39` is the only production import of the scene
  (`const Deck = lazy(() => import("./scene/Deck.tsx"))`); the dashboard
  shell pays nothing for it until the surface is asked for (§10).
- **Not** a second dashboard. Diff views, gate/verify tails, review
  findings, prompts, raw logs, the event query DSL, run/stat tables, plan
  preview, control confirmations, the stale-bundle banner, and every error
  message stay boring 2D UI inside the dock's `Inspector` — the deck renders
  the dashboard's own components there, never re-implements them
  (`web/src/scene/DeckInspector.tsx:1-22`).
- **Not** a data path. `scene/**` fetches nothing and owns no store
  (§5, §7). The Tauri shell (`desktop/`) is packaging around the same URL,
  not a second reader (`desktop/README.md`).

## 2. Module map (as-built; all paths repo-relative)

`web/src/scene/` owns the surface. Pure means no DOM, no `three`, no clock,
no fetch — unit-testable without a browser.

| File | Slice | Kind | Job |
|---|---|---|---|
| `types.ts` | d01–d13 | contracts | `DeckModel`/`DeckInput`/`DeckProps`, `DeckPrefs` + `parseDeckPrefs`, `DECK_PREFS_KEY`, `DECK_KEYS` (17 rows), `RenderStats`, `DeckDebugHook` (`window.__ompoDeck`) |
| `tier.ts` | d00/d10 | pure | `TIER_BUDGETS`, `TIER_ORDER`, `classifyRenderer`, `createTierController` (60-frame window, ≤ 2 demotions, never up, never below minimal) |
| `loop.ts` | d01 | pure | `createFrameLoop`: on-demand frames, `maxFps` timestamp gate, hidden-document stop |
| `rail.ts` | d02 | pure | `railPositions` (layout → world, status-independent), `railBounds`, `railFraming`, `gridPlan`, ribbon/tile geometry, `RIBBON_MAX_BARS = 48`, `GRID_CELL = 5`, ≤ 64 divisions |
| `model.ts` | d02–d04/d07 | pure | `buildDeckModel`: DTOs in, immutable `DeckModel` out; `HISTORY_TILE_CAP = 24`; live + historical cursor through one layout/digest |
| `focus.ts` | d03 | pure | `liveSliceIds`, `focusTarget`, `nextLiveId`, `SHAFT_SEGMENTS = 4` station marks |
| `camera.ts` | d03 | pure | `CameraState`, `applyCameraIntent`, `lerpCamera`, `visibleSliceIds`, `edgeAnchor`, off-screen markers |
| `lanes.ts` | d04 | pure | `stationSlots` (projection decides slots, so scene/HUD/lanes agree), overflow count |
| `alerts.ts` | d05 | pure | `deriveAlerts`, `dismissKey`, `activeAlerts`, `DISMISSED_KEY = "ompo.deck.dismissed"`, `DISMISSED_CAP = 200` |
| `deltas.ts` | d05 | pure | `diffModels`/`sceneDeltas`: state first, cue second; first paint and run switches yield no cues |
| `history.ts` | d07 | pure | `buildHistoryIndex`, `attemptSegments`, `RIBBON_MAX_BUCKETS = 120` time buckets |
| `dock.ts` | d06 | pure | `DockState`, `dockTabForKey` (`1`…`8` by `INSPECTOR_TABS` position), open-on-tab, new-subject → Output, new-run → closed |
| `fallback.ts` | d09 | pure | `deckAvailability` (3d/flat), `nextDeckMode`/`deckMode` (`auto/minimal/standard/high/flat`), `flatRows`/`flatRowLabel`/`focusMirrorText` |
| `roving.ts` | d09 | React | `useRovingFocus`: one tab stop for the pad list, arrows/Home/End move it |
| `instrument.ts` | d01 | stateful | `instrument`: 1 s sampler, 3000-frame ring, 512-latency ring, per-stage `model`/`scene` marks, dock interaction latencies; `window.__ompoDeck.instrument.snapshot()` is what `scripts/deck-perf.ts` and the e2e read |
| `palette.ts` | d13 | pure | the **single** CSS-token → scene-colour conversion (`PALETTE_TOKENS`, `parseColour`/`blendOver`/`mixColours`, `readPalette` is the one DOM read) |
| `ambient.ts` | d13 | pure | `AMBIENT_EFFECTS` registry (5 effects), `ambientEnabled` gate, `defaultOn`/`blockedReason`/`ambientRows`/`sanitizeEffects`/`toggleEffect`, `fogPlan`/`parallaxOffset`/`driftOffset`, `SETTLE_MAX = 4`, `SETTLE_MS = 400` |
| `renderer.ts` | d01–d05/d13 | `three` | the **only** module importing `three`; owns the scene graph, diff-applies `DeckModel`, `setCamera`/`setHover`/`pick`/`project`, `setAmbient`, `dispose` + `forceContextLoss` |
| `Deck.tsx` | d01 | React boundary | reads prefs, probes tier, owns renderer + loop lifecycle, projects props → `DeckModel`, canvas + overlay; fetches nothing |
| `DeckOverlay.tsx` | d03 | DOM | station line, lane strip, selected line, bounded live window (the dashboard's `LiveFeed`), alert stack, time band + ribbon strip, wall list, pad mirror, control bar slot |
| `DeckInspector.tsx` | d06 | DOM | the dock frame: renders the dashboard's own `Inspector` with identical props/endpoints/caps |
| `HistoryWall.tsx` | d07 | DOM | run list (`WALL_ROWS = 20` before "show all"), read-only run switching via the shell's `openRun` |
| `ControlBar.tsx` | d08 | DOM | deck control at the selection: `lib/control.ts` bodies + `DESTRUCTIVE` confirm + queued/direct outcomes; disabled at a recorded cursor |
| `FlatDeck.tsx` | d09 | DOM | flat projection over the same `DeckModel`: the dashboard's `SliceTable` + `WorkerLanes` + `flatRows` pad list |

Reuse, not re-derivation (M1): layout (`lib/dag.ts`), ranking
(`lib/selection.ts`), pipeline (`lib/pipeline.ts`), live window
(`lib/stream.ts`, `useLiveStream`/`useSliceLog`), lanes/events/timeline
(`lib/events.ts`, `lib/timeline.ts`), control semantics
(`lib/control.ts`), and the views (`LiveFeed`, `Inspector`,
`ControlPanel`, `SliceTable`, `StatusBadge`, `WorkerLanes`) are the
dashboard's. The deck joins them; it never re-derives slice/agent state
(asserted, §7).

## 3. CP-1…CP-8 as built (decision, evidence, trigger)

- **CP-1 — the deck lives in `web/src/scene/**` as a lazy chunk.**
  `App.tsx:39` + `App.tsx:359-388` (Suspense + `DeckBoundary` fallback to the
  dashboard). Reconsider if the deck chunk exceeds ~2 MB gzipped
  (§10: it is 625 KB raw / 162 KB gzip — nowhere near).
- **CP-2 — `three@0.186.0` imperative, no react-three-fiber.**
  `renderer.ts:25` is the one `three` import (asserted §7); pinned in
  `package.json`. Reconsider only for genuinely heterogeneous interactive 3D
  widgets.
- **CP-3 — all text in the DOM; the canvas draws geometry.**
  No `TextGeometry`/SDF/`CSS3DRenderer`/canvas-texture prose anywhere under
  `scene/`; labels, live window, alerts, dock, HUD are React DOM over the
  canvas (`Deck.tsx:1903-1923`, `DeckOverlay.tsx`). Reconsider only for labels
  that must be occluded by geometry (prefer projected DOM labels first).
- **CP-4 — reuse the HTTP+SSE read model and existing React state.**
  `App.tsx` owns fetch/SSE/polling; the deck receives props + intent
  callbacks (`DeckProps`, `types.ts:476-521`). No new endpoints (§5), no
  WebSocket (asserted §7), no client store. Reconsider only on measured
  > 2 s median transcript lag (then: filtered SSE params / focused-slice poll
  interval — still HTTP).
- **CP-5 — the shell loads the ompo URL; packaging, not a data path.**
  One window at `<url>/?surface=deck`; sidecar `ompo --no-open --print-url`;
  kill on close/exit/`Drop`; zero `#[tauri::command]`s
  (`desktop/src-tauri/src/main.rs`, `desktop/README.md`). The
  `chrome --app=` launcher (`scripts/deck-open.ts`) is the zero-toolchain
  path and stays supported. Reconsider (drop Tauri) if the shell shows no
  capability the launcher lacks.
- **CP-6 — tier for a software rasterizer; on-demand loop.**
  `classifyRenderer` (software → `minimal`, else `standard`, never `high`),
  `createTierController` demotes on a full 60-frame over-budget median,
  `createFrameLoop` renders zero frames while settled. Numbers in §6;
  method + re-measure in `docs/deck-performance-budget.md`.
- **CP-7 — pure model; camera is view state; layout never reflows.**
  `buildDeckModel` is deterministic (same input → `JSON.stringify`-equal);
  `railPositions` depends on roadmap structure only; camera is a separate
  reducer (`camera.ts`). Asserted by the five-permutation stability test
  (`tests/deck-model.test.ts:249-260`) and the digest early-out.
- **CP-8 — one runtime dependency.**
  `three@0.186.0` (lazy chunk, zero transitive deps) + `@types/three`
  (dev). Rejected: r3f/drei, stores/routers, troika, postprocessing,
  loaders, `ws`/`socket.io`, Tauri plugins beyond sidecar spawn, electron,
  d3, force-graph, framer-motion. (`@tauri-apps/cli` is build tooling for
  `desktop/` only, never imported by `web/src`.)

## 4. Data flow

```
store (.omp/roadmap/runs/<id>/{roadmap.json, events.jsonl, slices/})
  → server DTOs (RunSummary/RunDetail/SliceSummary/SliceDetail/AgentRow/RunEvent/…)
  → App.tsx fetch/SSE/poll (shell owns all I/O)
  → props → buildDeckModel → DeckModel → renderer.applyModel + overlay DOM
control: ControlBar / dock ControlPanel → POST …/control|resume|restart-loop
  → store (queue or direct) → SSE event → shell refetch → new model
```

Cadences (all pre-existing; the deck invents none): server store poll
900 ms (`src/server.ts:43`), SSE heartbeat 15 s / `idleTimeout` 60 s; client
SSE with `afterSeq`/`Last-Event-ID` replay + 900 ms polling fallback
(`App.tsx:16,220-283`); runs list 5 s; sessions/agents 10 s; slice log tails
2 s (`useSliceLog`); HUD readout 250 ms (`Deck.tsx:63`); history playback
320 ms per bucket (`Deck.tsx:76`).

Bounds: event pages ≤ 2000 (`TIMELINE_PAGE`, two requests worst case);
live tail `LIVE_TAIL = 400`; log tails ≤ 500; diffs ≤ 20000 chars; timeline
kept ≤ 2000 with a `truncated` flag; ribbon ≤ 120 buckets → ≤ 48 bars;
wall tiles ≤ 24 drawn (DOM lists all); dismissals ≤ 200; settles ≤ 4 ×
400 ms; stations ≤ tier cap (8/16/32) + 4 stack marks.

## 5. Endpoints the deck consumes (it adds none)

No server route mentions the deck: `?surface=deck` is client-only
(`initialSurface`, `App.tsx:43-45`); unknown non-`/api` paths serve the SPA
shell (`src/server.ts:1420-1433`). The deck surface can cause exactly these
existing calls — shell-owned unless noted:

| Endpoint | Fetched by | Why |
|---|---|---|
| `GET /api/health` | shell | stale-bundle banner (both surfaces) |
| `GET /api/runs` | shell (5 s) | history wall tiles + DOM run list |
| `GET /api/runs/:id` | shell (load + per-event targeted refresh) | the model + dock subject |
| `GET /api/runs/:id/events` | shell (load, poll fallback, timeline paging) + dock Events tab (slice-filtered) | live tail, temporal window, per-slice events |
| `GET /api/runs/:id/events/stream` (SSE; `/stream` alias) | shell (one `EventSource` per run) | live updates; reconnect replays from last seq |
| `GET /api/runs/:id/slices/:sid` | shell (selection) | focused station stage, dock subject |
| `GET /api/runs/:id/slices/:sid/log` | live window (`useLiveStream`, tail 400), dock Log tab (100), Review auditing signal (80) | bounded tails, 2 s poll while active |
| `GET /api/runs/:id/slices/:sid/diff` | dock Diff tab | branch vs merge-base, capped |
| `GET /api/runs/:id/agents` | shell (load + 10 s) | stations, wedged/stall signals |
| `GET /api/runs/:id/sessions` | shell (load + 10 s) | run markers the model joins (deck shows no session UI of its own) |
| `GET /api/runs/:id/stats` | shell (load) | `StatsPage`; fetched on the deck surface too because the shell loads it, not because the deck reads it |
| `GET /api/runs/:id/replay` | explicit `Verify replay` button (time band) | server's own cursor comparison, rendered as text |
| `POST /api/runs/:id/control` | deck ControlBar + dock `ControlPanel` | retry/skip/park/kill/pause/resume/set-jobs with the exact `ctl` semantics |
| `POST /api/runs/:id/resume` | ControlBar + `ControlPanel` | detached resume for quiescent runs |
| `POST /api/runs/:id/restart-loop` | ControlBar + `ControlPanel` | wedged-loop kill + fresh resume (reason required) |

Not consumed from the deck path: `…/query` and `/api/plan/*`
(`StatsPage`/`RoadmapPage` only), `…/sessions/:name/log` (Overview
`SessionsPanel` only). The dock opens no request outside this set
(`tests/e2e/deck-inspector.e2e.ts` scenario 2), and the deck opens no second
event stream (`scripts/deck-perf.ts` "one stream" check).

## 6. Tier, budget, and effect tables

Frozen tier table (`web/src/scene/tier.ts:48-82`; `docs/deck-performance-budget.md` §4.2
is the other view; `tests/deck-perf.test.ts` fails if they drift):

| tier | scale | maxFps | AA | maxCalls | maxStations | maxBeacons | ambient | p50 | p95 |
|---|---|---|---|---|---|---|---|---|---|
| minimal | 0.5 | 30 | no | 24 | 8 | 32 | no | 33 ms | 45 ms |
| standard | 1 | 60 | no | 48 | 16 | 64 | no | 16 ms | 25 ms |
| high | 1 | 60 | yes | 96 | 32 | 128 | yes | 12 ms | 20 ms |

`ambient` is the *expression* allowance (today only `drift`); the four
clarifying effects are admitted by measurement instead
(`docs/deck-performance-budget.md` §6.1). d14 changes no number here.

Effect registry (`web/src/scene/ambient.ts:73-129`):

| effect | minTier | cost | off means |
|---|---|---|---|
| `floor` (grid) | minimal | 1 draw call, ≤ 130 segments | plain background |
| `fog` (distance fade) | minimal, **default-off at `high`** | fill (no pass, no program) | uniform contrast |
| `parallax` (floor trails camera ≤ 0.6) | minimal | one write per camera change | floor + rail move as one |
| `settle` (completion plate ≤ 400 ms) | minimal | +1 draw call while landing, ≤ 4 | ordinary highlight only |
| `drift` (framing breath ≤ 0.5) | high + expression | camera offset on already-drawn frames | exact framing holds |

Gate: tier → expression allowance → reduced motion → operator switch. An
override can only ever *remove* an effect (`tests/deck-ambient.test.ts`).
Every effect has a HUD row with its tier and blocked reason; all off is a
working deck (asserted in `tests/e2e/deck.e2e.ts`).

## 7. Rules enforced by tests (roadmap §B.4 as built)

| Rule | Enforced by |
|---|---|
| `web/src/**` is API-only: no `node:*`, no `../src/`, no `src/store`/`src/control`, no `new WebSocket`, and the client references `/api/` | `tests/release-gate.test.ts` architecture lock |
| `three` only in `scene/renderer.ts` (+ `Deck*.tsx` allowance, unused: `Deck.tsx` does not import it) | `tests/release-gate.test.ts` deck boundary |
| `scene/**` opens no `fetch(`, no `new EventSource` | same test |
| No second derivation of slice/agent state outside `web/src/lib/**` + the deck derivation set (`model/rail/focus/lanes/alerts/deltas/history/fallback/palette/ambient`) | same test (M1) |
| Layout is a pure function of the roadmap: identical coordinates across five status permutations; appends never move existing pads | `tests/deck-model.test.ts` |
| No colour literal in `scene/**` outside `palette.ts`; palette fallbacks equal `tokens.css` (`:root` + `.dark`) | `tests/deck-palette.test.ts` |
| Registry completeness + full tier × motion × prefs gate matrix + bounded parameters | `tests/deck-ambient.test.ts` |
| Tier table equals the budget doc; controller rules (full-window median, never up, ≤ 2, never below minimal) | `tests/deck-perf.test.ts` |
| No file outside `App.tsx` references `scene/` (import specifiers, static or dynamic; comments do not count) | `tests/release-gate.test.ts` d14 removability assertion |
| Frame budgets + caps + zero idle frames + one stream, per tier, on the built bundle | `scripts/deck-perf.ts` (harness) |
| 20 surface switches dispose every renderer; GPU counters return to first-mount values | `tests/e2e/deck.e2e.ts` disposal audit |
| Desktop shell stays packaging: one window, sidecar wiring, capability allow-list, zero data commands | `scripts/deck-desktop-check.ts` + `tests/deck-desktop.test.ts` |

## 8. Operability: install, launch, run, reconnect, failure, cleanup

Install (one toolchain: Bun ≥ 1.3, plus `omp` on `PATH` for runs):

```bash
git clone https://github.com/NavidGhoreyshi/ompo.git && cd ompo
bun install
bun run build        # web bundle + compiled ./ompo binary (embeds the bundle)
./ompo doctor        # pre-flight: omp, models, tmux, git, tree, gates, disk, config
```

After editing `web/src`, `bun run web:build` alone (the served UI is the
embedded bundle in `src/webAssets.generated.ts`). With no bundle at all `/`
is an explanatory `503` naming the build command while `/api/*` keeps
working (`src/server.ts:849-850`).

Launch (three ways, same URL contract):

```bash
ompo                                    # dashboard, browser opens
ompo --no-open --print-url              # → exactly one stdout line: url=http://127.0.0.1:<port>
bun scripts/deck-open.ts                # server + chrome-less app window (Ctrl-C stops the server)
bun run deck:desktop:dev                # Tauri shell (needs Rust + WebKitGTK; fails with instructions otherwise)
```

`--print-url` moves the human banner to stderr; without the flag output is
unchanged; on a non-dashboard command it is a stderr warning, never a
failure (release-gate asserts all three). The launcher prefers
`$OMPO_DECK_BROWSER`, then Chromium-family, then Windows Edge via WSL
interop, then the platform opener; with nothing found it prints the URL and
exits 1. Ctrl-C kills the server it started (SIGTERM → grace → SIGKILL);
closing the window never stops ompo (browser semantics — printed once).

Run: open `<url>/?surface=deck`, or the header `Deck` toggle, or `D` on
either surface (the URL is rewritten with `replaceState`, dashboard history
untouched). Tier classifies from the renderer string (this box: SwiftShader
→ `minimal` + "software renderer detected"); `T` cycles
`auto → minimal → standard → high → flat`, `M` flips reduced motion, prefs
persist (§9). The HUD budget line names the tier's allowance every frame.

Reconnect: SSE replays from the last seen `seq` (`afterSeq`/`Last-Event-ID`);
900 ms polling fallback yields identical state; timeline appends stay
contiguous and capped (a slow run-switch load cancels rather than landing on
the next run). Loops are observed, never owned: liveness is `lockHeld`, and
`resume`/`restart-loop` settle through the lock + `run_resumed` on the
stream.

Failure (every one leaves the operator with a surface and a sentence):

| Failure | Behaviour |
|---|---|
| Deck chunk fails (offline build, stale asset) | `DeckBoundary` card + `Back to dashboard`; dashboard never unmounts |
| No WebGL2 / context creation fails | flat projection (same slices/workers/window/alerts/controls), one-sentence notice with the device string |
| Context lost mid-session | keep the model, switch to flat, offer `Retry 3D` (fresh canvas) |
| Forced flat (`T`) | notice + full DOM deck, no canvas |
| Sidecar fails (launcher/shell) | launcher: stderr tail + `run the handshake yourself`; shell: small error window with stderr tail + exact reproduce command |
| Server exits under the launcher | window stays open; terminal says the dashboard exited with its code |
| No bundle | `503` naming `bun run web:build`; API unaffected |
| Cross-origin POST | `403` (`originAllowed`); CSP is `default-src 'self'` + `connect-src 'self'` |

Cleanup: no orphans by construction — launcher SIGTERM-grace-SIGKILLs the
child; the shell kills the sidecar on window close/app exit/`Drop`; e2e and
perf fixtures serve from temp dirs and close their browsers/servers in
`finally`. Scratch runs live outside the repo (`.omp/` is gitignored).

## 9. Surface-selector and preference contracts

- `?surface=deck` selects the deck; any other value (including absent)
  selects the dashboard. Read once at mount; toggles rewrite the param.
- Header toggle (`aria-pressed`, `Switch to the dashboard/deck surface`) and
  `D` are the same action (`toggleSurface`); the deck's HUD `Dashboard`
  button and `Esc`-chain are the way back.
- Flat is orthogonal to the surface: `forced: "flat"` renders the document
  projection *inside* the deck surface (`data-availability="flat"`,
  `data-flat-reason`), never a redirect.
- `ompo.deck.prefs` (`DeckPrefs`): `tier: "auto"|tier` (start point; the
  controller may still demote), `motion: "system"|"on"|"reduced"` (explicit
  choice wins over the OS setting; legacy `reducedMotion: true` migrates to
  `"reduced"`), `forced: "3d"|"flat"|null` (`"3d"` is the retry after a lost
  context), `effects: Record<string, boolean>` (sanitized against the
  registry; only explicit off is stored, so a new effect ships on). Unreadable
  storage degrades to defaults, never throws.
- `ompo.deck.dismissed`: acknowledged `run|slice|kind|seq` keys (new evidence
  is a new key), capped at 200, session memory when storage is unavailable.

## 10. Bundle, binary, and measured record

Build of record (d13 bundle, unchanged by d14 — this slice touches no
`web/` file):

| Artifact | Bytes | Gzip |
|---|---|---|
| `web/dist/assets/Deck-D4TrDqWJ.js` (deck + `three`, lazy) | 639 890 | ~162 KB |
| `web/dist/assets/index-meK1i3v6.js` (dashboard shell) | 458 380 | ~134 KB |
| `web/dist/assets/index-*.css` | 109 157 | — |
| `src/webAssets.generated.ts` (embedded bundle, base64) | ~1.7 MB | — |

The shell chunk is byte-identical with the d13 build (`index-meK1i3v6.js`, 458 380 bytes);
the dashboard pays nothing for the deck until `?surface=deck` imports it.
`bun build --compile` embeds the bundle into the `ompo` binary. Measured this slice
(`/tmp/ompo-deck-smoke`, built after `bun run web:build`): 98 646 144 bytes vs the
repo's gitignored `./ompo` (built 2026-09-12): 98 465 920 bytes — delta +180 224 bytes
(+0.18%, toolchain noise; the embedded bundle is byte-identical, so the deck's marginal
weight is unchanged: the ~640 KB lazy chunk above, base64-inflated in the generated file).
Reproduce: `bun run web:build && bun build --compile src/cli.ts --outfile /tmp/ompo-deck-smoke`
(`bun run build` writes `./ompo`). The smoke binary serves `/` (200), `/api/health`
(`{"ok":true,"version":"0.2.0"}`), `/?surface=deck` (200) and the deck chunk (200) —
verified with loopback proxy bypass (`NO_PROXY`), which an earlier 502 taught again.

Frame record: `docs/deck-performance-budget.md` §5.2 (d10 idle-box pins,
all tiers PASS with 6–40× headroom) and §6.2 (d13 with the default effect
set: every budget check passes at every tier; the frame-count *window* comes
up short at `high`/loaded-`minimal` in every configuration including
all-effects-off — a completeness check, not a budget miss; the one real
p95 miss moved `fog` to default-off at `high`). d14 re-runs no perf
research: it changes no frame, object, pixel, or tier code, so those tables
stand. Evidence regeneration (screenshots + assertions):

```bash
bun run web:build
bun run deck:captures            # → captures/deck-{tier-minimal,tier-standard,tier-high,
                                 #   effects-off,flat,motion-reduced,inspector,wall,alerts}.png
                                 #   + captures/deck-qa.json
```

## 11. Platform matrix

| Platform | State |
|---|---|
| Linux/WSL2 + Chromium (this box: SwiftShader, no hardware GL) | Supported. Tier `minimal`, 0.5× backing, 30 fps cap, zero idle frames. The launcher is the path. |
| Windows 11 x64 (WebView2 + bundled `ompo.exe` sidecar) | Supported target for the Tauri shell. Hardware acceleration expected. Windows-side acceptance (dev run, `tasklist` cleanup, sidecar-kill recovery, tier + harness numbers) is **owed** — §13. |
| Linux/WSLg Tauri build | Requires Rust + `libwebkit2gtk-4.1-dev`; expected software-rendered, slower than the browser it wraps. Not the first target. |
| macOS | Untested, and says so (`desktop/README.md`). |

`bun run deck:desktop:check` verifies the shell contract without Rust;
`bun run deck:desktop:dev|build` refuse without the toolchain and point at
the launcher instead of installing anything unattended.

## 12. Removability proof

The deck's production surface outside `web/src/scene/**` is exactly:

1. one lazy import + one prop block in `App.tsx` (instrument import,
   `ReplayState` type import, `lazy(() => import("./scene/Deck.tsx"))`,
   the `surface === "deck"` branch),
2. one prop-only toggle in `Header.tsx` (`surface: "dashboard"|"deck"` +
   `onToggleSurface` — it imports no scene module),
3. the `?surface=` read (in `App.tsx` with the toggle),
4. the `d11`/`d12` artifacts (`--print-url` in `src/cli.ts`,
   `scripts/deck-open.ts`, `desktop/`).

"Delete the deck" is a revert of (1) plus optional deletions of
`web/src/scene/**`, `scripts/deck-{captures,open,perf,probe}.ts`,
`desktop/`, and the deck tests — no core, server, store, or dashboard file
changes meaning. The d14 assertion (`tests/release-gate.test.ts`) scans
every `web/src` module specifier and fails on any reference to `scene/`
outside `App.tsx`. `Header.tsx` is asserted scene-free separately.

## 13. Honesty: where the deck wins, where it loses, what was not built

Better on the deck: spatial scanning of a live multi-worker run (who is
running, what changed last, which worker to frame), transitions (status
moves as a decaying highlight on a stable floor), and history (ribbon +
wall: what happened when, and which run to reopen). These are structural —
stable positions plus state encoded by material/height/beacon — not styling.

Worse on the deck (use the dashboard): **dense textual forensics.** A 2D
table/board beats the rail at scanning 20+ slices' statuses at once, and the
inspector's Diff/Verify/Review/Prompt/Events/Usage/Log tabs, the event query
DSL, and any list over ~10 items are genuinely better as text — which is why
the deck embeds those exact components instead of competing with them.
Small windows (the HUD costs ~20 px plus a taller panel state), weak GPUs
(SwiftShader holds budgets but not 60 fps intervals at `high`), and
screen-reader-first operation (the mirror is complete but the dashboard is
direct) all favour the dashboard too.

Deliberately not built (roadmap §15): free-fly/WASD camera,
post-processing, per-line particles, 3D diff/log walls, GLTF/decorative
models, sound, multiple concurrent 3D surfaces, a second store/index,
VR/XR, in-browser roadmap editing. The usage-based revisit trigger stands:
if after real use the deck is not the surface the operator reaches for when
a run is live, the expression slices (`d13` content) should be dropped in
favour of keeping the stable view — a passing gate is permission, not a
mandate.

## 14. Open findings: accepted risks vs blockers

`d03v` (M1–M13 against a real `omp -p` worker, incl. **M10's five timed
tasks**) remains the real gate and remains **owed**. Nothing in d14 waives
it. Standing decisions for this release:

Accepted risks (shipped, documented, not re-litigated here):

- M10 unmeasured; F4 not declarable clean. The deck ships as an *optional*
  surface with the dashboard default — the claim is "projection integrity +
  budgets + boundary", never "operators are faster".
- Tauri acceptance owed (uncompiled crate + static verifier; Windows run,
  cleanup, sidecar-kill recovery, icons, error-page rendering). The shell is
  explicitly droppable; the launcher is the supported path.
- `drift` never seen moving (high-only, no hardware GL here). Bound +
  no-frame-scheduling rule unit-tested; look owed to a hardware-GL machine.
- Help overlay covers the HUD panel (`H` opens both; same key closes).
  Pre-existing composition, captured in `deck-tier-minimal.png`.
- Harness frame-count window short at `high` / loaded-`minimal` in *every*
  configuration (113–253/300, incl. all-effects-off). Completeness check,
  not a budget; recorded with the A/B arms in the budget doc §6.2.
- `minimal` p50 above the d10 idle-box number under load; 100k-event index
  build over its pathological budget (operating point: ≤ 2000 events, a few
  ms); transport owning event-to-screen latency; classified load flakes;
  unasserted settle-plate look; `ambient: false` read as the expression
  allowance. Each recorded in `docs/deck-slice-reviews.md` d12–d13.

Blockers (release stops until fixed):

- Any gate red: `tsc --noEmit`, `bun test` (incl. release-gate +
  removability), `git diff --check`, deck e2e with `--workers=1`,
  `deck:desktop:check`, `deck:captures` assertions.
- Any budget miss introduced by a scene change (d14 introduces none), any
  removability violation, any new endpoint / store import / `fetch` under
  `scene/`, any committed claim contradicted by the tree.
- Stale bundle: `web/dist` hash ≠ embedded `webAssets.generated.ts` at
  release time (`bun run web:build` first — the e2e and captures both test
  the previous build otherwise).

## 15. Review checklist and commands

Does it work (three opens, flat, reconnect)? Through existing interfaces
only (§5)? Existing behaviour preserved (dashboard/TUI/CLI untouched —
`git log --name-status` shows the deck's files)? Architecture still clean
(§7 green)? Tests present and honest (no re-pinned flakes)? Performance
acceptable (§10 tables, no new research)? No business logic in the UI (M1)?
No new dependencies (`three` pinned, Tauri tooling only)? TUI/dashboard
unbroken (sweep below)?

```bash
bunx tsc --noEmit
bun test
git diff --check
bun run web:build
bun run test:e2e -- --workers=1            # patience on SwiftShader; per-file on a loaded box
bun scripts/deck-desktop-check.ts
bun run deck:captures
bun scripts/gen-captures.ts                # TUI captures unchanged
bun build --compile src/cli.ts --outfile /tmp/ompo-deck-smoke
/tmp/ompo-deck-smoke --help | head -5; /tmp/ompo-deck-smoke status --help | head -3
ompo --tui --help | head -3; ompo run --dry-run --help | head -3   # manual surface pass
```
