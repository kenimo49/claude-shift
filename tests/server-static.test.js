import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { server } from "../cli/server.js";

// ROADMAP 案A: shift server が extension/ の popup 資産を静的配信し、ブラウザから
// http://127.0.0.1:19867/ で開けるようにする。ここではその配信ルートの HTTP 挙動を確認する。
// listen(0) で ephemeral port を掴むので既存 19867 との衝突は無い。

const EXTENSION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "extension"
);

let base;

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("GET / は popup.html を text/html で返す", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const body = await res.text();
  const expected = await readFile(join(EXTENSION_DIR, "popup.html"), "utf8");
  assert.equal(body, expected);
  // 中身の目印: popup.html にしかない要素
  assert.match(body, /<title>Claude Shift<\/title>/);
  assert.match(body, /id="accounts"/);
});

test("GET /popup.js は JavaScript 系 Content-Type で返る", async () => {
  const res = await fetch(`${base}/popup.js`);
  assert.equal(res.status, 200);
  const ct = res.headers.get("content-type") ?? "";
  // text/javascript でも application/javascript でも OK
  assert.match(ct, /(text|application)\/javascript/);
  const body = await res.text();
  const expected = await readFile(join(EXTENSION_DIR, "popup.js"), "utf8");
  assert.equal(body, expected);
});

test("GET /helpers.js と /styles.css も配信される", async () => {
  const helpers = await fetch(`${base}/helpers.js`);
  assert.equal(helpers.status, 200);
  assert.match(helpers.headers.get("content-type") ?? "", /(text|application)\/javascript/);

  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
});

test("path traversal (/../cli/server.js) は 404 になる", async () => {
  const res = await fetch(`${base}/../cli/server.js`);
  assert.equal(res.status, 404);
  // 既存の JSON 404 挙動を保つ (未知パスは JSON エラーで返す)
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
});

test("URL エンコードした path traversal も 404 になる", async () => {
  // WHATWG URL は %2e%2e を .. に正規化してから dot segment を潰すため
  // pathname は /cli/server.js になるが、いずれにせよホワイトリスト外で 404。
  const res = await fetch(`${base}/%2e%2e/cli/server.js`);
  assert.equal(res.status, 404);

  // 別変種: extension/ 配下を狙う (whitelist されていない実在パス)
  const res2 = await fetch(`${base}/../extension/manifest.json`);
  assert.equal(res2.status, 404);
});

test("既存 JSON API (/config) は影響を受けない", async () => {
  const res = await fetch(`${base}/config`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assert.ok(typeof body.pollMinutes === "number");
  assert.ok(Array.isArray(body.pollExclude));
});
