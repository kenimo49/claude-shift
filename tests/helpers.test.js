import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatCountdown, formatResetClock, renderBar } from "../extension/helpers.js";

// 固定基準時刻でドリフトを排除
const BASE = new Date("2026-07-15T10:00:00.000Z").getTime();

describe("formatCountdown", () => {
  test("null を渡すと null を返す", () => {
    assert.equal(formatCountdown(null, BASE), null);
  });

  test("過去のタイムスタンプは「リセット済み」", () => {
    assert.equal(formatCountdown(BASE - 1000, BASE), "リセット済み");
  });

  test("同時刻は「リセット済み」", () => {
    assert.equal(formatCountdown(BASE, BASE), "リセット済み");
  });

  test("30分後", () => {
    assert.equal(formatCountdown(BASE + 30 * 60 * 1000, BASE), "30分後");
  });

  test("1時間20分後", () => {
    assert.equal(formatCountdown(BASE + 80 * 60 * 1000, BASE), "1時間 20分後");
  });

  test("5時間0分後", () => {
    assert.equal(formatCountdown(BASE + 5 * 3600 * 1000, BASE), "5時間 0分後");
  });

  test("25時間後は日単位表示", () => {
    assert.equal(formatCountdown(BASE + 25 * 3600 * 1000, BASE), "1日 1時間後");
  });

  test("48時間後", () => {
    assert.equal(formatCountdown(BASE + 48 * 3600 * 1000, BASE), "2日 0時間後");
  });
});

describe("formatResetClock", () => {
  test("null を渡すと null を返す", () => {
    assert.equal(formatResetClock(null), null);
  });

  test("当日のタイムスタンプは HH:MM 形式", () => {
    const d = new Date();
    d.setHours(15, 30, 0, 0);
    const result = formatResetClock(d.getTime());
    assert.equal(result, "15:30");
  });

  test("別日のタイムスタンプは M/D HH:MM 形式", () => {
    const d = new Date(2026, 11, 25, 8, 0, 0); // 2026/12/25 08:00
    const result = formatResetClock(d.getTime());
    assert.equal(result, "12/25 08:00");
  });

  test("月・日が1桁でもゼロ埋めなし", () => {
    const d = new Date(2026, 0, 5, 9, 5, 0); // 2026/1/5 09:05
    const result = formatResetClock(d.getTime());
    assert.equal(result, "1/5 09:05");
  });
});

describe("renderBar", () => {
  test("null を渡すと空文字", () => {
    assert.equal(renderBar(null), "");
  });

  test("0% は cls なし", () => {
    const html = renderBar(0);
    assert.match(html, /width:0%/);
    assert.doesNotMatch(html, /danger|warning/);
    assert.match(html, /0% 使用中/);
  });

  test("54% は cls なし", () => {
    assert.doesNotMatch(renderBar(54), /danger|warning/);
  });

  test("55% は warning クラス", () => {
    assert.match(renderBar(55), /warning/);
  });

  test("84% は warning クラス", () => {
    const html = renderBar(84);
    assert.match(html, /warning/);
    assert.doesNotMatch(html, /danger/);
  });

  test("85% は danger クラス", () => {
    assert.match(renderBar(85), /danger/);
  });

  test("100% は danger クラス + 上限クランプ", () => {
    const html = renderBar(100);
    assert.match(html, /danger/);
    assert.match(html, /width:100%/);
  });

  test("110% は 100% にクランプ", () => {
    assert.match(renderBar(110), /width:100%/);
  });

  test("負値は 0% にクランプ", () => {
    assert.match(renderBar(-5), /width:0%/);
  });
});
