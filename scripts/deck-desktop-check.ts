#!/usr/bin/env bun
/**
 * Deck desktop static verifier (roadmap slice `d12`).
 *
 * Tauri needs a Rust toolchain plus WebKitGTK to build on Linux — neither
 * exists in this environment, and the roadmap's Windows acceptance cannot run
 * here either. So this script verifies what is verifiable without Rust: it
 * parses the committed Tauri config, capabilities and `main.rs` and asserts
 * the packaging contract, exiting 1 with a specific message per violation.
 *
 * Checks:
 *   1. `desktop/src-tauri/tauri.conf.json` parses: one window (`main`,
 *      1600×1000, min 900×600, initially hidden — the shell shows it only
 *      after the sidecar handshake), no dev-only `devUrl` dependence for the
 *      deck URL, sidecar wiring present (`bundle.externalBin` names
 *      `binaries/ompo`), no bundled SPA copy (`bundle.resources` empty, no
 *      `frontendDist` directory pointing at `web/dist`), and the config
 *      version matches the repo `package.json`.
 *   2. `desktop/src-tauri/capabilities/default.json` parses: the permission
 *      allow-list is exactly `core:default` + `shell:allow-spawn/kill/
 *      stdin-write` scoped to the sidecar — no `fs`/`http`/`dialog`/
 *      `notification`/`updater`/`opener` entries anywhere.
 *   3. `desktop/src-tauri/src/main.rs` contains the `--print-url` contract
 *      (the sidecar URL comes from the child's stdout), the deck-surface join
 *      (`?surface=deck`), the sidecar kill paths (window close + app exit +
 *      `Drop`), and no `.omp/` path handling, no `/api/` fetches, no
 *      `#[tauri::command]` (zero data-bearing commands).
 *   4. `desktop/src-tauri/Cargo.toml` parses as TOML-ish text: depends on
 *      `tauri` 2 + `tauri-plugin-shell`, nothing else load-bearing (no `fs`,
 *      `http`, `dialog`, `notification`, `updater` plugins).
 *
 * Usage:
 *   bun scripts/deck-desktop-check.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TAURI_DIR = join(ROOT, "desktop", "src-tauri");
const CONF_PATH = join(TAURI_DIR, "tauri.conf.json");
const CAPS_PATH = join(TAURI_DIR, "capabilities", "default.json");
const MAIN_PATH = join(TAURI_DIR, "src", "main.rs");
const CARGO_PATH = join(TAURI_DIR, "Cargo.toml");

const failures: string[] = [];
function recordFailure(message: string): void {
  failures.push(message);
}

function readJson(path: string, label: string): unknown | null {
  if (!existsSync(path)) {
    recordFailure(`missing ${label}: ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    recordFailure(`${label} does not parse as JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function readText(path: string, label: string): string | null {
  if (!existsSync(path)) {
    recordFailure(`missing ${label}: ${path}`);
    return null;
  }
  return readFileSync(path, "utf8");
}

// ---- 1. tauri.conf.json ----
const conf = readJson(CONF_PATH, "tauri.conf.json") as Record<string, unknown> | null;
if (conf) {
  const app = (conf.app ?? {}) as Record<string, unknown>;
  const windows = app.windows as { label?: string; width?: number; height?: number; minWidth?: number; minHeight?: number; visible?: boolean }[] | undefined;
  if (!Array.isArray(windows) || windows.length !== 1) {
    recordFailure(`tauri.conf.json: expected exactly one window, found ${Array.isArray(windows) ? windows.length : "none"}`);
  } else {
    const [main] = windows as [{ label?: string; width?: number; height?: number; minWidth?: number; minHeight?: number; visible?: boolean }];
    if (main.label !== "main") recordFailure(`tauri.conf.json: window label must be "main", found ${JSON.stringify(main.label)}`);
    if (main.width !== 1600 || main.height !== 1000) {
      recordFailure(`tauri.conf.json: window must be 1600x1000, found ${main.width}x${main.height}`);
    }
    if (main.minWidth !== 900 || main.minHeight !== 600) {
      recordFailure(`tauri.conf.json: window minimum must be 900x600, found ${main.minWidth}x${main.minHeight}`);
    }
    if (main.visible !== false) {
      recordFailure("tauri.conf.json: the window must start hidden (visible: false) — shown only after the sidecar handshake");
    }
  }

  const bundle = (conf.bundle ?? {}) as Record<string, unknown>;
  const externalBin = bundle.externalBin as string[] | undefined;
  if (!Array.isArray(externalBin) || !externalBin.some((entry) => entry.replace(/\\/g, "/").includes("binaries/ompo"))) {
    recordFailure("tauri.conf.json: bundle.externalBin must declare the bundled ompo sidecar (binaries/ompo)");
  }
  const resources = bundle.resources as unknown;
  const resourcesEmpty =
    resources === undefined ||
    (Array.isArray(resources) && resources.length === 0) ||
    (typeof resources === "object" && resources !== null && Object.keys(resources).length === 0);
  if (!resourcesEmpty) {
    recordFailure("tauri.conf.json: bundle.resources must stay empty — the shell bundles no copy of the SPA");
  }
  const build = (conf.build ?? {}) as Record<string, unknown>;
  const frontendDist = typeof build.frontendDist === "string" ? build.frontendDist : "";
  if (frontendDist.includes("web/dist") || frontendDist.includes("web\\dist")) {
    recordFailure("tauri.conf.json: frontendDist must not embed web/dist — the webview loads the server's own assets");
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
  if (typeof conf.version === "string" && typeof pkg.version === "string" && conf.version !== pkg.version) {
    recordFailure(`tauri.conf.json: version ${conf.version} drifts from package.json ${pkg.version}`);
  }
}

// ---- 2. capabilities/default.json ----
const caps = readJson(CAPS_PATH, "capabilities/default.json") as {
  windows?: string[];
  permissions?: (string | { identifier?: string; allow?: { name?: string; cmd?: string; sidecar?: boolean }[] })[];
} | null;
if (caps) {
  if (JSON.stringify(caps.windows) !== JSON.stringify(["main"])) {
    recordFailure(`capabilities/default.json: windows must be exactly ["main"], found ${JSON.stringify(caps.windows)}`);
  }
  const identifiers = (caps.permissions ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.identifier ?? "",
  );
  const allowed: Record<string, true> = {
    "core:default": true,
    "shell:allow-spawn": true,
    "shell:allow-kill": true,
    "shell:allow-stdin-write": true,
  };
  for (const id of identifiers) {
    if (!allowed[id]) {
      recordFailure(`capabilities/default.json: unexpected permission ${JSON.stringify(id)} — the shell allows core + sidecar spawn/kill/stdin-write only`);
    }
  }
  for (const want of Object.keys(allowed)) {
    if (!identifiers.includes(want)) recordFailure(`capabilities/default.json: missing required permission ${want}`);
  }
  const raw = readFileSync(CAPS_PATH, "utf8").toLowerCase();
  for (const forbidden of ['"fs:', '"http:', '"dialog:', '"notification:', '"updater:', '"opener:', "fs:", "http:", "dialog"]) {
    if (raw.includes(forbidden) && !raw.includes('"identifier"')) {
      recordFailure(`capabilities/default.json: must not reference ${forbidden} permissions`);
      break;
    }
  }
  // Every scoped entry must name the sidecar and nothing else.
  for (const entry of caps.permissions ?? []) {
    if (typeof entry === "string") continue;
    for (const scope of entry.allow ?? []) {
      const names = [scope.name, scope.cmd].filter(Boolean).join(" ");
      if (!names.includes("binaries/ompo")) {
        recordFailure(`capabilities/default.json: ${entry.identifier} scope must name the ompo sidecar only, found ${JSON.stringify(scope)}`);
      }
      if (scope.sidecar !== true) {
        recordFailure(`capabilities/default.json: ${entry.identifier} scope must set sidecar: true (${JSON.stringify(scope)})`);
      }
    }
  }
}

// ---- 3. src/main.rs ----
const main = readText(MAIN_PATH, "src/main.rs");
if (main) {
  const src = main.split("\n#[cfg(test)]")[0] ?? main;
  const mustContain: [string, string][] = [
    ["--print-url", "the sidecar must be spawned with the d11 --print-url handshake"],
    ["WebviewUrl::External", "the deck URL must come from the sidecar (WebviewUrl::External), never a bundled page"],
    ["WebviewWindowBuilder", "the shell must build its window with WebviewWindowBuilder"],
    ["?surface=deck", "the webview must load the deck surface (?surface=deck)"],
    ["CloseRequested", "window close must reap the sidecar"],
    ["RunEvent::Exit", "app exit must reap the sidecar"],
    ["impl Drop for DeckState", "a Drop guard must reap the sidecar on panic paths"],
    ["current_dir", "the sidecar must run with the project directory as cwd"],
    ["OMPO_PROJECT", "the project directory must be overridable via OMPO_PROJECT"],
    ["SIDECAR_NAME", "the spawned binary must be the configured sidecar"],
    [".sidecar(", "the sidecar must be spawned through the shell plugin"],
  ];
  for (const [needle, why] of mustContain) {
    if (!src.includes(needle)) recordFailure(`src/main.rs: missing ${JSON.stringify(needle)} — ${why}`);
  }
  const mustNotContain: [string, string][] = [
    ["events.jsonl", "the shell must never read the event log"],
    ["fetch(", "the shell must never fetch the API"],
    ["EventSource", "the shell must never open a transport"],
    ["WebSocket", "the shell must never open a transport"],
  ];
  for (const [needle, why] of mustNotContain) {
    if (src.includes(needle)) recordFailure(`src/main.rs: forbidden ${JSON.stringify(needle)} — ${why}`);
  }
  for (const line of src.split("\n")) {
    const code = line.split("//")[0] ?? "";
    if (code.includes(".omp/")) recordFailure(`src/main.rs: forbidden ".omp/" — the shell must never read the store`);
    if (code.includes("/api/")) recordFailure(`src/main.rs: forbidden "/api/" — the shell must never fetch the API`);
    if (code.includes("#[tauri::command]")) recordFailure(`src/main.rs: forbidden "#[tauri::command]" — packaging only: zero Tauri commands`);
    if (code.includes("invoke_handler")) recordFailure(`src/main.rs: forbidden "invoke_handler" — packaging only: no invoke handler`);
  }
}

// ---- 4. Cargo.toml ----
const cargo = readText(CARGO_PATH, "Cargo.toml");
if (cargo) {
  for (const dep of ['tauri = { version = "2"', "tauri-plugin-shell"]) {
    if (!cargo.includes(dep)) recordFailure(`Cargo.toml: missing required dependency ${dep}`);
  }
  for (const plugin of ["tauri-plugin-fs", "tauri-plugin-http", "tauri-plugin-dialog", "tauri-plugin-notification", "tauri-plugin-updater", "tauri-plugin-opener", "tauri-plugin-single-instance", "tauri-plugin-autostart"]) {
    if (cargo.includes(plugin)) recordFailure(`Cargo.toml: forbidden plugin ${plugin} — minimal capability surface only`);
  }
}

if (failures.length > 0) {
  for (const message of failures) process.stderr.write(`deck-desktop-check: ${message}\n`);
  process.exit(1);
}
process.stdout.write("deck-desktop-check: ok\n");
