import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanPreview } from "../src/planPreview.ts";
import { startDashboardServer } from "../src/server.ts";
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

function serve(markdown: string | null): { stop: () => void; url: string } {
  const dir = mkdtempSync(join(tmpdir(), "ompo-plan-"));
  if (markdown !== null) writeFileSync(join(dir, "ROADMAP.md"), markdown, "utf8");
  const server = startDashboardServer({ projectDir: dir });
  return { stop: server.stop, url: server.url };
}

async function fetchJSON(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("plan preview rows", () => {
  test("rows carry full verify gates, files, deps, and effort", () => {
    const p = buildPlanPreview(VALID);
    expect(p.status).toBe("ready");
    expect(p.rows[0]).toMatchObject({
      id: "a",
      effort: "lo",
      verifyCount: 1,
      verify: ["bun test -- scope-a"],
      files: ["src/a.ts"],
      deps: [],
    });
    expect(p.rows[1]).toMatchObject({ id: "b", effort: "med", deps: ["a"] });
  });
});

describe("plan dashboard endpoints", () => {
  test("preview exposes slices, status, surveyed docs, and hash", async () => {
    const { stop, url } = serve(VALID);
    try {
      const { status, body } = await fetchJSON(`${url}/api/plan/preview`);
      expect(status).toBe(200);
      expect(body.exists).toBe(true);
      expect(body.status).toBe("ready");
      expect(body.roadmapPath).toBe("ROADMAP.md");
      expect(typeof body.sourceHash).toBe("string");
      expect(typeof body.summary).toBe("string");
      const rows = body.rows as { id: string; verify: string[]; files: string[] }[];
      expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
      expect(rows[0]!.verify).toEqual(["bun test -- scope-a"]);
      expect(rows[0]!.files).toEqual(["src/a.ts"]);
      expect(Array.isArray(body.surveyed)).toBe(true);
    } finally {
      stop();
    }
  });

  test("accept and abort validate against disk state; bad input is 400", async () => {
    const { stop, url } = serve(VALID);
    try {
      const accept = await fetchJSON(`${url}/api/plan/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(accept.status).toBe(200);
      expect(accept.body.decision).toBe("accept");
      const abort = await fetchJSON(`${url}/api/plan/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "abort" }),
      });
      expect(abort.status).toBe(200);
      const bogus = await fetchJSON(`${url}/api/plan/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "rewrite" }),
      });
      expect(bogus.status).toBe(400);
    } finally {
      stop();
    }
  });

  test("blocked plans cannot be accepted (409) and surface errors", async () => {
    const { stop, url } = serve(BLOCKED);
    try {
      const { status, body } = await fetchJSON(`${url}/api/plan/preview`);
      expect(status).toBe(200);
      expect(body.status).toBe("blocked");
      expect((body.errors as unknown[]).length).toBeGreaterThan(0);
      const accept = await fetchJSON(`${url}/api/plan/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(accept.status).toBe(409);
    } finally {
      stop();
    }
  });

  test("raw roadmap returns markdown; missing roadmap is blocked with 404s", async () => {
    const { stop, url } = serve(VALID);
    try {
      const { status, body } = await fetchJSON(`${url}/api/plan/roadmap`);
      expect(status).toBe(200);
      expect(body.path).toBe("ROADMAP.md");
      expect(body.markdown).toBe(VALID);
    } finally {
      stop();
    }
    const missing = serve(null);
    try {
      const preview = await fetchJSON(`${missing.url}/api/plan/preview`);
      expect(preview.status).toBe(200);
      expect(preview.body.exists).toBe(false);
      expect(preview.body.status).toBe("blocked");
      const raw = await fetchJSON(`${missing.url}/api/plan/roadmap`);
      expect(raw.status).toBe(404);
      const accept = await fetchJSON(`${missing.url}/api/plan/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(accept.status).toBe(404);
    } finally {
      missing.stop();
    }
  });
});
