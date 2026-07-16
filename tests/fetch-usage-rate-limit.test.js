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
