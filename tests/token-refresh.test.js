import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { refreshOAuthToken, RefreshError } from "../cli/token-refresh.js";

describe("refreshOAuthToken", () => {
  test("正常系: access_token/refresh_token/expiresAt を返す", async () => {
    const fetchImpl = async (url, opts) => {
      assert.equal(opts.method, "POST");
      assert.match(opts.headers["Content-Type"], /x-www-form-urlencoded/);
      assert.match(opts.body, /grant_type=refresh_token/);
      assert.match(opts.body, /refresh_token=sk-ant-ort01-XYZ/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "sk-ant-oat01-NEW",
          refresh_token: "sk-ant-ort01-NEXT",
          expires_in: 3600,
        }),
      };
    };
    const before = Date.now();
    const r = await refreshOAuthToken("sk-ant-ort01-XYZ", { fetchImpl });
    assert.equal(r.accessToken, "sk-ant-oat01-NEW");
    assert.equal(r.refreshToken, "sk-ant-ort01-NEXT");
    assert.ok(r.expiresAt >= before + 3600 * 1000 - 200);
    assert.ok(r.expiresAt <= before + 3600 * 1000 + 500);
  });

  test("refresh_token 未返却時は既存 refreshToken を維持", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "sk-ant-oat01-A", expires_in: 100 }),
    });
    const r = await refreshOAuthToken("sk-ant-ort01-KEEP", { fetchImpl });
    assert.equal(r.refreshToken, "sk-ant-ort01-KEEP");
  });

  test("401 は needsReauth=true をエラーに立てる", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401 });
    await assert.rejects(
      () => refreshOAuthToken("sk-ant-ort01-BAD", { fetchImpl, endpoints: ["https://x/1"] }),
      (e) => e instanceof RefreshError && e.needsReauth === true && e.status === 401
    );
  });

  test("5xx は次のエンドポイントにフォールバック", async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 502 };
      return { ok: true, status: 200, json: async () => ({ access_token: "sk-ant-oat01-Z", expires_in: 60 }) };
    };
    const r = await refreshOAuthToken("sk-ant-ort01-FB", {
      fetchImpl,
      endpoints: ["https://x/1", "https://x/2"],
    });
    assert.equal(r.accessToken, "sk-ant-oat01-Z");
    assert.equal(calls, 2);
  });

  test("refreshToken 空文字はエラー", async () => {
    await assert.rejects(() => refreshOAuthToken(""), /refreshToken is required/);
  });

  test("全エンドポイント失敗時は最終ステータスでスロー", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500 });
    await assert.rejects(
      () => refreshOAuthToken("sk-ant-ort01-x", { fetchImpl, endpoints: ["https://x/1", "https://x/2"] }),
      (e) => e instanceof RefreshError && e.status === 500 && !e.needsReauth
    );
  });
});
