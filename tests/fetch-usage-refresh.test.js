import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUsageForAccount } from "../cli/fetch-usage.js";

function makeAccount(overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "cs-fu-"));
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

describe("fetchUsageForAccount", () => {
  test("正常系: expiresAt が先なら refresh せず fetch のみ", async () => {
    const { tmp, account } = makeAccount();
    try {
      let refreshCalled = 0;
      const fetchImpl = async () => ({
        ok: true,
        json: async () => ({ five_hour: { utilization: 10 }, seven_day: { utilization: 5 } }),
      });
      const refreshImpl = async () => { refreshCalled += 1; return {}; };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, true);
      assert.equal(r.refreshed, false);
      assert.equal(refreshCalled, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("期限切れなら proactive refresh してから fetch", async () => {
    const { tmp, account } = makeAccount({ expiresAt: Date.now() - 1000 });
    try {
      let refreshed = false;
      const fetchImpl = async (url, opts) => {
        assert.match(opts.headers.Authorization, /Bearer sk-ant-oat01-NEW/);
        return { ok: true, json: async () => ({ five_hour: { utilization: 20 } }) };
      };
      const refreshImpl = async () => {
        refreshed = true;
        return {
          accessToken: "sk-ant-oat01-NEW",
          refreshToken: "sk-ant-ort01-NEXT",
          expiresAt: Date.now() + 3600 * 1000,
        };
      };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, true);
      assert.equal(r.refreshed, true);
      assert.equal(refreshed, true);
      // account JSON が新 token に書き換わっている
      const written = JSON.parse(readFileSync(account.path, "utf8"));
      assert.equal(written.claudeAiOauth.accessToken, "sk-ant-oat01-NEW");
      assert.equal(written.claudeAiOauth.refreshToken, "sk-ant-ort01-NEXT");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("401 で refresh してリトライ、成功したら ok", async () => {
    const { tmp, account } = makeAccount();
    try {
      let call = 0;
      const fetchImpl = async () => {
        call += 1;
        if (call === 1) {
          return { ok: false, status: 401 };
        }
        return { ok: true, json: async () => ({ five_hour: { utilization: 30 } }) };
      };
      const refreshImpl = async () => ({
        accessToken: "sk-ant-oat01-R",
        refreshToken: "sk-ant-ort01-R",
        expiresAt: Date.now() + 3600 * 1000,
      });
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, true);
      assert.equal(r.refreshed, true);
      assert.equal(call, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("429 も refresh 対象 (期限切れ token でも 429 が返る)", async () => {
    const { tmp, account } = makeAccount();
    try {
      let call = 0;
      const fetchImpl = async () => {
        call += 1;
        if (call === 1) return { ok: false, status: 429 };
        return { ok: true, json: async () => ({ five_hour: { utilization: 40 } }) };
      };
      const refreshImpl = async () => ({
        accessToken: "sk-ant-oat01-R",
        refreshToken: "sk-ant-ort01-R",
        expiresAt: Date.now() + 3600 * 1000,
      });
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refresh 失敗 (needsReauth) は needs_reauth: true で返す (duck-typing)", async () => {
    const { tmp, account } = makeAccount({ expiresAt: Date.now() - 1000 });
    try {
      const fetchImpl = async () => { throw new Error("should not fetch"); };
      const refreshImpl = async () => {
        // DI mock の raw Error に needsReauth プロパティだけ生やす
        // (RefreshError インスタンスではないので instanceof は false)
        const e = new Error("refresh rejected: HTTP 401");
        e.needsReauth = true;
        e.status = 401;
        throw e;
      };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "refresh_failed");
      // duck-typing で needsReauth プロパティを見るので true になるべき
      assert.equal(r.needs_reauth, true);
      assert.equal(r.http_status, 401);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refresh 失敗で needsReauth なし (5xx 系) は needs_reauth: false", async () => {
    const { tmp, account } = makeAccount({ expiresAt: Date.now() - 1000 });
    try {
      const fetchImpl = async () => { throw new Error("should not fetch"); };
      const refreshImpl = async () => {
        const e = new Error("refresh failed: HTTP 503");
        e.status = 503;
        throw e;
      };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, false);
      assert.equal(r.needs_reauth, false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refreshToken 未保存で期限切れは needs_reauth", async () => {
    const { tmp, account } = makeAccount({
      expiresAt: Date.now() - 1000,
      refreshToken: null,
    });
    account.refreshToken = null;
    try {
      const r = await fetchUsageForAccount(account, {
        fetchImpl: async () => { throw new Error("should not fetch"); },
        refreshImpl: async () => { throw new Error("should not refresh"); },
      });
      assert.equal(r.ok, false);
      assert.equal(r.needs_reauth, true);
      assert.equal(r.error_kind, "no_refresh_token");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("500 系エラーは refresh せずそのまま返す (http_error)", async () => {
    const { tmp, account } = makeAccount();
    try {
      let refreshCalled = 0;
      const fetchImpl = async () => ({ ok: false, status: 503 });
      const refreshImpl = async () => { refreshCalled += 1; };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "http_error");
      assert.equal(r.http_status, 503);
      assert.equal(refreshCalled, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
