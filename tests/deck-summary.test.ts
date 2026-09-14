/**
 * Semantic ambient summaries (`ux04`), tested without a browser.
 *
 * Ambient text says the kind, never a fragment: `slice · kind-word` for
 * alerts, word-capped hero heads for lanes, glyph+identity for live heads.
 * Full diagnostics stay in `title=` and the Inspector.
 */

import { describe, expect, test } from "bun:test";
import { alertSummary, basenameOf, laneSummary, liveHead } from "../web/src/scene/summary.ts";
import type { DeckAlert } from "../web/src/scene/alerts.ts";

function alert(kind: DeckAlert["kind"], sliceId: string | null = "longreason"): DeckAlert {
  return { kind, severity: "high", sliceId, message: "worker exited 1 mid-generation: deadbeef".repeat(10), lastSeq: 9 };
}

describe("ux04 semantic summaries", () => {
  test("alerts read as slice plus kind-word, never a raw tail", () => {
    expect(alertSummary(alert("failed"))).toBe("longreason · failed");
    expect(alertSummary(alert("blocked-env", "envblock"))).toBe("envblock · blocked");
    expect(alertSummary(alert("wedged", "b"))).toBe("b · stalled");
    expect(alertSummary(alert("verify-failed", "c"))).toBe("c · gate failed");
    expect(alertSummary(alert("double-loop", null))).toBe("run · double loop");
  });

  test("lane tails cap at 80 chars with the head intact", () => {
    const long = `tool edit: src/${"deeply-nested-module-".repeat(8)}handler.ts plus more words here and beyond`;
    const short = laneSummary(long);
    expect(short.length).toBeLessThanOrEqual(80);
    expect(short).toContain("tool edit:");
  });

  test("basenames strip directories, live heads carry glyph plus stage", () => {
    expect(basenameOf("src/a/b/handler.ts")).toBe("handler.ts");
    expect(basenameOf("handler.ts")).toBe("handler.ts");
    expect(liveHead("b", "running", "Work")).toBe("● b · Work");
    expect(liveHead("b", "failed", "")).toBe("✕ b");
  });
});
