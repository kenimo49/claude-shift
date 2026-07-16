import { formatCountdown, formatResetClock, formatRelativeAgo, renderBar } from "./helpers.js";

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

function renderAccount(row, activeName, syncBroken) {
  const isActive = row.account === activeName;
  const accountAttr = escapeAttr(row.account);
  const accountText = escapeHtml(row.account);
  const marker = isActive
    ? '<span class="active-badge">使用中</span>'
    : `<button class="switch-btn" data-account="${accountAttr}">切替</button>`;

  const statusBadges = [];
  if (syncBroken) {
    // issue #5: claude CLI と shift の active identity が特定できない
    statusBadges.push('<span class="status-badge sync-broken" title="claude CLI と shift のアクティブが特定できません">同期切れ</span>');
  }
  if (row.needs_reauth) {
    statusBadges.push('<span class="status-badge reauth" title="refresh 失敗。/login で再ログインが必要">再ログイン必要</span>');
  } else if (row.last_error) {
    statusBadges.push(`<span class="status-badge error" title="${escapeAttr(row.last_error)}">取得失敗</span>`);
  } else if (row.stale) {
    statusBadges.push('<span class="status-badge stale" title="ポーリング間隔の 2 倍以上更新されていません">stale</span>');
  }

  const ageText = row.captured_at
    ? `<span class="account-age">取得: ${formatRelativeAgo(row.captured_at)}</span>`
    : '<span class="account-age never">未取得</span>';

  const classes = [
    "account-card",
    isActive ? "is-active" : "",
    syncBroken ? "sync-broken" : "",
    row.needs_reauth ? "needs-reauth" : "",
    row.last_error && !row.needs_reauth ? "has-error" : "",
    row.stale && !row.last_error && !row.needs_reauth ? "is-stale" : "",
  ].filter(Boolean).join(" ");

  return `
    <div class="${classes}">
      <div class="account-header">
        <div class="account-name">${accountText}</div>
        ${marker}
      </div>
      <div class="account-meta">
        ${ageText}
        ${statusBadges.join("")}
      </div>
      ${renderLimit("5時間枠", row.five_hour_pct, row.five_hour_reset_at)}
      ${renderLimit("週次", row.weekly_pct, row.weekly_reset_at)}
    </div>`;
}

// HTML 属性値用のエスケープ (title=".." data-account=".." 等)
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
// テキストノード用の HTML エスケープ (エンコード対象は同じだが用途を明示)
const escapeHtml = escapeAttr;

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
    const { accounts, active, fetched_at, attempted_at, any_needs_reauth, sync_broken } = await res.json();

    if (!accounts || accounts.length === 0) {
      container.innerHTML = "<p class='empty'>アカウントが見つかりません。<br>~/.claude-shift/accounts/ にcredentialsを追加してください。</p>";
      return;
    }

    container.innerHTML = accounts.map((a) => renderAccount(a, active, !!sync_broken)).join("");

    const ts = document.getElementById("timestamp");
    // 「最終取得」= 全アカウント成功した時刻。部分失敗中は attempted_at を別表記で出す。
    const fmt = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    if (fetched_at && (!attempted_at || attempted_at === fetched_at)) {
      ts.textContent = `最終取得: ${fmt(fetched_at)}`;
      ts.title = "";
      ts.classList.remove("has-error");
    } else if (fetched_at && attempted_at) {
      ts.textContent = `試行: ${fmt(attempted_at)} / 成功: ${fmt(fetched_at)}`;
      ts.title = "直近の refresh は一部アカウントで失敗しています";
      ts.classList.add("has-error");
    } else if (attempted_at) {
      ts.textContent = `試行: ${fmt(attempted_at)} (未成功)`;
      ts.title = "全アカウントで取得に失敗しています";
      ts.classList.add("has-error");
    } else {
      ts.textContent = "";
      ts.classList.remove("has-error");
    }

    // ヘッダ下の banner に警告メッセージを組み立てる。
    // - sync_broken (issue #5): claude CLI と shift のアクティブ identity 不一致
    // - any_needs_reauth: refresh 失敗で再ログインが必要な account が 1 件以上
    // 両方立つ可能性がある (完全に別問題) ので、独立して積む。
    const banner = document.getElementById("global-banner");
    if (banner) {
      const messages = [];
      if (sync_broken) {
        messages.push("claude CLI と shift のアクティブが特定できません (shift add で再登録)");
      }
      if (any_needs_reauth) {
        messages.push("再ログインが必要なアカウントがあります (claude /login → shift add)");
      }
      if (messages.length > 0) {
        banner.innerHTML = messages.map((m) => `<div>${escapeHtml(m)}</div>`).join("");
        banner.classList.remove("hidden");
      } else {
        banner.classList.add("hidden");
        banner.innerHTML = "";
      }
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
        <span class="legend-name">${escapeHtml(account)}</span>
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
