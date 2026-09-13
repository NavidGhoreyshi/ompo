/**
 * Deck launcher (roadmap slice `d11`): the pure `deckLaunchPlan` browser
 * preference order and the handshake reader the launcher shares with any
 * future shell.
 *
 * No process is spawned here — the CLI-level contract (`--no-open
 * --print-url` → exactly one stdout line) lives in `tests/release-gate.test.ts`,
 * and this file owns the decisions: which browser, which args, and what a
 * bounded read does when the line never comes.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { cliCommand, deckAppUrl, deckLaunchPlan, readUrlLine } from "../scripts/deck-open.ts";

const URL = "http://127.0.0.1:41237";
const APP_URL = `${URL}/?surface=deck`;
const APP_ARGS = [`--app=${APP_URL}`, "--window-size=1600,1000"];

/** An existence probe that answers yes for exactly the listed paths. */
function only(...paths: string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

describe("deckAppUrl", () => {
  test("appends the deck surface after the server URL", () => {
    expect(deckAppUrl(URL)).toBe(APP_URL);
    // A trailing slash must not double up — the server URL never carries one,
    // but an operator-pasted one might.
    expect(deckAppUrl(`${URL}/`)).toBe(APP_URL);
    expect(deckAppUrl(`${URL}//`)).toBe(APP_URL);
  });
});

describe("deckLaunchPlan", () => {
  test("$OMPO_DECK_BROWSER wins when it resolves", () => {
    const plan = deckLaunchPlan({
      url: URL,
      env: { OMPO_DECK_BROWSER: "/usr/bin/chromium", PATH: "/usr/bin" },
      platform: "linux",
      exists: only("/usr/bin/chromium"),
    });
    expect(plan).toEqual({ cmd: "/usr/bin/chromium", args: APP_ARGS, appWindow: true });
  });

  test("$OMPO_DECK_BROWSER resolves through PATH when it is a bare command name", () => {
    const plan = deckLaunchPlan({
      url: URL,
      env: { OMPO_DECK_BROWSER: "google-chrome", PATH: "/usr/local/bin:/usr/bin" },
      platform: "linux",
      exists: only("/usr/local/bin/google-chrome"),
    });
    expect(plan?.cmd).toBe("/usr/local/bin/google-chrome");
    expect(plan?.appWindow).toBe(true);
  });

  test("a non-Chromium override opens a normal tab instead of faking --app support", () => {
    const plan = deckLaunchPlan({
      url: URL,
      env: { OMPO_DECK_BROWSER: "/usr/bin/firefox", PATH: "/usr/bin" },
      platform: "linux",
      exists: only("/usr/bin/firefox"),
    });
    expect(plan).toEqual({ cmd: "/usr/bin/firefox", args: [APP_URL], appWindow: false });
  });

  test("an override that does not exist falls through to the ordered list", () => {
    const plan = deckLaunchPlan({
      url: URL,
      env: { OMPO_DECK_BROWSER: "/opt/gone/chrome", PATH: "/usr/bin" },
      platform: "linux",
      exists: only("/usr/bin/chromium"),
    });
    expect(plan?.cmd).toBe("/usr/bin/chromium");
  });

  test("linux prefers the earlier Chromium-family names", () => {
    const plan = deckLaunchPlan({
      url: URL,
      env: { PATH: "/usr/bin" },
      platform: "linux",
      exists: only("/usr/bin/google-chrome", "/usr/bin/chromium"),
    });
    expect(plan?.cmd).toBe("/usr/bin/google-chrome");
  });

  test("linux falls back to Windows Edge through the WSL interop mount", () => {
    const edge = "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
    const plan = deckLaunchPlan({
      url: URL,
      env: { PATH: "/usr/bin" },
      platform: "linux",
      exists: only(edge),
    });
    expect(plan).toEqual({ cmd: edge, args: APP_ARGS, appWindow: true });
  });

  test("darwin prefers the Chrome bundle, then falls back to `open`", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const bundle = deckLaunchPlan({
      url: URL,
      env: {},
      platform: "darwin",
      exists: only(chrome, "/usr/bin/open"),
    });
    expect(bundle).toEqual({ cmd: chrome, args: APP_ARGS, appWindow: true });

    const tab = deckLaunchPlan({ url: URL, env: {}, platform: "darwin", exists: only("/usr/bin/open") });
    expect(tab).toEqual({ cmd: "/usr/bin/open", args: [APP_URL], appWindow: false });
  });

  test("win32 prefers Edge, then falls back to `cmd start`", () => {
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const browser = deckLaunchPlan({ url: URL, env: {}, platform: "win32", exists: only(edge) });
    expect(browser).toEqual({ cmd: edge, args: APP_ARGS, appWindow: true });

    const cmd = "C:\\Windows\\System32\\cmd.exe";
    const tab = deckLaunchPlan({ url: URL, env: {}, platform: "win32", exists: only(cmd) });
    // `start` reads the first quoted argument as the window title.
    expect(tab).toEqual({ cmd, args: ["/c", "start", "", APP_URL], appWindow: false });
  });

  test("the opener is the last resort and never claims an app window", () => {
    const plan = deckLaunchPlan({
      url: URL,
      env: { PATH: "/usr/bin" },
      platform: "linux",
      exists: only("/usr/bin/xdg-open"),
    });
    expect(plan).toEqual({ cmd: "/usr/bin/xdg-open", args: [APP_URL], appWindow: false });
  });

  test("nothing found is null — the launcher prints the URL and exits 1", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      expect(deckLaunchPlan({ url: URL, env: { PATH: "/usr/bin" }, platform, exists: () => false })).toBeNull();
    }
  });

  test("every plan's cmd is absolute, with the platform's app-window args", () => {
    const every = () => true;
    for (const platform of ["linux", "darwin", "win32"]) {
      const plan = deckLaunchPlan({ url: URL, env: { PATH: "/usr/bin" }, platform, exists: every });
      expect(plan).not.toBeNull();
      // Windows paths are checked with the win32 flavour — this test runs on linux.
      const absolute = platform === "win32" ? win32.isAbsolute(plan!.cmd) : isAbsolute(plan!.cmd);
      expect(absolute).toBe(true);
      expect(plan!.args).toContain(`--app=${APP_URL}`);
      expect(plan!.appWindow).toBe(true);
    }
  });
});

describe("cliCommand", () => {
  test("a source run re-invokes bun on src/cli.ts (the resumeCommand mirror)", () => {
    const cmd = cliCommand();
    expect(cmd[0]).toBe(process.execPath);
    const base = process.execPath.split("/").pop() ?? "";
    // `bun test` always runs the bun runtime; the compiled-binary branch
    // (a single argv element) is exercised by the release gate instead.
    expect(base === "bun" || base.startsWith("bun-")).toBe(true);
    expect(cmd[1]).toBe(join(import.meta.dir, "..", "src", "cli.ts"));
    expect(existsSync(cmd[1]!)).toBe(true);
  });
});

describe("readUrlLine", () => {
  const encoder = new TextEncoder();

  function streamFrom(chunks: string[], close = true): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
        else if (close) controller.close();
      },
    });
  }

  test("returns the url= line and ignores everything around it", async () => {
    const stream = streamFrom(["ompo dashboard: http://127.0.0.1:1/\n", "url=http://127.0.0.1:41237\n", "press Ctrl-C to stop\n"]);
    expect(await readUrlLine(stream, 1_000)).toBe(URL);
  });

  test("a line split across chunks is still one line", async () => {
    const stream = streamFrom(["url=http://127.0.", "0.1:41237\n"]);
    expect(await readUrlLine(stream, 1_000)).toBe("http://127.0.0.1:41237");
  });

  test("bounded: no line within the budget rejects", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    await expect(readUrlLine(stalled, 30)).rejects.toThrow(/no url= line within 30 ms/);
  });

  test("EOF before the line rejects with the reason", async () => {
    await expect(readUrlLine(streamFrom(["nothing useful\n"]), 1_000)).rejects.toThrow(/closed stdout before printing a url/);
  });
});
