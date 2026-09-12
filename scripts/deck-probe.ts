#!/usr/bin/env bun
/**
 * Deck rendering probe — roadmap slice `d00` (docs/desktop-3d-roadmap.md).
 *
 * Measures the rendering environment the deck will actually run on and prints
 * the numbers that `docs/deck-performance-budget.md` records. This is an
 * evidence tool, in the same class as `scripts/web-captures.ts`: it is not
 * part of the shipped dashboard and app code never imports it.
 *
 * Method (binding, see A.6 of the roadmap):
 *  - every timing forces completion with `gl.finish()` *followed by* a 1-pixel
 *    `readPixels` — a bare `gl.finish()` returns meaningless sub-millisecond
 *    numbers in this Chromium build;
 *  - each configuration is measured `--repeat` times (default 3) and reported
 *    as min/median/max — single samples are meaningless (≈40 % spread);
 *  - a sample is the mean of up to `--max-frames` frames (20) but runs at
 *    least `--min-frames` (5) and stops once `--sample-ms` (900 ms) has
 *    elapsed, so a full pass stays near a minute on a software rasterizer.
 *    The frame count behind every sample is recorded in the JSON;
 *  - 2560×1440 is measured at 1× and 4× only; 2× and 8× would take minutes.
 *
 * Usage:
 *   bun scripts/deck-probe.ts                 # human table, headless
 *   bun scripts/deck-probe.ts --json          # machine output (stdout only)
 *   bun scripts/deck-probe.ts --headed        # real WSLg window
 *   bun scripts/deck-probe.ts --repeat 5      # more samples, slower
 */

import { existsSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { chromium, type Browser } from "playwright";
import { classifyRenderer, TIER_BUDGETS, type QualityTier } from "../web/src/scene/tier.ts";

const SYNC_METHOD = "gl.finish()+readPixels(1x1)";

/** Fill configurations. `overdraw` = full-screen layers drawn per frame. */
const RESOLUTIONS: { w: number; h: number; overdraw: number[] }[] = [
  { w: 640, h: 360, overdraw: [1, 2, 4, 8] },
  { w: 1280, h: 720, overdraw: [1, 2, 4, 8] },
  { w: 1920, h: 1080, overdraw: [1, 2, 4, 8] },
  // 2× and 8× at 2560×1440 would take minutes per repeat on SwiftShader.
  { w: 2560, h: 1440, overdraw: [1, 4] },
];

const OBJECT_RESOLUTION = { w: 1280, h: 720, quadPx: 8 };
/** Instance counts swept for the per-object cost; 20 000 is the headline number. */
const INSTANCE_COUNTS = [64, 256, 2_000, 20_000];
/** Separate drawArrays calls per frame, one quad each. */
const DRAW_CALL_COUNTS = [10, 100, 1_000];
/** The same 20 000 quads baked into one vertex buffer, drawn in a single call. */
const BAKED_QUADS = 20_000;

interface Options {
  headed: boolean;
  json: boolean;
  repeat: number;
  sampleMs: number;
  warmupMs: number;
  warmupFrames: number;
  minFrames: number;
  maxFrames: number;
}

interface RunSample {
  frames: number;
  warmupFrames: number;
  mean: number;
}

interface Stat {
  min: number;
  median: number;
  max: number;
}

const HELP = `deck-probe — rendering environment probe for the deck (roadmap d00)

Usage: bun scripts/deck-probe.ts [options]

  --headless        run headless (default)
  --headed          run in a real window; falls back to headless with
                    "headed": "unavailable" when there is no display
  --json            print the JSON report on stdout (nothing else on stdout)
  --repeat N        measurement runs per configuration (default 3)
  --sample-ms N     measurement window per run (default 900)
  --min-frames N    minimum frames per sample (default 5)
  --max-frames N    maximum frames per sample (default 20)
  --warmup-frames N warm-up frames per run (default 5)
  --warmup-ms N     warm-up window per run (default 400)
  --help            this text
`;

function readNumber(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const raw = argv[i + 1];
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} expects a positive number, got ${raw ?? "(nothing)"}`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  return {
    headed: argv.includes("--headed"),
    json: argv.includes("--json"),
    repeat: readNumber(argv, "--repeat", 3),
    sampleMs: readNumber(argv, "--sample-ms", 900),
    minFrames: readNumber(argv, "--min-frames", 5),
    maxFrames: readNumber(argv, "--max-frames", 20),
    warmupFrames: readNumber(argv, "--warmup-frames", 5),
    warmupMs: readNumber(argv, "--warmup-ms", 400),
  };
}

const round = (x: number): number => Math.round(x * 100) / 100;

function stat(values: number[]): Stat {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min: round(sorted[0]!), median: round(median), max: round(sorted[sorted.length - 1]!) };
}

/** Shape returned by the page-side probe (see the `evaluate` body below). */
interface PageProbe {
  webgl2: boolean;
  reason?: string;
  renderer?: {
    vendor: string;
    renderer: string;
    glVersion: string;
    maxTextureSize: number;
    maxSamples: number;
    devicePixelRatio: number;
  };
  fills?: { w: number; h: number; overdraw: number; mpx: number; runs: RunSample[] }[];
  objects?: {
    res: { w: number; h: number };
    quadPx: number;
    instanced: { count: number; fillMPx: number; runs: RunSample[] }[];
    drawCalls: { calls: number; runs: RunSample[] }[];
    batched: { quads: number; vertices: number; fillMPx: number; runs: RunSample[] };
  };
  glError?: number;
}

// The measurement crosses a process boundary, so it is validated rather than
// trusted: a silently malformed result would end up in the budget document.

function badShape(what: string): never {
  throw new Error(`probe page returned an unexpected shape: ${what}`);
}

function rec(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) badShape(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) badShape(`${what} is not a number`);
  return value;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") badShape(`${what} is not a string`);
  return value;
}

function parseRuns(value: unknown, what: string): RunSample[] {
  if (!Array.isArray(value)) badShape(`${what} is not an array`);
  return value.map((raw, i) => {
    const r = rec(raw, `${what}[${i}]`);
    return {
      frames: num(r.frames, `${what}[${i}].frames`),
      warmupFrames: num(r.warmupFrames, `${what}[${i}].warmupFrames`),
      mean: num(r.mean, `${what}[${i}].mean`),
    };
  });
}

function parsePageProbe(raw: unknown): PageProbe {
  const root = rec(raw, "root");
  if (root.webgl2 === false) {
    return { webgl2: false, reason: typeof root.reason === "string" ? root.reason : undefined };
  }
  if (root.webgl2 !== true) badShape("webgl2 is not a boolean");
  const r = rec(root.renderer, "renderer");
  const fillsRaw = root.fills;
  if (!Array.isArray(fillsRaw)) badShape("fills is not an array");
  const obj = rec(root.objects, "objects");
  const objRes = rec(obj.res, "objects.res");
  if (!Array.isArray(obj.instanced)) badShape("objects.instanced is not an array");
  if (!Array.isArray(obj.drawCalls)) badShape("objects.drawCalls is not an array");
  const batched = rec(obj.batched, "objects.batched");
  return {
    webgl2: true,
    renderer: {
      vendor: str(r.vendor, "renderer.vendor"),
      renderer: str(r.renderer, "renderer.renderer"),
      glVersion: str(r.glVersion, "renderer.glVersion"),
      maxTextureSize: num(r.maxTextureSize, "renderer.maxTextureSize"),
      maxSamples: num(r.maxSamples, "renderer.maxSamples"),
      devicePixelRatio: num(r.devicePixelRatio, "renderer.devicePixelRatio"),
    },
    fills: fillsRaw.map((rawFill, i) => {
      const f = rec(rawFill, `fills[${i}]`);
      return {
        w: num(f.w, `fills[${i}].w`),
        h: num(f.h, `fills[${i}].h`),
        overdraw: num(f.overdraw, `fills[${i}].overdraw`),
        mpx: num(f.mpx, `fills[${i}].mpx`),
        runs: parseRuns(f.runs, `fills[${i}].runs`),
      };
    }),
    objects: {
      res: { w: num(objRes.w, "objects.res.w"), h: num(objRes.h, "objects.res.h") },
      quadPx: num(obj.quadPx, "objects.quadPx"),
      instanced: obj.instanced.map((rawRow, i) => {
        const row = rec(rawRow, `objects.instanced[${i}]`);
        return {
          count: num(row.count, `objects.instanced[${i}].count`),
          fillMPx: num(row.fillMPx, `objects.instanced[${i}].fillMPx`),
          runs: parseRuns(row.runs, `objects.instanced[${i}].runs`),
        };
      }),
      drawCalls: obj.drawCalls.map((rawRow, i) => {
        const row = rec(rawRow, `objects.drawCalls[${i}]`);
        return {
          calls: num(row.calls, `objects.drawCalls[${i}].calls`),
          runs: parseRuns(row.runs, `objects.drawCalls[${i}].runs`),
        };
      }),
      batched: {
        quads: num(batched.quads, "objects.batched.quads"),
        vertices: num(batched.vertices, "objects.batched.vertices"),
        fillMPx: num(batched.fillMPx, "objects.batched.fillMPx"),
        runs: parseRuns(batched.runs, "objects.batched.runs"),
      },
    },
    glError: num(root.glError, "glError"),
  };
}

const hasDisplay = (): boolean => Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

async function launch(opts: Options): Promise<{ browser: Browser; mode: "headless" | "headed"; headed: string }> {
  if (!opts.headed) {
    return { browser: await chromium.launch({ headless: true }), mode: "headless", headed: "headless" };
  }
  if (!hasDisplay()) {
    return { browser: await chromium.launch({ headless: true }), mode: "headless", headed: "unavailable" };
  }
  try {
    return { browser: await chromium.launch({ headless: false }), mode: "headed", headed: "headed" };
  } catch (err) {
    process.stderr.write(`deck-probe: headed launch failed (${err instanceof Error ? err.message.split("\n")[0] : err}); falling back to headless\n`);
    return { browser: await chromium.launch({ headless: true }), mode: "headless", headed: "unavailable" };
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    process.stderr.write(
      `deck-probe: no Playwright chromium at ${executable}\n` +
        `deck-probe: install it with: bunx playwright install chromium\n`,
    );
    process.exit(1);
  }

  const started = Date.now();
  const { browser, mode, headed } = await launch(opts);

  let pageProbe: PageProbe;
  let browserVersion: string;
  try {
    browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.exposeFunction("__deckProbeProgress", (label: string) => {
      process.stderr.write(`deck-probe: ${label}\n`);
    });
    pageProbe = parsePageProbe(
      await page.evaluate(
        async (req: {
          fills: { w: number; h: number; overdraw: number }[];
          objects: {
            w: number;
            h: number;
            quadPx: number;
            instanceCounts: number[];
            drawCallCounts: number[];
            bakedQuads: number;
          };
          repeat: number;
          sampleMs: number;
          warmupMs: number;
          warmupFrames: number;
          minFrames: number;
          maxFrames: number;
        }) => {
          // Playwright installs this hook via exposeFunction; absent when the page is driven directly.
          const host = globalThis as unknown as { __deckProbeProgress?: (label: string) => void };
          const progress = (label: string): void => host.__deckProbeProgress?.(label);

          const canvas = document.createElement("canvas");
          document.body.appendChild(canvas);
          const gl = canvas.getContext("webgl2", {
            antialias: false,
            alpha: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: false,
            powerPreference: "high-performance",
          });
          if (!gl) return { webgl2: false, reason: "getContext('webgl2') returned null" };

          const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
          const renderer = {
            vendor: String(debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
            renderer: String(debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
            glVersion: String(gl.getParameter(gl.VERSION)),
            maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
            maxSamples: Number(gl.getParameter(gl.MAX_SAMPLES)),
            devicePixelRatio: window.devicePixelRatio,
          };

          const compile = (type: number, src: string): WebGLShader => {
            const sh = gl.createShader(type);
            if (!sh) throw new Error("createShader failed");
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
              throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
            }
            return sh;
          };
          const link = (vs: string, fs: string): WebGLProgram => {
            const p = gl.createProgram();
            if (!p) throw new Error("createProgram failed");
            gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
            gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
            gl.linkProgram(p);
            if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
              throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
            }
            return p;
          };

          // Trivial fragment shader: three vertices cover the whole viewport.
          const FILL_VS = [
            "#version 300 es",
            "void main() {",
            "  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));",
            "  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);",
            "}",
          ].join("\n");
          const FILL_FS = [
            "#version 300 es",
            "precision highp float;",
            "uniform float uSeed;",
            "out vec4 frag;",
            "void main() { frag = vec4(0.12 + uSeed, 0.18, 0.24, 1.0); }",
          ].join("\n");
          const INST_VS = [
            "#version 300 es",
            "in vec2 aPos;",
            "in vec2 aOrigin;",
            "uniform vec2 uSize;",
            "void main() { gl_Position = vec4(aOrigin + aPos * uSize, 0.0, 1.0); }",
          ].join("\n");
          const INST_FS = [
            "#version 300 es",
            "precision highp float;",
            "out vec4 frag;",
            "void main() { frag = vec4(0.14, 0.2, 0.26, 1.0); }",
          ].join("\n");
          const BAKED_VS = [
            "#version 300 es",
            "in vec2 aPos;",
            "void main() { gl_Position = vec4(aPos, 0.0, 1.0); }",
          ].join("\n");

          const fillProgram = link(FILL_VS, FILL_FS);
          const fillSeed = gl.getUniformLocation(fillProgram, "uSeed");
          const instProgram = link(INST_VS, INST_FS);
          const instSize = gl.getUniformLocation(instProgram, "uSize");
          const instPos = gl.getAttribLocation(instProgram, "aPos");
          const instOrigin = gl.getAttribLocation(instProgram, "aOrigin");
          const bakedProgram = link(BAKED_VS, INST_FS);
          const bakedPos = gl.getAttribLocation(bakedProgram, "aPos");

          gl.disable(gl.DEPTH_TEST);
          gl.disable(gl.BLEND);
          gl.disable(gl.CULL_FACE);
          gl.disable(gl.SCISSOR_TEST);

          const pixel = new Uint8Array(4);
          const sync = (): void => {
            gl.finish();
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          };

          const resize = (w: number, h: number): void => {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          };

          /** Up to `maxFrames` frames per run, mean of the frame times. */
          const sampleRuns = (frame: () => void): RunSample[] => {
            const runs: RunSample[] = [];
            for (let r = 0; r < req.repeat; r++) {
              let warmed = 0;
              const warmEnd = performance.now() + req.warmupMs;
              while (warmed < req.warmupFrames && (warmed < 1 || performance.now() < warmEnd)) {
                frame();
                warmed++;
              }
              const times: number[] = [];
              const end = performance.now() + req.sampleMs;
              while (times.length < req.maxFrames && (times.length < req.minFrames || performance.now() < end)) {
                const t0 = performance.now();
                frame();
                times.push(performance.now() - t0);
              }
              runs.push({ frames: times.length, warmupFrames: warmed, mean: times.reduce((a, b) => a + b, 0) / times.length });
              progress(`measured ${label} run ${r + 1}/${req.repeat} (${times.length} frames)`);
            }
            return runs;
          };

          let label = "";
          const fills: NonNullable<PageProbe["fills"]> = [];
          for (const cfg of req.fills) {
            resize(cfg.w, cfg.h);
            label = `${cfg.w}x${cfg.h} ${cfg.overdraw}x`;
            gl.useProgram(fillProgram);
            const frame = (): void => {
              for (let layer = 0; layer < cfg.overdraw; layer++) {
                gl.uniform1f(fillSeed, layer * 1e-6);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
              }
              sync();
            };
            fills.push({
              w: cfg.w,
              h: cfg.h,
              overdraw: cfg.overdraw,
              mpx: Math.round(((cfg.w * cfg.h * cfg.overdraw) / 1e6) * 100) / 100,
              runs: sampleRuns(frame),
            });
          }

          // Object cost. On this machine an instance costs about as much as a draw
          // call (see docs/deck-performance-budget.md), so both paths are swept at
          // the counts a deck frame actually uses, plus the 20k headline number.
          const oc = req.objects;
          resize(oc.w, oc.h);
          const maxObjects = Math.max(...oc.instanceCounts, ...oc.drawCallCounts, oc.bakedQuads);
          const cols = Math.ceil(Math.sqrt(maxObjects * (oc.w / oc.h)));
          const rows = Math.ceil(maxObjects / cols);
          const origins = new Float32Array(maxObjects * 2);
          for (let i = 0; i < maxObjects; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            origins[i * 2] = -1 + ((col + 0.5) * 2) / cols;
            origins[i * 2 + 1] = -1 + ((row + 0.5) * 2) / rows;
          }
          const quad = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
          const quadBuffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
          const originBuffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, originBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, origins, gl.STATIC_DRAW);

          gl.useProgram(instProgram);
          gl.uniform2f(instSize, (2 * oc.quadPx) / oc.w, (2 * oc.quadPx) / oc.h);
          gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
          gl.enableVertexAttribArray(instPos);
          gl.vertexAttribPointer(instPos, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, originBuffer);
          gl.enableVertexAttribArray(instOrigin);
          gl.vertexAttribPointer(instOrigin, 2, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(instOrigin, 1);

          const mpx = (count: number): number => Math.round(((count * oc.quadPx * oc.quadPx) / 1e6) * 100) / 100;
          const instanced: { count: number; fillMPx: number; runs: RunSample[] }[] = [];
          for (const count of oc.instanceCounts) {
            label = `instanced ${count}x${oc.quadPx}px`;
            instanced.push({
              count,
              fillMPx: mpx(count),
              runs: sampleRuns(() => {
                gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
                sync();
              }),
            });
          }

          // The same quads baked into one buffer, drawn with N separate drawArrays
          // calls — the cost model of a scene graph with N meshes.
          gl.disableVertexAttribArray(instOrigin);
          gl.vertexAttribDivisor(instOrigin, 0);
          const baked = new Float32Array(oc.bakedQuads * 12);
          const sx = (2 * oc.quadPx) / oc.w;
          const sy = (2 * oc.quadPx) / oc.h;
          for (let i = 0; i < oc.bakedQuads; i++) {
            const ox = origins[i * 2]!;
            const oy = origins[i * 2 + 1]!;
            for (let v = 0; v < 6; v++) {
              baked[i * 12 + v * 2] = ox + quad[v * 2]! * sx;
              baked[i * 12 + v * 2 + 1] = oy + quad[v * 2 + 1]! * sy;
            }
          }
          const bakedBuffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, bakedBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, baked, gl.STATIC_DRAW);
          gl.useProgram(bakedProgram);
          gl.bindBuffer(gl.ARRAY_BUFFER, bakedBuffer);
          gl.enableVertexAttribArray(bakedPos);
          gl.vertexAttribPointer(bakedPos, 2, gl.FLOAT, false, 0, 0);

          const drawCalls: { calls: number; runs: RunSample[] }[] = [];
          for (const calls of oc.drawCallCounts) {
            label = `draw calls ${calls}x${oc.quadPx}px`;
            drawCalls.push({
              calls,
              runs: sampleRuns(() => {
                for (let i = 0; i < calls; i++) gl.drawArrays(gl.TRIANGLES, i * 6, 6);
                sync();
              }),
            });
          }
          label = `batched ${oc.bakedQuads} quads`;
          const batched = {
            quads: oc.bakedQuads,
            vertices: oc.bakedQuads * 6,
            fillMPx: mpx(oc.bakedQuads),
            runs: sampleRuns(() => {
              gl.drawArrays(gl.TRIANGLES, 0, oc.bakedQuads * 6);
              sync();
            }),
          };

          return {
            webgl2: true,
            renderer,
            fills,
            objects: { res: { w: oc.w, h: oc.h }, quadPx: oc.quadPx, instanced, drawCalls, batched },
            glError: gl.getError(),
          };
        },
        {
          fills: RESOLUTIONS.flatMap((r) => r.overdraw.map((o) => ({ w: r.w, h: r.h, overdraw: o }))),
          objects: {
            w: OBJECT_RESOLUTION.w,
            h: OBJECT_RESOLUTION.h,
            quadPx: OBJECT_RESOLUTION.quadPx,
            instanceCounts: INSTANCE_COUNTS,
            drawCallCounts: DRAW_CALL_COUNTS,
            bakedQuads: BAKED_QUADS,
          },
          repeat: opts.repeat,
          sampleMs: opts.sampleMs,
          warmupMs: opts.warmupMs,
          warmupFrames: opts.warmupFrames,
          minFrames: opts.minFrames,
          maxFrames: opts.maxFrames,
        },
      ),
    );
  } finally {
    await browser.close();
  }

  const machine = {
    platform: platform(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpus: cpus().length,
    memGB: Math.round((totalmem() / 1e9) * 10) / 10,
    runtime: `bun ${Bun.version}`,
  };

  const base = {
    probe: "deck-probe",
    roadmap: "docs/desktop-3d-roadmap.md#d00",
    at: new Date().toISOString(),
    webgl2: pageProbe.webgl2,
    mode,
    headed,
    browser: { name: "chromium", version: browserVersion, executablePath: executable },
    sync: SYNC_METHOD,
    params: {
      repeat: opts.repeat,
      sampleMs: opts.sampleMs,
      warmupMs: opts.warmupMs,
      warmupFrames: opts.warmupFrames,
      minFrames: opts.minFrames,
      maxFrames: opts.maxFrames,
    },
    machine,
    elapsedMs: Date.now() - started,
  };

  if (!pageProbe.webgl2) {
    const report = { ...base, reason: pageProbe.reason ?? "no WebGL2 context" };
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`deck-probe: no WebGL2 context (${report.reason})\n`);
    return; // exit 0: "no WebGL2" is a legitimate measurement (the d09 fallback path)
  }

  const rows = (runs: RunSample[]): { ms: Stat; runs: { frames: number; warmupFrames: number; mean: number }[] } => ({
    ms: stat(runs.map((r) => r.mean)),
    runs: runs.map((r) => ({ frames: r.frames, warmupFrames: r.warmupFrames, mean: round(r.mean) })),
  });

  const fills = (pageProbe.fills ?? []).map((f) => ({
    res: { w: f.w, h: f.h },
    overdraw: f.overdraw,
    mpx: f.mpx,
    ...rows(f.runs),
  }));

  const objs = pageProbe.objects;
  const instancedRows = (objs?.instanced ?? []).map((row) => ({
    count: row.count,
    fillMPx: row.fillMPx,
    ...rows(row.runs),
  }));
  const twentyK = objs ? instancedRows.find((row) => row.count === 20_000) : undefined;
  const instanced20k =
    objs && twentyK
      ? {
          count: twentyK.count,
          quadPx: objs.quadPx,
          res: objs.res,
          fillMPx: twentyK.fillMPx,
          drawCalls: 1,
          ms: twentyK.ms,
          runs: twentyK.runs,
        }
      : null;
  const objects = objs
    ? {
        res: objs.res,
        quadPx: objs.quadPx,
        instanceSweep: instancedRows.filter((row) => row.count !== 20_000),
        drawCallSweep: objs.drawCalls.map((row) => ({ calls: row.calls, ...rows(row.runs) })),
        batched: { quads: objs.batched.quads, vertices: objs.batched.vertices, fillMPx: objs.batched.fillMPx, ...rows(objs.batched.runs) },
      }
    : null;

  const tier: QualityTier = classifyRenderer(pageProbe.renderer?.renderer ?? null);
  const report = {
    ...base,
    renderer: pageProbe.renderer,
    glError: pageProbe.glError ?? 0,
    fills,
    instanced20k,
    objects,
    tier,
    tierBudget: TIER_BUDGETS[tier],
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const pad = (s: string, n: number): string => s.padEnd(n);
  const num = (n: number): string => n.toFixed(2).padStart(8);
  const out: string[] = [];
  out.push(`deck-probe  ${report.at}  ${mode}${headed === "unavailable" ? " (headed unavailable)" : ""}`);
  out.push(`machine     ${machine.platform}/${machine.arch}  ${machine.cpus}x ${machine.cpuModel}  ${machine.memGB} GB  ${machine.runtime}`);
  out.push(`browser     chromium ${browserVersion}`);
  out.push(`vendor      ${pageProbe.renderer?.vendor}`);
  out.push(`renderer    ${pageProbe.renderer?.renderer}`);
  out.push(`limits      MAX_TEXTURE_SIZE ${pageProbe.renderer?.maxTextureSize}  MAX_SAMPLES ${pageProbe.renderer?.maxSamples}  devicePixelRatio ${pageProbe.renderer?.devicePixelRatio}`);
  out.push(`sync        ${SYNC_METHOD}   glError ${pageProbe.glError}`);
  out.push("");
  out.push("fill — trivial fragment shader, full-screen layers, mean ms per frame");
  out.push(`  ${pad("resolution", 12)}${pad("overdraw", 10)}${pad("mpx", 8)}${pad("min", 8)}${pad("median", 8)}${pad("max", 8)}frames/run`);
  for (const f of fills) {
    out.push(
      `  ${pad(`${f.res.w}x${f.res.h}`, 12)}${pad(`${f.overdraw}x`, 10)}${pad(String(f.mpx), 8)}${num(f.ms.min)}${num(f.ms.median)}${num(f.ms.max)}   ${f.runs.map((r) => r.frames).join("/")}`,
    );
  }
  if (instanced20k && objects) {
    const label = (s: string): string => s.padEnd(22);
    const mpx = (n: number): string => n.toFixed(2).padStart(8);
    out.push("");
    out.push(`objects — ${objects.quadPx}px quads at ${objects.res.w}x${objects.res.h}, mean ms per frame`);
    out.push(`  ${label("instanced")}${pad("mpx", 8)}${pad("min", 8)}${pad("median", 8)}${pad("max", 8)}frames/run`);
    for (const row of instancedRows) {
      out.push(`  ${label(`${row.count} objects`)}${mpx(row.fillMPx)}${num(row.ms.min)}${num(row.ms.median)}${num(row.ms.max)}   ${row.runs.map((r) => r.frames).join("/")}`);
    }
    out.push(`  ${label("draw calls")}${pad("", 8)}${pad("min", 8)}${pad("median", 8)}${pad("max", 8)}frames/run`);
    for (const row of objects.drawCallSweep) {
      out.push(`  ${label(`${row.calls} calls`)}${pad("", 8)}${num(row.ms.min)}${num(row.ms.median)}${num(row.ms.max)}   ${row.runs.map((r) => r.frames).join("/")}`);
    }
    const b = objects.batched;
    out.push(
      `  ${label(`1 call, ${b.vertices} verts`)}${mpx(b.fillMPx)}${num(b.ms.min)}${num(b.ms.median)}${num(b.ms.max)}   ${b.runs.map((r) => r.frames).join("/")}`,
    );
  }
  out.push("");
  out.push(`tier        ${tier}  ${JSON.stringify(report.tierBudget)}`);
  out.push(`elapsed     ${(report.elapsedMs / 1000).toFixed(1)} s`);
  out.push("next        copy these numbers into docs/deck-performance-budget.md");
  process.stdout.write(`${out.join("\n")}\n`);
}

main().catch((err) => {
  process.stderr.write(`deck-probe: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
