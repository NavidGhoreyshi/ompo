# ompo deck — desktop shell (Tauri 2, roadmap slice `d12`)

> **Tauri is packaging, not architecture.** This directory owns exactly one OS
> capability — spawning the bundled `ompo` sidecar and reaping it — and then
> steps out of the way. The deck keeps obtaining its data through the existing
> ompo URL path. Nothing here is a state layer, a store, a transport, a
> filesystem-backed deck API, or a reason to touch the 3D scene.

## How it works

```
desktop app start
  → spawn ./ompo --no-open --print-url            (sidecar; cwd = project dir)
  → stdout "url=http://127.0.0.1:<port>"          (5 s budget)
  → WebviewWindowBuilder(url + "/?surface=deck")  → webview loads the SPA from the server
  → window close → kill child → wait → exit
```

The sidecar is the `d11` handshake consumer: the shell reads the same single
`url=` stdout line `scripts/deck-open.ts` reads, appends `?surface=deck`, and
builds one `WebviewWindowBuilder` with `WebviewUrl::External`. The webview
loads the server's own assets, so there is no duplicated build, no second
asset pipeline, and no drift between what the shell shows and what the browser
shows. There are deliberately zero `#[tauri::command]`s — the webview never
invokes Rust, so there is no data-bearing surface to audit.

No single-instance plugin: a second launch is harmless (the server is
read-only plus lock-guarded control). Remembered window size is explicitly
deferred (a convenience, not a capability).

## Use

```bash
bun run deck:desktop:dev    # tauri dev, after the prerequisite check below
bun run deck:desktop:build  # tauri build (defaults: installer/binary)
bun run deck:desktop:check  # static verifier, no Rust needed
```

The `deck:desktop:*` scripts never attempt an unattended toolchain install:
with no Rust they print the prerequisite and exit 1.

## Platform matrix

| Platform | State in this slice |
|---|---|
| Windows 11 x64 (WebView2, bundled `ompo.exe` sidecar) | Supported target. Hardware acceleration expected (WebView2 + D3D11/ANGLE). |
| Linux (incl. WSLg) | Requires `libwebkit2gtk-4.1-dev` + Rust; **expected to be software-rendered** under WSLg, slower than the browser the shell would wrap. Not the first target. |
| macOS | Untested, and says so. |

Sidecar failure behaviour (fixed content, minimal bundled error page): the
app opens a single small error window with the child's stderr tail and the
exact terminal command that reproduces the failure
(`ompo --no-open --print-url`). If the sidecar dies later, the window shows
"ompo stopped"; relaunching the app respawns the sidecar and reloads the URL.
Closing the window stops the sidecar; a `Drop` guard covers panic paths.

## Files

- `src-tauri/tauri.conf.json` — one window (`main`, 1600×1000, min 900×600,
  hidden until the handshake), `bundle.externalBin: ["binaries/ompo"]`, empty
  `bundle.resources` (no SPA copy), version pinned to the repo `package.json`.
- `src-tauri/src/main.rs` — sidecar lifecycle + error document + pure,
  unit-tested helpers (`cargo test` covers them where Rust exists).
- `src-tauri/capabilities/default.json` — `core:default` plus
  `shell:allow-spawn/kill/stdin-write` scoped to the sidecar. No `fs`, `http`,
  `dialog`, `process` beyond the sidecar, no remote URL permissions.
- `src-tauri/icons/` — placeholder app icon (replace before any real release).

## Comparison with the browser launcher

`bun scripts/deck-open.ts` (slice `d11`) remains fully usable and is the
better development/runtime path on this machine: zero toolchain, same app
window via `--app=`, same handshake. The Tauri shell earns its keep only
where it shows a capability the launcher lacks (packaged installer, tray /
autostart, always-on-top mini-HUD — none in this slice). If it cannot, drop
it: `d12` is a deliberately droppable packaging experiment, off the critical
path (`d11` → `d14` may skip it entirely).
