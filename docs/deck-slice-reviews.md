# Deck slice reviews (d00–d14)

Performance observations per slice, in the terms the operator cares about: what a frame costs, what
an event costs, what the DOM does while nobody is looking, and whether the surface is still usable
at the **minimal** tier. The gate's full protocol (`d03v`, M1–M13) lives in
`docs/deck-validation-report.md`; this file is the running record that feeds it.

Rules for entries here:

- Every number names the command that produced it, so it can be re-measured the same way.
- Measurements come from the built bundle served by the real server (`tests/e2e/serve.ts`), not
  from a dev server, and never from a synthetic in-page benchmark.
- **A slice review that contains no negative is incomplete.** Each entry names something the deck
  does worse than the dashboard, or states plainly that none was found.
- Claims are quoted with their sample counts and spread; `d00`'s rule applies: single samples are
  not evidence on this machine (`docs/deck-performance-budget.md` §2, §3).

---

## d00 — probe and budget (accepted)

The measurement method, the machine's numbers, the tier table and the decision rules are in
`docs/deck-performance-budget.md`; raw runs in `captures/deck-probe-*.json`. Headline facts other
slices must design against:

- Fill ≈ **9 ns per shaded pixel**; **~28 µs per object** whether instanced or a separate draw call
  (instancing does not batch here), ≈0.7 ms fixed per frame.
- This machine classifies as `minimal` (SwiftShader): 0.5× backing store, 30 fps cap.
- `standard` cannot hold 60 fps here even with a single full-screen layer; `high` is operator-only.

Re-measure: `bun scripts/deck-probe.ts --json` (~1 min, 3 repeats per configuration).

---

## d01 — deck surface, render loop, HUD, instrumentation

Reproduce everything below with:

```bash
bun run web:build                                                    # chunk names and sizes
bunx playwright test tests/e2e/deck.e2e.ts --reporter=list           # all numbers printed by the specs
DECK_IDLE_MS=20000 bunx playwright test tests/e2e/deck.e2e.ts -g "idle deck" --reporter=list
```

### Bundle (acceptance 4)

| Artifact | Size | Gzip |
|---|---|---|
| `assets/Deck-DYSj2eEw.js` (the deck + `three`) | 540.83 kB | 135.91 kB |
| `assets/index-DhyE4qaS.js` (the dashboard shell) | 453.20 kB | 136.56 kB |
| `assets/index-BhYoi-B2.css` | 79.93 kB | 14.50 kB |

The deck is a **separate chunk** (the lazy import guarantees it), so the dashboard pays nothing for
it. `./ompo` (compiled, asset mode embedded) serves `/?surface=deck` and
`/assets/Deck-*.js` (200, `text/javascript`, 540 833 bytes) with no server routing change.

### Frame and render cost (M2/M3 in miniature)

Interaction window — resize + HUD toggle on the minimal tier, measured by the deck's own
instruments (`GET /?surface=deck`, then `window.__ompoDeck.instrument.snapshot()`), three runs:

| Run | frames | p50 | p95 | worst | samples |
|---|---|---|---|---|---|
| 1 | 2 | 0.80 ms | 1.10 ms | 1.10 ms | 2 |
| 2 | 2 | 0.70 ms | 1.90 ms | 1.90 ms | 2 |
| 3 | 2 | 0.70 ms | 0.90 ms | 0.90 ms | 2 |

- Against `d00`'s minimal budget (**p50 ≤ 33 ms, p95 ≤ 45 ms**) that is **17–40× of headroom**, and
  the spread across runs (p95 0.9–1.9 ms) is the machine's noise, not the scene's.
- Rendered frames in a 20 s idle window: **0**. Long tasks in the interaction window: **0**.
- Frame cost is dominated by main-thread bookkeeping, not the GPU: the scene shades 13 053 px,
  which `d00`'s model prices at 0.12 ms.

### Scene complexity (M8 shape)

| Counter | Value at 1440×900 CSS |
|---|---|
| draw calls | 1 |
| objects / lines / vertices | 1 / 18 / 36 |
| backing store | 612×389 (CSS × tier scale 0.5) |
| full-screen layers | 0 |
| shaded pixels | 13 053 |

`d00`'s pixel cost is only paid where geometry actually lands: the `d01` world has no full-screen
pass at all, which is the design the budget asked for.

### Event → visible latency (M4 plumbing)

A real event through the real path (`POST /api/runs/<id>/control` → store → SSE poll → `App` state
→ deck DOM mark), three runs: **619 / 670 / 677 ms** (p50 = worst = 1 sample each, 0 mark misses).
The bound is the server's 900 ms store poll, and the deck adds no measurable time on top of it.
This measures the HUD's event line; the live-window measurement lands with `d03`.

### DOM and update behaviour (M5/M6 direction)

| Observation | 20 s idle | Interaction window |
|---|---|---|
| React commits | 8 (0.40/s) | 9–11 (4.7–5.8/s) |
| DOM mutations | 0 | 19–25 (9.7–13.2/s) |
| deck DOM nodes | 12 | 12 (HUD open) |
| forced-layout cost (p50) | — | 0.10–0.60 ms |
| heap (`performance.memory`) | 10.0 MB | 10.0 MB |

The idle commits are the shell's own 5 s/10 s polls re-rendering the tree; the deck's HUD adds
none — it compares its readout field-by-field before calling `setState`, so a settled deck performs
**zero DOM mutations** and renders **zero frames**. M5's budgets (≤ 4 commits/s, ≤ 60 mutations/s)
hold with more than an order of magnitude to spare.

### What the deck does worse, and open findings

1. **Heap readings are quantized.** `performance.memory.usedJSHeapSize` reports exactly
   10 000 000 bytes before and after load here — the browser coarsens the value. M7 (≤ 10 % growth)
   cannot be answered from this API alone; `d03v`/`d10` must add `renderer.info.memory` and
   `performance.measureUserAgentSpecificMemory()` (or a Chromium launch flag) before claiming a
   leak verdict. Today's instruments report the reason, not a fake zero.
2. **Creating a second WebGL context can fail on this machine.** A rebuild-on-tier-change design
   was measured failing (`getContext("webgl2")` returning a dead context) — which is why a tier now
   changes *parameters* (scale, fps cap) on one context, and only MSAA re-creates it, with a
   graceful "3D unavailable" notice if that fails. Cost of the design: `high` (MSAA) needs a
   rebuild, so it is the one tier that can degrade on a machine like this one.
3. **The on-demand fps reading is honest but low** (`fps ≈ 1.1–1.2` while interacting): the number
   reflects rendered frames per second, which is ~0 when nothing changes. A dashboard-style "fps"
   gauge would be misleading here; `d10` should report frame *cost* and idle frames, not fps.
4. **No live tail yet** — the deck shows the newest event from the shared event list, so the
   workflow questions the gate asks (T1–T5) are not answerable from `d01` alone; timings for those
   land with `d03`.
5. **The HUD is DOM text over a canvas** (CP-3): searchable, selectable, and readable by a screen
   reader — but it is *not* positioned relative to 3D objects yet, which is the overlay risk the
   roadmap flagged (red-team #3) and `d02`/`d03` must keep honest.

### Acceptance criteria (d01)

| Criterion | Result |
|---|---|
| `?surface=deck` → WebGL2 canvas + HUD tier, `window.__ompoDeck.tier` = renderer classification | ✔ `minimal` on this machine, HUD chip agrees, `software renderer detected` shown |
| Idle 2 s (and 20 s) → `frames` grows by 0 | ✔ 0 frames, 0 mutations |
| Ten surface switches → one canvas, `disposed ≥ 9` | ✔ 11 mounts / 10+ disposals, one canvas, dashboard intact |
| `web:build` emits a separate chunk; `./ompo` serves it | ✔ `Deck-DYSj2eEw.js` 540.83 kB (135.91 kB gzip), served embedded by the compiled binary |
| `bun test` incl. extended release gate; `bun run test:e2e` | ✔ 655 unit tests, 26 e2e tests (18 existing + 8 deck) |
| `snapshot()` shape (frames, p50/p95, commits/s, mutations/s, long tasks, heap or reason, renderer counters) | ✔ asserted in `tests/deck-instrument.test.ts` and the e2e budget spec |
| No `fetch`/`EventSource`/`WebSocket`/`node:*`/`../src/` under `scene/**` | ✔ asserted by the release gate, with a violation probe verified |

---

## d02 — scene model and the roadmap rail

The whole roadmap as a spatial object: one pad per slice at its dependency depth, one edge per
declared dep, ghosts for unknown deps, outlines for cycles, status encoded in pad height/colour
plus markers, selection shared with the dashboard — all produced by a pure
`buildDeckModel(DeckInput): DeckModel` (`web/src/scene/model.ts`) whose coordinates come from
`layoutDag` through `railPositions` (`web/src/scene/rail.ts`) and never from status.

Reproduce everything below with:

```bash
bun run web:build
bunx playwright test tests/e2e/deck.e2e.ts --reporter=list --workers=1
DECK_IDLE_MS=20000 bunx playwright test tests/e2e/deck.e2e.ts -g "idle deck" --reporter=list --workers=1
bun test tests/deck-model.test.ts
# the real run (22 slices, 32 deps), served embedded by the repo's own dashboard:
bun src/cli.ts --port 4321 --no-open     # then open /?surface=deck and pick 20260909-kph0as
```

### Bundle

| Artifact | d01 | d02 | Δ |
|---|---|---|---|
| `assets/Deck-*.js` (the deck + `three`) | 540.83 kB / 135.91 kB gzip | 557.71 kB / 142.08 kB gzip | **+16.9 kB / +6.2 kB gzip** |
| `assets/index-*.js` (the dashboard shell) | 453.20 kB / 136.56 kB gzip | 453.25 kB / 136.59 kB gzip | +0.05 kB |
| `assets/index-*.css` | 79.93 kB / 14.50 kB gzip | 82.42 kB / 14.86 kB gzip | +2.5 kB (overlay + mirror styles) |

The rail's code is the whole cost: model + positions + pads/markers/edges/outlines/ring + the DOM
overlay. The dashboard chunk is unchanged (its only d02 deltas are the deck's `onSelect` prop in
`App.tsx` and reusing `liveSliceEvent` in `RunHeader`), and the deck remains its own lazy chunk —
the dashboard pays nothing for any of it.

### What the model itself cost us (the question this slice exists to answer)

Fixture run (9 slices, 5 deps, 3 alert markers), 1440×900 CSS, tier `minimal`; counters read from
`window.__ompoDeck` / `instrument.snapshot()` in the deck e2e run above:

| Counter | d01 (empty world) | d02 (rail) |
|---|---|---|
| draw calls | 1 | **6** (grid, pads, markers, edges, outlines, ring) |
| objects (`calls + instances`, `d00`'s budget term) | 1 | **18** (6 + 12 instances) |
| instances | — | 12 (9 pads + 3 markers) |
| triangles | 0 | 144 |
| lines | 18 | 56 |
| vertices | 36 | 396 |
| geometries / programs | 1 / 1 | 6 / 4 |
| shaded pixels (est. `× 9 ns/px`, `d00`) | 13 053 (0.12 ms) | **40 609 (0.37 ms)** |
| full-screen layers | 0 | 0 |

Against `d00`'s minimal budget (`p50 ≤ 33 ms`, `p95 ≤ 45 ms`) and the model
`0.9 + 9·MPx + 0.03·objects`: the rail prices at ~1.8 ms/frame (0.9 fixed + 0.37 fill + 0.54
objects) and measures at 0.4–1.6 ms.

| Window (minimal tier) | frames | p50 | p95 | worst |
|---|---|---|---|---|
| interaction: resize + HUD toggle (d01's window, same spec) | 2 | 0.4 ms | 0.9 ms | 0.9 ms |
| one status change through the real control path | 1 | 1.4 ms | 1.4 ms | 1.4 ms |
| 10 selection changes via the raycast path | 9 | 1.2 ms | 2.8 ms | 2.8 ms |

- **A status change costs one frame and no buffers.** `deck-status-change` (printed by the
  status-change spec) reports `moved: false`, `instances 12→12`, `geometries 6→6`, `drawCalls 6`,
  `window.frames 1` at 1.4 ms, `longTasks 0`. Only the instance colour/height buffers are
  rewritten; nothing is reallocated, recreated or remounted.
- **Nothing that is not visual reaches the scene.** `buildDeckModel`'s digest excludes events,
  agents and preferences; `tests/deck-model.test.ts` asserts that 200 events, an empty worker
  list, a wedged worker and a preference change all leave it byte-identical, and the e2e shows
  the rail produces no frames while the event stream ticks. Log text cannot drive the render
  loop because it cannot change the model.

### Idle behaviour (20 s, same window as d01's run)

| Observation | d01 | d02 |
|---|---|---|
| rendered frames | 0 | **0** |
| DOM mutations | 0 | **0** |
| React commits | 8 (0.40/s) | **6 (0.30/s)** |
| long tasks | 0 | 0 |
| heap (`performance.memory`) | 10.0 MB (quantized) | 10.0 MB (quantized) |

The commit rate went *down* although the deck now draws 22 objects: the HUD's compact comparison
was narrowed to the fields the always-visible row actually renders. Measured before the change:
150 readout diffs in a 20 s idle window, every one of them `commitsPerSec`, `mutationsPerSec` or
`eventsPerSec` — panel-only rates that were committing ~1/s for pixels nobody was looking at.
M5's budget (≤ 4 commits/s) holds either way; the fix removes the invisible half.

### Event → visible latency

A real event through the real path (`POST /api/runs/<id>/control` → store → SSE poll → `App` state
→ deck DOM mark): **361 ms** in the d02 run, against d01's 619/670/677 ms. Same bound (the
server's 900 ms store poll) and same conclusion: the deck adds no measurable time on top of the
transport. Single sample — `d03v`'s M4 is where the distribution comes from.

### Layout stability (the property the operator actually uses)

`tests/deck-model.test.ts` (pure, no browser):

- **5 status permutations** of the same roadmap (all-pending, all-done, two mixed, one
  all-terminal) → identical `id → (x,z)` maps and identical node order, for every pad.
- Worker state (wedged, stale, gone), activity/log content (200 events, 400-char details), a
  changed failure reason, selection, `prefs`, `live` → positions, order and bounds unchanged.
- Appending three slices at the end of the roadmap → every existing pad keeps its exact
  coordinates.
- Spatial invariants: a dep is always drawn to the *left* of its dependent, and an unknown dep's
  ghost column leads every real column.

`tests/e2e/deck.e2e.ts` proves the same through the real app: a `skip` control lands, the model
digest changes, and `moved: false` with `instances`/`geometries`/`drawCalls` all unchanged.

What this deliberately does *not* cover: inserting a slice in the middle of a column shifts that
column's later rows (the existing `layoutDag` row order). A run's roadmap is written once before
it starts, and a *status* change can never reflow — which is the rule CP-7 states.

### The real run, not just the fixture

`.omp/roadmap/runs/20260909-kph0as` (22 slices, 32 declared deps), served by `bun src/cli.ts`:
22 pads, 32 edges, 5 draw calls, 27 objects, 1 112 vertices, no ghosts and no cycle outlines.
`captures/deck-d02-real-run.png` is the capture; the chain-with-branches shape matches the
dashboard's DAG view of the same run, and the framing was retuned after that check: the first
implementation fitted a bounding sphere and shrank the long, shallow rail to a fifth of the
viewport. `railFraming` now fits the rail's box in the camera's own basis (`rail.ts`), and
`tests/deck-model.test.ts` projects every corner of that box through a real
`THREE.PerspectiveCamera` at 16:9, 1:1 and 390×844 to assert it lands inside the frustum.

### What the deck does worse, and open findings

1. **Growing the viewport costs one long task.** A resize-only probe: 1440→1600×1000 → 1 frame
   (1.1 ms) and 1 long task (**75 ms**); 1600→1180 → 0 long tasks; 1180→1440 → 0. The
   interaction window in the e2e run shows the same single task (57 ms isolated; up to 194 ms
   when three other software-rendered browsers share this 4-vCPU box). It is the main-thread side
   of reallocating the canvas backing store inside SwiftShader, not the rail — the rail's own
   frames are 0.4–1.6 ms. The e2e guard is now the *count* (≤ 2 per window); a hardware-dependent
   worst-case threshold was removed rather than loosened. Against the gate's own M5 budget
   (≤ 2 long tasks > 50 ms per minute) this is an operator action, not a rate — the idle window
   measures 0 — but it is the one place in `d02` where the machine, not the scene, sets the floor.
2. **Hover is colour-only.** The pointer's highlight brightens a pad's instance colour; selection
   has the ring, alerts have markers and heights, but hover has no non-colour channel. Colour-blind
   operators keep the overlay line and the mirror list (both text), and `d09` owns the fix.
3. **The DOM census root changed and the counts are not comparable to d01.** The instrument now
   watches the whole deck subtree (canvas, overlay, mirror, HUD) because the DOM line mutates as
   much as the scene does; the "deck DOM nodes" column therefore jumped from 12 (HUD root) to 72
   (panel closed) / 145 (open). The mirror list is the bulk of it — 3 spans per pad, ~600 nodes at
   200 pads — and it is the accessibility price `d09` will virtualise.
4. **`objects` was redefined** from "scene-graph children" to `drawCalls + instances` — `d00`'s
   budget term, and what the HUD should have shown from the start. d01's numbers in this file
   (`objects 1`) used the old meaning.
5. **Heap is still quantized.** `performance.memory` reports exactly 10 000 000 bytes before and
   after; M7 still needs `renderer.info.memory` plus a better API (`d03v`/`d10`), unchanged from
   d01.
6. **No animation anywhere in the rail** — pads appear when the model arrives, and the ring jumps
   on selection. That is deliberate for this slice (`d05` adds transitions, `d13` ambient), but it
   means the first paint of a run is abrupt, and `d03` inherits the jump until transitions land.

### Acceptance criteria (d02)

| Criterion | Result |
|---|---|
| Pads = `slices.length`, edges = dep count, both matching `layoutDag` | ✔ 9 pads / 5 edges on the fixture; 22 pads / 32 edges on the real run; parity asserted against `layoutDag` in `tests/deck-model.test.ts` |
| A status change leaves every pad's position unchanged | ✔ unit: 5 status permutations, identical coordinates; e2e: real `skip` → `moved: false`, `geometries`/`instances` unchanged |
| Clicking pad X selects X in the deck line *and* the dashboard's board | ✔ `s-beta` selected by a real pointer click on the canvas; dashboard row shows it after switching surfaces, and a dashboard click moves the deck's line |
| Draw calls ≤ 8 at 24 slices; no buffer rebuild on selection change | ✔ 6 calls (fixture and real run), `geometries` 6→6 and `instances` 12→12 across selection changes |
| `bun test`, `bunx tsc --noEmit`, `git diff --check`, `bun run test:e2e` clean | ✔ 670 unit tests, 32 e2e tests |
| M1 duplication scan passes (no second derivation) | ✔ release gate green; `model.ts` reuses `layoutDag`/`preferredSliceId`/`depSatisfied`, and the deck↔dashboard DAG parity is asserted in the e2e |

---

## d03 — active-worker focus and the bounded live window

The running worker becomes the object the deck points at: the camera frames it (`command` framing),
its pad carries a stage shaft, the lane strip lists every live worker, and its real transcript runs
in a bounded DOM window that the operator can hold (`Space`), expand to the raw tail (`E`) and step
between workers (`[`/`]`) — all without the render loop ever seeing a log line.

This is also the slice where the roadmap's first product question gets a measured answer rather than
a design intention: **does putting the active worker and its live activity into this spatial
representation improve the operator's experience?** The evidence below is organised the way the
brief asked for it (focus, churn, latency attribution, retention, degradation, wins/losses), and it
ends with a verdict and the deployment question ("what would a polished 2D dashboard lose?").

Reproduce everything below with:

```bash
bun run web:build
bunx playwright test tests/e2e/deck.e2e.ts --reporter=list --workers=1                       # fixture surface, focus, window, degradation
DECK_IDLE_MS=20000 bunx playwright test tests/e2e/deck.e2e.ts -g "idle deck" --reporter=list --workers=1
bunx playwright test tests/e2e/deck-workflow.e2e.ts --reporter=list --workers=1              # a real run: 8 workflow steps + the 60 s M6 window
bun test tests/deck-focus.test.ts tests/deck-model.test.ts tests/deck-churn.test.ts tests/deck-instrument.test.ts
bun run test:e2e                                                                              # all surfaces, parallel
```

Raw artifacts: `captures/deck-validation/d03-workflow.json` (per-step numbers, churn, latency
stages), `captures/deck-validation/d03-text-window.json` (the 60 s log-volume window),
`captures/deck-d03-workflow.png` (the real run, full page).

### Bundle

| Artifact | d02 | d03 | Δ |
|---|---|---|---|
| `assets/Deck-*.js` (the deck + `three`) | 557.71 kB / 142.08 kB gzip | 566.64 kB / 145.05 kB gzip | **+8.9 kB / +3.0 kB gzip** |
| `assets/index-*.js` (the dashboard shell) | 453.25 kB / 136.59 kB gzip | 455.25 kB / 137.36 kB gzip | +2.0 kB (the `LiveFeed` freeze/expand props and the shared live-status rule) |
| `assets/index-*.css` | 82.42 kB / 14.86 kB gzip | 85.61 kB / 15.24 kB gzip | +3.2 kB (station line, lane strip, docked window, flat mode) |

The deck's own cost is one pure focus module, one pure camera module, the station shaft, and the DOM
layer of the window. The dashboard's chunk grows only where it had to (`LiveFeed` gained four
optional props so the deck could drive it instead of forking it; `isLiveStatus` moved into
`lib/selection.ts` so the live set has one rule).

### 1. The active worker as the primary object (brief §1)

The work is real, not an animation: `tests/e2e/deck-workflow.e2e.ts` creates a run in a throwaway
project, drives it through `storeApi` (`claimSlice`, `recordHandoff`, `workerFinished`,
`verifyFailed`, `verifyPassed`) while the page is open, and writes worker transcripts with the real
progress formatter (`formatProgressLine`). Step 1 of that run:

| Property | Measured |
|---|---|
| focused slice (derived, unpinned) | the live primary — `window.__ompoDeck.focused` = `alpha`, and the only `.omp-deck-lane[data-focused="true"]` |
| awareness of the others | `liveCount` 1 · lane strip = every live worker (3 on the fixture run) |
| station on screen, dead centre | `screenPosition("longtitle")` = (612, 399) in a 1224 × 778 canvas, camera target = the station's own `(x, z)`, distance 10.22 |
| the station is the distinctive object | pad + shaft: 14 instances = 9 pads + 3 markers + **2 shaft segments** (`stationSegments`); the station's stage comes from `buildPipelineStages`/`currentStageIndex` |
| focus switch is immediate | `]` → `focused` changes, then **6 frames** (p50 0.7 ms, p95 9.3 ms) to the painted result; `geometries` 7→7 and draw calls unchanged |
| the overview is one key away | `C` → rail preset, 9/9 pads on screen (command framing keeps 8/9: the framing carries context, it is not an exclusive view) |

That last row is the honest shape of `command` framing: it aims the camera at the worker and puts the
shaft on it, but with `LIVE_FRAME_UNITS = 8` (the roadmap's "station plus an 8-unit margin") most of
the rail stays in frame. It reads as "the worker, in its place", not as "the worker alone" — which is
the trade the roadmap asked for, and the reason a rail preset exists at all.

### 2. The bounded live window under churn (brief §3)

The window is the dashboard's own `LiveFeed` with the deck driving `expanded`/`frozen`; the tail is
the server's 400-line cap (`LIVE_TAIL`). What it costs, at the caps and beyond them:

| Test | Input | Result |
|---|---|---|
| `deck-churn-100k` | 100 000 events **and** 100 000 transcript lines handed to `buildLiveStream` | compact window = **5 rows**; derivation 0.8 s (linear in the rows given) |
| `deck-churn-capped` | the real caps: 400 events, 400 lines | compact = 5 rows, **2.9 ms** |
| `deck-churn-model` | 100 000 events in `DeckInput.events` | digest and nodes **byte-identical** to the empty array; 0.3 ms |
| `deck-churn-store` | a 100 000-event `events.jsonl` | `readEvents` 249 ms per call — the *server's* cost per SSE tick, not the deck's |
| workflow step 2 | handoff + 30 transcript lines in 3 bursts | `frames` 5 → 5 (**zero** for the text), rows changed, window stayed 5 |
| workflow step 7 | 420 transcript lines + 50 real control events | compact 5 rows, expanded 400, `domElements` 214 → 90 (**ratio 0.42**, no growth) |
| workflow M6 | **2 038 lines over 63 s**, tail polled every 2 s | `frames` **0**, commits 18 (0.29/s), mutations 940 (14.95/s), long tasks 1 (73 ms), `domElements` 90 flat, rows 5, `logLines` 400 |

The three answers the brief demanded, stated as they are rather than as headlines:

- **The default window stays bounded.** 5 meaningful rows, always; the expanded view is the raw tail
  (≤ 400 lines, server cap 500), and 2 038 incoming lines never increased the DOM.
- **Old output can be deliberately inspected**: the raw tail the dashboard's Inspector reads, with
  freeze (`Space` → `frozen — N new rows`, N counted from the stream since the hold), expand (`E`),
  scroll, and `Jump to live` to resume following.
- **100 000 events do not reach the browser.** The transport is a `seq` cursor, the shell keeps the
  last 400 events, and the window keeps 5 rows — measured, not assumed. The *derivation* is linear
  in whatever it is handed (0.8 s for 100 000 rows); the caps are what keep that path away, and the
  honest ceiling this measurement exposes is the **server's** whole-log read (249 ms per tick at
  100 000 events against a 900 ms poll).

### 3. Event → visible latency, attributed (brief §4)

The instrument now splits one collapsed number into four stages: `transport` (the event's own
timestamp → applied to React state), then `dom`, `model` and `scene`, each measured from application
(`instrument.snapshot().latencyStages`). Same event, four stages, p50:

| Window | transport | dom | model | scene | records |
|---|---|---|---|---|---|
| workflow step 1 (first event after page load) | 2 733 ms | 34 ms | 91 ms | 137 ms | 4 |
| workflow step 2 (handoff + 30 lines) | 197 ms | 41 ms | — (digest unchanged) | — | 1 |
| workflow step 3 (`worker_finished`) | 203 ms | 26 ms | 84 ms | 113 ms | 1 |
| workflow step 4 (terminal failure) | 840 ms | 24 ms | 89 ms | 138 ms | 1 |
| workflow step 7 (50 controls + 420 lines) | 379 ms | 27 ms | 84 ms | 128 ms | 101 |
| fixture, one `retry` control | 603 ms | 34 ms | 94 ms | 147 ms | 3 |

The delay is **transport**: the store's own `at` timestamp to the browser is 197–2 733 ms (the SSE
poll runs every 900 ms, so its mean share is ~450 ms and its worst case is a loaded tick — step 1's
2 733 ms is the first event racing the initial page load), while the deck's whole remaining pipeline
— React commit, model rebuild, DOM text, and the frame that draws the change — is 116–262 ms and is
dominated by the same loaded box. Note step 2's missing stages: a handoff that only bumps a counter
is *not* scene-visible, so no model mark and no frame follow it.

Perceptually, at 0.2–0.9 s p50 the deck is "live, one beat behind"; at a 2.7 s worst case an operator
watching a burst would notice the lag. Nothing in the deck's own stages justifies a transport
redesign; the one thing this measurement does *not* settle is how a human perceives ~600 ms with a
*steady* event stream, which is `d03v`'s M4 protocol (≥ 50 samples over a live run).

### 4. Focus retention (brief §5)

Measured in the workflow run's step 6 and in `deck.e2e.ts`, with a live worker producing output:

| Action | Result |
|---|---|
| select another pad (canvas raycast → `delta`) | live-window row keys and `scrollTop` unchanged; the window keeps following its own worker |
| hover another worker | `hover` = that worker, `focused` unchanged — hover is a preview, never a focus change |
| 20 new transcript lines while scrolled back | camera JSON **byte-identical**; `data-follow="false"` and the scroll offset retained; `Jump to live` returns `data-follow="true"` and lands ≤ 24 px from the bottom |
| a pinned worker (`F`) while a control event lands | the pin holds and the camera is unchanged; `Esc` releases the pin, restores the primary, and re-frames it |
| freeze (`Space`) during events | rows do not change; the counter says how many rows arrived; resume shows the newest window with no replayed motion |

A user reading old output is never yanked back to the tail, and nothing but `F`/`C`/`[`/`]`/`Esc`, a
lane click, or a *change of the primary while unpinned* moves the camera.

### 5. Cost on the minimal tier (brief §8)

This machine classifies as `minimal` (SwiftShader, 0.5× backing, 30 fps cap), 1440 × 900 CSS:
7 draw calls, 21 objects, 444 vertices, 40 609 shaded px (0.37 ms at `d00`'s 9 ns/px), canvas
612 × 389.

| Window | frames | frame p50 / p95 / worst | commits/s | mutations/s | long tasks | notes |
|---|---|---|---|---|---|---|
| idle 2 s | **0** | — | 1 (0.46/s) | 0 | 0 | HUD compares before `setState`; the live window polls without touching the scene |
| idle 20 s | **0** | — | 6 (0.29/s) | 0 | 0 | M3's budget is ≤ 3 frames |
| interaction (resize + HUD) | 3 | 0.8 / 0.8 / 0.8 ms | 10 (3.43/s) | 56 (19.2/s) | 2 (worst 83 ms) | `d00` budget: p50 ≤ 33, p95 ≤ 45 ms |
| one real status change | 1 | 2.5 ms | 3 | 4 | 0 | `moved: false`, `instances` 14→14, `geometries` 7→7 |
| focus switch (`]`) | 6 | 0.7 / 9.3 ms | — | — | — | `geometries` 7→7, draw calls ≤ 8 |
| 5 s of transcript growth | **0** | — | 0.2/s | 0 | 0 | acceptance 5; digest byte-identical (≤ 1 frame under 4-way parallel e2e, from a status change another spec caused) |
| 63 s, 2 038 lines | **0** | — | 0.29/s | 14.95/s | 1 (73 ms) | M6; DOM flat at 90 elements |

Long tasks in the parallel `bun run test:e2e` run (four software-rendered browsers on four vCPUs):
the interaction window reported up to 5, all from the viewport resize path (`d02`'s known
backing-store reallocation), which is why that guard is a jank ceiling and the *rate* budget is
measured on the idle/churn windows — where it is 0–1 per window. The same contention reaches the
frame budget itself: the p95 of a three-frame window measured 57.2 ms once in the parallel run and
0.8 ms alone, so the budget spec asserts `d00`'s numbers only when the suite runs with
`--workers=1` (the command above) and a 3× regression ceiling otherwise — the machine, not the
scene, is the variable, and the venue is stated rather than averaged in.

### 6. Degraded operation (brief §9)

| Case | Result |
|---|---|
| pinned `minimal` (the tier this machine auto-selects) | every operational answer survives: focused worker, 3 lanes, shaft, window rows; canvas at 0.5× |
| runtime tier change (`T` → `standard`) | same GL context (`mounted` unchanged), same station, same instances — tier is a parameter, not a rebuild |
| no WebGL2 at all | the notice says what is lost, and the DOM layer (station line, lane strip, live window) stays usable; the dashboard is one click away and untouched |

The degradation rule the brief asked for — remove decoration before information — is the tier table's
own shape: `minimal` drops backing-store resolution, MSAA and the ambient pass, and *nothing* that
answers which worker is running, what it is doing, or that it is failing. What is missing on the flat
path is the spatial overview itself (and the pad mirror list), which `d09` owns.

### 7. Where the deck wins, where it loses (brief §6)

Not a replacement claim, and not a timed human comparison — M10's five scripted tasks (deck vs
dashboard vs TUI, three repetitions) are `d03v`'s protocol, and this slice did not run them. What the
measurements above do support:

**Wins (measured).**
- **Concurrency awareness**: every live worker is a station plus a lane strip row, and the HUD says
  `live: N · showing <id>`; a second live worker is visible *without scrolling* and without changing
  the primary (fixture: 3 live workers, 1 focused, camera on the primary).
- **Active-worker focus**: the camera targets the station's own coordinates and the operator gets it
  without asking; the shaft encodes the pipeline stage (2 → 3 segments from Work to Verify as the
  worker handed off), which the dashboard shows as a spine but not as "this object".
- **Spatial overview on demand**: `C` returns the whole rail (9/9 pads on the fixture, 22 pads/32
  edges on the real d02 run) and `C` again puts the camera back on the work.
- **State transitions read in place**: a status change moves no pad (`moved: false`) and costs one
  frame at 2.5 ms, so the map is stable enough to learn.

**Losses (measured or structural).**
- **Raw log inspection**: the deck's window is one transcript (`worker`/`verify` lane the server
  picks). The dashboard's Inspector has Diff, Verify (per-gate output), Review, Prompt and Log tabs;
  the deck has none of them until `d06`, and `E` is not a substitute for a diff view.
- **Exact textual information**: dense tables (slices, agents, stats), report fields, token counts,
  copyable payloads — all still dashboard-only.
- **Review/gate detail**: verdict steps, findings, re-review history — inspector only.
- **No-GPU devices and any surface where 3D is not worth 145 kB gzip**: the dashboard loads and runs
  with none of the deck's chunk or its per-frame cost; the deck's flat path is a stub today (`d09`
  builds the real one).
- **Latency**: both surfaces share the 0.9 s poll; the deck adds none, but it also cannot beat it.

### 8. What the deck does worse, and open findings

1. **The transport dominates the event pipeline** (197–2 733 ms of a 223–2 995 ms total). The deck's
   own stages are 20–300 ms and the scene is never the bottleneck; a sub-second monitoring surface
   needs a transport change, not a renderer change (CP-4's trigger, now measurable).
2. **The server reads the whole event log per poll** (249 ms at 100 000 events). The deck is bounded
   at every step after that; the store is not. This is the next real ceiling and it is not the deck's
   to fix.
3. **A focus switch changes the instance count by the shaft's segments** (14→15 in the fixture run).
   Acceptance criterion 5's "objects unchanged" therefore holds for the pool, `geometries` and draw
   calls, but *not* literally for `objects`: the station's stage indicator is scene geometry that
   must differ, or the stage would not be visible. Recorded as a deviation rather than fudged.
4. **`command` framing keeps most of the rail on screen** (8/9 pads). The camera is aimed, not
   exclusive; "unmistakable" is carried by the shaft, the lane strip, the station line and the
   framing together. If an operator wants isolation, `d04`/`d05` are where that argument belongs.
5. **The camera can move without being asked** whenever the *primary changes* and nothing is pinned.
   That is the slice's core behaviour ("a spatial focus that follows the work"), and `F`/`Esc`/`C`
   are the escape hatches — but it is motion an operator did not request, and it is the most likely
   thing to annoy a keyboard-first user in a long run.
6. **Heap is still quantized** (`performance.memory` reports exactly 10 000 000 bytes). M7 cannot be
   answered from that API; `d03v`/`d10` need `renderer.info.memory` over time (this slice keeps
   `geometries` constant at 7 and `instances` at 14 across focus switches, which is evidence about
   the renderer, not about the JS heap).
7. **A rejected control still writes DOM text but changes nothing in the scene.** Correct, and the
   reason the workflow's 50-control churn shows `control_rejected` rows — but an operator reading
   only the scene cannot tell "rejected" from "still queued"; the lane strip and HUD line carry that,
   and the planned alert stack (`d05`) is where it should become unmissable.
8. **Resize is still the one machine-bound cost** (1–5 long tasks per resize under e2e parallelism,
   73–83 ms worst). Unchanged from `d02`, and now measured in two more windows.

### Acceptance criteria (d03)

| Criterion | Result |
|---|---|
| 1. With exactly one live slice, `focused` = the derived primary | ✔ workflow step 1 (`alpha`), fixture (`longtitle` = first live in board order); unit tests pin the rule (pin → live primary → overall primary) |
| 2. Compact window ≤ 5 meaningful rows; expanded = the raw transcript; rows have text on first paint | ✔ 5 rows everywhere it was measured; expanded = 86 rows (fixture) / 400 rows (churn); rows are built from `compactWindow`/`rawLine`, never animated in |
| 3. Freezing shows the skipped-row count; resuming shows the newest window with no queued animation | ✔ `frozen — N new rows` + `resume`; held rows unchanged under events; resume clears motion (unit + workflow evidence) |
| 4. `Esc` after `F` restores follow-the-primary framing (target id, not just position) | ✔ pinned `p-two` → `Esc` → `focused` = `longtitle`, camera target = `longtitle`'s coordinates, station line agrees |
| 5. `frames` unchanged over transcript growth; `objects`/`geometries` unchanged across focus switches | ✔ 0 frames over 5 s and over 63 s / 2 038 lines; `geometries` 7→7 and draw calls stable across switches (`objects` moves by the shaft's segments — finding 3) |
| 6. Instruments produce usable distributions on a real run (M4/M6 first exercised) | ✔ 101 stage records in the churn window; M6's 60 s window is its own artifact; latency attributed per stage |
| 7. Gates clean | ✔ `bunx tsc --noEmit`, `bun test` (701), `git diff --check`, `bun run test:e2e` (44 passed, parallel), deck suite `--workers=1` (24 passed), workflow spec (2 passed) |

### Verdict

**PASS WITH RESTRICTIONS — recommendation, not a decision** (`docs/desktop-3d-roadmap.md` §0.5 rule 1:
the operator fills in the decision block at `d03v`). The spatial model provides a *measurable*
operational advantage for the workflow it was built for — one to three live workers on a software
rasterizer — and it costs nothing measurable when idle (0 frames, 0 mutations, 0.29 commits/s over
20 s). The restrictions, in the order they would bite:

1. **Latency is transport-shaped** (p50 0.2–0.9 s, worst 2.7 s): the deck is a "live, one beat
   behind" surface, not a sub-second one, and no deck-side work changes that.
2. **Inspection stays 2D** until `d06`: diffs, gate output, review findings and prompt history are
   dashboard-only, and the deck must not pretend otherwise.
3. **The verdict rests on structural and instrument evidence**, not on timed human tasks: M10 (five
   scripted tasks, deck vs dashboard vs TUI) is unmeasured here by design, and F4 cannot be declared
   clean without it.
4. **The camera follows the primary unpinned**, which is the point of the slice and also its most
   likely annoyance; `F`/`Esc`/`C` exist so the operator can take the camera back.

Continue to `d04` under those restrictions: multi-worker stations, off-screen awareness and the
lane-order policy are the natural next step, and `d03v`'s M10 run is what turns this recommendation
into a decision.

### What a polished 2D dashboard would lose

If the same information lived in a polished 2D dashboard — the board, the DAG, the live window, the
lane strip — the operator would lose **one thing, not a list**: a single, persistent spatial map of
the whole run that stays put while one worker is framed, so *where the work is*, *how many workers
are in flight*, and *which of them the surface is pointing at* are answered by the same view at the
same time. A 2D dashboard answers each of those well on its own (a lane strip for concurrency, a
board or DAG for position, a hero header for the primary) but not simultaneously without scrolling,
collapsing or a minimap that is itself a small spatial widget. Everything the deck's *text* says —
status, stage, lane, reason, the last five meaningful rows — a 2D surface can say equally well and
more densely, and everything about *inspection* (diffs, gates, reviews, prompts, exact payloads) a 2D
surface does better; those are the parts the deck must not try to win. Transitions and history, the
other two candidates, are not yet built here (`d05`, `d07`), so today the spatial representation's
measurable contribution is comprehension of concurrency and focus — worth continuing for an operator
who watches several workers at once, and worth nothing much for an operator who watches one worker
and reads its log.

---

## d04 — multi-worker command centre

Reproduce everything below with:

```bash
bun run web:build
bunx playwright test tests/e2e/deck.e2e.ts --workers=1 --reporter=list      # the numbers the specs print
DECK_IDLE_MS=20000 bunx playwright test tests/e2e/deck.e2e.ts -g "idle deck" --reporter=list
bun test tests/deck-lanes.test.ts tests/deck-model.test.ts tests/deck-focus.test.ts
bun run test:e2e                                                            # all surfaces, parallel
```

Raw artifacts: `captures/deck-validation/d04-stations.json` (hook snapshot: stations, lanes, focus
switch, pan, marker activation), `captures/deck-d04-stations.png` (three live workers),
`captures/deck-d04-focus-switch.png`, `captures/deck-d04-markers.png` (all three off screen, three
markers), `captures/deck-d04-marker-focus.png`. The artifacts are taken with a throwaway Playwright
script against the same fixture server (`bun tests/e2e/serve.ts`) the specs use; the numbers in
them are the ones the specs assert, and the script is not part of the suite.

### Bundle

| Artifact | d03 | d04 | Δ |
|---|---|---|---|
| `assets/Deck-*.js` (the deck + `three`) | 566.64 kB / 145.05 kB gzip | 572.43 kB / 147.04 kB gzip | **+5.8 kB / +2.0 kB gzip** |
| `assets/index-*.js` (the dashboard shell) | 455.25 kB / 137.36 kB gzip | 455.25 kB / 137.36 kB gzip | **0** — the dashboard is untouched |
| `assets/index-*.css` | 85.61 kB / 15.24 kB gzip | 86.83 kB / 15.40 kB gzip | +1.2 kB (markers, lane-row columns, the measured HUD offset) |

The dashboard's chunk and the shell's behaviour are byte-identical to `d03`: this slice is additive
by construction (one pure module, `scene/lanes.ts`, plus the scene and overlay work it drives).

The `d03` product run (`tests/e2e/deck-workflow.e2e.ts`, its own harness and its own run) re-ran
green against the `d04` bundle in both venues — its per-step numbers are in the `deck-d03 step N ok`
lines of that run, and they are unchanged in shape (station stage grows across the handoff, the
window stays bounded, 2 038 lines render 0 frames). Its committed artifacts
(`captures/deck-validation/d03-*.json`, `captures/deck-d03-workflow.png`) are deliberately left at
the run they were reviewed with, so the `d03` record does not drift; the spec rewrites them on every
run.

### 1. N workers as N stations (brief §1)

`AgentRow.lane` is the server's dense index over the live set in board order (`src/server.ts`), so
"lane order" and "board order" are the same order, and the primary is by definition first in it.
The fixture run has three live workers; measured through the debug hook and the DOM:

| Property | Measured |
|---|---|
| stations drawn | `stations` 3 · `stationMarks` 7 · `stationOverflow` 0 · `liveCount` 3 |
| the marks are the workers' stages | `longtitle` 2 (Work), `verifying` 3 (Verify), `running` 2 (Work) — `stageSegments`, from `buildPipelineStages`/`currentStageIndex` |
| identity per row | `● longtitle running Work L0 · g0 · a1` + its `heroAction` line, then `○ verifying verify… Verify L1 …`, `○ running running Work L2 …` (screenshot crop, 2× scale) |
| one primary, unmistakable | the focused station's pad and column at full brightness + the selection ring + `command` framing; the two secondaries at 0.6 in colour only (`d03`'s rule: height is status information) |
| HUD | `live: 3 · showing longtitle` |
| every worker accounted for | `.omp-deck-lane` count = `liveCount`, and after panning the camera off the rail: `offScreen` = all three ids, one `.omp-deck-edge[data-slice-id=…]` button each |
| a marker is actionable | clicking `longtitle`'s marker → `focused` = `longtitle`, `cameraPreset` back to `command`, `target` = that station's own `(x, z)`, `screenPosition("longtitle")` non-null, the marker gone |

What the scene gained over `d03`: the station column is now drawn for **every** live worker, not
just the focused one, so "how many are running" and "how far along is each" are readable from the
floor itself. The instance count is therefore independent of focus (`d03`'s finding 3, closed):
switching focus rewrites colours and nothing else.

### 2. Focus is not camera (brief §2)

`d03` fused them: `[`/`]` and a lane click pinned *and* framed. `d04` splits them — lane rows and
`[`/`]` move the focus, `F` and an edge marker move the camera. Measured:

| Action | Result |
|---|---|
| `]` (focus → the next live worker) | `focused` changed, the live window followed (`aria-label` ends in the new id), `.omp-deck-lane[data-focused="true"]` moved — and the camera JSON is **byte-identical** to before the keypress |
| the same switch, scene cost | `instances` 19 → 19, `stationMarks` 7 → 7, `geometries` 7 → 7, draw calls ≤ 8; 1 frame (2.9–27.8 ms across runs) |
| `F` afterwards | camera flies to that station: `target` = its `(x, z)` within 1e-3, distance < 20 |
| pan (`Shift+ArrowRight` × 10) | no pad moved (`positions` identical), `offScreen` grew to the 3 live workers, 3 marker buttons appeared |
| marker click | focus + frame in one action, and the marker disappears once the worker is on screen again |

The camera policy is unchanged otherwise: it still auto-frames the primary when nothing is pinned
(`d03` restriction 4), and `Esc`/`F`/`C`/`0` remain the ways to take it back.

### 3. The tier cap, and what happens past it (brief §5)

`stationSlots` (pure, `tests/deck-lanes.test.ts`) assigns one pool entry per live worker in lane
order, clamps a malformed lane, resolves a collision by walking to the next free entry, and turns
workers past `tier.maxStations` into `stack` entries. The model reports both the count
(`stationOverflow`) and any repair it had to make (`warnings`, rendered in the HUD). The scene draws
one dim mark per overflow worker beside the last pool entry, capped at 4, so a full pool still says
"there are more" on the floor.

**Honest limit:** every part of that path is proven at the unit/model level and in the HUD's
rendering code — not in a browser, because the fixture has three live workers and the smallest tier
holds eight. `stationCountLabel(live, pooled)` is unit-tested; the browser evidence for the cap is
`stationOverflow` 0 with `stations` 3 (i.e. "no overflow happened here"). A run with more workers
than the tier holds has never been rendered on this machine.

### 4. What the capture caught: the HUD covered the primary lane row

The first capture of a *three-worker* deck (not of a one-worker one) showed the lane strip's first
row — the focused worker — behind the HUD's second line: the HUD row wraps when the window is
narrower than its chips, and the station line and lane strip were placed at a fixed `top: 44px`
that assumed a 34 px HUD. Measured after the fix (`getBoundingClientRect` in the same fixture):
HUD height 68 px, HUD bottom at y = 143, lane strip top at y = 151, first row fully visible. The
offset is now `calc(10px + var(--omp-deck-hud-h) + 8px)`, where the deck measures the HUD with a
`ResizeObserver` and writes the value on the section. Cost: one style write per HUD height change
(never per frame, never while idle).

This is the kind of defect a single-worker review cannot see: with `liveCount` 1 the strip is one
row and the overlap looks like a margin.

### 5. Cost on the minimal tier (brief §8)

Minimal (SwiftShader, 0.5× backing, 30 fps cap), 1440 × 900 CSS, three live workers:

| Window | frames | frame p50 / p95 / worst | commits/s | mutations/s | long tasks |
|---|---|---|---|---|---|
| idle 2 s | **0** | — | 0.2 | 0 | 0 |
| idle 20 s | **0** | — | 0.29 | 0 | 0 |
| interaction (resize + HUD) | 4 | 0.9 / 5.0 / 5.0 ms | 2.77 | 10.7 | 12 (209 ms) |
| one real status change | 1 | 1.6 ms | — | 5 | 1 (90 ms) |
| focus switch (`]`) | 1 | 7.8 ms | — | — | — |
| 5 s of transcript growth (fixture quiet) | **0** | — | 0.38 | 0 | 0 |
| the three live workers | — | — | — | — | instances 19 (= 9 pads + 3 markers + 7 station marks), objects 26, draw calls 7, geometries 7, 564 vertices, 238 068 px canvas |

Spread, two serial runs (the box was also running a foreign `ompo -p` worker during both, load
average 6–11 — this is a shared machine, and the review quotes the run it can point at): interaction
p50 0.9–1.5 ms, p95 2.0–5.0 ms, long tasks 1–12; the focus-switch frame 2.9–27.8 ms (one frame per
keypress, decided by box load); the idle windows **0 frames in every run**. The frame budget
(`minimal`: p50 ≤ 33 ms, p95 ≤ 45 ms) held in every window with an order of magnitude to spare.

`d03`'s fixture drew 14 instances / 21 objects; `d04` draws 19 / 26 for the same roadmap because the
two other live workers now carry their own stage marks (+7 marks, −2 for the single focused shaft).
At the measured ≈53 µs per object that is ≈ +0.15 ms of frame cost on a 22 ms allowance, and the
budget document's worst case is updated accordingly (stations ≤ 8 × 4 + 4 objects on `minimal`).

The `]`-switch frame is the largest single frame this slice produces (2.9–27.8 ms across two runs:
it rewrites the station instances' colours and re-renders the readout). It is one frame per
keypress, not a trend, and the p95 of the whole interaction window stays at or below 5.0 ms.

### 6. Degraded operation (brief §9)

| Case | Result |
|---|---|
| runtime tier change (`T` → `standard`) | same GL context (`mounted` unchanged), same stations, `instances` 19 → 19, `stationSegments` unchanged; the pool is allocated once for the `high` cap, so a tier change re-caps what is drawn, never what is allocated |
| no WebGL2 at all | the notice says what is lost; the station line, the complete lane list (3 rows) and the window survive; `offScreen` is empty because there is no camera (the flat projection is `d09`'s) |
| tier `minimal` at 0.5× | the lane rows, the station line, the columns and the markers are all readable at 612 × 389 backing (screenshots) |

### 7. Where the deck wins, where it loses (brief §6)

**Wins (measured).** Concurrency as simultaneous presence: three workers are three objects in one
view, one of them framed, with per-worker stage marks and no list scrolling; the operator can move
between them without losing the view they were reading (`]` leaves the camera alone); a worker the
camera cannot see still has a marker pointing at it, and clicking the marker is one action.

**Losses (measured or structural).**

- The lane list is a list, and at three workers it is *denser* in the dashboard: `WorkerLanes` shows
  the same facts in the same order and does not need a camera. The deck's advantage is the floor,
  not the rows; the rows exist so the floor is never the only way to reach a worker.
- Markers only exist for **live** workers. A pinned terminal slice that is off screen has no marker
  and no lane row — its only handles are the pad list and the camera keys. Same for any slice that
  is not live: the deck's edge layer is a worker-awareness device, not a "find anything" device.
- The station column encodes the stage in four marks over seven pipeline steps, so it says "how far
  along", not "which phase". The exact phase is the lane row's (and the station line's) job.
- A verifying worker's marks are amber (live phase colour) while its pad is cyan (status colour):
  deliberate, since the pad must keep the roadmap's palette, but it is two colours for one worker.
- `AgentRow.lane` is a per-poll index, not a durable id. The deck orders stations by it (and hence
  by board order); if the server ever redefines lanes, the deck's order follows the dashboard's
  lane strip rather than inventing its own — the intended coupling, but it is a coupling.
- Everything in `d03`'s loss column that `d06`/`d07` own is unchanged: diffs, gate output, review
  findings, prompts, event history.

### 8. Open findings (carried into `d05`)

1. **The overflow path has no browser evidence** (§3). The cheapest fix is a fixture with more live
   workers than `minimal` holds (9+), which is a fixture change, not a scene change.
2. **The station column has no "appeared/disappeared" transition.** The roadmap's `d04` sketch asked
   for a ≤ 200 ms scale+opacity tween; this slice deliberately does not animate state changes (the
   handoff's transport-latency restriction: animation must not fabricate state), so a worker
   appearing is an instant appearance. `d05` owns transitions and the reduced-motion rule for them.
3. **A wedged station's pattern is one displaced mark** (its top mark steps sideways, in amber). It
   survives greyscale and costs no instance, but it has not been seen in a real run: the fixture has
   no wedged worker (the server flags one after 10 minutes of transcript silence).
4. **The HUD/lane overlap was found by capture, not by test** (§4). A layout assertion (no overlay
   rectangle covered by the HUD) would catch the next one; today the guard is the screenshot.
5. `d03` restriction 4 stands: the camera still follows the primary when unpinned.

### Acceptance criteria (d04)

| Criterion | Result |
|---|---|
| 1. Three live slices → three stations, HUD `live: 3`, lane list in `AgentRow.lane` order | ✔ `stations` 3 · `stationMarks` 7 · `liveCount` 3; rows `longtitle`/`verifying`/`running` (L0/L1/L2); HUD `live: 3 · showing longtitle` |
| 2. Focus switch updates the window and the highlight, `geometries`/`objects` unchanged | ✔ `aria-label` + `[data-focused]` follow the focus; `instances` 19 → 19, `stationMarks` 7 → 7, `geometries` 7 → 7 (the `d03` deviation is gone) |
| 3. The camera moves only on `F`, a primary change while unpinned, or operator input | ✔ `]` → camera JSON byte-identical; `F` → target = the station's own coordinates; pan/zoom are the operator's |
| 4. Every off-screen live worker has a marker or a lane row | ✔ after panning: `offScreen` = 3/3, one marker button each, all three lane rows present; marker click focuses and frames |
| 5. Over the tier budget: HUD reports the overflow, no allocation past the pool | ✔ at the model/unit level (`stationOverflow`, `stationCountLabel`, `stationSlots` overflow tests, one pooled buffer sized once); no browser run has exercised it (finding 1) |
| 6. Gates clean | ✔ `bunx tsc --noEmit`, `bun test` (719), `git diff --check`, `bunx playwright test tests/e2e/deck.e2e.ts --workers=1` (25 passed), `bun run test:e2e` (44 passed), workflow spec (2 passed) |

### Verdict

**PASS — recommendation, not a decision** (`docs/desktop-3d-roadmap.md` §0.5 rule 1: the operator
fills in the decision block at `d03v`). Multi-worker concurrency is what the spatial representation
was for, and it holds at the scale this machine can run: three stations, one primary, per-worker
stage marks, focus that moves without the camera, and no worker that can be lost off screen. The
scene's cost grows with the worker count in instances only (one pooled mesh, ≤ 4 marks each) and
the focus path is now free of geometry churn.

Restrictions, in the order they would bite:

1. **The overflow path is unproven in a browser** (finding 1): it is a policy with unit tests, not
   a behaviour anyone has seen. A `--jobs 9` run (or a fixture that claims nine slices) is what
   turns it into evidence.
2. **Transitions are still absent on purpose** (finding 2): a worker appearing, changing stage or
   finishing is an instant change. `d05` owns the choreography, and it must respect the transport
   constraint: animate the transition, never the state.
3. **Alert visibility is still `d05`'s**: the wedge pattern and the `stalled` row are the only
   failure-ish signals a live worker can show, and they are not yet the unmissable alert stack.
4. **M10 is still owed** (`d03v`): this slice did not run the timed workflow comparison, and the
   concurrency claim here is structural + instrumented, not human-timed.

Continue to `d05` (lifecycle choreography and alerts) under those restrictions: the scene now knows
who is running and who is pointed at; the next question is what a change *looks* like.

### What a polished 2D dashboard would lose

A 2D dashboard can list concurrent workers better than the deck can — `WorkerLanes` already does,
densely and in the same order. What it cannot do is make concurrency *spatial*: three workers as
three objects standing on the roadmap they are working through, one of them framed, the others
still present in the same view, with a marker pointing at whichever one is out of shot. The
operator's question "how many are running, and where" is answered by looking, not by reading a
count and then locating each id on a board. That advantage is bounded and honest: it needs a
camera, it needs the pads to be legible at 0.5×, and it is worth nothing for a one-worker run —
which is exactly why the lane list, the station line and the live window are DOM and behave like
the dashboard's own.

---

## d05 — lifecycle choreography and alerts

Reproduce everything below with:

```bash
bun run web:build
bun test tests/deck-alerts.test.ts tests/deck-deltas.test.ts tests/deck-churn.test.ts
bunx playwright test tests/e2e/deck-transitions.e2e.ts --workers=1 --reporter=list   # the five bursts
bunx playwright test tests/e2e/deck.e2e.ts --workers=1 --reporter=list              # the surface specs
bun run test:e2e                                                                    # all surfaces, parallel
```

Raw artifacts: `captures/deck-validation/d05-transitions.json` (every scenario: the delta batch the
deck recorded, cue peaks sampled at rAF cadence, and a windowed instrument sample per burst),
`captures/deck-d05-transitions.png` (the simultaneous burst), `captures/deck-d05-transitions-reduced.png`
(the same deck with motion off), `captures/deck-d05-alerts-rail.png` (the whole rail with two
alerting pads, taken with a throwaway script against the shared fixture — the view where the ring
pattern has to survive competition). The transition run owns its own project, its own run
(`d05-transitions`) and its own server (`tests/e2e/deck-workflow-harness.ts`, port 4481); the shared
fixture over port 4319 carries the alert-stack assertions, because it always has an alerting slice.

### Bundle

| Artifact | d04 | d05 | Δ |
|---|---|---|---|
| `assets/Deck-*.js` (the deck + `three`) | 572.43 kB / 147.04 kB gzip | 586.26 kB / 151.22 kB gzip | **+13.8 kB / +4.2 kB gzip** |
| `assets/index-*.js` (the dashboard shell) | 455.25 kB / 137.36 kB gzip | 455.26 kB / 137.36 kB gzip | +0.01 kB |
| `assets/index-*.css` | 86.83 kB / 15.40 kB gzip | 90.55 kB / 15.88 kB gzip | +3.7 kB (the alert stack, the banner, the deck's motion switch) |

Two new pure modules (`alerts.ts` 293 lines, `deltas.ts` 121 lines) and the renderer's cue engine are
the whole of the deck-side growth. The dashboard's chunk moves by ~10 bytes — the shell names the
lazy deck chunk, so a new chunk hash shows up there and nowhere else; no dashboard code changed.

### 1. The transition contract: state first, cue second

The brief's rule for this slice is "never fabricate state", and it decides the whole design:

```
application state (DTO)  ──►  model (pure projection)  ──►  semantic scene state   ← switches at once
                                                             │
                                                             └─►  cue (decaying highlight)  ← may animate
```

`renderer.applyModel(model, deltas)` writes the model's own values **first and unconditionally**
(status colour, pad height, stage-mark count, beacon set), then turns the deltas into *cues*:
one cue per entity (`cueEntity` in `deltas.ts`), bounded at 48, dropped
when they expire. A cue can only *add*: a pad's new status colour brightened toward the focus token
and decaying back to it (≤ 320 ms; 200 ms on `minimal`; **0 on reduced motion, where no cue is
created at all**), a newly filled stage mark growing from 35 % to its height, a beacon scaling in on
arrival and out from where it stood when cleared. No pad height, no status colour and no mark count
is ever interpolated *between* two states — there is no frame in which the scene shows a state the
model is not in, which is exactly what makes a dropped or late animation a cosmetic problem rather
than a lie.

Deltas come from `diffModels(prev, next)` — pure, and emitted only when the digest moved, so an
event that changes nothing scene-visible produces none. `attempt` deltas (a generation handoff) are
recorded and animate nothing: `d03` measured that a handoff buys zero frames, and `d05` keeps it
that way (`sceneDeltas` filters them; the unit test pins it).

Measured, across five scenarios: `tweens` peaks at 1–4 and returns to **0** in every one — the
counter identity that says nothing was queued, delayed or left painted. `sceneWrites` (instance
buffer rewrites) moves 3–26 per scenario, i.e. one per model application plus one per animated
frame, and nothing at all while nothing changes.

### 2. Scenario A — one worker: Work → Verify

`alpha` is claimed and then `workerFinished` lands (`storeApi.workerFinished`), through the real
SSE path (900 ms poll) into the deck:

| Metric | Value |
|---|---|
| the deck's own delta record | `[{status, alpha, running → verifying}]` — one change, one worker |
| lane row after | `alpha · verifying · Verify` |
| peak cues / animated entities | 1 / 1 |
| frames in the window | 4 (p50 2.8 ms, p95 4.9 ms, worst 4.9 ms) |
| commits / DOM mutations | 4 / 16 · 0 long tasks |
| instance count | 20 → 21: the station grew **one stage mark** (13 → 14 marks overall) |
| geometry | `geometries` 8 → 8, `drawCalls` 6: no rebuild, no reallocation |
| pads moved | **no** (`positions` byte-identical) |
| event → visible | 577 ms total: transport 540 ms, DOM 37 ms, model 78 ms, scene 109 ms (the stage clocks overlap; the model build and the frame land inside the poll's shadow) |

### 3. Scenario B — three workers at once (the case this slice exists for)

One store tick, three transitions, one model change:

```
zeta:  running  → verifying        (Work → Verify)
beta:  running  → blocked-env      (Work → Blocked)  + its high alert
gamma: verifying → done            (Verify → Complete)
```

| Metric | Value |
|---|---|
| delta batch (one application) | `[status beta running→blocked-env, status gamma verifying→done, status zeta running→verifying, alert beta blocked-env]` |
| peak cues / animated entities | 4 / 3 — three independent cues plus the beacon arrival, **not** a queue |
| lane rows after | `zeta · verifying`, `beta` and `gamma` left the live set; the mirror says `gamma · done` |
| alert stack after | `beta · high · blocked-env · "port 5432 refused — the environment is not up"` |
| frames in the window | 3 (p50 4.4 ms, p95 = worst 9.3 ms) |
| commits / DOM mutations | 7 / 25 · 0 long tasks |
| instances / objects | 21 → 21 / 27 → 29: beta's and gamma's stations left the pool, zeta's grew a mark, beta's two markers and the beacon's two rings arrived |
| geometry | `geometries` 8 → 8, `drawCalls` 8 (markers + beacons) |
| pads moved | **no** — station identity survives three simultaneous state changes |
| event → visible | p50 645 ms (transport 607–608 ms over 4 records; DOM 38 / model 123 / scene 150 ms) |

The three transitions are separable because each is its own entity: the worker's pad pulse, its
station's mark, and the alert's rings all animate on their own clocks, and the delta record names
each transition with its `from`/`to`. Nothing was serialised to make the result easier to film.

### 4. Scenario C — an alert while another worker is focused

`delta` is pinned and framed; `alpha` (a *different* worker) fails its gate.

| Metric | Value |
|---|---|
| delta record | `status alpha verifying→failed`, `alert alpha failed`, `alert-cleared alpha verify-failed` |
| focus / camera | `focused = delta`, `pinned = delta`, camera JSON **byte-identical** across the alert |
| stack after | `alpha · high · failed · "gate bun test failed — 2 tests"` above `beta`'s blocked-env |
| peak beacons | 5 rings across the window (alpha's 2, beta's 2, the transient verify-failed's 1) |
| frames / commits / mutations | 3 (p50 4.1, p95 = worst 15.8 ms) / 7 / 25 · 1 long task (96 ms) |
| event → visible | p50 735 ms (transport 711–717 ms of it) |

The poll caught the *intermediate* state here — `verify_failed` raises a medium alert for one
cadence, then the terminal failure replaces it with a high one (the deck reported both, in order).
That is the transport's granularity, read honestly, and it is also the first evidence that alert
replacement works: the medium beacon left as the high one arrived.

### 5. Scenario D — the focused worker completes, and the focus policy, stated

Policy, in the deck's own terms (`focusTarget`, `d03`, unchanged by this slice):

1. **Pinned** (the operator pressed `F` on this worker): focus **stays** on that slice. Its station
   leaves the pool because it is no longer live, the pad shows `done`, and the camera does not move
   — a pin exists precisely to stop the view following the work. `Esc` releases it.
2. **Unpinned**: the focus target recomputes to the live primary — `preferredSliceId`'s ranking
   over the live set, i.e. the same slice the dashboard's board and the TUI's cursor would pick,
   never "whatever is first in the array". The camera follows it, because that is `d03`'s documented
   auto-follow while nothing is pinned.

Measured: pinned → `focused` still `epsilon`, camera byte-identical, one cue, 3 frames (p50 1.0,
p95 = worst 12.5 ms), event→visible 840 ms (816 of it transport — a full poll interval on a busy
box). Released (`Esc`) → focus moved to `zeta` (the live set was `zeta`, `delta`), the camera moved,
and the lane row `zeta` carries `data-focused="true"`.

### 6. Scenario E — reduced motion: the same change, no cue at all

`M` sets `motion: reduced` (persisted in `ompo.deck.prefs`, shown in the HUD, and published as
`data-motion="reduced"` so the DOM's own row motion stops too). Then a live worker fails
(`running → failed` plus a high alert) in one model change:

| Metric | Value |
|---|---|
| peak cues / animated entities | **0 / 0** — not "fast", none |
| the change itself | stack gained `delta · high · failed · "gate bun test failed — 2 tests"`; the lane row left the live set |
| frames | 2 (p50 1.1 ms, p95 1.2 ms), commits 4, DOM mutations 21 |
| event → visible | p50 365 ms (transport 348 / DOM 17 / model 22 / scene 24 ms) |
| HUD | `motion: reduced`, `transitions 0 cues · 0 entities` |

### 7. Alerts: multi-channel by construction

`deriveAlerts` implements §D.8 exactly, from the DTOs the server already produces: `failed` (high),
`blocked-env` (high), `wedged` (high, from `AgentRow.wedged`/`staleForMs`), `double-loop` (high,
run-level), `verify-failed` (medium, from the newest `verify_failed` event while the slice is live
or queued), `review-rejected` (medium, from `SliceDetail.review`), `verdict-stall` (advisory, from
`SliceDetail.verdictStall`, worded "gates idle", never "stuck"). One condition is one alert however
many events produced it, and severity is expressed on four channels at once:

| Channel | How |
|---|---|
| shape/pattern | rings around the pad: **two** concentric for high, **one** for medium, one nested and smaller for advisory — legible in greyscale |
| position | the rings circle the *worker's own pad*, so an alert is where the work is |
| text | the stack row: severity word + glyph (`!!` / `!` / `i`) + slice id + one line of the store's own reason |
| colour | red / amber / violet, redundant with all of the above |

Dismissal is per alarm instance (`runId|sliceId|kind|lastSeq`, stored in
`localStorage["ompo.deck.dismissed"]`), so acknowledging a condition clears that alarm and a
recurrence — a second failure, a later wedge — raises a new one. There is deliberately no "dismiss
all". Beacons are capped by `tier.maxBeacons` with overflow counted in the HUD
(`alerts: N · M over the beacon cap`) while every alert keeps its stack row. Measured on the shared
fixture: 2 alerts → 4 beacon rings → `instances` 23, `objects` 31, `drawCalls` 8; with no alert or
marker drawn the same scene issues 6 calls, so the beacon mesh costs one draw call *only* while a
ring is up (an empty instanced mesh is skipped by the renderer).

Two honest limits: `review-rejected` and `verdict-stall` read `SliceDetail`, which the shell fetches
for the *selected* slice, so those two kinds cover the slice the operator has open until `d06`'s
dock fetches on demand; and a `blocked-env` slice has no `reason` in the run record, so the message
comes from the event that parked it (`slice_blocked_env.detail`) rather than from a field that does
not exist.

### 8. What the deck does worse, and open findings

1. **The transport still owns the clock.** Event→visible was 196–816 ms in these windows, and 180–742
   of those milliseconds are the 900 ms store poll; the deck's own stages are 16–525 ms and the
   scene is never the largest. Nothing here justifies changing the transport, and nothing here can
   beat it — the honest statement is that a state change can be *up to a poll interval old* before
   the deck even hears about it. Transitions are choreographed inside that budget, not around it.
2. **An instrument defect this slice found and fixed.** The reduced-motion window read
   `mutations: 0` while its alert row demonstrably appeared (the other windows read 16–44). Cause:
   `instrument.stop()` detaches the `MutationObserver`, and a renderer rebuild — which pressing `M`
   now causes, through the context key — stops and restarts the instrument without re-attaching, so
   the mutation count and the element census **freeze at their last value for the rest of the
   session**. Fixed in `instrument.ts` (`start()` re-attaches to the element the deck promised to
   watch), unit-tested, and re-measured: the same window now records 21 mutations. Earlier slices'
   mutation figures are unaffected — the rebuild path only became reachable from a key (`M`) here.
3. **Long tasks are the box.** 0–2 per transition window (worst 96 ms) on a machine also running
   Chromium, the fixture server and Playwright. Scenario A's pre-fix runs showed up to 4 (worst
   194 ms) while the window still contained page-load work.
4. **The station's mark count is part of the state, so it changes.** A status change moves
   `instances` by ±1 (the column grows a mark) — this is the information, not churn, but it means
   `instances` is no longer a constant across a transition the way it is across a focus switch.
5. **`attempt` deltas animate nothing.** A generation handoff is recorded and drawn as nothing at
   all. Deliberate (`d03`'s zero-frame property), but a handoff is a real transition and the DOM
   shows it only in the lane row's `g` counter.
6. **`review-rejected`/`verdict-stall` cover one slice** (the selected one) until `d06` fetches
   detail on demand — noted in §7.
7. **The beacons have not been looked at by a human on a real screen.** They are measured
   (rings 2/1/1 at 0.94–1.22 scale, one instanced mesh, no idle frames) and captured in the
   screenshots, but "is the pattern obvious at 0.5× on a busy deck" is a judgement this file cannot
   make for the operator.
8. **Row motion settled.** `.omp-live-row` enter/leave was 320 ms / 220 ms against the roadmap's
   ≤ 150 ms row budget (§D.6). `d05` settled it at **150 ms in / 120 ms out** in `theme.css`, for the
   deck and the dashboard alike, since they share the component.

### 9. Acceptance criteria (d05)

| Criterion | Result |
|---|---|
| 1. For `slice_claimed → worker_finished → verify_failed → slice_retried`, the deck applies those states in order and reports 0 queued tweens at the end | ✔ `tests/deck-deltas.test.ts` (running → verifying → done as one delta per step) and every measured scenario ends at `tweens: 0` |
| 2. A failed slice produces exactly one high alert with its `reason`; dismissing removes the row and the beacon; a new failure re-raises | ✔ unit: one alert per condition, dismissal key includes the evidence seq; browser: the row appears with the store's words, dismissing removes row **and** beacon, the dismissal survives a reload; recurrence re-raises by key (unit) |
| 3. With reduced motion, no tween runs for any transition and the stack behaves identically | ✔ scenario E: `maxTweens 0`, `maxAnimated 0` across a real `running → failed` + alert; HUD `0 cues`; the stack row is identical |
| 4. Beacons never exceed `tier.maxBeacons`; overflow is counted in the HUD and the stack lists every alert | ✔ by construction (`beaconAlerts = alerts.slice(0, maxBeacons)`, HUD `alerts: N · M over the beacon cap`) and unit-tested ordering; no browser run has exceeded a cap |
| 5. The alert stack never overlaps the live window | ✔ e2e: bounding-box disjointness asserted on the shared fixture (`.omp-deck-alerts` vs `.omp-deck-live`) |
| 6. Gates clean | ✔ `bunx tsc --noEmit`, `bun test` (747 pass / 0 fail, 57 files), `git diff --check`, `bunx playwright test tests/e2e/deck.e2e.ts --workers=1` (27 passed), `bunx playwright test tests/e2e/deck-transitions.e2e.ts --workers=1` (1 passed, 5 scenarios), `bun run test:e2e` (48 passed) |

### 10. Verdict

**PASS — recommendation, not a decision** (`docs/desktop-3d-roadmap.md` §0.5 rule 1: the operator
fills in the decision block at `d03v`). The slice's own success criterion — *can an operator glance
at the deck during active work and correctly identify meaningful state transitions across several
concurrent workers without reading the underlying logs* — is answered **yes, with one measured
caveat**: yes, because every transition is reported by the deck as a named delta (worker, from, to),
drawn on the worker's own pad, and separately for each worker in a burst of three; the caveat is the
poll — event→visible ran 365–840 ms in these windows, 348–818 ms of it transport, so a change can be
a poll interval old before the deck has it. "Glance and see it now" is really "glance and see the
last poll". What the deck must not do — animate a state it does not have, move
a station because its status changed, or let an alert depend on colour — it demonstrably does not.

Restrictions, in the order they would bite:

1. **The transport is the ceiling** (finding 1). Anything that needs sub-second comprehension is a
   transport question, and this slice deliberately did not touch it.
2. **The beacon pattern is unverified by human eyes** (finding 7): the numbers and the captures are
   in hand; the aesthetic judgement is not.
3. **Two alert kinds cover one slice each** (finding 6) until `d06` fetches detail on demand.
4. **M10 remains owed** (`d03v`): the timed deck-vs-dashboard-vs-TUI comparison still has not run.

### 11. What a polished 2D dashboard would lose

A 2D dashboard can absolutely show transitions: a row that changes colour and appends a line does
it. What it cannot show is *where* the change happened and *which* of several simultaneous changes
belongs to which worker in one glance — the deck's answer is that each worker owns a place, and a
change happens *at that place*: the column grows a mark, the pad brightens on its own colour, and a
ring pattern appears around the pad that is in trouble. Three workers changing state at once is
three places changing, not three rows mutating in a list you have to re-read. The advantage is
bounded: it needs the pads to be legible (they are, at 0.5×), it needs the camera to be pointed
somewhere useful (the off-screen markers and the lane list cover the rest), and for a single worker
the dashboard's row is still the cheaper place to read the same fact.

---

## d06 — inspection dock over the existing endpoints

The slice's question was a boundary, not a feature: *can an operator move from the spatial overview
to precise inspection and back without losing spatial context, while the 3D layer stays cheap and
the 2D inspection experience stays the dashboard's own?* The answer is **yes**, and the evidence is
that the dock is literally the dashboard's `Inspector` (byte-identical content on all eight tabs),
that 40 open/close passes leave the camera, the selection, the digest and the GL geometry exactly
where they were, and that the scene issues zero frames, zero DOM mutations and zero instance-buffer
writes while the dock is up and nothing is happening. The boundary this slice draws is the product
decision `d03`–`d05` had been building toward: **3D selects and orients; 2D inspects.**

### Bundle

| Artifact | d05 | d06 | Δ |
|---|---|---|---|
| `assets/Deck-*.js` (the deck + `three`) | 586.26 kB / 151.22 kB gzip | 589.48 kB / 152.20 kB gzip | **+3.2 kB / +1.0 kB gzip** |
| `assets/index-*.js` (the dashboard shell) | 455.26 kB / 137.36 kB gzip | 456.02 kB / 137.62 kB gzip | +0.8 kB (the inspector's exported tab list, the shell's `onControlDone`) |
| `assets/index-*.css` | 90.55 kB / 15.88 kB gzip | 93.06 kB / 16.30 kB gzip | +2.5 kB (the dock, the two overlay bands, the Inspect affordance) |

The deck's growth is one new component (63 lines), one pure state module (86 lines) and the CSS
that makes room for the panel. Nothing on the GPU side changed: no new scene object, no new draw
call, no new geometry — the dock is pure DOM, by construction.

### 1. The boundary, stated and enforced

Three kinds of state, and where each one lives:

| Category | Owner | In this slice |
|---|---|---|
| **Domain state** | ompo (`App.tsx` + the store, over the existing endpoints) | run detail, slice detail, events, agents |
| **Spatial state** | the deck (camera, selection, focus, hover, viewport framing) | unchanged by the dock |
| **Inspection UI state** | the dock (the 2D surface) | scroll, `<details>`, filters, the control form — plus the active tab, which the deck shell holds *only* so `1`…`8` and `Esc` can address it |

The one thing the spatial layer says to the inspection layer is *which slice the operator selected*
(`onInspect`). The dock receives no renderer, no camera and no scene model; `DeckInspector.tsx`
imports `Inspector` and nothing else — it renders with the canvas absent (the flat path already
renders it) and under test without WebGL. Log fetching, diff parsing, verification output, review
findings and prompt history stay where they already were.

Neither the dock's openness nor its tab enters `DeckModel`: the digest is asserted identical across
20 open/close cycles, and *even a model change cannot be caused by dock state* — the projection
never sees it.

### 2. The dock is the dashboard's inspector (acceptance 1)

Measured on one run, one slice, both surfaces (`deck-inspector.e2e.ts`, scenario 1): the dock is
opened on each of `1`…`8`, the panel text is captured, then the dashboard's own inspector is opened
for the same slice and each tab is compared after whitespace normalisation.

| Tab | chars | identical |
|---|---|---|
| Output | 413 | ✔ |
| Diff | 164 | ✔ |
| Verify | 94 | ✔ |
| Review | 176 | ✔ |
| Prompt | 223 | ✔ |
| Events | 278 | ✔ |
| Usage | 325 | ✔ |
| Log | 117 | ✔ |

The test also asserts the dock holds the real widgets (`Inspector`'s `.omp-inspector-panel` and
`.omp-tabs`), so "same text" cannot be satisfied by a lookalike. `Inspector.tsx` changed by 15 lines:
the tab list is exported (the keymap addresses it by position, one source for both) and the tab is
controllable — the dashboard passes nothing and behaves exactly as before.

One deliberate deviation from this slice's written spec: the roadmap's error behaviour asks for
`ui/skeleton.tsx` while `SliceDetail` loads. The dashboard's inspector does not render a skeleton —
it renders the same views with `detail === null`, and each view owns its own empty/loading copy — so
the dock does exactly what the dashboard does (passes `detail` through) rather than introducing a
skeleton only the deck shows. Matching the dashboard beats matching the spec's description of it.

### 3. Opening, resizing, returning (acceptance 3, 4; brief §5)

**Open.** The dock's own latency is instrumented (`recordInteraction`), measured from the intent to
the second animation frame after the commit — the first frame the operator can see it in. Across the
runs of this slice:

| Interaction | p50 | p95 | worst |
|---|---|---|---|
| `inspection-open` (20 samples/run) | 92–172 ms | 155–389 ms | 254–805 ms |
| `inspection-close` (20 samples/run) | 101–281 ms | 153–1409 ms | 209–1409 ms |
| `inspection-tab` (single samples) | 69–180 ms | — | — |

The spread is the machine, not the dock: this box was carrying other work (an eslint run, a second
Chromium, another agent) during every measurement window, and the `d00` rule — a single sample is
not evidence — is why the table is a range. The deterministic measures agree with each other and are
stable across runs: keydown → the dock is in the DOM at **36–72 ms**, and keydown → the canvas
backing store has been resized at **219–290 ms**.

**Resize.** The stage narrows by the dock's width (one CSS variable drives the stage, the panels and
the marker space) and the renderer resizes through the existing debounced path: one `setSize`, one
frame. The keydown→resize figure above is that path exactly — commit (tens of ms) + the 150 ms
debounce + one frame. Nothing is reallocated: the GL geometry count is unchanged across 40 resizes.

**Cycles.** 20 open/close passes on a quiescent deck:

| Measure | Result |
|---|---|
| camera, selection, focus, pin, digest, pad positions | identical to the pre-loop values (deep equality) |
| `hook.mounted` | unchanged (no context rebuilt) |
| `renderer.geometries` | unchanged |
| `sceneWrites` (instance-buffer writes) | **0** across the whole window |
| frames | 16 (≈ one per resize, `p50 0.9 ms`, `p95 8.8 ms`) |

**Return.** `select → inspect → scroll → switch tab → close` (the brief's §5 walkthrough, driven by
the real affordance on the selected line, then the panel's own X): camera, selection, focus, pin and
frozen state identical; `sceneWrites 0` (no scene rebuild on the way back); the Inspect affordance
reappears. One defect surfaced while writing that walkthrough and was fixed: closing the dock with
its X left focus on a button that no longer exists, so **every deck shortcut went dead until the
next click**. The deck now hands focus back to its surface when the dock closes (only if focus was
inside the deck), and the spec asserts it by closing and then driving the keyboard (`C` → `rail` →
`command`) with no mouse event in between.

**While it is up.** With the dock open on a quiescent run, a 1.5 s window recorded **0 frames, 0 DOM
mutations, 0 scene writes, 0 React commits**. The 2D layer is busy; the 3D layer is not.

### 4. Layout: right side, covers nothing (acceptance 3)

At 1440×900 (deck 1224×778, HUD row 68 px tall) with the dock open:

| Element | Box |
|---|---|
| dock | x 861, y 151, 562×690 (flush right, below the HUD) |
| stage | 660×776 (was 1222×776) |
| station line / lane strip | stacked at the top-left of the remaining column |
| selected line | 640×60, above the bottom row |
| live window | 316×235, bottom-left |
| alert column | 316×59, bottom-right of the column |

Every pair the operator reads at once is asserted **disjoint**: dock ∩ HUD, dock ∩ live window,
dock ∩ lane strip, dock ∩ station line, dock ∩ selected line, live window ∩ lane strip, live window
∩ station line, live window ∩ alert column. The lane strip and alert stack are re-anchored into the
column the dock leaves — no panel moves under a panel. The dock arrives in 180 ms
(`getComputedStyle` = 180 ms), and in **0.01 ms** under the deck's own reduced-motion switch (`M`).

### 5. No new endpoints (acceptance 2)

The request log for a full open-all-eight-tabs interaction contains exactly these paths — all of
them pre-existing (`src/server.ts`'s route table), none invented for the dock:

```
GET /api/health
GET /api/runs
GET /api/runs/d06-inspection
GET /api/runs/d06-inspection/agents
GET /api/runs/d06-inspection/events
GET /api/runs/d06-inspection/events/stream
GET /api/runs/d06-inspection/sessions
GET /api/runs/d06-inspection/slices/alpha
GET /api/runs/d06-inspection/slices/alpha/diff
GET /api/runs/d06-inspection/slices/alpha/log
GET /api/runs/d06-inspection/slices/gamma
GET /api/runs/d06-inspection/slices/gamma/log
GET /api/runs/d06-inspection/stats
```

The Diff and Log tabs really fetch (that is how the assertion is worth anything); the deck itself
still issues no request of its own — it is the same shell endpoints the dashboard's inspector uses,
called by the same components.

### 6. Live while inspecting (brief §6): the explicit table

Measured by mutating the run under an open dock (`deck-inspector.e2e.ts` scenario 6, artifact
`captures/deck-validation/d06-inspection.json`). Mutations are counted inside the dock subtree and
split: *content* (nodes/text the operator reads) vs *attributes* (React/Radix bookkeeping).

| What happens | What the operator sees | Dock content mutations |
|---|---|---|
| the inspected worker's log grows by 121 lines | the Log tab's tail updates within its 2 s poll; the live window within its own | (its own subject — expected) |
| **another** worker becomes active | lane strip, HUD `live: N`, scene: live | **0** (8 attribute writes) |
| **an alert** lands (another slice fails) | stack row + beacon, `live: N` unchanged | **0** (6 attribute writes) |
| the inspected worker completes | the dock's header flips `verifying → done` by itself, its trace and tone update; the deck's focus (`d03`) falls to the next live worker while the *selection* stays put | 26 (its subject) |
| closing afterwards | camera and selection identical to before the close | — |

Nothing "waits until the user returns" and nothing freezes: the dock is live for its subject and
inert for everything else. The **forensic** mode is the live window's freeze (`Space`, `d03`) — the
dock deliberately has no second freeze control, and the Log tab's tail keeps following until the
slice stops being live, exactly as the dashboard's Log tab does.

### 7. The bounded window survives inspection (brief §7)

With 121 lines appended to the inspected worker's transcript: the dock's Log tab renders **100
lines** (the existing server `tail` cap) and the live window holds **≤ 5 meaningful rows** (the
`d03` compact window). The two concepts stay distinct:

```
live window        = the bounded now (5 rows, freeze/expand, one per focused worker)
forensic history   = on-demand tails (Log 100 lines, Events 200, prompt tail)
```

Opening the dock neither enlarges the live window nor accumulates the event stream: the dock's
history is fetched per tab, capped by the server, and dropped when the tab unmounts.

### 8. What the deck does worse, and open findings

1. **The focused lane row trades its action line for the Inspect button.** The button is a sibling
   grid cell, so the row's own content loses ~62 px — the action text is ellipsised (still in the
   DOM, readable by AT, and shown in full on hover and in the live window immediately below). The
   affordance is only drawn while the dock is closed, when it is the discoverable way in. A
   wider-window redesign of the row (icons, or an overflow menu) would fix it; nothing here needs it.
2. **The dock re-renders on the shell's cadence, and the only DOM churn it produces is Radix's.**
   Measured: unrelated updates produce 0 *content* mutations but 6–36 *attribute* writes, all on a
   hidden `<input>` inside `ControlPanel`'s Select (React re-rendering the form with equal values).
   It costs nothing measurable (no layout, no paint), but it is the honest answer to "do live updates
   cause unnecessary inspection rerenders": the component tree re-renders, the operator's content
   does not.
3. **The transport is still the ceiling, unchanged.** Nothing in this slice touches it (brief §11):
   the dock's contents are exactly as old as the shell's fetch of the selected slice — up to a poll
   interval (900 ms store poll, 2 s Log-tab poll) — and that is the same staleness the dashboard's
   inspector shows. The dock does not hide it: an operator can watch a running slice's Log tab lag
   its own live window by a poll, because both polls are real.
4. **`review-rejected`/`verdict-stall` alerts still read the selected slice only.** The dock is
   where the operator opens other slices (`d05` finding 6), so the alerts now cover everything the
   operator actually looks at — but nothing fetches detail for unopened slices, by design (no new
   endpoints, no new polling).
5. **The measurement box was busy.** Interaction latencies span 2–5× across runs (see §3); the
   frame, commit, mutation and write counters are stable, but the latency numbers here are ranges,
   not a budget. A quiet-machine re-measurement belongs to `d03v`/`d10`.
6. **The flat path renders the dock but has no stage.** With no WebGL the dock still opens and
   inspects (it is DOM), but there is no canvas to narrow, so the layout rules reduce to the dock
   over the notice. `d09` owns the real flat projection.
7. **M10 remains owed** (`d03v`): the timed deck-vs-dashboard-vs-TUI comparison has still not run.

### 9. Acceptance criteria (d06)

| Criterion | Result |
|---|---|
| 1. All eight tabs render for a fixture slice with content identical to the dashboard's inspector | ✔ scenario 1: eight tabs, whitespace-normalised text equality after driving both surfaces; the dock's widgets are the same components |
| 2. Opening the dock issues no request outside the existing endpoint set | ✔ scenario 2: 13 distinct paths observed while opening every tab, all pre-existing; `/diff` and `/log` asserted to have really been fetched |
| 3. The live window and the HUD remain fully visible (no intersection with the dock) | ✔ scenario 3: bounding-box disjointness for dock ∩ HUD, live window, station line, lane strip and selected line; stage narrowed 1222 → 660 |
| 4. Open/close 20× leaves `geometries` constant and the camera state unchanged | ✔ scenario 4: geometries unchanged, camera/selection/focus/pin/digest/positions deep-equal, `mounted` unchanged, `sceneWrites` delta 0 |
| 5. Gates clean | ✔ `bunx tsc --noEmit`, `bun test` (757 pass / 0 fail, 58 files), `git diff --check`, `bunx playwright test tests/e2e/deck.e2e.ts --workers=1` (27 passed), `bunx playwright test tests/e2e/deck-inspector.e2e.ts --workers=1` (6 passed), `bun run test:e2e` (54 passed) |

### 10. Verdict

**PASS — recommendation, not a decision** (the operator fills in the decision block at `d03v`). The
slice's own question is answered from the real e2e workflow: an operator selects a worker, opens the
dock (key `1`…`8`, the Inspect affordance, or an alert row), scrolls, switches tabs, and closes —
and the camera, the selection, the focus, the frozen state and the pad geometry are all exactly what
they were, with no scene rebuild at all on the way back. The 3D layer stays cheap while the 2D layer
is up (0 frames, 0 mutations, 0 writes in the idle window), the dock is the dashboard's inspector
rather than a second one, and no new endpoint or fetch was introduced.

Restrictions, in the order they would bite:

1. **The dock is as fresh as the shell's fetch** (finding 3). Sub-second forensics remain a
   transport question, deliberately untouched here.
2. **The lane row's action text is the price of the affordance** (finding 1) — a cosmetic trade with
   a visible workaround (hover, or the live window below).
3. **Interaction latencies are measured on a busy machine** (finding 5): ranges, not a budget; the
   deterministic sub-measures (36–72 ms to DOM, 219–290 ms to resized canvas) are the stable ones.
4. **M10 (five timed tasks) remains owed** (`d03v`), together with the d03–d05 caveats that have not
   changed.

### 11. What a polished 2D dashboard would lose

The dashboard's inspector is a contextual drawer: it opens over the workspace, and the workspace
behind it is a list. Moving from "what is running" to "show me this diff" is a click on a row and a
click on a tab — the same clicks the deck now offers, and the dock's content is identical. What the
dashboard cannot do is keep *where the work is* on screen while inspecting: its board is a list, its
DAG a diagram in another mode, and the drawer's subject is a selection you trust rather than a place
you can see. The deck's dock narrows the world instead of covering it, so the operator inspects one
worker's diff while the other workers stay visible at their own positions — an inspector and a map at
once. The advantage is bounded: the dock is not a better inspector (it is the same one), it is an
inspector that never makes the operator leave the map, and for a single-slice run on a small window
the dashboard's drawer remains the cheaper surface.

## d07 — temporal layer: event ribbon, replay-aware history, and the history wall

The slice's question is the one the directive set for it: *when the deck answers "where is the work
now", can it also answer "what was the state of the system at that point" — spatially, without
becoming a 3D log viewer, without inventing a state, and without touching the run?* The answer is
**yes**, and the boundary this slice holds is that time is a *projection*: one pure fold over the
recorded log (`scene/history.ts`), so a cursor is a sequence and the same sequence always produces
the same scene. Live stays the default; history is one key deep and one key back (`L`, or the
`RETURN TO LIVE` chip, or `Esc`); and every step of a walk is measured to issue no request, change
no selection, move no camera and write nothing durable.

The roadmap's `d07` text was amended where this directive supersedes it: the written slice said "no
time-travel that changes what the deck shows". The construction stays exactly the roadmap's
("visualise the log; never re-implement `rebuildStatusesFromEvents` in the browser") — but the
amendment is what makes the fold *reachable*: the deck can project the recorded state at a cursor,
and it does so with the store's own status rule, asserted equal in a unit test rather than claimed.

### Reproduction

```bash
bun test tests/deck-history.test.ts tests/deck-model.test.ts    # the pure claims + the numbers below
bunx playwright test tests/e2e/deck-history.e2e.ts --workers=1  # the product claims, own fixture
```

`captures/deck-validation/d07-history.json` holds every e2e number; `captures/deck-d07-*.png` the
screens (the live band, the rail preset, a historical cursor with the dock open, the wall) — and
`captures/deck-d07-real-rail.png` / `-real-history.png` the roadmap's manual step: the real
`.omp/roadmap/runs/20260909-kph0as` run on the real surface, live and at seq 59 of its log.

### Bundle

| Artifact | d06 | d07 | Δ |
|---|---|---|---|
| `assets/Deck-*.js` (the deck + `three`) | 589.48 kB / 152.20 kB gzip | 611.77 kB / 159.53 kB gzip | +22.3 kB / +7.3 kB gzip |
| `assets/index-*.js` (the dashboard shell) | 456.02 kB / 137.62 kB gzip | 457.26 kB / 138.01 kB gzip | +1.2 kB (the shell's paged timeline fetch and the replay state) |
| `assets/index-*.css` | 93.06 kB / 16.30 kB gzip | 99.75 kB / 17.19 kB gzip | +6.7 kB (the temporal band, the ribbon, the runs list) |

The deck's growth is the temporal module (one fold + ribbon, plus the wall's DOM list), two new
instanced meshes and the markup for the band. On the GPU side the slice adds **two draw calls** and
at most `RIBBON_MAX_BARS + 1 + HISTORY_TILE_CAP` instances, all pooled at creation: the fixture
measures 10 calls and 72 objects on the `minimal` tier (budget 24 / 48 / 96).

### 1. The fold is the store's, and it is asserted equal (not similar)

`scene/history.ts` folds the log with `nextStatus`, mirroring `rebuildStatusesFromEvents`
(`src/store.ts:631`) case for case. `tests/deck-history.test.ts` builds a log that exercises every
status-bearing event type (claim, handoff, finish, verify pass/fail, retry, terminal fail, block,
skip, kill, abort-demotion, the two no-ops) and asserts the fold at ∞ equals the store's own
function, slice by slice. History is not a second state model; it is the store's rule, stopped at a
sequence.

| Claim (unit) | Result |
|---|---|
| fold-at-∞ ≡ `rebuildStatusesFromEvents` | equal for every slice with a status-bearing event |
| `snapshotAt(N)` independent of visit order | equal for a shuffled walk vs a fresh index |
| checkpoints cannot change a snapshot | `checkpointEvery: 1` ≡ `checkpointEvery: 100000` over 86 cursors |
| `attemptSegments` ≡ `buildTimeline` | equal arrays for the same log (a real equality, not a smoke test) |
| unparseable timestamps | excluded from buckets, still folded by seq |

### 2. The ribbon is bounded and clock-readable

| Claim | Result |
|---|---|
| 100 000 synthetic events → buckets | **84** (≤ 120), one O(events) pass |
| bucket size | off a clock ladder (1s … 1d), e.g. a 1h span → 30s |
| empty stretches | kept as buckets with `count 0` and `lastSeq -1` — the gap is information |
| concurrency per bucket | workers in flight at the bucket's *end*, from the same fold |
| cursor positions | only *recorded* buckets: a seq no event has is not a state the log can describe |

### 3. What a walk costs, measured (the directive's item 7)

`tests/deck-history.test.ts` prints `deck-history-scrub`. On this box:

| Measure | 100 000-event window | 1 000-event window |
|---|---|---|
| index build (once per event window) | 145–427 ms (busy-box range) | — |
| `snapshotAt` mean | **0.04–0.09 ms** | 0.07–0.14 ms |
| same code, checkpoints disabled | 7.2–37 ms | — |

So scrubbing a 100k window costs what scrubbing a 1k window costs: a snapshot folds at most
`CHECKPOINT_EVERY` (256) events from the nearest checkpoint, and every cursor lands inside one
frame's budget by two orders of magnitude. **The roadmap's `d07` acceptance criterion 1
("model build ≤ 16 ms at 100 000 events") is not met** and is recorded as an open finding rather
than massaged: the index build is O(events) with `Date.parse` + lane classification per event
(145–427 ms at 100k). The operating point is not 100k: the shell caps the temporal window at one
`EVENTS_MAX_LIMIT` page (2000 events), where the same build is a few milliseconds, and a real run
measured 96 events for 22 slices. If a later workflow hands the deck 100k events, the fix is a
server-side `tail` parameter (one page of the *newest* events), not a bigger client.

### 4. Product claims on the real surface (`tests/e2e/deck-history.e2e.ts`)

| Question | Result |
|---|---|
| live is the default | `historySeq === null`, `data-history="live"`, live statuses in the pad mirror |
| the same seq gives the same scene, by any route | 6 moments walked with `,`, then jumped to with the scrubber: identical digests and statuses; back to live: the original digest |
| a walk issues no request | **0** requests outside the live baseline; **13** scene writes (the world *was* reprojected) |
| a walk changes nothing durable | store statuses identical, selection identical, camera identical, no non-GET request, no POST anywhere in the slice |
| a bucket click | moves the cursor, selects the newest slice the bucket touched, opens the dock on **Events** |
| playback | visits **all 14** recorded moments in order (126–257 samples across runs), never a synthesized one, never past the last; `tweens` = 0 on the way in and out |
| the wall | 2 runs → 2 tiles + 2 rows, `aria-current` follows the switch, `mounted` unchanged (no reload), 0 writes |
| idle after all of it | a 1.5 s window: **0 frames, 0 commits, 0 mutations** — the temporal layer costs nothing when nothing moves |
| attempts strip | the selected slice's two recorded tries, the open one marked |

History never animates a change of reference frame: entering, scrubbing and returning all pass
`[]` to the renderer, so a jump into the past cannot look like a burst of transitions that never
happened (the directive's item 4: state at N, never an interpolated N+½).

**The manual step** (roadmap `d07`, "on the real run, verify the ribbon's shape against `ompo log`")
was run on `.omp/roadmap/runs/20260909-kph0as` (22 slices, 96 events) through the real server, in a
real browser: 22 pads, **27 bars**, 1 run tile, 7 draw calls, 57 objects; the DOM strip's heights
(`100%, 86%, 71%, 57%…`) follow the recorded bursts, and `ompo log`'s distribution matches them
(worker claims clustered, a long settled tail). Stepping back 12 recorded moments puts the pads at
seq 59 — `7 done · 1 running` where the live run reads `all done` — with the camera untouched
(distance 71.8 before and after) and the station line reading `RECORDED · running · w4a · 1 active
at this point`. The two captures in `captures/` are that run.

### 5. Ownership, restated for the new layer

| Category | Owner | In this slice |
|---|---|---|
| Domain state | ompo (`App.tsx` + the store) | the shell's bounded timeline window (≤ one page), nothing else |
| Spatial state | the deck | the ribbon, the wall row, the historical pad projection — all derived from `DeckModel` |
| Temporal state | the deck shell | the cursor (`historySeq`), playback, the wall's openness: view state, so none of it enters the store and none of it survives a run switch |
| Inspection state | the dock | unchanged; a bucket click *opens the dock*, it never re-implements it |

### 6. New visuals, reviewed against the `d03` premise (the directive's item 13)

| Element | The question it answers | Verdict |
|---|---|---|
| the ribbon (3D bars + DOM strip) | where was activity concentrated, when did concurrency rise | kept: height = events per bucket, colour = busiest lane, `active` in the label |
| — its 3D placement | does the strip read, or hide behind the world | **measured and moved twice** (below) |
| the playhead | what point am I looking at | kept: one extra instance in the ribbon's mesh — no new draw call |
| the run wall (tiles + list) | where does this run sit among the others | kept: identity only; the list is the operable half |
| the attempts strip | how many tries has this slice taken | kept: text chips on the selected line, from `buildTimeline` |
| the time band | what state am I in, and how do I get back | kept: `LIVE` / `RETURN TO LIVE`, the span, the bucket size |

**The band's placement is a measurement, not a taste call.** The first cut sat 0.8 units behind
the rail's far edge; on the real run the pads' own screen silhouette covered the bars (their bases
landed 3–7 px from the pads' tops), and a vision check could not find them at all. A near-side
variant was measured next and rejected: it runs into the bottom-left live window and the
bottom-right panels. The shipped placement is **5 units behind the rail** (rail gap 5, wall gap
2.2), where the same measurement gives 14–26 px of clearance, and the bars are **2.2 world units
tall** — a red-pixel probe of the real run's rail preset found the strip as a 608 px-wide band,
16 px median bar height (37 px at the busiest bucket), clear of the station line and the pads.
The DOM strip remains the exact half: every bucket, labelled, clickable; the scene draws the shape.

Deliberately **not** built, with the reason: per-bucket 3D hover highlight (a second highlight
system for a question the strip's own text answers); stations at a historical cursor (a station's
shaft is a *current* pipeline stage with no recorded counterpart — the pads' own statuses carry
"who was running" and the count carries "how many"); historical alerts (a second alert policy, and
a past moment has no live conditions); a historical inspector (the dock is the inspector, and it
inspects the record, not a second copy of it); any control in the band (`d08`'s territory).

The live window is **paused, not re-subjected** at a historical cursor, with a note that names the
key back. Retargeting it per scrub tick would make the surface say two tenses at once and re-fetch a
log for each step; leaving it mounted on the *live* focus would have been the other option, and it
was rejected because the freeze/expand state is keyed to the same focus the scene edits.

### 7. What the deck does worse, and open findings

1. **The 100k index build is 145–427 ms** (§3): the roadmap's 16 ms budget is missed at the
   pathological input, not at the operating one. Recorded, not hidden.
2. **A truncated window is a tail, and says so.** The shell pages forward to the end of a log up to
   one server page; a longer log yields its *newest* 2000 events and the band states "window is the
   newest page". The states of slices whose last transition predates the window fall back to their
   current DTO status (documented in `model.ts`); a `tail` parameter on `/events` is the cheap fix
   if a real run ever exceeds a page (none measured so far).
3. **`run_resumed` demotions are invisible to the log.** The store demotes `running`/`verifying` to
   `pending` in the cursor (`resumeRun`) without an event, so the historical fold reports what the
   log recorded — exactly like the store's own replay check. Stated in `history.ts`; a fix belongs
   to the store (an event), not to the client.
4. **History pauses the live window** (§6). The trade is deliberate and one key wide; if an operator
   ever needs both tenses at once, the answer is two panes, not a re-subjected window.
5. **Playback is a fixed 320 ms per recorded moment.** It answers "watch the shape of the run", not
   "replay at wall-clock speed": a 3-hour run with 40 recorded moments replays in ~13 s. Speed
   control is not built (no user has asked); the direct-manipulation paths are the scrubber and the
   step keys.
6. **The full suite's parallel run flakes one d05 assertion under load** — not this slice's code:
   `deck-transitions.e2e.ts` samples `animatedEntities`/`tweens` while cues decay, and with four
   browsers on four vCPUs it read a cue as still live (`expected 0, received 1`). It passes
   standalone (42 s, twice) and the file's own advice stands: run the deck specs with `--workers=1`.
   Recorded here rather than papered over, because the fix belongs to that spec's timing, not to
   the temporal layer.
7. **M10 (five timed tasks) remains owed** — unchanged by this slice, and still the debt the
   directives section names. This slice measured the temporal layer's own costs (§3) and the idle
   sample (§4); it did **not** measure an operator completing a task, in either mode.

### 8. Verdict

**PASS — recommendation, not a decision.** The slice's own question is answered from the real
surface: a historical state is reproducible from its sequence, a walk is inert (0 requests, 0
durable writes, 0 camera moves), live is the default and one key away, and playback can only land
on states the log recorded. The boundary the directive drew — 3D selects and orients, 2D inspects —
holds in the new layer by construction: the ribbon and the wall are scene geometry and DOM text,
while every question of detail still opens the existing dock.

### 9. What a polished 2D dashboard would lose

A 2D timeline can absolutely show when things happened — the dashboard's own Timeline chart does,
and better than a ribbon of 120 bars. What it cannot do is answer *where the system was* at that
moment: the pads, the dependencies between them, and which workers were in flight are the same
spatial objects the operator learned in the live view, and moving the cursor moves *them*, not a
table's rows. The deck's advantage is bounded and specific: it is the only surface where "what was
the state at 14:22" is answered by looking at the same map the operator watches at 14:23.

## d08 — control from the deck: the dashboard's actions at the selection

The slice's question: can the operator act on what they are looking at — retry, skip, park, kill,
pause, resume, set-jobs, restart-loop — without leaving the spatial surface, with the *same*
guards, confirmations and queued-vs-direct feedback the dashboard has, and with a queued intent
never reported as success before the orchestrator says so?

Answer: **yes, and the semantics moved rather than duplicated.**

### Reproduction

```bash
bun test tests/deck-control.test.ts tests/deck-alerts.test.ts    # the pure claims
bunx playwright test tests/e2e/deck-control.e2e.ts --workers=1   # the product claims, own fixture
```

`captures/deck-validation/d08-control.json` holds every recorded request body;
`captures/deck-d08-control.png` shows the bar with an alert stack above it and the selected line
below.

### 1. One module of control semantics; two renderings

"Control stays a pure delegation" is implemented literally. `web/src/lib/control.ts` (pure) is now
the single source of: every `ControlIntent` body (`sliceIntent`, `runIntent`, `jobsIntent` — kind,
subject, and a trimmed reason omitted when empty), the destructive set (`DESTRUCTIVE`), the guard
messages (park/restart reasons, `set-jobs` bounds, the loop-local kinds a quiescent run cannot
serve), the 202 → pending and 200 → direct view states, the outcome correlation, the wedged-loop
gate (`restartOffered`), and the dashboard's exact quiescent sentence + command.

`ControlPanel` (the dashboard's panel, also rendered by the dock) and `scene/ControlBar.tsx` (the
deck's compact bar) are two skins over it. No rule is stated twice, so "the deck does what the
dashboard does" is true by construction — and the e2e proves it over real HTTP anyway: **seven
actions produce byte-identical bodies** on both surfaces (§4).

One rule got *stricter* in the move: an outcome event whose detail names a kind different from the
pending intent's (`skip: …` arriving while a `retry` is queued) no longer settles that intent. The
old fall-through meant scope+recency could mislabel a queued intent with another intent's message;
a detail that names no kind still settles, so a queued row cannot hang forever.

### 2. What the deck adds, and nothing else

- **A bar at the selection.** `DeckOverlay` renders `ControlBar` in the panel that already holds
  the selected line — the line says what, the bar acts on it. The bar owns only view state (reason
  box, armed confirm, the last intent and its outcome); the press calls `api.control` and then the
  shell's existing `onControlDone` refetch, the same callback the dock's panel uses.
- **Intent feedback where the operator pressed.** `queued (#N kind slice jobs=N)` with a spinner
  that stops after 2 s (the row stays), which flips to `applied`/`rejected` only when the
  orchestrator's own `control_applied`/`control_rejected` arrives on the event tail. A 200 (quiescent)
  renders the direct outcome and never enters the pending state; a failed request renders the
  message verbatim with a "Retry request" affordance and a dismiss.
- **A rejection is an alert.** `alerts.ts` gains `control-rejected` (medium): the *newest*
  `control_rejected` in the window is one dismissible row carrying the server's own
  `${kind}: ${message}`. One row, not one per rejection — the same "one alert per condition" rule
  the rest of the taxonomy uses — and a newer rejection is a new dismissal key. Both the deck and
  the dashboard get this: a rejection from `ompo ctl` lands on the deck's stack too. The station's
  pulse is the existing beacon-arrival cue (≤200 ms at `minimal`, 0 under reduced motion), so no
  new animation code was written for it.
- **Two deck-only rules.** Control acts on the *live* run: at a recorded cursor every action is
  disabled and the bar says so (``L`` returns). And the target must exist in the current run's
  DTOs, so a run switch in flight disables the bar instead of letting a press address the previous
  run's slice by name.
- **`restart-loop` is gated**: `live && loops.length >= 1 && stalled`, where *stalled* is the
  surface's own existing signal (a `wedged` or `verdict-stall` alert). The confirm and the reason
  requirement are the dashboard's, in the dashboard's order (arm → reason error → arm → send).

### 3. The gate exposed a shell bug: the wedge signal never refreshed

`restart-loop`'s "live but stalled" reads `AgentRow.wedged`, and `App` fetched agents only in
`loadRun` — which, with SSE connected, runs on `run` frames. A *wedged* run emits no events by
definition, so the flag could never arrive: the recovery would have been dead in exactly the
scenario it exists for (the deck's `wedged` alert had the same problem since `d05`). Fixed in the
shell's existing slow-tick pattern: the 10 s session refresh now also refreshes agents, with the
reason stated at the call site. This is the one change outside the deck, and it is a fix to a
pre-existing defect, not a new dependency.

### 4. Verification (`tests/e2e/deck-control.e2e.ts`, 4 specs, real surface, own harness)

| Question | Result |
|---|---|
| body equality, dashboard vs deck | **7/7 identical**, byte for byte: `retry`/`skip`/`park`/`kill` with a trimmed reason, `pause`/`resume` with one, `set-jobs` `{"kind":"set-jobs","jobs":4}` |
| one path, existing kinds | every request `POST /api/runs/d08-control/control`; the kind set is the taxonomy's, nothing new |
| a destructive confirm | first press sends nothing and relabels itself `Confirm <kind>`; the second sends; the arm clears |
| queued ≠ success | 202 → `queued`, store statuses unchanged by the press alone; `control_applied` → `applied`; `control_rejected` → `rejected` **and** a dismissible stack row with the server's message verbatim |
| control is live-only | at a recorded cursor all seven actions render disabled with the note, then re-enable on `L` |
| restart-loop gate | absent on a healthy live run; after the server-derives-wedged condition appears, present, refusal without a reason, arm, then one body `{"reason":"worker silent 30m, loop starved"}` |
| quiescent recast | no pause/resume/set-jobs/restart-loop; `Resume run` + the dashboard's exact sentence and `ompo resume --run d08-control` |
| idle with the bar | 1.5 s window: **0 frames** |

`bun test`: the new pure suites (`tests/deck-control.test.ts` 16, the `d08` block of
`tests/deck-alerts.test.ts` 5) plus the rest of the tree.

### 5. Layout: the right-hand column

The bar is clickable, so "the alert stack paints over the selected line" stopped being cosmetic.
`DeckOverlay` now puts the alert column and the line+bar into one bottom-right column
(`.omp-deck-right`), which owns the corner and the width; the bar keeps its place at the bottom, so
an arriving alert grows the stack *upward* instead of moving the buttons. With the dock open the
wrapper becomes `display: contents`, so `d06`'s grid is unchanged (the line spans both columns, the
window and the alerts share the row beneath it). Measured at 1440×900 and 1024×768: zero overlap of
the bar with the live window, the lane strip or the line; with the dock open, zero overlap between
the dock, the window, the bar and the alert column.

### 6. Bundle

| Artifact | d07 | d08 | Δ |
|---|---|---|---|
| `assets/Deck-*.js` | 611.77 kB / 159.53 kB gzip | 619.99 kB / 161.68 kB gzip | +8.2 kB / +2.2 kB gzip |
| `assets/index-*.js` (shell) | 457.26 kB / 138.01 kB gzip | 458.02 kB / 138.29 kB gzip | +0.8 kB (the agents tick) |
| `assets/index-*.css` | 99.75 kB / 17.17 kB gzip | 103.18 kB / 17.61 kB gzip | +3.4 kB / +0.4 kB gzip |

The scene is untouched: **no new mesh, no new draw call, no new per-frame work**. The bar is DOM
(~20 elements), it re-renders on selection/status change (the SSE cadence), and the only new
network call is the shell's 10 s agents tick (already the cadence of the session list).

### 7. Open findings, deliberate choices

1. **A rejection alert comes from the log, not from the deck's own press.** The consequence is
   deliberate: a rejection another client caused (`ompo ctl`) is also visible, and an old rejection
   stays on the stack until dismissed. It is bounded by the event window and re-raises only on a
   newer rejection.
2. **A 400/404 has no event**, so it cannot be a stack row: the bar's own `role="alert"` row carries
   the server's message verbatim with a retry, and dismisses. Network failure lands the same way —
   the deck never assumes the action happened.
3. **The action bar is always visible** (disabled with a reason when there is nothing to act on).
   Hiding it behind a key would put the operator's control surface behind a memory test; the
   roadmap's "contextual" is satisfied by its *content*, which follows the selection.
4. **`Resume run` is not exercised end-to-end**: pressing it spawns a real detached loop, which no
   fixture should do. The button, its wording and the recovery sentence are asserted; the request
   itself is the dashboard's own path, unchanged.
5. **The full suite's parallel run flaked two frame-budget assertions** on this box
   (`deck.e2e.ts` "a status change … rebuilds no geometry": 5 frames against a ≤4 budget;
   `deck-workflow.e2e.ts` pipeline sample). Both files pass with `--workers=1` (27/27 and the
   file's own count), the same load-sensitive class `d07` recorded — and this box was running a
   real `omp -p` worker loop while the suite ran, which is exactly the load those budgets assume
   away.
6. **One spec assertion had to be re-stated, not relaxed.** `deck-workflow.e2e.ts`'s churn step
   asserted the deck's *total* element count stays within 1.3× of its start under 50 control
   intents. Measured, the growth is +63 elements: the temporal band's bucket strip **66 → 123**
   (one button per recorded bucket — `d07`'s, capped at `RIBBON_MAX_BUCKETS`), one new rejection
   alert row (+7, `d08`), and **nothing else** (the live window, mirror, lanes, line and bar are
   flat; the bar is 13 elements before and after). The assertion now says what it always meant:
   the surfaces the burst stresses must not grow *at all*, and the document stays under a fixed
   ceiling. Recorded here because a re-stated assertion is a claim, not a cleanup.
7. **M10 (five timed tasks) is still owed** — unchanged by this slice, still the debt the
   directives section names.

### 8. Verdict

**PASS — recommendation, not a decision.** The operator can press the dashboard's own actions from
the spatial surface, sees exactly what the dashboard would send, and the outcome they see is the
orchestrator's, not the client's optimism. Control remains a delegation: one pure module of
semantics, one `POST`, one existing event correlation, and a deck that stores nothing but its own
view state.

## d09 — fallback, accessibility, and the no-WebGL path

### Reproduction

`bun run web:build`, then, with `--workers=1`: `tests/e2e/deck-a11y.e2e.ts` (6),
`tests/e2e/deck.e2e.ts` (27), `tests/e2e/deck-history.e2e.ts` (7),
`tests/e2e/deck-inspector.e2e.ts` (6), `tests/e2e/deck-transitions.e2e.ts` (1),
`tests/e2e/deck-control.e2e.ts` (4), `tests/e2e/deck-workflow.e2e.ts` (2); `bun test` (817, 61
files); `bun run test:e2e` (71 pass). Evidence: `captures/deck-validation/d09-a11y.json`,
`captures/deck-d09-flat.png`, `captures/deck-d09-help.png`.

### 1. The fallback is a projection, not a second surface

`scene/fallback.ts` (pure, no DOM, no `three`) owns the two decisions this slice exists for.
`deckAvailability` reads capability plus an explicit choice — no WebGL2 is flat, an explicit flat
wins anywhere, `minimal` is a 3D tier (the gate machine's expected tier), and an explicit `3d`
cannot conjure a context. Motion is carried in the input so callers pass one prefs slice, and a
test asserts it never changes the answer: reduce stops tweens, it does not demote the device.

`FlatDeck` consumes the **same** `DeckModel`: the board is the dashboard's `SliceTable` and the
worker list is its `WorkerLanes` (the two components the roadmap names), and the "Rail, flattened"
list is `flatRows(model)` — every pad exactly once in rail order, carrying the scene's whole
information set (status + glyph, attempts/generation, stage label, alert kind, live/stalled,
selected/focused, ghost/cycle flags). A divergence between the two surfaces would be a model bug
caught by `flatRows`' coverage test, not a UI bug found by a user.

Three ways in, one surface out: no WebGL2 at mount (probe returns `null`), a lost context
(`webglcontextlost` on the canvas), or `T` cycling to `flat`. All three render the same section,
the same overlay (time band, station line, alerts, control bar, live window, history), the same
dock, and a reason-specific one-sentence notice with the device string and the way back
(`Retry 3D` after a loss, `Use 3D` after a choice, `Back to dashboard` always).

### 2. Accessibility, asserted structurally rather than promised

- **The pad mirror is the `flatRows` list**: every pad a real button, with the full sentence in
  `aria-label`, and **one tab stop** (`roving.ts`): ArrowUp/ArrowDown/Home/End move the stop and the
  focus together, Enter/Space activate. A 200-pad roadmap no longer puts 200 stops between the
  operator and the rest of the page.
- **The focus mirror is one polite node** whose text is `focusMirrorText(model)` — focused slice,
  status, stage, live/stalled, alert and worker counts. The e2e installs a `MutationObserver` and
  asserts the count is **0** for a worker handoff plus transcript growth (an event and 2 new log
  lines, neither of which changes any of those inputs) and **≥1** for a real status change. "Never
  announced per log line" is therefore a property of the node, not of the test's timing.
- **The help panel is generated from `DECK_KEYS`** in the overlay, so it exists on the flat surface
  too (which has no HUD row); `H`/`?` toggles both panels, and the e2e counts the rows against the
  table.
- **The canvas is decorative**: `aria-hidden="true"`, a descriptive label for tooling, and no tab
  stop — the keyboard path to every fact is the DOM layer.
- **No status by colour alone** is checked by walking the DOM: board rows, pad rows, worker lanes,
  the selected line, the station line and the mirror rows must each contain a status word or glyph
  (both surfaces).
- **Reduced motion** is honoured on mount from `prefers-reduced-motion` (emulated in the e2e) with
  `renderer.tweens === 0` across a real status change, and `M` flips the *effective* state and
  persists it (`motion: "system" | "on" | "reduced"`), so a reduced-motion OS no longer prevents
  the operator from choosing motion. The `d01`–`d08` `reducedMotion: boolean` storage shape
  migrates (`true` → `"reduced"`, everything else → `"system"`).

### 3. Verification (`tests/e2e/deck-a11y.e2e.ts`, own harness, `captures/…/d09-a11y.json`)

| Question | Result |
|---|---|
| no WebGL2 → usable flat deck | notice "3D unavailable…", 0 canvases; board 6 rows, pads 6, workers 2, live window wired (`data-lines` ≥ 1), alerts, time band, dock — no page error |
| keyboard-only reaches every function | `Output…Log` (8 tabs) by `1`…`8`, close on `Esc`; freeze/resume on `Space`; worker cycling on `]`; expand on `E`; `,`→past, `L`→live; control press on a focused retry button produced `{"kind":"retry","sliceId":"delta"}` and a queued row; `H` help; `D` out and back to the deck with no pointer event |
| roving mirror | first row tab stop `0`; ArrowDown moves focus and the stop to row 2 (`0`), row 1 becomes `-1` |
| aria-live mirror | 0 writes for handoff + transcript growth; ≥1 for `running → verifying → done` |
| reduced motion | `motion: "reduced"` on mount, 0 cues after a status change; `M` → `full`; `M` again → `reduced`, persisted |
| context loss | synthetic `webglcontextlost` → flat, `contextLost: 1`, selection and freeze preserved, `Retry 3D` → fresh canvas, 3D, state intact |
| `T` | 4 presses from auto → flat (forced), 5th → 3D again |
| status by words/glyphs | 6 board + 6 pad + 2 lane + line + station + 6 mirror rows (flat), 2 lanes + line + station + 6 mirror (3D), all carrying words/glyphs |

### 4. The gate exposed a hook bug (fixed here)

`hook.ribbon`/`hook.tiles` had two writers: `applyToScene` published the renderer's *drawn* instance
counts (from the same `info()` snapshot as `hook.instances`) and the history effect published the
*window's* bucket count. While a window stayed under `RIBBON_MAX_BARS` the two agreed and the `d01`
instance identity held by luck; past the cap, the value depended on which effect ran last, and the
identity failed in one full-file run (3 specs: `instances` 73 against a sum of 110). `hook.ribbon`
and `hook.tiles` are now the drawn counts, the window's size is `hook.ribbonBuckets`, and
`deck-history`'s artifact records buckets and drawn bars separately. The model-level hook facts
(selection, focus, live count, alerts, overflow, digest, node/edge counts) are now published by an
effect that runs on both surfaces — in flat mode nothing goes through the renderer, so fields that
only `applyToScene` wrote would have read `null` forever.

### 5. Bundle

| Artifact | d08 | d09 | Δ |
|---|---|---|---|
| `assets/Deck-*.js` | 619.99 kB / 161.68 kB gzip | 626.85 kB / 161.67 kB gzip | +6.9 kB / ±0 |
| `assets/index-*.js` (shell) | 458.02 kB / 138.29 kB gzip | 458.38 kB / 137.02 kB gzip | +0.4 kB |
| `assets/index-*.css` | 103.18 kB / 17.61 kB gzip | 106.80 kB / 18.13 kB gzip | +3.6 kB / +0.5 kB |

No new mesh, no new draw call, no per-frame work: the flat path creates no canvas and no loop at
all (the renderer effect is gated on `availability`), and the 3D path is byte-for-byte the same
scene contract it was.

### 6. Open findings, deliberate choices

1. **The station lane strip is 3D-only.** Flat mode lists workers through `WorkerLanes` (the
   dashboard's own rows) instead; the deck's focus model stays available through `[`/`]`, the
   station line and the pad list. Rendering both would say the same thing twice.
2. **The flat document is one scroll container**: panels flow top-to-bottom (time band, station
   line, workspace, alerts, live window, selected line + control, help). The e2e asserts zero
   panel-to-panel overlap and zero deck/footer overlap at 1440×900; the dock becomes the last block
   rather than a column, because there is no stage to narrow.
3. **No screen-reader narration of the 3D scene itself** (the roadmap's explicit non-scope): the
   scene is decorative, and the focus mirror announces the deck's own pointer. A user who wants
   every worker's line reads the mirror or the pad list.
4. **`flatRows` is not capped; the aria-live mirror is** (`MIRROR_LIMIT`, remainder stated in
   words). The visible pad list is the operator's rail replacement, so silently dropping pads there
   would defeat the slice.
5. **`H` toggles the HUD and the help panel together**; the help panel is the overlay copy so the
   same binding works where no HUD exists.
6. **M10 (five timed tasks) is still owed** — unchanged by this slice; `d03v` remains the real gate.

## d11 — launcher and the `--print-url` handshake

One additive flag, one contract line, and a launcher with no toolchain: the deck is one command away
in a chrome-less window, and any future shell reads a deterministic URL instead of scraping a banner.

### Outcome

- **`ompo --no-open --print-url`** writes exactly one stdout line `url=http://127.0.0.1:<port>` once
  bound (the resolved, auto-selected port) and moves the banner — `ompo dashboard: …`,
  `press Ctrl-C to stop`, `ompo dashboard stopped` — to stderr. Without the flag both streams are
  unchanged; on a non-dashboard command the flag is a stderr warning, not a parse error.
- **`scripts/deck-open.ts`** spawns the handshake (self-relaunch: the compiled binary re-executes
  itself, a source run re-invokes `bun src/cli.ts`, mirroring `resumeCommand()`), reads the line
  under a 5 s budget, opens `<url>/?surface=deck`, and owns the child on every exit path.
- **`deckLaunchPlan`** is pure over `env` + platform + an injected existence probe:
  `$OMPO_DECK_BROWSER` → Chromium-family (`--app=<url> --window-size=1600,1000`) → Windows Edge
  through the WSL interop mount → `xdg-open` / `open` / `cmd start` as a normal tab → `null`
  (the launcher prints the URL and exits 1). Every plan's `cmd` is absolute.

### Verification

- `tests/deck-launch.test.ts` (17): the ordered preference list per platform, the app-window args
  for each family, a non-Chromium override opening a plain tab, an unresolvable override falling
  through, `null` when nothing exists, absolute `cmd`s, and `readUrlLine` (line split across chunks,
  bounded timeout, EOF).
- `tests/release-gate.test.ts` (3 new): exactly one stdout line + banner on stderr + SIGTERM exit 0
  with the server live; the no-flag run keeping the banner on stdout with no `url=` line; a
  non-dashboard command warning on stderr and exiting 0.
- Manual no-orphan check (this box, `DISPLAY=:0`): `bun scripts/deck-open.ts` opened a real
  chrome-less window — chromium argv carried `--app=http://127.0.0.1:41015/?surface=deck`, an
  established TCP connection to the ompo port confirmed the page load — and SIGINT exited the
  launcher 0 with zero `ompo` processes left (`pgrep -f "src/cli.ts"` empty). Re-run with a
  recording fake browser proved the same cleanup returns the child count to its pre-launch value.
- Gates: `bunx tsc --noEmit` clean; `bun test` **852 pass / 0 fail** (62 files); `git diff --check`
  clean; the deck e2e files with `--workers=1` **54 passed**; `bun run test:e2e` **72 passed**.
  `bun scripts/deck-perf.ts` was not re-run: `d11` touches no performance-sensitive subsystem (no
  `web/src` change, so `web:build` was not needed either).

### A finding from the handshake tests: the stop handlers ran after the banner

The new gate test kills the dashboard the moment the banner line lands, and it intermittently saw the
process die *by signal* (`close` code `null`) instead of stopping cleanly: `cmdDashboard` registered
its SIGINT/SIGTERM handlers after printing the banner — and after the best-effort browser open. Any
consumer that reacts immediately to the output could hit that gap (the launcher's own 5 s budget
never would, but the contract should not depend on the consumer being slow). The handlers now
register before the first byte is written; the immediate-kill test passed 5/5 repeats plus the suite
runs. Material because it is the only place the new flag changed core sequencing.

### What this does worse, and open findings

1. **The window outlives Ctrl-C.** The launcher kills the ompo child it started but never the
   browser (browser process semantics; on WSL the interop Edge window may belong to the operator's
   running Edge). The launcher says `stop: Ctrl-C` once instead of implying it owns the window — the
   roadmap chose the honest version.
2. **`$OMPO_DECK_BROWSER` takes one executable, no arguments.** A browser needing flags to behave
   (a kiosk profile, a specific user-data-dir) needs a wrapper script.
3. **On this box the default plan is WSL interop Edge** (no Linux Chromium is installed); the real
   app-window check therefore used the documented override with Playwright's chromium rather than
   launching into the operator's live Edge session. The default resolution is asserted by a probe,
   not by opening Edge.
4. **`--print-url` is dashboard-only.** The flag with `--tui`/any other command warns on stderr and
   is otherwise ignored; there is no machine-readable handshake for the TUI, and none is planned.
5. **M10 (five timed tasks) is still owed** — unchanged by this slice; `d03v` remains the real gate.

## d12 — Tauri 2 desktop shell (Windows-first, deliberately droppable)

Packaging, not architecture: one window plus one reaped sidecar, zero Tauri commands, and the deck
keeps obtaining its data through the existing ompo URL path. `deck-open` remains the better
development/runtime path on this machine and is fully usable regardless.

### Outcome

- **`desktop/src-tauri/`** — `tauri.conf.json` (one window `main`, 1600×1000, min 900×600, hidden
  until the handshake; `bundle.externalBin: ["binaries/ompo"]`, empty `bundle.resources`, version
  pinned to `package.json`), `src/main.rs` (spawn sidecar with `--no-open --print-url`, 5 s `url=`
  budget, `WebviewWindowBuilder` + `WebviewUrl::External(<url>/?surface=deck)`, kill on window
  close / app exit / `Drop`, stderr-tail error window with the terminal reproduce), `build.rs`,
  `Cargo.toml` (`tauri` 2 + `tauri-plugin-shell` + `tokio/time` only), `capabilities/default.json`
  (`core:default` + `shell:allow-spawn/kill/stdin-write` scoped to the sidecar — no `fs`/`http`/
  `dialog`/anything else), placeholder `icons/`, `README.md` with the platform matrix.
- **`scripts/deck-desktop-check.ts`** (gated: `bun run deck:desktop:check`) — dependency-free static
  verifier: config/capabilities/`main.rs`/`Cargo.toml` parsed and asserted, one specific message per
  violation, exit 1 on any. No Rust needed.
- **`scripts/deck-desktop-run.ts`** behind `deck:desktop:dev` / `deck:desktop:build` — missing Rust or
  WebKitGTK fails with the prerequisite and the `deck-open` fallback, never an unattended install.
- **`tests/deck-desktop.test.ts`** (6) — the check passes, no bundled SPA copy, the exact capability
  allow-list, `deck-open` stays toolchain-free, the three `deck:desktop:*` scripts are wired, the
  guard fails with instructions.
- `.gitignore` gains `desktop/src-tauri/target/` + `gen/`. `web/src/**` untouched — the web surface
  is byte-identical with and without `desktop/` present.

### Verification

- `bun scripts/deck-desktop-check.ts` → `deck-desktop-check: ok`.
- `deck:desktop:dev` / `deck:desktop:build` on this box (no `rustc`/`cargo`, no `libwebkit2gtk`,
  `/dev/dxg` present, no `/dev/dri`) → exit 1 with the rustup + WebKitGTK instructions and the
  `deck-open` pointer. Recorded evidence that d12's toolchain does not exist here, per the roadmap.
- `bun test` **858 pass / 0 fail** (63 files); `bunx tsc --noEmit` clean; `git diff --check` clean;
  `tests/deck-desktop + deck-launch + release-gate` 41 pass.
- Deck e2e: `deck-control.e2e.ts` 4 passed; `deck.e2e.ts` 9 observed passing before the 240 s `timeout`
  wrapper killed the file's long tail (1.6 m surface-switch spec on SwiftShader); the 7-file
  `--workers=1` sweep was stopped at 600 s mid-`deck-inspector` (19 passing specs observed, same
  machine-slowness cause). `captures/` restored after each run. No e2e file was modified by this
  slice, and `web/` is untouched — the slowness is the box (SwiftShader), not d12.
- `bun run test:e2e -- --grep "smoke|health"` 1 passed (non-deck surface unaffected).
- Launcher regression (`$OMPO_DECK_BROWSER` fake script): `bun scripts/deck-open.ts` printed the deck
  URL, SIGINT exited the launcher, `pgrep -f "src/cli.ts --no-open"` returned to zero — no orphans.
- Rust `cargo test` (the `main.rs` pure helpers) and the Windows manual acceptance (dev run,
  `tasklist` cleanup, sidecar-kill recovery, webview renderer string + tier) were **not executed in
  this environment** — no toolchain here. A Windows-side operator must run `cargo test` in
  `desktop/src-tauri`, then `bun run deck:desktop:dev`, close-cleanup, sidecar-kill recovery, and
  record `window.__ompoDeck.tier` + `bun scripts/deck-perf.ts` against the shell's URL.
- `bun scripts/deck-perf.ts` was not re-run: d12 touches no performance-sensitive subsystem (no
  `web/src` change, no bundle rebuild).

### What this does worse, and open findings

1. **The shell is unverified where it matters.** Everything above is static: no Rust compiler checked
   `main.rs`, no webview ever loaded the deck URL, no close-cleanup was observed. The honest
   statement is that d12 ships a reviewed-but-uncompiled crate plus a verifier — the Windows
   acceptance is owed, not waived.
2. **The icons are placeholders.** Solid-colour PNG/ICO/ICNS stand-ins satisfy the bundler schema;
   a real release needs a designed icon set.
3. **The `data:text/html` error path is untested against real WebView2/WebKitGTK.** The document
   content is fixed by the roadmap, but whether every webview renders the encoded page identically
   is a Windows-side observation, still owed.
4. **The full deck e2e sweep does not fit this box's clock.** The 7-file `--workers=1` run exceeded
   600 s with 19 specs observed passing; per-file runs pass (`deck-control` 4/4) but the suite as a
   whole is a patience test on SwiftShader. Unchanged by d12, recorded because the gate evidence
   must not pretend otherwise.
5. **M10 (five timed tasks) is still owed** — unchanged by this slice; `d03v` remains the real gate.

### Verdict

**PASS — recommendation, not a decision.** The packaging question gets its honest answer: on this
machine `deck-open` provides the better development/runtime path (zero toolchain, same app window,
same handshake), and Tauri remains optional packaging, dropped from the critical path exactly as the
roadmap allows. The shell earns its keep only if the Windows acceptance shows a capability the
launcher lacks; until then it is a committed, verified recipe — not a second runtime.

## d13 — expression pass: ambient world, completion, and a composed HUD

The deck stops being a diagram. One conversion from the design tokens, a registry of effects each
with a tier, a cost, an off switch and a reason when it is unavailable, a floor that reads as
ground, distance fog, a completion moment, and a HUD ordered by the operator's questions instead of
by the order the chips were written — with none of it load-bearing: **every effect off is still a
working deck**, and that state is asserted, not promised.

### Reproduce

```bash
bun run web:build
bun scripts/deck-perf.ts                                             # effects on, this box's tier
bun test tests/deck-palette.test.ts tests/deck-ambient.test.ts        # the pure halves
bunx playwright test tests/e2e/deck.e2e.ts -g "deck expression pass" --reporter=list --workers=1
```

Captures: `captures/deck-d13-effects-on.png`, `captures/deck-d13-effects-off.png`,
`captures/deck-d13-hud.png` (the rail preset with the default effect set; the same view with all
five effects off; the HUD panel with the effects list open).

### 1. One palette, no literals left in `scene/**`

`scene/palette.ts` is now the only place a design token becomes a scene colour. Before it, the
renderer carried the six status tokens **and** four hex literals (`0x0a0e14` clear, `0x3b536b` /
`0x22303d` floor lines, the beacon fade target). The derived colours are now a function of the
theme: the clear colour and the fog are `--background`, the floor's two line tones are `--border`
composited over it (`—` at its own alpha, the major lines at `1.7×`), and the completion colour is
`--success`. `tests/deck-palette.test.ts` parses `tokens.css` and compares every role's fallback to
the token's value (both blocks — `:root` and `.dark` — must agree), and scans `scene/**` for colour
literals: none exist outside `palette.ts`.

The deck's own chrome followed: `.omp-deck`'s background is `var(--omp-bg)` (`#121820`), which is
what the scene clears to, so the fog dissolves into the panel edge instead of drawing a horizon at
it — and the scene no longer clears to a colour nothing else in the product used.

### 2. The registry, the gate, and the switches

`scene/ambient.ts` holds one registry — id, label, sentence, `minTier`, expression flag, motion
flag, cost class, and what is lost when it is off — and one total gate,
`ambientEnabled(tier, prefs, reducedMotion)`: the effect's own tier, then the tier's `ambient`
allowance for the effects marked `expression` (today only `drift`), then reduced motion, then the
operator's switch. **An override can only ever remove an effect**: `{ drift: true }` at `minimal`
resolves to off, and so does `{ settle: true }` under reduced motion.

| effect | tier | cost | what it does |
|---|---|---|---|
| `floor` | minimal | 1 draw call, ≤ 130 line segments | the ground plane, centred on the rail's box |
| `fog` | minimal, **off by default at `high`** | fill (no pass) | the far edge fades into the panel background |
| `parallax` | minimal | one position write per camera change | the floor trails the camera by ≤ 0.6 world units |
| `settle` | minimal | +1 draw call for ≤ 400 ms, ≤ 4 at once | a completion plate lands on a finished pad |
| `drift` | high | one camera offset, ≤ 0.5 units | the framing breathes while a worker is live |

The fog's tier default is a measurement, not a taste call: at `high` on this
software rasterizer its fragment branch put p95 at 21.10 ms against the tier's
20 ms pin, and the other four effects were not implicated (fog off, the rest on:
13.10 ms). Per the roadmap's own rule — a tier that fails its budget with an effect
on ships that effect off — `fog` now defaults off there and **the switch still
works**, so the operator can have it. `docs/deck-performance-budget.md` §6.2 has
all three arms of that measurement.

The settings panel is generated from that registry (the roadmap's "every effect listed with an on/off
toggle and its tier requirement"): `ambientRows()` produces each row's label, sentence, tier and
blocked reason, and the e2e counts the rows against `AMBIENT_EFFECTS.length`. It is a disclosure
inside the HUD panel — one line that says how many are running, and the rows on request.

Two defects were found and fixed by testing the switches rather than trusting them:

1. **The floor's switch reached nothing.** `floor` was in the registry and in the gate, but the
   renderer never read it, so the HUD said "off" while the grid stayed on the floor. The switch is
   now the object's visibility, and the spec asserts the *reading* (`floorVisible` 1 → 0) and the
   cost of it (`drawCalls` 10 → 9) rather than the panel's own claim. `fog`'s switch is asserted the
   same way through the far plane in force (`fogFar` → `FOG_OFF`), which is why `RenderStats` grew
   three diagnostics (`fogFar`, `floorVisible`, `parallax`).
2. **The runs list could not be clicked where it mattered.** Opening the wall under the time band
   put its rows under the lane strip (DOM order), so an operator could see a run row and not click
   it. Found by the run-complete spec, which could not switch runs; fixed with one `z-index` on the
   open list, and only on the list.

### 3. Measured (`bun scripts/deck-perf.ts`, each tier's default set)

| tier | frames | p50 ms | p95 ms | worst ms | draw calls | objects | layers | programs | idle frames | budget |
|---|---|---|---|---|---|---|---|---|---|---|
| minimal (auto) | 314 | 1.10 | 6.80 | 17.90 | 10 | 78 | 0 | 4 | 0 | PASS |
| standard (pinned) | 317 | 1.40 | 8.00 | 24.20 | 10 | 85 | 0 | 4 | 0 | PASS |
| high (pinned) | 228 | 1.90 | 14.10 | — | 10 | 106 | 0 | 4 | 0 | budget checks pass; window short of 300 frames |

Every **budget** check passes at every tier — the enforced p50/p95 pins, the draw-call ceiling, zero
full-screen layers, the station and beacon caps, constant GPU counters, zero idle frames — with
`programs` staying at **4**, which is the fog's own claim (a branch in the materials the deck already
draws, not a pass). The `frames` column is the one place the box shows through: the harness needs 300
rendered frames to measure percentiles, and this 4-vCPU box was carrying a foreign build (load ≈ 5–9)
for every run — with **every effect off** the same build still reached only 218 at `high`, and the
`minimal` window came up short once at load 9 after passing at load 5. Classified as the existing
environmental behaviour `d10`/`d12` record, not as this slice's cost.

Where the effects *did* cross a pin, the measurement changed the product: at `high`, fog put p95 at
21.10 ms against the 20 ms pin while fog-off/rest-on measured 13.10 ms — so `fog` ships off at that
tier (still switchable). Full attribution in `docs/deck-performance-budget.md` §6.2.

Bundle: `Deck-*.js` 639.64 kB (167.91 kB gzip), **+12.8 kB / +6.2 kB** over `d09`; the shell's
`index-*.js` is unchanged at 458.38 kB, so the dashboard still pays nothing for any of it.

### 4. Completion, and what the HUD says first

- `DeckModel.completion` (`d13`) is derived from `counts` plus the DTO's own `createdAt`/`updatedAt`:
  total, done, failed, skipped, blocked, remaining, `complete`, `terminal`, `durationMs`. The HUD
  states it in one line — `run complete · 1 slice · 2ms`, or `run finished · 8/9 done · 1 failed` —
  present tense only (at a historical cursor the pads carry the recorded state and the line is
  absent). The e2e reaches a genuinely finished run through the wall and asserts the line appears
  with `data-completion="complete"`, then disappears when the surface switches back to a run in
  flight.
- The completion **plate** is the scene's half: `status → done` adds one success-coloured plate that
  falls the last world unit onto the pad and dissolves, ≤ 400 ms, coalesced at `SETTLE_MAX` = 4 with
  ordinary highlights for the rest. It is additive by construction — the pad's height and colour are
  the model's from the first frame, and `instances` (the model's pools) never includes it, which is
  why the `d02`/`d05` instance identities still hold.
- The compact HUD row is three clusters in the operator's question order — state (tier, liveness,
  live count, alerts, completion), frame (fps, cap, calls, objects, scale), world (pads, run,
  motion, history, effects) — and the event line ("LAST CHANGE …") gets a line of its own, because
  it is the only chip whose content moves at run cadence and it is the answer to "what just
  changed?". Grouping is layout only: every chip kept its class and its data attributes, which is
  why the existing specs still read the same HUD.
- Empty and loading states: one centred lowercase sentence became a titled state with a sentence
  that says what the deck is holding meanwhile and where the way back is.

### 5. Verification

| Question | Result |
|---|---|
| does the panel list every effect, with its tier and its switch? | `deck expression pass › the HUD lists every effect from the registry…` — row count == `AMBIENT_EFFECTS.length`, each row's tier text == the registry's `minTier`, `drift` blocked with `needs high` and a disabled input at `minimal` |
| does a toggle reach the *scene*, or only the panel? | `…switching an effect off moves nothing, reaches the scene, and persists` — `floorVisible` 1→0 and `drawCalls` 10→9 with `geometries`/`programs` unchanged; `fogFar` → `FOG_OFF` and back; camera, selection and focus byte-identical after the toggle; `localStorage` holds `{ floor: false }` and a reload comes back with the floor still off |
| is "all effects off" a working deck? | `…every effect off is still a working deck` — `ambient == []`, pads 9, selection and focus change through the real paths, a camera preset flight, real frames drawn |
| reduced motion? | `…reduced motion silences the animated effects…` — `ambient == ["floor", "fog"]`, `parallax`/`settle` blocked with `motion is reduced`, `floor` still on; the existing `d05`/`d09` reduced-motion specs still pass with effects enabled (`peaks.maxTweens` 0) |
| is the run's ending real? | `…the run's ending is named once, from the DTOs, and only while it is true` — no line on the running fixture, `data-completion="complete"` + `run complete · 1 slice` on the finished run reached through the wall, gone again on the way back |
| the whole surface, with effects on | every deck e2e file was run with `--workers=1`: `deck.e2e` **33 passed**, `deck-transitions` + `deck-a11y` (with `deck.e2e`) **40 passed**, `deck-inspector` **6**, `deck-control` **4**, `deck-workflow` **2** (including M6: 2 000 transcript lines over 60 s render no frames), `deck-history` **6** (+ the attempts flake classified below). `bun test` **891 pass / 0 fail** (65 files, +32 for `d13`); `bunx tsc --noEmit` and `git diff --check` clean |

The unit halves are `tests/deck-palette.test.ts` (13) and `tests/deck-ambient.test.ts` (19): the
palette↔`tokens.css` coupling, the colour parser, the registry's completeness, the full gate matrix
(tier × motion × prefs), "an override can only remove an effect", storage sanitising and round-trip,
and the boundedness of every parameter (fog, parallax, drift, settle).

### 6. What this does worse, and open findings

1. **Focus drift is unverifiable on this box.** It only runs at `high` (the tier table's `ambient`
   allowance), and this machine has no hardware GL, so `drift` was exercised through its pure
   function and its gate and **never seen moving**. Its bound (≤ 0.5 units) and its "advances only
   across frames that were already being drawn" rule are unit-tested; the look is owed to a
   hardware-GL machine.
2. **The help overlay still covers the HUD panel.** `H` opens both (`d09`), and the help panel is a
   centred overlay above the panel — which now includes the settings rows. It is the pre-existing
   composition, unchanged by this slice, and `captures/deck-d13-hud.png` shows it; the operator
   closes it with the same key. A later slice should either fold the keymap into the panel or give
   it its own key.
3. **The compact HUD is one line taller.** The "last change" row is the improvement this slice
   wanted, and it costs ~20 px of canvas at the top; the overlay bands follow the measured HUD height
   (`--omp-deck-hud-h`), so nothing is covered — but the deck's usable canvas is that much smaller.
4. **Frame cost at `minimal` reads higher than `d10` recorded** (p50 1.10 ms against 0.5 ms). The
   measurement ran while a foreign build held this 4-vCPU box at load ≈ 5–9, and the same build with
   the effects gated off measured 0.90 ms on a run with a different churn phase — inside the box's own
   spread (`d00` §2), so the effect set is not resolvable here. Both configurations are 6–14× inside
   the p95 budget; the number is reported as measured, not adjusted.
5. **The harness's frame-count window is the one gate this slice does not clear** — not at `minimal`
   under load, and not at `high` in any configuration (218/300 with every effect off). It is a
   *window completeness* check, not a budget check: the harness cannot measure percentiles over 113
   frames, so it fails rather than reporting. Two honest options remain for a later slice: run the
   harness on an idle box (the number `d10` recorded), or teach it to scale its window to the tier's
   measured interval — which `d10` §5.2 already argues for ("a future slice that wants a raster-bound
   demotion rule must add a cap-relative interval threshold").
6. **The `d00` tier table's `ambient` flag was read, not changed.** `minimal`/`standard` still say
   `ambient: false` while four effects run at `minimal`. The flag is treated as the *expression*
   allowance (the roadmap's own words), and the clarifying effects are admitted by measurement
   instead (`docs/deck-performance-budget.md` §6.1). A reviewer who reads the flag as "no effects
   below `high`" would call this a deviation; flipping frozen numbers was the alternative and was
   rejected.
7. **Two flakes, both classified: not this slice's.** Under `--workers=1` at load ≈ 10, one run
   failed `deck focus › F pins the selection, Esc releases it back onto the primary` and another
   failed `deck-history › the selected slice's recorded attempts are on the line`. Every one of them
   passes alone and in the surrounding file runs (the focus spec in the two later full-file runs and
   in a two-spec reproduction; the attempts spec alone and in `deck-inspector`+`deck-history`'s own
   12/13). The focus one is the spec's own documented `settledCamera` hazard — two equal samples can
   both be *pre*-flight when frames are starved — in a `d03` camera-flight assertion; `d13` writes no
   camera state outside the drift path, which is off at `minimal`. The attempts one is a default
   `expect(...).toHaveCount(2)` poll on a box that was carrying a foreign build. Left as recorded
   environmental behaviour rather than re-pinned or loosened here.
8. **The completion plate has no e2e of its own.** It is exercised by `deck-perf.ts`'s status churn
   (claim → finish → fail → retry), where the counters stay inside budget, and by the cue tests for
   the machinery it reuses; the fixture cannot reach a `done` transition without mutating the run
   every other spec shares, so the *look* of one plate landing is unchecked by the suite. Verify by
   hand on a run that finishes: `S` in `captures` terms, one plate, ≤ 400 ms.

### Acceptance criteria (d13)

| Criterion | Result |
|---|---|
| effects on change no acceptance criterion of `d03`–`d09` | ✔ the full `deck.e2e.ts` (33) plus `deck-transitions` and `deck-a11y` pass with the default effect set on |
| idle with ambient enabled renders 0 frames over 2 s | ✔ harness idle window 0 frames over 2031 ms; the deck's own idle spec passes with the floor, fog, parallax and settle running |
| `scripts/deck-perf.ts` passes at every tier with that tier's default effect set | ✔ every budget check at every tier (`minimal` p50 1.10 / p95 6.80; `standard` 1.40 / 8.00; `high` 1.90 / 14.10, after the fog default); the frame-count window came up short on this loaded box in every configuration, including with every effect off — recorded, with the arms, in `docs/deck-performance-budget.md` §6.2 |
| toggling an effect never moves the camera, changes the selection, or re-creates scene objects | ✔ asserted, and the switch's own scene reading is asserted with it (`floorVisible`, `drawCalls`, `fogFar`) |
| no colour literal in `scene/**` outside `palette.ts` | ✔ asserted by `tests/deck-palette.test.ts`, which also proves the palette and `tokens.css` agree |
| gates clean | ✔ `tsc --noEmit`, `bun test` (890), `git diff --check` |

---

## d14 — operability, docs, evidence, release gate

No product code: docs, one capture script, one gate assertion, one README section, and the
sweep that proves the rest still holds. The only runtime-adjacent files touched are
`tests/release-gate.test.ts` (+29 lines: the removability assertion) and `package.json`
(one script: `deck:captures`).

### Reproduce

```bash
bunx tsc --noEmit
bun test                                                       # 892 pass / 0 fail, 65 files
git diff --check
bun run web:build                                              # bundle identical to the d13 build
bun run deck:captures                                          # 9/9 shots ok → captures/deck-qa.json
bun scripts/deck-desktop-check.ts                              # ok
bun scripts/gen-captures.ts                                    # TUI captures byte-identical
bun build --compile src/cli.ts --outfile /tmp/ompo-deck-smoke  # 98 646 144 bytes
```

### 1. What landed

- **`docs/deck-architecture.md`** — the as-built sibling of
  `docs/web-dashboard-architecture.md`: module map (§2), CP-1…CP-8 with evidence and triggers
  (§3), data flow with every cadence and bound (§4), the endpoint table with the deck's exact
  consumption per route (§5: shell-owned vs dock-owned vs live-window-owned), tier/effect tables
  (§6), the enforced-rules table (§7), install/launch/run/reconnect/failure/cleanup (§8),
  surface + prefs contracts (§9), bundle/binary/measured record (§10), platform matrix (§11),
  removability proof (§12), honesty + not-built + revisit trigger (§13), accepted-vs-blocker
  verdicts (§14), and the review checklist with the sweep commands (§15).
- **`scripts/deck-captures.ts`** (`bun run deck:captures`) — evidence generator over the e2e
  fixture server: prefs seeded per shot, 9 screenshots + `captures/deck-qa.json` with one
  assertion each. This run: **9/9 ok** (minimal 3d, 2 alerts, standard, high, effects-off
  `ambient []`, flat forced with 0 canvases, reduced `ambient [floor,fog]`, dock open · Output,
  2 wall rows).
- **Removability assertion** — `tests/release-gate.test.ts` scans every `web/src` module
  specifier (static + dynamic; comments do not count): no file outside `App.tsx` references
  `scene/`, and `App.tsx` touches exactly the three seams (instrument import, `ReplayState`
  type, lazy chunk). `Header.tsx` asserted scene-free separately.
- **README "Deck" section** — gained the three opens (URL, toggle/`D`, launcher), fallback,
  platform pointer, the honest "dashboard is better at forensics" paragraph, and the evidence
  pointers. The d11 handshake lines are unchanged.

### 2. Measured

| Artifact | Bytes | Note |
|---|---|---|
| `Deck-D4TrDqWJ.js` (lazy) | 639 890 (gzip ~162 KB) | byte-identical name+size to the d13 build |
| `index-meK1i3v6.js` (shell) | 458 380 (gzip ~134 KB) | untouched — the dashboard pays nothing |
| Smoke binary `/tmp/ompo-deck-smoke` | 98 646 144 | +180 224 (+0.18%) vs gitignored `./ompo` — toolchain noise, embedded bundle identical |
| Smoke serves | `/` 200 · `/api/health` `{"ok":true,"version":"0.2.0"}` · `/?surface=deck` 200 · deck chunk 200 | loopback proxy bypass (`NO_PROXY`) required — without it the same curls 502 |
| `bun test` | 892 pass / 0 fail (65 files) | release-gate 19/19 incl. the new assertion |
| CLI smoke | `plan` 0 (1 warning) · `run --dry-run` 0 · `--tui --help` 0 · `logs --help` 0 | no regressions on the non-deck surfaces |
| `deck.e2e.ts --workers=1` | 31 passed / 2 failed in the full file (7.3 min) — both classified environmental (below): each passes alone (7.0 s / 9.3 s) |

### 3. What this does worse, and open findings

1. **Two full-file e2e failures, both classified — not this slice's.** `deck focus › F pins the
   selection` (camera `x` 0 vs 0.0011, `z` 5.5200 vs 5.5194 — the spec's own documented
   `settledCamera` hazard: two equal samples both pre-flight when frames starve) and `deck
   alerts › dismissing clears row and beacon` (`beacons` 0 where ≥ alerts expected — an earlier
   spec's control event had already moved the shared fixture: the snapshot shows `p-two`/`p-one`
   skipped with a `control-rejected` alert outstanding). Both pass alone (7.0 s / 9.3 s); d13
   recorded the same class twice under load; d14 writes no camera, alert, or control code.
   Left as recorded environmental behaviour rather than re-pinned or loosened here.
2. **The e2e tail is the release's slowest gate.** `deck.e2e.ts` alone runs for many minutes on
   SwiftShader; the full `--workers=1` sweep is a patience test this box has never completed in
   one sitting (d12). d14 adds no coverage to make it slower — but it does not make it faster
   either.
3. **`deck-captures.ts` overlaps the d13 captures.** The d13 PNGs (`deck-d13-*.png`) stay as the
   expression pass's own record; the d14 set (`deck-tier-*.png`, `deck-effects-off.png`, …) is
   the release record. Two captures of "effects off" exist on purpose, one per slice.
4. **M10, Tauri acceptance, drift's look, the help/HUD overlap** — unchanged, all accepted
   risks (§14 of the architecture note). d14 decides them, fixes none of them.

### Verdict

**PASS — recommendation, not a decision.** d14 is the release gate doing its job: the deck is
documented, reproducible, removable, and measured — with the same owed items it entered with,
named as accepted risks rather than fixed.

## ux00 — baseline freeze (UX correction pass, pre-UX01)

Baseline for UX01–UX04 comparison. No product code changed. One tooling fix:
`scripts/deck-captures.ts` (+4 lines: restore the `--port`/`base`/`headed`
bindings the d14 commit dropped — as committed the script threw
`ReferenceError: port is not defined` before spawning the fixture server).

Reproduce: `bun run web:build && bun run deck:captures` → **9/9 ok**
(`captures/deck-qa.json`, 1440×900, `tests/e2e/serve.ts` fixture, embedded
bundle). This run (2026-09-14): minimal 3d, 2 alerts, standard, high,
effects-off `ambient []`, flat forced 0 canvases, reduced `ambient
[floor,fog]`, dock open · Output, 2 wall rows — all ok.

Primary states (the "before" pictures): `deck-tier-minimal.png` (default
operator view, SwiftShader → minimal), `deck-alerts.png` (same world, failed +
blocked-env stack), `deck-flat.png` (forced flat, 0 canvases), `deck-inspector.png`
(dock open · Output), `deck-wall.png` (2 run rows).

Overlay/layout config frozen: HUD one strip (state / frame / world clusters +
`last change` line + `dl.omp-deck-costs` + effects disclosure behind `HUD`);
time band (`--omp-deck-time-h: 76px`: LIVE/RETURN, slider, ribbon `ol`,
`runs (N)`, `verify replay`); station line left + `omp-deck-lanes` right
(per-station `heroAction` tail, focused-row `Inspect`); right column
(`omp-deck-right`: alertcol above linewrap = alerts + selected line +
`DeckControlBar`); live window (`LiveFeed` verbatim) bottom-left; mirror
(`MIRROR_LIMIT=200`, roving) hidden until focused; help (`DECK_KEYS` verbatim,
`H`/`?`) overlaps the HUD panel — accepted risk, arch §14.

UX05 fixtures frozen to the same `serve.ts` run (`e2emain`: s-alpha/s-beta
done, longtitle + verifying + running live = 3, longreason failed,
envblock blocked-env, p-one/p-two pending; + `e2e-overflow-probe` run).
S1–S4 derive from this run — no new benchmark framework.

Worse: d14's committed "9/9 ok" claim contradicted the tree until this fix
(the script could not run at HEAD). No renderer, tier, model, or overlay
change in this slice.

## ux01 — conservative spatial labels + legend

Objective: name the pooled stations in the scene so the operator stops
cross-referencing the lane strip for basic identity (§2 hierarchy:
focus/primary always, live normally, beaconed conditionally).

Reproduce: `bunx tsc --noEmit`; `bun test tests/deck-labels.test.ts
tests/deck-fallback.test.ts tests/release-gate.test.ts` (40 pass);
`bun run web:build` + fixture check → 3 labels
(`longtitle·Work` focused, `verifying·Verify`, `running·Work`), legend
closed chip, flat 0 labels / 0 legend / 0 canvases, reduced-motion 3 labels.

What landed: `scene/labels.ts` (pure: `labelStage` first-word short,
`spatialLabelFor` `id · Stage` + glyphs, `labelIds` focus→primary→live→alerted
over pooled stations only, `capLabels` with focus/primary protection,
`alertGlyphFor` severest beacon); `Deck.tsx` projection at camera-settle /
model / resize cadence (`refreshLabelPositions`, `LABEL_CAP=8`, anchor y=2.2
above tallest pad .85 + station headroom); `DeckOverlay.tsx` `aria-hidden`
labels layer + closed `Legend` disclosure (§11 semantics, 8 rows); theme.css
positioning (labels `translate(-50%,-130%)`, legend above live window);
`SEVERITY_GLYPH` hoisted `DeckOverlay.tsx` → `alerts.ts` (shared, no copy).
`tests/deck-labels.test.ts` (5 specs: stage short, text cap, order,
alert-after-live, cap protection).

Acceptance: labels materially simpler than lanes (id+stage+glyph vs lane's
status/stage/meta/action tail + Inspect); capped at 8 with `+N more` stated;
crowding solved by suppression (project-null, over-cap), never smaller text;
no logs/paths/reasons/controls/tables in labels — Inspector owns those.

Worse: the default view keeps every pre-UX01 panel (lanes, HUD strip,
alerts, control, live window) — subtraction is UX03's job, not this slice's.
Labels sit above pads and can sit under the lane strip on narrow windows;
the anchor is fixed, not occlusion-aware.
