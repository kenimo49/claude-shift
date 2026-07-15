#!/usr/bin/env node
// SQLite に usage スナップショットを時系列保存する

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function defaultDataDir() {
  return process.env.CLAUDE_SHIFT_DATA_DIR ?? join(homedir(), ".claude-shift");
}

function openDb(dataDir = defaultDataDir()) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "usage.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account     TEXT    NOT NULL,
      captured_at INTEGER NOT NULL,
      five_hour_pct  REAL,
      five_hour_reset_at INTEGER,
      weekly_pct     REAL,
      weekly_reset_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_account ON snapshots(account, captured_at);
  `);
  return db;
}

export function saveSnapshots(usageList, dataDir) {
  const db = openDb(dataDir);
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO snapshots
      (account, captured_at, five_hour_pct, five_hour_reset_at, weekly_pct, weekly_reset_at)
    VALUES
      (@account, @captured_at, @five_hour_pct, @five_hour_reset_at, @weekly_pct, @weekly_reset_at)
  `);
  const insertAll = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
  insertAll(
    usageList
      .filter((u) => !u.error)
      .map((u) => ({
        account: u.name,
        captured_at: now,
        five_hour_pct: u.five_hour?.utilization ?? null,
        five_hour_reset_at: u.five_hour?.resets_at
          ? new Date(u.five_hour.resets_at).getTime()
          : null,
        weekly_pct: u.seven_day?.utilization ?? null,
        weekly_reset_at: u.seven_day?.resets_at
          ? new Date(u.seven_day.resets_at).getTime()
          : null,
      }))
  );
  db.close();
}

export function getLatestSnapshots(dataDir) {
  const db = openDb(dataDir);
  const rows = db
    .prepare(`
      SELECT s.*
      FROM snapshots s
      INNER JOIN (
        SELECT account, MAX(captured_at) AS max_at
        FROM snapshots
        GROUP BY account
      ) t ON s.account = t.account AND s.captured_at = t.max_at
      ORDER BY s.account
    `)
    .all();
  db.close();
  return rows;
}

export function getHistory(account, limitHours = 24, dataDir) {
  const db = openDb(dataDir);
  const since = Date.now() - limitHours * 3600 * 1000;
  const rows = db
    .prepare(
      `SELECT * FROM snapshots
       WHERE account = ? AND captured_at >= ?
       ORDER BY captured_at ASC`
    )
    .all(account, since);
  db.close();
  return rows;
}

// 全アカウント分の履歴を一括取得
export function getAllHistory(limitHours = 24, dataDir) {
  const db = openDb(dataDir);
  const since = Date.now() - limitHours * 3600 * 1000;
  const rows = db
    .prepare(
      `SELECT * FROM snapshots
       WHERE captured_at >= ?
       ORDER BY account ASC, captured_at ASC`
    )
    .all(since);
  db.close();
  // {account: [...], account2: [...]} の形にまとめる
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.account]) grouped[r.account] = [];
    grouped[r.account].push(r);
  }
  return grouped;
}
