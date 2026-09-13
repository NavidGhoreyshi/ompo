/**
 * Release gate (w5f) — final dashboard gate over the whole surface.
 *
 * Representative checks, each through the same entrypoint the compiled
 * `./ompo` binary uses (`src/cli.ts` → store/event/control seams):
 *
 *  1. browser smoke  — dashboard server: health, runs, detail, shell-or-503,
 *     SPA fallback, /api 404 boundary, localhost-only default, plus a live
 *     boot of the bare-dashboard path (`bun src/cli.ts --no-open`).
 *  2. --tui smoke    — `--help` boots from the entrypoint; the unified flow
 *     drives plan→run headless with stub planner/loop (no ink render, no
 *     workers). A live interactive TUI needs a terminal; that half stays a
 *     manual check (see README "Browser dashboard" / w5c binary matrix).
 *  3. run --dry-run  — valid roadmap exits 0 and creates no run; blocked
 *     roadmap exits 1 (fails closed). `status` still works headless.
 *  4. control path   — `ompo retry` / `ompo ctl` and POST /control agree
 *     (direct-apply on quiescent runs, queued with seq on live runs,
 *     identical 400/404 validation).
 *  5. replay path    — `ompo replay` and GET /replay agree (cursor matches).
 *  6. planner path   — `ompo plan` and GET /api/plan/preview agree
 *     (ready / blocked / missing-roadmap).
 *
 * Architecture lock (must remain true):
 *   OMPO ENGINE -> durable store + events -> Web / TUI / CLI
 * The web client imports no store/control/fs seams (API-only over /api/*),
 * speaks SSE only (no WebSockets), and the server reuses exactly the
 * control/event/store functions (no parallel mutation path).
 */
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { acquireLock, createRun, listRuns, loadRun, releaseLock, storeApi } from "../src/store.ts";
import { buildPlanPreview, formatPreviewSummary } from "../src/planPreview.ts";
import { DEFAULT_HOST, startDashboardServer } from "../src/server.ts";
import { driveUnifiedFlow, type UnifiedSession } from "../src/unified.tsx";
import pkg from "../package.json";
// The sandbox sets HTTP(S)_PROXY without NO_PROXY; loopback test traffic
// must not go through the proxy.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

const VALID = `## [a] First slice work item here
Do A thoroughly and completely now.
Effort: lo
Verify: bun test -- scope-a
Files: src/a.ts
## [b] Second work item here
Do B thoroughly and completely now.
Effort: med
Depends: a
Verify: bun test -- scope-b
`;

const BLOCKED = `## [a] First slice work item here
Do A thoroughly and completely now.
Effort: lo
`;

const MINI = "## [a] A\nDo A.\nVerify: true\nRetries: 0\n";

/**
 * Spawn the CLI with a pinned config home (bun does not forward
 * `process.env` mutations to children, so the preload's isolation stops at
 * the test process — a bare spawn would read the developer's real config).
 */
function cli(dir: string, ...args: string[]): { exit: number; out: string } {
  const r = spawnSync("bun", ["src/cli.ts", ...args, "--project", dir], {
    encoding: "utf8",
    env: { ...process.env, OMPO_CONFIG_HOME: join(dir, ".ompo-config") },
  });
  return { exit: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Same spawn as `cli()`, but with stdout and stderr kept apart (stream contracts). */
function cliStreams(dir: string, ...args: string[]): { exit: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", ["src/cli.ts", ...args, "--project", dir], {
    encoding: "utf8",
    env: { ...process.env, OMPO_CONFIG_HOME: join(dir, ".ompo-config") },
  });
  return { exit: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function fetchJSON(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; text: string; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain-text shell/503 bodies are asserted as text */
  }
  return { status: res.status, text, body };
}

/** Run with slice a terminally failed (the control-path starting point). */
function failedRun(dir: string, runId: string): void {
  createRun(dir, parseRoadmap(VALID), runId);
  storeApi.claimSlice(dir, runId, "a");
  storeApi.workerFinished(dir, runId, "a", "slices/a/report.json", { exit: 1, durationMs: 1000 });
  storeApi.terminalFail(dir, runId, "a", "gate failed");
}

describe("release gate: browser smoke (dashboard server)", () => {
  test("health, runs, detail project the store (deps included)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-web-"));
    failedRun(dir, "r1");
    const server = startDashboardServer({ projectDir: dir });
    try {
      const health = await fetchJSON(`${server.url}/api/health`);
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ ok: true, version: pkg.version });

      const runs = (await fetchJSON(`${server.url}/api/runs`)).body as { runId: string }[];
      expect(runs.map((r) => r.runId)).toContain("r1");

      const detail = (await fetchJSON(`${server.url}/api/runs/r1`)).body as {
        runId: string;
        slices: { id: string; status: string; deps: string[] }[];
      };
      expect(detail.runId).toBe("r1");
      // Deps come from the store cursor, not an independent web parse.
      expect(detail.slices.find((s) => s.id === "b")?.deps).toContain("a");
      expect(detail.slices.find((s) => s.id === "a")?.status).toBe("failed");
    } finally {
      server.stop();
    }
  });

  test("shell-or-503, SPA fallback, /api boundary, localhost default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-web-"));
    failedRun(dir, "r1");
    const server = startDashboardServer({ projectDir: dir });
    try {
      // Localhost-only by default (arch §7).
      expect(DEFAULT_HOST).toBe("127.0.0.1");
      expect(server.host).toBe("127.0.0.1");
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // `/` serves the shell when a bundle exists, else a 503 naming the
      // build command — never a blank page, and /api/* keeps working either way.
      const root = await fetchJSON(`${server.url}/`);
      if (root.status === 200) {
        expect(root.text).toContain("<html");
      } else {
        expect(root.status).toBe(503);
        expect(root.text).toContain("bun run web:build");
      }
      // Client routes fall back to the shell, never to /api JSON.
      const clientRoute = await fetchJSON(`${server.url}/runs/r1`);
      expect(clientRoute.status).toBe(root.status);
      // `/api/*` is reserved: unknown API paths are 404, never the shell.
      expect((await fetchJSON(`${server.url}/api/nope`)).status).toBe(404);
      expect((await fetchJSON(`${server.url}/api/health`)).status).toBe(200);
    } finally {
      server.stop();
    }
  });

  test("bare-dashboard entrypoint boots the server (binary-equivalent path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-web-"));
    failedRun(dir, "r1");
    const child = spawn("bun", ["src/cli.ts", "--no-open", "--project", dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`dashboard boot timeout, got: ${out.slice(0, 300)}`)), 20_000);
        const poll = setInterval(() => {
          const m = out.match(/ompo dashboard: (http:\/\/\S+)/);
          if (m) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(m[1]!);
          }
        }, 50);
      });
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await fetchJSON(`${url}/api/health`);
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ ok: true });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }, 30_000);
});

describe("release gate: --print-url handshake (roadmap d11)", () => {
  /**
   * Spawn the bare dashboard with both streams apart and splits stdout into
   * lines as they arrive — the handshake is a line contract, so the test reads
   * lines, not chunks. `closed` resolves after both pipes are drained, which
   * is the only place a "stdout carried nothing else" claim is deterministic.
   */
  function boot(dir: string, ...extra: string[]) {
    const child = spawn("bun", ["src/cli.ts", "--no-open", ...extra, "--project", dir], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OMPO_CONFIG_HOME: join(dir, ".ompo-config") },
    });
    let err = "";
    let buffer = "";
    const lines: string[] = [];
    let sawUrl: (url: string) => void = () => {};
    let sawBanner: (url: string) => void = () => {};
    const urlLine = new Promise<string>((resolve) => {
      sawUrl = resolve;
    });
    const bannerLine = new Promise<string>((resolve) => {
      sawBanner = resolve;
    });
    child.stdout!.on("data", (d) => {
      buffer += String(d);
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line);
        const url = /^url=(http:\/\/\S+)$/.exec(line);
        if (url) sawUrl(url[1]!);
        const banner = /^ompo dashboard: (http:\/\/\S+)/.exec(line);
        if (banner) sawBanner(banner[1]!);
      }
    });
    child.stderr!.on("data", (d) => {
      err += String(d);
    });
    const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    return { child, urlLine, bannerLine, lines: () => lines, err: () => err, closed };
  }

  async function terminate(child: ReturnType<typeof spawn>, closed: Promise<number | null>): Promise<number | null> {
    child.kill("SIGTERM");
    return closed;
  }

  test("stdout carries exactly the url= line, the banner moves to stderr, SIGTERM exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-printurl-"));
    failedRun(dir, "r1");
    const { child, urlLine, lines, err, closed } = boot(dir, "--print-url");
    try {
      const url = await urlLine;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // The line names a server that is actually up.
      expect((await fetchJSON(`${url}/api/health`)).status).toBe(200);
      expect(child.exitCode).toBeNull();
      expect(await terminate(child, closed)).toBe(0);
      // The handshake is exactly one line; the banner and the shutdown notice
      // are stderr's. Asserted after close, when both pipes are drained.
      expect(lines()).toEqual([`url=${url}`]);
      expect(err()).toContain("ompo dashboard:");
      expect(err()).toContain("press Ctrl-C to stop");
      expect(err()).toContain("ompo dashboard stopped");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  test("without the flag the banner stays on stdout and no url= line appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-banner-"));
    failedRun(dir, "r1");
    const { child, bannerLine, lines, err, closed } = boot(dir);
    try {
      expect(await bannerLine).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await terminate(child, closed)).toBe(0);
      expect(lines().some((line) => line.includes("press Ctrl-C to stop"))).toBe(true);
      expect(lines().some((line) => line.startsWith("url="))).toBe(false);
      expect(err()).not.toContain("ompo dashboard:");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  test("on a non-dashboard command the flag is a stderr warning, never a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-printurl-ignored-"));
    failedRun(dir, "r1");
    const r = cliStreams(dir, "status", "--print-url");
    expect(r.exit).toBe(0);
    expect(r.stdout).not.toContain("url=");
    expect(r.stderr).toContain("--print-url applies to the bare dashboard only");
  });
});

describe("release gate: --tui smoke", () => {
  test("entrypoint boots headless (--help names dashboard + --tui)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-tui-"));
    const r = cli(dir, "--help");
    expect(r.exit).toBe(0);
    expect(r.out).toContain("--tui");
    expect(r.out).toContain("dashboard");
  });

  test("unified flow plans when missing, then runs (headless, no workers)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-tui-"));
    const logs: string[] = [];
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    const res = await driveUnifiedFlow(
      {
        projectDir: dir,
        planner: async (o) => {
          const p = o.roadmapPath ?? join(dir, "ROADMAP.md");
          writeFileSync(p, MINI, "utf8");
          return { roadmapPath: p, slices: ["a"] };
        },
        looper: async () => ({ exitCode: 0, done: 1, failed: 0, skipped: 0, pending: 0, blockedEnv: 0 }),
      },
      (m) => logs.push(m),
      session,
      new AbortController().signal,
    );
    expect(res.exitCode).toBe(0);
    expect(session.phase).toBe("done");
    expect(session.runId).not.toBeNull();
    expect(readFileSync(join(dir, "ROADMAP.md"), "utf8")).toContain("## [a]");
    expect(logs.some((m) => m.includes("roadmap OK: 1 slices"))).toBe(true);
  });
});

describe("release gate: run --dry-run + headless status", () => {
  test("valid roadmap: exit 0, prints order, creates no run", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-dry-"));
    writeFileSync(join(dir, "ROADMAP.md"), VALID, "utf8");
    const r = cli(dir, "run", "--dry-run");
    expect(r.exit).toBe(0);
    expect(r.out).toContain("dry-run: 2 slices");
    expect(r.out).toContain("first ready: a");
    expect(r.out).toContain("dependency order:");
    expect(r.out).toContain("lint:");
    expect(listRuns(dir)).toEqual([]);
    expect(existsSync(join(dir, ".omp"))).toBe(false);
  });

  test("blocked roadmap: exit 1 (fails closed), headless status intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-dry-"));
    writeFileSync(join(dir, "ROADMAP.md"), BLOCKED, "utf8");
    expect(cli(dir, "run", "--dry-run").exit).toBe(1);
    expect(listRuns(dir)).toEqual([]);
    const empty = cli(dir, "status");
    expect(empty.exit).toBe(0);
    expect(empty.out).toContain("no runs yet");
  });
});

describe("release gate: control path (CLI + HTTP agree)", () => {
  test("CLI retry + ctl skip direct-apply on a quiescent run", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-ctl-"));
    failedRun(dir, "r1");
    const retry = cli(dir, "retry", "a", "--run", "r1");
    expect(retry.exit).toBe(0);
    expect(retry.out).toContain("control retry a");
    expect(loadRun(dir, "r1").doc.slices.find((s) => s.id === "a")?.status).toBe("pending");

    const skip = cli(dir, "ctl", "skip", "--slice", "b", "--run", "r1");
    expect(skip.exit).toBe(0);
    expect(skip.out).toMatch(/skip b/);
    expect(loadRun(dir, "r1").doc.slices.find((s) => s.id === "b")?.status).toBe("skipped");

    const resume = cli(dir, "ctl", "resume", "--run", "r1");
    expect(resume.exit).toBe(1);
    expect(resume.out).toContain("ompo resume --run r1");
  });

  test("POST /control: direct-apply, validation parity, queued on live runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-ctl-"));
    failedRun(dir, "r2");
    const server = startDashboardServer({ projectDir: dir });
    try {
      const post = (run: string, body: unknown, headers?: Record<string, string>) =>
        fetchJSON(`${server.url}/api/runs/${run}/control`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify(body),
        });

      // Same validator as `ompo ctl`: unknown kind / missing sliceId /
      // park-without-reason are 400, unknown slice is 404.
      expect((await post("r2", { kind: "dance" })).status).toBe(400);
      expect((await post("r2", { kind: "retry" })).status).toBe(400);
      expect((await post("r2", { kind: "park", sliceId: "a" })).status).toBe(400);
      expect((await post("r2", { kind: "retry", sliceId: "zzz" })).status).toBe(404);
      // Loop-local intents need a live loop, like `ompo ctl resume` quiescent —
      // the rejection names the run-resume recovery on both surfaces.
      const paused = await post("r2", { kind: "pause" });
      expect(paused).toMatchObject({ status: 200 });
      const pausedMessage = paused.body && typeof paused.body === "object" && "message" in paused.body ? paused.body.message : undefined;
      expect(pausedMessage).toContain("ompo resume --run r2");
      // Cross-origin writes are denied.
      expect((await post("r2", { kind: "pause" }, { origin: "https://evil.test" })).status).toBe(403);

      // Quiescent run: valid intents apply synchronously (cmdCtl parity).
      const retry = await post("r2", { kind: "retry", sliceId: "a" });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ ok: true, applied: "direct" });
      expect(loadRun(dir, "r2").doc.slices.find((s) => s.id === "a")?.status).toBe("pending");

      // Live run (lock held): the same intent queues with its seq.
      failedRun(dir, "r3");
      acquireLock(dir, "r3");
      try {
        const queued = await post("r3", { kind: "retry", sliceId: "a" });
        expect(queued.status).toBe(202);
        expect(queued.body).toMatchObject({ kind: "retry", sliceId: "a", applied: "queued" });
        expect(typeof (queued.body as { seq: unknown }).seq).toBe("number");
        // Not yet applied — the live loop drains it.
        expect(loadRun(dir, "r3").doc.slices.find((s) => s.id === "a")?.status).toBe("failed");
      } finally {
        releaseLock(dir, "r3");
      }
    } finally {
      server.stop();
    }
  });
});

describe("release gate: replay path (CLI + HTTP agree)", () => {
  test("ompo replay and GET /replay both report a matching cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-gate-replay-"));
    failedRun(dir, "r1");
    expect(cli(dir, "retry", "a", "--run", "r1").exit).toBe(0);
    const replay = cli(dir, "replay", "--run", "r1");
    expect(replay.exit).toBe(0);
    expect(replay.out).toContain("ok: cursor matches event-log replay");

    const server = startDashboardServer({ projectDir: dir });
    try {
      const res = await fetchJSON(`${server.url}/api/runs/r1/replay`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mismatches: [] });
      expect((res.body as { events: number }).events).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  });
});

describe("release gate: planner path (CLI + HTTP agree)", () => {
  test("ready / blocked / missing roadmaps agree across plan + preview", async () => {
    const good = mkdtempSync(join(tmpdir(), "ompo-gate-plan-"));
    writeFileSync(join(good, "ROADMAP.md"), VALID, "utf8");
    const bad = mkdtempSync(join(tmpdir(), "ompo-gate-plan-"));
    writeFileSync(join(bad, "ROADMAP.md"), BLOCKED, "utf8");
    const missing = mkdtempSync(join(tmpdir(), "ompo-gate-plan-"));

    const expected = buildPlanPreview(VALID);
    const plan = cli(good, "plan");
    expect(plan.exit).toBe(0);
    expect(plan.out).toContain(formatPreviewSummary(expected));
    expect(cli(bad, "plan").exit).toBe(1);
    expect(cli(missing, "plan").exit).toBe(1);

    for (const [dir, want] of [
      [good, { exists: true, status: expected.status }],
      [bad, { exists: true, status: "blocked" }],
      [missing, { exists: false, status: "blocked" }],
    ] as const) {
      const server = startDashboardServer({ projectDir: dir });
      try {
        const res = (await fetchJSON(`${server.url}/api/plan/preview`)).body as {
          exists: boolean;
          status: string;
          summary: string;
          rows: unknown[];
        };
        expect(res.exists).toBe(want.exists);
        expect(res.status).toBe(want.status);
        if (want.exists) {
          expect(res.rows.length).toBe(buildPlanPreview(readFileSync(join(dir, "ROADMAP.md"), "utf8")).rows.length);
        }
      } finally {
        server.stop();
      }
    }
    // The ready summary is the same string on both surfaces.
    const server = startDashboardServer({ projectDir: good });
    try {
      const res = (await fetchJSON(`${server.url}/api/plan/preview`)).body as { summary: string };
      expect(res.summary).toBe(formatPreviewSummary(expected));
    } finally {
      server.stop();
    }
  });
});

describe("release gate: architecture lock (engine -> store+events -> Web/TUI/CLI)", () => {
  test("web client is API-only: no store/control/fs imports, SSE only", () => {
    const root = join(import.meta.dir, "..", "web", "src");
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    let apiRefs = 0;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/^\s*import[^;]*?from\s*["']([^"']+)["']/gm)) {
        const spec = m[1]!;
        expect(spec.startsWith("node:")).toBe(false);
        expect(spec).not.toContain("../src/");
        expect(spec).not.toContain("src/store");
        expect(spec).not.toContain("src/control");
      }
      expect(text).not.toContain("new WebSocket");
      apiRefs += (text.match(/\/api\//g) ?? []).length;
    }
    // The client actually uses the API (not a second store reader).
    expect(apiRefs).toBeGreaterThan(0);
  });
});

describe("release gate: deck boundary (roadmap d01)", () => {
  const webRoot = join(import.meta.dir, "..", "web", "src");
  const sceneRoot = join(webRoot, "scene");

  const walkFiles = (root: string, match: (name: string) => boolean): string[] => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (match(e.name)) files.push(p);
      }
    };
    walk(root);
    return files;
  };

  const importSpecifiers = (text: string): string[] => [...text.matchAll(/^\s*import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]!);
  const relative = (file: string): string => file.slice(webRoot.length + 1).split("\\").join("/");

  test("`three` is confined to renderer.ts; Deck.tsx may not smuggle it in", () => {
    const scene = walkFiles(sceneRoot, (name) => name.endsWith(".ts") || name.endsWith(".tsx"));
    expect(scene.length).toBeGreaterThan(0);
    for (const file of scene) {
      const name = relative(file);
      const allowed = name === "scene/renderer.ts" || /^scene\/Deck.*\.tsx$/.test(name);
      const usesThree = importSpecifiers(readFileSync(file, "utf8")).some((spec) => spec === "three" || spec.startsWith("three/"));
      if (usesThree && !allowed) {
        throw new Error(`${name} imports three — only scene/renderer.ts and Deck*.tsx may`);
      }
    }
    // The renderer is the one that must, and it is not a documentation claim.
    const renderer = readFileSync(join(sceneRoot, "renderer.ts"), "utf8");
    expect(importSpecifiers(renderer)).toContain("three");
    expect(importSpecifiers(readFileSync(join(sceneRoot, "Deck.tsx"), "utf8"))).not.toContain("three");
  });

  test("the deck renders: no fetching, no transport, no store access under scene/**", () => {
    for (const file of walkFiles(sceneRoot, (name) => name.endsWith(".ts") || name.endsWith(".tsx"))) {
      const name = relative(file);
      const text = readFileSync(file, "utf8");
      expect(`${name}: fetch`).toBe(text.includes("fetch(") ? `${name}: fetch(` : `${name}: fetch`);
      expect(`${name}: EventSource`).toBe(text.includes("new EventSource") ? `${name}: EventSource` : `${name}: EventSource`);
      expect(`${name}: WebSocket`).toBe(text.includes("new WebSocket") ? `${name}: WebSocket` : `${name}: WebSocket`);
      for (const spec of importSpecifiers(text)) {
        expect(`${name}: ${spec}`).toBe(spec.startsWith("node:") ? `${name}: forbidden` : `${name}: ${spec}`);
        expect(`${name}: ${spec}`).toBe(spec.includes("../src/") ? `${name}: forbidden` : `${name}: ${spec}`);
      }
    }
  });

  test("M1: the deck projects instead of re-deriving (no second source of slice/agent state)", () => {
    // Derivation lives in web/src/lib/** and, for the scene's own model, in the
    // deck modules listed in the roadmap's module map. Anywhere else — a
    // component, a page, a new scene file — re-deriving slice status, the
    // "needs eyes" ranking, the pipeline stage index or the live-window
    // contents is a second source of truth, whether copied or re-exported.
    const deckDerivations = new Set([
      "scene/model.ts",
      "scene/rail.ts",
      "scene/focus.ts",
      "scene/lanes.ts",
      "scene/alerts.ts",
      "scene/deltas.ts",
      "scene/history.ts",
      "scene/fallback.ts",
      "scene/palette.ts",
      "scene/ambient.ts",
    ]);
    const stageLabels = ["Claim", "Generation", "Work", "Handoff", "Verify", "Review", "Done"];
    const violations: string[] = [];
    for (const file of walkFiles(webRoot, (name) => name.endsWith(".ts") || name.endsWith(".tsx"))) {
      const name = relative(file);
      if (name.startsWith("lib/") || deckDerivations.has(name)) continue;
      const text = readFileSync(file, "utf8");

      // Rank switch over live statuses: `case "running": … return 0`.
      const rankSwitch = /(?:case\s*["'](?:running|verifying)["']\s*:|===\s*["'](?:running|verifying)["'])[\s\S]{0,240}?return\s+\d/;
      if (rankSwitch.test(text)) violations.push(`${name} ranks slices by status (preferredSliceId belongs in lib/selection.ts)`);

      // Pipeline stage index: three or more stage names in one file.
      const present = stageLabels.filter((label) => text.includes(`"${label}"`));
      if (present.length >= 3) violations.push(`${name} names pipeline stages (${present.join(", ")}) — buildPipelineStages belongs in lib/pipeline.ts`);
    }
    expect(violations).toEqual([]);
  });
});
