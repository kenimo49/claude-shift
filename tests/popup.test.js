import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  escapeAttr,
  escapeHtml,
  fmtHM,
  fmtMD,
  classifyActiveAs,
} from "../extension/helpers.js";

describe("escapeAttr / escapeHtml", () => {
  test("特殊文字 & < > \" ' をすべてエンティティ化する", () => {
    assert.equal(
      escapeAttr(`<img src="x" onerror='a&b'>`),
      "&lt;img src=&quot;x&quot; onerror=&#39;a&amp;b&#39;&gt;",
    );
  });

  test("非文字列は toString して処理する", () => {
    assert.equal(escapeAttr(42), "42");
    assert.equal(escapeAttr(null), "null");
  });

  test("特殊文字を含まない文字列はそのまま返す", () => {
    assert.equal(escapeAttr("plain text 123"), "plain text 123");
  });

  test("escapeHtml は escapeAttr と同一のエスケープを行う", () => {
    const s = `<a href="?q=1&r=2">'x'</a>`;
    assert.equal(escapeHtml(s), escapeAttr(s));
  });
});

describe("fmtHM", () => {
  test("時・分を 2 桁ゼロ埋めで HH:MM に整形する", () => {
    const d = new Date(2026, 6, 15, 9, 5, 0);
    assert.equal(fmtHM(d.getTime()), "09:05");
  });

  test("24 時制で 23:59 まで正しく整形する", () => {
    const d = new Date(2026, 6, 15, 23, 59, 0);
    assert.equal(fmtHM(d.getTime()), "23:59");
  });

  test("00:00 はゼロ埋めされる", () => {
    const d = new Date(2026, 6, 15, 0, 0, 0);
    assert.equal(fmtHM(d.getTime()), "00:00");
  });
});

describe("fmtMD", () => {
  test("月・日は 1 桁のときゼロ埋めしない", () => {
    const d = new Date(2026, 0, 5, 0, 0, 0); // 2026/1/5
    assert.equal(fmtMD(d.getTime()), "1/5");
  });

  test("2 桁の月・日をそのまま返す", () => {
    const d = new Date(2026, 11, 25, 0, 0, 0); // 2026/12/25
    assert.equal(fmtMD(d.getTime()), "12/25");
  });
});

describe("classifyActiveAs", () => {
  const LOGIN = "alice";
  const TOKEN = "bob";

  test("login モード: loginActiveName と一致するときだけ true", () => {
    assert.equal(classifyActiveAs("alice", LOGIN, TOKEN, "login"), true);
    assert.equal(classifyActiveAs("bob", LOGIN, TOKEN, "login"), false);
    assert.equal(classifyActiveAs("carol", LOGIN, TOKEN, "login"), false);
  });

  test("token モード: tokenActiveName と一致するときだけ true", () => {
    assert.equal(classifyActiveAs("alice", LOGIN, TOKEN, "token"), false);
    assert.equal(classifyActiveAs("bob", LOGIN, TOKEN, "token"), true);
    assert.equal(classifyActiveAs("carol", LOGIN, TOKEN, "token"), false);
  });

  test("both モード: login または token のどちらかと一致すれば true", () => {
    assert.equal(classifyActiveAs("alice", LOGIN, TOKEN, "both"), true);
    assert.equal(classifyActiveAs("bob", LOGIN, TOKEN, "both"), true);
    assert.equal(classifyActiveAs("carol", LOGIN, TOKEN, "both"), false);
  });

  test("effective モード (既定): token pin があれば token 優先", () => {
    // token pin あり: bob だけが実効 active
    assert.equal(classifyActiveAs("alice", LOGIN, TOKEN, "effective"), false);
    assert.equal(classifyActiveAs("bob", LOGIN, TOKEN, "effective"), true);
  });

  test("effective モード: token pin が null なら login にフォールバック", () => {
    assert.equal(classifyActiveAs("alice", LOGIN, null, "effective"), true);
    assert.equal(classifyActiveAs("bob", LOGIN, null, "effective"), false);
  });

  test("activeHighlight を省略すると effective として扱う", () => {
    assert.equal(classifyActiveAs("bob", LOGIN, TOKEN), true);
    assert.equal(classifyActiveAs("alice", LOGIN, TOKEN), false);
    // token pin なし → login にフォールバック
    assert.equal(classifyActiveAs("alice", LOGIN, null), true);
  });

  test("未知の activeHighlight は effective として扱う (default 分岐)", () => {
    assert.equal(classifyActiveAs("bob", LOGIN, TOKEN, "unknown-mode"), true);
    assert.equal(classifyActiveAs("alice", LOGIN, TOKEN, "unknown-mode"), false);
  });
});
