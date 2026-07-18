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
| **アカウントをマシン単位で分ける（推奨）** | マシンごとに専用アカウントを割り当てる | 最も確実。複数アカウント保有が前提 |
| 片方を `claude setup-token` にする | 長期トークン（refresh なし）を発行して使う。ローテーションが起きないので競合しない | 有効期限切れ時に手動再発行。対話ログインとの機能差に注意 |
| 現状維持 | 失効した側で毎日再ログイン | 手間が毎日発生。/login 上書き事故（[account-setup.md](../account-setup.md) 参照）のリスクも毎日踏む |

## 関連

- 認証ファイルの構造: [claude-code-auth-internals.md](claude-code-auth-internals.md)
- /login 上書き事故と登録手順: [../account-setup.md](../account-setup.md)
