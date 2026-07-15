# Claude Code の認証構造

Claude Code のアカウント認証は **2ファイル構造** になっている。両方を同期して切り替えないと、`credentials.json` だけ書き換えても `/status` は古いアカウントを表示し続ける。

## ファイル構成

### 1. `~/.claude/.credentials.json` — 認証トークン

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1784130520977,
    "scopes": ["user:file_upload", "user:inference", ...],
    "subscriptionType": "team",
    "rateLimitTier": "default_claude_max_5x"
  }
}
```

**役割**: API 呼び出し時の Bearer token。実際の Claude API・Anthropic API はこのトークンを使う。usage カウントも token に紐づく実ユーザーに帰属する。

### 2. `~/.claude.json` — ユーザーメタデータ（`oauthAccount` フィールド）

`~/.claude.json` は大きな設定ファイル（プロジェクト履歴等を含む数十KB〜数MB）で、その中に `oauthAccount` フィールドがある：

```json
{
  ...
  "oauthAccount": {
    "accountUuid": "4463e719-b3bf-4d18-8e04-2c1ac46f36f4",
    "emailAddress": "imoto@timeleap.co.jp",
    "organizationUuid": "cdc35446-36d8-4c60-b2d9-e0cf52ad9931",
    "hasExtraUsageEnabled": false,
    "billingType": "stripe_subscription",
    "accountCreatedAt": "2025-08-01T02:12:30.340984Z",
    "subscriptionCreatedAt": "2026-01-05T07:36:45.068735Z",
    ...
  },
  "userID": "...",
  ...
}
```

**役割**: `/status` の Email / Organization 表示、および Claude Code の起動時ロゴ（`· Claude Team` などのプラン表示）はここから取られている。API 認証には使われない。

## 事故パターン

**`credentials.json` だけ切り替えた場合の症状**:
- `curl` で `/api/oauth/profile` を叩くと新アカウントの情報が返る（token は切り替わっている）
- しかし Claude Code の `/status` は古いアカウントの Email / Organization を表示し続ける
- API 呼び出しは正しく新アカウントで実行されるので usage は新アカウントに計上される
- 見た目と実態のズレで「切替が失敗している」と誤解しやすい

## 正しい切り替え手順

1. **`credentials.json` を新トークンで上書き**
2. **新トークンで `https://api.anthropic.com/api/oauth/profile` を叩いて account/organization 情報を取得**
3. **`~/.claude.json` の `oauthAccount` フィールドを新情報で上書き**
   - 未知フィールドを保持するため、merge (`{...old, ...new}`) が安全
4. Claude Code を再起動すると `/status` に新アカウントが表示される

## `/api/oauth/profile` レスポンス例

```
GET https://api.anthropic.com/api/oauth/profile
Authorization: Bearer <access_token>
anthropic-beta: oauth-2025-04-20
```

```json
{
  "account": {
    "uuid": "...",
    "full_name": "...",
    "display_name": "...",
    "email": "user@example.com",
    "has_claude_max": false,
    "has_claude_pro": false,
    "created_at": "..."
  },
  "organization": {
    "uuid": "...",
    "name": "Org名",
    "organization_type": "claude_team",
    "billing_type": "stripe_subscription",
    "rate_limit_tier": "default_claude_max_5x",
    "seat_tier": "team_tier_1",
    "has_extra_usage_enabled": false,
    "subscription_status": "active",
    "subscription_created_at": "...",
    "cc_onboarding_flags": {},
    "claude_code_trial_ends_at": null,
    "claude_code_trial_duration_days": null
  },
  "application": {
    "uuid": "...",
    "name": "Claude Code",
    "slug": "claude-code"
  }
}
```

このレスポンスから `oauthAccount` の各フィールドを生成できる（マッピング実装は `cli/accounts.js` の `profileToOAuthAccount()` を参照）。

## Team account の見分け方

- `subscriptionType: "team"` + `organization_type: "claude_team"` → Team plan
- 同じ Team plan でも Organization 名は Owner のメールを含む形式（例: `imoto@timeleap.co.jp's Organization`）
- Team plan は複数メンバーが同じ Organization に属するので、`/status` の Organization 名だけでは個人を判別できない
- Email フィールドで個人を判別する（`oauthAccount.emailAddress` = ログイン user の email）

## 個人 Max との識別

- Max plan → `organization_type: "claude_max"` + `has_claude_max: true`
- rate_limit_tier で `default_claude_max_20x` 等と表示される
- Organization 名は `<owner-email>'s Organization`

## 起動時のプロセスメモリ

Claude Code は起動時にこの 2ファイルを読み込んで **プロセスメモリに保持** する。稼働中のプロセスに対して credentials.json / .claude.json を書き換えても反映されない。切替後は必ず Claude Code プロセスを再起動する必要がある。

## claude-shift の実装

- `cli/accounts.js` の `switchAccount(name)` が 2ファイル同時切替を担当
- サブフロー:
  1. sync-back: 現 credentials.json を現 active account に書き戻し（refresh 済みトークンの保全）
  2. credentials.json ← accounts/`<name>`.json をコピー
  3. `/api/oauth/profile` を新トークンで呼び出し
  4. profile → oauthAccount にマップして `~/.claude.json` を書き換え

`shift.sh use <name>` および Chrome 拡張の切替ボタン（`POST /active`）はどちらもこの Node 実装に集約されている。
