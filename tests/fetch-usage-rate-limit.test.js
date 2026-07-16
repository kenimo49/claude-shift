import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUsageForAccount, parseRetryAfter } from "../cli/fetch-usage.js";

function makeAccount(overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "cs-fu-rl-"));
  const path = join(tmp, "acct.json");
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: overrides.accessToken ?? "sk-ant-oat01-OLD",
        refreshToken: overrides.refreshToken ?? "sk-ant-ort01-REF",
        expiresAt: overrides.expiresAt ?? Date.now() + 60 * 60 * 1000,
      },
    })
  );
  return {
    tmp,
    account: {
      name: "acct",
      path,
      token: overrides.accessToken ?? "sk-ant-oat01-OLD",
      refreshToken: overrides.refreshToken ?? "sk-ant-ort01-REF",
      expiresAt: overrides.expiresAt ?? Date.now() + 60 * 60 * 1000,
    },
  };
}

// mock res object の Response ライクなヘッダ API
function headerBag(map = {}) {
  return { get: (name) => map[name] ?? map[name.toLowerCase()] ?? null };
}

describe("parseRetryAfter (issue #6)", () => {
  test("delta-seconds (整数) を ms に変換", () => {
    assert.equal(parseRetryAfter("30"), 30_000);
    assert.equal(parseRetryAfter("0"), 0);
    assert.equal(parseRetryAfter("120"), 120_000);
  });

  test("HTTP-date を now との差 (ms) に変換", () => {
    const now = 1_700_000_000_000;
    const future = new Date(now + 45_000).toUTCString();
    const past = new Date(now - 10_000).toUTCString();
    assert.equal(parseRetryAfter(future, now), 45_000);
    assert.equal(parseRetryAfter(past, now), 0); // 過去日付は 0 に丸める
  });

  test("null / 空 / 不正値は null", () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter(""), null);
    assert.equal(parseRetryAfter("abc"), null);
    assert.equal(parseRetryAfter("-5"), null); // 負値は正規表現でマッチしない
  });

  test("空白入りの delta-seconds は前後 trim して解釈", () => {
    assert.equal(parseRetryAfter("  15  "), 15_000);
  });

  // codex-review Medium: 巨大整数の clamp
  test("巨大 delta-seconds は 24h で clamp (unsafe int 対策)", () => {
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    // 1 年分の秒数を渡しても 24h でカットされる
    assert.equal(parseRetryAfter(String(365 * 24 * 60 * 60)), 24 * 60 * 60 * 1000);
    // MAX_SAFE_INTEGER クラスも clamp される (unsafe になる前に頭打ち)
    assert.equal(parseRetryAfter("9999999999999"), 24 * 60 * 60 * 1000);
  });

  test("巨大 HTTP-date も 24h で clamp", () => {
    const now = 1_700_000_000_000;
    const farFuture = new Date(now + 7 * 24 * 60 * 60 * 1000).toUTCString();
    assert.equal(parseRetryAfter(farFuture, now), 24 * 60 * 60 * 1000);
  });

  // codex-review Medium: カンマ結合された値
  test("複数値カンマ結合 → 最小待機を採用", () => {
    assert.equal(parseRetryAfter("60, 120"), 60_000);
    assert.equal(parseRetryAfter("300,120,60"), 60_000);
  });

  test("カンマ結合中の不正値は無視、有効値の最小を採用", () => {
    assert.equal(parseRetryAfter("garbage, 30, -5"), 30_000);
  });

  test("カンマ結合が全部不正なら null", () => {
    assert.equal(parseRetryAfter("garbage, -5, abc"), null);
  });
});

describe("fetchUsageForAccount: 429 rate-limit distinction (issue #6)", () => {
  test("expiresAt 有効 & 429 → refresh せず rate_limited", async () => {
    const { tmp, account } = makeAccount(); // expiresAt = 1h 先
    try {
      let refreshCalled = 0;
      const fetchImpl = async () => ({
        ok: false,
        status: 429,
        headers: headerBag({ "Retry-After": "60" }),
      });
      const refreshImpl = async () => { refreshCalled += 1; return {}; };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "rate_limited");
      assert.equal(r.http_status, 429);
      assert.equal(r.needs_reauth, false);
      assert.equal(r.retry_after_ms, 60_000);
      assert.equal(refreshCalled, 0, "refresh は 1 度も呼ばれない");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Retry-After 無しでも rate_limited として返る (retry_after_ms=null)", async () => {
    const { tmp, account } = makeAccount();
    try {
      const fetchImpl = async () => ({
        ok: false,
        status: 429,
        headers: headerBag({}),
      });
      const r = await fetchUsageForAccount(account, {
        fetchImpl,
        refreshImpl: async () => { throw new Error("should not be called"); },
      });
      assert.equal(r.error_kind, "rate_limited");
      assert.equal(r.retry_after_ms, null);
      assert.match(r.error, /rate limited/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("expiresAt 切れ & 429 → 期限切れ由来として refresh 経路", async () => {
    // isExpired が true になれば proactive refresh される → 429 は refresh 経路に流れる
    const { tmp, account } = makeAccount({ expiresAt: Date.now() - 1000 });
    try {
      let refreshCalled = 0;
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ five_hour: { utilization: 15 } }),
        headers: headerBag({}),
      });
      const refreshImpl = async () => {
        refreshCalled += 1;
        return {
          accessToken: "sk-ant-oat01-NEW",
          refreshToken: "sk-ant-ort01-NEXT",
          expiresAt: Date.now() + 3600 * 1000,
        };
      };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, true);
      assert.equal(refreshCalled, 1, "expired なら proactive refresh は走る (これが本来の 429 想定パス)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("post-refresh 429 → rate_limited 扱い (needs_reauth ではない)", async () => {
    // proactive refresh 後、fetch がまた 429 を返した場合。新 token でも rate-limit なら
    // 「再ログインしても解決しない」= rate_limited。rotation は 1 回消費してしまっているが、
    // これ以上の消費を止める。
    const { tmp, account } = makeAccount({ expiresAt: Date.now() - 1000 });
    try {
      const fetchImpl = async () => ({
        ok: false,
        status: 429,
        headers: headerBag({ "Retry-After": "10" }),
      });
      const refreshImpl = async () => ({
        accessToken: "sk-ant-oat01-NEW",
        refreshToken: "sk-ant-ort01-NEXT",
        expiresAt: Date.now() + 3600 * 1000,
      });
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "rate_limited");
      assert.equal(r.needs_reauth, false, "429 は needs_reauth ではない (再ログインでは直らない)");
      assert.equal(r.retry_after_ms, 10_000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("401 は今まで通り refresh 経路 (rate_limited にはならない)", async () => {
    const { tmp, account } = makeAccount();
    try {
      let call = 0;
      let refreshCalled = 0;
      const fetchImpl = async () => {
        call += 1;
        if (call === 1) return { ok: false, status: 401, headers: headerBag({}) };
        return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 10 } }), headers: headerBag({}) };
      };
      const refreshImpl = async () => {
        refreshCalled += 1;
        return {
          accessToken: "sk-ant-oat01-NEW",
          refreshToken: "sk-ant-ort01-NEXT",
          expiresAt: Date.now() + 3600 * 1000,
        };
      };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, true);
      assert.equal(refreshCalled, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // codex-review High: expiresAt が null (未保存) のとき、429 は "有効 token" 扱いに
  // しない。rate_limited 分岐に落ちず、通常の refresh 経路に流れる。
  test("expiresAt=null & 429 → rate_limited にはならず refresh 経路 (High)", async () => {
    const { tmp, account } = makeAccount(); // account object を作る
    account.expiresAt = null; // 明示的に null にする (makeAccount 側の ?? default 回避)
    try {
      let call = 0;
      let refreshCalled = 0;
      const fetchImpl = async () => {
        call += 1;
        if (call === 1) return { ok: false, status: 429, headers: headerBag({}) };
        return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 10 } }), headers: headerBag({}) };
      };
      const refreshImpl = async () => {
        refreshCalled += 1;
        return {
          accessToken: "sk-ant-oat01-NEW",
          refreshToken: "sk-ant-ort01-NEXT",
          expiresAt: Date.now() + 3600 * 1000,
        };
      };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      // 期限切れ由来の 429 として refresh → retry で成功する
      assert.equal(r.ok, true);
      assert.equal(refreshCalled, 1);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // codex-review Medium: proactive refresh 後の 429 で rotation はちょうど 1 回だけ消費
  test("proactive refresh 直後の 429 → rotation ちょうど 1 回消費 (以降を止める)", async () => {
    const { tmp, account } = makeAccount({ expiresAt: Date.now() - 1000 });
    try {
      let refreshCalled = 0;
      const fetchImpl = async () => ({
        ok: false,
        status: 429,
        headers: headerBag({ "Retry-After": "60" }),
      });
      const refreshImpl = async () => {
        refreshCalled += 1;
        return {
          accessToken: "sk-ant-oat01-NEW",
          refreshToken: "sk-ant-ort01-NEXT",
          expiresAt: Date.now() + 3600 * 1000,
        };
      };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      // proactive refresh 1 回のみ (以降 fetch で 429 が来ても rate_limited 分岐で早期 return)
      assert.equal(refreshCalled, 1, "proactive 1 回のみ、追加 rotation 消費しない");
      assert.equal(r.error_kind, "rate_limited");
      assert.equal(r.needs_reauth, false);
      assert.equal(r.retry_after_ms, 60_000);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // codex-review Medium: 401 → refresh → retry で 429 に落ちる枝 ("rotation wasted" 明示)
  test("401 → refresh → 429 (post-refresh 経路) → rate_limited + rotation wasted 明示", async () => {
    const { tmp, account } = makeAccount(); // expiresAt 1h 先
    try {
      let call = 0;
      let refreshCalled = 0;
      const fetchImpl = async () => {
        call += 1;
        if (call === 1) return { ok: false, status: 401, headers: headerBag({}) };
        return { ok: false, status: 429, headers: headerBag({ "Retry-After": "45" }) };
      };
      const refreshImpl = async () => {
        refreshCalled += 1;
        return {
          accessToken: "sk-ant-oat01-NEW",
          refreshToken: "sk-ant-ort01-NEXT",
          expiresAt: Date.now() + 3600 * 1000,
        };
      };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(refreshCalled, 1, "401 で 1 回 refresh、以降 429 では refresh しない");
      assert.equal(r.error_kind, "rate_limited");
      assert.equal(r.retry_after_ms, 45_000);
      assert.equal(r.needs_reauth, false);
      // Low: post-refresh 経路では error 文言に rotation wasted と retry_after が含まれる
      assert.match(r.error, /Retry-After: 45s/);
      assert.match(r.error, /rotation wasted/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("post-refresh 401 → post_refresh_reauth (needs_reauth=true) は従来通り", async () => {
    const { tmp, account } = makeAccount({ expiresAt: Date.now() - 1000 });
    try {
      const fetchImpl = async () => ({ ok: false, status: 401, headers: headerBag({}) });
      const refreshImpl = async () => ({
        accessToken: "sk-ant-oat01-NEW",
        refreshToken: "sk-ant-ort01-NEXT",
        expiresAt: Date.now() + 3600 * 1000,
      });
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "post_refresh_reauth");
      assert.equal(r.needs_reauth, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
