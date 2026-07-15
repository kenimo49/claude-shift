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

function renderAccount(row) {
  return `
    <div class="account-card">
      <div class="account-name">${row.account}</div>
      ${renderLimit("5時間枠", row.five_hour_pct, row.five_hour_reset_at)}
      ${renderLimit("週次", row.weekly_pct, row.weekly_reset_at)}
    </div>`;
}

async function load(live = false) {
  const container = document.getElementById("accounts");
  container.innerHTML = "<p class='loading'>取得中...</p>";

  try {
    const endpoint = live ? `${SERVER}/usage/live` : `${SERVER}/usage`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { accounts, fetched_at } = await res.json();

    if (!accounts || accounts.length === 0) {
      container.innerHTML = "<p class='empty'>アカウントが見つかりません。<br>~/.claude-shift/accounts/ にcredentialsを追加してください。</p>";
      return;
    }

    container.innerHTML = accounts.map(renderAccount).join("");

    const ts = document.getElementById("timestamp");
    if (fetched_at) {
      const d = new Date(fetched_at);
      ts.textContent = `最終取得: ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    }
  } catch (e) {
    container.innerHTML = `<p class='error'>サーバーに接続できません。<br><code>shift server</code> を起動してください。<br><small>${e.message}</small></p>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  document.getElementById("btn-refresh").addEventListener("click", () => load(true));
});
