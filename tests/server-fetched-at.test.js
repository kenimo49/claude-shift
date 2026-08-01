import { test } from "node:test";
import assert from "node:assert/strict";
import { isFullyFetched } from "../cli/server.js";

// issue #7: lastFetched (= UI の「最終取得」時刻) の更新判定。
// needs_reauth は恒久的状態なので "取得失敗" から除外する。

test("全 account 成功なら isFullyFetched=true", () => {
  const data = [
    { name: "a", five_hour: { utilization: 30 } },
    { name: "b", five_hour: { utilization: 50 } },
  ];
  assert.equal(isFullyFetched(data), true);
});

test("空配列でも true (何も取得すべき対象が無い)", () => {
  assert.equal(isFullyFetched([]), true);
});

test("真の transient failure が 1 件でもあれば false", () => {
  const data = [
    { name: "a", five_hour: { utilization: 30 } },
    { name: "b", error: "network timeout", error_kind: "http_error", needs_reauth: false },
  ];
  assert.equal(isFullyFetched(data), false);
});

test("needs_reauth 単独では true (恒久的な状態なので取得失敗にカウントしない)", () => {
  const data = [
    { name: "a", five_hour: { utilization: 30 } },
    { name: "b", error: "refresh failed", error_kind: "refresh_failed", needs_reauth: true },
  ];
  assert.equal(isFullyFetched(data), true);
});

test("needs_reauth と transient が混在する場合は false", () => {
  const data = [
    { name: "a", five_hour: { utilization: 30 } },
    { name: "b", error: "refresh failed", error_kind: "refresh_failed", needs_reauth: true },
    { name: "c", error: "HTTP 500", error_kind: "http_error", needs_reauth: false },
  ];
  assert.equal(isFullyFetched(data), false);
});

test("全 account が needs_reauth でも true (他に成功があれば時刻更新、無くても attempted と同じ扱い)", () => {
  // 実際の server は accounts の登録が 0 でない前提。全 needs_reauth のケースは
  // 「取得すべき transient failure が無かった」ので lastFetched は更新される。
  // popup 側は any_needs_reauth banner + fetched_at 表示で状況を伝える。
  const data = [
    { name: "a", error: "refresh failed", error_kind: "refresh_failed", needs_reauth: true },
    { name: "b", error: "refresh failed", error_kind: "refresh_failed", needs_reauth: true },
  ];
  assert.equal(isFullyFetched(data), true);
});

test("error_kind=post_refresh_reauth も needs_reauth=true なら除外", () => {
  const data = [
    { name: "a", five_hour: { utilization: 30 } },
    { name: "b", error: "post refresh 401", error_kind: "post_refresh_reauth", needs_reauth: true },
  ];
  assert.equal(isFullyFetched(data), true);
});
