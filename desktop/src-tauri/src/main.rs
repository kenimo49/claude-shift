// claude-shift desktop — Local Web UI (http://127.0.0.1:19867/) を Tauri v2 の窓で開くガワ。
//
// 設計:
// - UI 資産は持たない。server が配信する Web UI をそのまま WebView で開く (単一ソース原則)。
// - server が起きていなければ `node <repo>/cli/server.js` を spawn する (Node は
//   Claude Code ユーザーの前提環境なので sidecar バイナリ同梱はしない)。
// - 自分が spawn した server だけ終了時に kill する。systemd 等で既に動いている server は
//   そのまま使い、殺さない。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

struct SpawnedServer(Mutex<Option<Child>>);

fn port() -> u16 {
    std::env::var("CLAUDE_SHIFT_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(19867)
}

fn server_running(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)).is_ok()
}

// server.js の場所: env 明示 > このソースからの相対 (git clone 運用前提)。
// desktop/src-tauri から見て repo root は 2 つ上。
fn server_js_path() -> PathBuf {
    if let Ok(repo) = std::env::var("CLAUDE_SHIFT_REPO") {
        return PathBuf::from(repo).join("cli/server.js");
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../cli/server.js")
}

fn ensure_server(port: u16) -> Option<Child> {
    if server_running(port) {
        return None;
    }
    let server_js = server_js_path();
    if !server_js.exists() {
        eprintln!(
            "[desktop] server.js が見つかりません: {} (CLAUDE_SHIFT_REPO で repo を指定できます)",
            server_js.display()
        );
        return None;
    }
    match Command::new("node").arg(&server_js).spawn() {
        Ok(child) => {
            // 起動待ち (最大 5 秒)。間に合わなくても WebView 側のリロードで回復できる
            for _ in 0..50 {
                if server_running(port) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Some(child)
        }
        Err(e) => {
            eprintln!("[desktop] node の起動に失敗: {e} (Node.js >= 20 が必要です)");
            None
        }
    }
}

fn main() {
    let port = port();
    let spawned = ensure_server(port);

    tauri::Builder::default()
        .manage(SpawnedServer(Mutex::new(spawned)))
        .setup(move |app| {
            let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("Claude Shift")
                .inner_size(380.0, 680.0)
                .min_inner_size(340.0, 480.0)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // 自分で spawn した server だけ道連れにする
                if let Some(mut child) = window
                    .app_handle()
                    .state::<SpawnedServer>()
                    .0
                    .lock()
                    .unwrap()
                    .take()
                {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("claude-shift desktop の起動に失敗");
}
