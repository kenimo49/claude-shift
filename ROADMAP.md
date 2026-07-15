# ROADMAP

現時点で動くのは CLI + ローカル API サーバ + Chrome 拡張の 3 層構成です。この文書は今後の UI 層追加と install UX 改善の候補をまとめたものです。優先度・確定順序ではなく「入れる価値のある選択肢の一覧」です。

## 決定済みの方針

- **Chrome Web Store には出さない**: Node.js サーバを同梱できず、拡張だけを提出しても他人のマシンでは動きません。install の 1 step 化を狙うより GitHub 経由で「サーバ + 拡張」を丸ごと配布する方が現実的、と判断しました
- **npm publish (`npm i -g claude-shift`)**: 検討候補ですが、bin ラッパー整備・CI・パッケージ名の空き確認が必要なので後回し。install UX を根本改善したくなったタイミングで着手します

## UI 層の追加候補

現状 UI は Chrome 拡張のみですが、実装は `fetch('http://localhost:19867/*')` + SVG 描画で完結しているので、他の UI 層にゼロコストに近いコストで移植できます。

### A. Local Web UI (最短)

- `shift server` の `/` route で `web/index.html` を配信、`/assets/*` で静的ファイル
- ユーザーは `http://localhost:19867/` をブラウザで開くだけ
- 既存 `extension/popup.{html,js,css}` をほぼ 100% 流用可能
- **メリット**: Chrome/Firefox/Safari どこでも動く、拡張 install 不要、Chrome 拡張と並存できる
- **実装コスト**: 30 分程度 (server.js に静的配信 route 10 行追加 + ファイル移動)

### B. TUI (Terminal UI)

- `shift status --watch` で ink (React for CLI) or blessed で 3 アカウントを端末描画
- 5 秒間隔で自動更新、ASCII bar で 5 時間枠/週次を可視化
- **メリット**: CLI 完結、ブラウザ不要、SSH 越しでも使える
- **制約**: SVG chart は諦めて `▓▓▓▓░░░░░░ 40%` の ASCII bar 表現になる
- **実装コスト**: 2-3 時間 (ink 依存追加 + JSX 実装)

### C. VS Code 拡張

- status bar に active account + weekly % を常時表示
- Command Palette から `Claude Shift: Switch Account` で切替
- **メリット**: VS Code Marketplace で discoverability あり、Claude Code ユーザー層と重なる
- **実装コスト**: 半日以上 (VS Code Extension API + publish 手続き)

### D. Menu bar / System tray アプリ

- Tauri or ネイティブでメニューバー常駐
- **制約**: OS 別ビルド、code signing 必要
- **実装コスト**: 大 (少なくとも 1-2 日)

### E. Chrome 拡張の維持

- 現状のまま維持。既存ユーザーの互換性のため deprecate はしない予定
- Web Store には出さない (前述)、GitHub からの手動 install のみ

## 推奨導入順

1. **README 整備** (完了)
2. **A: Local Web UI** — 既存 popup 資産をほぼそのまま使えるので費用対効果最大
3. **B: TUI** — CLI 主派ユーザー向け、独立して価値がある
4. **C: VS Code 拡張** — installability と Marketplace discoverability を上げたくなった時
5. **D: Menu bar** — 上記だけで足りるので後回し

## サーバ常駐化 (別問題)

`shift server` を起動しっぱなしにしたいユーザー向け。

### Linux / WSL2 (systemd user service)

実装済み。手順は [docs/service-setup.md](docs/service-setup.md) を参照 (unit テンプレートは [contrib/systemd/claude-shift.service](contrib/systemd/claude-shift.service))。

### macOS (launchd)

未実装。`~/Library/LaunchAgents/dev.kenimoto.claude-shift.plist` を書いて `launchctl load` する形が定番。実機検証が終わったら docs/service-setup.md に追記予定。

### Windows native

未検証。`nssm` または Task Scheduler で node プロセスを常駐化する想定。WSL2 側で常駐させる方が実運用は楽 (前記 docs 参照)。

## 実装依存関係

```
README 整備 ─┬─→ A (Local Web UI) ─┐
             │                     ├─→ npm publish (bin ラッパー整備)
             ├─→ B (TUI) ──────────┘
             └─→ C (VS Code 拡張、独立)
```

A/B/C は独立に着手できるので、必要が出た順に着手します。
