import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlanPreview,
  defaultPreviewDecision,
  formatPreviewSummary,
  renderPreviewLines,
} from "../src/planPreview.ts";
import { driveUnifiedFlow, type UnifiedSession } from "../src/unified.tsx";
import type { LoopOptions, LoopResult } from "../src/loop.ts";
const VALID = "## [a] First slice work item here\nDo A thoroughly and completely now.\nEffort: lo\nVerify: true\n## [b] Second work item here\nDo B thoroughly and completely now.\nEffort: lo\nDepends: a\nVerify: true\n";
const NO_VERIFY = "## [a] First slice work item here\nDo A thoroughly and completely now.\nEffort: lo\n";
const UNKNOWN_DEP = "## [a] First slice work item here\nDo A thoroughly and completely now.\nEffort: lo\nDepends: nope\nVerify: true\n";
const CYCLE = "## [a] First slice work item here\nDo A thoroughly and completely now.\nEffort: lo\nDepends: b\nVerify: true\n## [b] Second work item here\nDo B thoroughly and completely now.\nEffort: lo\nDepends: a\nVerify: true\n";
const OR_GATE = "## [a] First slice work item here\nDo A thoroughly.\nVerify: make test || true\nEffort: lo\n";

describe("buildPlanPreview", () => {
  test("valid plan previews rows as ready", () => {
    const p = buildPlanPreview(VALID);
    expect(p.status).toBe("ready");
    expect(p.errors).toEqual([]);
    expect(p.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(p.rows[0]).toMatchObject({ title: "First slice work item here", verifyCount: 1 });
    expect(p.rows[1]!.deps).toEqual(["a"]);
    expect(formatPreviewSummary(p)).toContain("2 slice(s) — ready");
  });

  test("missing Verify surfaces as a blocking error (existing lint rule)", () => {
    const p = buildPlanPreview(NO_VERIFY);
    expect(p.status).toBe("blocked");
    expect(p.errors.some((f) => f.code === "no-verify")).toBe(true);
  });

  test("unknown dependency blocks with no rows lost", () => {
    const p = buildPlanPreview(UNKNOWN_DEP);
    expect(p.status).toBe("blocked");
    expect(p.errors.length).toBeGreaterThan(0);
  });

  test("dependency cycle blocks", () => {
    const p = buildPlanPreview(CYCLE);
    expect(p.status).toBe("blocked");
    expect(p.errors.map((e) => e.message).join()).toMatch(/cycle/i);
  });

  test("or-gate warning surfaces without blocking", () => {
    const p = buildPlanPreview(OR_GATE);
    expect(p.status).toBe("warnings");
    expect(p.warnings.some((f) => f.code === "or-gate")).toBe(true);
    expect(renderPreviewLines(p).join("\n")).toContain("or-gate");
  });

  test("unparseable roadmap yields empty rows with the parse error", () => {
    const p = buildPlanPreview("no headings here\n");
    expect(p.status).toBe("blocked");
    expect(p.rows).toEqual([]);
    expect(p.errors[0]!.code).toBe("parse");
  });
});

describe("defaultPreviewDecision", () => {
  test("accepts ready and warnings, throws on blocked", async () => {
    await expect(defaultPreviewDecision(buildPlanPreview(VALID))).resolves.toBe("accept");
    await expect(defaultPreviewDecision(buildPlanPreview(OR_GATE))).resolves.toBe("accept");
    await expect(defaultPreviewDecision(buildPlanPreview(NO_VERIFY))).rejects.toThrow(/blocking error/);
  });
});

describe("driveUnifiedFlow preview gate", () => {
  const okLoop = (seen: { calls: number }): ((o: LoopOptions) => Promise<LoopResult>) =>
    (async () => {
      seen.calls += 1;
      return { exitCode: 0, done: 1, failed: 0, skipped: 0, pending: 0, blockedEnv: 0 };
    });

  function projectWith(md: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ompo-prev-"));
    writeFileSync(join(dir, "ROADMAP.md"), md, "utf8");
    return dir;
  }

  test("accept proceeds to the loop", async () => {
    const dir = projectWith(VALID);
    const seen = { calls: 0 };
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    const res = await driveUnifiedFlow(
      { projectDir: dir, looper: okLoop(seen), preview: (async () => "accept") },
      () => {},
      session,
      new AbortController().signal,
    );
    expect(res.exitCode).toBe(0);
    expect(seen.calls).toBe(1);
    expect(session.phase).toBe("done");
  });

  test("abort stops before the loop", async () => {
    const dir = projectWith(VALID);
    const seen = { calls: 0 };
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    const res = await driveUnifiedFlow(
      { projectDir: dir, looper: okLoop(seen), preview: (async () => "abort") },
      () => {},
      session,
      new AbortController().signal,
    );
    expect(res.exitCode).toBe(2);
    expect(seen.calls).toBe(0);
    expect(session.note).toMatch(/preview aborted/);
  });

  test("edit reloads the file and revalidates", async () => {
    const dir = projectWith(NO_VERIFY);
    const seen = { calls: 0 };
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    let edited = false;
    const res = await driveUnifiedFlow(
      {
        projectDir: dir,
        looper: okLoop(seen),
        preview: (async (p) => {
          if (!edited) {
            edited = true;
            writeFileSync(join(dir, "ROADMAP.md"), VALID, "utf8");
            return "edit";
          }
          expect(p.status).toBe("ready");
          return "accept";
        }),
      },
      () => {},
      session,
      new AbortController().signal,
    );
    expect(res.exitCode).toBe(0);
    expect(seen.calls).toBe(1);
  });

  test("accepting a blocked plan throws and never runs", async () => {
    const dir = projectWith(NO_VERIFY);
    const seen = { calls: 0 };
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    await expect(
      driveUnifiedFlow(
        { projectDir: dir, looper: okLoop(seen), preview: (async () => "accept") },
        () => {},
        session,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/blocking error/);
    expect(seen.calls).toBe(0);
  });

  test("default handler refuses blocked roadmaps headlessly", async () => {
    const dir = projectWith(UNKNOWN_DEP);
    const seen = { calls: 0 };
    const session: UnifiedSession = { phase: "planning", runId: null, note: "" };
    await expect(
      driveUnifiedFlow({ projectDir: dir, looper: okLoop(seen) }, () => {}, session, new AbortController().signal),
    ).rejects.toThrow(/blocking error/);
    expect(seen.calls).toBe(0);
  });
});
