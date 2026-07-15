# claude-shift

複数のClaude Codeアカウントを切り替え・監視するツール。

## 構成

```
claude-shift/
├── shift.sh          # メインCLI
├── cli/
│   ├── fetch-usage.js  # api.anthropic.com からusage取得
│   ├── db.js           # SQLite時系列保存
│   └── server.js       # localhost:19867 API サーバー
└── extension/          # Chrome拡張 (UI)
```

## セットアップ

### 1. アカウント登録

各アカウントでログインした状態で：

```bash
# ~/.claude/.credentials.json の内容を "accountA" として保存
./shift.sh add accountA

# 別アカウントに切り替えてログイン後
./shift.sh add accountB
```

または手動で `~/.claude-shift/accounts/accountA.json` を作成：

```json
{
  "accessToken": "sk-ant-oat01-..."
}
```

### 2. 依存インストール

```bash
npm install
```

### 3. サーバー起動

```bash
./shift.sh server
# または
npm run server
```

### 4. Chrome拡張をロード

1. `chrome://extensions` を開く
2. デベロッパーモード ON
3. 「パッケージ化されていない拡張機能を読み込む」→ `extension/` フォルダを選択

## CLIコマンド

```bash
./shift.sh list            # 全アカウント一覧（アクティブ表示）
./shift.sh use accountB    # accountB に切り替え
./shift.sh usage           # 全アカウントの使用状況を表示
./shift.sh seed accountA   # accountA の5時間ウィンドウを今から起動
./shift.sh add accountC    # 現在のcredentialsをaccountCとして登録
```

## 5時間ウィンドウ管理

使い始めた時点から5時間でリセット。`seed` コマンドで任意のタイミングに起動できる。

```bash
# 夜10時に seed → 翌3時にリセット → 朝の作業に新枠が待機
./shift.sh seed accountA
```

## API エンドポイント (localhost:19867)

| エンドポイント | 内容 |
|---|---|
| `GET /usage` | 最新スナップショット（DB） |
| `GET /usage/live` | APIから今すぐ再取得 |
| `GET /history?account=accountA&hours=24` | 過去24時間の推移 |
