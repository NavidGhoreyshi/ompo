import { describe, expect, test } from "bun:test";
 import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { acquireLock, createRun, releaseLock } from "../src/store.ts";
import { HEARTBEAT_MS, IDLE_TIMEOUT_S, startDashboardServer } from "../src/server.ts";
// The sandbox sets HTTP(S)_PROXY without NO_PROXY; loopback test traffic
// must not go through the proxy.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

const MD = `## [a] Alpha
Effort: lo
body a
## [b] Beta
Depends: a
body b
`;

function fixture(): { dir: string; stop: () => void; url: string } {
  const dir = mkdtempSync(join(tmpdir(), "ompo-web-"));
  createRun(dir, parseRoadmap(MD), "r1");
  const server = startDashboardServer({ projectDir: dir });
  return { dir, stop: server.stop, url: server.url };
}

async function getJSON(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

describe("dashboard server timeouts", () => {
  test("SSE heartbeat fires before Bun.serve idle timeout", () => {
    // Regression: default idleTimeout (10s) killed the event stream before
    // the first 15s heartbeat — dead live-updates on the dashboard.
    expect(HEARTBEAT_MS).toBeLessThan(IDLE_TIMEOUT_S * 1000);
  });
});

describe("dashboard server", () => {
  test("health, runs, detail, events", async () => {
    const { stop, url } = fixture();
    try {
      const health = await getJSON(`${url}/api/health`);
      expect(health.status).toBe(200);
      expect((health.body as { ok: boolean }).ok).toBe(true);

      const runs = await getJSON(`${url}/api/runs`);
      expect(runs.status).toBe(200);
      expect((runs.body as unknown[]).length).toBe(1);

      const latest = await getJSON(`${url}/api/runs/latest`);
      expect(latest.status).toBe(200);
      const detail = latest.body as { runId: string; slices: { id: string }[] };
      expect(detail.runId).toBe("r1");
      expect(detail.slices.map((s) => s.id)).toEqual(["a", "b"]);

      const events = await getJSON(`${url}/api/runs/r1/events?afterSeq=-1&limit=10`);
      expect(events.status).toBe(200);
      const ev = events.body as { events: unknown[]; offset: number };
      expect(ev.events.length).toBeGreaterThan(0);
      expect(ev.offset).toBeGreaterThanOrEqual(0);
    } finally {
      stop();
    }
  });
  test("unknown run is 404, bad run id is 400, no file endpoint exists", async () => {
    const { stop, url } = fixture();
    try {
      expect((await getJSON(`${url}/api/runs/nope`)).status).toBe(404);
      expect((await getJSON(`${url}/api/runs/bad!id`)).status).toBe(400);
      expect((await fetch(`${url}/api/files/roadmap.json`)).status).toBe(404);
    } finally {
      stop();
    }
  });

  test("control validation, unknown slice, direct apply on quiescent run", async () => {
    const { stop, url } = fixture();
    try {
      const post = (body: unknown, headers?: Record<string, string>) =>
        getJSON(`${url}/api/runs/r1/control`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify(body),
        });

      expect((await post({ kind: "dance" })).status).toBe(400);
      expect((await post({ kind: "retry" })).status).toBe(400);
      expect((await post({ kind: "park", sliceId: "a" })).status).toBe(400);
      expect((await post({ kind: "retry", sliceId: "zzz" })).status).toBe(404);

      // Quiescent run: slice intents apply synchronously (cmdCtl parity).
      const skip = await post({ kind: "skip", sliceId: "a" });
      expect(skip.status).toBe(200);
      expect(skip.body).toMatchObject({ ok: true, applied: "direct" });

      const detail = (await getJSON(`${url}/api/runs/r1`)).body as {
        slices: { id: string; status: string }[];
      };
      expect(detail.slices.find((s) => s.id === "a")?.status).toBe("skipped");

      // Loop-local intents need a live loop, like `ompo ctl`.
      const pause = await post({ kind: "pause" });
      expect(pause.status).toBe(200);
      expect(pause.body).toMatchObject({ ok: false, applied: "direct" });
      const pauseMessage = pause.body && typeof pause.body === "object" && "message" in pause.body ? pause.body.message : undefined;
      expect(pauseMessage).toContain("ompo resume --run r1");

      // Cross-origin writes are denied.
      const evil = await post({ kind: "pause" }, { origin: "https://evil.test" });
      expect(evil.status).toBe(403);
    } finally {
      stop();
    }
  });

  test("stats, query, replay, slice log/diff, stream", async () => {
    const { stop, url } = fixture();
    try {
      expect((await getJSON(`${url}/api/runs/r1/stats`)).status).toBe(200);
      expect((await getJSON(`${url}/api/runs/r1/query?q=all`)).status).toBe(200);
      expect((await getJSON(`${url}/api/runs/r1/query?q=${encodeURIComponent("all where bogus=1")}`)).status).toBe(400);
      expect((await getJSON(`${url}/api/runs/r1/replay`)).status).toBe(200);
      expect((await getJSON(`${url}/api/runs/r1/slices/zzz`)).status).toBe(404);
      expect((await getJSON(`${url}/api/runs/r1/slices/a/log?tail=10`)).status).toBe(200);
      expect((await getJSON(`${url}/api/runs/r1/slices/a/log?tail=501`)).status).toBe(400);
      expect((await getJSON(`${url}/api/runs/r1/slices/a/diff`)).status).toBe(200);

      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/runs/r1/stream?afterSeq=-1`, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const first = await reader.read();
      ctrl.abort();
      await reader.cancel().catch(() => {});
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("event:");
    } finally {
      stop();
    }
  });

  test("events/stream is the canonical SSE tail (legacy /stream alias kept)", async () => {
    const { stop, url } = fixture();
    try {
      for (const tail of ["events/stream", "stream"]) {
        const ctrl = new AbortController();
        const res = await fetch(`${url}/api/runs/r1/${tail}?afterSeq=-1`, { signal: ctrl.signal });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const reader = res.body!.getReader();
        const first = await reader.read();
        ctrl.abort();
        await reader.cancel().catch(() => {});
        const text = new TextDecoder().decode(first.value);
        // Existing event semantics verbatim: replayed RunEvent frames carry `id:` = seq.
        expect(text).toContain("event: event");
        expect(text).toContain("run_started");
      }
      // Last-Event-ID resume skips already-seen seqs (only the `run` meta frame is new).
      const resumeCtrl = new AbortController();
      const resumed = await fetch(`${url}/api/runs/r1/events/stream`, {
        headers: { "last-event-id": "0" },
        signal: resumeCtrl.signal,
      });
      expect(resumed.status).toBe(200);
      const resumeReader = resumed.body!.getReader();
      const resumeFirst = await resumeReader.read();
      resumeCtrl.abort();
      await resumeReader.cancel().catch(() => {});
      const resumeText = new TextDecoder().decode(resumeFirst.value);
      expect(resumeText).toContain("event: run");
      expect((await getJSON(`${url}/api/runs/nope/events/stream`)).status).toBe(404);
      expect((await getJSON(`${url}/api/runs/r1/events/stream?afterSeq=bogus`)).status).toBe(400);
    } finally {
      stop();
    }
  });

  test("resume spawns a detached loop for quiescent runs, refuses live ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ompo-web-"));
    createRun(dir, parseRoadmap(MD), "r1");
    const calls: { cmd: string[]; cwd: string; logPath: string }[] = [];
    const server = startDashboardServer({
      projectDir: dir,
      spawnResume: (cmd, opts) => {
        calls.push({ cmd, cwd: opts.cwd, logPath: opts.logPath });
        return { pid: 4242 };
      },
    });
    try {
      const post = (runId: string, headers?: Record<string, string>) =>
        getJSON(`${server.url}/api/runs/${runId}/resume`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: "{}",
        });
      expect((await post("nope")).status).toBe(404);
      expect((await post("bad!id")).status).toBe(400);
      expect((await post("r1", { origin: "https://evil.test" })).status).toBe(403);

      // Quiescent: spawns the same `resume --run` path as the CLI, detached.
      const spawned = await post("r1");
      expect(spawned.status).toBe(202);
      expect(spawned.body).toMatchObject({ ok: true, applied: "spawned", pid: 4242 });
      expect(calls.length).toBe(1);
      expect(calls[0]!.cmd.slice(-3)).toEqual(["resume", "--run", "r1"]);
      expect(calls[0]!.cwd).toBe(dir);
      expect(calls[0]!.logPath).toContain("r1");

      // Live: single-flight — the lock holder wins, dashboard refuses.
      acquireLock(dir, "r1");
      try {
        const live = await post("r1");
        expect(live.status).toBe(409);
        expect(calls.length).toBe(1);
      } finally {
        releaseLock(dir, "r1");
      }
    } finally {
      server.stop();
    }
  });

  test("serves the dashboard shell", async () => {
    const { stop, url } = fixture();
    try {
      const res = await fetch(`${url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("ompo");
    } finally {
      stop();
    }
  });

 describe("operator sessions", () => {
   function sessionFixture(): { dir: string; stop: () => void; url: string; root: string } {
     const dir = mkdtempSync(join(tmpdir(), "ompo-web-sess-"));
     createRun(dir, parseRoadmap(MD), "r1");
     const root = join(dir, ".omp", "roadmap", "runs", "r1");
     writeFileSync(join(root, "unblock-1.prompt.md"), "# unblock 1\n", "utf8");
     writeFileSync(
       join(root, "unblock-1.meta.json"),
       JSON.stringify({ targets: ["a"], startedAt: "2026-09-10T00:00:00.000Z" }) + "\n",
       "utf8",
     );
     writeFileSync(join(root, "unblock-1.log"), "exit=0 timedOut=false durationMs=10\n--- stdout ---\nok\n", "utf8");
     writeFileSync(join(root, "unblock-2.prompt.md"), "# unblock 2\n", "utf8");
     const sliceA = join(root, "slices", "a");
     mkdirSync(sliceA, { recursive: true });
     writeFileSync(join(sliceA, "debug-1.log"), "exit=1 timedOut=false durationMs=5\n--- stdout ---\nnope\n", "utf8");
     writeFileSync(join(sliceA, "debug-prompt-2.md"), "# debug 2\n", "utf8");
     const server = startDashboardServer({ projectDir: dir });
     return { dir, stop: server.stop, url: server.url, root };
   }

   function sessionRows(body: unknown): { key: string; targets: unknown; exit: unknown }[] {
     if (!Array.isArray(body)) throw new Error("expected sessions array");
     return body.map((s) => {
       if (
         !s ||
         typeof s !== "object" ||
         !("name" in s) ||
         !("kind" in s) ||
         !("sliceId" in s) ||
         !("status" in s) ||
         !("targets" in s) ||
         !("exit" in s)
       ) {
         throw new Error("expected session rows");
       }
       return {
         key: `${String(s.kind)}:${String(s.name)}:${s.sliceId === null ? "" : String(s.sliceId)}:${String(s.status)}`,
         targets: s.targets,
         exit: s.exit,
       };
     });
   }

   function logLines(body: unknown): string[] {
     if (!body || typeof body !== "object" || !("lines" in body) || !Array.isArray(body.lines)) {
       throw new Error("expected { lines }");
     }
     return body.lines.filter((l): l is string => typeof l === "string");
   }

   test("sessions list reports running vs done with targets and exit", async () => {
     const { stop, url } = sessionFixture();
     try {
       const res = await getJSON(`${url}/api/runs/r1/sessions`);
       expect(res.status).toBe(200);
       const sessions = sessionRows(res.body);
       expect(sessions.map((s) => s.key)).toEqual([
         "unblock:unblock-1::done",
         "unblock:unblock-2::running",
         "debug:debug-1:a:done",
         "debug:debug-2:a:running",
       ]);
       expect(sessions[0]).toMatchObject({ targets: ["a"], exit: 0 });
       expect(sessions[2]).toMatchObject({ exit: 1 });
     } finally {
       stop();
     }
   });

   test("empty runs report no sessions", async () => {
     const { stop, url } = fixture();
     try {
       const res = await getJSON(`${url}/api/runs/r1/sessions`);
       expect(res.status).toBe(200);
       expect(res.body).toEqual([]);
     } finally {
       stop();
     }
   });

   test("session log tails unblock and debug logs, rejects traversal", async () => {
     const { stop, url } = sessionFixture();
     try {
       const unblock = await getJSON(`${url}/api/runs/r1/sessions/unblock-1/log?tail=10`);
       expect(unblock.status).toBe(200);
       expect(logLines(unblock.body)[0]).toBe("exit=0 timedOut=false durationMs=10");

       const debug = await getJSON(`${url}/api/runs/r1/sessions/debug-1/log?slice=a&tail=10`);
       expect(debug.status).toBe(200);
       expect(logLines(debug.body)[0]).toBe("exit=1 timedOut=false durationMs=5");

       // Dispatch is strict: unknown names, missing/wrong scope, bad tails.
       expect((await getJSON(`${url}/api/runs/r1/sessions/nope-9/log`)).status).toBe(400);
       expect((await getJSON(`${url}/api/runs/r1/sessions/unblock-1x/log`)).status).toBe(400);
       expect((await getJSON(`${url}/api/runs/r1/sessions/debug-1/log`)).status).toBe(400);
       expect((await getJSON(`${url}/api/runs/r1/sessions/unblock-1/log?slice=a`)).status).toBe(400);
       expect((await getJSON(`${url}/api/runs/r1/sessions/debug-1/log?slice=nope`)).status).toBe(404);
       expect((await getJSON(`${url}/api/runs/r1/sessions/unblock-1/log?tail=0`)).status).toBe(400);
       // Encoded traversal never reaches a session file (rejected, nothing served).
       expect((await getJSON(`${url}/api/runs/r1/sessions/..%2F..%2Fsecret/log`)).status).toBe(400);
     } finally {
       stop();
     }
   });
 });
});
