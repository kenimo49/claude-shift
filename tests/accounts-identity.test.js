import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAccountUuid,
  getActiveInfo,
  getActiveAccount,
  enrichAccountIdentity,
  enrichIdentityForAccount,
  profileToOAuthAccount,
} from "../cli/accounts.js";

function makeHome({ credentialsToken, claudeJsonUuid, accounts = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "cs-id-"));
  const accountsDir = join(home, ".claude-shift", "accounts");
  const credentialsPath = join(home, ".claude", ".credentials.json");
  const claudeJsonPath = join(home, ".claude.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(accountsDir, { recursive: true });
  if (credentialsToken !== undefined) {
    writeFileSync(
      credentialsPath,
      JSON.stringify({ claudeAiOauth: { accessToken: credentialsToken, refreshToken: "r" } }, null, 2)
    );
  }
  if (claudeJsonUuid !== undefined) {
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({ oauthAccount: { accountUuid: claudeJsonUuid } }, null, 2)
    );
  }
  for (const [name, spec] of Object.entries(accounts)) {
    const raw = { claudeAiOauth: { accessToken: spec.token, refreshToken: "r" } };
    if (spec.uuid) raw.oauthAccount = { accountUuid: spec.uuid };
    writeFileSync(join(accountsDir, `${name}.json`), JSON.stringify(raw, null, 2));
  }
  return { home, accountsDir, credentialsPath, claudeJsonPath };
}

describe("extractAccountUuid", () => {
  test("トップレベル oauthAccount.accountUuid", () => {
    assert.equal(extractAccountUuid({ oauthAccount: { accountUuid: "uuid-A" } }), "uuid-A");
  });
  test("claudeAiOauth.oauthAccount.accountUuid (レガシー layout)", () => {
    assert.equal(
      extractAccountUuid({ claudeAiOauth: { oauthAccount: { accountUuid: "uuid-B" } } }),
      "uuid-B"
    );
  });
  test("フラット accountUuid", () => {
    assert.equal(extractAccountUuid({ accountUuid: "uuid-C" }), "uuid-C");
  });
  test("null / 未定義 は null", () => {
    assert.equal(extractAccountUuid(null), null);
    assert.equal(extractAccountUuid({}), null);
    assert.equal(extractAccountUuid({ claudeAiOauth: {} }), null);
  });
});

describe("getActiveInfo (issue #5)", () => {
  test("uuid 一致で method=uuid、syncBroken=false", () => {
    const { home, accountsDir, credentialsPath, claudeJsonPath } = makeHome({
      credentialsToken: "t-shift-latest",
      claudeJsonUuid: "uuid-A",
      accounts: {
        alice: { token: "t-alice-different", uuid: "uuid-A" },
        bob:   { token: "t-bob", uuid: "uuid-B" },
      },
    });
    try {
      const info = getActiveInfo(accountsDir, credentialsPath, claudeJsonPath);
      // token 値は乖離しているが uuid が alice に一致 → alice が active
      assert.deepEqual(info, { name: "alice", method: "uuid", syncBroken: false });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("uuid 情報が両方無ければ token fallback (method=token)", () => {
    const { home, accountsDir, credentialsPath, claudeJsonPath } = makeHome({
      credentialsToken: "t-alice",
      // claudeJsonUuid 未設定
      accounts: {
        alice: { token: "t-alice" },  // uuid 未 migration
        bob:   { token: "t-bob" },
      },
    });
    try {
      const info = getActiveInfo(accountsDir, credentialsPath, claudeJsonPath);
      assert.deepEqual(info, { name: "alice", method: "token", syncBroken: false });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("uuid が unregistered account を指しても token マッチで救われる", () => {
    // claude CLI 側 uuid だけ更新されて、accounts に該当 uuid が無い状態。
    // token マッチで拾えるならそっちに落とす (fallback として正常動作)。
    const { home, accountsDir, credentialsPath, claudeJsonPath } = makeHome({
      credentialsToken: "t-alice",
      claudeJsonUuid: "uuid-UNKNOWN",
      accounts: {
        alice: { token: "t-alice", uuid: "uuid-A" },
      },
    });
    try {
      const info = getActiveInfo(accountsDir, credentialsPath, claudeJsonPath);
      assert.deepEqual(info, { name: "alice", method: "token", syncBroken: false });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("uuid も token もマッチせず、account 登録あり → syncBroken=true, name=null", () => {
    const { home, accountsDir, credentialsPath, claudeJsonPath } = makeHome({
      credentialsToken: "t-STRANGER",
      claudeJsonUuid: "uuid-STRANGER",
      accounts: {
        alice: { token: "t-alice", uuid: "uuid-A" },
      },
    });
    try {
      const info = getActiveInfo(accountsDir, credentialsPath, claudeJsonPath);
      assert.deepEqual(info, { name: null, method: null, syncBroken: true });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("account 登録 0 件 → syncBroken=false (何もない状態なので broken ではない)", () => {
    const { home, accountsDir, credentialsPath, claudeJsonPath } = makeHome({
      credentialsToken: "t-anything",
      claudeJsonUuid: "uuid-X",
      accounts: {},
    });
    try {
      const info = getActiveInfo(accountsDir, credentialsPath, claudeJsonPath);
      assert.deepEqual(info, { name: null, method: null, syncBroken: false });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("credentials.json が空 → 全部 null", () => {
    const { home, accountsDir, credentialsPath, claudeJsonPath } = makeHome({
      accounts: { alice: { token: "t-alice", uuid: "uuid-A" } },
    });
    try {
      const info = getActiveInfo(accountsDir, credentialsPath, claudeJsonPath);
      assert.deepEqual(info, { name: null, method: null, syncBroken: false });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("getActiveAccount 互換 API", () => {
  test("getActiveInfo().name を返す (name のみ)", () => {
    const { home, accountsDir, credentialsPath, claudeJsonPath } = makeHome({
      credentialsToken: "t-alice-latest",
      claudeJsonUuid: "uuid-A",
      accounts: { alice: { token: "t-different", uuid: "uuid-A" } },
    });
    try {
      const name = getActiveAccount(accountsDir, credentialsPath, claudeJsonPath);
      assert.equal(name, "alice");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("enrichAccountIdentity", () => {
  test("既存 claudeAiOauth を preserve しつつ oauthAccount を merge", () => {
    const { home, accountsDir } = makeHome({
      accounts: { alice: { token: "t-alice" } }, // uuid 未 migration
    });
    try {
      const path = join(accountsDir, "alice.json");
      const merged = enrichAccountIdentity(path, {
        accountUuid: "uuid-A",
        emailAddress: "alice@example.com",
      });
      assert.equal(merged.accountUuid, "uuid-A");

      const raw = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(raw.claudeAiOauth.accessToken, "t-alice", "既存 accessToken は保持される");
      assert.equal(raw.oauthAccount.accountUuid, "uuid-A");
      assert.equal(raw.oauthAccount.emailAddress, "alice@example.com");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("既存 oauthAccount と merge (未知フィールド preserve)", () => {
    const { home, accountsDir } = makeHome({
      accounts: { alice: { token: "t-alice", uuid: "uuid-OLD" } },
    });
    try {
      const path = join(accountsDir, "alice.json");
      // 元 raw に oauthAccount.customFlag=true を仕込む
      const raw0 = JSON.parse(readFileSync(path, "utf8"));
      raw0.oauthAccount.customFlag = true;
      writeFileSync(path, JSON.stringify(raw0, null, 2));

      enrichAccountIdentity(path, { accountUuid: "uuid-NEW" });
      const raw1 = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(raw1.oauthAccount.accountUuid, "uuid-NEW", "新値で上書き");
      assert.equal(raw1.oauthAccount.customFlag, true, "未知フィールド preserve");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("enrichIdentityForAccount (profile fetch DI)", () => {
  test("profile fetch → profileToOAuthAccount → 保存", async () => {
    const { home, accountsDir } = makeHome({
      accounts: { alice: { token: "t-alice" } },
    });
    try {
      const path = join(accountsDir, "alice.json");
      const fetchProfileImpl = async (token) => {
        assert.equal(token, "t-alice");
        return {
          account: { uuid: "uuid-A", email: "alice@example.com", display_name: "Alice" },
          organization: { uuid: "org-1", organization_type: "claude_max", rate_limit_tier: "pro" },
        };
      };
      await enrichIdentityForAccount(path, { fetchProfileImpl });
      const raw = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(raw.oauthAccount.accountUuid, "uuid-A");
      assert.equal(raw.oauthAccount.emailAddress, "alice@example.com");
      assert.equal(raw.oauthAccount.userRateLimitTier, "pro", "claude_max では org tier を流用");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("token が無ければ throw", async () => {
    const home = mkdtempSync(join(tmpdir(), "cs-noTok-"));
    const path = join(home, "acct.json");
    writeFileSync(path, JSON.stringify({}));
    try {
      await assert.rejects(
        () => enrichIdentityForAccount(path, { fetchProfileImpl: async () => ({}) }),
        /no accessToken/
      );
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
