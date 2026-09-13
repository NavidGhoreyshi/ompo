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
