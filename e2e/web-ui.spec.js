// Local Web UI の e2e (Playwright)。
//
// 分離の設計:
// - 一時 dir を HOME にした subprocess で `node cli/server.js` を起動する。
//   accounts / credentials / SQLite は全て os.homedir() 起点なので、実行マシンの
//   ~/.claude / ~/.claude-shift には一切読み書きしない (tests/shift-add.test.js と同方式)。
// - fixture 全アカウントを pollExclude に入れる → fetchAllUsage が fetch をスキップし、
//   usage 取得の外部ネットワークアクセスが発生しない。
// - 切替時の profile fetch は CLAUDE_SHIFT_PROFILE_URL でテストプロセス内の loopback stub に向け、
//   外部に出ずに失敗パス (catch 済み・切替自体は成功) を踏ませる (差し替えは loopback のみ許可)。
// - ~/.claude.json 相当に oauthAccount を置かない → active 判定は token fallback になり、
//   profile fetch が失敗しても切替結果が UI に反映される。
import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 隔離 HOME に加えて、親プロセスから CLAUDE_SHIFT_* が漏れて実データを指すのを防ぐ。
// (例: 実行マシンで CLAUDE_SHIFT_DATA_DIR が設定済みだと HOME 差し替えだけでは実 DB に触れる)
function isolatedEnv(home, extra = {}) {
  const env = { ...process.env, ...extra, HOME: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_SHIFT_") && !(key in extra)) delete env[key];
  }
  return env;
}

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

let home;
let serverProc;
let serverLog = "";
let base;
let profileStub;

// server の stdout「claude-shift server → http://127.0.0.1:<port>」から実 bind ポートを取る。
// 事前に空きポートを探して渡す方式は close→spawn 間の TOCTOU で EADDRINUSE を踏みうるため、
// CLAUDE_SHIFT_PORT=0 (ephemeral) で起動して OS に採番させる。
function waitForReportedPort(proc, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not report port\n--- server log ---\n${serverLog}`)),
      timeoutMs
    );
    const check = () => {
      const m = serverLog.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    proc.stdout.on("data", check);
    proc.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`server exited before reporting port\n--- server log ---\n${serverLog}`));
    });
    check();
  });
}

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
    env: isolatedEnv(home),
  });

  // profile fetch の宛先: テストプロセス内の loopback stub (404 固定)。外部には一切出ない
  profileStub = createHttpServer((req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"e2e profile stub"}');
  });
  await new Promise((r) => profileStub.listen(0, "127.0.0.1", r));
  const stubPort = profileStub.address().port;

  serverProc = spawn(process.execPath, [join(REPO_ROOT, "cli", "server.js")], {
    env: isolatedEnv(home, {
      CLAUDE_SHIFT_PORT: "0",
      CLAUDE_SHIFT_PROFILE_URL: `http://127.0.0.1:${stubPort}/e2e-profile-stub`,
    }),
  });
  serverProc.stdout.on("data", (d) => (serverLog += d));
  serverProc.stderr.on("data", (d) => (serverLog += d));
  const port = await waitForReportedPort(serverProc);
  base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/usage`);
});

test.afterAll(async () => {
  // signal 死は exitCode=null のまま signalCode に入るので両方見る
  if (serverProc && serverProc.exitCode == null && serverProc.signalCode == null) {
    serverProc.kill("SIGTERM");
    await new Promise((r) => serverProc.once("exit", r));
  }
  if (profileStub) await new Promise((r) => profileStub.close(r));
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

  // issue #23: login (credentials.json) と token pin (env.sh) は独立に判定される。
  // 通常運用は片方だけ、split 運用は両方が別アカウントに付く。
  // 各テストは開始時に credentials.json / env.sh / setupToken を明示的に再配置し、
  // 前テストの残余状態に依存しない。
  test.describe("activeAs バッジ (login / token pin / split)", () => {
    const BRAVO_SETUP_TOKEN = "sk-ant-oat01-BRAVO-SETUP-FIXTURE";
    const credPath = () => join(home, ".claude", ".credentials.json");
    const envPath = () => join(home, ".claude-shift", "env.sh");
    const bravoPath = () => join(home, ".claude-shift", "accounts", "bravo.json");

    function writeLoginCreds(name) {
      const raw = JSON.parse(readFileSync(join(home, ".claude-shift", "accounts", `${name}.json`), "utf8"));
      writeFileSync(credPath(), JSON.stringify({ claudeAiOauth: raw.claudeAiOauth }, null, 2));
    }
    function deleteLoginCreds() {
      rmSync(credPath(), { force: true });
    }
    function writeEnvSh(token) {
      writeFileSync(envPath(), `# claude-shift use-token: bravo (fixture)\nexport CLAUDE_CODE_OAUTH_TOKEN=${token}\n`);
    }
    function deleteEnvSh() {
      rmSync(envPath(), { force: true });
    }
    function setBravoSetupToken(token) {
      const raw = JSON.parse(readFileSync(bravoPath(), "utf8"));
      raw.setupToken = { accessToken: token, issuedAt: Date.now(), expiresAt: Date.now() + 86400_000 };
      writeFileSync(bravoPath(), JSON.stringify(raw, null, 2));
    }
    function unsetBravoSetupToken() {
      const raw = JSON.parse(readFileSync(bravoPath(), "utf8"));
      delete raw.setupToken;
      writeFileSync(bravoPath(), JSON.stringify(raw, null, 2));
    }

    test("normal: credentials.json のみ → login バッジのみ、split-warning は非表示", async ({ page }) => {
      writeLoginCreds("alpha");
      deleteEnvSh();
      unsetBravoSetupToken();

      await page.goto(`${base}/`);
      const alphaCard = page.locator(".account-card", { hasText: "alpha" });
      const bravoCard = page.locator(".account-card", { hasText: "bravo" });

      await expect(alphaCard.locator(".active-as-login")).toHaveText("login");
      await expect(alphaCard.locator(".active-as-token")).toHaveCount(0);
      await expect(bravoCard.locator(".active-as")).toHaveCount(0);
      // split 条件 (login と token pin の双方が別アカウントに付く) は満たさないので DOM に出ない
      await expect(page.locator(".split-warning")).toHaveCount(0);
    });

    test("split: login=alpha + token pin=bravo → 両バッジ + split-warning が可視で bravo を含む", async ({ page }) => {
      writeLoginCreds("alpha");
      setBravoSetupToken(BRAVO_SETUP_TOKEN);
      writeEnvSh(BRAVO_SETUP_TOKEN);

      await page.goto(`${base}/`);
      const alphaCard = page.locator(".account-card", { hasText: "alpha" });
      const bravoCard = page.locator(".account-card", { hasText: "bravo" });

      await expect(alphaCard.locator(".active-as-login")).toHaveText("login");
      await expect(bravoCard.locator(".active-as-token")).toHaveText("token pin");

      const banner = page.locator("#global-banner");
      await expect(banner).toBeVisible();
      const warning = banner.locator(".split-warning");
      await expect(warning).toBeVisible();
      await expect(warning).toContainText("bravo");
    });

    test("token pin のみ: credentials.json 不在 → token バッジのみ、login バッジ・split-warning は無し", async ({ page }) => {
      deleteLoginCreds();
      setBravoSetupToken(BRAVO_SETUP_TOKEN);
      writeEnvSh(BRAVO_SETUP_TOKEN);

      await page.goto(`${base}/`);
      const alphaCard = page.locator(".account-card", { hasText: "alpha" });
      const bravoCard = page.locator(".account-card", { hasText: "bravo" });

      await expect(bravoCard.locator(".active-as-token")).toHaveText("token pin");
      await expect(bravoCard.locator(".active-as-login")).toHaveCount(0);
      await expect(alphaCard.locator(".active-as")).toHaveCount(0);
      // split は「両方存在 かつ 別々」のみ。login 側が空なので警告は出ない
      await expect(page.locator(".split-warning")).toHaveCount(0);
    });
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
