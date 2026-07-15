#!/usr/bin/env node
// localhost:PORT で usage データを提供するローカル API サーバー

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fetchAllUsage } from "./fetch-usage.js";
import { saveSnapshots, getLatestSnapshots, getHistory, getAllHistory } from "./db.js";
import { getActiveAccount, switchAccount } from "./accounts.js";

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
let lastFetched = 0;

async function refresh() {
  try {
    const data = await fetchAllUsage();
    saveSnapshots(data);
    cache = data;
    lastFetched = Date.now();
    console.log(`[${new Date().toISOString()}] fetched ${data.length} accounts`);
  } catch (e) {
    console.error("fetch error:", e.message);
  }
}

function reschedulePoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, pollMinutes * 60 * 1000);
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
    respond(res, 200, {
      accounts: getLatestSnapshots(),
      active: getActiveAccount(),
      fetched_at: lastFetched,
    });
    return;
  }

  if (url.pathname === "/usage/live") {
    await refresh();
    respond(res, 200, {
      accounts: getLatestSnapshots(),
      active: getActiveAccount(),
      fetched_at: lastFetched,
    });
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

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`claude-shift server → http://127.0.0.1:${PORT}`);
  console.log(`polling every ${pollMinutes} minute(s)`);
  await refresh();
  reschedulePoll();
});
