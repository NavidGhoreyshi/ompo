/**
 * Deck desktop shell (roadmap slice `d12`): the packaging contract, verifiable
 * without Rust.
 *
 * The verifier (`scripts/deck-desktop-check.ts`) owns the assertions; this
 * file owns the invocation plus the repo-level locks the slice promises:
 * the check passes, the shell stays off the critical path (`deck-open` needs
 * no Rust), and the Tauri surface stays minimal. Real window behaviour
 * (launch, deck URL, close-cleanup) is a Windows-manual step the slice
 * review records — nothing here pretends to open a webview.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CHECK = join(ROOT, "scripts", "deck-desktop-check.ts");

describe("deck desktop shell (roadmap d12)", () => {
  test("deck:desktop:check exits 0 on the committed configuration", () => {
    const run = spawnSync("bun", [CHECK], { encoding: "utf8" });
    expect(`stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toContain("deck-desktop-check: ok");
    expect(run.status).toBe(0);
  });

  test("the shell declares no bundled copy of the SPA", () => {
    const conf = JSON.parse(readFileSync(join(ROOT, "desktop", "src-tauri", "tauri.conf.json"), "utf8")) as {
      build?: { frontendDist?: unknown };
      bundle?: { externalBin?: unknown; resources?: unknown };
    };
    expect(JSON.stringify(conf.bundle?.resources ?? {})).toBe("{}");
    expect(String(conf.build?.frontendDist ?? "")).not.toContain("web/dist");
    expect(JSON.stringify(conf.bundle?.externalBin ?? [])).toContain("binaries/ompo");
  });

  test("the capability surface is core + sidecar spawn/kill/stdin-write only", () => {
    const caps = JSON.parse(
      readFileSync(join(ROOT, "desktop", "src-tauri", "capabilities", "default.json"), "utf8"),
    ) as { permissions?: (string | { identifier?: string })[] };
    const identifiers = (caps.permissions ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.identifier,
    );
    expect([...identifiers].sort()).toEqual(
      ["core:default", "shell:allow-kill", "shell:allow-spawn", "shell:allow-stdin-write"].sort(),
    );
  });

  test("deck-open stays toolchain-free: no Rust, no tauri import", () => {
    const launcher = readFileSync(join(ROOT, "scripts", "deck-open.ts"), "utf8");
    expect(launcher).not.toContain("tauri");
    expect(launcher).not.toContain("rustc");
    expect(launcher).not.toContain("cargo");
  });

  test("package.json wires the three deck:desktop scripts", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["deck:desktop:check"]).toBe("bun scripts/deck-desktop-check.ts");
    expect(pkg.scripts?.["deck:desktop:dev"]).toBe("bun scripts/deck-desktop-run.ts dev");
    expect(pkg.scripts?.["deck:desktop:build"]).toBe("bun scripts/deck-desktop-run.ts build");
  });

  test("the prereq guard fails with instructions, never an install", () => {
    const guard = readFileSync(join(ROOT, "scripts", "deck-desktop-run.ts"), "utf8");
    expect(guard).toContain("rustup.rs");
    expect(guard).toContain("bun scripts/deck-open.ts");
    expect(guard.toLowerCase()).not.toContain("install rust");
    expect(guard.toLowerCase()).not.toContain("rustup install");
    expect(existsSync(join(ROOT, "scripts", "deck-desktop-run.ts"))).toBe(true);
  });
});
