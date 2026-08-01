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
    uuid: "11111111-1111-4111-8111-111111111111",
    display_name: "alice",
    email: "alice@example.com",
    created_at: "2025-01-01T00:00:00.000000Z",
  },
  organization: {
    uuid: "22222222-2222-4222-8222-222222222222",
    name: "alice@example.com's Organization",
    organization_type: "claude_max",
    billing_type: "stripe_subscription",
    rate_limit_tier: "default_claude_max_20x",
    seat_tier: null,
    has_extra_usage_enabled: false,
    subscription_created_at: "2025-06-01T00:00:00.000000Z",
    cc_onboarding_flags: {},
    claude_code_trial_ends_at: null,
    claude_code_trial_duration_days: null,
  },
};

// 前アカウント (account-a / Example Team / claude_team) が残していく典型的な oauthAccount
const STALE_TEAM_OAUTH = {
  accountUuid: "33333333-3333-4333-8333-333333333333",
  emailAddress: "bob@example.com",
  organizationUuid: "44444444-4444-4444-8444-444444444444",
  organizationName: "Example Team",
  organizationType: "claude_team",
  organizationRateLimitTier: "default_raven",
  userRateLimitTier: "default_claude_max_5x",
  seatTier: "team_tier_1",
  workspaceRole: null,
  displayName: "alice",
  hasExtraUsageEnabled: false,
  billingType: "stripe_subscription",
};

describe("profileToOAuthAccount", () => {
  test("claude_max profile を全 identity フィールド付きで変換する", () => {
    const oa = profileToOAuthAccount(MAX_PROFILE);
    assert.equal(oa.accountUuid, MAX_PROFILE.account.uuid);
    assert.equal(oa.emailAddress, "alice@example.com");
    assert.equal(oa.displayName, "alice");
    assert.equal(oa.organizationUuid, MAX_PROFILE.organization.uuid);
    assert.equal(
      oa.organizationName,
      "alice@example.com's Organization"
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
      assert.equal(after.oauthAccount.emailAddress, "alice@example.com");
      assert.equal(
        after.oauthAccount.organizationName,
        "alice@example.com's Organization"
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
