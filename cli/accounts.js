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

export function extractRefreshToken(obj) {
  return (
    obj?.claudeAiOauth?.refreshToken ??
    obj?.refreshToken ??
    obj?.refresh_token ??
    null
  );
}

export function extractExpiresAt(obj) {
  const v =
    obj?.claudeAiOauth?.expiresAt ??
    obj?.expiresAt ??
    obj?.expires_at ??
    null;
  return v == null ? null : Number(v);
}

// account JSON / ~/.claude.json 両対応で accountUuid を抜き出す。
// issue #5: identity ベース照合の identity source。
export function extractAccountUuid(obj) {
  return (
    obj?.oauthAccount?.accountUuid ??
    obj?.claudeAiOauth?.oauthAccount?.accountUuid ??
    obj?.accountUuid ??
    null
  );
}

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// refresh 済み token を account JSON (と必要なら active credentials.json) に書き戻す。
// 既存フィールド (scopes, subscriptionType, rateLimitTier, その他) は保持する。
//
// active mirror は compare-and-swap 相当:
//   1. account JSON を書く前に「元 access token」を snapshot
//   2. 書いた直後、mirror 直前にもう一度 .credentials.json を読み、
//      その中の access token が元 snapshot と一致するときだけ mirror する
//   一致しないなら claude CLI や switchAccount が並行で別 token に書き換えているので、
//   古い/別アカウントの credentials を戻さないよう mirror をスキップする。
//
// { active, mirrored, mirrorError?, mirrorSkipped? } を返す。
export function writeAccountCreds(
  accountPath,
  { accessToken, refreshToken, expiresAt },
  { credentialsPath = DEFAULT_CREDENTIALS, mirrorActive = true } = {}
) {
  if (!existsSync(accountPath)) throw new Error(`account file not found: ${accountPath}`);
  const raw = JSON.parse(readFileSync(accountPath, "utf8"));

  const previousAccountToken = extractToken(raw);
  const activeTokenBefore = mirrorActive ? extractToken(readJsonSafe(credentialsPath)) : null;
  const wasActive = !!activeTokenBefore && activeTokenBefore === previousAccountToken;

  if (raw.claudeAiOauth) {
    raw.claudeAiOauth = { ...raw.claudeAiOauth, accessToken, refreshToken, expiresAt };
  } else if ("accessToken" in raw || "refreshToken" in raw || "expiresAt" in raw) {
    raw.accessToken = accessToken;
    raw.refreshToken = refreshToken;
    raw.expiresAt = expiresAt;
  } else {
    // 想定外レイアウト: claudeAiOauth 形にラップする (fetch-usage 側と互換)
    raw.claudeAiOauth = { accessToken, refreshToken, expiresAt };
  }

  writeFileSync(accountPath, JSON.stringify(raw, null, 2));
  try { chmodSync(accountPath, 0o600); } catch {}

  if (!(mirrorActive && wasActive)) {
    return { active: wasActive, mirrored: false };
  }

  // CAS: .credentials.json を再読して、上で snapshot した previousAccountToken と
  // まだ一致していることを確認してから mirror する。ズレていれば別プロセスが
  // 更新済み (claude CLI の自前 refresh / switchAccount) なので上書きしない。
  const currentActive = extractToken(readJsonSafe(credentialsPath));
  if (currentActive !== previousAccountToken) {
    return {
      active: true,
      mirrored: false,
      mirrorSkipped: "credentials.json changed during refresh; not overwriting",
    };
  }
  try {
    writeFileSync(credentialsPath, readFileSync(accountPath));
    chmodSync(credentialsPath, 0o600);
  } catch (e) {
    return { active: true, mirrored: false, mirrorError: e.message };
  }
  return { active: true, mirrored: true };
}

export function listAccounts(accountsDir = DEFAULT_ACCOUNTS_DIR) {
  if (!existsSync(accountsDir)) return [];
  return readdirSync(accountsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const path = join(accountsDir, f);
      const raw = readJsonSafe(path);
      return {
        name: f.replace(/\.json$/, ""),
        path,
        token: extractToken(raw),
        uuid: extractAccountUuid(raw),
      };
    })
    .filter((a) => a.token);
}

// issue #5: identity ベースで active アカウントを解決する。
//
// 従来: `.credentials.json` の accessToken 値と accounts/*.json の accessToken 値を
//       文字列比較。claude CLI と shift はそれぞれ独立に refresh するので、片方が
//       refresh した瞬間トークン値が乖離して active=null になる。
//
// 新設: `~/.claude.json.oauthAccount.accountUuid` (claude CLI が管理する current active
//       の identity) と accounts/*.json の oauthAccount.accountUuid を照合する。
//       token 値は refresh で変わるが uuid は不変なので乖離しない。
//
// 返り値: { name, method, syncBroken }
//   - name: 解決した account 名 (null なら不明)
//   - method: "uuid" | "token" | null  (どの経路でマッチしたか)
//   - syncBroken: true なら claude CLI と shift のどちらも identity を特定できない
//                 (uuid も token も一致する account が無い、しかし credentials.json は存在する状態)
export function getActiveInfo(
  accountsDir = DEFAULT_ACCOUNTS_DIR,
  credentialsPath = DEFAULT_CREDENTIALS,
  claudeJsonPath = DEFAULT_CLAUDE_JSON
) {
  const activeToken = extractToken(readJsonSafe(credentialsPath));
  if (!activeToken) return { name: null, method: null, syncBroken: false };
  const activeUuid = extractAccountUuid(readJsonSafe(claudeJsonPath));
  const accounts = listAccounts(accountsDir);
  // 1. uuid 一致 (最も信頼できる、トークン rotate に耐える)
  if (activeUuid) {
    const byUuid = accounts.find((a) => a.uuid === activeUuid);
    if (byUuid) return { name: byUuid.name, method: "uuid", syncBroken: false };
  }
  // 2. token 一致 (uuid 未 migration な既存 accounts 向け fallback)
  const byToken = accounts.find((a) => a.token === activeToken);
  if (byToken) return { name: byToken.name, method: "token", syncBroken: false };
  // 3. 両方外れた: credentials.json はあるが、どの account にも紐付かない。
  //    accounts 登録が 0 のケースは syncBroken でも何でもないので除外する。
  return { name: null, method: null, syncBroken: accounts.length > 0 };
}

// 従来互換 API: name だけ返す。呼び出し側は switchAccount など多数あるので互換維持する。
// sync_broken 情報が欲しい呼び出し側 (server.js) は getActiveInfo を直接使う。
export function getActiveAccount(
  accountsDir = DEFAULT_ACCOUNTS_DIR,
  credentialsPath = DEFAULT_CREDENTIALS,
  claudeJsonPath = DEFAULT_CLAUDE_JSON
) {
  return getActiveInfo(accountsDir, credentialsPath, claudeJsonPath).name;
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

// Anthropic の profile レスポンスを ~/.claude.json.oauthAccount 形式に変換。
// 未マッピングだと writeOAuthAccountToClaudeJson の merge で前アカウントの値が居残るため、
// アカウント identity に関わるフィールドは (API 応答に無くても) 明示 null で返す。
export function profileToOAuthAccount(profile) {
  const a = profile.account ?? {};
  const o = profile.organization ?? {};
  // profile 応答に userRateLimitTier は無い。claude_max org では org tier と一致するので流用。
  // claude_team 等では別ソースから来るためここでは推測せず null にして stale 値を排除する。
  const userRateLimitTier =
    o.organization_type === "claude_max" ? (o.rate_limit_tier ?? null) : null;
  return {
    accountUuid: a.uuid,
    emailAddress: a.email,
    displayName: a.display_name ?? null,
    organizationUuid: o.uuid,
    organizationName: o.name ?? null,
    organizationType: o.organization_type ?? null,
    organizationRole: o.role ?? null,
    organizationRateLimitTier: o.rate_limit_tier ?? null,
    userRateLimitTier,
    seatTier: o.seat_tier ?? null,
    workspaceRole: null,
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

// account JSON に oauthAccount (identity 情報) を書き込む。
// - shift add 直後 or 初回 refresh 時に profile fetch → uuid 等を埋める。
// - 既存フィールドは preserve (accessToken/refreshToken 等は書き換えない)。
// - 既に oauthAccount がある場合は merge。
export function enrichAccountIdentity(accountPath, oauthAccount) {
  if (!existsSync(accountPath)) throw new Error(`account file not found: ${accountPath}`);
  const raw = JSON.parse(readFileSync(accountPath, "utf8"));
  raw.oauthAccount = { ...(raw.oauthAccount ?? {}), ...oauthAccount };
  writeFileSync(accountPath, JSON.stringify(raw, null, 2));
  try { chmodSync(accountPath, 0o600); } catch {}
  return raw.oauthAccount;
}

// profile fetch → oauthAccount 形式に変換 → account JSON に保存。
// network 失敗は throw する (呼び出し側で catch → best-effort 扱いに)。
export async function enrichIdentityForAccount(accountPath, { fetchProfileImpl = fetchProfile } = {}) {
  const raw = readJsonSafe(accountPath);
  if (!raw) throw new Error(`account file unreadable: ${accountPath}`);
  const token = extractToken(raw);
  if (!token) throw new Error(`account has no accessToken: ${accountPath}`);
  const profile = await fetchProfileImpl(token);
  const oauthAccount = profileToOAuthAccount(profile);
  return enrichAccountIdentity(accountPath, oauthAccount);
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

// CLI エントリポイント:
//   node cli/accounts.js <name>              switchAccount 実行
//   node cli/accounts.js --enrich <name>     account に identity (uuid 等) を埋め込む (best-effort)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = "Usage: node cli/accounts.js <name> | --enrich <name>";
  if (args[0] === "--enrich") {
    const name = args[1];
    if (!name) { console.error(usage); process.exit(1); }
    const path = join(DEFAULT_ACCOUNTS_DIR, `${name}.json`);
    enrichIdentityForAccount(path)
      .then((o) => console.log(`Enriched ${name}: uuid=${o.accountUuid ?? "(none)"}`))
      .catch((e) => { console.error(`enrich failed: ${e.message}`); process.exit(1); });
  } else {
    const [name] = args;
    if (!name) { console.error(usage); process.exit(1); }
    switchAccount(name)
      .then(() => console.log(`Switched to: ${name}`))
      .catch((e) => { console.error(e.message); process.exit(1); });
  }
}
