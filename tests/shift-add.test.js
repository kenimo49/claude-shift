import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SHIFT = resolve("shift.sh");

// 隔離用の HOME を作って credentials.json と accounts/ を配置
function makeIsolatedHome({ credentialsToken, accounts = {} }) {
  const home = mkdtempSync(join(tmpdir(), "cs-shift-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".claude-shift", "accounts"), { recursive: true });
  if (credentialsToken !== undefined) {
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: credentialsToken, refreshToken: "r" } }, null, 2)
    );
  }
  for (const [name, token] of Object.entries(accounts)) {
    writeFileSync(
      join(home, ".claude-shift", "accounts", `${name}.json`),
      JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r" } }, null, 2)
    );
  }
  return home;
}

// shift.sh を隔離 HOME 下で実行
function runShift(home, args) {
  try {
    const stdout = execFileSync("bash", [SHIFT, ...args], {
      env: { ...process.env, HOME: home, PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: stdout.toString(), stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? -1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

describe("shift add — duplicate token detection", () => {
  test("同一トークンが既に別ラベルで登録済みなら中止", () => {
    const home = mkdtempSync(join(tmpdir(), "cs-dup-"));
    try {
      const isolated = makeIsolatedHome({
        credentialsToken: "sk-ant-oat01-SAME",
        accounts: { kumiko: "sk-ant-oat01-SAME" },
      });
      try {
        const r = runShift(isolated, ["add", "kumiko-copy"]);
        assert.notEqual(r.code, 0);
        assert.match(r.stderr, /既に別アカウント 'kumiko'/);
        assert.ok(!existsSync(join(isolated, ".claude-shift", "accounts", "kumiko-copy.json")));
      } finally {
        rmSync(isolated, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("-f で重複警告を無視して強制登録", () => {
    const isolated = makeIsolatedHome({
      credentialsToken: "sk-ant-oat01-SAME",
      accounts: { kumiko: "sk-ant-oat01-SAME" },
    });
    try {
      const r = runShift(isolated, ["add", "kumiko-copy", "-f"]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Saved as:/);
      const saved = JSON.parse(
        readFileSync(join(isolated, ".claude-shift", "accounts", "kumiko-copy.json"), "utf8")
      );
      assert.equal(saved.claudeAiOauth.accessToken, "sk-ant-oat01-SAME");
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("同名アカウントへの上書きは警告なしで成功", () => {
    const isolated = makeIsolatedHome({
      credentialsToken: "sk-ant-oat01-NEW",
      accounts: { kumiko: "sk-ant-oat01-OLD" },
    });
    try {
      const r = runShift(isolated, ["add", "kumiko"]);
      assert.equal(r.code, 0);
      const saved = JSON.parse(
        readFileSync(join(isolated, ".claude-shift", "accounts", "kumiko.json"), "utf8")
      );
      assert.equal(saved.claudeAiOauth.accessToken, "sk-ant-oat01-NEW");
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("別トークンなら新規ラベルで登録できる", () => {
    const isolated = makeIsolatedHome({
      credentialsToken: "sk-ant-oat01-B",
      accounts: { accountA: "sk-ant-oat01-A" },
    });
    try {
      const r = runShift(isolated, ["add", "accountB"]);
      assert.equal(r.code, 0);
      const saved = JSON.parse(
        readFileSync(join(isolated, ".claude-shift", "accounts", "accountB.json"), "utf8")
      );
      assert.equal(saved.claudeAiOauth.accessToken, "sk-ant-oat01-B");
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("credentials.json が存在しない場合はエラー", () => {
    const isolated = makeIsolatedHome({});
    try {
      const r = runShift(isolated, ["add", "nowhere"]);
      assert.notEqual(r.code, 0);
      assert.match(r.stdout + r.stderr, /credentials\.json が見つかりません/);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("引数なしは Usage メッセージ", () => {
    const isolated = makeIsolatedHome({ credentialsToken: "sk-ant-oat01-X" });
    try {
      const r = runShift(isolated, ["add"]);
      assert.notEqual(r.code, 0);
      assert.match(r.stdout + r.stderr, /Usage: shift add/);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("shift rm", () => {
  test("非アクティブアカウントを削除", () => {
    const isolated = makeIsolatedHome({
      credentialsToken: "sk-ant-oat01-A",
      accounts: { accountA: "sk-ant-oat01-A", accountB: "sk-ant-oat01-B" },
    });
    try {
      const r = runShift(isolated, ["rm", "accountB"]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Removed: accountB/);
      assert.ok(!existsSync(join(isolated, ".claude-shift", "accounts", "accountB.json")));
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("アクティブアカウントは -f なしで削除拒否", () => {
    const isolated = makeIsolatedHome({
      credentialsToken: "sk-ant-oat01-A",
      accounts: { accountA: "sk-ant-oat01-A" },
    });
    try {
      const r = runShift(isolated, ["rm", "accountA"]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /現在アクティブなアカウント/);
      assert.ok(existsSync(join(isolated, ".claude-shift", "accounts", "accountA.json")));
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("アクティブアカウントも -f で削除できる", () => {
    const isolated = makeIsolatedHome({
      credentialsToken: "sk-ant-oat01-A",
      accounts: { accountA: "sk-ant-oat01-A" },
    });
    try {
      const r = runShift(isolated, ["rm", "accountA", "-f"]);
      assert.equal(r.code, 0);
      assert.ok(!existsSync(join(isolated, ".claude-shift", "accounts", "accountA.json")));
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("存在しないアカウントは Not found", () => {
    const isolated = makeIsolatedHome({ credentialsToken: "sk-ant-oat01-X" });
    try {
      const r = runShift(isolated, ["rm", "ghost"]);
      assert.notEqual(r.code, 0);
      assert.match(r.stdout + r.stderr, /not found/i);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
