// Local Web UI の e2e (Playwright)。
//
// 分離の設計:
// - 一時 dir を HOME にした subprocess で `node cli/server.js` を起動する。
//   accounts / credentials / SQLite は全て os.homedir() 起点なので、実行マシンの
//   ~/.claude / ~/.claude-shift には一切読み書きしない (tests/shift-add.test.js と同方式)。
// - fixture 全アカウントを pollExclude に入れる → fetchAllUsage が fetch をスキップし、
//   usage 取得の外部ネットワークアクセスが発生しない。
// - 切替時の profile fetch は CLAUDE_SHIFT_PROFILE_URL で自サーバの未登録 path に向け、
//   外部に出ずに失敗パス (catch 済み・切替自体は成功) を踏ませる。
// - ~/.claude.json 相当に oauthAccount を置かない → active 判定は token fallback になり、
//   profile fetch が失敗しても切替結果が UI に反映される。
import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function accountJson(name, uuid) {
  return {
    claudeAiOauth: {
      accessToken: `token-${name}`,
      refreshToken: `refresh-${name}`,
      expiresAt: Date.now() + 86400_000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    },
    oauthAccount: {
      accountUuid: uuid,
      emailAddress: `${name}@example.com`,
    },
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let home;
let serverProc;
let serverLog = "";
let base;

async function waitForServer(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server not ready: ${url}\n--- server log ---\n${serverLog}`);
}

test.beforeAll(async () => {
  // 隔離 HOME に fixture を配置
  home = mkdtempSync(join(tmpdir(), "claude-shift-e2e-"));
  const shiftDir = join(home, ".claude-shift");
  mkdirSync(join(shiftDir, "accounts"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });

  const alpha = accountJson("alpha", "11111111-1111-4111-8111-111111111111");
  const bravo = accountJson("bravo", "22222222-2222-4222-8222-222222222222");
  writeFileSync(join(shiftDir, "accounts", "alpha.json"), JSON.stringify(alpha, null, 2));
  writeFileSync(join(shiftDir, "accounts", "bravo.json"), JSON.stringify(bravo, null, 2));
  // active = alpha (credentials.json は claudeAiOauth ラッパー形式)
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: alpha.claudeAiOauth }, null, 2)
  );
  // oauthAccount を持たない .claude.json → active 判定は token fallback
  writeFileSync(join(home, ".claude.json"), JSON.stringify({}, null, 2));
  // 全アカウント pollExclude → usage fetch の外部アクセスなし
  writeFileSync(
    join(shiftDir, "config.json"),
    JSON.stringify({ pollExclude: ["alpha", "bravo"] }, null, 2)
  );

  // SQLite snapshot を server と同じコードパス (cli/db.js) で seed
  execFileSync(process.execPath, [join(REPO_ROOT, "e2e", "fixtures", "seed.mjs")], {
    env: { ...process.env, HOME: home },
  });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serverProc = spawn(process.execPath, [join(REPO_ROOT, "cli", "server.js")], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_SHIFT_PORT: String(port),
      // 自サーバの未登録 path = JSON 404。外部に出ずに profile fetch を失敗させる
      CLAUDE_SHIFT_PROFILE_URL: `${base}/e2e-profile-stub`,
    },
  });
  serverProc.stdout.on("data", (d) => (serverLog += d));
  serverProc.stderr.on("data", (d) => (serverLog += d));
  await waitForServer(`${base}/usage`);
});

test.afterAll(async () => {
  // signal 死は exitCode=null のまま signalCode に入るので両方見る
  if (serverProc && serverProc.exitCode == null && serverProc.signalCode == null) {
    serverProc.kill("SIGTERM");
    await new Promise((r) => serverProc.once("exit", r));
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

test.describe("Local Web UI", () => {
  test.describe.configure({ mode: "serial" });

  test("ハッピーパス: アカウント一覧と usage が表示される", async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page).toHaveTitle("Claude Shift");

    const alphaCard = page.locator(".account-card", { hasText: "alpha" });
    const bravoCard = page.locator(".account-card", { hasText: "bravo" });
    await expect(alphaCard).toBeVisible();
    await expect(bravoCard).toBeVisible();

    // active = alpha: 使用中バッジは alpha 側、bravo 側は切替ボタン
    await expect(alphaCard.locator(".active-badge")).toHaveText("使用中");
    await expect(bravoCard.locator(".switch-btn")).toBeVisible();

    // seed した snapshot がバーに反映される (5時間枠 42% / 週次 63%)
    await expect(alphaCard.locator(".bar-label").first()).toHaveText("42% 使用中");
    await expect(alphaCard.locator(".bar-label").nth(1)).toHaveText("63% 使用中");

    // pollExclude 中のアカウントは「観測対象外」バッジ
    await expect(page.locator(".status-badge.excluded")).toHaveCount(2);
  });

  test("ハッピーパス: 切替で active と credentials.json が切り替わる", async ({ page }) => {
    await page.goto(`${base}/`);
    const bravoCard = page.locator(".account-card", { hasText: "bravo" });
    await bravoCard.locator(".switch-btn").click();

    // UI 上で使用中が bravo に移る
    await expect(bravoCard.locator(".active-badge")).toHaveText("使用中");
    const alphaCard = page.locator(".account-card", { hasText: "alpha" });
    await expect(alphaCard.locator(".switch-btn")).toBeVisible();

    // fixture HOME の credentials.json が実際に bravo へ書き換わっている
    const creds = JSON.parse(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"));
    expect(creds.claudeAiOauth.accessToken).toBe("token-bravo");
  });

  test("エッジケース: マスキングトグルが効き、リロード後も維持される", async ({ page }) => {
    await page.goto(`${base}/`);
    const maskBtn = page.locator("#btn-mask");
    await maskBtn.click();
    await expect(page.locator("body")).toHaveClass(/is-masked/);
    await expect(maskBtn).toHaveText("🙈");

    // localStorage フォールバックで永続化される (Web UI は chrome.storage が無い)
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/is-masked/);

    await maskBtn.click();
    await expect(page.locator("body")).not.toHaveClass(/is-masked/);
  });

  test("エラーパス: サーバ停止後の更新でエラーメッセージが出る", async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator(".account-card").first()).toBeVisible();

    // サーバを落としてから「今すぐ更新」→ 接続エラー表示 (このテストは必ず最後に置く)
    serverProc.kill("SIGTERM");
    await new Promise((r) => serverProc.once("exit", r));
    await page.getByRole("button", { name: "今すぐ更新" }).click();
    await expect(page.locator("#accounts .error")).toContainText("サーバーに接続できません");
  });
});
