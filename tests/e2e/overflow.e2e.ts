import { expect, test, type Page } from "@playwright/test";

interface OverflowHit {
  tag: string;
  cls: string;
  text: string;
  overBy: number;
  clippedBy: string;
}

/**
 * Horizontal overflow detector. An element violates when its content is
 * wider than its box, it does not scroll itself, and no intended scroller
 * or ellipsis truncation contains it. Returns one hit per offending box,
 * innermost-first so a single spilling string is reported once.
 */
function collectOverflow(): OverflowHit[] {
  const SKIP_TAGS = new Set([
    "HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "SVG", "G", "PATH", "RECT",
    "TEXT", "CIRCLE", "LINE", "POLYLINE", "POLYGON", "ELLIPSE", "USE",
    "INPUT", "TEXTAREA", "SELECT", "OPTION", "CANVAS", "VIDEO", "IMG",
  ]);
  const SCROLL_OK = ["omp-table-wrap", "omp-code", "omp-dag-scroll", "omp-tabs", "omp-terminal-log", "omp-lanes", "omp-activity-list"];
  const hits: OverflowHit[] = [];
  const seen = new Set<string>();

  const label = (el: Element): string => {
    const c = (el.className && typeof el.className === "string" ? el.className : "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return `${el.tagName.toLowerCase()}${c ? "." + c : ""}`;
  };

  for (const el of document.querySelectorAll("*")) {
    if (!(el instanceof HTMLElement)) continue;
    if (SKIP_TAGS.has(el.tagName)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (cs.overflowX !== "visible") continue;
    const overBy = el.scrollWidth - el.clientWidth;
    if (overBy <= 2) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text) continue;

    // Nearest ancestor that clips or scrolls on x.
    let clip: HTMLElement | null = null;
    let p = el.parentElement;
    while (p) {
      const o = getComputedStyle(p).overflowX;
      if (o === "hidden" || o === "auto" || o === "scroll" || o === "clip") {
        clip = p;
        break;
      }
      p = p.parentElement;
    }
    if (clip) {
      const co = getComputedStyle(clip).overflowX;
      if (co === "auto" || co === "scroll") {
        if (SCROLL_OK.some((c) => clip!.classList.contains(c))) continue;
        hits.push({ tag: el.tagName, cls: label(el), text, overBy, clippedBy: `scroll:${label(clip)}` });
        continue;
      }
      // overflow hidden/clip: intentional only with ellipsis truncation.
      let n: HTMLElement | null = el;
      let ellipsis = false;
      while (n && n !== clip.parentElement) {
        const ns = getComputedStyle(n);
        if (ns.textOverflow === "ellipsis" && ns.whiteSpace === "nowrap") {
          ellipsis = true;
          break;
        }
        n = n.parentElement;
      }
      if (ellipsis) continue;
      hits.push({ tag: el.tagName, cls: label(el), text, overBy, clippedBy: `cut:${label(clip)}` });
    } else {
      hits.push({ tag: el.tagName, cls: label(el), text, overBy, clippedBy: "viewport" });
    }
  }

  // Dedupe: same box shape + text keeps the worst offender.
  const out: OverflowHit[] = [];
  for (const h of hits.sort((a, b) => b.overBy - a.overBy)) {
    const key = `${h.tag}|${h.cls}|${h.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= 40) break;
  }
  return out;
}

function formatHits(hits: OverflowHit[]): string {
  return hits
    .map((h) => `  [${h.clippedBy}] +${Math.round(h.overBy)}px ${h.tag} .${h.cls}\n    "${h.text}"`)
    .join("\n");
}

const CSS_NOISE = /favicon|Declaration dropped|Unknown property|-webkit-text-size-adjust|-moz-osx-font-smoothing/;

async function collectClientErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !CSS_NOISE.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  return errors;
}

async function openView(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name }).click();
}

/** The Inspector is a drawer now: open it (header toggle) before its tabs. */
async function openInspector(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /Inspector/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.getByRole("tablist", { name: "Inspector views" }).waitFor();
}

async function closeInspector(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /Inspector/ });
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
}

async function openInspectorTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tablist", { name: "Inspector views" }).getByRole("tab", { name }).click();
}

async function openMode(page: Page, name: string): Promise<void> {
  await page.getByRole("tablist", { name: "Workspace mode" }).getByRole("tab", { name }).click();
}

async function scan(page: Page, where: string, out: Map<string, OverflowHit[]>): Promise<void> {
  await page.waitForTimeout(150);
  const hits = await page.evaluate(collectOverflow);
  if (hits.length > 0) out.set(where, hits);
}

test.describe("dashboard client health", () => {
  test("boots with real content and zero client errors", async ({ page }) => {
    const errors = await collectClientErrors(page);
    await page.goto("/");
    await expect(page.getByText("ompo dashboard")).toBeVisible();
    await page.getByRole("listbox").waitFor();
    await expect(page.getByRole("option").first()).toBeVisible();
    expect(errors, "client errors on boot").toEqual([]);
  });
});

test.describe("overflow at desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no text escapes its container across views, modes, and inspector tabs", async ({ page }) => {
    const errors = await collectClientErrors(page);
    const hits = new Map<string, OverflowHit[]>();
    await page.goto("/");
    await page.getByRole("listbox").waitFor();

    await scan(page, "overview/board", hits);
    await openMode(page, "DAG");
    await scan(page, "overview/dag", hits);
    await openMode(page, "Agents");
    await scan(page, "overview/agents", hits);
    await openMode(page, "Board");

    // Live window, compact and expanded.
    await page.getByRole("button", { name: "View full log" }).click();
    await scan(page, "overview/live-expanded", hits);
    await page.getByRole("button", { name: "Collapse log" }).click();

    // Inspector over the two stress slices, every tab.
    await page.getByRole("option", { name: /longtitle/ }).click();
    await openInspector(page);
    for (const tab of ["Output", "Diff", "Verify", "Review", "Prompt", "Events", "Usage", "Log"]) {
      await openInspectorTab(page, tab);
      await scan(page, `inspector/longtitle/${tab}`, hits);
    }
    await closeInspector(page);
    await page.getByRole("option", { name: /longreason/ }).click();
    await openInspector(page);
    await openInspectorTab(page, "Output");
    await scan(page, "inspector/longreason/Output", hits);
    await closeInspector(page);

    // Activity expanded over the same run.
    await page.getByRole("button", { name: /Activity/ }).click();
    await scan(page, "overview/activity-expanded", hits);
    await page.getByRole("button", { name: /Activity/ }).click();

    for (const view of ["Runs", "Roadmap", "Agents", "Stats"]) {
      await openView(page, view);
      await scan(page, `page/${view}`, hits);
    }

    expect(errors, "client errors during walkthrough").toEqual([]);
    expect(hits.size, hits.size > 0 ? `overflow:\n${[...hits].map(([w, h]) => `${w}:\n${formatHits(h)}`).join("\n")}` : "clean").toBe(0);
  });
});

test.describe("overflow at narrow width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("stacked shell still contains its text", async ({ page }) => {
    const hits = new Map<string, OverflowHit[]>();
    await page.goto("/");
    await page.getByRole("listbox").waitFor();
    await scan(page, "narrow/overview", hits);
    await openMode(page, "Agents");
    await scan(page, "narrow/agents", hits);
    await openMode(page, "Board");
    await page.getByRole("option", { name: /longtitle/ }).click();
    await openInspector(page);
    await openInspectorTab(page, "Output");
    await scan(page, "narrow/inspector", hits);
    await closeInspector(page);
    await openView(page, "Runs");
    await scan(page, "narrow/runs", hits);
    expect(hits.size, hits.size > 0 ? `overflow:\n${[...hits].map(([w, h]) => `${w}:\n${formatHits(h)}`).join("\n")}` : "clean").toBe(0);
  });
});
