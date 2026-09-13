#!/usr/bin/env bun
/**
 * Deck launcher (roadmap slice `d11`).
 *
 * `bun scripts/deck-open.ts` is the desktop story with no desktop toolchain:
 * it starts the dashboard with `--no-open --print-url`, reads the one
 * machine-readable line that handshake prints, and opens `<url>/?surface=deck`
 * in a chrome-less app window (a normal tab when only an opener is available).
 * Ctrl-C stops the dashboard; the launcher owns the child process on every
 * exit path, so it never leaves an `ompo` server behind.
 *
 * The browser choice is a pure function (`deckLaunchPlan`) over the
 * environment plus an injected existence probe, so the preference order —
 * `$OMPO_DECK_BROWSER`, a Chromium-family binary, Windows Edge via WSL
 * interop, then the platform opener — is unit-tested instead of assumed.
 * The child contract is the same one the shell (`d12`) will consume:
 * `ompo --no-open --print-url` → exactly one stdout line `url=<url>`.
 *
 * Usage:
 *   bun scripts/deck-open.ts                          # from the repo
 *   OMPO_DECK_BROWSER=/usr/bin/brave-browser bun scripts/deck-open.ts
 *   ompo --no-open --print-url                        # the handshake alone
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

// ---- the launch plan (pure) ----

export interface DeckLaunchPlan {
  /** Absolute path to the executable to spawn. */
  cmd: string;
  /** argv after `cmd`. */
  args: string[];
  /** True when the plan opens a chrome-less app window (`--app=<url>`). */
  appWindow: boolean;
}

export interface DeckLaunchInput {
  /** The dashboard URL from the `url=` handshake line. */
  url: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Existence probe (`fs.existsSync` by default) — injected so the order is testable. */
  exists?: (path: string) => boolean;
}

/** Chromium-family browsers accept `--app=`; anything else opens a plain tab. */
const APP_WINDOW_RE = /(chrome|chromium|msedge|brave|vivaldi|opera)/i;

const MAC_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const WINDOWS_BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** The same binaries seen from WSL (`d11` runs on this box; Edge is the Windows 10/11 default). */
const WSL_WINDOWS_BROWSERS = [
  "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

const LINUX_BROWSER_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"];
const LINUX_BROWSER_PATHS = ["/opt/google/chrome/google-chrome", "/snap/bin/chromium"];
const WINDOWS_CMD = "C:\\Windows\\System32\\cmd.exe";

/** `<url>/?surface=deck` — the deck surface the shell opens (`App.tsx` reads `?surface=`). */
export function deckAppUrl(url: string): string {
  return `${url.replace(/\/+$/, "")}/?surface=deck`;
}

/**
 * Pick a browser for `url`, or `null` when nothing on this machine can be
 * found (the launcher then prints the URL and the manual command, exit 1).
 *
 * Order: `$OMPO_DECK_BROWSER` (path or PATH command name), the platform's
 * Chromium-family binaries, Windows Edge/Chrome through WSL interop, then
 * the platform opener (`xdg-open` / `open` / `cmd start`) as a normal tab.
 * Every plan's `cmd` is absolute.
 */
export function deckLaunchPlan(input: DeckLaunchInput): DeckLaunchPlan | null {
  const env = input.env ?? {};
  const platform = input.platform ?? process.platform;
  const exists = input.exists ?? existsSync;
  const appUrl = deckAppUrl(input.url);

  const override = (env["OMPO_DECK_BROWSER"] ?? "").trim();
  if (override) {
    const resolved = lookup(override, env, platform, exists);
    if (resolved) return browserPlan(resolved, appUrl);
  }
  const browser = chromiumCandidates(platform, env, exists)[0];
  if (browser) return browserPlan(browser, appUrl);
  return openerPlan(platform, env, exists, appUrl);
}

/** App-window args for a Chromium-family binary, a plain URL for anything else. */
function browserPlan(cmd: string, appUrl: string): DeckLaunchPlan {
  const appWindow = APP_WINDOW_RE.test(basename(cmd));
  return appWindow ? { cmd, args: [`--app=${appUrl}`, "--window-size=1600,1000"], appWindow } : { cmd, args: [appUrl], appWindow };
}

function chromiumCandidates(platform: string, env: Record<string, string | undefined>, exists: (path: string) => boolean): string[] {
  if (platform === "darwin") return MAC_BROWSERS.filter(exists);
  if (platform === "win32") return WINDOWS_BROWSERS.filter(exists);
  const found: string[] = [];
  for (const name of LINUX_BROWSER_NAMES) {
    const path = lookup(name, env, platform, exists);
    if (path) found.push(path);
  }
  for (const path of LINUX_BROWSER_PATHS) if (exists(path)) found.push(path);
  for (const path of WSL_WINDOWS_BROWSERS) if (exists(path)) found.push(path);
  return [...new Set(found)];
}

function openerPlan(
  platform: string,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
  appUrl: string,
): DeckLaunchPlan | null {
  if (platform === "darwin") {
    const cmd = exists("/usr/bin/open") ? "/usr/bin/open" : lookup("open", env, platform, exists);
    return cmd ? { cmd, args: [appUrl], appWindow: false } : null;
  }
  if (platform === "win32") {
    const cmd = exists(WINDOWS_CMD) ? WINDOWS_CMD : lookup("cmd.exe", env, platform, exists);
    // `start` treats the first quoted argument as a window title.
    return cmd ? { cmd, args: ["/c", "start", "", appUrl], appWindow: false } : null;
  }
  const cmd = exists("/usr/bin/xdg-open") ? "/usr/bin/xdg-open" : lookup("xdg-open", env, platform, exists);
  return cmd ? { cmd, args: [appUrl], appWindow: false } : null;
}

/** Resolve a command name through `PATH` (absolute dirs only) or probe an absolute path. */
function lookup(name: string, env: Record<string, string | undefined>, platform: string, exists: (path: string) => boolean): string | null {
  const raw = name.trim();
  if (!raw) return null;
  if (isAbsolute(raw)) return exists(raw) ? raw : null;
  if (raw.includes("/") || raw.includes("\\")) return exists(raw) ? raw : null;
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of (env["PATH"] ?? "").split(sep)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, raw);
    if (exists(candidate)) return candidate;
  }
  return null;
}

// ---- the launcher (process) ----

/** The handshake's stdout budget: the server binds in well under a second. */
export const URL_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 5_000;
const URL_LINE = /^url=(http:\/\/\S+)$/;

type DashboardChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

/**
 * Self relaunch, mirroring `resumeCommand()` (src/server.ts): the compiled
 * binary re-executes itself, a source run re-invokes bun on `src/cli.ts`.
 */
export function cliCommand(): string[] {
  const exe = process.execPath;
  const base = exe.split("/").pop() ?? "";
  if (base === "bun" || base.startsWith("bun-")) return [exe, join(import.meta.dir, "..", "src", "cli.ts")];
  return [exe];
}

/** Read the first `url=` line from the handshake, bounded by `timeoutMs`. */
export async function readUrlLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`the dashboard printed no url= line within ${timeoutMs} ms`);
      const chunk = await raceTimeout(reader.read(), remaining, `the dashboard printed no url= line within ${timeoutMs} ms`);
      if (chunk.done) throw new Error("the dashboard closed stdout before printing a url");
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = URL_LINE.exec(line.trim());
        if (match) return match[1]!;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function raceTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolve `promise` (or `fallback` after `ms`), never rejecting. */
function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** SIGTERM, a bounded grace, then SIGKILL — the launcher must not orphan the server. */
async function stopChild(child: DashboardChild, graceMs = STOP_GRACE_MS): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* raced exit */
  }
  if (await settleWithin(child.exited.then(() => true), graceMs, false)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* raced exit */
  }
  await settleWithin(child.exited.then(() => true), 2_000, false);
}

/** Keep stderr flowing (the child must never block on a full pipe) and remembered (failure tails). */
function drainInto(stream: ReadableStream<Uint8Array> | null, sink: (text: string) => void): void {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sink(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* the child died; the tail already collected is what the failure path reports */
    }
  })();
}

function tailLines(text: string, count: number): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join("\n");
}

async function main(): Promise<number> {
  const child = Bun.spawn([...cliCommand(), "--no-open", "--print-url"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let childErr = "";
  drainInto(child.stderr, (text) => {
    childErr += text;
  });

  // Ctrl-C stops the dashboard the launcher started; the window is not ours
  // to close (see the launch-note in the README).
  let interrupted = false;
  const onSignal = (): void => {
    if (interrupted) return;
    interrupted = true;
    void stopChild(child).then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let url: string;
  try {
    url = await readUrlLine(child.stdout, URL_TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await stopChild(child);
    if (interrupted) return 0;
    process.stderr.write(`deck-open: ${message}\n`);
    if (child.exitCode !== null) process.stderr.write(`deck-open: ompo exited with code ${child.exitCode}\n`);
    const tail = tailLines(childErr, 10);
    if (tail) process.stderr.write(`deck-open: ompo stderr:\n${tail}\n`);
    process.stderr.write("deck-open: run the handshake yourself: ompo --no-open --print-url\n");
    return 1;
  }

  const appUrl = deckAppUrl(url);
  const plan = deckLaunchPlan({ url, env: process.env, platform: process.platform });
  if (!plan) {
    process.stderr.write(`deck-open: no Chromium-family browser and no opener found\n`);
    process.stderr.write(`deck-open: open ${appUrl} yourself, or set OMPO_DECK_BROWSER to a browser path\n`);
    await stopChild(child);
    return 1;
  }

  process.stdout.write(`deck-open: ${appUrl}\n`);
  if (!plan.appWindow) process.stdout.write(`deck-open: ${plan.cmd} opens a normal tab (no app-window support)\n`);
  process.stdout.write("deck-open: stop: Ctrl-C\n");
  try {
    const browser = Bun.spawn([plan.cmd, ...plan.args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    browser.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`deck-open: could not start ${plan.cmd}: ${message}\n`);
    process.stderr.write(`deck-open: open ${appUrl} yourself, or set OMPO_DECK_BROWSER to a browser path\n`);
    await stopChild(child);
    return 1;
  }

  const code = await child.exited;
  if (!interrupted) {
    process.stderr.write(`deck-open: the dashboard exited (code ${code}) — the window stays open\n`);
    return code;
  }
  return 0;
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
