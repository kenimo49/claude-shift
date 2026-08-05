# デスクトップアプリ セットアップガイド (Tauri v2)

`extension/popup.html` を独立ウィンドウで開く Tauri v2 のガワです。build 手順と、別マシンで使うための設定方法をまとめます。

> **アーキテクチャの前提**: この exe は「ガワ」で、UI (`extension/`) と server (`cli/server.js`) を持ちません。実行時に `cli/server.js` を Node.js プロセスとして spawn し、WebView2 (Windows) / WebKitGTK (Linux) で `http://127.0.0.1:19867/` を開きます。つまり **exe 単体では動かず、Node.js と `cli/server.js` の場所を教える必要があります**。

## 前提

- **Rust toolchain** (最新 stable、[rustup.rs](https://rustup.rs/))
  - `cargo --version` が `1.90` 以上を返せば OK。古い場合は `rustup update stable`
- **Node.js v20 以上** (build 時にも実行時にも必要)
- **OS 別の Tauri システム依存** ([公式 prerequisites](https://v2.tauri.app/start/prerequisites/))
  - **Windows**: Visual Studio Build Tools (C++ workload) + WebView2 Runtime (Windows 11 は標準搭載)
  - **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf`
  - **macOS**: Xcode Command Line Tools

## 1. ビルド

### Windows

repo は **Windows 側 (C ドライブ)** に置くこと。`\\wsl$\...` 経由で cargo build するとファイル IO が桁違いに遅くなります (5〜10 倍)。

```powershell
cd C:\Users\<you>\workspace
git clone https://github.com/kenimo49/claude-shift.git
cd claude-shift
npm install
npm run desktop:build
```

初回は依存の compile に 3〜10 分かかります。完了すると以下が生成されます。

```
desktop\src-tauri\target\release\
├─ claude-shift-desktop.exe                            ← 本体 (~8 MB)
└─ bundle\
   ├─ msi\claude-shift_0.1.0_x64_en-US.msi             ← Windows Installer (~3 MB)
   └─ nsis\claude-shift_0.1.0_x64-setup.exe            ← NSIS Installer (~2 MB)
```

### Linux

```bash
cd claude-shift
npm install
npm run desktop:build
```

生成物は `desktop/src-tauri/target/release/bundle/{deb,rpm,appimage}/` 配下。

### macOS

CI ビルドのみで実機動作は未検証です。手順としては Linux と同じ (`npm run desktop:build`) で、生成物は `bundle/dmg/` 配下。

## 2. build したマシンで自分用に使う場合

**追加設定は不要**です。`main.rs` の fallback で build 時の repo パス (`CARGO_MANIFEST_DIR`) がハードコードされるため、その場所に repo がある限り exe から `cli/server.js` を見つけて自動起動します。

```powershell
# exe 直接
& "C:\Users\<you>\workspace\claude-shift\desktop\src-tauri\target\release\claude-shift-desktop.exe"

# または msi / nsis インストーラを実行 → スタートメニューに登録される
```

すでに `cli/server.js` が別プロセスで走っている場合 (`shift server` や systemd user service) は、そちらに接続するだけで新たに spawn しません。両者の共存は README §6 と [service-setup.md](service-setup.md) 参照。

## 3. 別マシンで使う場合 (要 2 つの設定)

build 時にハードコードされる repo パスは配布先マシンには存在しないため、**明示的に指定する必要**があります。

### 必要なもの

1. **Node.js v20 以上** が PATH に居ること
   - Windows なら [Volta](https://volta.sh/) か [公式インストーラ](https://nodejs.org/) から
   - `where node` (Windows) / `which node` (Linux) で確認
2. **repo (少なくとも `cli/` と `extension/`)** を配布先に配置
   - `git clone` でも zip 展開でも可
3. **環境変数 `CLAUDE_SHIFT_REPO`** に repo のルートパスを指定
   - 未指定時は build 時の `CARGO_MANIFEST_DIR` fallback を見に行くため、存在しないパスでエラーになる

### Windows 手順

repo を配布 & clone:

```powershell
# 例: C:\Program Files\Claude Shift\ 配下に repo も置く
git clone https://github.com/kenimo49/claude-shift.git "C:\ProgramData\claude-shift"
```

システム環境変数に `CLAUDE_SHIFT_REPO` を登録 (要管理者):

```powershell
[Environment]::SetEnvironmentVariable('CLAUDE_SHIFT_REPO', 'C:\ProgramData\claude-shift', 'Machine')
```

または、ユーザ環境変数として登録 (管理者不要):

```powershell
[Environment]::SetEnvironmentVariable('CLAUDE_SHIFT_REPO', 'C:\ProgramData\claude-shift', 'User')
```

登録後は一度ログオフ→再ログオンして exe を起動。または、ラッパー `.bat` を用意しても OK:

```bat
@echo off
set CLAUDE_SHIFT_REPO=C:\ProgramData\claude-shift
start "" "C:\Program Files\Claude Shift\claude-shift-desktop.exe"
```

### Linux 手順

```bash
sudo mkdir -p /opt/claude-shift
sudo git clone https://github.com/kenimo49/claude-shift.git /opt/claude-shift

# ~/.bashrc / ~/.zshrc に追記
export CLAUDE_SHIFT_REPO=/opt/claude-shift

# デスクトップから起動する場合は .desktop ファイルの Exec に env を仕込む
# Exec=env CLAUDE_SHIFT_REPO=/opt/claude-shift /opt/claude-shift/desktop/src-tauri/target/release/claude-shift-desktop
```

### ポートを変える場合

デフォルトは `127.0.0.1:19867`。別ポートで動かすなら `CLAUDE_SHIFT_PORT` も設定します。ただし Chrome 拡張は `extension/popup.js` と `extension/manifest.json` の 2 箇所で `127.0.0.1:19867` が固定 hard-code されているため、拡張も併用するなら実質 19867 固定です。

## 4. 動作確認

正常に起動すれば、ウィンドウにアカウントカード + 使用率グラフが表示されます。**もし** `{"error":"not found"}` **という JSON が表示される場合**、下の「トラブルシューティング」を参照。

- ウィンドウを閉じる → タスクトレイに常駐 (完全終了はトレイメニュー「終了」)
- Ctrl+R / F5 でリロード可

## トラブルシューティング

### ウィンドウに `{"error":"not found"}` が表示される

同ポート (19867) で別バージョンの server が動いていて、そちらに Tauri が繋がっています。よくある原因:

- **WSL2 mirrored networking** — Windows で Tauri を起動しても、WSL 側で走ってる systemd service (`claude-shift.service`) の古い server に繋がってしまう。WSL 側を最新化 (`git pull`) → `systemctl --user restart claude-shift` で解決します
- **手動で古い `shift server` を裏で立てたまま** — `pkill -f 'cli/server.js'` で終了させて Tauri を再起動

修正後は Tauri ウィンドウを Ctrl+R でリロード。

### 起動直後にエラーページで「server.js が見つかりません」

`CLAUDE_SHIFT_REPO` が未設定で、fallback path (build 時の `CARGO_MANIFEST_DIR`) が存在しないケース。§3 の手順で env を設定します。

### 起動直後にエラーページで「node の起動に失敗しました」

Node.js が PATH に居ないか、v20 未満です。`node --version` で確認し、v20+ を入れ直します。

### `cargo check` / `cargo build` で `lock file version 4 was found`

Rust toolchain が古い (1.78 未満) と Cargo.lock v4 を読めません。`rustup update stable` で最新 stable に更新してください。

### build に非常に時間がかかる / 中断される

- WSL 側の `\\wsl$\...` パスから build していないか確認。Windows 側 C ドライブに repo を置き直す
- 初回は依存の compile で 3〜10 分は正常。2 回目以降は 30 秒〜 (target ディレクトリのキャッシュが効く)
- `desktop:dev` と `desktop:build` を同時実行すると cargo のロック競合が起きます。片方を止めてから
