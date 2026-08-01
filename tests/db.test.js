import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSnapshots, getLatestSnapshots, getHistory } from "../cli/db.js";

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-shift-test-"));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const makeUsage = (name, fhPct, wkPct, offsetMs = 0) => ({
  name,
  five_hour: {
    utilization: fhPct,
    resets_at: new Date(Date.now() + 5 * 3600 * 1000 + offsetMs).toISOString(),
  },
  seven_day: {
    utilization: wkPct,
    resets_at: new Date(Date.now() + 7 * 24 * 3600 * 1000 + offsetMs).toISOString(),
  },
});

describe("saveSnapshots + getLatestSnapshots", () => {
  test("保存したデータが取得できる", () => {
    saveSnapshots([makeUsage("accountA", 38, 44)], tmpDir);
    const rows = getLatestSnapshots(tmpDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account, "accountA");
    assert.equal(rows[0].five_hour_pct, 38);
    assert.equal(rows[0].weekly_pct, 44);
  });

  test("複数アカウントをまとめて保存できる", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "claude-shift-test-multi-"));
    try {
      saveSnapshots(
        [makeUsage("acctA", 10, 20), makeUsage("acctB", 50, 60)],
        tmp2
      );
      const rows = getLatestSnapshots(tmp2);
      assert.equal(rows.length, 2);
      const names = rows.map((r) => r.account).sort();
      assert.deepEqual(names, ["acctA", "acctB"]);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  test("同アカウントを2回保存したとき最新のみ返る", () => {
    const tmp3 = mkdtempSync(join(tmpdir(), "claude-shift-test-latest-"));
    try {
      saveSnapshots([makeUsage("acct", 10, 20)], tmp3);
      saveSnapshots([makeUsage("acct", 90, 80)], tmp3);
      const rows = getLatestSnapshots(tmp3);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].five_hour_pct, 90);
    } finally {
      rmSync(tmp3, { recursive: true, force: true });
    }
  });

  test("error フィールドがあるアカウントはスキップされる", () => {
    const tmp4 = mkdtempSync(join(tmpdir(), "claude-shift-test-err-"));
    try {
      saveSnapshots([{ name: "broken", error: "HTTP 401" }], tmp4);
      const rows = getLatestSnapshots(tmp4);
      assert.equal(rows.length, 0);
    } finally {
      rmSync(tmp4, { recursive: true, force: true });
    }
  });
});

describe("getHistory", () => {
  test("指定アカウントの履歴のみ返る", () => {
    const tmp5 = mkdtempSync(join(tmpdir(), "claude-shift-test-hist-"));
    try {
      saveSnapshots([makeUsage("alpha", 10, 20), makeUsage("beta", 30, 40)], tmp5);
      const rows = getHistory("alpha", 24, tmp5);
      assert.ok(rows.every((r) => r.account === "alpha"));
    } finally {
      rmSync(tmp5, { recursive: true, force: true });
    }
  });

  test("存在しないアカウントは空配列を返す", () => {
    const rows = getHistory("nonexistent", 24, tmpDir);
    assert.deepEqual(rows, []);
  });
});
