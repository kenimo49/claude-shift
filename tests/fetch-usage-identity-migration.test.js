import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUsageForAccount } from "../cli/fetch-usage.js";

// issue #5: refresh 成功時に oauthAccount が未保存なら profile fetch で自動 migration。
// fetch-usage.js は enrichIdentityForAccount を module 内から import している。
// unit test では account JSON を作って refresh フローを走らせ、
// account JSON に uuid が書き込まれることを確認する。

function makeAccount({ expiresAt = Date.now() - 1000, hasIdentity = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "cs-mig-"));
  const path = join(tmp, "acct.json");
  const raw = {
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-OLD",
      refreshToken: "sk-ant-ort01-REF",
      expiresAt,
    },
  };
  if (hasIdentity) raw.oauthAccount = { accountUuid: "uuid-EXISTING" };
  writeFileSync(path, JSON.stringify(raw, null, 2));
  return {
    tmp,
    account: {
      name: "acct",
      path,
      token: "sk-ant-oat01-OLD",
      refreshToken: "sk-ant-ort01-REF",
      expiresAt,
    },
  };
}

// enrichIdentityForAccount は accounts.js 内部で fetchProfile を直接呼ぶので、
// この unit test では global fetch をスタブして profile 応答を返させる。
function stubGlobalFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test("refresh 成功 + uuid 未保存 → profile fetch で自動 migration (issue #5)", async () => {
  const { tmp, account } = makeAccount({ hasIdentity: false });
  const restoreFetch = stubGlobalFetch(async (url) => {
    // enrichIdentityForAccount 内から呼ばれる profile fetch
    assert.match(String(url), /api\/oauth\/profile/);
    return {
      ok: true,
      json: async () => ({
        account: { uuid: "uuid-MIGRATED", email: "acct@example.com" },
        organization: { uuid: "org-1", organization_type: "claude_max", rate_limit_tier: "pro" },
      }),
    };
  });
  try {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 15 } }),
    });
    const refreshImpl = async () => ({
      accessToken: "sk-ant-oat01-NEW",
      refreshToken: "sk-ant-ort01-NEXT",
      expiresAt: Date.now() + 3600 * 1000,
    });
    const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
    assert.equal(r.ok, true);
    // account JSON に uuid が書き込まれているはず
    const raw = JSON.parse(readFileSync(account.path, "utf8"));
    assert.equal(raw.oauthAccount?.accountUuid, "uuid-MIGRATED");
  } finally {
    restoreFetch();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh 成功 + uuid 既に保存済 → profile fetch を呼ばない (skip)", async () => {
  const { tmp, account } = makeAccount({ hasIdentity: true });
  let profileCalled = 0;
  const restoreFetch = stubGlobalFetch(async () => {
    profileCalled += 1;
    return { ok: true, json: async () => ({}) };
  });
  try {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 20 } }),
    });
    const refreshImpl = async () => ({
      accessToken: "sk-ant-oat01-NEW",
      refreshToken: "sk-ant-ort01-NEXT",
      expiresAt: Date.now() + 3600 * 1000,
    });
    const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
    assert.equal(r.ok, true);
    assert.equal(profileCalled, 0, "既に uuid があるので profile fetch は skip");
  } finally {
    restoreFetch();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("profile fetch が失敗しても refresh 自体は成功扱い (best-effort)", async () => {
  const { tmp, account } = makeAccount({ hasIdentity: false });
  const restoreFetch = stubGlobalFetch(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: "server error" }),
  }));
  try {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 30 } }),
    });
    const refreshImpl = async () => ({
      accessToken: "sk-ant-oat01-NEW",
      refreshToken: "sk-ant-ort01-NEXT",
      expiresAt: Date.now() + 3600 * 1000,
    });
    // console.warn を握って noise を抑える
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, true, "profile fetch 失敗しても refresh 自体は成功");
      const raw = JSON.parse(readFileSync(account.path, "utf8"));
      assert.equal(raw.oauthAccount, undefined, "uuid は保存されない (次回リトライ)");
    } finally { console.warn = originalWarn; }
  } finally {
    restoreFetch();
    rmSync(tmp, { recursive: true, force: true });
  }
});
