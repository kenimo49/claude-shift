import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  profileToOAuthAccount,
  writeOAuthAccountToClaudeJson,
} from "../cli/accounts.js";

const MAX_PROFILE = {
  account: {
    uuid: "4463e719-b3bf-4d18-8e04-2c1ac46f36f4",
    display_name: "imoto",
    email: "imoto@timeleap.co.jp",
    created_at: "2025-08-01T02:12:30.340984Z",
  },
  organization: {
    uuid: "cdc35446-36d8-4c60-b2d9-e0cf52ad9931",
    name: "imoto@timeleap.co.jp's Organization",
    organization_type: "claude_max",
    billing_type: "stripe_subscription",
    rate_limit_tier: "default_claude_max_20x",
    seat_tier: null,
    has_extra_usage_enabled: false,
    subscription_created_at: "2026-01-05T07:36:45.068735Z",
    cc_onboarding_flags: {},
    claude_code_trial_ends_at: null,
    claude_code_trial_duration_days: null,
  },
};

// 前アカウント (kumiko / QuestBoard / claude_team) が残していく典型的な oauthAccount
const STALE_TEAM_OAUTH = {
  accountUuid: "64138633-c881-4977-86ef-87540fd8ded7",
  emailAddress: "kumiko@questboard.world",
  organizationUuid: "453ec18a-f95c-4fb7-a18c-c84b681a50df",
  organizationName: "QuestBoard",
  organizationType: "claude_team",
  organizationRateLimitTier: "default_raven",
  userRateLimitTier: "default_claude_max_5x",
  seatTier: "team_tier_1",
  workspaceRole: null,
  displayName: "imoto",
  hasExtraUsageEnabled: false,
  billingType: "stripe_subscription",
};

describe("profileToOAuthAccount", () => {
  test("claude_max profile を全 identity フィールド付きで変換する", () => {
    const oa = profileToOAuthAccount(MAX_PROFILE);
    assert.equal(oa.accountUuid, MAX_PROFILE.account.uuid);
    assert.equal(oa.emailAddress, "imoto@timeleap.co.jp");
    assert.equal(oa.displayName, "imoto");
    assert.equal(oa.organizationUuid, MAX_PROFILE.organization.uuid);
    assert.equal(
      oa.organizationName,
      "imoto@timeleap.co.jp's Organization"
    );
    assert.equal(oa.organizationType, "claude_max");
    assert.equal(oa.organizationRateLimitTier, "default_claude_max_20x");
    assert.equal(oa.userRateLimitTier, "default_claude_max_20x");
    assert.equal(oa.seatTier, null);
    assert.equal(oa.workspaceRole, null);
  });

  test("claude_team profile では userRateLimitTier を null にする (推測しない)", () => {
    const teamProfile = {
      account: { uuid: "u1", email: "x@y.z", display_name: "x" },
      organization: {
        uuid: "o1",
        name: "Team Org",
        organization_type: "claude_team",
        rate_limit_tier: "default_raven",
        seat_tier: "team_tier_1",
      },
    };
    const oa = profileToOAuthAccount(teamProfile);
    assert.equal(oa.organizationRateLimitTier, "default_raven");
    assert.equal(oa.userRateLimitTier, null);
    assert.equal(oa.seatTier, "team_tier_1");
  });

  test("空 profile でも identity フィールドは undefined にせず null で埋める", () => {
    const oa = profileToOAuthAccount({});
    assert.equal(oa.displayName, null);
    assert.equal(oa.organizationName, null);
    assert.equal(oa.organizationType, null);
    assert.equal(oa.organizationRateLimitTier, null);
    assert.equal(oa.userRateLimitTier, null);
    assert.equal(oa.seatTier, null);
    assert.equal(oa.workspaceRole, null);
  });
});

describe("writeOAuthAccountToClaudeJson", () => {
  test("前アカウントの identity 残骸を新アカウントで完全に上書きする", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-shift-test-"));
    const cjPath = join(dir, ".claude.json");
    try {
      writeFileSync(
        cjPath,
        JSON.stringify({ oauthAccount: STALE_TEAM_OAUTH, otherField: "keep" })
      );

      const newOA = profileToOAuthAccount(MAX_PROFILE);
      const ok = writeOAuthAccountToClaudeJson(newOA, cjPath);
      assert.equal(ok, true);

      const after = JSON.parse(readFileSync(cjPath, "utf8"));
      // 前アカウントの identity は全て置き換わっている
      assert.equal(after.oauthAccount.emailAddress, "imoto@timeleap.co.jp");
      assert.equal(
        after.oauthAccount.organizationName,
        "imoto@timeleap.co.jp's Organization"
      );
      assert.equal(after.oauthAccount.organizationType, "claude_max");
      assert.equal(
        after.oauthAccount.organizationRateLimitTier,
        "default_claude_max_20x"
      );
      assert.equal(
        after.oauthAccount.userRateLimitTier,
        "default_claude_max_20x"
      );
      assert.equal(after.oauthAccount.seatTier, null);
      // 無関係フィールドは保持
      assert.equal(after.otherField, "keep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claude.json が存在しない場合は false を返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-shift-test-"));
    const cjPath = join(dir, ".claude.json");
    try {
      const ok = writeOAuthAccountToClaudeJson({ emailAddress: "x" }, cjPath);
      assert.equal(ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
