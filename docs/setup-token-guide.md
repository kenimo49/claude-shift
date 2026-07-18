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
- `identity enrich skipped: HTTP 403` → **正常**。setup-token には profile スコープが
  無いため、login 側の identity が未登録のアカウントでは表示できない（login 側の
  次回 refresh 時に自動で埋まる）。この場合 email の機械検証はできないので、
  ブラウザでのアカウント選択が正しかったことを再確認する
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

setup-token は **inference 専用スコープ**で、usage / profile API は使えない
(実測: beta ヘッダ無し 403 / 有り 429。usage 観測は従来どおり login credentials で動く)。
そのため疎通確認は claude の実行そのもので行う:

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(./shift.sh token <name>) claude -p "ok"
```

応答が返れば疎通OK。「You've hit your session limit」が返った場合も、
アカウントの枠状態が見えている = **認証は通っている**（枠のリセットを待てばよい）。
注意: この確認は該当アカウントの 5 時間ウィンドウを起動する（seed と同じ副作用）。

## 3. 日常の使い方

### マシンの既定を token にする（サブマシン側の常用、推奨）

```bash
./shift.sh use-token <name>
# → ~/.claude-shift/env.sh に export 行を書き出す
# → 案内に従って ~/.bashrc に source 行を1回だけ追記する:
#    [ -f ~/.claude-shift/env.sh ] && source ~/.claude-shift/env.sh
```

以降、新しいシェルの claude は全部 token で動く。アカウントを替えるときは
`use-token <別name>` を打ち直すだけ（`.bashrc` は触らない）。
login モードに戻すと (`./shift.sh use <name>`) env.sh は自動削除される
（既に開いているシェルでは `unset CLAUDE_CODE_OAUTH_TOKEN`）。

### 単発でシェルに適用する

```bash
eval "$(./shift.sh env <name>)"   # このシェルの claude が token で動く
claude
```

`CLAUDE_CODE_OAUTH_TOKEN` が設定されている間は credentials.json より優先される。
シェルを閉じれば消える。

### cron / スクリプトの単発実行

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(./shift.sh token <name>) claude -p "..."
```

### アカウント切替

- login 系のまま使う → 従来どおり `./shift.sh use <name>`
- token で切替 → `./shift.sh use-token <別name>`（新しいシェルから有効）、または
  `eval "$(./shift.sh env <別name>)"`（今のシェルだけ。プロセス再起動は必要）

### やってはいけないこと

- **setup-token を `credentials.json` に書かない**（claude CLI が refresh を試みて壊れる。
  `shift use` は token-only アカウントを自動で拒否する）
- **`ANTHROPIC_API_KEY` と併用しない**（干渉する。token 運用マシンでは
  `CLAUDE_CODE_OAUTH_TOKEN` だけを設定する）
- トークンを shell 履歴に残さない（`add-token` の対話入力は非表示、pipe 渡しは
  スクリプト内のみで使う）

## 4. マシン割り当ての考え方

原則は2つ:

1. **実行**: 同一アカウントの login (/login) を2台以上で使わない。サブマシンは setup-token
2. **観測**: usage ポーリング（`shift server` / `shift usage`）も login credentials の refresh を
   消費するので、**アカウントごとに login を所有する1台だけ** が観測する

| マシン | 実行 | 観測 |
|---|---|---|
| ken のメインPC | /login（従来どおり。Remote Control 等のフル機能） | 自分が login を所有するアカウントのみ |
| サブマシン / Iris | setup-token（`use-token` で既定化） | 他マシン所有のアカウントは `observe <name> off` で除外 |
| cron / headless | setup-token（`token` 経由の単発） | 観測しない |

- `observe <name> off` は `~/.claude-shift/config.json` の `pollExclude` に入り、
  server のポーリングと `shift usage` の両方から外れる（Chrome 拡張 ⚙ 設定からも変更可）
- 除外アカウントは `list` と popup に「観測対象外」と表示される
- setup-token はモデルリクエスト専用（Remote Control・クラウドコネクタ不可）なので、
  フル機能が要る側を /login に割り当てる

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
