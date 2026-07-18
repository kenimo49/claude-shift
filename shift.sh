#!/usr/bin/env bash
# claude-shift — multi-account Claude Code manager
set -euo pipefail

ACCOUNTS_DIR="${HOME}/.claude-shift/accounts"
CREDENTIALS="${HOME}/.claude/.credentials.json"

usage() {
  cat <<EOF
Usage: shift <command> [args]

Commands:
  list              全アカウント一覧 (認証方式 [login]/[token] と token 期限を表示)
  use <name>        アカウントを切り替える (login 系のみ。token-only は env を使う)
  usage             全アカウントの使用状況を表示
  seed <name>       5時間ウィンドウを今から起動する（軽量タスク実行）
  server [--interval <min>]
                    localhost API サーバーを起動 (デフォルト10分間隔)
  add <name> [-f]   アカウントを登録（credentials.json からコピー）
  add-token <name>  setup-token を登録 (claude setup-token で発行した1年トークン)
  token <name>      登録済み setup-token の値を出力 (script 埋め込み用)
  env <name>        'export CLAUDE_CODE_OAUTH_TOKEN=...' を出力 (eval 用)
  rm <name> [-f]    アカウント登録を削除

setup-token の使い方:
  eval "\$(shift.sh env <name>)"                        # このシェルで有効化
  CLAUDE_CODE_OAUTH_TOKEN=\$(shift.sh token <name>) claude -p "..."   # 単発

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

# 登録アカウントの setup-token を取り出す
_extract_setup_token() {
  python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print((d.get('setupToken') or {}).get('accessToken', ''))
except: print('')
" "$1" 2>/dev/null || echo ""
}

list_accounts() {
  mkdir -p "$ACCOUNTS_DIR"
  ACCOUNTS_DIR="$ACCOUNTS_DIR" CREDENTIALS="$CREDENTIALS" python3 <<'PYEOF'
import json, os, glob, time

accounts_dir = os.environ["ACCOUNTS_DIR"]
credentials = os.environ["CREDENTIALS"]
env_token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")

def load(path):
    try:
        with open(path) as f: return json.load(f)
    except Exception: return {}

active_login = ""
cred = load(credentials)
active_login = (cred.get("claudeAiOauth") or {}).get("accessToken") or cred.get("accessToken") or ""

now_ms = time.time() * 1000
print("Accounts:")
for path in sorted(glob.glob(os.path.join(accounts_dir, "*.json"))):
    name = os.path.basename(path)[:-5]
    d = load(path)
    login_tok = (d.get("claudeAiOauth") or {}).get("accessToken") or d.get("accessToken") or ""
    setup = d.get("setupToken") or {}
    setup_tok = setup.get("accessToken", "")

    methods = [m for m, ok in (("login", bool(login_tok)), ("token", bool(setup_tok))) if ok]
    method_str = "[" + "+".join(methods) + "]" if methods else "[?]"

    active = ""
    if login_tok and login_tok == active_login:
        active = " (active: login)"
    if setup_tok and env_token and setup_tok == env_token:
        active += " (active: token env)"

    expiry = ""
    if setup_tok and setup.get("expiresAt"):
        days = int((setup["expiresAt"] - now_ms) / 86400000)
        date = time.strftime("%Y-%m-%d", time.localtime(setup["expiresAt"] / 1000))
        if days < 0:
            expiry = f"  token期限切れ ({date}) ⚠️ 再発行してください"
        elif days < 30:
            expiry = f"  token期限: {date} (残{days}日) ⚠️ 再発行推奨"
        else:
            expiry = f"  token期限: {date} (残{days}日)"

    mark = "*" if active else " "
    print(f"  {mark} {name} {method_str}{active}{expiry}")
PYEOF
}

use_account() {
  local name="${1:-}"
  [[ -z "$name" ]] && { echo "Usage: shift use <name>"; exit 1; }
  local cred_file="$ACCOUNTS_DIR/${name}.json"
  [[ -f "$cred_file" ]] || { echo "Account '$name' not found. Run: shift list"; exit 1; }

  # Node実装に委譲: credentials.json + ~/.claude.json の oauthAccount 両方を更新
  local script_dir
  script_dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
  node "$script_dir/cli/accounts.js" "$name"
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
  const via = a.via === "setup_token" ? " (via setup-token)" : "";
  console.log(`
[${a.name}]${via}
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

  # setup-token があれば優先 (login 側の refresh rotation を消費しない)
  local token
  token=$(python3 -c "
import json
d = json.load(open('$cred_file'))
print((d.get('setupToken') or {}).get('accessToken')
      or d.get('accessToken')
      or d.get('claudeAiOauth', {}).get('accessToken', ''))
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

  # credentials.json を account JSON へ merge 保存。
  # 丸コピー (cp) だと account JSON 側にしか無い setupToken を破壊するため node に委譲。
  local script_dir
  script_dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
  node "$script_dir/cli/accounts.js" --merge-creds "$name"

  # issue #5: identity (accountUuid 等) を profile fetch で埋め込む。
  # network 断や API 失敗でも add 自体は成功扱い (次回 refresh 時に自動 migration される)。
  node "$script_dir/cli/accounts.js" --enrich "$name" 2>/dev/null || \
    echo "  (identity enrich skipped — 次回 refresh 時に自動リトライされます)"
}

add_token_account() {
  local name="${1:-}"
  [[ -z "$name" ]] && { echo "Usage: shift add-token <name>"; exit 1; }
  local script_dir
  script_dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

  local token=""
  if [[ -t 0 ]]; then
    # 対話: 非表示入力 (shell 履歴・画面に残さない)
    echo "claude setup-token で発行したトークンを貼り付けてください (入力は非表示):"
    read -rs token
    echo
  else
    # pipe: echo "sk-ant-oat01-..." | shift add-token <name>
    token=$(cat)
  fi
  [[ -z "$token" ]] && { echo "トークンが空です"; exit 1; }

  printf '%s' "$token" | node "$script_dir/cli/tokens.js" add "$name"
}

token_value() {
  local name="${1:-}"
  [[ -z "$name" ]] && { echo "Usage: shift token <name>" >&2; exit 1; }
  local cred_file="$ACCOUNTS_DIR/${name}.json"
  [[ -f "$cred_file" ]] || { echo "Account '$name' not found." >&2; exit 1; }
  local token
  token=$(_extract_setup_token "$cred_file")
  [[ -z "$token" ]] && { echo "Account '$name' に setup-token が登録されていません。shift add-token $name" >&2; exit 1; }
  printf '%s\n' "$token"
}

env_line() {
  local name="${1:-}"
  [[ -z "$name" ]] && { echo "Usage: eval \"\$(shift.sh env <name>)\"" >&2; exit 1; }
  local token
  token=$(token_value "$name") || exit 1
  printf 'export CLAUDE_CODE_OAUTH_TOKEN=%q\n' "$token"
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
  list)      list_accounts ;;
  use)       use_account "$@" ;;
  usage)     show_usage ;;
  seed)      seed_account "$@" ;;
  add)       add_account "$@" ;;
  add-token) add_token_account "$@" ;;
  token)     token_value "$@" ;;
  env)       env_line "$@" ;;
  rm)        rm_account "$@" ;;
  server)    start_server "$@" ;;
  *)         usage ;;
esac
