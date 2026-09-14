// Tauri build script (roadmap slice `d12`).
//
// `tauri-build` embeds the `tauri.conf.json` snapshot into the binary
// (`tauri::generate_context!()`), so the shell's window/sidecar wiring is a
// compile-time constant, not a runtime read.

fn main() {
    tauri_build::build()
}
