// setup-token (`claude setup-token` が発行する1年有効の長期トークン) の管理
//
// login (claudeAiOauth) との併存が前提:
//   accounts/<name>.json = {
//     claudeAiOauth: {...},   // /login 由来 (refresh rotation あり)
//     oauthAccount: {...},    // identity
//     setupToken: { accessToken, issuedAt, expiresAt }  // ← このモジュールが管理
//   }
//
// setup-token には refreshToken が無く rotation が起きないため、
// 複数マシン運用や usage ポーリングでの refresh 競合を回避できる
// (docs/knowledge/multi-device-token-conflict.md)。

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_ACCOUNTS_DIR,
  extractAccountUuid,
  fetchProfile,
  profileToOAuthAccount,
  enrichAccountIdentity,
} from "./accounts.js";
import { saveSetupTokenIssuance } from "./db.js";

export const SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
// 公式仕様は1年有効。発行応答に期限は含まれないため、発行時刻 + 365日 で記録する。
export const SETUP_TOKEN_TTL_MS = 365 * 24 * 3600 * 1000;
// list / usage で再発行を促す閾値
export const EXPIRY_WARN_MS = 30 * 24 * 3600 * 1000;

export function extractSetupToken(obj) {
  return obj?.setupToken?.accessToken ?? null;
}

export function extractSetupTokenExpiresAt(obj) {
  const v = obj?.setupToken?.expiresAt ?? null;
  return v == null ? null : Number(v);
}

export function isSetupTokenExpired(obj, now = Date.now()) {
  const expiresAt = extractSetupTokenExpiresAt(obj);
  if (expiresAt == null) return false;
  return expiresAt <= now;
}

// setup-token を account JSON に merge 保存する。
// - 既存の claudeAiOauth / oauthAccount / その他フィールドは保持 (login 併存)
// - account JSON が無ければ token-only アカウントとして新規作成
// - DB (setup_tokens テーブル) に発行記録を append
export function addSetupToken(
  name,
  token,
  { accountsDir = DEFAULT_ACCOUNTS_DIR, dataDir, issuedAt = Date.now() } = {}
) {
  const trimmed = String(token ?? "").trim();
  if (!trimmed.startsWith(SETUP_TOKEN_PREFIX)) {
    throw new Error(
      `setup-token は '${SETUP_TOKEN_PREFIX}' で始まる必要があります (got: ${trimmed.slice(0, 16)}...)`
    );
  }

  mkdirSync(accountsDir, { recursive: true });
  const path = join(accountsDir, `${name}.json`);
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

  const expiresAt = issuedAt + SETUP_TOKEN_TTL_MS;
  raw.setupToken = { accessToken: trimmed, issuedAt, expiresAt };
  writeFileSync(path, JSON.stringify(raw, null, 2));
  try { chmodSync(path, 0o600); } catch {}

  saveSetupTokenIssuance({ account: name, issuedAt, expiresAt }, dataDir);
  return { path, issuedAt, expiresAt, hadLogin: !!raw.claudeAiOauth };
}

// setup-token で identity (accountUuid 等) を enrich する。
// token-only アカウントは claudeAiOauth が無く accounts.js の enrichIdentityForAccount
// (extractToken 依存) が使えないため、setup-token の Bearer で profile を叩く版。
// setup-token で /api/oauth/profile が拒否される環境もあり得るので呼び出し側で catch する。
export async function enrichIdentityWithSetupToken(
  name,
  { accountsDir = DEFAULT_ACCOUNTS_DIR, fetchProfileImpl = fetchProfile } = {}
) {
  const path = join(accountsDir, `${name}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (extractAccountUuid(raw)) return raw.oauthAccount; // 既に identity あり
  const token = extractSetupToken(raw);
  if (!token) throw new Error(`account has no setupToken: ${path}`);
  const profile = await fetchProfileImpl(token);
  return enrichAccountIdentity(path, profileToOAuthAccount(profile));
}

// CLI エントリポイント:
//   node cli/tokens.js add <name>   stdin から token を1行読んで登録
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, name] = process.argv.slice(2);
  if (cmd !== "add" || !name) {
    console.error("Usage: node cli/tokens.js add <name>   (token は stdin から渡す)");
    process.exit(1);
  }
  const token = readFileSync(0, "utf8").trim();
  try {
    const r = addSetupToken(name, token);
    const days = Math.round((r.expiresAt - r.issuedAt) / 86400000);
    console.log(`Saved setup-token for '${name}' (${r.hadLogin ? "login併存" : "token-only"})`);
    console.log(`  expires: ${new Date(r.expiresAt).toLocaleDateString("ja-JP")} (${days}日後)`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  try {
    const o = await enrichIdentityWithSetupToken(name);
    if (o?.accountUuid) console.log(`  identity: ${o.emailAddress ?? "?"} (uuid=${o.accountUuid})`);
  } catch (e) {
    console.log(`  (identity enrich skipped: ${e.message})`);
  }
}
