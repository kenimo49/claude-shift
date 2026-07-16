import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSnapshots, saveFailures, getLatestFailuresPerAccount } from "../cli/db.js";

describe("failures テーブル", () => {
  test("saveFailures は error 入りだけ INSERT する", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-db-fail-"));
    try {
      saveFailures(
        [
          { name: "a", error: "boom", error_kind: "http_error", http_status: 500 },
          { name: "b", five_hour: { utilization: 10 } }, // 成功
          { name: "c", error: "reauth", error_kind: "refresh_failed", needs_reauth: true },
        ],
        dir
      );
      const latest = getLatestFailuresPerAccount(dir);
      assert.equal(latest.length, 2);
      const byName = new Map(latest.map((r) => [r.account, r]));
      assert.equal(byName.get("a").kind, "http_error");
      assert.equal(byName.get("a").http_status, 500);
      assert.equal(byName.get("c").needs_reauth, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("成功 snapshot が failure より新しい account は返らない (clear 済み)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-db-fail2-"));
    try {
      saveFailures([{ name: "a", error: "old boom", error_kind: "http_error" }], dir);
      // わずかに時間を進めるため sleep
      const wait = Date.now() + 5;
      while (Date.now() < wait) {}
      saveSnapshots(
        [
          {
            name: "a",
            five_hour: { utilization: 10, resets_at: "2026-07-16T10:00:00Z" },
            seven_day: { utilization: 5, resets_at: "2026-07-22T10:00:00Z" },
          },
        ],
        dir
      );
      const latest = getLatestFailuresPerAccount(dir);
      assert.equal(latest.length, 0, "成功後の failure は clear されるべき");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("成功 snapshot 後にまた失敗したら再び返る", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-db-fail3-"));
    try {
      saveSnapshots(
        [{ name: "a", five_hour: { utilization: 10, resets_at: "2026-07-16T10:00:00Z" } }],
        dir
      );
      const wait = Date.now() + 5;
      while (Date.now() < wait) {}
      saveFailures([{ name: "a", error: "later boom", error_kind: "http_error" }], dir);
      const latest = getLatestFailuresPerAccount(dir);
      assert.equal(latest.length, 1);
      assert.equal(latest[0].message, "later boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
