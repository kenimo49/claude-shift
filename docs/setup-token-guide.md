# setup-token 運用ガイド（発行 → 登録 → 切替 → 再発行）

複数マシンで同一アカウントを使うと refresh token rotation 競合で毎日ログアウトされる
([knowledge/multi-device-token-conflict.md](knowledge/multi-device-token-conflict.md))。
その対策として、全アカウント分の setup-token（1年有効・refresh なし）を発行して
claude-shift に登録するまでの手順書。

## 前提

- claude-shift セットアップ済み（`npm install` 完了、アカウント登録済み）
- Claude Code CLI が使えること（`claude setup-token` は CLI のコマンド）
- ブラウザで claude.ai にログインできること（発行時に認可画面が開く）
- プラン: Pro / Max / Team / Enterprise のいずれか

## 1. 発行 → 登録（アカウントごとに繰り返す）

### 1-1. ブラウザ側のアカウントを確認する

`claude setup-token` の認可は **ブラウザでログイン中のアカウント** に対して行われる。
ローカルの `credentials.json` が何であっても関係ない。

発行したいアカウントと違うアカウントで claude.ai にログインしていると
**誤アカウントのトークンが発行される**ので、先にブラウザで対象アカウントに
切り替えておく（claude.ai 右下のアカウントメニュー → アカウント切替）。

### 1-2. トークンを発行する

```bash
claude setup-token
```

ブラウザが開くので認可する。ターミナルに `sk-ant-oat01-...` のトークンが表示される。

- トークンは **どこにも自動保存されない**。この画面から直接コピーする
- 有効期限は発行から1年（自動更新なし）

### 1-3. claude-shift に登録する

```bash
./shift.sh add-token <name>
# → プロンプトが出るので、コピーしたトークンを貼り付けて Enter（入力は非表示）
```

出力の identity 行で **email が対象アカウントと一致していることを必ず確認**する
（誤ラベル登録の検出はここが最後の砦）:

```
Saved setup-token for 'imoto-team' (login併存)
  expires: 2027/7/18 (365日後)
  identity: imoto@questboard.world (uuid=dca91ac9-...)
```

- email が違う → ブラウザのアカウント選択ミス。`./shift.sh rm <name>` はせず、
  正しいアカウントで 1-1 からやり直して `add-token` で上書きする
- `identity enrich skipped: HTTP 401` → トークン自体が無効の可能性。貼り付けミス
  （途中で切れた等）を疑い、再発行から

### 1-4. 全アカウント分できたか確認する

```bash
./shift.sh list
```

```
Accounts:
  * imoto-team [login+token] (active: login)  token期限: 2027-07-18 (残365日)
    imoto-max20 [login+token]  token期限: 2027-07-18 (残365日)
    kumiko [login+token]  token期限: 2027-07-18 (残365日)
```

全員 `[login+token]` になっていれば完了。

## 2. 疎通確認

```bash
./shift.sh usage
```

各アカウントに `(via setup-token)` が付いていれば、usage 取得が setup-token 経由に
切り替わっている（= ポーリングが login credentials の refresh を消費しなくなった）。

## 3. 日常の使い方

### 対話セッションを setup-token で動かす（サブマシン側）

```bash
eval "$(./shift.sh env <name>)"   # このシェルの claude が token で動く
claude
```

`CLAUDE_CODE_OAUTH_TOKEN` が設定されている間は credentials.json より優先される。
シェルを閉じれば消える。常用するなら `~/.bashrc` に `eval` 行を書く。

### cron / スクリプトの単発実行

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(./shift.sh token <name>) claude -p "..."
```

### アカウント切替

- login 系のまま使う → 従来どおり `./shift.sh use <name>`
- token で切替 → `eval "$(./shift.sh env <別name>)"` を打ち直すだけ（ファイル書き換え無し、プロセス再起動は必要）

### やってはいけないこと

- **setup-token を `credentials.json` に書かない**（claude CLI が refresh を試みて壊れる。
  `shift use` は token-only アカウントを自動で拒否する）
- **`ANTHROPIC_API_KEY` と併用しない**（干渉する。token 運用マシンでは
  `CLAUDE_CODE_OAUTH_TOKEN` だけを設定する）
- トークンを shell 履歴に残さない（`add-token` の対話入力は非表示、pipe 渡しは
  スクリプト内のみで使う）

## 4. マシン割り当ての考え方

同一アカウントの **login (/login) を2台以上で使わない** のが原則。

| マシン | 認証 | 理由 |
|---|---|---|
| ken のメインPC | /login（従来どおり） | 対話メイン。Remote Control 等のフル機能 |
| サブマシン / Iris | setup-token（env 経由） | rotation を持たないので何台で使っても競合しない |
| cron / headless | setup-token（token 経由） | 同上。`shift server` の usage 観測も setup-token 優先で動く |

setup-token はモデルリクエスト専用（Remote Control・クラウドコネクタ不可）なので、
フル機能が要る側を /login に割り当てる。

## 5. 再発行（1年後 / 期限警告が出たら）

`./shift.sh list` が残30日を切ると `⚠️ 再発行推奨` を表示する。

```bash
# 1. ブラウザで対象アカウントにログインしていることを確認（§1-1）
claude setup-token
# 2. 同じ名前に登録し直すだけ（上書き。発行履歴は SQLite に append される）
./shift.sh add-token <name>
```

旧トークンは新トークン発行では失効しない（1年の期限切れで死ぬだけ）ので、
登録し忘れてもすぐには壊れない。ただし期限切れ後は usage が
`setup_token_expired` を返すようになる。

## トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| `usage` で `setup_token_invalid` | トークンが無効化された可能性。再発行 → `add-token` |
| `usage` で `setup_token_expired` | 1年期限切れ。§5 の再発行 |
| identity の email が期待と違う | ブラウザのアカウント選択ミス。正しいアカウントで再発行して `add-token` 上書き |
| `claude` が token を使ってくれない | `--bare` モードは env token を読まない。`ANTHROPIC_API_KEY` が設定されていないかも確認 |
| それでも毎日ログアウトする | ログアウトするマシンがまだ /login 運用のはず。§4 の割り当てを見直す |

## 関連

- 背景（なぜ競合するか）: [knowledge/multi-device-token-conflict.md](knowledge/multi-device-token-conflict.md)
- login 系アカウントの登録手順: [account-setup.md](account-setup.md)
- 2ファイル認証の内部構造: [knowledge/claude-code-auth-internals.md](knowledge/claude-code-auth-internals.md)
