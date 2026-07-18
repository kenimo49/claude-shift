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

// account JSON → credentials.json へ書く内容を作る。
// setupToken (1年トークン) と shift 内部フィールドは claude CLI に渡す必要が無く、
// credentials.json への secret 拡散を避けるため落とす。
export function toCredentialsPayload(accountRaw) {
  const { setupToken, _shiftIdentityError, ...rest } = accountRaw ?? {};
  return rest;
}

// credentials.json の内容を account JSON へ書き戻す (sync-back / add 用)。
// 丸コピーだと account JSON 側にしか無い setupToken / oauthAccount /
// _shiftIdentityError が破壊されるため、既存フィールドを保持して merge する。
export function mergeCredentialsIntoAccount(accountPath, credsRaw) {
  const existing = readJsonSafe(accountPath) ?? {};
  const merged = { ...existing, ...credsRaw };
  writeFileSync(accountPath, JSON.stringify(merged, null, 2));
  try { chmodSync(accountPath, 0o600); } catch {}
  return merged;
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
    // setupToken 等の shift 内部フィールドは credentials.json に持ち込まない
    const payload = toCredentialsPayload(JSON.parse(readFileSync(accountPath, "utf8")));
    writeFileSync(credentialsPath, JSON.stringify(payload, null, 2));
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
// 判定順序 (uuid authoritative の原則):
//   1. activeUuid あり + accounts に一致する uuid あり → { method: "uuid" }
//   2. activeUuid あり + 一致無し → { syncBroken: true } — 意図: claude CLI が
//      未登録アカウントで動いている状態を token fallback で "healthy" に見せない。
//      (codex-review High #5 指摘: uuid authoritative の原則を fallback で崩さない)
//   3. activeUuid 無し (~/.claude.json 未整備 or 破損) → token マッチを試みる。
//      これは identity source が無い環境向けの fallback で、issue #5 の対策以前と同じ挙動。
//   4. 上記全て外れ + accounts 登録 1 件以上 → syncBroken=true
//   5. accounts 登録 0 件 → syncBroken=false (broken にする対象すら無い)
//
// 返り値: { name, method, syncBroken }
//   - name: 解決した account 名 (null なら不明)
//   - method: "uuid" | "token" | null
//   - syncBroken: true なら claude CLI と shift のアクティブが一致していない
export function getActiveInfo(
  accountsDir = DEFAULT_ACCOUNTS_DIR,
  credentialsPath = DEFAULT_CREDENTIALS,
  claudeJsonPath = DEFAULT_CLAUDE_JSON
) {
  const activeToken = extractToken(readJsonSafe(credentialsPath));
  if (!activeToken) return { name: null, method: null, syncBroken: false };
  const activeUuid = extractAccountUuid(readJsonSafe(claudeJsonPath));
  const accounts = listAccounts(accountsDir);

  if (activeUuid) {
    // uuid authoritative モード: claude CLI が identity を知っているので uuid のみで判定。
    const byUuid = accounts.find((a) => a.uuid === activeUuid);
    if (byUuid) return { name: byUuid.name, method: "uuid", syncBroken: false };
    // 一致無し → claude CLI が shift 未登録の account で動いている or accounts の
    // uuid migration が遅れている。いずれも "healthy" に見せてはいけない。
    return { name: null, method: null, syncBroken: accounts.length > 0 };
  }

  // activeUuid 未提供 (~/.claude.json 未整備 / 破損 / 旧 claude CLI): token fallback。
  const byToken = accounts.find((a) => a.token === activeToken);
  if (byToken) return { name: byToken.name, method: "token", syncBroken: false };
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
//
// race-safety (codex-review Medium): profile fetch は network 呼び出しなので秒〜十秒単位。
// その間に別プロセス (switchAccount / 手動編集) が同 account JSON を書き換えている可能性が
// あるため、書き込み直前にもう一度 read して最新状態に oauthAccount だけ merge する。
// 完全な lock ではないが lost update の window を最小化 (「関数エントリ→書き込み」から
// 「read→書き込み」に短縮)。
export function enrichAccountIdentity(accountPath, oauthAccount) {
  if (!existsSync(accountPath)) throw new Error(`account file not found: ${accountPath}`);
  // 書き込み直前に最新版を読み直す (race window 縮小)
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
  const merged = enrichAccountIdentity(accountPath, oauthAccount);
  // 成功したので以前の enrich エラー記録があれば clear
  clearIdentityEnrichError(accountPath);
  return merged;
}

// identity migration の状態を診断可能な形で account JSON に残す。
// codex-review Medium (silent fail 対策): fetch-usage 経路の migration 失敗は
// 従来 warn ログのみで下流に見えなかった。account JSON に `_shiftIdentityError`
// フィールドとして永続化することで、server 経由で popup / debug に露出できる。
export function recordIdentityEnrichError(accountPath, error) {
  if (!existsSync(accountPath)) return;
  try {
    const raw = JSON.parse(readFileSync(accountPath, "utf8"));
    raw._shiftIdentityError = {
      at: Date.now(),
      message: String(error?.message ?? error ?? "unknown"),
    };
    writeFileSync(accountPath, JSON.stringify(raw, null, 2));
    try { chmodSync(accountPath, 0o600); } catch {}
  } catch {
    // 記録自体が失敗した場合は諦める (元の migration 失敗は上流でログ済み)
  }
}

export function clearIdentityEnrichError(accountPath) {
  if (!existsSync(accountPath)) return;
  try {
    const raw = JSON.parse(readFileSync(accountPath, "utf8"));
    if (!raw._shiftIdentityError) return;
    delete raw._shiftIdentityError;
    writeFileSync(accountPath, JSON.stringify(raw, null, 2));
    try { chmodSync(accountPath, 0o600); } catch {}
  } catch {
    // clear 失敗は無害 (次回成功で再度 clear される)
  }
}

// server / debug 向けに account の identity 状態を返す。
//   hasUuid: uuid migration 済みか
//   lastError: 直近の migration 失敗記録 (成功したら clear されている)
export function getIdentityStatus(accountPath) {
  const raw = readJsonSafe(accountPath);
  return {
    hasUuid: !!extractAccountUuid(raw),
    lastError: raw?._shiftIdentityError ?? null,
  };
}

export async function switchAccount(
  name,
  {
    accountsDir = DEFAULT_ACCOUNTS_DIR,
    credentialsPath = DEFAULT_CREDENTIALS,
    claudeJsonPath = DEFAULT_CLAUDE_JSON,
    skipProfileFetch = false,
    fetchProfileImpl = fetchProfile,
  } = {}
) {
  const target = join(accountsDir, `${name}.json`);
  if (!existsSync(target)) throw new Error(`Account '${name}' not found`);

  // token-only アカウント (setupToken のみ、claudeAiOauth 無し) は credentials.json
  // 切替の対象外。claude CLI が refresh を試みて壊れるため、env var 利用を案内する。
  const targetRaw = readJsonSafe(target);
  if (!extractToken(targetRaw)) {
    if (targetRaw?.setupToken?.accessToken) {
      throw new Error(
        `Account '${name}' は setup-token のみ登録です (login credentials 無し)。\n` +
        `credentials.json 切替は /login 系アカウント専用なので、環境変数で使ってください:\n` +
        `  eval "$(shift.sh env ${name})"   # CLAUDE_CODE_OAUTH_TOKEN を export`
      );
    }
    throw new Error(`Account '${name}' has no accessToken`);
  }

  // sync-back: 現在の credentials.json を今のactiveアカウントに書き戻す。
  // 丸コピーではなく merge (account JSON 側の setupToken / oauthAccount を保持)。
  const active = getActiveAccount(accountsDir, credentialsPath);
  if (active && active !== name && existsSync(credentialsPath)) {
    const credsRaw = readJsonSafe(credentialsPath);
    if (credsRaw) mergeCredentialsIntoAccount(join(accountsDir, `${active}.json`), credsRaw);
  }

  // credentials 切替 (setupToken 等の shift 内部フィールドは持ち込まない)
  mkdirSync(dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, JSON.stringify(toCredentialsPayload(targetRaw), null, 2));
  try { chmodSync(credentialsPath, 0o600); } catch {}

  // ~/.claude.json の oauthAccount を新アカウントに合わせて更新
  // 失敗しても切替自体は成功扱い（credentialsは既に更新済み）
  if (!skipProfileFetch) {
    try {
      const token = extractToken(readJsonSafe(target));
      if (token) {
        const profile = await fetchProfileImpl(token);
        const oauthAccount = profileToOAuthAccount(profile);
        writeOAuthAccountToClaudeJson(oauthAccount, claudeJsonPath);
        // account 側にも identity を書き戻す。usage ポーリングの enrich に頼ると
        // pollExclude 環境で uuid が埋まらず getActiveInfo が syncBroken になる。
        enrichAccountIdentity(target, oauthAccount);
      }
    } catch (e) {
      console.error(`[switchAccount] oauthAccount update failed: ${e.message}`);
    }
  }

  return name;
}

// CLI エントリポイント:
//   node cli/accounts.js <name>                switchAccount 実行
//   node cli/accounts.js --enrich <name>       account に identity (uuid 等) を埋め込む (best-effort)
//   node cli/accounts.js --merge-creds <name>  credentials.json を account JSON へ merge 保存
//                                              (setupToken 等を保持。shift.sh add / sync-back 用)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = "Usage: node cli/accounts.js <name> | --enrich <name> | --merge-creds <name>";
  if (args[0] === "--merge-creds") {
    const name = args[1];
    if (!name) { console.error(usage); process.exit(1); }
    const credsRaw = readJsonSafe(DEFAULT_CREDENTIALS);
    if (!credsRaw) { console.error(`credentials.json が読めません: ${DEFAULT_CREDENTIALS}`); process.exit(1); }
    mkdirSync(DEFAULT_ACCOUNTS_DIR, { recursive: true });
    mergeCredentialsIntoAccount(join(DEFAULT_ACCOUNTS_DIR, `${name}.json`), credsRaw);
    console.log(`Saved as: ${join(DEFAULT_ACCOUNTS_DIR, `${name}.json`)}`);
  } else if (args[0] === "--enrich") {
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
