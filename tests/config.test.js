import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, getPollExclude, setPollExclude } from "../cli/config.js";
import { fetchAllUsage } from "../cli/fetch-usage.js";
import { saveSnapshots, getLatestSnapshots } from "../cli/db.js";

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-shift-config-test-"));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("saveConfig merge保存", () => {
  test("部分更新しても既存キーが保持される", () => {
    const path = join(tmpDir, "merge.json");
    saveConfig({ pollMinutes: 5 }, path);
    saveConfig({ pollExclude: ["imoto-team"] }, path);
    const cfg = loadConfig(path);
    assert.equal(cfg.pollMinutes, 5);
    assert.deepEqual(cfg.pollExclude, ["imoto-team"]);

    // pollMinutes を更新しても pollExclude は残る (旧 server.js の丸ごと上書き回帰防止)
    saveConfig({ pollMinutes: 10 }, path);
    const cfg2 = loadConfig(path);
    assert.equal(cfg2.pollMinutes, 10);
    assert.deepEqual(cfg2.pollExclude, ["imoto-team"]);
  });

  test("壊れた JSON は空 config 扱い", () => {
    const path = join(tmpDir, "broken.json");
    writeFileSync(path, "{not json");
    assert.deepEqual(loadConfig(path), {});
  });
});

describe("getPollExclude / setPollExclude", () => {
  test("配列でない・文字列でない値は無視される", () => {
    const path = join(tmpDir, "invalid.json");
    writeFileSync(path, JSON.stringify({ pollExclude: "imoto-team" }));
    assert.deepEqual(getPollExclude(path), []);

    writeFileSync(path, JSON.stringify({ pollExclude: ["ok", 42, null, ""] }));
    assert.deepEqual(getPollExclude(path), ["ok"]);
  });

  test("on/off で追加・削除、重複追加しない", () => {
    const path = join(tmpDir, "toggle.json");
    assert.deepEqual(setPollExclude("a", true, path), ["a"]);
    assert.deepEqual(setPollExclude("a", true, path), ["a"]);
    assert.deepEqual(setPollExclude("b", true, path), ["a", "b"]);
    assert.deepEqual(setPollExclude("a", false, path), ["b"]);
  });
});

describe("fetchAllUsage の pollExclude", () => {
  const makeAccount = (dir, name) => {
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `token-${name}`,
          refreshToken: `refresh-${name}`,
          expiresAt: Date.now() + 3600_000,
        },
      })
    );
  };

  test("除外アカウントは fetch されず excluded: true を返す", async () => {
    const accountsDir = join(tmpDir, "accounts-excluded");
    mkdirSync(accountsDir, { recursive: true });
    makeAccount(accountsDir, "solo");

    // 唯一のアカウントを除外 → ネットワークに一切出ないで返る
    const results = await fetchAllUsage(accountsDir, { pollExclude: ["solo"] });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, "solo");
    assert.equal(results[0].excluded, true);
    assert.equal(results[0].via, "excluded");
    assert.equal(results[0].error, undefined);
  });

  test("pollExclude が空なら全アカウントが対象 (excluded エントリ無し)", async () => {
    const accountsDir = join(tmpDir, "accounts-empty-exclude");
    mkdirSync(accountsDir, { recursive: true });
    // アカウント 0 件で呼んでも空配列 (getPollExclude fallback を踏まないよう明示指定)
    const results = await fetchAllUsage(accountsDir, { pollExclude: [] });
    assert.deepEqual(results, []);
  });
});

describe("saveSnapshots は excluded を保存しない", () => {
  test("excluded エントリが null snapshot として混入しない", () => {
    const dataDir = join(tmpDir, "db-excluded");
    saveSnapshots(
      [
        {
          name: "observed",
          five_hour: { utilization: 12, resets_at: new Date().toISOString() },
          seven_day: { utilization: 34, resets_at: new Date().toISOString() },
        },
        { name: "elsewhere", excluded: true, via: "excluded" },
      ],
      dataDir
    );
    const rows = getLatestSnapshots(dataDir);
    assert.deepEqual(rows.map((r) => r.account), ["observed"]);
  });
});
