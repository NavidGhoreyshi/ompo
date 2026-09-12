import { expect, test, type Page } from "@playwright/test";

/**
 * Overview as a focused operator workspace: the active worker is the subject,
 * the live window stays compact, history and forensics are one control away,
 * and the page never scrolls.
 */

async function gotoOverview(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("listbox").waitFor();
  await expect(page.locator(".omp-livefeed-log")).toBeVisible();
}

/** Rows in the live window. Leaving rows are mid-exit animation, not content. */
const compactRowCount = (page: Page): Promise<number> =>
  page.locator('.omp-live-row:not([data-motion="leave"])').count();

test.describe("overview focus (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the page itself never scrolls; regions do", async ({ page }) => {
    await gotoOverview(page);
    const doc = await page.evaluate(() => ({
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight,
      bodyScrolls: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
    }));
    expect(doc.sh).toBeLessThanOrEqual(doc.ch + 1);
    expect(doc.bodyScrolls).toBe(0);

    // The workspace column scrolls internally instead (short viewport or
    // expanded activity), never the document.
    await page.getByRole("button", { name: /Activity/ }).click();
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight,
    }));
    expect(after.sh).toBeLessThanOrEqual(after.ch + 1);
  });

  test("the active worker is selected automatically and its output is shown", async ({ page }) => {
    await gotoOverview(page);
    // The run's live slice is the hero subject without any click.
    await expect(page.locator(".omp-hero-id")).toHaveText("longtitle");
    await expect(page.locator(".omp-hero-status")).toContainText("running");
    // Status never rides on color alone: the glyph sits beside the word.
    await expect(page.locator(".omp-hero-glyph svg")).toHaveCount(1);
    const rows = await page.locator('.omp-live-row:not([data-motion="leave"]) .omp-live-text').allTextContents();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.join(" ")).not.toContain("{");
  });

  test("the overview stacks hero, active execution, then the workspace modes", async ({ page }) => {
    await gotoOverview(page);
    const top = (sel: string) => page.locator(sel).evaluate((el) => el.getBoundingClientRect().top);
    const hero = await top(".omp-runline");
    const exec = await top(".omp-exec");
    const modes = await top(".omp-modes");
    expect(hero).toBeLessThan(exec);
    expect(exec).toBeLessThan(modes);
  });

  test("collapsing the rail widens the workspace instead of reserving a hidden drawer", async ({ page }) => {
    await gotoOverview(page);
    const mainWidth = () => page.locator(".omp-main").evaluate((el) => el.getBoundingClientRect().width);
    const before = await mainWidth();
    await page.getByRole("button", { name: "Collapse navigation" }).click();
    await expect(page.locator(".omp-shell")).toHaveAttribute("data-sidebar", "collapsed");
    // Regression: a leftover grid rule once kept a 372px column for the
    // closed inspector, so collapsing the rail shrank the workspace.
    await expect.poll(mainWidth).toBeGreaterThan(before);
    await expect(page.locator(".omp-nav-label").first()).toBeHidden();
  });

  test("the dependency graph appears only in the DAG mode", async ({ page }) => {
    await gotoOverview(page);
    await expect(page.getByRole("region", { name: "Dependency graph" })).toHaveCount(0);
    await page.getByRole("tablist", { name: "Workspace mode" }).getByRole("tab", { name: "DAG" }).click();
    await expect(page.getByRole("region", { name: "Dependency graph" })).toBeVisible();
    await page.getByRole("tablist", { name: "Workspace mode" }).getByRole("tab", { name: "Board" }).click();
    await expect(page.getByRole("region", { name: "Dependency graph" })).toHaveCount(0);
  });

  test("compact window shows about five meaningful rows, never a transcript", async ({ page }) => {
    await gotoOverview(page);
    const compact = await compactRowCount(page);
    expect(compact).toBeLessThanOrEqual(5);
    expect(compact).toBeGreaterThan(0);
    // Raw long lines are trimmed, not spilled.
    const texts = await page.locator('.omp-live-row:not([data-motion="leave"]) .omp-live-text').allTextContents();
    for (const t of texts) expect(t.length).toBeLessThan(220);
  });

  test("expanding reveals the whole worker log, collapsing returns to the window", async ({ page }) => {
    await gotoOverview(page);
    const compact = await compactRowCount(page);
    await page.getByRole("button", { name: "View full log" }).click();
    await expect(page.locator(".omp-livefeed")).toHaveAttribute("data-expanded", "true");
    const expanded = await compactRowCount(page);
    expect(expanded).toBeGreaterThan(compact);

    const scroll = await page.locator(".omp-livefeed-log").evaluate((el) => ({
      sh: el.scrollHeight,
      ch: el.clientHeight,
      top: el.scrollTop,
    }));
    expect(scroll.sh).toBeGreaterThan(scroll.ch); // own scroll path
    expect(scroll.sh - scroll.ch - scroll.top).toBeLessThanOrEqual(2); // pinned to the newest line

    await page.getByRole("button", { name: "Collapse log" }).click();
    await expect(page.locator(".omp-livefeed")).toHaveAttribute("data-expanded", "false");
    expect(await compactRowCount(page)).toBe(compact);
  });

  test("scrolling history stops following; Jump to live restores it", async ({ page }) => {
    await gotoOverview(page);
    await page.getByRole("button", { name: "View full log" }).click();
    await expect(page.locator(".omp-livefeed-log")).toHaveAttribute("data-follow", "true");

    await page.locator(".omp-livefeed-log").evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(page.locator(".omp-livefeed-log")).toHaveAttribute("data-follow", "false");
    const jump = page.getByRole("button", { name: "Jump to live" });
    await expect(jump).toBeVisible();

    await jump.click();
    await expect(page.locator(".omp-livefeed-log")).toHaveAttribute("data-follow", "true");
    await expect(page.getByRole("button", { name: "Jump to live" })).toHaveCount(0);
  });

  test("multiple live workers are switchable and retarget the live log", async ({ page }) => {
    await gotoOverview(page);
    const lanes = page.locator(".omp-lanes--dense .omp-lane");
    await expect(lanes).toHaveCount(3);
    await page.locator('.omp-lanes--dense .omp-lane:has(.omp-lane-slice:text-is("running"))').click();
    await expect(page.locator(".omp-hero-id")).toHaveText("running");
    // The live window retargets to that worker's log (its fixture has two lines,
    // the previously focused worker's has eighty-five).
    await expect(page.locator(".omp-livefeed-log-name")).toContainText("2 lines");
  });

  test("the execution spine shows observed stages only, current one dominant", async ({ page }) => {
    await gotoOverview(page);
    const stages = page.locator(".omp-spine-step");
    await expect(stages).toHaveCount(7);
    await expect(page.locator('.omp-spine-step[data-current="true"]')).toHaveCount(1);
    // The focused slice is running attempt 1: the live phase is Work, not the
    // phase it entered first (Claim/Generation also read as observed).
    await expect(page.locator('.omp-spine-step[data-current="true"] .omp-spine-label')).toHaveText("Work");
    // No phase implies progress it has not observed.
    const pending = page.locator('.omp-spine-step[data-state="pending"]');
    expect(await pending.count()).toBeGreaterThan(0);
  });

  test("activity is compact by default and opens into the searchable stream", async ({ page }) => {
    await gotoOverview(page);
    const bar = page.locator(".omp-activity");
    await expect(bar).toHaveAttribute("data-open", "false");
    await expect(bar).toContainText("events");
    // Filters exist only in the opened view.
    await expect(page.locator(".omp-activity-body")).toHaveCount(0);

    await page.getByRole("button", { name: /Activity/ }).click();
    await expect(bar).toHaveAttribute("data-open", "true");
    await expect(page.getByRole("group", { name: "Filter events by lane" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search events" })).toBeVisible();
    await expect(page.locator(".omp-activity-list li").first()).toBeVisible();

    await page.getByRole("button", { name: /Activity/ }).click();
    await expect(bar).toHaveAttribute("data-open", "false");
  });

  test("the inspector is closed until asked for, and keeps the shared selection", async ({ page }) => {
    await gotoOverview(page);
    const toggle = page.getByRole("button", { name: /Inspector/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".omp-inspector")).toHaveAttribute("aria-hidden", "true");

    await page.getByRole("option", { name: /longreason/ }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".omp-inspector-title")).toContainText("longreason");

    await page.getByRole("button", { name: "Close inspector" }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("board, DAG, and agents modes share one selection", async ({ page }) => {
    await gotoOverview(page);
    await page.getByRole("option", { name: /s-beta/ }).click();
    await expect(page.locator('.omp-board-row[data-selected="true"]')).toContainText("s-beta");
    // Board rows read as workflow entities: state, id, and one meta line.
    await expect(page.locator('.omp-board-row[data-selected="true"] .omp-board-meta')).toContainText("attempt 1");

    await page.getByRole("tablist", { name: "Workspace mode" }).getByRole("tab", { name: "DAG" }).click();
    await expect(page.locator('.omp-dag-node[data-selected="true"]')).toContainText("s-beta");

    await page.getByRole("tablist", { name: "Workspace mode" }).getByRole("tab", { name: "Agents" }).click();
    await expect(page.getByRole("region", { name: "Worker lanes" })).toBeVisible();

    await page.getByRole("tablist", { name: "Workspace mode" }).getByRole("tab", { name: "Board" }).click();
    await expect(page.locator('.omp-board-row[data-selected="true"]')).toContainText("s-beta");
  });
});

test.describe("overview focus (narrow)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("active execution stays on the first screen", async ({ page }) => {
    await gotoOverview(page);
    const box = await page.locator(".omp-exec").boundingBox();
    const liveBox = await page.locator(".omp-livefeed-log").boundingBox();
    expect(box).not.toBeNull();
    expect(liveBox).not.toBeNull();
    // The region starts inside the first viewport and its live window is
    // either visible or reachable by scrolling that one region.
    expect(box!.y).toBeLessThan(844);
    const workspaceScrollable = await page.locator(".omp-workspace").evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(liveBox!.y < 844 || workspaceScrollable).toBe(true);

    const doc = await page.evaluate(() => ({
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight,
    }));
    expect(doc.sh).toBeLessThanOrEqual(doc.ch + 1);

    // Worker switching stays reachable at narrow widths.
    await expect(page.locator(".omp-lanes--dense .omp-lane").first()).toBeVisible();
  });

  test("the inspector becomes an overlay instead of a column", async ({ page }) => {
    await gotoOverview(page);
    await page.getByRole("option", { name: /longtitle/ }).click();
    const pos = await page.locator(".omp-inspector").evaluate((el) => getComputedStyle(el).position);
    expect(pos).toBe("fixed");
    await expect(page.locator(".omp-inspector-title")).toContainText("longtitle");
  });
});
