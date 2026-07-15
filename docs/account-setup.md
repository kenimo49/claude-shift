# アカウント登録ガイド

`claude-shift` に複数の Claude Code アカウントを登録する手順。

## 大原則

**`shift add <name>` は「今 `~/.claude/.credentials.json` に入っているアカウント」を `<name>` として保存する** だけのコマンドです。ラベルと実体の紐付けは呼び出し側の責任なので、順序を間違えると誤ラベル登録になります。

## 前提となる Claude CLI の挙動

- `~/.claude/.credentials.json` は **常に1アカウント分** しか保持しません
- `/login` は logout せずとも実行できますが、**新しい credentials で既存ファイルを上書き** します
- 使用中に accessToken が失効すると refreshToken で自動更新され、同ファイルに上書き保存されます

つまり「今どのアカウントで認証しているか」は `credentials.json` の中身が全て。**アクティブ化されていないアカウントに `add` してもトークンは取れません**。

## 基本手順（各アカウントごとに繰り返す）

```bash
# 1. Claude Code 内で /login を実行し、登録したいアカウントで認証する
#    → ~/.claude/.credentials.json が新しいトークンで上書きされる

# 2. すぐに add で保存する
bash shift.sh add <name>

# 3. list で確認（active マークが該当アカウントに付くこと）
bash shift.sh list
```

**重要**: `/login` の直後に必ず `add` してください。他のアカウントを触る前に保存しないと、後続の操作で credentials.json が上書きされて元アカウントのトークンが失われます。

## 自動チェック (v0.2+)

`shift add <name>` は現在の `credentials.json` のトークンが**既に別ラベルとして登録済み**の場合、自動で中止します：

```
⚠️  現在の credentials.json のトークンは既に別アカウント 'kumiko' として登録されています。
中止しました。
```

意図的にコピーを作りたい場合は `-f` / `--force`：

```bash
bash shift.sh add kumiko-copy -f
```

これにより「別アカウントで /login し忘れた状態で誤って add」を防止します。

## ありがちな事故

### 1. 別アカウントでログインしたのに気付かず add

`/login` の画面で別アカウントを選択してしまうと、`credentials.json` はそのアカウントで上書きされます。この状態で `shift add kumiko` すると、kumiko.json に別アカウントのトークンが保存されて誤ラベル化します。

**予防**: `/login` 前に「今どのアカウントで認証するか」を確定させる。認証後の usage 出力でアカウントを目視確認する。v0.2+ では自動チェックが動きます (上記参照)。

### 2. アクティブでないアカウントで add

`shift list` で active マークが付いていないアカウントに対して `add` を実行しても、書き込まれるのは現在アクティブなアカウントのトークンです。**必ず該当アカウントを active 状態にしてから `add`**。

### 3. logout せずに `/login` を連打

Claude Code は logout 不要で `/login` できるため、複数アカウントを立て続けにログインすると `credentials.json` が次々と上書きされ、前のアカウントのトークンは（refresh されていない限り）失われます。1アカウントずつ `/login → add` のペアで完了させてください。

## 干渉なしログイン（HOME override 方式）

現在アクティブなアカウントに影響を与えずに別アカウントのトークンを取り出したい場合：

```bash
mkdir -p /tmp/claude-login-<name>
HOME=/tmp/claude-login-<name> claude
# → 中で /login → 目的アカウントで認証
cp /tmp/claude-login-<name>/.claude/.credentials.json ~/.claude-shift/accounts/<name>.json
chmod 600 ~/.claude-shift/accounts/<name>.json
```

`HOME` 環境変数を上書きすることで、そのセッションだけ別の credentials ファイルに保存されます。現在の `~/.claude/.credentials.json` は一切触られません。

**将来的には `shift add-fresh <name>` として自動化予定**。

## `shift use` の挙動

```bash
bash shift.sh use kumiko
```

内部で以下を実行します：

1. `_sync_back`: 現在の `credentials.json` を、現在アクティブなアカウントファイルへ書き戻す（refresh 済みトークンを保全）
2. `kumiko.json` の内容を `credentials.json` にコピー

これにより、切り替え前のアカウントで自動リフレッシュされたトークンが失われることを防いでいます。

## credentials.json のフォーマット

Claude CLI が期待するのは `claudeAiOauth` ラッパー形式：

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "..."
  }
}
```

フラット形式（`{"accessToken":..., "refreshToken":...}`）は CLI で読めません。`shift add` は `credentials.json` をそのままコピーするのでこの形式を保ちますが、手動編集時は注意してください。

## トラブルシューティング

### `shift usage` で HTTP 401

- accessToken が失効している可能性があります
- 対処: 該当アカウントで `/login` → `shift add <name>` でリフレッシュ

### `shift list` で全アカウントが非 active

- `/login` により credentials.json が既存アカウントと一致しないトークンに置き換わっている状態
- 対処: 直前にログインしたアカウント名で `shift add` を実行して現状を保存
