# claude-shift

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-144%20passing-brightgreen.svg)](tests/)

複数の Claude Code アカウントを 1 台のマシンで切り替え・観測するツール。CLI + ローカル API サーバー + Chrome 拡張の 3 層構成です。

![demo](docs/images/demo.gif)

## なぜ作ったか

Claude Code の 5 時間ウィンドウは「初回リクエスト起点」でリセットされる仕様なので、Max/Team を **時差でずらせば連続作業時間を実質伸ばせます** (kumiko を 10 時に開始、imoto-team を 15 時に開始、imoto-max20 を 20 時に開始で 15 時間分)。

ただし切替は素朴に `~/.claude/.credentials.json` を差し替えるだけでは足りず、Claude Code は認証 token (`credentials.json`) と表示情報 (`~/.claude.json` の `oauthAccount`) を **2 ファイルで管理**しています。片方だけ書き換えると `/status` が古いアカウントを表示し続ける食い違いが起きます。詳細は [docs/knowledge/claude-code-auth-internals.md](docs/knowledge/claude-code-auth-internals.md) と [解説記事 (kenimoto.dev/ja)](https://kenimoto.dev/ja/blog/claude-code-two-file-auth-multi-account/) にまとめてあります。

`shift use` は両ファイルを一貫して書き換えつつ、refresh 済み token の sync back までやります。

## Prerequisites

- **Node.js**: v20 以上
- **npm**: v9 以上
- **OS**: Linux / macOS / **WSL2** で動作確認済み (Windows native は未検証)
- **Claude Code CLI**: [公式手順](https://docs.claude.com/en/docs/agents-and-tools/claude-code) でインストール済みであること
- **Chrome 拡張を使う場合**: Chrome / Chromium / Edge (Manifest V3 対応ブラウザ)

`better-sqlite3` は native build を含むので、初回 `npm install` で `python3` + C++ toolchain (`build-essential` / Xcode CLT 相当) が必要になる場合があります。

## セットアップ

### 1. clone + install

```bash
git clone https://github.com/kenimo49/claude-shift
cd claude-shift
npm install
chmod +x shift.sh
```

### 2. アカウント登録

各アカウントを Claude Code の `/login` 直後にキャプチャします。**手順を間違えると別アカウントの token で上書きされる**ので、順序を厳守してください。詳細は [docs/account-setup.md](docs/account-setup.md)。

```bash
# a. Claude Code 内で /login を実行し、登録したいアカウントで認証
# b. Claude Code を抜けて (Ctrl+D)、直後に add
./shift.sh add my-account-a

# c. b と c を残りのアカウント分繰り返す
```

### 3. サーバ起動 (usage 観測が必要な場合)

```bash
./shift.sh server              # デフォルト 10 分間隔
./shift.sh server --interval 5 # 5 分間隔
```

ログイン中はずっと動かしたい場合は systemd user service にする手順が [docs/service-setup.md](docs/service-setup.md) にあります (Linux native / WSL2 対応)。**常駐化する場合は先に手動 server を止めてポート 19867 を空けてください ([§0](docs/service-setup.md#0-既存の手動-server-を止める-必要な場合のみ))。**

### 4. Chrome 拡張のロード (optional)

1. Chrome で `chrome://extensions/` を開く
2. 右上「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」→ `extension/` フォルダを指定

## CLI コマンド

| コマンド | 内容 |
|---|---|
| `./shift.sh list` | 登録済み全アカウントと認証方式 (`[login]` / `[token]` / `[login+token]`)、active、setup-token 期限を一覧表示 |
| `./shift.sh use <name>` | active を切替。refresh 済み token を sync back し、`~/.claude.json` の oauthAccount も更新 (login 系専用) |
| `./shift.sh usage` | 全アカウントの 5 時間枠と週次の使用率+リセット時刻を表示 |
| `./shift.sh seed <name>` | 最小 API リクエスト 1 発で 5 時間ウィンドウを能動起動 (長時間セッション直前に新枠を仕込む用) |
| `./shift.sh add <name>` | 現在の `credentials.json` を `<name>` として登録。重複 token は警告 (`-f` で強行) |
| `./shift.sh add-token <name>` | `claude setup-token` で発行した 1 年トークンを `<name>` に登録 (login と併存可)。発行時期・期限は SQLite に記録 |
| `./shift.sh token <name>` | 登録済み setup-token の値を出力 (`CLAUDE_CODE_OAUTH_TOKEN=$(./shift.sh token x) claude -p ...`) |
| `./shift.sh env <name>` | `export CLAUDE_CODE_OAUTH_TOKEN=...` を出力 (`eval "$(./shift.sh env x)"` でシェルに適用) |
| `./shift.sh rm <name>` | 登録削除。active 削除は `-f` 必要 |
| `./shift.sh server [--interval N]` | ローカル API サーバ (127.0.0.1:19867) 起動 |

## setup-token 併用 (複数マシン運用)

同一アカウントを複数マシンで `/login` すると、refresh token のローテーション競合で片方が毎日ログアウトされます ([docs/knowledge/multi-device-token-conflict.md](docs/knowledge/multi-device-token-conflict.md))。`claude setup-token` の 1 年トークン (refresh なし) を `add-token` で登録すると:

- **inference 専用スコープ**: setup-token は claude の実行 (モデルリクエスト) にのみ使えます。usage / profile API は拒否される (実測 403/429) ため、usage 観測は従来どおり login credentials で行われます (token-only アカウントのみ setup-token で試行し、状態を可視化)
- **login と併存**: 同じアカウント名に `[login+token]` の両方式を持てます。`use` は login、環境変数利用は `env` / `token`
- **期限管理**: 発行時期・期限を SQLite (`setup_tokens` テーブル) に記録し、`list` が残 30 日を切ると再発行を促します

```bash
# ken のマシン: 通常どおり /login
# サブマシン / cron: setup-token で運用
claude setup-token                     # ブラウザ認可 → token が表示される
./shift.sh add-token my-account-a      # 貼り付けて登録 (入力は非表示)
eval "$(./shift.sh env my-account-a)"  # このシェルの claude が token で動く
```

## API エンドポイント (127.0.0.1:19867)

| Endpoint | Method | 内容 |
|---|---|---|
| `/usage` | GET | 最新スナップショット (SQLite から) |
| `/usage/live` | GET | Anthropic API から今すぐ再取得 |
| `/history?account=<name>&hours=N` | GET | 指定アカウントの N 時間分の推移 |
| `/history/all?hours=N` | GET | 全アカウントの N 時間分の推移 |
| `/active` | GET / POST | 現在の active 取得 / 切替 (`{"name": "..."}` を送る) |
| `/config` | GET / POST | ポーリング間隔の取得 / 変更 (`{"pollMinutes": N}` を送る) |

## Chrome 拡張

`extension/` を Chrome にロードすると popup 画面で以下が使えます。

- 全アカウントの 5 時間枠 + 週次バー + リセット時刻
- Active アカウントの「使用中」バッジ、他アカウントは「切替」ボタン (裏で `shift use` を実行)
- ⚙ 設定モーダル: ポーリング間隔を popup から即変更 (`~/.claude-shift/config.json` に永続化)
- 📊 分析モーダル: 6h / 24h / 7d の 3 アカウント横断 SVG 折れ線グラフ

## Troubleshooting

### `/status` が古いアカウントを表示し続ける

`shift use` を通さず `credentials.json` を直接差し替えた可能性があります。`shift use <name>` を再実行すれば `~/.claude.json` の `oauthAccount` も同期されます。

### HTTP 401 / 再ログイン要求

sync back を経由しない差し替えで refresh 済み token が捨てられた可能性があります。該当アカウントで Claude Code の `/login` をやり直し、`shift add <name>` で再登録してください。今後の切替は `shift use` を経由すれば再発しません。

### popup が「サーバに接続できません」と表示

`shift server` が起動していません。別ターミナルで `./shift.sh server` を実行してから popup を開き直してください。

### Chrome 拡張のアイコンが読み込めない

`extension/icons/` が空の場合は `npm run icons` で PNG を生成してください (sharp が SVG を PNG に変換します)。

### `better-sqlite3` の native build エラー

`node-gyp` が使う python3 + C++ toolchain が不足しています。

- Debian/Ubuntu: `sudo apt install build-essential python3`
- macOS: `xcode-select --install`
- WSL2: 上記 Debian/Ubuntu と同じ

その後 `npm rebuild better-sqlite3` で再ビルド。

### `shift.sh` が動かない (`bash: shift: 数字の引数が必要です`)

`shift` は bash 組み込みコマンドと衝突するので、PATH に置いた `shift` エイリアスや function は無限再帰します。**必ず `./shift.sh <cmd>` のパス付きで呼んでください**。

## セキュリティ / プライバシー

- **書き換えるファイル**: `~/.claude/.credentials.json` (token 保管) と `~/.claude.json` の `oauthAccount` フィールドのみ。`~/.claude.json` の他フィールド (会話履歴、UI 設定など) には触れません
- **保存先**: 登録済みアカウントの credentials (と setup-token) は `~/.claude-shift/accounts/<name>.json`。SQLite の usage スナップショット・setup-token 発行記録は `~/.claude-shift/usage.db`。setup-token は `credentials.json` へは書き込みません
- **通信先**: `api.anthropic.com` のみ (`/api/oauth/profile` と `/api/oauth/usage`)。外部サーバへの送信はありません
- **サーバのバインド**: `127.0.0.1:19867` (loopback only、外部から到達不可)
- **ファイル権限**: `credentials.json` は `chmod 600` (owner のみ読み書き) で書き出します

## テストの実行

```bash
npm test
# node --test tests/*.test.js
# → 144 tests passing
```

## ドキュメント

- [docs/account-setup.md](docs/account-setup.md) — 登録・切替の詳細ガイド、事故パターン、干渉なしログイン方法
- [docs/setup-token-guide.md](docs/setup-token-guide.md) — setup-token の発行 → 登録 → 日常運用 → 1年後の再発行までの手順書
- [docs/knowledge/claude-code-auth-internals.md](docs/knowledge/claude-code-auth-internals.md) — Claude Code の 2 ファイル認証仕様メモ
- [docs/knowledge/multi-device-token-conflict.md](docs/knowledge/multi-device-token-conflict.md) — 複数マシン同時使用で毎日ログアウトされる問題 (refresh token 競合) と setup-token による対策
- [ROADMAP.md](ROADMAP.md) — 今後の UI 層追加候補 (Local Web UI / TUI / VS Code 拡張) と方針

## 関連

- 解説記事: [複数アカウントで気づいた Claude Code の2ファイル認証 (kenimoto.dev/ja)](https://kenimoto.dev/ja/blog/claude-code-two-file-auth-multi-account/)
- プロダクト LP: [kenimoto.dev/products/claude-shift/](https://kenimoto.dev/products/claude-shift/) (EN / JA / PT / ES)

## License

[MIT](LICENSE) © Ken Imoto
