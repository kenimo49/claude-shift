// Anthropic OAuth token の refresh 処理 (claude-cli と同じ手順)
//
// 参考: hermes-agent/agent/anthropic_adapter.py の refresh_anthropic_oauth_pure
//       docs/knowledge/claude-code-auth-internals.md
//
// grant_type=refresh_token を x-www-form-urlencoded で送る。
// 応答の access_token / refresh_token / expires_in から新 credentials 構造を作る。

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// 実測: platform.claude.com が新エンドポイント、console.anthropic.com は互換 fallback。
export const TOKEN_ENDPOINTS = [
  "https://console.anthropic.com/v1/oauth/token",
  "https://platform.claude.com/v1/oauth/token",
];

export class RefreshError extends Error {
  constructor(message, { status = null, endpoint = null, cause = null } = {}) {
    super(message);
    this.name = "RefreshError";
    this.status = status;
    this.endpoint = endpoint;
    if (cause) this.cause = cause;
  }
}

// refresh_token → {accessToken, refreshToken, expiresAt}
// 401/403 はまず間違いなく再ログインが必要なので needsReauth=true をエラーに立てる。
export async function refreshOAuthToken(refreshToken, { endpoints = TOKEN_ENDPOINTS, fetchImpl = fetch } = {}) {
  if (!refreshToken) throw new RefreshError("refreshToken is required");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }).toString();

  let lastStatus = null;
  let lastEndpoint = null;
  let lastError = null;

  for (const endpoint of endpoints) {
    lastEndpoint = endpoint;
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "claude-cli/2.1 (external, cli)",
        },
        body,
      });
    } catch (e) {
      lastError = e;
      continue;
    }

    if (!res.ok) {
      lastStatus = res.status;
      // 400/401/403 は refreshToken 自体が dead — 別エンドポイントを試しても救えない
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const err = new RefreshError(`refresh rejected: HTTP ${res.status}`, {
          status: res.status,
          endpoint,
        });
        err.needsReauth = true;
        throw err;
      }
      // 5xx/429 は他エンドポイントで retry
      continue;
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      lastError = e;
      continue;
    }

    const accessToken = data.access_token;
    if (!accessToken) {
      throw new RefreshError("refresh response missing access_token", { endpoint });
    }
    const nextRefresh = data.refresh_token ?? refreshToken;
    const expiresIn = Number(data.expires_in ?? 3600);
    return {
      accessToken,
      refreshToken: nextRefresh,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  throw new RefreshError(
    lastError ? `refresh failed: ${lastError.message}` : `refresh failed: HTTP ${lastStatus}`,
    { status: lastStatus, endpoint: lastEndpoint, cause: lastError }
  );
}
