#!/usr/bin/env node
// 各アカウントの usage を api.anthropic.com から取得する

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEFAULT_ACCOUNTS_DIR = join(homedir(), ".claude-shift", "accounts");
const API_URL = "https://api.anthropic.com/api/oauth/usage";

export async function fetchUsage(token) {
  const res = await fetch(API_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function loadAccounts(accountsDir = DEFAULT_ACCOUNTS_DIR) {
  let entries;
  try {
    entries = readdirSync(accountsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => {
      const name = e.name.replace(/\.json$/, "");
      const raw = JSON.parse(readFileSync(join(accountsDir, e.name), "utf8"));
      const token =
        raw.accessToken ??
        raw.claudeAiOauth?.accessToken ??
        raw.access_token ??
        null;
      return { name, token };
    })
    .filter((a) => a.token);
}

export async function fetchAllUsage() {
  const accounts = loadAccounts();
  const results = await Promise.allSettled(
    accounts.map(async ({ name, token }) => {
      const data = await fetchUsage(token);
      return { name, ...data };
    })
  );
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { name: accounts[i].name, error: r.reason.message }
  );
}

// CLI として直接実行した場合
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const all = await fetchAllUsage();
  console.log(JSON.stringify(all, null, 2));
}
