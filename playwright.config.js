import { defineConfig } from "@playwright/test";

// Local Web UI の e2e。サーバの起動・fixture HOME の用意は spec 側 (e2e/web-ui.spec.js) が行う。
// サーバ停止シナリオを含むためテストは直列 (workers: 1)。
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    locale: "ja-JP",
  },
});
