#!/usr/bin/env node
// localhost:PORT で usage データを提供するローカル API サーバー

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fetchAllUsage } from "./fetch-usage.js";
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
} from "./accounts.js";

const PORT = process.env.CLAUDE_SHIFT_PORT ?? 19867;
const CONFIG_PATH =
  process.env.CLAUDE_SHIFT_CONFIG_PATH ??
  join(homedir(), ".claude-shift", "config.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}

function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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

  // snapshot がまだ 1 度も無い account (登録直後 or ずっと失敗) も UI に出す
  const accountNames = new Set([
    ...snapshots.map((s) => s.account),
    ...failures.map((f) => f.account),
  ]);

  // codex-review Medium 対策: identity migration の状態を per-account で載せる。
  // 失敗しても silent にならないよう、hasUuid=false / lastError を popup 側から見える形に。
  const accountList = listAccounts();
  const identityByName = new Map(
    accountList.map((a) => [a.name, getIdentityStatus(a.path)])
  );

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
    const stale = snap.captured_at == null
      ? true
      : now - snap.captured_at > STALE_THRESHOLD_MS;
    const idStatus = identityByName.get(name);
    return {
      ...snap,
      stale,
      needs_reauth: fail ? !!fail.needs_reauth : false,
      last_error: fail?.message ?? null,
      error_kind: fail?.kind ?? null,
      error_at: fail?.at ?? null,
      identity_missing: idStatus ? !idStatus.hasUuid : false,
      identity_error: idStatus?.lastError ?? null,
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
      respond(res, 200, { pollMinutes });
      return;
    }
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const { pollMinutes: newVal } = JSON.parse(body || "{}");
        const v = typeof newVal === "number" ? newVal : parseFloat(newVal);
        if (!(v > 0)) {
          respond(res, 400, { error: "pollMinutes must be a positive number (minutes)" });
          return;
        }
        pollMinutes = v;
        saveConfig({ pollMinutes });
        reschedulePoll();
        console.log(`[config] pollMinutes → ${pollMinutes}`);
        respond(res, 200, { pollMinutes });
      } catch (e) {
        respond(res, 400, { error: "invalid JSON body" });
      }
      return;
    }
  }

  respond(res, 404, { error: "not found" });
});

// CLI として直接実行された時のみ listen する。
// テストが `import { isFullyFetched } from "../cli/server.js"` した際に port を掴んで
// EADDRINUSE で他テストと衝突するのを防ぐ。
if (process.argv[1] === new URL(import.meta.url).pathname) {
  server.listen(PORT, "127.0.0.1", async () => {
    console.log(`claude-shift server → http://127.0.0.1:${PORT}`);
    console.log(`polling every ${pollMinutes} minute(s)`);
    await refresh();
    reschedulePoll();
  });
}
