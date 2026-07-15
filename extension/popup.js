const SERVER = "http://127.0.0.1:19867";

function formatCountdown(ms) {
  if (!ms) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return "リセット済み";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}日 ${h % 24}時間後`;
  if (h > 0) return `${h}時間 ${m}分後`;
  return `${m}分後`;
}

function formatResetClock(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? `${hh}:${mm}`
    : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function renderBar(pct) {
  if (pct == null) return "";
  const c = Math.min(100, Math.max(0, Math.round(pct)));
  const cls = c >= 85 ? "danger" : c >= 55 ? "warning" : "";
  return `
    <div class="bar-wrap">
      <div class="bar-fill ${cls}" style="width:${c}%"></div>
    </div>
    <div class="bar-label">${c}% 使用中</div>`;
}

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
