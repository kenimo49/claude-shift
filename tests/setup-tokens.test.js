import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSetupToken,
  extractSetupToken,
  extractSetupTokenExpiresAt,
  SETUP_TOKEN_TTL_MS,
} from "../cli/tokens.js";
import {
  toCredentialsPayload,
  mergeCredentialsIntoAccount,
  switchAccount,
} from "../cli/accounts.js";
import { saveSetupTokenIssuance, getLatestSetupTokenIssuances } from "../cli/db.js";
import { loadAccounts, fetchUsageForAccount } from "../cli/fetch-usage.js";

const TOKEN = "sk-ant-oat01-SETUPTOKEN";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("db: setup_tokens", () => {
  test("発行記録を append し、account ごとの最新を返す", () => {
    const dataDir = tmpDir("cs-db-tok-");
    try {
      saveSetupTokenIssuance({ account: "a", issuedAt: 100, expiresAt: 200 }, dataDir);
      saveSetupTokenIssuance({ account: "a", issuedAt: 300, expiresAt: 400 }, dataDir);
      saveSetupTokenIssuance({ account: "b", issuedAt: 150, expiresAt: 250 }, dataDir);
      const rows = getLatestSetupTokenIssuances(dataDir);
      assert.equal(rows.length, 2);
      const a = rows.find((r) => r.account === "a");
      assert.equal(a.issued_at, 300); // 再発行後の最新行
      assert.equal(a.expires_at, 400);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("tokens: addSetupToken", () => {
  test("token-only アカウントを新規作成し DB に記録する", () => {
    const accountsDir = tmpDir("cs-tok-a-");
    const dataDir = tmpDir("cs-tok-d-");
    try {
      const issuedAt = 1000;
      const r = addSetupToken("fresh", TOKEN, { accountsDir, dataDir, issuedAt });
      assert.equal(r.hadLogin, false);
      assert.equal(r.expiresAt, issuedAt + SETUP_TOKEN_TTL_MS);
      const raw = JSON.parse(readFileSync(join(accountsDir, "fresh.json"), "utf8"));
      assert.equal(extractSetupToken(raw), TOKEN);
      assert.equal(extractSetupTokenExpiresAt(raw), issuedAt + SETUP_TOKEN_TTL_MS);
      const rows = getLatestSetupTokenIssuances(dataDir);
      assert.equal(rows[0].account, "fresh");
      assert.equal(rows[0].issued_at, issuedAt);
    } finally {
      rmSync(accountsDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("既存 login アカウントに merge し claudeAiOauth を保持する", () => {
    const accountsDir = tmpDir("cs-tok-a-");
    const dataDir = tmpDir("cs-tok-d-");
    try {
      const path = join(accountsDir, "both.json");
      writeFileSync(
        path,
        JSON.stringify({
          claudeAiOauth: { accessToken: "sk-ant-oat01-LOGIN", refreshToken: "sk-ant-ort01-R" },
          oauthAccount: { accountUuid: "uuid-1" },
        })
      );
      const r = addSetupToken("both", TOKEN, { accountsDir, dataDir });
      assert.equal(r.hadLogin, true);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(raw.claudeAiOauth.accessToken, "sk-ant-oat01-LOGIN");
      assert.equal(raw.oauthAccount.accountUuid, "uuid-1");
      assert.equal(extractSetupToken(raw), TOKEN);
    } finally {
      rmSync(accountsDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("prefix 不正は拒否する", () => {
    const accountsDir = tmpDir("cs-tok-a-");
    const dataDir = tmpDir("cs-tok-d-");
    try {
      assert.throws(
        () => addSetupToken("bad", "sk-ant-api03-NOT-A-SETUP-TOKEN", { accountsDir, dataDir }),
        /sk-ant-oat01-/
      );
      assert.equal(existsSync(join(accountsDir, "bad.json")), false);
    } finally {
      rmSync(accountsDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("accounts: setupToken 保持", () => {
  test("toCredentialsPayload は setupToken と内部フィールドを落とす", () => {
    const payload = toCredentialsPayload({
      claudeAiOauth: { accessToken: "t" },
      oauthAccount: { accountUuid: "u" },
      setupToken: { accessToken: TOKEN },
      _shiftIdentityError: { message: "x" },
    });
    assert.deepEqual(Object.keys(payload).sort(), ["claudeAiOauth", "oauthAccount"]);
  });

  test("mergeCredentialsIntoAccount は setupToken を保持する", () => {
    const dir = tmpDir("cs-merge-");
    try {
      const path = join(dir, "a.json");
      writeFileSync(
        path,
        JSON.stringify({
          claudeAiOauth: { accessToken: "old" },
          setupToken: { accessToken: TOKEN, expiresAt: 999 },
        })
      );
      mergeCredentialsIntoAccount(path, { claudeAiOauth: { accessToken: "new" } });
      const raw = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(raw.claudeAiOauth.accessToken, "new");
      assert.equal(raw.setupToken.accessToken, TOKEN); // 破壊されない
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("switchAccount: sync-back が setupToken を破壊せず、credentials に setupToken を持ち込まない", async () => {
    const dir = tmpDir("cs-sw-");
    try {
      const accountsDir = join(dir, "accounts");
      const credentialsPath = join(dir, ".credentials.json");
      const claudeJsonPath = join(dir, ".claude.json");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(accountsDir, { recursive: true });

      // from: 現 active (setupToken 持ち)。credentials.json は refresh 済みの新 token
      writeFileSync(
        join(accountsDir, "from.json"),
        JSON.stringify({
          claudeAiOauth: { accessToken: "from-OLD" },
          setupToken: { accessToken: TOKEN, expiresAt: 999 },
        })
      );
      writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "from-OLD" } }));
      // to: 切替先 (setupToken 持ち)
      writeFileSync(
        join(accountsDir, "to.json"),
        JSON.stringify({
          claudeAiOauth: { accessToken: "to-TOKEN" },
          setupToken: { accessToken: "sk-ant-oat01-TO", expiresAt: 999 },
        })
      );

      await switchAccount("to", {
        accountsDir,
        credentialsPath,
        claudeJsonPath,
        skipProfileFetch: true,
      });

      // sync-back: from.json は credentials の内容で更新されつつ setupToken を保持
      const from = JSON.parse(readFileSync(join(accountsDir, "from.json"), "utf8"));
      assert.equal(from.setupToken.accessToken, TOKEN);
      // credentials.json には切替先の login token が入り、setupToken は持ち込まれない
      const creds = JSON.parse(readFileSync(credentialsPath, "utf8"));
      assert.equal(creds.claudeAiOauth.accessToken, "to-TOKEN");
      assert.equal("setupToken" in creds, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("switchAccount: token-only アカウントは拒否して env 利用を案内する", async () => {
    const dir = tmpDir("cs-sw-");
    try {
      const accountsDir = join(dir, "accounts");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(accountsDir, { recursive: true });
      writeFileSync(
        join(accountsDir, "tokonly.json"),
        JSON.stringify({ setupToken: { accessToken: TOKEN, expiresAt: 999 } })
      );
      await assert.rejects(
        switchAccount("tokonly", {
          accountsDir,
          credentialsPath: join(dir, ".credentials.json"),
          claudeJsonPath: join(dir, ".claude.json"),
          skipProfileFetch: true,
        }),
        /CLAUDE_CODE_OAUTH_TOKEN/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fetch-usage: setup-token 優先", () => {
  function makeAccount(overrides = {}) {
    const tmp = tmpDir("cs-fu-tok-");
    const path = join(tmp, "acct.json");
    const raw = {};
    if (overrides.login !== false) {
      raw.claudeAiOauth = {
        accessToken: "sk-ant-oat01-LOGIN",
        refreshToken: "sk-ant-ort01-REF",
        expiresAt: Date.now() + 3600 * 1000,
      };
    }
    if (overrides.setupToken !== false) {
      raw.setupToken = {
        accessToken: TOKEN,
        expiresAt: overrides.setupTokenExpiresAt ?? Date.now() + 3600 * 1000,
      };
    }
    writeFileSync(path, JSON.stringify(raw));
    return {
      tmp,
      account: {
        name: "acct",
        path,
        token: raw.claudeAiOauth?.accessToken ?? null,
        refreshToken: raw.claudeAiOauth?.refreshToken ?? null,
        expiresAt: raw.claudeAiOauth?.expiresAt ?? null,
        setupToken: raw.setupToken?.accessToken ?? null,
        setupTokenExpiresAt: raw.setupToken?.expiresAt ?? null,
      },
    };
  }

  test("token-only なら setup-token で fetch する (refresh 不消費)", async () => {
    const { tmp, account } = makeAccount({ login: false });
    try {
      let refreshCalled = 0;
      let usedToken = null;
      const fetchImpl = async (url, opts) => {
        usedToken = opts.headers.Authorization;
        return { ok: true, json: async () => ({ five_hour: { utilization: 10 } }) };
      };
      const refreshImpl = async () => { refreshCalled += 1; return {}; };
      const r = await fetchUsageForAccount(account, { fetchImpl, refreshImpl });
      assert.equal(r.ok, true);
      assert.equal(r.via, "setup_token");
      assert.equal(usedToken, `Bearer ${TOKEN}`);
      assert.equal(refreshCalled, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("login があれば setup-token は使わず login token で fetch する (usage API は setup-token 拒否のため)", async () => {
    const { tmp, account } = makeAccount();
    try {
      const calls = [];
      const fetchImpl = async (url, opts) => {
        calls.push(opts.headers.Authorization);
        return { ok: true, json: async () => ({ five_hour: { utilization: 20 } }) };
      };
      const r = await fetchUsageForAccount(account, { fetchImpl });
      assert.equal(r.ok, true);
      assert.notEqual(r.via, "setup_token");
      assert.deepEqual(calls, ["Bearer sk-ant-oat01-LOGIN"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("token-only の 429 は真の rate-limit として返す", async () => {
    const { tmp, account } = makeAccount({ login: false });
    try {
      const fetchImpl = async () => ({
        ok: false,
        status: 429,
        headers: { get: (h) => (h === "Retry-After" ? "60" : null) },
      });
      const r = await fetchUsageForAccount(account, { fetchImpl });
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "rate_limited");
      assert.equal(r.needs_reauth, false);
      assert.equal(r.retry_after_ms, 60000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("token-only + setup-token 401 は setup_token_invalid (needs_reauth)", async () => {
    const { tmp, account } = makeAccount({ login: false });
    try {
      const fetchImpl = async () => ({ ok: false, status: 401, headers: { get: () => null } });
      const r = await fetchUsageForAccount(account, { fetchImpl });
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "setup_token_invalid");
      assert.equal(r.needs_reauth, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("token-only + 期限切れ setup-token は setup_token_expired", async () => {
    const { tmp, account } = makeAccount({ login: false, setupTokenExpiresAt: Date.now() - 1000 });
    try {
      const fetchImpl = async () => { throw new Error("should not fetch"); };
      const r = await fetchUsageForAccount(account, { fetchImpl });
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "setup_token_expired");
      assert.equal(r.needs_reauth, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("loadAccounts は token-only アカウントも含める", () => {
    const accountsDir = tmpDir("cs-la-");
    try {
      writeFileSync(
        join(accountsDir, "tokonly.json"),
        JSON.stringify({ setupToken: { accessToken: TOKEN, expiresAt: 999 } })
      );
      writeFileSync(join(accountsDir, "empty.json"), JSON.stringify({}));
      const accounts = loadAccounts(accountsDir);
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].name, "tokonly");
      assert.equal(accounts[0].setupToken, TOKEN);
    } finally {
      rmSync(accountsDir, { recursive: true, force: true });
    }
  });
});
