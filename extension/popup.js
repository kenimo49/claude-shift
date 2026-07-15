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

// ---- 分析モーダル ----

const CHART_COLORS = ["#93c5fd", "#f59e0b", "#6ee7b7", "#f472b6", "#a78bfa", "#fb7185"];
let chartState = { metric: "five_hour_pct", hours: 24 };

function fmtHM(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtMD(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function drawChart(history, metric, hours) {
  const container = document.getElementById("chart-container");
  const legend = document.getElementById("chart-legend");
  const msg = document.getElementById("chart-msg");
  msg.textContent = "";

  const accounts = Object.keys(history).sort();
  const allRows = accounts.flatMap((a) => history[a] ?? []);
  if (allRows.length === 0) {
    container.innerHTML = "";
    legend.innerHTML = "";
    msg.textContent = "履歴データがまだありません";
    msg.className = "modal-msg";
    return;
  }

  // X: 表示範囲は「現在時刻から hours 遡り」で固定
  const now = Date.now();
  const xMin = now - hours * 3600 * 1000;
  const xMax = now;

  // SVG viewBox
  const W = 300, H = 160;
  const padL = 26, padR = 8, padT = 8, padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xScale = (t) => padL + ((t - xMin) / (xMax - xMin)) * plotW;
  const yScale = (p) => padT + (1 - Math.min(100, Math.max(0, p)) / 100) * plotH;

  // Y軸グリッド (0/25/50/75/100)
  const grids = [0, 25, 50, 75, 100].map((v) => {
    const y = yScale(v).toFixed(1);
    return `
      <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="grid"/>
      <text x="${padL - 4}" y="${+y + 3}" class="tick" text-anchor="end">${v}</text>`;
  }).join("");

  // X軸ラベル (両端 + 中央)
  const xTicks = [xMin, xMin + (xMax - xMin) / 2, xMax];
  const useDate = hours > 24;
  const xLabels = xTicks.map((t) => {
    const x = xScale(t).toFixed(1);
    const label = useDate ? fmtMD(t) : fmtHM(t);
    return `<text x="${x}" y="${H - 4}" class="tick" text-anchor="middle">${label}</text>`;
  }).join("");

  // 各アカウントの polyline
  const lines = accounts.map((account, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const rows = (history[account] ?? []).filter((r) => r.captured_at >= xMin && r[metric] != null);
    if (rows.length < 1) return "";
    const points = rows
      .map((r) => `${xScale(r.captured_at).toFixed(1)},${yScale(r[metric]).toFixed(1)}`)
      .join(" ");
    if (rows.length === 1) {
      // 単点は小さな○
      const [x, y] = points.split(",");
      return `<circle cx="${x}" cy="${y}" r="2" fill="${color}"/>`;
    }
    return `<polyline points="${points}" stroke="${color}" fill="none" stroke-width="1.6" stroke-linejoin="round"/>`;
  }).join("");

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${grids}
      ${xLabels}
      ${lines}
    </svg>`;

  legend.innerHTML = accounts.map((account, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const rows = history[account] ?? [];
    const latest = rows.length ? rows[rows.length - 1][metric] : null;
    return `
      <span class="legend-item">
        <span class="legend-swatch" style="background:${color}"></span>
        <span class="legend-name">${account}</span>
        <span class="legend-value">${latest != null ? `${Math.round(latest)}%` : "-"}</span>
      </span>`;
  }).join("");
}

async function refreshChart() {
  const msg = document.getElementById("chart-msg");
  try {
    const res = await fetch(`${SERVER}/history/all?hours=${chartState.hours}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const history = await res.json();
    drawChart(history, chartState.metric, chartState.hours);
  } catch (e) {
    msg.textContent = `履歴取得に失敗: ${e.message}`;
    msg.className = "modal-msg error";
  }
}

function openAnalytics() {
  document.getElementById("analytics-modal").classList.remove("hidden");
  refreshChart();
}

function closeAnalytics() {
  document.getElementById("analytics-modal").classList.add("hidden");
}

function bindSegButtons() {
  document.querySelectorAll(".seg-btn-group").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      const value = btn.dataset.value;
      const which = group.dataset.group;
      group.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("is-on", b === btn));
      if (which === "metric") chartState.metric = value;
      if (which === "range") chartState.hours = parseInt(value, 10);
      refreshChart();
    });
  });
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
  document.getElementById("btn-analytics").addEventListener("click", openAnalytics);
  document.getElementById("modal-close").addEventListener("click", closeSettings);
  document.getElementById("modal-cancel").addEventListener("click", closeSettings);
  document.getElementById("modal-save").addEventListener("click", saveSettings);
  document.querySelector("#modal .modal-backdrop")
    .addEventListener("click", closeSettings);
  // 分析モーダルの閉じるボタン
  document.querySelectorAll('[data-close="analytics"]').forEach((el) => {
    el.addEventListener("click", closeAnalytics);
  });
  bindSegButtons();

  // カード内の切替ボタン (event delegation)
  document.getElementById("accounts").addEventListener("click", (e) => {
    const btn = e.target.closest(".switch-btn");
    if (!btn) return;
    switchAccountUI(btn.dataset.account, btn);
  });
});
