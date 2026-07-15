// アカウントの読み書き・active検出・切替
// 切替は credentials.json と ~/.claude.json の oauthAccount の両方を更新する
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  chmodSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

export const DEFAULT_ACCOUNTS_DIR = join(homedir(), ".claude-shift", "accounts");
export const DEFAULT_CREDENTIALS = join(homedir(), ".claude", ".credentials.json");
export const DEFAULT_CLAUDE_JSON = join(homedir(), ".claude.json");
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

export function extractToken(obj) {
  return (
    obj?.claudeAiOauth?.accessToken ??
    obj?.accessToken ??
    obj?.access_token ??
    null
  );
}

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function listAccounts(accountsDir = DEFAULT_ACCOUNTS_DIR) {
  if (!existsSync(accountsDir)) return [];
  return readdirSync(accountsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f.replace(/\.json$/, ""),
      path: join(accountsDir, f),
      token: extractToken(readJsonSafe(join(accountsDir, f))),
    }))
    .filter((a) => a.token);
}

export function getActiveAccount(
  accountsDir = DEFAULT_ACCOUNTS_DIR,
  credentialsPath = DEFAULT_CREDENTIALS
) {
  const activeToken = extractToken(readJsonSafe(credentialsPath));
  if (!activeToken) return null;
  return listAccounts(accountsDir).find((a) => a.token === activeToken)?.name ?? null;
}

export async function fetchProfile(token) {
  const res = await fetch(PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`profile fetch failed: HTTP ${res.status}`);
  return res.json();
}

// Anthropic の profile レスポンスを ~/.claude.json.oauthAccount 形式に変換
export function profileToOAuthAccount(profile) {
  const a = profile.account ?? {};
  const o = profile.organization ?? {};
  return {
    accountUuid: a.uuid,
    emailAddress: a.email,
    organizationUuid: o.uuid,
    organizationRole: o.role,
    hasExtraUsageEnabled: o.has_extra_usage_enabled,
    billingType: o.billing_type,
    accountCreatedAt: a.created_at,
    subscriptionCreatedAt: o.subscription_created_at,
    ccOnboardingFlags: o.cc_onboarding_flags,
    claudeCodeTrialEndsAt: o.claude_code_trial_ends_at,
    claudeCodeTrialDurationDays: o.claude_code_trial_duration_days,
  };
}

// ~/.claude.json の oauthAccount を更新（未知フィールドは保持）
export function writeOAuthAccountToClaudeJson(newAccount, claudeJsonPath = DEFAULT_CLAUDE_JSON) {
  if (!existsSync(claudeJsonPath)) return false;
  const cj = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
  cj.oauthAccount = { ...(cj.oauthAccount ?? {}), ...newAccount };
  writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2));
  return true;
}

export async function switchAccount(
  name,
  {
    accountsDir = DEFAULT_ACCOUNTS_DIR,
    credentialsPath = DEFAULT_CREDENTIALS,
    claudeJsonPath = DEFAULT_CLAUDE_JSON,
    skipProfileFetch = false,
  } = {}
) {
  const target = join(accountsDir, `${name}.json`);
  if (!existsSync(target)) throw new Error(`Account '${name}' not found`);

  // sync-back: 現在の credentials.json を今のactiveアカウントに書き戻す
  const active = getActiveAccount(accountsDir, credentialsPath);
  if (active && active !== name && existsSync(credentialsPath)) {
    writeFileSync(join(accountsDir, `${active}.json`), readFileSync(credentialsPath));
  }

  // credentials 切替
  mkdirSync(dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, readFileSync(target));
  try { chmodSync(credentialsPath, 0o600); } catch {}

  // ~/.claude.json の oauthAccount を新アカウントに合わせて更新
  // 失敗しても切替自体は成功扱い（credentialsは既に更新済み）
  if (!skipProfileFetch) {
    try {
      const token = extractToken(readJsonSafe(target));
      if (token) {
        const profile = await fetchProfile(token);
        writeOAuthAccountToClaudeJson(profileToOAuthAccount(profile), claudeJsonPath);
      }
    } catch (e) {
      console.error(`[switchAccount] oauthAccount update failed: ${e.message}`);
    }
  }

  return name;
}

// CLI エントリポイント: node cli/accounts.js <name>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , name] = process.argv;
  if (!name) {
    console.error("Usage: node cli/accounts.js <name>");
    process.exit(1);
  }
  switchAccount(name)
    .then(() => console.log(`Switched to: ${name}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
