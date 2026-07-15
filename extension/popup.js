import { formatCountdown, formatResetClock, renderBar } from "./helpers.js";

const SERVER = "http://127.0.0.1:19867";

function renderLimit(title, pct, resetAt) {
  const countdown = formatCountdown(resetAt);
  const clock = formatResetClock(resetAt);
  const resetText = countdown ? `${countdown}${clock ? ` (${clock})` : ""}` : "不明";
  return `
    <div class="limit-block">
      <div class="limit-header">
        <span class="limit-label">${title}</span>
        <span class="limit-reset">${resetText}</span>
      </div>
      ${renderBar(pct)}
    </div>`;
}

function renderAccount(row, activeName) {
  const isActive = row.account === activeName;
  const marker = isActive
    ? '<span class="active-badge">使用中</span>'
    : `<button class="switch-btn" data-account="${row.account}">切替</button>`;
  return `
    <div class="account-card ${isActive ? "is-active" : ""}">
      <div class="account-header">
        <div class="account-name">${row.account}</div>
        ${marker}
      </div>
      ${renderLimit("5時間枠", row.five_hour_pct, row.five_hour_reset_at)}
      ${renderLimit("週次", row.weekly_pct, row.weekly_reset_at)}
    </div>`;
}

async function load(live = false) {
  const container = document.getElementById("accounts");
  const btn = document.getElementById("btn-refresh");

  if (live) {
    btn.disabled = true;
    btn.classList.add("loading");
    btn.textContent = "更新中...";
  } else {
    container.innerHTML = "<p class='loading'>取得中...</p>";
  }

  try {
    const endpoint = live ? `${SERVER}/usage/live` : `${SERVER}/usage`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { accounts, active, fetched_at } = await res.json();

    if (!accounts || accounts.length === 0) {
      container.innerHTML = "<p class='empty'>アカウントが見つかりません。<br>~/.claude-shift/accounts/ にcredentialsを追加してください。</p>";
      return;
    }

    container.innerHTML = accounts.map((a) => renderAccount(a, active)).join("");

    const ts = document.getElementById("timestamp");
    if (fetched_at) {
      const d = new Date(fetched_at);
      ts.textContent = `最終取得: ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    }
  } catch (e) {
    container.innerHTML = `<p class='error'>サーバーに接続できません。<br><code>shift server</code> を起動してください。<br><small>${e.message}</small></p>`;
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.textContent = "今すぐ更新";
  }
}

// ---- 設定モーダル ----

async function openSettings() {
  const modal = document.getElementById("modal");
  const input = document.getElementById("poll-minutes");
  const msg = document.getElementById("modal-msg");
  msg.textContent = "";
  msg.className = "modal-msg";

  input.value = "";
  input.placeholder = "取得中...";
  modal.classList.remove("hidden");
  input.focus();

  try {
    const res = await fetch(`${SERVER}/config`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    input.value = cfg.pollMinutes;
    input.placeholder = "";
  } catch (e) {
    msg.textContent = `現在の設定を取得できません: ${e.message}`;
    msg.className = "modal-msg error";
  }
}

function closeSettings() {
  document.getElementById("modal").classList.add("hidden");
}

async function saveSettings() {
  const input = document.getElementById("poll-minutes");
  const msg = document.getElementById("modal-msg");
  const btn = document.getElementById("modal-save");

  const v = parseFloat(input.value);
  if (!(v > 0)) {
    msg.textContent = "0より大きい数値を入れてください";
    msg.className = "modal-msg error";
    return;
  }

  btn.disabled = true;
  btn.textContent = "保存中...";
  msg.textContent = "";
  msg.className = "modal-msg";

  try {
    const res = await fetch(`${SERVER}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollMinutes: v }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    msg.textContent = `保存しました (${data.pollMinutes} 分間隔)`;
    msg.className = "modal-msg ok";
    setTimeout(closeSettings, 800);
  } catch (e) {
    msg.textContent = `保存に失敗: ${e.message}`;
    msg.className = "modal-msg error";
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
}

async function switchAccountUI(name, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "切替中...";
  try {
    const res = await fetch(`${SERVER}/active`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    // 成功したら再描画
    await load();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    btn.title = `切替失敗: ${e.message}`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  document.getElementById("btn-refresh").addEventListener("click", () => load(true));
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("modal-close").addEventListener("click", closeSettings);
  document.getElementById("modal-cancel").addEventListener("click", closeSettings);
  document.getElementById("modal-save").addEventListener("click", saveSettings);
  document.querySelector("#modal .modal-backdrop")
    .addEventListener("click", closeSettings);

  // カード内の切替ボタン (event delegation)
  document.getElementById("accounts").addEventListener("click", (e) => {
    const btn = e.target.closest(".switch-btn");
    if (!btn) return;
    switchAccountUI(btn.dataset.account, btn);
  });
});
