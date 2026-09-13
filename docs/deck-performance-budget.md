# Deck performance budget (roadmap `d00`)

What a deck frame is allowed to spend, measured on the machine that runs it. This document and
`web/src/scene/tier.ts` are two views of one table: `tests/deck-perf.test.ts` parses the tier
table below and fails if a number here and a number there drift apart. Slice `d00` of
`docs/desktop-3d-roadmap.md` owns both; `d10` enforces the budget with a harness.

- Raw artifacts: `captures/deck-probe-headless.json`, `captures/deck-probe-headless-2.json`,
  `captures/deck-probe-headed.json` (two independent headless runs + one headed run, taken
  2026-09-12).
- Probe: `scripts/deck-probe.ts` (Playwright chromium, WebGL2, no app code).

## 1. Machine

| Fact | Value |
|---|---|
| CPU / RAM | Intel(R) Core(TM) i7-4500U @ 1.80 GHz, 4 vCPU, 10.4 GB |
| OS / kernel | WSL2, Linux 6.18.33.2-microsoft-standard-WSL2, WSLg 1.0.73.2 |
| Browser | Playwright chromium 151.0.7922.34 (`~/.cache/ms-playwright/chromium-1234`) |
| Vendor string | `Google Inc. (Google)` |
| Renderer string (`UNMASKED_RENDERER_WEBGL`) | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` |
| GL / limits | WebGL 2.0 (OpenGL ES 3.0 Chromium), `MAX_TEXTURE_SIZE` 8192, `MAX_SAMPLES` 4, devicePixelRatio 1 |
| Tier this implies | `minimal` (`classifyRenderer`) |

There is **no hardware GL** on this box: every fragment is rasterized on the CPU. The renderer
string is identical headless and headed, and so are the timings (see §3.3) — the measurements
below are the machine's, not the mode's.

## 2. Method

The probe is the only sanctioned way to produce these numbers; this section is what makes them
comparable across machines and across time.

1. **Full-screen fill benchmark.** A 3-vertex triangle covering the viewport with a trivial
   fragment shader, drawn 1× / 2× / 4× / 8× per frame (`overdraw`), so the deck's fill cost is
   measured rather than inferred. Depth test, blend, cull and scissor are off: every layer shades
   every pixel. Clearing happens outside the timed region.
2. **Completion is forced explicitly.** Each frame ends with `gl.finish()` **followed by** a
   1-pixel `readPixels`. A bare `gl.finish()` does not synchronise in this Chromium build and
   returns meaningless sub-millisecond numbers (roadmap A.6); the readPixels is what makes the
   measurement real.
3. **Samples, not samples-of-one.** Each configuration is measured `--repeat 3` times (default) in
   three full passes and reported as min/median/max. A sample is the mean of up to 20 frames
   (warm-up: up to 5 frames, capped at 400 ms); heavy configurations stop at a 900 ms window with
   a floor of 5 frames, and the frame count behind every sample is recorded in the artifact. The
   spread on this machine is large (~1.6× between runs on the same configuration), which is why
   single samples are forbidden here.
4. **Skipped on purpose.** 2560×1440 is measured at 1× and 4× only — 2× and 8× take minutes per
   repeat on a software rasterizer. 14 fill configurations are measured (≥ 12 required).
5. **Object cost.** 8 px quads at 1280×720, swept as instances (one `drawArraysInstanced`) and as
   separate `drawArrays` calls, plus one baked 20 000-quad draw in a single call — the three ways a
   scene graph can submit the same objects.
6. **Run hygiene.** Headless and headed runs are taken separately, never concurrently; the JSON
   records the mode, the elapsed time and `glError` (0 for every run cited here).

Re-measure (≈1 min per run; `--repeat 1` halves it, at the cost of a wider range):

```bash
bun scripts/deck-probe.ts --json > captures/deck-probe-headless-$(date +%Y%m%d).json
bun scripts/deck-probe.ts --headed --json > captures/deck-probe-headed-$(date +%Y%m%d).json
```

## 3. Measured (2026-09-12)

### 3.1 Fill — full-screen layers, ms per frame

min/median/max over 6 samples (2 headless runs × 3 repeats). `frames` is the per-sample frame
count (all 20 unless noted). `ns/px` is the median divided by shaded pixels — the marginal cost of
one more layer.

| resolution | overdraw | MPx | min | median | max | ns/px | frames |
|---|---|---|---|---|---|---|---|
| 640×360 | 1× | 0.23 | 2.97 | 3.35 | 4.63 | 14.6 | 20 |
| 640×360 | 2× | 0.46 | 5.03 | 5.54 | 5.98 | 12.0 | 20 |
| 640×360 | 4× | 0.92 | 8.23 | 9.20 | 10.42 | 10.0 | 20 |
| 640×360 | 8× | 1.84 | 15.13 | 15.96 | 21.21 | 8.7 | 20 |
| 1280×720 | 1× | 0.92 | 8.21 | 9.91 | 11.76 | 10.8 | 20 |
| 1280×720 | 2× | 1.84 | 15.49 | 17.54 | 18.64 | 9.5 | 20 |
| 1280×720 | 4× | 3.69 | 29.09 | 32.16 | 35.61 | 8.7 | 20 |
| 1280×720 | 8× | 7.37 | 55.86 | 65.89 | 90.29 | 8.9 | 10–17 |
| 1920×1080 | 1× | 2.07 | 18.05 | 20.24 | 25.46 | 9.8 | 20 |
| 1920×1080 | 2× | 4.15 | 33.97 | 39.11 | 72.25 | 9.4 | 13–20 |
| 1920×1080 | 4× | 8.29 | 62.03 | 78.35 | 119.26 | 9.5 | 8–15 |
| 1920×1080 | 8× | 16.59 | 124.54 | 151.82 | 294.64 | 9.2 | 5–8 |
| 2560×1440 | 1× | 3.69 | 31.37 | 36.57 | 41.85 | 9.9 | 20 |
| 2560×1440 | 4× | 14.75 | 109.88 | 128.93 | 153.92 | 8.7 | 6–9 |

**Marginal fill ≈ 9 ns per shaded pixel (≈ 9 ms per MPx).** The small resolutions read higher
because a fixed ~1 ms per-frame overhead (sync + submission) dominates there.

### 3.2 Objects — 8 px quads at 1280×720, ms per frame

| configuration | min | median | max | per object |
|---|---|---|---|---|
| 64 instances, 1 draw call | 1.91 | 3.41 | 5.24 | 53 µs |
| 256 instances, 1 draw call | 7.40 | 11.50 | 16.38 | 45 µs |
| 2 000 instances, 1 draw call | 53.00 | 75.91 | 115.69 | 38 µs |
| 20 000 instances, 1 draw call | 534.04 | 558.94 | 992.22 | **27.9 µs** |
| 10 separate draw calls | 0.88 | 1.04 | 1.32 | 104 µs |
| 100 separate draw calls | 3.31 | 3.59 | 4.33 | 36 µs |
| 1 000 separate draw calls | 28.31 | 31.31 | 41.81 | **31.3 µs** |
| 20 000 quads baked into one VBO, 1 draw call (120 000 verts) | 47.22 | 48.61 | 53.07 | 2.4 µs |

The per-object column divides the median by the object count; below ~100 objects it is dominated
by the ~0.7 ms fixed per-frame floor (at 10 calls, ~0.3 ms is drawing and ~0.7 ms is the
`finish`+`readPixels` sync and submission).

**Instancing is not a batching win on this driver.** One instance costs ~28 µs, one separate draw
call ~31 µs: 20 000 instanced objects cost 559 ms, the same 20 000 objects baked into a single
draw cost 49 ms (the fill is only ~11 ms of that). The per-instance charge is CPU-side inside
ANGLE/SwiftShader, not fill — a 1 px and an 8 px instance cost the same (measured during `d00`
attribution). Consequences, both binding for later slices:

- Budget **objects**, not draw calls: an instance and a call cost the same. `d10`'s harness must
  count `instances + draw calls`.
- Instancing remains the right *authoring* choice (one buffer, one state change per kind) and is
  affordable at deck scale — 65 objects ≈ 3 ms — but it must never be used to render thousands of
  objects as a performance strategy on this machine. Detail level is a tier decision (§4), not a
  batching decision.

### 3.3 Headed vs headless

The headed run (real WSLg window) tracks the second headless run within ±13 % on all 14 fill
configurations (ratio headed/headless median: 0.87–1.08, mean 0.97) and 561.9 ms vs 540.3 ms for
the 20 k-instance draw. Same software rasterizer, same budget: **the tier does not depend on the
mode**, and the probe's default headless mode is the one to re-run.

## 4. Budget

### 4.1 Cost model

For a 1280×720 viewport at tier `minimal` (backing store 0.5× → 640×360), fitted to the medians
of §3:

```
frame_ms ≈ 0.9 (fixed)  +  9.0 × shaded_MPx  +  0.03 × objects
```

`objects` counts instanced instances plus separate draw calls. `shaded_pixels` counts every layer
that covers a pixel, i.e. the sum over the scene of the area each pass rasterizes.

### 4.2 Tier table (frozen; parsed by `tests/deck-perf.test.ts`)

| tier | resolutionScale | maxFps | antialias | maxDrawCalls | maxStations | maxBeacons | ambient |
|---|---|---|---|---|---|---|---|
| minimal | 0.5 | 30 | false | 24 | 8 | 32 | false |
| standard | 1 | 60 | false | 48 | 16 | 64 | false |
| high | 1 | 60 | true | 96 | 32 | 128 | true |

What the caps cost on this machine, at the model above:

| tier | worst-case fill | worst-case objects | verdict on this machine |
|---|---|---|---|
| minimal | 640×360 (0.23 MPx), 4 layers = 9.2 ms | 24 + 36 + 32 = 92 objects = 4.6 ms | 0.9 + 9.2 + 4.6 = **14.7 ms** vs the 22 ms allowance (33 ms p50 ÷ 1.5) → fits with ≈ 1.5× spare |
| standard | 1280×720 (0.92 MPx) = 9.9 ms for **one** layer | 48 + 36 + 64 = 148 objects = 4.9 ms | one layer costs 15.7 ms against an 11.1 ms allowance (16.7 ms ÷ 1.5) → needs hardware GL |
| high | 1280×720 with MSAA, i.e. more pixels per layer than `standard` | 96 + 36 + 128 = 260 objects = 7.8 ms | not selectable on this machine and never guessed from a vendor string; the tier exists for hardware GL |

The station term (`d04`) is the one cap that is not one object per worker: every live worker draws
its own column of stage marks (≤ `SHAFT_SEGMENTS` = 4 instances, all in one pooled
`InstancedMesh`), plus ≤ 4 marks for the workers the pool cannot hold. On `minimal` that is
≤ 8 × 4 + 4 = 36 objects; the fixture the slice reviews measure (3 live workers, 7 filled marks)
draws 7. The marks are one instanced mesh across all workers, so the cap costs instances, never
draw calls or geometries, and nothing is allocated per worker beyond the one pooled buffer sized
for the `high` tier (`STATION_POOL`).

### 4.3 Decision rules (binding for `d01`–`d14`)

1. **Budgets carry ≥ 1.5× headroom over the best measured sample.** A scene is admitted only if
   `1.5 × estimated_ms ≤ frame target`, using the medians above. The measured cross-run spread on
   this machine reaches 1.6× (1280×720 8×: 55.86 → 90.29 ms), so a scene that only fits at the
   median does not fit.
2. **Frame targets:** `minimal` p50 ≤ 33 ms and p95 ≤ 45 ms (M2), rendering on demand at ≤ 30 fps
   with **zero frames while idle** (M3: ≤ 3 frames over a 60 s settled window). A tier's `maxFps` is
   a cap, not a target: exceeding it is never allowed, and falling short of it is the expected
   state of the minimal tier.
3. **Which dimension binds:** pixels, not objects. At 9 ns/px a shaded pixel is only worth a 57×57
   px area per 30 µs object, so the deck's small quads are object-bound (fill is free at that size)
   while the background/rail/island surfaces are pixel-bound. Optimise the large surfaces first;
   reduce object count only past ~250 objects.
4. **Tier selection is not a guess:** `classifyRenderer` returns `minimal` for any software string,
   `standard` for hardware (and for an unknown/empty string), and **never** `high` — `high` is only
   ever an explicit operator choice (`T` in `d01`, persisted). A machine that classifies `standard`
   but performs like this one is `d10`'s runtime controller's problem: it demotes on measured
   frame cost, and this document is why that controller exists (CP-6).
5. **No WebGL2 is a legitimate outcome, not an error.** The probe exits 0 with `"webgl2": false`;
   the deck must take the `d09` flat path there rather than attempting a scene.
6. **Re-measure when:** the target machine, GPU driver, WSLg/WSL kernel or Chromium major version
   changes, or before `d10` pins its harness — and after any two consecutive runs whose medians
   differ by more than 1.6×, since that means the machine, not the scene, is the variable.
7. **A new machine means a new table, not a new architecture.** On hardware GL the numbers in
   §3 drop by roughly two orders of magnitude; `standard`/`high` become the defaults and the tier
   constants move — the cost model, the rules above and the tier boundaries stay as they are.

### 4.4 What this budget does not cover

Compositing and display of the final frame, texture upload, shader compilation, DOM/React cost of
the overlay, SSE/poll latency and event-to-screen latency. Those are measured separately by the
gate (`d03v`, M4/M5/M13) and enforced by `d10`; this document is only the renderer's allowance.

[INFERENCE] Extrapolation beyond the measured range (e.g. 2× or 4× the slice count) is a
prediction from the cost model, not a measurement — the model is linear in pixels and objects and
was taken over a 0.23–16.6 MPx and 1–20 000 object range, which covers the deck's design envelope
by more than an order of magnitude in both dimensions.
