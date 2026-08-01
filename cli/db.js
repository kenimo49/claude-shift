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

    CREATE TABLE IF NOT EXISTS failures (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account     TEXT    NOT NULL,
      at          INTEGER NOT NULL,
      kind        TEXT    NOT NULL,
      http_status INTEGER,
      needs_reauth INTEGER NOT NULL DEFAULT 0,
      message     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_failures_account ON failures(account, at);

    CREATE TABLE IF NOT EXISTS setup_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      account    TEXT    NOT NULL,
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_setup_tokens_account ON setup_tokens(account, issued_at);
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
      // excluded (pollExclude で観測対象外) は成功でも失敗でもないので snapshot に残さない
      .filter((u) => !u.error && !u.excluded)
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

// usageList 中の error 入りエントリを failures テーブルへ書き出す。
// 直前の成功以降だけを見るために、per-account の最新 failure を後段で使う。
export function saveFailures(usageList, dataDir) {
  const failing = usageList.filter((u) => u.error);
  if (failing.length === 0) return;
  const db = openDb(dataDir);
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO failures
      (account, at, kind, http_status, needs_reauth, message)
    VALUES
      (@account, @at, @kind, @http_status, @needs_reauth, @message)
  `);
  const insertAll = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
  insertAll(
    failing.map((u) => ({
      account: u.name,
      at: now,
      kind: u.error_kind ?? "http_error",
      http_status: u.http_status ?? null,
      needs_reauth: u.needs_reauth ? 1 : 0,
      message: u.error ?? null,
    }))
  );
  db.close();
}

// account ごとの「最新 snapshot 以降に起きた最新 failure」を返す。
// 成功した snapshot が failure より新しければその account は clear 扱い (返り値に含まれない)。
//
// 同一ミリ秒 (lf.at === ls.at) の場合は snapshot 側を優先し、failure を返さない。
// これは saveSnapshots → saveFailures の順で同一 refresh サイクル内に呼ばれる設計を
// 反映したもので、成功と失敗が同時刻タイの場合はユーザー体験として「成功後の失敗」より
// 「失敗前の成功」を最新として扱う方が UI が混乱しにくい。
// (同一 account が同一 refresh サイクル内で成功 & 失敗の両方になることは無いので、
//  この境界が発火するのは別サイクルで運悪く clock が同 ms に揃った時のみ)
export function getLatestFailuresPerAccount(dataDir) {
  const db = openDb(dataDir);
  const rows = db
    .prepare(`
      WITH latest_snap AS (
        SELECT account, MAX(captured_at) AS at FROM snapshots GROUP BY account
      ),
      latest_fail AS (
        SELECT f.* FROM failures f
        INNER JOIN (
          SELECT account, MAX(at) AS at FROM failures GROUP BY account
        ) t ON f.account = t.account AND f.at = t.at
      )
      SELECT lf.*
      FROM latest_fail lf
      LEFT JOIN latest_snap ls ON ls.account = lf.account
      WHERE ls.at IS NULL OR lf.at > ls.at
    `)
    .all();
  db.close();
  return rows;
}

// setup-token の発行記録。1年期限の再発行管理用に履歴として append する。
// 同一 account への再発行は行を追加する (上書きしない)。最新行が現行 token。
export function saveSetupTokenIssuance({ account, issuedAt, expiresAt }, dataDir) {
  const db = openDb(dataDir);
  db.prepare(
    `INSERT INTO setup_tokens (account, issued_at, expires_at) VALUES (?, ?, ?)`
  ).run(account, issuedAt, expiresAt);
  db.close();
}

// account ごとの最新発行記録を返す。account 指定なしなら全アカウント分。
export function getLatestSetupTokenIssuances(dataDir) {
  const db = openDb(dataDir);
  const rows = db
    .prepare(`
      SELECT s.*
      FROM setup_tokens s
      INNER JOIN (
        SELECT account, MAX(issued_at) AS max_at
        FROM setup_tokens
        GROUP BY account
      ) t ON s.account = t.account AND s.issued_at = t.max_at
      ORDER BY s.account
    `)
    .all();
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
