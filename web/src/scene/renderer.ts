/**
 * The deck's WebGL2 renderer (roadmap slice `d01`) — the **only** module in
 * the repository that imports `three` (asserted by `tests/release-gate.test.ts`).
 *
 * It owns a scene graph and nothing else: no DTOs, no fetching, no derivation.
 * `d01` draws an empty world — a finitely sized floor grid, no full-screen
 * fill, no shadows, no lighting, no post-processing — because the `d00` probe
 * measured what pixels cost on this machine (~9 ns each) and the floor grid is
 * the cheapest thing that proves the canvas is alive.
 *
 * `info()` returns one object that is mutated in place: the per-frame path must
 * not allocate, and callers that keep it must copy it.
 */

import * as THREE from "three";
import { TIER_BUDGETS, type QualityTier } from "./tier.ts";
import type { DeckCamera, DeckModel, RenderStats } from "./types.ts";

export interface DeckRenderer {
  applyModel(model: DeckModel): void;
  setCamera(state: DeckCamera): void;
  setSize(cssWidth: number, cssHeight: number): void;
  /**
   * Re-read a tier's budget (resolution scale, caps) and re-apply the size.
   * `antialias` is fixed at context creation, so the caller re-creates the
   * renderer only when that bit changes — not on every tier change.
   */
  setTier(tier: QualityTier): void;
  render(): RenderStats;
  info(): RenderStats;
  /** True while an animation (the intro fade) still wants frames. */
  animating(): boolean;
  /** Revision of the last model handed to `applyModel` (-1 before the first). */
  appliedRevision(): number;
  dispose(): void;
  disposed(): boolean;
}

export interface DeckRendererOptions {
  reducedMotion?: boolean;
  /** Clock injection: the fade and fps sampling are deterministic in tests. */
  now?: () => number;
}

/**
 * `UNMASKED_RENDERER_WEBGL` from a throwaway context, or `null` when this
 * device has no WebGL2 at all (the caller shows the flat notice instead of a
 * canvas — `d09` builds the full fallback).
 */
export function probeRendererString(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return null;
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const value = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof value === "string" && value.length > 0 ? value : "";
  } catch {
    return null;
  }
}

const FADE_MS = 200;

export function createDeckRenderer(canvas: HTMLCanvasElement, tier: QualityTier, options: DeckRendererOptions = {}): DeckRenderer {
  const now = options.now ?? (() => performance.now());
  let budget = TIER_BUDGETS[tier];

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: budget.antialias,
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
  });
  // The `d00` budget is denominated in backing-store pixels, so the ratio is
  // fixed at 1 and the tier's scale is applied in `setSize` instead.
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x0a0e14, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  const cameraTarget = new THREE.Vector3();

  // One finitely sized grid: lines are 1 px wide, cover a bounded area, and
  // never shade the whole viewport (no full-screen layer anywhere in `d01`).
  const gridSize = 40;
  const gridDivisions = 8;
  const grid = new THREE.GridHelper(gridSize, gridDivisions, 0x3b536b, 0x22303d);
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0;
  scene.add(grid);

  const gridVertices = grid.geometry.getAttribute("position").count;
  const lineSegments = Math.round(gridVertices / 2);

  const fadeMs = options.reducedMotion ? 0 : FADE_MS;
  const fadeStart = now();

  const stats: RenderStats = {
    drawCalls: 0,
    triangles: 0,
    lines: 0,
    objects: scene.children.length,
    programs: 0,
    textures: 0,
    geometries: 0,
    vertices: gridVertices,
    pixels: 0,
    fullScreenLayers: 0,
    linePixels: 0,
    shadedPixels: 0,
    fps: 0,
  };

  let width = 0;
  let height = 0;
  let cssWidth = 0;
  let cssHeight = 0;
  let disposed = false;
  let modelRevision = -1;

  // Frame intervals, for the fps reading only. Fixed ring, no allocation.
  const intervals = new Float64Array(32);
  let intervalWrite = 0;
  let intervalCount = 0;
  let lastRenderAt = Number.NaN;

  const fadeProgress = (): number => {
    if (fadeMs <= 0) return 1;
    return Math.min(1, Math.max(0, (now() - fadeStart) / fadeMs));
  };

  const medianInterval = (): number => {
    if (intervalCount === 0) return 0;
    const values: number[] = [];
    for (let i = 0; i < intervalCount; i++) values.push(intervals[(intervalWrite - intervalCount + i + intervals.length) % intervals.length]!);
    values.sort((a, b) => a - b);
    return values[values.length >> 1]!;
  };

  const cameraFromState = (state: DeckCamera): void => {
    const cosElevation = Math.cos(state.elevation);
    cameraTarget.set(state.target.x, state.target.y, state.target.z);
    camera.position.set(
      state.target.x + state.distance * cosElevation * Math.sin(state.azimuth),
      state.target.y + state.distance * Math.sin(state.elevation),
      state.target.z + state.distance * cosElevation * Math.cos(state.azimuth),
    );
    camera.lookAt(cameraTarget);
  };

  return {
    applyModel(model: DeckModel): void {
      // `d01`'s world is fixed, so this records the revision it was handed;
      // `d02` diff-applies the rail through the same seam, and the debug hook
      // exposes the revision so the switch-away test can prove it happened.
      modelRevision = model.revision;
    },
    setCamera(state: DeckCamera): void {
      cameraFromState(state);
    },
    setSize(nextCssWidth: number, nextCssHeight: number): void {
      if (nextCssWidth <= 0 || nextCssHeight <= 0) return;
      cssWidth = nextCssWidth;
      cssHeight = nextCssHeight;
      const scale = budget.resolutionScale;
      width = Math.max(1, Math.round(cssWidth * scale));
      height = Math.max(1, Math.round(cssHeight * scale));
      renderer.setSize(width, height, false);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      camera.aspect = cssWidth / cssHeight;
      camera.updateProjectionMatrix();
      stats.pixels = width * height;
      // Upper bound: no 1 px line can cover more than the screen diagonal.
      stats.linePixels = Math.round(lineSegments * Math.hypot(width, height));
      stats.shadedPixels = stats.pixels * stats.fullScreenLayers + stats.linePixels;
    },
    setTier(next: QualityTier): void {
      budget = TIER_BUDGETS[next];
      if (cssWidth > 0 && cssHeight > 0) {
        const scale = budget.resolutionScale;
        width = Math.max(1, Math.round(cssWidth * scale));
        height = Math.max(1, Math.round(cssHeight * scale));
        renderer.setSize(width, height, false);
        camera.aspect = cssWidth / cssHeight;
        camera.updateProjectionMatrix();
        stats.pixels = width * height;
        stats.linePixels = Math.round(lineSegments * Math.hypot(width, height));
        stats.shadedPixels = stats.pixels * stats.fullScreenLayers + stats.linePixels;
      }
    },
    render(): RenderStats {
      const at = now();
      if (Number.isFinite(lastRenderAt)) {
        intervals[intervalWrite % intervals.length] = at - lastRenderAt;
        intervalWrite++;
        if (intervalCount < intervals.length) intervalCount++;
      }
      lastRenderAt = at;

      const progress = fadeProgress();
      if (gridMaterial.opacity !== progress) gridMaterial.opacity = progress;

      renderer.render(scene, camera);

      const info = renderer.info;
      stats.drawCalls = info.render.calls;
      stats.triangles = info.render.triangles;
      stats.lines = info.render.lines;
      stats.objects = scene.children.length;
      stats.programs = info.programs?.length ?? 0;
      stats.textures = info.memory.textures;
      stats.geometries = info.memory.geometries;
      return stats;
    },
    info(): RenderStats {
      const interval = medianInterval();
      stats.fps = interval > 0 ? Math.round((1000 / interval) * 10) / 10 : 0;
      return stats;
    },
    animating(): boolean {
      return !disposed && fadeProgress() < 1;
    },
    appliedRevision(): number {
      return modelRevision;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(grid);
      grid.geometry.dispose();
      gridMaterial.dispose();
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        // A lost context is already released; nothing to do.
      }
    },
    disposed(): boolean {
      return disposed;
    },
  };
}
