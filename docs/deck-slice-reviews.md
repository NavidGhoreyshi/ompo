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
