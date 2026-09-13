# Deck slice reviews (d00–d03v)

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
