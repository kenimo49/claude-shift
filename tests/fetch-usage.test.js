import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccounts, fetchUsage } from "../cli/fetch-usage.js";

function writeAccount(dir, name, data) {
  mkdirSync(join(dir, "accounts"), { recursive: true });
  writeFileSync(join(dir, "accounts", `${name}.json`), JSON.stringify(data));
}

describe("loadAccounts", () => {
  test("claudeAiOauth.accessToken 形式を読む", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cs-load-"));
    try {
      writeAccount(tmp, "acctA", {
        claudeAiOauth: { accessToken: "sk-ant-oat01-AAA", refreshToken: "ref" },
      });
      const accounts = loadAccounts(join(tmp, "accounts"));
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].name, "acctA");
      assert.equal(accounts[0].token, "sk-ant-oat01-AAA");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("accessToken フラット形式を読む", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cs-load2-"));
    try {
      writeAccount(tmp, "acctB", { accessToken: "sk-ant-oat01-BBB" });
      const accounts = loadAccounts(join(tmp, "accounts"));
      assert.equal(accounts[0].token, "sk-ant-oat01-BBB");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("token がないファイルは除外される", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cs-load3-"));
    try {
      writeAccount(tmp, "empty", { someOtherField: "value" });
      const accounts = loadAccounts(join(tmp, "accounts"));
      assert.equal(accounts.length, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("accounts ディレクトリが存在しない場合は空配列", () => {
    const accounts = loadAccounts("/nonexistent/path/accounts");
    assert.deepEqual(accounts, []);
  });

  test(".json 以外のファイルは無視される", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cs-load4-"));
    try {
      mkdirSync(join(tmp, "accounts"), { recursive: true });
      writeFileSync(join(tmp, "accounts", "notes.txt"), "ignore me");
      writeFileSync(join(tmp, "accounts", "acct.json"), JSON.stringify({ accessToken: "tok" }));
      const accounts = loadAccounts(join(tmp, "accounts"));
      assert.equal(accounts.length, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("fetchUsage", () => {
  test("200 レスポンスを JSON として返す", async () => {
    const mockResponse = {
      five_hour: { utilization: 38, resets_at: "2026-07-15T09:00:00Z" },
      seven_day: { utilization: 44, resets_at: "2026-07-19T00:00:00Z" },
    };
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => mockResponse });
    try {
      const result = await fetchUsage("sk-ant-oat01-TEST");
      assert.equal(result.five_hour.utilization, 38);
      assert.equal(result.seven_day.utilization, 44);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("HTTP エラーは Error をスローする", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    try {
      await assert.rejects(() => fetchUsage("bad-token"), /HTTP 401/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("Authorization ヘッダーに Bearer token を付ける", async () => {
    let capturedHeaders;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({}) };
    };
    try {
      await fetchUsage("sk-ant-oat01-XYZ");
      assert.match(capturedHeaders.Authorization, /Bearer sk-ant-oat01-XYZ/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
