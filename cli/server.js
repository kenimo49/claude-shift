#!/usr/bin/env node
// localhost:PORT で usage データを提供するローカル API サーバー

import { createServer } from "http";
import { fetchAllUsage } from "./fetch-usage.js";
import { saveSnapshots, getLatestSnapshots, getHistory } from "./db.js";

const PORT = process.env.CLAUDE_SHIFT_PORT ?? 19867;
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10分ごとに自動取得

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

function respond(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/usage") {
    const latest = getLatestSnapshots();
    respond(res, 200, {
      accounts: latest,
      fetched_at: lastFetched,
    });
    return;
  }

  if (url.pathname === "/usage/live") {
    await refresh();
    respond(res, 200, { accounts: cache, fetched_at: lastFetched });
    return;
  }

  if (url.pathname === "/history") {
    const account = url.searchParams.get("account");
    const hours = parseInt(url.searchParams.get("hours") ?? "24", 10);
    if (!account) { respond(res, 400, { error: "account param required" }); return; }
    respond(res, 200, getHistory(account, hours));
    return;
  }

  respond(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`claude-shift server → http://127.0.0.1:${PORT}`);
  await refresh();
});

// 定期ポーリング
setInterval(refresh, POLL_INTERVAL_MS);
