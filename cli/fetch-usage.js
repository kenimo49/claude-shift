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
import { extractSetupToken, extractSetupTokenExpiresAt } from "./tokens.js";
import { refreshOAuthToken } from "./token-refresh.js";

const DEFAULT_ACCOUNTS_DIR = join(homedir(), ".claude-shift", "accounts");
const API_URL = "https://api.anthropic.com/api/oauth/usage";

// expiresAt の何 ms 前に proactive refresh するか (clock skew と API 呼び出し余裕を含めて 60 秒)
const EXPIRY_SKEW_MS = 60 * 1000;
// refresh を促す HTTP status。
// 401/403 は認証失敗系、429 は「期限切れ token で観測」した実績があるが、
// 真の rate-limit (token 健全) でも 429 は返る。issue #6 で expiresAt との
// 突き合わせで区別するようになった。
const REAUTH_STATUS = new Set([401, 403, 429]);

// RFC 7231 §7.1.3 Retry-After ヘッダをパースして「あと何 ms 待つか」を返す。
// - delta-seconds (整数秒): そのまま * 1000
// - HTTP-date: Date.parse で絶対時刻 → now との差
// - パース不能なら null (呼び出し側で fallback)
// Retry-After は現実的には数分〜数時間なので、24 時間で clamp。
// codex-review Medium 対策: 巨大整数 (MAX_SAFE_INTEGER 超) が unsafe int のまま
// retry_after_ms に入るのを防ぐ + 悪意ある / 誤設定サーバの極端値からもガード。
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

export function parseRetryAfter(headerValue, now = Date.now()) {
  if (headerValue == null) return null;
  let trimmed = String(headerValue).trim();
  if (!trimmed) return null;
  // codex-review Medium 対策: 環境によっては複数の Retry-After が "60, 120" のように
  // カンマ結合されて渡ってくる。RFC 7231 は Retry-After は単一値だが、defensive に
  // カンマ分割して各値を parse → 最小の待機時間を採用 (最短で復帰試行、無意味な長待ちを避ける)。
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    const parsed = parts.map((p) => parseRetryAfter(p, now)).filter((v) => v != null);
    if (parsed.length === 0) return null;
    return Math.min(...parsed);
  }
  // delta-seconds (RFC 7231: non-negative integer)
  if (/^\d+$/.test(trimmed)) {
    const s = parseInt(trimmed, 10);
    if (!Number.isFinite(s) || s < 0) return null;
    const ms = s * 1000;
    return Math.min(ms, RETRY_AFTER_MAX_MS);
  }
  // 単純な数値表現 (負数・小数など) は delta-seconds として不正、
  // Date.parse の環境依存 fallback (e.g. "-5" → 1970-01-01 起点解釈) にも
  // 流したくないので明示的に null。
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return null;
  // HTTP-date
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  const diff = t - now;
  if (diff <= 0) return 0;
  return Math.min(diff, RETRY_AFTER_MAX_MS);
}

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
    // Retry-After ヘッダを載せる (429 の rate-limit 分岐で使う)
    const retryAfterHeader = res.headers?.get?.("Retry-After") ?? null;
    err.retryAfterMs = parseRetryAfter(retryAfterHeader);
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
        setupToken: extractSetupToken(raw),
        setupTokenExpiresAt: extractSetupTokenExpiresAt(raw),
      };
    })
    .filter((a) => a.token || a.setupToken);
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

  // setup-token は inference 専用スコープで、usage/profile API は拒否される
  // (2026-07-18 実測: beta ヘッダ無し=403 / 有り=429 固定。login token は同時刻に 200)。
  // そのため usage 取得は login credentials が正で、setup-token を試すのは
  // login の無い token-only アカウントだけ (失敗しても他に手段が無く、
  // setup_token_invalid / expired として状態を可視化する意味がある)。
  const setupTokenValid =
    account.setupToken &&
    (account.setupTokenExpiresAt == null ||
      account.setupTokenExpiresAt - now() > EXPIRY_SKEW_MS);
  if (setupTokenValid && !account.token) {
    try {
      const data = await fetchUsage(account.setupToken, { fetchImpl });
      return { name: account.name, ok: true, refreshed: false, via: "setup_token", data };
    } catch (e) {
      const status = e?.status ?? null;
      // setup-token は1年有効なので 429 = 真の rate-limit。login token に切り替えても
      // 同じアカウント枠で 429 が返るだけなので、ここで rate_limited として返す。
      if (status === 429) {
        const retryMs = e?.retryAfterMs ?? null;
        return {
          name: account.name,
          ok: false,
          refreshed: false,
          via: "setup_token",
          error_kind: "rate_limited",
          http_status: 429,
          needs_reauth: false,
          retry_after_ms: retryMs,
          error: retryMs != null
            ? `rate limited (Retry-After: ${Math.round(retryMs / 1000)}s)`
            : "rate limited",
        };
      }
      // token-only アカウント: fallback 先が無いので setup-token の失効/無効として返す
      return {
        name: account.name,
        ok: false,
        refreshed: false,
        via: "setup_token",
        error_kind: "setup_token_invalid",
        http_status: status,
        needs_reauth: status === 401 || status === 403,
        error: `setup-token fetch failed: ${e.message} (再発行: claude setup-token → shift add-token)`,
      };
    }
  } else if (!account.token) {
    // token-only アカウントで setup-token が期限切れ/直前: login fallback が無い
    return {
      name: account.name,
      ok: false,
      refreshed: false,
      via: "setup_token",
      error_kind: "setup_token_expired",
      needs_reauth: true,
      error: "setup-token が期限切れです (再発行: claude setup-token → shift add-token)",
    };
  }

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
    const retryAfterMs = e?.retryAfterMs ?? null;

    // issue #6: 429 の rate-limit vs expired token 区別
    // expiresAt がまだ有効なのに 429 が返ったら「真の rate-limit」= token 側の問題ではない。
    // ここで refresh すると refreshToken rotation を無駄消費し、次の retry も 429 が返るだけ。
    // 早期 return して rate_limited として記録する。needs_reauth=false (再ログイン不要)。
    //
    // codex-review High: expiresAt が null (未保存 / 破損 credential) のケースは
    // 「有効」とみなさない。isExpired(null) が false を返すのに乗せると、旧 credential で
    // 429 が来たとき無条件 rate_limited になり refresh chain が走らない。「有効」=
    // 明示的に expiresAt が保存されていて、かつ isExpired が false のときだけ。
    if (status === 429 && account.expiresAt != null && !isExpired(account.expiresAt, now())) {
      return {
        name: account.name,
        ok: false,
        refreshed: refreshedThisCall,
        error_kind: "rate_limited",
        http_status: 429,
        needs_reauth: false,
        retry_after_ms: retryAfterMs,
        error: retryAfterMs != null
          ? `rate limited (Retry-After: ${Math.round(retryAfterMs / 1000)}s)`
          : "rate limited",
      };
    }

    if (status && REAUTH_STATUS.has(status) && !refreshedThisCall) {
      // 401/403 → refresh してリトライを 1 回だけ (429 は上で吸収済みだが、
      // 期限切れ由来の 429 の場合は上の isExpired 判定が false→true 側に落ちるのでここに来る)
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
        const status2 = e2?.status ?? null;
        // refresh 直後にまた 429 → 「新 token でも rate-limited」なので needs_reauth ではなく
        // rate_limited として返す (rotation は既に 1 回消費してしまったが、以降を止める)
        if (status2 === 429) {
          const retryMs2 = e2?.retryAfterMs ?? null;
          return {
            name: account.name,
            ok: false,
            refreshed: refreshedThisCall,
            error_kind: "rate_limited",
            http_status: 429,
            needs_reauth: false,
            retry_after_ms: retryMs2,
            error: retryMs2 != null
              ? `rate limited after refresh (Retry-After: ${Math.round(retryMs2 / 1000)}s, rotation wasted)`
              : "rate limited after refresh (rotation was wasted)",
          };
        }
        return {
          name: account.name,
          ok: false,
          refreshed: refreshedThisCall,
          error_kind: "http_error",
          http_status: status2,
          error: `retry after refresh failed: ${e2.message}`,
        };
      }
    }
    // proactive refresh 済みで再度 401/403 が返ったケースは needs_reauth 扱い。
    // (429 はもう rate_limited 経路で処理されているので、ここに落ちるのは 401/403 のみ)
    const needsReauth = refreshedThisCall && status && (status === 401 || status === 403);
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
      return { name: r.name, refreshed: r.refreshed, via: r.via ?? "login", ...r.data };
    }
    return {
      name: r.name,
      error: r.error,
      error_kind: r.error_kind,
      http_status: r.http_status ?? null,
      needs_reauth: !!r.needs_reauth,
      retry_after_ms: r.retry_after_ms ?? null,
      refreshed: r.refreshed,
      via: r.via ?? "login",
    };
  });
}

// CLI として直接実行した場合
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const all = await fetchAllUsage();
  console.log(JSON.stringify(all, null, 2));
}
