#!/usr/bin/env bash
# claude-shift — multi-account Claude Code manager
set -euo pipefail

ACCOUNTS_DIR="${HOME}/.claude-shift/accounts"
CREDENTIALS="${HOME}/.claude/.credentials.json"

usage() {
  cat <<EOF
Usage: shift <command> [args]

Commands:
  list              全アカウント一覧
  use <name>        アカウントを切り替える
  usage             全アカウントの使用状況を表示
  seed <name>       5時間ウィンドウを今から起動する（軽量タスク実行）
  server [--interval <min>]
                    localhost API サーバーを起動 (デフォルト10分間隔)
  add <name> [-f]   アカウントを登録（credentials.json からコピー）
  rm <name> [-f]    アカウント登録を削除

EOF
}

# credentials.json からアクセストークンを取り出す（フラット・ネスト両形式対応）
_extract_token() {
  python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('claudeAiOauth', {}).get('accessToken', '') or d.get('accessToken', ''))
except: print('')
" "$1" 2>/dev/null || echo ""
}

# 現在アクティブなアカウント名を返す
_active_name() {
  [[ -f "$CREDENTIALS" ]] || return
  local active_token
  active_token=$(_extract_token "$CREDENTIALS")
  [[ -z "$active_token" ]] && return
  for f in "$ACCOUNTS_DIR"/*.json; do
    [[ -f "$f" ]] || continue
    local tok
    tok=$(_extract_token "$f")
    if [[ "$tok" == "$active_token" ]]; then
      basename "$f" .json
      return
    fi
  done
}

# 現在の credentials を アクティブアカウントファイルへ書き戻す
_sync_back() {
  local active
  active=$(_active_name)
  if [[ -n "$active" && -f "$CREDENTIALS" ]]; then
    cp "$CREDENTIALS" "$ACCOUNTS_DIR/${active}.json"
  fi
}

list_accounts() {
  mkdir -p "$ACCOUNTS_DIR"
  local active
  active=$(_active_name)
  echo "Accounts:"
  for f in "$ACCOUNTS_DIR"/*.json; do
    [[ -f "$f" ]] || continue
    local name
    name=$(basename "$f" .json)
    if [[ "$name" == "$active" ]]; then
      echo "  * $name (active)"
    else
      echo "    $name"
    fi
  done
}

use_account() {
  local name="${1:-}"
  [[ -z "$name" ]] && { echo "Usage: shift use <name>"; exit 1; }
  local cred_file="$ACCOUNTS_DIR/${name}.json"
  [[ -f "$cred_file" ]] || { echo "Account '$name' not found. Run: shift list"; exit 1; }

  # 現在のアカウントへリフレッシュ済みトークンを書き戻してから切り替え
  _sync_back

  cp "$cred_file" "$CREDENTIALS"
  chmod 600 "$CREDENTIALS"
  echo "Switched to: $name"
}

show_usage() {
  node --input-type=module <<'EOF'
import { fetchAllUsage } from "./cli/fetch-usage.js";

const all = await fetchAllUsage();
for (const a of all) {
  if (a.error) {
    console.log(`\n[${a.name}] ERROR: ${a.error}`);
    continue;
  }
  const fh = a.five_hour;
  const wd = a.seven_day;
  const fhReset = fh?.resets_at ? new Date(fh.resets_at).toLocaleTimeString("ja-JP") : "不明";
  const wdReset = wd?.resets_at ? new Date(wd.resets_at).toLocaleDateString("ja-JP") : "不明";
  console.log(`
[${a.name}]
  5時間枠:  ${fh?.utilization ?? "?"}%  (リセット: ${fhReset})
  週次:     ${wd?.utilization ?? "?"}%  (リセット: ${wdReset})`);
}
EOF
}

seed_account() {
  local name="${1:-}"
  [[ -z "$name" ]] && { echo "Usage: shift seed <name>"; exit 1; }

  local cred_file="$ACCOUNTS_DIR/${name}.json"
  [[ -f "$cred_file" ]] || { echo "Account '$name' not found."; exit 1; }

  local token
  token=$(python3 -c "
import json
d = json.load(open('$cred_file'))
print(d.get('accessToken') or d.get('claudeAiOauth', {}).get('accessToken', ''))
")

  echo "Seeding 5-hour window for: $name"
  CLAUDE_CODE_OAUTH_TOKEN="$token" claude --dangerously-skip-permissions -p "ok" 2>/dev/null
  echo "Done. Window starts now → resets in ~5 hours."
}

add_account() {
  local name="${1:-}"
  local force=""
  # -f/--force フラグを受け付ける
  for arg in "$@"; do
    [[ "$arg" == "-f" || "$arg" == "--force" ]] && force="1"
  done
  [[ -z "$name" || "$name" == "-f" || "$name" == "--force" ]] && { echo "Usage: shift add <name> [-f]"; exit 1; }
  mkdir -p "$ACCOUNTS_DIR"

  [[ -f "$CREDENTIALS" ]] || { echo "credentials.json が見つかりません: $CREDENTIALS"; exit 1; }

  # 現在のトークンと既存アカウントを突合して誤ラベル登録を防ぐ
  local current_token
  current_token=$(_extract_token "$CREDENTIALS")
  if [[ -z "$current_token" ]]; then
    echo "credentials.json から accessToken を取得できません"
    exit 1
  fi

  if [[ -z "$force" ]]; then
    for f in "$ACCOUNTS_DIR"/*.json; do
      [[ -f "$f" ]] || continue
      local other_name
      other_name=$(basename "$f" .json)
      [[ "$other_name" == "$name" ]] && continue
      local other_token
      other_token=$(_extract_token "$f")
      if [[ -n "$other_token" && "$other_token" == "$current_token" ]]; then
        cat >&2 <<EOF
⚠️  現在の credentials.json のトークンは既に別アカウント '$other_name' として登録されています。

このまま '$name' として保存すると、同一トークンが2つのラベルで保存されます
(誤ラベル登録の可能性が高い)。

直前に該当アカウントで /login しましたか？
- していない: /login を実行してから add してください
- した: 意図的なコピーであれば -f で強行できます: shift add $name -f

中止しました。
EOF
        exit 1
      fi
    done
  fi

  # credentials.json をそのままコピーして保存（フォーマット保持）
  cp "$CREDENTIALS" "$ACCOUNTS_DIR/${name}.json"
  chmod 600 "$ACCOUNTS_DIR/${name}.json"
  echo "Saved as: $ACCOUNTS_DIR/${name}.json"
}

rm_account() {
  local name="${1:-}"
  local force=""
  for arg in "$@"; do
    [[ "$arg" == "-f" || "$arg" == "--force" ]] && force="1"
  done
  [[ -z "$name" || "$name" == "-f" || "$name" == "--force" ]] && { echo "Usage: shift rm <name> [-f]"; exit 1; }

  local cred_file="$ACCOUNTS_DIR/${name}.json"
  [[ -f "$cred_file" ]] || { echo "Account '$name' not found."; exit 1; }

  # active アカウントの削除は確認を挟む
  local active
  active=$(_active_name)
  if [[ "$active" == "$name" && -z "$force" ]]; then
    cat >&2 <<EOF
⚠️  '$name' は現在アクティブなアカウントです。
削除すると list で active マークが外れますが、~/.claude/.credentials.json
自体は残るので Claude CLI は使用中のまま動きます。

続行する場合は: shift rm $name -f
中止しました。
EOF
    exit 1
  fi

  rm -f "$cred_file"
  echo "Removed: $name"
}

start_server() {
  cd "$(dirname "$0")"
  node cli/server.js "$@"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  list)    list_accounts ;;
  use)     use_account "$@" ;;
  usage)   show_usage ;;
  seed)    seed_account "$@" ;;
  add)     add_account "$@" ;;
  rm)      rm_account "$@" ;;
  server)  start_server "$@" ;;
  *)       usage ;;
esac
