import { formatCountdown, formatResetClock, renderBar } from "./helpers.js";

const SERVER = "http://127.0.0.1:19867";

function renderAccount(row) {
  const fhReset = row.five_hour_reset_at;
  const wkReset = row.weekly_reset_at;

  return `
    <div class="account-card">
      <div class="account-name">${row.account}</div>
      <div class="limit-row">
        <span class="limit-label">5時間枠</span>
        ${renderBar(row.five_hour_pct)}
        <div class="reset-time">${formatCountdown(fhReset) ?? "不明"} (${formatResetClock(fhReset) ?? "?"})</div>
      </div>
      <div class="limit-row">
        <span class="limit-label">週次</span>
        ${renderBar(row.weekly_pct)}
        <div class="reset-time">${formatCountdown(wkReset) ?? "不明"}</div>
      </div>
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
