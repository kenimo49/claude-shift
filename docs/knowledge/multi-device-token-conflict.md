# 複数マシンでの毎日ログアウト問題（refresh token 競合）

同一アカウントを **2台以上のマシン** で使うと、片方がだいたい1日1回のペースで非認証状態（HTTP 401 → 再ログイン要求）になる。claude-shift の sync-back では防げないクラスの問題なので、仕組みと対策をここに残す。

## 症状

- 毎日1回程度、Claude Code が突然ログアウト状態になり `/login` を求められる
- `shift list` で active マークが消えている（credentials.json がどの保存ファイルとも不一致、または token 失効）
- 直前まで正常に使えていたのに、access token の失効タイミングで突然発生する

## 仕組み

1. access token は数時間〜半日程度で失効し、refresh token で自動更新される
2. 更新のたびに **refresh token 自体もローテーション**（新しいものに差し替わり、旧 refresh token は失効）する
3. 同一アカウントのトークンが2箇所で生きていると、**片方が refresh した瞬間にもう片方の refresh token が死ぬ**
4. 死んだ側は、手元の access token の寿命が切れた時点で更新に失敗 → 401 → ログアウト

access token の寿命がおおよそ半日〜1日なので、「1日1回ログアウトする」という周期になる。

## なぜ claude-shift では防げないか

sync-back（切替時に最新トークンを `~/.claude-shift/accounts/<name>.json` へ書き戻す仕組み）は、**同一マシン内** の保存コピーと live credentials のずれを防ぐもの。マシン A と マシン B がそれぞれ独立に refresh を走らせる競合は、どちらか一方のツールからは観測も制御もできない。

## 実例 (2026-07-18)

- imoto-team アカウントを ken の PC と Iris マシンの両方で使用
- Iris マシン側が毎日1回 401 → 再ログインが必要になっていた
- Iris マシン側の cron / スクリプトに credentials を触るものが無いことは確認済み → マシン間競合と断定

## 裏取り方法

次に非認証になった時刻と、もう一方のマシンで Claude Code を使った（= refresh が走った可能性のある）時刻を突き合わせる。「マシン B 使用 → 数時間後にマシン A がログアウト」のパターンが再現すれば確定。

## 対策

| 案 | 内容 | トレードオフ |
|---|---|---|
| **片方を `claude setup-token` にする（推奨、shift 対応済み）** | 1年有効の長期トークン（refresh なし）を発行して使う。ローテーションが起きないので競合しない | 1年後に手動再発行（`shift list` が残30日で警告）。Remote Control 等の一部機能は使えない |
| アカウントをマシン単位で分ける | マシンごとに専用アカウントを割り当てる | 確実だが、アカウント数がマシン数に縛られる |
| 現状維持 | 失効した側で毎日再ログイン | 手間が毎日発生。/login 上書き事故（[account-setup.md](../account-setup.md) 参照）のリスクも毎日踏む |

## setup-token 対応 (2026-07-18 実装)

claude-shift は setup-token を login と併存で管理できる。

```bash
claude setup-token               # ブラウザ認可 → 1年トークンが表示される
./shift.sh add-token <name>      # 貼り付けて登録 (発行時期・期限は SQLite に記録)
eval "$(./shift.sh env <name>)"  # CLAUDE_CODE_OAUTH_TOKEN をこのシェルに適用
```

- **setup-token は inference 専用スコープ** (2026-07-18 実測)。`/api/oauth/usage` と `/api/oauth/profile` は beta ヘッダ無しで 403、有りで 429 固定（同時刻の login token は 200）。そのため usage 観測は従来どおり login credentials で行われ、token-only アカウントのみ setup-token で試行する
- 観測ポーリングの refresh は残るため、別マシンで /login 運用中のアカウントを server で観測すると rotation 競合は起き得る。これは `./shift.sh observe <name> off` (pollExclude) で解消する — **観測はアカウントの login を所有する1台に寄せる**。実行は `use-token` で token に寄せれば、そのマシンから login refresh が走る経路はゼロになる
- `list` は `[login]` / `[token]` / `[login+token]` の認証方式と token 期限（残30日で警告）を表示する
- setup-token は `~/.claude/.credentials.json` には書き込まれない（claude CLI が refresh を試みて壊れるのを防ぐ）

## 関連

- 認証ファイルの構造: [claude-code-auth-internals.md](claude-code-auth-internals.md)
- /login 上書き事故と登録手順: [../account-setup.md](../account-setup.md)
