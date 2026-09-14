#!/usr/bin/env bun
/**
 * Deck desktop prerequisite guard (roadmap slice `d12`).
 *
 * `bun run deck:desktop:dev` / `deck:desktop:build` route through here so a
 * missing Rust toolchain fails with actionable instructions instead of a
 * cryptic spawn error — and nothing ever attempts an unattended toolchain
 * install. Exits 1 after printing what is missing and how to get it.
 *
 * Usage:
 *   bun scripts/deck-desktop-run.ts dev    # bunx tauri dev (cwd=desktop)
 *   bun scripts/deck-desktop-run.ts build  # bunx tauri build (cwd=desktop)
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "build") {
  process.stderr.write("deck-desktop-run: usage: bun scripts/deck-desktop-run.ts <dev|build>\n");
  process.exit(1);
}

const missing: string[] = [];
const have = (name: string): boolean => {
  const found = spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
  if (!found) missing.push(name);
  return found;
};
const haveRustc = have("rustc");
const haveCargo = have("cargo");
have("tauri");

if (!existsSync(join(import.meta.dir, "..", "desktop", "src-tauri", "tauri.conf.json"))) {
  process.stderr.write("deck-desktop-run: desktop/src-tauri/tauri.conf.json is missing — is the d12 shell checked out?\n");
  process.exit(1);
}

if (!haveRustc || !haveCargo) {
  process.stderr.write(
    "deck-desktop-run: the Rust toolchain is not installed (missing: " +
      missing.filter((name) => name === "rustc" || name === "cargo").join(", ") +
      ").\n" +
      "  Install it from https://rustup.rs, then re-run this command.\n" +
      "  On Linux you also need WebKitGTK: libwebkit2gtk-4.1-dev (Debian/Ubuntu).\n" +
      "  Under WSLg the webview is software-rendered — prefer the browser launcher:\n" +
      "    bun scripts/deck-open.ts\n",
  );
  process.exit(1);
}

if (process.platform === "linux" && !existsSync("/usr/include/webkitgtk-4.1") && !existsSync("/usr/include/webkitgtk-6.0")) {
  process.stderr.write(
    "deck-desktop-run: WebKitGTK headers not found (/usr/include/webkitgtk-4.1 or -6.0).\n" +
      "  Install libwebkit2gtk-4.1-dev (Debian/Ubuntu), then re-run this command.\n" +
      "  Under WSLg the webview is software-rendered — prefer the browser launcher:\n" +
      "    bun scripts/deck-open.ts\n",
  );
  process.exit(1);
}

const child = spawnSync("bunx", ["tauri", mode], {
  cwd: join(import.meta.dir, "..", "desktop"),
  stdio: "inherit",
});
process.exit(child.status ?? 1);
