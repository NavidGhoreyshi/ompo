/**
 * The deck's scene model (roadmap slice `d02`), tested without a browser.
 *
 * Two things are being proven here, and they are the two hardest rules of the
 * whole roadmap:
 *
 * 1. `buildDeckModel` is a pure projection: same input → same output, no state,
 *    no clock, and nothing the DTOs do not provide.
 * 2. **The world does not reflow.** Coordinates are a function of the roadmap's
 *    structure alone, so a status, selection, worker, event or preference change
 *    can only change what a pad *looks like* — never where it is. That is what
 *    lets the operator learn where things are (CP-7).
 */

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import type { AgentRow, RunDetail, RunEvent, SliceSummary } from "../web/src/api.ts";
import { layoutDag, readyDagIds, DAG_PAD } from "../web/src/lib/dag.ts";
import { preferredSliceId } from "../web/src/lib/selection.ts";
import { buildDeckModel } from "../web/src/scene/model.ts";
import { MIRROR_LIMIT, mirrorRows } from "../web/src/scene/DeckOverlay.tsx";
import {
  cameraPose,
  GRID_CELL,
  gridPlan,
  PAD_D,
  PAD_W,
  RAIL_SCALE,
  railBounds,
  railFraming,
  railPositions,
} from "../web/src/scene/rail.ts";
import {
  CAMERA_FOV,
  DEFAULT_DECK_PREFS,
  type DeckCamera,
  type DeckInput,
  type RailBounds,
  type RailNode,
} from "../web/src/scene/types.ts";

const AT = "2026-09-12T00:00:00.000Z";

function slice(id: string, status: string, deps: string[] = [], extra: Partial<SliceSummary> = {}): SliceSummary {
  return {
    id,
    title: `Slice ${id}`,
    status,
    attempts: 1,
    updatedAt: AT,
    deps,
    generation: 1,
    verify: [],
    ...extra,
  };
}

/**
 * A roadmap with a chain, a fan-in, a failure with an unknown dependency, and a
 * blocked slice — the shapes the rail has to survive (ghost pad, blocked flag).
 */
const BASE: SliceSummary[] = [
  slice("a", "done"),
  slice("b", "done", ["a"]),
  slice("c", "running", ["b"], { attempts: 2, generation: 3 }),
  slice("d", "pending", ["b"]),
  slice("e", "pending", ["c", "d"]),
  slice("f", "failed", ["m", "b"], { reason: "worker exited 1" }),
  slice("g", "blocked-env", ["b"]),
];

function detail(slices: SliceSummary[], extra: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "run-1",
    createdAt: AT,
    updatedAt: AT,
    live: true,
    counts: { done: 2, active: 1, failed: 1, skipped: 0, blockedEnv: 1, pending: 2 },
    workers: 1,
    total: slices.length,
    status: "running",
    retries: 0,
    handoffs: 0,
    tokens: null,
    cost: null,
    slices,
    ...extra,
  };
}

const AGENTS: AgentRow[] = [
  { id: "c", lane: 1, status: "running", attempt: 1, generation: 3, lastLine: "[c] tool edit: web/src/scene/model.ts" },
];

function event(seq: number, sliceId: string, extra: Partial<RunEvent> = {}): RunEvent {
  return { seq, at: AT, type: "slice_claimed", sliceId, ...extra };
}

function input(overrides: Partial<DeckInput> = {}): DeckInput {
  return {
    runId: "run-1",
    detail: detail(BASE),
    events: [event(1, "c")],
    agents: AGENTS,
    selected: null,
    sliceDetail: null,
    pinnedId: null,
    prefs: DEFAULT_DECK_PREFS,
    live: true,
    maxStations: 8,
    ...overrides,
  };
}

const positionsOf = (nodes: RailNode[]): Map<string, string> =>
  new Map(nodes.map((n) => [n.id, `${n.x},${n.z}`]));

/**
 * The camera the deck would build for a framing: the projection is the real
 * `three` math and the pose is `rail.ts`'s own function, so a framing claim is
 * tested against the same geometry the renderer uses.
 */
function cameraFor(framing: DeckCamera, aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, 0.1, 500);
  const pose = cameraPose(framing);
  camera.position.set(pose.x, pose.y, pose.z);
  camera.lookAt(framing.target.x, framing.target.y, framing.target.z);
  camera.updateMatrixWorld();
  return camera;
}

/**
 * Corners of the rail's box: `railBounds` already includes the pads' footprints,
 * so only the pad *height* is added on top of it (the tallest pad the scene can
 * draw is a live one at 0.85).
 */
function boundsCorners(bounds: RailBounds): THREE.Vector3[] {
  const corners: THREE.Vector3[] = [];
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const z of [bounds.minZ, bounds.maxZ]) {
      for (const y of [0, 0.85]) corners.push(new THREE.Vector3(x, y, z));
    }
  }
  return corners;
}

describe("buildDeckModel: the projection", () => {
  test("one pad per slice plus a ghost per unknown dependency, one edge per dep", () => {
    const model = buildDeckModel(input());
    const layout = layoutDag(BASE);

    expect(model.nodes.length).toBe(BASE.length + 1); // the unknown dep `m`
    expect(model.edges.length).toBe(layout.edges.length);
    expect(model.edges.length).toBe(BASE.reduce((sum, s) => sum + s.deps.length, 0));
    expect([...model.edges.map((e) => e.key)].sort()).toEqual([...layout.edges.map((e) => e.key)].sort());

    const ghost = model.nodes.find((n) => n.id === "m");
    expect(ghost?.ghost).toBe(true);
    expect(ghost?.status).toBe("unknown");
    expect(model.edges.filter((e) => e.unknown).map((e) => e.from)).toEqual(["m"]);
  });

  test("every field is a DTO field or a layout output — no re-derivation", () => {
    const model = buildDeckModel(input());
    const run = detail(BASE);
    const byId = new Map(run.slices.map((s) => [s.id, s]));

    for (const node of model.nodes) {
      const source = byId.get(node.id);
      if (!source) continue;
      expect(node.title).toBe(source.title);
      expect(node.status).toBe(source.status);
      expect(node.attempts).toBe(source.attempts);
      expect(node.generation).toBe(source.generation);
      expect(node.deps).toEqual(source.deps);
      expect(node.reason).toBe(source.reason ?? null);
    }
    // Counts are the DTO's own counts object, not a recount.
    expect(model.counts).toEqual(run.counts);
    expect(model.live).toBe(true);
    expect(model.runId).toBe("run-1");
  });

  test("primaryId is preferredSliceId, and ready/blocked are dag.ts's answers", () => {
    for (const permutation of statusPermutations()) {
      const slices = [...permutation];
      const model = buildDeckModel(input({ detail: detail(slices) }));
      expect(model.primaryId).toBe(preferredSliceId(slices));

      const ready = new Set(readyDagIds(slices));
      for (const node of model.nodes) {
        expect(`${node.id}:${node.ready}`).toBe(`${node.id}:${ready.has(node.id)}`);
      }
    }
  });

  test("alert is set by failed and blocked-env only", () => {
    const model = buildDeckModel(input({ detail: detail([...BASE, slice("h", "aborted"), slice("i", "skipped")]) }));
    const alertOf = (id: string): string | null => model.nodes.find((n) => n.id === id)?.alert ?? null;
    expect(alertOf("f")).toBe("failed");
    expect(alertOf("g")).toBe("blocked-env");
    expect(alertOf("h")).toBeNull(); // aborted: nothing draws it in this slice
    expect(alertOf("i")).toBeNull();
    expect(alertOf("c")).toBeNull();
  });

  test("cycle membership is dag.ts's answer, and their edges carry it too", () => {
    const cyclic = [slice("x", "pending", ["y"]), slice("y", "pending", ["x"]), slice("z", "pending", ["x"])];
    const slices = [...cyclic];
    const layout = layoutDag(slices);
    const model = buildDeckModel(input({ detail: detail(slices) }));
    // Exactly dag.ts's membership (which includes nodes downstream of a cycle:
    // they can never reach in-degree zero either — the dashboard's rule, not a
    // second one invented for the scene).
    expect(model.nodes.filter((n) => n.inCycle).map((n) => n.id).sort()).toEqual([...layout.cycleIds].sort());
    expect(model.edges.filter((e) => e.inCycle).map((e) => e.key).sort()).toEqual(
      layout.edges.filter((e) => e.inCycle).map((e) => e.key).sort(),
    );
    expect(model.edges.find((e) => e.key === "y→x")?.inCycle).toBe(true);
  });

  test("a null detail is an empty, loading model — not a crash", () => {
    const model = buildDeckModel(input({ detail: null }));
    expect(model.loading).toBe(true);
    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.primaryId).toBeNull();
    expect(model.counts).toEqual({ done: 0, active: 0, failed: 0, skipped: 0, blockedEnv: 0, pending: 0 });
  });

  test("identical inputs produce identical models (no hidden state)", () => {
    const a = buildDeckModel(input());
    const b = buildDeckModel(input());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(b.digest).toBe(a.digest);
  });
});

describe("buildDeckModel: the world does not reflow", () => {
  test("identical coordinates across five status permutations", () => {
    const base = positionsOf(buildDeckModel(input()).nodes);
    const permutations = statusPermutations();
    expect(permutations.length).toBeGreaterThanOrEqual(5);
    for (const slices of permutations) {
      const model = buildDeckModel(input({ detail: detail(slices) }));
      expect(positionsOf(model.nodes)).toEqual(base);
      // The *appearance* may change; the placement may not.
      expect(model.nodes.map((n) => n.id)).toEqual([...base.keys()]);
    }
  });

  test("worker state, activity, log content, error text, selection and prefs move nothing", () => {
    const base = buildDeckModel(input());
    const positions = positionsOf(base.nodes);

    const variants: DeckInput[] = [
      // Workers change state, churn and go stale.
      input({ agents: [{ id: "c", lane: 2, status: "wedged", attempt: 4, generation: 9, lastLine: "stuck", wedged: true, staleForMs: 90_000 }] }),
      input({ agents: [] }),
      // Activity and log content arrive at the poll cadence.
      input({ events: [event(9, "d", { type: "worker_finished", detail: "x".repeat(400) }), event(10, "c", { type: "verify_failed", reason: "gate red" })] }),
      // A failure reason changes; the pad stays put.
      input({ detail: detail([...BASE.slice(0, 5), slice("f", "failed", ["m", "b"], { reason: "a completely different failure" }), BASE[6]!]) }),
      // Selection and view preferences.
      input({ selected: "e" }),
      input({ prefs: { tier: "high", reducedMotion: true } }),
      input({ live: false }),
    ];

    for (const variant of variants) {
      const model = buildDeckModel(variant);
      expect(positionsOf(model.nodes)).toEqual(positions);
      expect(model.bounds).toEqual(base.bounds);
      expect(model.nodes.map((n) => n.id)).toEqual(base.nodes.map((n) => n.id));
    }
  });

  test("an event or worker churn does not even change the digest", () => {
    const base = buildDeckModel(input());
    expect(buildDeckModel(input({ agents: [] })).digest).toBe(base.digest);
    expect(buildDeckModel(input({ events: Array.from({ length: 200 }, (_, i) => event(i, "c")) })).digest).toBe(base.digest);
    expect(buildDeckModel(input({ prefs: { tier: "minimal", reducedMotion: true } })).digest).toBe(base.digest);
    // Selection and status are scene-visible, so they must change it.
    expect(buildDeckModel(input({ selected: "e" })).digest).not.toBe(base.digest);
    expect(buildDeckModel(input({ detail: detail([...BASE.slice(0, 2), slice("c", "verifying", ["b"]), ...BASE.slice(3)]) })).digest).not.toBe(base.digest);
    // `d04`: a wedge is scene-visible (the station's column breaks)…
    expect(buildDeckModel(input({ agents: [{ id: "c", lane: 1, status: "running", attempt: 1, generation: 3, lastLine: "", wedged: true }] })).digest).not.toBe(base.digest);
    // …while a slot is not: it is a pool entry, so a lane re-index upstream
    // must not repaint a scene whose coordinates come from the roadmap.
    expect(buildDeckModel(input({ agents: [{ id: "c", lane: 4, status: "running", attempt: 1, generation: 3, lastLine: "" }] })).digest).toBe(base.digest);
  });

  test("appending a slice leaves every pad already on the floor where it was", () => {
    const before = positionsOf(buildDeckModel(input()).nodes);
    const grown = [
      ...BASE,
      slice("h", "pending"),
      slice("i", "pending", ["a"]),
      slice("j", "pending", ["e", "i"]),
    ];
    const after = positionsOf(buildDeckModel(input({ detail: detail(grown) })).nodes);
    for (const [id, position] of before) expect(after.get(id)).toBe(position);
  });

  test("a dependency is drawn to the left of its dependent (the rail reads as a DAG)", () => {
    const model = buildDeckModel(input());
    const x = new Map(model.nodes.map((n) => [n.id, n.x]));
    for (const edge of model.edges) {
      expect(x.get(edge.from)!).toBeLessThan(x.get(edge.to)!);
    }
    // The unknown dependency's ghost column leads every real column.
    expect(x.get("m")!).toBeLessThan(Math.min(...BASE.map((s) => x.get(s.id)!)));
  });
});

describe("buildDeckModel: focus, live workers and the station stage (d03)", () => {
  test("liveIds is the live set in board order, and nodes agree with it", () => {
    const slices = [slice("p", "pending"), slice("r1", "running"), slice("v", "verifying"), slice("t", "done"), slice("r2", "running")];
    const model = buildDeckModel(input({ detail: detail(slices) }));
    expect(model.liveIds).toEqual(["r1", "v", "r2"]);
    // One rule (`isLiveStatus`) applied in one place: the per-node flag and the
    // ordered list can never disagree.
    expect(model.nodes.filter((n) => n.live).map((n) => n.id)).toEqual(model.liveIds);
  });

  test("focusId is the pin, else the live primary, else the overall primary", () => {
    const model = buildDeckModel(input());
    expect(model.focusId).toBe("c"); // the fixture's only live slice
    expect(buildDeckModel(input({ pinnedId: "e" })).focusId).toBe("e"); // a pin on a pending slice still wins
    // The live primary is preferredSliceId's answer over live slices…
    const two = [slice("a", "done"), slice("v", "verifying"), slice("r", "running")];
    expect(buildDeckModel(input({ detail: detail(two) })).focusId).toBe(preferredSliceId(two.filter((s) => s.status !== "done" && s.status !== "pending")));
    expect(buildDeckModel(input({ detail: detail(two) })).focusId).toBe("v");
    // …and with nothing live the focus falls back to the slice that needs eyes.
    const quiescent = [slice("a", "done"), slice("b", "failed")];
    expect(buildDeckModel(input({ detail: detail(quiescent) })).focusId).toBe("b");
  });

  test("the station stage comes from lib/pipeline.ts, and only for live slices", () => {
    const model = buildDeckModel(input());
    const node = (id: string): RailNode => model.nodes.find((n) => n.id === id)!;

    // A running worker with no detail: Claim → Generation → Work are observed,
    // so the stage index is Work even before the shell's detail lands.
    expect(node("c").stage).toBe(2);
    expect(node("c").stageLabel).toBe("Work");
    // A non-live slice has no phase to draw.
    for (const id of ["a", "b", "d", "f", "g"]) {
      expect(node(id).stage).toBe(-1);
      expect(node(id).stageLabel).toBe("");
    }

    // Verifying with no detail resolves to the Verify stage: the station rises
    // when a worker hands off, which is the signal the operator reads.
    const verifying = buildDeckModel(input({ detail: detail([slice("c", "verifying", ["b"])]) }));
    expect(verifying.nodes.find((n) => n.id === "c")?.stage).toBe(4);
    expect(verifying.nodes.find((n) => n.id === "c")?.stageLabel).toBe("Verify");
  });

  test("the shell's slice detail moves the stage on, and only for its own slice", () => {
    const slices = [slice("c", "verifying", ["b"], { attempts: 1 }), slice("d", "running", ["b"])];
    const cDetail = {
      sliceId: "c",
      title: "Slice c",
      status: "verifying",
      attempts: 1,
      generation: 1,
      verify: [],
      deps: ["b"],
      metrics: { turns: 4, tools: 9, durationMs: 1000 },
      verdictPass: true,
      review: { approved: true, findings: [] },
      recentEvents: [],
      history: [],
      artifacts: { report: true, verdict: true, review: true, workerLog: true, prompt: false },
    };
    const withDetail = buildDeckModel(input({ detail: detail(slices), sliceDetail: cDetail }));
    const node = (id: string): RailNode => withDetail.nodes.find((n) => n.id === id)!;
    expect(node("c").stageLabel).toBe("Review"); // verdict passed + review approved
    expect(node("d").stageLabel).toBe("Work"); // the detail belongs to `c`, not `d`
  });

  test("focus and stage are scene-visible, but log text is not", () => {
    const base = buildDeckModel(input());
    expect(buildDeckModel(input({ pinnedId: "e" })).digest).not.toBe(base.digest);
    const proving = buildDeckModel(input({ detail: detail([slice("c", "verifying", ["b"])]) }));
    expect(proving.digest).not.toBe(base.digest); // the shaft grew a segment

    // A detail that does not change the stage — more transcript, more events —
    // must leave the renderer's early-out intact (CP-3).
    const detailOf = (workerTail: string) => ({
      sliceId: "c",
      title: "Slice c",
      status: "running",
      attempts: 1,
      generation: 1,
      verify: [],
      deps: ["b"],
      workerTail,
      recentEvents: [],
      history: [],
      artifacts: { report: false, verdict: false, review: false, workerLog: true, prompt: false },
    });
    const before = buildDeckModel(input({ sliceDetail: detailOf("one line") }));
    const after = buildDeckModel(input({ sliceDetail: detailOf("a different line\nand another\n".repeat(50)) }));
    expect(after.digest).toBe(before.digest);
  });
});

describe("buildDeckModel: stations (d04)", () => {
  /** Four live workers, plus a done slice, with lanes as the server numbers them. */
  const live = (): { slices: SliceSummary[]; agents: AgentRow[] } => ({
    slices: [
      slice("a", "done"),
      slice("r1", "running"),
      slice("v", "verifying"),
      slice("t", "done"),
      slice("r2", "running"),
      slice("r3", "running"),
    ],
    agents: [
      { id: "r1", lane: 0, status: "running", attempt: 1, generation: 1, lastLine: "edit" },
      { id: "v", lane: 1, status: "verifying", attempt: 1, generation: 2, lastLine: "gates" },
      { id: "r2", lane: 2, status: "running", attempt: 1, generation: 0, lastLine: "" },
      { id: "r3", lane: 3, status: "running", attempt: 1, generation: 0, lastLine: "" },
    ],
  });

  test("every live worker is one station, in lane order, with its own facts", () => {
    const { slices, agents } = live();
    const model = buildDeckModel(input({ detail: detail(slices), agents }));
    expect(model.stations.map((station) => station.id)).toEqual(["r1", "v", "r2", "r3"]);
    expect(model.stations.map((station) => station.id)).toEqual(model.liveIds);
    expect(model.stations.map((station) => station.lane)).toEqual([0, 1, 2, 3]);
    expect(model.stations.map((station) => station.stack)).toEqual([0, 0, 0, 0]);
    expect(model.stations.filter((station) => station.primary).map((station) => station.id)).toEqual(["r1"]);
    expect(model.stations.filter((station) => station.focused).map((station) => station.id)).toEqual(["r1"]);
    // The stage is the same number the node carries: one derivation, two views.
    const node = (id: string): RailNode => model.nodes.find((n) => n.id === id)!;
    for (const station of model.stations) expect(station.stage).toBe(node(station.id).stage);
    expect(model.stationOverflow).toBe(0);
    expect(model.warnings).toEqual([]);
  });

  test("focusing another worker moves the flag, not the station", () => {
    const { slices, agents } = live();
    const before = buildDeckModel(input({ detail: detail(slices), agents }));
    const after = buildDeckModel(input({ detail: detail(slices), agents, pinnedId: "r3" }));
    expect(after.focusId).toBe("r3");
    expect(after.stations.find((station) => station.id === "r3")?.focused).toBe(true);
    expect(positionsOf(after.nodes)).toEqual(positionsOf(before.nodes));
    expect(after.stations.map((station) => [station.id, station.slot, station.stage])).toEqual(
      before.stations.map((station) => [station.id, station.slot, station.stage]),
    );
    // Focus is scene-visible (the station brightens), so the digest moves — and
    // it is the only thing that moved.
    expect(after.digest).not.toBe(before.digest);
  });

  test("a wedged worker is flagged on its station, and only on it", () => {
    const { slices, agents } = live();
    const wedged: AgentRow[] = agents.map((row) => (row.id === "v" ? { ...row, wedged: true, staleForMs: 700_000 } : row));
    const model = buildDeckModel(input({ detail: detail(slices), agents: wedged }));
    expect(model.stations.filter((station) => station.wedged).map((station) => station.id)).toEqual(["v"]);
    expect(model.nodes.find((node) => node.id === "v")?.wedged).toBe(true);
  });

  test("over the tier's cap the pool holds what it can and counts the rest", () => {
    const { slices, agents } = live();
    const model = buildDeckModel(input({ detail: detail(slices), agents, maxStations: 2 }));
    expect(model.stations.map((station) => station.id)).toEqual(["r1", "v", "r2", "r3"]);
    expect(model.stations.filter((station) => station.stack === 0).map((station) => station.id)).toEqual(["r1", "v"]);
    expect(model.stations.filter((station) => station.stack > 0).map((station) => station.id)).toEqual(["r2", "r3"]);
    expect(model.stationOverflow).toBe(2);
    // The lane list is still complete: the pool's cap hides a station, not a worker.
    expect(model.liveIds).toHaveLength(4);
  });

  test("a malformed lane is repaired in the model, and the repair is visible", () => {
    const { slices, agents } = live();
    const duplicated: AgentRow[] = agents.map((row) => ({ ...row, lane: 0 }));
    const model = buildDeckModel(input({ detail: detail(slices), agents: duplicated, maxStations: 2 }));
    expect(model.stations.map((station) => station.slot)).toEqual([0, 1, 1, 1]);
    // One repair (the second worker at lane 0), then the pool is full and the
    // rest are counted rather than repaired.
    expect(model.warnings).toEqual(["v: slot 0 already taken — placed at slot 1"]);
    expect(model.stationOverflow).toBe(2);
  });
});

describe("rail geometry", () => {
  test("positions follow the layout pitch and the origin anchor", () => {
    const layout = layoutDag(BASE);
    const positions = railPositions(layout);
    expect(positions.size).toBe(layout.nodes.length);
    const a = positions.get("a")!;
    const b = positions.get("b")!;
    const nodeA = layout.nodes.find((n) => n.id === "a")!;
    const nodeB = layout.nodes.find((n) => n.id === "b")!;
    // A deeper dependency column is one SVG pitch to the right, scaled once.
    expect(b.x - a.x).toBeGreaterThan(0);
    expect(b.x - a.x).toBeCloseTo((nodeB.x - nodeA.x) * RAIL_SCALE, 6);
    // World z is the SVG row, anchored at the layout's own top-left padding.
    expect(a.z).toBeCloseTo((nodeA.y - DAG_PAD) * RAIL_SCALE, 6);
    expect(a.y).toBe(0);
  });

  test("bounds cover every pad and framing centres on them", () => {
    const layout = layoutDag(BASE);
    const positions = railPositions(layout);
    const bounds = railBounds(positions.values());
    for (const p of positions.values()) {
      expect(p.x - PAD_W / 2).toBeGreaterThanOrEqual(bounds.minX - 1e-9);
      expect(p.x + PAD_W / 2).toBeLessThanOrEqual(bounds.maxX + 1e-9);
    }
    const framing = railFraming(bounds, 16 / 9);
    expect(framing.target.x).toBe(bounds.centerX);
    expect(framing.target.z).toBe(bounds.centerZ);
    expect(framing.distance).toBeGreaterThan(0);
    // A bigger world needs a longer lens-to-target distance.
    const wide = railFraming({ ...bounds, width: bounds.width * 4, depth: bounds.depth * 4 }, 16 / 9);
    expect(wide.distance).toBeGreaterThan(framing.distance);
    // An empty rail still frames something finite.
    expect(Number.isFinite(railFraming(railBounds([]), 1).distance)).toBe(true);
  });

  test("the rail framing fits every pad inside the viewport, at any window shape", () => {
    // Long and thin, like a mostly sequential run, and square, like a wide fan.
    const shapes: RailBounds[] = [
      railBounds(railPositions(layoutDag(BASE)).values()),
      { minX: 0, maxX: 110, minZ: 0, maxZ: 14, width: 110, depth: 14, centerX: 55, centerZ: 7 },
      { minX: 0, maxX: 30, minZ: 0, maxZ: 60, width: 30, depth: 60, centerX: 15, centerZ: 30 },
    ];
    for (const bounds of shapes) {
      for (const aspect of [16 / 9, 1, 390 / 844]) {
        const camera = cameraFor(railFraming(bounds, aspect), aspect);
        for (const corner of boundsCorners(bounds)) {
          const ndc = corner.project(camera);
          expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("the floor grid covers the rail with a bounded line count", () => {
    const small = gridPlan({ minX: 0, maxX: 20, minZ: 0, maxZ: 8, width: 20, depth: 8, centerX: 10, centerZ: 4 });
    expect(small.size).toBeGreaterThanOrEqual(20);
    expect(small.size / small.divisions).toBe(GRID_CELL);

    const huge = gridPlan({ minX: 0, maxX: 6000, minZ: 0, maxZ: 3000, width: 6000, depth: 3000, centerX: 3000, centerZ: 1500 });
    expect(huge.size).toBeGreaterThanOrEqual(6000);
    expect(huge.divisions).toBeLessThanOrEqual(65); // a cap, so a giant rail stays cheap

    const empty = gridPlan(railBounds([]));
    expect(empty.divisions).toBeGreaterThanOrEqual(4);
    expect(Number.isFinite(empty.size)).toBe(true);
  });

  test("the DOM mirror lists every pad, and states the ones it does not", () => {
    const nodes = Array.from({ length: MIRROR_LIMIT + 5 }, (_, i) => ({ id: `s${i}` }) as RailNode);
    const big = mirrorRows(nodes);
    expect(big.listed).toHaveLength(MIRROR_LIMIT);
    expect(big.hidden).toBe(5); // never silent: the count is rendered
    expect(big.listed[0]).toBe(nodes[0]);
    expect(big.listed[MIRROR_LIMIT - 1]).toBe(nodes[MIRROR_LIMIT - 1]);
    const small = mirrorRows(nodes.slice(0, 9));
    expect(small.listed).toHaveLength(9);
    expect(small.hidden).toBe(0);
  });
});

/**
 * The same roadmap, five different status assignments — the same slices, deps
 * and order, so the layout is the only thing that is allowed to be identical.
 */
function statusPermutations(): SliceSummary[][] {
  const statuses = ["pending", "done", "running", "failed", "blocked-env", "skipped", "aborted"];
  return [
    BASE.map((s) => ({ ...s, status: "pending" })),
    BASE.map((s) => ({ ...s, status: "done" })),
    BASE.map((s, i) => ({ ...s, status: statuses[i % statuses.length]! })),
    BASE.map((s, i) => ({ ...s, status: statuses[(i * 3) % statuses.length]! })),
    BASE.map((s, i) => ({ ...s, status: statuses[(i * 5 + 2) % statuses.length]! })),
  ];
}
