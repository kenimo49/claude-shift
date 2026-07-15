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
  server            localhost API サーバーを起動
  add <name>        アカウントを登録（credentials.json からコピー）

EOF
}

list_accounts() {
  mkdir -p "$ACCOUNTS_DIR"
  local active_token
  active_token=$(python3 -c "
import json, sys
d = json.load(open('${CREDENTIALS}'))
print(d.get('claudeAiOauth', {}).get('accessToken', ''))
" 2>/dev/null || echo "")

  echo "Accounts:"
  for f in "$ACCOUNTS_DIR"/*.json; do
    [[ -f "$f" ]] || continue
    name=$(basename "$f" .json)
    token=$(python3 -c "
import json
d = json.load(open('$f'))
print(d.get('accessToken') or d.get('claudeAiOauth', {}).get('accessToken', ''))
" 2>/dev/null || echo "")
    if [[ "$token" == "$active_token" ]]; then
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
  [[ -z "$name" ]] && { echo "Usage: shift add <name>"; exit 1; }
  mkdir -p "$ACCOUNTS_DIR"

  # 現在のcredentials.jsonからaccessTokenだけ抽出して保存
  python3 -c "
import json
d = json.load(open('${CREDENTIALS}'))
token = d.get('claudeAiOauth', {}).get('accessToken', '')
refresh = d.get('claudeAiOauth', {}).get('refreshToken', '')
out = {'accessToken': token, 'refreshToken': refresh}
json.dump(out, open('${ACCOUNTS_DIR}/${name}.json', 'w'), indent=2)
print('Saved as: ${ACCOUNTS_DIR}/${name}.json')
"
}

start_server() {
  cd "$(dirname "$0")"
  node cli/server.js
}

case "${1:-}" in
  list)    list_accounts ;;
  use)     use_account "${2:-}" ;;
  usage)   show_usage ;;
  seed)    seed_account "${2:-}" ;;
  add)     add_account "${2:-}" ;;
  server)  start_server ;;
  *)       usage ;;
esac
