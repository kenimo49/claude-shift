import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProfileUrl } from "../cli/accounts.js";

// CLAUDE_SHIFT_PROFILE_URL は e2e 用の seam だが、fetchProfile は実 OAuth token を
// Bearer で送るので、env 注入で任意 URL へ token を送れないよう loopback のみ許可する。

const DEFAULT = "https://api.anthropic.com/api/oauth/profile";

test("未設定なら既定の Anthropic URL", () => {
  assert.equal(resolveProfileUrl(undefined), DEFAULT);
  assert.equal(resolveProfileUrl(""), DEFAULT);
});

test("loopback への差し替えは許可される", () => {
  assert.equal(
    resolveProfileUrl("http://127.0.0.1:19867/stub"),
    "http://127.0.0.1:19867/stub"
  );
  assert.equal(resolveProfileUrl("http://localhost:8080/x"), "http://localhost:8080/x");
  assert.equal(resolveProfileUrl("http://[::1]:8080/x"), "http://[::1]:8080/x");
});

test("外部ホストへの差し替えは拒否して既定 URL に戻す", () => {
  assert.equal(resolveProfileUrl("https://evil.example.com/steal"), DEFAULT);
  // loopback を装った紛らわしいホストも拒否
  assert.equal(resolveProfileUrl("http://127.0.0.1.evil.example.com/"), DEFAULT);
});

test("URL として不正な値は既定 URL に戻す", () => {
  assert.equal(resolveProfileUrl("not a url"), DEFAULT);
});
