// claude-shift desktop — Local Web UI (http://127.0.0.1:19867/) を Tauri v2 の窓で開くガワ。
//
// 設計:
// - UI 資産は持たない。server が配信する Web UI をそのまま WebView で開く (単一ソース原則)。
// - server が起きていなければ `node <repo>/cli/server.js` を spawn する (Node は
//   Claude Code ユーザーの前提環境なので sidecar バイナリ同梱はしない)。
// - 自分が spawn した server だけ終了時に kill する。systemd 等で既に動いている server は
//   そのまま使い、殺さない。cleanup は RunEvent::Exit (全終了経路) + Linux は PDEATHSIG
//   (親クラッシュ/SIGKILL でも子を道連れ) の二段構え。
// - server を用意できなかったときは接続失敗ページではなく、原因と対処を書いた
//   エラーページを表示する (Windows release は stderr が見えないため)。
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
// 注意: CARGO_MANIFEST_DIR はコンパイル時埋め込みなので、ビルド済みバイナリを
// 別マシンへ配布した場合は CLAUDE_SHIFT_REPO の明示が必要 (README 記載)。
fn server_js_path() -> PathBuf {
    if let Ok(repo) = std::env::var("CLAUDE_SHIFT_REPO") {
        return PathBuf::from(repo).join("cli/server.js");
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../cli/server.js")
}

// server を使える状態にする。
//   Ok(None)        = 既存 server を使う (殺してはいけない)
//   Ok(Some(child)) = 自分が spawn した (終了時に kill する)
//   Err(msg)        = 用意できなかった (エラーページに出す)
fn ensure_server(port: u16) -> Result<Option<Child>, String> {
    if server_running(port) {
        return Ok(None);
    }

    let server_js = server_js_path();
    if !server_js.exists() {
        return Err(format!(
            "server.js が見つかりません: {}\n\
             git clone した repo から起動するか、環境変数 CLAUDE_SHIFT_REPO で repo の場所を指定してください。\n\
             または先に `./shift.sh server` を起動してからこのアプリを開いてください。",
            server_js.display()
        ));
    }

    let mut cmd = Command::new("node");
    cmd.arg(&server_js);
    // Linux: 親がクラッシュ/SIGKILL されても子 node が孤児として残らないよう PDEATHSIG を張る
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("node の起動に失敗しました: {e}\nNode.js >= 20 が PATH にある必要があります。"))?;

    // 起動待ち (最大 5 秒)。途中で子が死んだら失敗として検知する
    for _ in 0..50 {
        if server_running(port) {
            return Ok(Some(child));
        }
        if let Ok(Some(status)) = child.try_wait() {
            // 多重起動 race: 別インスタンスが先に bind して自分の子が EADDRINUSE で死んだ場合、
            // port が生きていれば「既存 server を使う」に降格する
            if server_running(port) {
                return Ok(None);
            }
            return Err(format!(
                "server が起動直後に終了しました ({status})。\n\
                 ポート {port} を別プロセスが使用している可能性があります。"
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let _ = child.kill();
    let _ = child.wait();
    Err(format!("server がポート {port} で 5 秒以内に応答しませんでした。"))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

// data: URL のエラーページ。WebView に「接続できません」の謎ページを出さないための最終着地。
fn error_page_url(msg: &str) -> tauri::Url {
    let body = format!(
        "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><title>claude-shift</title></head>\
         <body style=\"font-family:sans-serif;background:#0f1117;color:#e5e7eb;padding:2em;font-size:14px\">\
         <h1 style=\"font-size:1.2em\">server を起動できませんでした</h1>\
         <pre style=\"white-space:pre-wrap;background:#1a1d27;padding:1em;border-radius:6px\">{}</pre>\
         </body></html>",
        html_escape(msg)
    );
    // data URL では % と # がデリミタなので最低限エスケープする
    let encoded = body.replace('%', "%25").replace('#', "%23");
    format!("data:text/html;charset=utf-8,{encoded}")
        .parse()
        .expect("data URL の構築に失敗")
}

fn main() {
    let port = port();
    let (spawned, url) = match ensure_server(port) {
        Ok(child) => {
            let url = format!("http://127.0.0.1:{port}/")
                .parse()
                .expect("URL の構築に失敗");
            (child, url)
        }
        Err(msg) => {
            eprintln!("[desktop] {msg}");
            (None, error_page_url(&msg))
        }
    };

    let app = tauri::Builder::default()
        .manage(SpawnedServer(Mutex::new(spawned)))
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url.clone()))
                .title("Claude Shift")
                .inner_size(380.0, 680.0)
                .min_inner_size(340.0, 480.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("claude-shift desktop の起動に失敗");

    app.run(|app_handle, event| {
        // 全終了経路 (最終 window close / SIGTERM 由来の quit 等) で spawn 分だけ後始末。
        // poison していても panic せず best-effort で回収する。
        if let tauri::RunEvent::Exit = event {
            if let Ok(mut guard) = app_handle.state::<SpawnedServer>().0.lock() {
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
