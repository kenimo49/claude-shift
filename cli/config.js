#!/usr/bin/env node
// ~/.claude-shift/config.json の読み書き。
// saveConfig は既存キーを保持する merge 保存 (pollMinutes だけ保存して
// pollExclude を消す、のような取りこぼしを防ぐ)。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".claude-shift", "config.json");

function resolvePath(configPath) {
  return configPath ?? process.env.CLAUDE_SHIFT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

export function loadConfig(configPath) {
  const path = resolvePath(configPath);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// 部分更新 (merge)。渡したキーだけ上書きし、他のキーは保持する。
export function saveConfig(partial, configPath) {
  const path = resolvePath(configPath);
  const next = { ...loadConfig(path), ...partial };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2));
  return next;
}

// pollExclude を「文字列の配列」に正規化して返す。壊れた値は空配列扱い。
export function getPollExclude(configPath) {
  const raw = loadConfig(configPath).pollExclude;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v) => typeof v === "string" && v.length > 0);
}

export function setPollExclude(name, excluded, configPath) {
  const current = new Set(getPollExclude(configPath));
  if (excluded) current.add(name);
  else current.delete(name);
  const list = [...current].sort();
  saveConfig({ pollExclude: list }, configPath);
  return list;
}

// CLI:
//   node cli/config.js get
//   node cli/config.js set-exclude <name> on|off   (on = 観測から除外する)
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [cmd, name, flag] = process.argv.slice(2);
  if (cmd === "get") {
    const cfg = loadConfig();
    console.log(JSON.stringify({ pollMinutes: cfg.pollMinutes ?? null, pollExclude: getPollExclude() }, null, 2));
  } else if (cmd === "set-exclude" && name && (flag === "on" || flag === "off")) {
    const list = setPollExclude(name, flag === "on");
    console.log(JSON.stringify({ pollExclude: list }, null, 2));
  } else {
    console.error("Usage: node cli/config.js get | set-exclude <name> on|off");
    process.exit(1);
  }
}
