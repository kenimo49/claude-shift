#!/usr/bin/env node
// 各アカウントの usage を api.anthropic.com から取得する
// token 期限切れは refreshToken で自動更新、失敗は明示的に返す。

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readFileSync as _readFileSync } from "fs";
import {
  extractToken,
  extractRefreshToken,
  extractExpiresAt,
  extractAccountUuid,
  writeAccountCreds,
  enrichIdentityForAccount,
  recordIdentityEnrichError,
} from "./accounts.js";
import { refreshOAuthToken } from "./token-refresh.js";

const DEFAULT_ACCOUNTS_DIR = join(homedir(), ".claude-shift", "accounts");
const API_URL = "https://api.anthropic.com/api/oauth/usage";

// expiresAt の何 ms 前に proactive refresh するか (clock skew と API 呼び出し余裕を含めて 60 秒)
const EXPIRY_SKEW_MS = 60 * 1000;
// refresh を促す HTTP status (401 は当然、429 は期限切れ token で観測、403 は念のため)
const REAUTH_STATUS = new Set([401, 403, 429]);

export async function fetchUsage(token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(API_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function loadAccounts(accountsDir = DEFAULT_ACCOUNTS_DIR) {
  let entries;
  try {
    entries = readdirSync(accountsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => {
      const name = e.name.replace(/\.json$/, "");
      const path = join(accountsDir, e.name);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      return {
        name,
        path,
        token: extractToken(raw),
        refreshToken: extractRefreshToken(raw),
        expiresAt: extractExpiresAt(raw),
      };
    })
    .filter((a) => a.token);
}

// 期限切れ or 期限直前なら true
function isExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  return expiresAt - now <= EXPIRY_SKEW_MS;
}

// 1 アカウント分の refresh + fetch フロー。
// - expiresAt を見て事前 refresh
// - fetch が 401/403/429 なら 1 回だけ refresh してリトライ
// - refresh に失敗した場合は needs_reauth: true を返す
// 戻り値: { name, ok, data?, error?, error_kind?, http_status?, needs_reauth?, refreshed? }
export async function fetchUsageForAccount(
  account,
  {
    fetchImpl = fetch,
    refreshImpl = refreshOAuthToken,
    writeback = writeAccountCreds,
    now = () => Date.now(),
  } = {}
) {
  let token = account.token;
  let refreshedThisCall = false;

  const tryRefresh = async (reason) => {
    if (!account.refreshToken) {
      return { needs_reauth: true, error_kind: "no_refresh_token", error: `${reason}: refreshToken 未保存` };
    }
    try {
      const next = await refreshImpl(account.refreshToken);
      account.refreshToken = next.refreshToken;
      account.expiresAt = next.expiresAt;
      token = next.accessToken;
      refreshedThisCall = true;
      try {
        const result = writeback(account.path, next);
        // active account の mirror が失敗した / CAS で skip した場合は silent にしない。
        // issue #3 の再発 (「silent に古いデータで表示」) を防ぐため、明示的にログ。
        if (result?.mirrorError) {
          console.error(`[fetch-usage] ${account.name}: credentials.json mirror failed: ${result.mirrorError}`);
        } else if (result?.mirrorSkipped) {
          console.warn(`[fetch-usage] ${account.name}: credentials.json mirror skipped (${result.mirrorSkipped})`);
        }
      } catch (e) {
        // account JSON への書き戻し自体の失敗はログ相当だが fetch は続行する
        console.error(`[fetch-usage] ${account.name}: writeback failed: ${e.message}`);
      }
      // issue #5: identity migration
      // account JSON に oauthAccount.accountUuid が未保存なら、新 token を使って
      // profile fetch し埋め込む。既存 accounts の自動 migration 用。
      // 失敗しても refresh 自体は続行 (best-effort) するが、
      // codex-review Medium 対策として失敗を account JSON に永続化して下流に露出する
      // (`_shiftIdentityError`, server.js の buildUsagePayload 経由で popup / debug から見える)。
      try {
        const raw = JSON.parse(_readFileSync(account.path, "utf8"));
        if (!extractAccountUuid(raw)) {
          try {
            await enrichIdentityForAccount(account.path);
            // 成功: enrichIdentityForAccount 内で clearIdentityEnrichError 済み
          } catch (enrichErr) {
            console.warn(`[fetch-usage] ${account.name}: identity enrich failed: ${enrichErr.message}`);
            recordIdentityEnrichError(account.path, enrichErr);
          }
        }
      } catch (e) {
        // account JSON 自体が読めない: これは refresh 中に既に問題が出るはずだが、念のため
        console.warn(`[fetch-usage] ${account.name}: identity migration check skipped: ${e.message}`);
      }
      return { ok: true };
    } catch (e) {
      // needsReauth は duck-typed で判定 (RefreshError instanceof チェックは DI mock で通らない)
      const needs = !!e?.needsReauth;
      return {
        needs_reauth: needs,
        error_kind: "refresh_failed",
        http_status: e?.status ?? null,
        error: `${reason}: ${e.message}`,
      };
    }
  };

  // proactive: expiresAt が過ぎている / 直前
  if (isExpired(account.expiresAt, now())) {
    const r = await tryRefresh("proactive refresh");
    if (!r.ok) {
      return { name: account.name, ok: false, refreshed: refreshedThisCall, ...r };
    }
  }

  try {
    const data = await fetchUsage(token, { fetchImpl });
    return { name: account.name, ok: true, refreshed: refreshedThisCall, data };
  } catch (e) {
    const status = e?.status ?? null;
    if (status && REAUTH_STATUS.has(status) && !refreshedThisCall) {
      // 401/403/429 → refresh してリトライを 1 回だけ
      // ただし proactive refresh を既に行っているなら、直後の 401 は
      // 「新 token でも API 側が拒否している」= refresh token rotation を
      // 追加消費しても解決しない状況なので、needs_reauth として即返す。
      const r = await tryRefresh(`fetch HTTP ${status}`);
      if (!r.ok) {
        return {
          name: account.name,
          ok: false,
          refreshed: refreshedThisCall,
          http_status: status,
          ...r,
        };
      }
      try {
        const data = await fetchUsage(token, { fetchImpl });
        return { name: account.name, ok: true, refreshed: refreshedThisCall, data };
      } catch (e2) {
        return {
          name: account.name,
          ok: false,
          refreshed: refreshedThisCall,
          error_kind: "http_error",
          http_status: e2?.status ?? null,
          error: `retry after refresh failed: ${e2.message}`,
        };
      }
    }
    // proactive refresh 済みで再度 401/403/429 が返ったケースは needs_reauth 扱い
    const needsReauth = refreshedThisCall && status && REAUTH_STATUS.has(status);
    return {
      name: account.name,
      ok: false,
      refreshed: refreshedThisCall,
      error_kind: needsReauth ? "post_refresh_reauth" : "http_error",
      http_status: status,
      needs_reauth: needsReauth,
      error: e.message,
    };
  }
}

// 全アカウント一括取得。返り値は per-account の結果配列。
// 従来コード互換のため、成功時は { name, ...data } を、失敗時は { name, error, ... } を返す。
export async function fetchAllUsage(accountsDir) {
  const accounts = loadAccounts(accountsDir);
  const results = await Promise.all(
    accounts.map((a) => fetchUsageForAccount(a))
  );
  return results.map((r) => {
    if (r.ok) {
      return { name: r.name, refreshed: r.refreshed, ...r.data };
    }
    return {
      name: r.name,
      error: r.error,
      error_kind: r.error_kind,
      http_status: r.http_status ?? null,
      needs_reauth: !!r.needs_reauth,
      refreshed: r.refreshed,
    };
  });
}

// CLI として直接実行した場合
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const all = await fetchAllUsage();
  console.log(JSON.stringify(all, null, 2));
}
