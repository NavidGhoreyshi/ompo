// Deck desktop shell (roadmap slice `d12`).
//
// Packaging, not architecture: the shell owns exactly one OS capability —
// spawning the bundled `ompo` sidecar and reaping it — and then steps out of
// the way. The deck keeps obtaining its data through the existing ompo URL
// path: the sidecar prints one `url=<url>` line (the `d11` `--print-url`
// handshake), and the single webview navigates to `<url>/?surface=deck`.
// No state layer, no store, no transport, no `.omp/` reading, and no code in
// this crate fetches the API or parses events.
//
// Lifecycle:
//   setup → spawn sidecar → read the `url=` line (5 s budget) → build one
//   `WebviewWindowBuilder` with `WebviewUrl::External` → show.
//   Window close / app exit / panic → kill the child (the shell plugin also
//   kills tracked children on `RunEvent::Exit`; `DeckState`'s `Drop` is the
//   panic backstop).
//
// Zero-dependency logic (URL-line parsing, deck-URL join, error document) is
// pure and unit-tested under `#[cfg(test)]` below; everything else is Tauri
// wiring. There are deliberately zero `#[tauri::command]`s: the webview never
// invokes Rust, so there is no data-bearing surface to audit.

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WindowEvent};
use tauri::webview::WebviewWindowBuilder;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The `d11` handshake budget: the server binds in well under a second.
const URL_TIMEOUT: Duration = Duration::from_secs(5);
/// Sidecar name as declared in `tauri.conf.json` `bundle.externalBin`.
const SIDECAR_NAME: &str = "binaries/ompo";

/// The one line the sidecar prints on stdout once bound: `url=<url>`.
fn parse_url_line(line: &str) -> Option<String> {
    let line = line.trim();
    line.strip_prefix("url=").map(|url| url.trim().to_string())
}

/// Join the deck surface onto the server URL (`<url>/?surface=deck`).
fn deck_url(server_url: &str) -> String {
    format!("{}/?surface=deck", server_url.trim_end_matches('/'))
}

/// Minimal error document: what failed, why, and how to reproduce outside the
/// shell (the roadmap fixes the content, not the rendering mechanism).
fn error_document(title: &str, detail: &str, stderr_tail: &str, reproduce: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <title>{title}</title>\
         <style>body{{font:14px/1.5 system-ui,sans-serif;padding:32px;max-width:640px;margin:0 auto}}\
         pre{{background:#f4f4f5;padding:12px;overflow:auto;border-radius:8px}}\
         code{{background:#f4f4f5;padding:2px 6px;border-radius:4px}}</style>\
         </head><body><h1>{title}</h1><p>{detail}</p>\
         <h2>ompo stderr</h2><pre>{stderr_tail}</pre>\
         <h2>Reproduce outside the shell</h2><p><code>{reproduce}</code></p></body></html>",
        title = html_escape(title),
        detail = html_escape(detail),
        stderr_tail = html_escape(stderr_tail),
        reproduce = html_escape(reproduce),
    )
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn reproduce_command() -> String {
    "ompo --no-open --print-url".to_string()
}

/// Project directory the sidecar serves: the directory the app was launched
/// from, overridable by `OMPO_PROJECT` (the server resolves `projectDir` from
/// its own cwd, mirroring `src/cli.ts`).
fn project_dir() -> std::path::PathBuf {
    std::env::var_os("OMPO_PROJECT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")))
}

struct DeckState {
    child: Option<CommandChild>,
    deck_url: Option<String>,
    /// Last stderr lines, bounded (failure tails only, never the deck data).
    stderr_tail: Vec<String>,
}

impl DeckState {
    fn new() -> Self {
        Self { child: None, deck_url: None, stderr_tail: Vec::new() }
    }

    fn push_stderr(&mut self, line: String) {
        self.stderr_tail.push(line);
        const KEEP: usize = 10;
        if self.stderr_tail.len() > KEEP {
            let excess = self.stderr_tail.len() - KEEP;
            self.stderr_tail.drain(..excess);
        }
    }

    fn stderr_text(&self) -> String {
        self.stderr_tail.join("\n")
    }

    fn stop_child(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

/// Panic backstop: if the app unwinds, the child is still reaped.
impl Drop for DeckState {
    fn drop(&mut self) {
        self.stop_child();
    }
}

fn deck_state(app: &AppHandle) -> MutexGuard<'_, DeckState> {
    app.state::<Mutex<DeckState>>()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Read the single `url=` handshake line, collecting stderr tails on the way.
/// The whole wait is bounded by `URL_TIMEOUT`.
async fn read_handshake_url(
    rx: &mut tauri::async_runtime::Receiver<CommandEvent>,
    app: &AppHandle,
) -> Result<String, String> {
    let fut = async {
        loop {
            match rx.recv().await {
                None => return Err("the sidecar exited before printing its `url=` line".to_string()),
                Some(CommandEvent::Stdout(bytes)) => {
                    if let Some(url) = parse_url_line(&String::from_utf8_lossy(&bytes)) {
                        return Ok(url);
                    }
                }
                Some(CommandEvent::Stderr(bytes)) => {
                    let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                    if !line.is_empty() {
                        deck_state(app).push_stderr(line);
                    }
                }
                Some(CommandEvent::Terminated(payload)) => {
                    let code = payload.code.map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string());
                    return Err(format!(
                        "the sidecar exited (code {code}) before printing its `url=` line"
                    ));
                }
                Some(CommandEvent::Error(message)) => {
                    return Err(format!("failed reading the sidecar output: {message}"));
                }
            }
        }
    };
    match tokio::time::timeout(URL_TIMEOUT, fut).await {
        Ok(result) => result,
        Err(_) => Err("timed out after 5 s waiting for the sidecar's `url=` line".to_string()),
    }
}

/// Build the single small error window (boot failure path: no deck window
/// exists yet, so this *is* the one window).
fn show_boot_error(app: &AppHandle, title: &str, detail: &str, stderr_tail: &str) {
    let document = error_document(title, detail, stderr_tail, &reproduce_command());
    let url = format!("data:text/html,{}", url_encode(&document));
    let parsed: Result<tauri::Url, _> = url.parse();
    let Ok(parsed) = parsed else { return };
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title(format!("ompo deck — error"))
        .inner_size(640.0, 480.0)
        .build();
}

/// Spawn the sidecar, read the handshake, build the one deck window, then keep
/// draining stderr (bounded) and watch for a later sidecar death.
async fn boot_deck(app: AppHandle) -> Result<(), ()> {
    let cwd = project_dir();
    let (mut rx, child) = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map(|command| command.args(["--no-open", "--print-url"]).current_dir(&cwd))
        .and_then(|command| command.spawn())
        .map_err(|_| {
            show_boot_error(&app, "ompo failed to start", "The bundled ompo sidecar could not be spawned.", "");
        })?;
    deck_state(&app).child = Some(child);

    let url = match read_handshake_url(&mut rx, &app).await {
        Ok(url) => url,
        Err(reason) => {
            let tail = deck_state(&app).stderr_text();
            deck_state(&app).stop_child();
            show_boot_error(&app, "ompo failed to start", &reason, &tail);
            return Err(());
        }
    };
    let url = deck_url(&url);
    deck_state(&app).deck_url = Some(url.clone());

    let parsed: Result<tauri::Url, _> = url.parse();
    let Ok(parsed) = parsed else {
        deck_state(&app).stop_child();
        show_boot_error(&app, "ompo failed to start", "The sidecar printed a URL that is not a valid URL.", "");
        return Err(());
    };
    let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(parsed))
        .title("ompo deck")
        .inner_size(1600.0, 1000.0)
        .min_inner_size(900.0, 600.0)
        .build()
        .map_err(|_| ())?;

    let app_for_drain = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut rx = rx;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                    if !line.is_empty() {
                        deck_state(&app_for_drain).push_stderr(line);
                    }
                }
                CommandEvent::Terminated(_) => {
                    on_sidecar_stopped(&app_for_drain);
                    break;
                }
                CommandEvent::Error(_) | CommandEvent::Stdout(_) => {}
            }
        }
    });
    let _ = window.show();
    Ok(())
}

/// The sidecar died after a successful boot: keep the window, say so, and
/// point at the terminal reproduce (relaunching the app respawns + reloads).
fn on_sidecar_stopped(app: &AppHandle) {
    deck_state(app).child = None;
    let Some(window) = app.get_webview_window("main") else { return };
    let tail = deck_state(app).stderr_text();
    let document = error_document(
        "ompo stopped",
        "The ompo sidecar exited. Relaunch this app to respawn it (restart = respawn sidecar + reload the URL).",
        &tail,
        &reproduce_command(),
    );
    let Ok(url) = format!("data:text/html,{}", url_encode(&document)).parse() else { return };
    let _ = window.navigate(url);
    let _ = window.show();
}

fn url_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(DeckState::new()))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = boot_deck(handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                deck_state(window.app_handle()).stop_child();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running the ompo deck shell")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                deck_state(app).stop_child();
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_line_parses() {
        assert_eq!(
            parse_url_line("url=http://127.0.0.1:41237\n"),
            Some("http://127.0.0.1:41237".to_string())
        );
        assert_eq!(
            parse_url_line("url=http://127.0.0.1:41237"),
            Some("http://127.0.0.1:41237".to_string())
        );
        // The contract is exactly one meaning per line: banners never match.
        assert_eq!(parse_url_line("ompo dashboard: http://127.0.0.1:41237"), None);
        assert_eq!(parse_url_line(""), None);
    }

    #[test]
    fn deck_url_appends_the_surface() {
        assert_eq!(deck_url("http://127.0.0.1:41237"), "http://127.0.0.1:41237/?surface=deck");
        // An operator-pasted trailing slash must not double up.
        assert_eq!(deck_url("http://127.0.0.1:41237/"), "http://127.0.0.1:41237/?surface=deck");
    }

    #[test]
    fn stderr_tail_is_bounded() {
        let mut state = DeckState::new();
        for n in 0..25 {
            state.push_stderr(format!("line {n}"));
        }
        assert_eq!(state.stderr_tail.len(), 10);
        assert_eq!(state.stderr_tail[0], "line 15");
        assert!(state.stderr_text().contains("line 24"));
    }

    #[test]
    fn error_document_carries_the_contract_content() {
        let document = error_document(
            "ompo failed to start",
            "reason here",
            "tail here",
            "ompo --no-open --print-url",
        );
        for needle in ["ompo failed to start", "reason here", "tail here", "ompo --no-open --print-url"] {
            assert!(document.contains(needle), "missing {needle}");
        }
    }

    #[test]
    fn shell_never_reads_the_store() {
        let source = include_str!("main.rs");
        for forbidden in [".omp/", "events.jsonl", "/api/", "fetch(", "EventSource", "WebSocket"] {
            assert!(!source.contains(forbidden), "main.rs must not contain {forbidden}");
        }
    }

    #[test]
    fn shell_exposes_no_commands() {
        let source = include_str!("main.rs");
        assert!(!source.contains("#[tauri::command]"), "packaging only: zero Tauri commands");
        assert!(!source.contains("invoke_handler"), "packaging only: no invoke handler");
    }
}
