/**
 * Composition-first dashboard redesign: structural pins.
 *
 * The browser UI is verified objectively here (selection order, viewport
 * shell rules, composition), not aesthetically. Visual quality needs human
 * eyes on rendered captures (see captures/ + scripts/web-qa.ts).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heroAction, preferredSliceId } from "../web/src/lib/selection.ts";
function slice(id: string, status: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return { id, status, updatedAt };
}

const ROOT = join(import.meta.dir, "..");
const css = readFileSync(join(ROOT, "web", "src", "styles", "theme.css"), "utf8");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("preferred slice auto-selection (single selection system)", () => {
  test("empty run selects nothing", () => {
    expect(preferredSliceId([])).toBeNull();
  });

  test("running slice beats done and pending", () => {
    expect(preferredSliceId([slice("a", "done"), slice("b", "running"), slice("c", "pending")])).toBe("b");
  });

  test("verifying slice beats failed", () => {
    expect(preferredSliceId([slice("f", "failed"), slice("v", "verifying")])).toBe("v");
  });

  test("failed beats blocked-env and done when nothing runs", () => {
    expect(preferredSliceId([slice("d", "done"), slice("e", "blocked-env"), slice("f", "failed")])).toBe("f");
  });

  test("blocked-env beats done and pending when nothing runs or fails", () => {
    expect(preferredSliceId([slice("d", "done"), slice("p", "pending"), slice("e", "blocked-env")])).toBe("e");
  });

  test("most recently completed done slice wins among done", () => {
    expect(
      preferredSliceId([
        slice("old", "done", "2026-01-01T00:00:00.000Z"),
        slice("new", "done", "2026-03-01T00:00:00.000Z"),
        slice("p", "pending"),
      ]),
    ).toBe("new");
  });

  test("first slice wins when everything is pending", () => {
    expect(preferredSliceId([slice("a", "pending"), slice("b", "pending")])).toBe("a");
  });

  test("concurrent runners resolve to the first live slice, never null", () => {
    expect(preferredSliceId([slice("w1", "running"), slice("w2", "running"), slice("q", "pending")])).toBe("w1");
  });
});

describe("hero action line (what is it on?)", () => {
  test("live worker line wins", () => {
    expect(heroAction({ status: "running", lastLine: "run typecheck", lastEvent: "slice_claimed" })).toBe("run typecheck");
  });

  test("latest slice event is the fallback", () => {
    expect(heroAction({ status: "running", lastEvent: "worker_finished — ok" })).toBe("worker_finished — ok");
  });

  test("pending names its dependencies", () => {
    expect(heroAction({ status: "pending", deps: ["s4b", "s5a"] })).toBe("queued — needs s4b, s5a");
    expect(heroAction({ status: "pending", deps: [] })).toBe("queued");
  });

  test("failure and block surface their reasons", () => {
    expect(heroAction({ status: "failed", reason: "gate bun test failed" })).toBe("gate bun test failed");
    expect(heroAction({ status: "blocked-env", reason: "postgres down" })).toBe("postgres down");
    expect(heroAction({ status: "blocked-env" })).toBe("waiting on environment");
  });

  test("verifying and idle states never invent work", () => {
    expect(heroAction({ status: "verifying" })).toBe("gates running…");
    expect(heroAction({ status: "running" })).toBe("working…");
    expect(heroAction({ status: "done" })).toBe("done");
  });
});

describe("viewport app shell (no page-level scroll)", () => {
  test("shell fills the viewport and clips page scroll", () => {
    expect(css).toMatch(/\.omp-shell\s*\{[^}]*height:\s*100dvh/s);
    expect(css).toMatch(/\.omp-shell\s*\{[^}]*overflow:\s*hidden/s);
  });

  test("body band is a fixed viewport region", () => {
    expect(css).toMatch(/\.omp-body\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.omp-body\s*\{[^}]*min-height:\s*0/s);
  });

  test("board, inspector, and activity scroll internally", () => {
    expect(css).toMatch(/\.omp-board-scroll\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.omp-inspector\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.omp-activity-list\s*\{[^}]*overflow-y:\s*auto/s);
  });

  test("board panel root is the flex parent that enables board scrolling", () => {
    // Regression: .omp-board-scroll is flex:1, which is inert unless its
    // parent is flex — without this the board grew with content and clipped
    // under .omp-workspace overflow:hidden with no scroll.
    expect(css).toMatch(/\.omp-board-panel\s*\{[^}]*display:\s*flex/s);
    expect(css).toMatch(/\.omp-board-panel\s*\{[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/\.omp-board-panel\s*\{[^}]*overflow:\s*hidden/s);
    expect(src("web/src/pages/Overview.tsx")).toContain("omp-board-panel");
    expect(src("web/src/pages/Overview.tsx")).not.toContain("omp-board-tabs");
  });

  test("secondary pages scroll as a whole inside .omp-page", () => {
    expect(css).toMatch(/\.omp-page\s*\{[^}]*overflow-y:\s*auto/s);
    for (const p of ["RunsPage", "AgentsPage", "StatsPage", "RoadmapPage"]) {
      expect(src(`web/src/pages/${p}.tsx`)).toContain("omp-page");
    }
  });

  test("activity is a fixed-height strip, not page content", () => {
    expect(css).toMatch(/\.omp-activity\s*\{[^}]*height:\s*\d+px/s);
  });

  test("narrow layouts keep the shell viewport-sized", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*900px\)/);
    expect(css).toMatch(/prefers-reduced-motion/);
  });
});

describe("run strip replaces KPI cards", () => {
  test("no KPI card language remains in the shell stylesheet", () => {
    expect(css).not.toContain(".omp-stat-card");
    expect(css).not.toContain(".omp-cards");
    expect(css).not.toContain(".omp-bento");
  });

  test("run hero, lanes, board rows, trace, and tabs exist", () => {
    for (const cls of [".omp-runline", ".omp-hero", ".omp-hero-sub", ".omp-runline-telemetry", ".omp-lanes", ".omp-lane", ".omp-board-row", ".omp-trace", ".omp-tabs", ".omp-tab", ".omp-attention"]) {
      expect(css).toContain(cls);
    }
  });

  test("telemetry sits muted below the hero", () => {
    expect(css).toMatch(/\.omp-runline-telemetry\s*\{[^}]*color:\s*var\(--omp-muted\)/s);
    expect(css).toMatch(/\.omp-hero-title\s*\{[^}]*font-size:\s*18px/s);
  });

  test("palette is dark but inviting: navy-charcoal surfaces, bright text", () => {
    expect(css).toContain("--omp-bg: #0e131a");
    expect(css).toContain("--omp-panel: #151d29");
    expect(css).toContain("--omp-text: #e8eef5");
  });

  test("status never relies on color alone in the stylesheet", () => {
    expect(css).toContain(".omp-status-sym");
    expect(css).toContain(".omp-board-state");
  });
});

describe("overview composition (execution first)", () => {
  const overview = src("web/src/pages/Overview.tsx");
  const app = src("web/src/App.tsx");
  const inspector = src("web/src/components/Inspector.tsx");
  const board = src("web/src/components/SliceTable.tsx");
  test("overview leads with the live worker feed, not the roadmap — not the bento grid", () => {
    expect(overview).toContain("RunHeader");
    expect(overview).toContain("LiveFeed");
    expect(overview).toContain("WorkerLanes");
    expect(overview).toContain("SliceTable");
    // The roadmap graph lives in exactly one place (RoadmapPage), not in
    // Overview alongside the board.
    expect(overview).not.toContain("Dag");
    expect(src("web/src/pages/RoadmapPage.tsx")).toContain("Dag");
    expect(overview).not.toContain("Timeline");
    expect(overview).not.toContain("omp-bento");
  });

  test("overview passes live lanes into the workspace", () => {
    expect(overview).toContain("agents={agents}");
  });

  test("hero leads with the active slice, not the counts", () => {
    const hero = src("web/src/components/RunHeader.tsx");
    expect(overview).toContain("activeId={selected}");
    expect(hero).toContain("omp-hero");
    expect(hero).toContain("heroAction");
    expect(hero).toContain("omp-runline-telemetry");
  });

  test("app auto-selects through the single selection helper", () => {
    expect(app).toContain("preferredSliceId");
    expect(app).toContain("Active slice auto-selection");
  });

  test("inspector never shows the empty giant rectangle and renders every tab", () => {
    expect(inspector).not.toContain("Select a slice in Overview");
    expect(inspector).toContain("ExecutionTrace");
    // All eight tabs wired, including the previously dead Events tab.
    for (const tab of ["OutputView", "DiffView", "VerifyView", "ReviewView", "PromptView", "EventsView", "Usage", "LogView"]) {
      expect(inspector).toContain(tab);
    }
  });

  test("board rows read as execution, not a database table", () => {
    expect(board).toContain("omp-board-row");
    expect(board).toContain("attempt");
    expect(board).not.toContain("<table");
  });

  test("live feed follows the hero slice and streams its worker log", () => {
    const feed = src("web/src/components/LiveFeed.tsx");
    // Same slice the hero leads with: explicit selection, else the slice
    // that needs eyes — never a hardcoded first row.
    expect(feed).toContain("useSliceLog");
    expect(feed).toContain("useSliceLog(runId");
    expect(feed).toContain("omp-livefeed");
    expect(feed).toContain("lastLine");
    // Feed sits front and center: hero, feed, lanes — board below.
    const heroIdx = overview.indexOf("<RunHeader");
    const feedIdx = overview.indexOf("<LiveFeed");
    const lanesIdx = overview.indexOf("<WorkerLanes");
    const boardIdx = overview.indexOf("omp-board-panel");
    expect(heroIdx).toBeGreaterThanOrEqual(0);
    expect(feedIdx).toBeGreaterThan(heroIdx);
    expect(lanesIdx).toBeGreaterThan(feedIdx);
    expect(boardIdx).toBeGreaterThan(lanesIdx);
  });

  test("worker-log polling lives in one shared hook, not two pollers", () => {
    const hook = src("web/src/lib/useSliceLog.ts");
    const logView = src("web/src/components/LogView.tsx");
    expect(hook).toContain("sliceLog");
    expect(hook).toMatch(/setInterval.*2000/s);
    expect(logView).toContain("useSliceLog");
    expect(logView).not.toContain("setInterval");
  });

  test("live feed chrome is fixed-height with an internal log scroll", () => {
    expect(css).toContain(".omp-livefeed");
    expect(css).toMatch(/\.omp-livefeed\s*\{[^}]*flex:\s*none/s);
    expect(css).toMatch(/\.omp-livefeed-log\s*\{[^}]*max-height:\s*\d+px/s);
    expect(css).toMatch(/\.omp-livefeed-log\s*\{[^}]*overflow-y:\s*auto/s);
  });

  test("overview shows operator sessions under the live feed", () => {
    const panel = src("web/src/components/SessionsPanel.tsx");
    expect(overview).toContain("SessionsPanel");
    expect(overview).toContain("sessions={sessions}");
    expect(src("web/src/App.tsx")).toContain("api.sessions");
    expect(panel).toContain("useSessionLog");
    expect(panel).toContain("omp-sessions");
    // Feed first, sessions right after, lanes then board below.
    const feedIdx = overview.indexOf("<LiveFeed");
    const sessIdx = overview.indexOf("<SessionsPanel");
    const lanesIdx = overview.indexOf("<WorkerLanes");
    expect(sessIdx).toBeGreaterThan(feedIdx);
    expect(lanesIdx).toBeGreaterThan(sessIdx);
  });

  test("operator sessions chrome is fixed-height with internal log scroll", () => {
    expect(css).toContain(".omp-sessions");
    expect(css).toMatch(/\.omp-sessions\s*\{[^}]*flex:\s*none/s);
    expect(css).toMatch(/\.omp-session-log\s*\{[^}]*max-height:\s*\d+px/s);
    expect(css).toMatch(/\.omp-session-log\s*\{[^}]*overflow-y:\s*auto/s);
  });

  test("overview imports every component it renders", () => {
    // Regression: dropped Skeleton/preferredSliceId imports shipped a
    // runtime ReferenceError that neither the bundler nor the old
    // tsconfig (which excluded web/) caught.
    for (const name of ["Skeleton", "preferredSliceId", "LiveFeed", "SessionsPanel", "RunHeader", "WorkerLanes", "SliceTable"]) {
      expect(overview).toContain(name);
    }
    expect(overview).toMatch(/import\s*\{[^}]*Skeleton[^}]*\}\s*from/);
    expect(overview).toMatch(/import\s*\{[^}]*preferredSliceId[^}]*\}\s*from/);
  });
 });
