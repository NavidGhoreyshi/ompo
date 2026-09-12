/**
 * The deck's frame scheduler (roadmap slice `d01`).
 *
 * Rendering is on demand, so these are the guarantees the budget rests on:
 * an idle deck renders nothing, the fps cap is a timestamp gate rather than a
 * dropped frame, a hidden document stops scheduling, and the loop always stops
 * itself when there is nothing left to draw. The clock and the frame scheduler
 * are injected, so the assertions are exact rather than statistical.
 */

import { describe, expect, test } from "bun:test";
import { createFrameLoop, type FrameLoop } from "../web/src/scene/loop.ts";

interface Harness {
  loop: FrameLoop;
  frames: number;
  pending: number;
  flush(ms: number): void;
  setHidden(hidden: boolean): void;
  fireVisibility(): void;
  setMaxFps(fps: number): void;
}

function harness(options: { maxFps?: number; isDirty?: () => boolean; onFrame?: () => void; hidden?: boolean } = {}): Harness {
  let time = 0;
  let hidden = options.hidden ?? false;
  let nextHandle = 1;
  let frames = 0;
  let visibility: (() => void) | null = null;
  const queue = new Map<number, (at: number) => void>();

  const loop = createFrameLoop({
    maxFps: options.maxFps ?? 30,
    isDirty: options.isDirty,
    onFrame: () => {
      frames++;
      options.onFrame?.();
    },
    raf: (cb) => {
      const handle = nextHandle++;
      queue.set(handle, cb);
      return handle;
    },
    cancelRaf: (handle) => {
      queue.delete(handle);
    },
    now: () => time,
    isHidden: () => hidden,
    onVisibility: (cb) => {
      visibility = cb;
      return () => {
        if (visibility === cb) visibility = null;
      };
    },
  });

  return {
    loop,
    get frames() {
      return frames;
    },
    get pending() {
      return queue.size;
    },
    flush(ms) {
      time += ms;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(time);
    },
    setHidden(value) {
      hidden = value;
    },
    fireVisibility() {
      visibility?.();
    },
    setMaxFps(fps) {
      loop.setMaxFps(fps);
    },
  };
}

describe("frame loop", () => {
  test("a requested frame renders once and the loop then stops itself", () => {
    const h = harness();
    h.loop.request();
    expect(h.pending).toBe(1);
    h.flush(16);
    expect(h.frames).toBe(1);
    // Idle: nothing was asked for, so nothing is scheduled.
    expect(h.pending).toBe(0);
    h.flush(1000);
    expect(h.frames).toBe(1);
    expect(h.loop.stats().idleStops).toBe(0);
  });

  test("a tick that finds nothing dirty stops scheduling instead of spinning", () => {
    // The animation ends between two ticks: the frame it asked for is drawn,
    // the tick it had already scheduled finds nothing and the loop goes idle.
    let dirty = true;
    const h = harness({ maxFps: 1000, isDirty: () => dirty });
    h.loop.request();
    h.flush(2);
    expect(h.frames).toBe(1);
    dirty = false;
    h.flush(2);
    expect(h.frames).toBe(1);
    expect(h.loop.stats().idleStops).toBe(1);
    expect(h.pending).toBe(0);
    h.flush(1000);
    expect(h.frames).toBe(1);
  });

  test("maxFps is a timestamp gate: 30 fps over one second renders ~30 frames", () => {
    let ticks = 0;
    const h = harness({
      maxFps: 30,
      // A continuous animation keeps asking for frames, so only the gate limits them.
      isDirty: () => true,
      onFrame: () => {
        ticks++;
      },
    });
    h.loop.request();
    for (let i = 0; i < 60; i++) h.flush(1000 / 60);
    expect(h.frames).toBeGreaterThanOrEqual(28);
    expect(h.frames).toBeLessThanOrEqual(31);
    expect(ticks).toBe(h.frames);
    expect(h.loop.stats().deferred).toBeGreaterThanOrEqual(28);
  });

  test("setMaxFps tightens the gate immediately", () => {
    const h = harness({ maxFps: 60, isDirty: () => true });
    h.loop.request();
    for (let i = 0; i < 60; i++) h.flush(1000 / 60);
    const atSixty = h.frames;
    expect(atSixty).toBeGreaterThanOrEqual(55);

    h.setMaxFps(6);
    const before = h.frames;
    for (let i = 0; i < 60; i++) h.flush(1000 / 60);
    const atSix = h.frames - before;
    expect(atSix).toBeLessThanOrEqual(7);
    expect(h.loop.stats().maxFps).toBe(6);
  });

  test("a hidden document stops scheduling and resumes on visibility", () => {
    const h = harness();
    h.setHidden(true);
    h.loop.request();
    expect(h.pending).toBe(0);
    h.flush(500);
    expect(h.frames).toBe(0);

    h.setHidden(false);
    h.fireVisibility();
    expect(h.pending).toBe(1);
    h.flush(16);
    expect(h.frames).toBe(1);
    expect(h.pending).toBe(0); // idle again: the resume did not start a loop
  });

  test("a frame that dirties itself schedules exactly one more frame", () => {
    let requests = 1;
    const h = harness({
      maxFps: 1000,
      onFrame: () => {
        if (requests > 0) {
          requests--;
          h.loop.request();
        }
      },
    });
    h.loop.request();
    h.flush(2);
    expect(h.frames).toBe(1);
    expect(h.pending).toBe(1);
    h.flush(2);
    expect(h.frames).toBe(2);
    expect(h.pending).toBe(0);
    h.flush(100);
    expect(h.frames).toBe(2);
  });

  test("stop() cancels the pending frame and ignores later requests", () => {
    const h = harness();
    h.loop.request();
    h.loop.stop();
    expect(h.pending).toBe(0);
    h.flush(16);
    expect(h.frames).toBe(0);
    h.loop.request();
    expect(h.pending).toBe(0);
    h.setHidden(false);
    h.fireVisibility();
    expect(h.pending).toBe(0);
  });
});
