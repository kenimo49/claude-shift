#!/usr/bin/env node
// localhost:PORT で usage データを提供するローカル API サーバー

import { createServer } from "http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { fetchAllUsage } from "./fetch-usage.js";
import { loadConfig, saveConfig, getPollExclude } from "./config.js";
import {
  saveSnapshots,
  saveFailures,
  getLatestSnapshots,
  getLatestFailuresPerAccount,
  getHistory,
  getAllHistory,
} from "./db.js";
import {
  getActiveAccount,
  getActiveInfo,
  switchAccount,
  getIdentityStatus,
  listAccounts,
  DEFAULT_ACCOUNTS_DIR,
} from "./accounts.js";
import { extractSetupToken } from "./tokens.js";

const ENV_SH_PATH = join(homedir(), ".claude-shift", "env.sh");

// issue #23: shift use-token が書き出す env.sh の CLAUDE_CODE_OAUTH_TOKEN を抽出。
// claude 実行時は credentials.json より env の token が優先されるため、popup 側で
// 「実際にどのアカウントで claude が動くか」を login pin と併せて示す。
// shift.sh list_accounts と同じ (\S+) パターンで拾い、bash %q が付ける単一クォートは
// 剥がしておく (実用上 setup-token は英数字+ハイフンで %q はノーオペだが safety net)。
export function readEnvShToken(envPath = ENV_SH_PATH) {
  if (!existsSync(envPath)) return null;
  try {
    const raw = readFileSync(envPath, "utf8");
    const m = raw.match(/CLAUDE_CODE_OAUTH_TOKEN=(\S+)/);
    if (!m) return null;
    let v = m[1];
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    return v || null;
  } catch {
    return null;
  }
}

// account 名 → setupToken 値 の map。login 系 (accounts.listAccounts) は
// setupToken を含まないので、accounts ディレクトリを直接読む。token-only アカウントも
// 対象 (usage snapshot 側で名前だけ出る場合がある)。
export function collectSetupTokens(accountsDir = DEFAULT_ACCOUNTS_DIR) {
  const map = new Map();
  let entries;
  try {
    entries = readdirSync(accountsDir);
  } catch {
    return map;
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const name = f.replace(/\.json$/, "");
    try {
      const raw = JSON.parse(readFileSync(join(accountsDir, f), "utf8"));
      const t = extractSetupToken(raw);
      if (t) map.set(name, t);
    } catch {
      // 読めない account はスキップ (identity_error として別経路で露出済み)
    }
  }
  return map;
}

const PORT = process.env.CLAUDE_SHIFT_PORT ?? 19867;

// ROADMAP 案A: extension/ を単一ソースとしてブラウザからも popup UI を開けるようにする。
// path traversal を許さないため、ホワイトリスト方式で URL path → 実ファイルを固定マップする。
const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const STATIC_ASSETS = new Map([
  ["/",           { file: "popup.html", contentType: "text/html; charset=utf-8" }],
  ["/popup.html", { file: "popup.html", contentType: "text/html; charset=utf-8" }],
  ["/popup.js",   { file: "popup.js",   contentType: "text/javascript; charset=utf-8" }],
  ["/helpers.js", { file: "helpers.js", contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
]);

async function serveStatic(res, entry) {
  try {
    const data = await readFile(join(EXTENSION_DIR, entry.file));
    res.writeHead(200, { "Content-Type": entry.contentType });
    res.end(data);
  } catch (e) {
    respond(res, 500, { error: `static asset unavailable: ${e.code ?? e.message}` });
  }
}

// ポーリング間隔（分）: CLI引数 > 環境変数 > 保存済み設定 > デフォルト10分
function initialIntervalMinutes() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--interval" || args[i] === "-i") && args[i + 1]) {
      const v = parseFloat(args[i + 1]);
      if (v > 0) return v;
    }
  }
  const env = parseFloat(process.env.CLAUDE_SHIFT_POLL_MINUTES ?? "");
  if (env > 0) return env;
  const saved = parseFloat(loadConfig().pollMinutes ?? "");
  if (saved > 0) return saved;
  return 10;
}

let pollMinutes = initialIntervalMinutes();
let pollTimer = null;
let cache = null;
// 全アカウント成功した最後の時刻 (UI で「最終取得」に出す信頼できる時刻)
let lastFetched = 0;
// 直近の refresh 試行時刻 (失敗を含む) — UI では区別して出す
let lastAttempted = 0;
// in-flight refresh の共有 promise。setInterval と /usage/live の直列化用。
// 走行中に refresh() を再度呼ぶと同じ promise を await して二重実行を防ぐ。
let refreshInFlight = null;

// issue #7: `needs_reauth` は「再ログインが必要」という恒久的な状態で、次回 poll しても
// 手動対応 (claude /login → shift add) 無しには自動回復しない。この account を
// 「一時的な取得失敗」と同じ扱いにすると、healthy な他 account の usage 表示が
// 「試行 HH:MM (未成功)」のまま居残り、ユーザーに「全部古い」と誤解させる。
//
// そこで lastFetched (= UI で「最終取得」に出す信頼できる時刻) を更新して良いか判定する時、
// needs_reauth は「取得失敗」から除外し、真の transient failure (http_error / refresh_failed /
// network 断など) だけを見る。needs_reauth は any_needs_reauth バナー + card badge で表現。
//
// pure function として export しておくとテストしやすい。
export function isFullyFetched(usageList) {
  return usageList.every((u) => !u.error || u.needs_reauth);
}

async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const data = await fetchAllUsage();
      saveSnapshots(data);
      saveFailures(data);
      cache = data;
      lastAttempted = Date.now();

      const transientFailed = data.filter((u) => u.error && !u.needs_reauth);
      const reauthFailed = data.filter((u) => u.error && u.needs_reauth);
      if (transientFailed.length === 0) {
        lastFetched = lastAttempted;
        if (reauthFailed.length === 0) {
          console.log(`[${new Date().toISOString()}] fetched ${data.length} accounts`);
        } else {
          const rnames = reauthFailed.map((f) => f.name).join(", ");
          console.log(
            `[${new Date().toISOString()}] fetched ${data.length - reauthFailed.length}/${data.length} accounts (needs_reauth: ${rnames})`
          );
        }
      } else {
        const ok = data.length - transientFailed.length - reauthFailed.length;
        const fnames = transientFailed.map((f) => `${f.name}(${f.error_kind ?? "err"}${f.http_status ? ` ${f.http_status}` : ""})`).join(", ");
        const reauthNote = reauthFailed.length
          ? `, needs_reauth: ${reauthFailed.map((f) => f.name).join(", ")}`
          : "";
        console.error(
          `[${new Date().toISOString()}] partial fetch: ${ok}/${data.length} ok, failed: ${fnames}${reauthNote}`
        );
      }
    } catch (e) {
      console.error("fetch error:", e.message);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function reschedulePoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, pollMinutes * 60 * 1000);
}

// snapshot + failure を account 単位で merge した /usage レスポンスを構築する。
// account: [{account, captured_at, five_hour_*, weekly_*, stale, needs_reauth?, last_error?, error_kind?}, ...]
function buildUsagePayload() {
  const STALE_THRESHOLD_MS = Math.max(pollMinutes * 2 * 60 * 1000, 5 * 60 * 1000);
  const now = Date.now();
  const snapshots = getLatestSnapshots();
  const failures = getLatestFailuresPerAccount();
  const failureByAccount = new Map(failures.map((f) => [f.account, f]));

  // codex-review Medium 対策: identity migration の状態を per-account で載せる。
  // 失敗しても silent にならないよう、hasUuid=false / lastError を popup 側から見える形に。
  const accountList = listAccounts();
  const identityByName = new Map(
    accountList.map((a) => [a.name, getIdentityStatus(a.path)])
  );

  // pollExclude: 別マシンが観測を担当しているアカウント。
  // 登録済みの名前だけ有効 (typo や削除済みアカウントの残骸は無視)
  const registered = new Set(accountList.map((a) => a.name));
  const excludeSet = new Set(getPollExclude().filter((n) => registered.has(n)));

  // snapshot がまだ 1 度も無い account (登録直後 or ずっと失敗) も UI に出す。
  // excluded は snapshot が今後増えないので、登録名から必ず出す
  const accountNames = new Set([
    ...snapshots.map((s) => s.account),
    ...failures.map((f) => f.account),
    ...excludeSet,
    ...accountList.map((a) => a.name),
  ]);

  // issue #23: activeAs 判定用の identity source。
  //   login = credentials.json ベース (getActiveInfo)
  //   token = ~/.claude-shift/env.sh の CLAUDE_CODE_OAUTH_TOKEN
  // 両者は独立に判定するので、split 運用 (login=A, token pin=B) では別アカウントに付く。
  const loginActiveName = getActiveInfo().name;
  const envToken = readEnvShToken();
  const setupTokenByName = envToken ? collectSetupTokens() : new Map();
  const tokenActiveName = envToken
    ? [...setupTokenByName.entries()].find(([, tok]) => tok === envToken)?.[0] ?? null
    : null;
  // token pin されたアカウントが snapshot / login list どちらにも出ていない
  // (token-only + 未 poll) 場合でも UI に出せるよう accountNames に足す
  if (tokenActiveName) accountNames.add(tokenActiveName);

  const accounts = [...accountNames].sort().map((name) => {
    const snap = snapshots.find((s) => s.account === name) ?? {
      account: name,
      captured_at: null,
      five_hour_pct: null,
      five_hour_reset_at: null,
      weekly_pct: null,
      weekly_reset_at: null,
    };
    const fail = failureByAccount.get(name);
    const excluded = excludeSet.has(name);
    const stale = excluded
      ? false // 観測対象外: このマシンでは更新されないのが正常なので stale 扱いしない
      : snap.captured_at == null
        ? true
        : now - snap.captured_at > STALE_THRESHOLD_MS;
    const idStatus = identityByName.get(name);
    // issue #23: 両方一致する通常運用時は 'login' を優先 (spec 準拠)。
    // split 運用時 (login=A, token pin=B) は別々のアカウントに 'login' / 'token' が付く。
    const activeAs =
      name === loginActiveName
        ? "login"
        : name === tokenActiveName
          ? "token"
          : null;
    return {
      ...snap,
      stale,
      excluded,
      // 除外中は過去の failure 残骸で「再ログイン必要」等を出さない (観測は別マシンの責務)
      needs_reauth: !excluded && fail ? !!fail.needs_reauth : false,
      last_error: excluded ? null : fail?.message ?? null,
      error_kind: excluded ? null : fail?.kind ?? null,
      error_at: excluded ? null : fail?.at ?? null,
      identity_missing: idStatus ? !idStatus.hasUuid : false,
      identity_error: idStatus?.lastError ?? null,
      activeAs,
    };
  });

  // issue #5: identity ベース照合。active_method で「uuid/token/なし」を出し、
  // sync_broken=true は claude CLI と shift の同期が切れていることを popup に伝える。
  const activeInfo = getActiveInfo();
  return {
    accounts,
    active: activeInfo.name,
    active_method: activeInfo.method,
    sync_broken: activeInfo.syncBroken,
    fetched_at: lastFetched || null,
    attempted_at: lastAttempted || null,
    any_stale: accounts.some((a) => a.stale),
    any_needs_reauth: accounts.some((a) => a.needs_reauth),
  };
}

function respond(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS プリフライト
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/usage") {
    respond(res, 200, buildUsagePayload());
    return;
  }

  if (url.pathname === "/usage/live") {
    await refresh();
    respond(res, 200, buildUsagePayload());
    return;
  }

  if (url.pathname === "/active") {
    if (req.method === "GET") {
      respond(res, 200, { active: getActiveAccount() });
      return;
    }
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const { name } = JSON.parse(body || "{}");
        if (!name) { respond(res, 400, { error: "name required" }); return; }
        await switchAccount(name);
        console.log(`[active] switched to ${name}`);
        respond(res, 200, { active: name });
      } catch (e) {
        respond(res, 400, { error: e.message });
      }
      return;
    }
  }

  if (url.pathname === "/history") {
    const account = url.searchParams.get("account");
    const hours = parseInt(url.searchParams.get("hours") ?? "24", 10);
    if (!account) { respond(res, 400, { error: "account param required" }); return; }
    respond(res, 200, getHistory(account, hours));
    return;
  }

  if (url.pathname === "/history/all") {
    const hours = parseInt(url.searchParams.get("hours") ?? "24", 10);
    respond(res, 200, getAllHistory(hours));
    return;
  }

  if (url.pathname === "/config") {
    if (req.method === "GET") {
      respond(res, 200, { pollMinutes, pollExclude: getPollExclude() });
      return;
    }
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body || "{}");
        const partial = {};

        if ("pollMinutes" in parsed) {
          const v = typeof parsed.pollMinutes === "number"
            ? parsed.pollMinutes
            : parseFloat(parsed.pollMinutes);
          if (!(v > 0)) {
            respond(res, 400, { error: "pollMinutes must be a positive number (minutes)" });
            return;
          }
          partial.pollMinutes = v;
        }

        if ("pollExclude" in parsed) {
          const list = parsed.pollExclude;
          if (!Array.isArray(list) || list.some((n) => typeof n !== "string" || !n)) {
            respond(res, 400, { error: "pollExclude must be an array of account names" });
            return;
          }
          partial.pollExclude = [...new Set(list)].sort();
        }

        if (Object.keys(partial).length === 0) {
          respond(res, 400, { error: "no config keys given (pollMinutes / pollExclude)" });
          return;
        }

        saveConfig(partial);
        if ("pollMinutes" in partial) {
          pollMinutes = partial.pollMinutes;
          reschedulePoll();
          console.log(`[config] pollMinutes → ${pollMinutes}`);
        }
        if ("pollExclude" in partial) {
          console.log(`[config] pollExclude → [${partial.pollExclude.join(", ")}]`);
        }
        respond(res, 200, { pollMinutes, pollExclude: getPollExclude() });
      } catch (e) {
        respond(res, 400, { error: "invalid JSON body" });
      }
      return;
    }
  }

  // ホワイトリスト static 配信 (popup 資産)。JSON API より後・404 より前に置くことで
  // 既存 API path とは衝突せず、未登録 path は従来どおり JSON 404 になる。
  if (req.method === "GET" && STATIC_ASSETS.has(url.pathname)) {
    await serveStatic(res, STATIC_ASSETS.get(url.pathname));
    return;
  }

  respond(res, 404, { error: "not found" });
});

// テストから listen(0) して静的配信の HTTP 挙動を確認できるように export する。
// module load 時点では listen() されないので、import しても port は掴まれない。
export { server };

// CLI として直接実行された時のみ listen する。
// テストが `import { isFullyFetched } from "../cli/server.js"` した際に port を掴んで
// EADDRINUSE で他テストと衝突するのを防ぐ。
if (process.argv[1] === new URL(import.meta.url).pathname) {
  server.listen(PORT, "127.0.0.1", async () => {
    // CLAUDE_SHIFT_PORT=0 (ephemeral) でも実 bind ポートを表示する (e2e はこの行から取得)
    console.log(`claude-shift server → http://127.0.0.1:${server.address().port}`);
    console.log(`polling every ${pollMinutes} minute(s)`);
    await refresh();
    reschedulePoll();
  });
}
