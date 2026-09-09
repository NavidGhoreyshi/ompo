import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../src/parse.ts";
import { createRun } from "../src/store.ts";
import { startDashboardServer } from "../src/server.ts";
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
});
