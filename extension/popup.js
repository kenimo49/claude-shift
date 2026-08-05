import { formatCountdown, formatResetClock, formatRelativeAgo, renderBar } from "./helpers.js";

// http(s) 配信 (shift server 経由の Local Web UI) のときだけ same-origin の相対 URL にして
// CLAUDE_SHIFT_PORT の変更にも追随させる。それ以外 (chrome-extension: の拡張 popup、
// file:// での直接デバッグ) は従来どおり既定ポートの絶対 URL。
const SERVER = (typeof location !== "undefined" && /^https?:$/.test(location.protocol))
  ? ""
  : "http://127.0.0.1:19867";

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

function renderAccount(row, loginActiveName, tokenActiveName, syncBroken, activeHighlight = "effective") {
  const isSplit = !!(tokenActiveName && loginActiveName && tokenActiveName !== loginActiveName);

  // activeHighlight に従って強調対象を決定
  let isActive = false;
  let isLoginSecondary = false; // split+effective 時の login: 左ボーダーのみ
  switch (activeHighlight) {
    case "login":
      isActive = row.account === loginActiveName;
      break;
    case "both":
      isActive = row.account === loginActiveName || row.account === tokenActiveName;
      break;
    default: // "effective": token pin 優先
      isActive = row.account === (tokenActiveName ?? loginActiveName);
      isLoginSecondary = isSplit && row.account === loginActiveName;
  }
  const accountAttr = escapeAttr(row.account);
  const accountText = escapeHtml(row.account);

  // login切替: login credentials があり、かつ現在 login active でない場合に表示
  // token切替: setup token があり、かつ現在 token pin でない場合に表示
  const switchBtns = [];
  if (row.hasLogin && row.activeAs !== "login") {
    switchBtns.push(`<button class="switch-btn switch-btn-login" data-account="${accountAttr}" data-mode="login">login切替</button>`);
  }
  if (row.hasToken && row.activeAs !== "token") {
    switchBtns.push(`<button class="switch-btn switch-btn-token" data-account="${accountAttr}" data-mode="token">token切替</button>`);
  }
  const marker = switchBtns.length > 0
    ? `<div class="switch-btns">${switchBtns.join("")}</div>`
    : "";

  const statusBadges = [];
  // issue #23: 実効 active の内訳 (login credentials.json / token pin env.sh) を明示する。
  // 通常運用時は片方だけ、split 運用時は 2 アカウントに別々に付いてバナーで補足される。
  if (row.activeAs === "login") {
    statusBadges.push('<span class="status-badge active-as active-as-login" title="~/.claude/.credentials.json のログインアカウント">login</span>');
  } else if (row.activeAs === "token") {
    statusBadges.push('<span class="status-badge active-as active-as-token" title="~/.claude-shift/env.sh の CLAUDE_CODE_OAUTH_TOKEN が指すアカウント (claude 実行時に優先)">token pin</span>');
  }
  if (syncBroken) {
    // issue #5: claude CLI と shift の active identity が特定できない
    statusBadges.push('<span class="status-badge sync-broken" title="claude CLI と shift のアクティブが特定できません">同期切れ</span>');
  }
  if (row.excluded) {
    // pollExclude: このマシンでは観測しない (server 側で stale / エラーは抑制済み)
    statusBadges.push('<span class="status-badge excluded" title="このマシンでは usage を取得しません。login を所有する別マシン側で観測します (⚙ 設定で変更)">観測対象外</span>');
  } else if (row.needs_reauth) {
    statusBadges.push('<span class="status-badge reauth" title="refresh 失敗。/login で再ログインが必要">再ログイン必要</span>');
  } else if (row.error_kind === "rate_limited") {
    // issue #6: 429 で token 健全なケース。refresh してもすぐには回復しないので badge で明示。
    statusBadges.push(`<span class="status-badge rate-limited" title="${escapeAttr(row.last_error ?? "rate limited")}">レート制限中</span>`);
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
    // login 強調時は青色に上書き (デフォルト is-active は紫 = token pin)
    isActive && row.account === loginActiveName ? "is-active-login" : "",
    isLoginSecondary ? "is-login-secondary" : "",
    syncBroken ? "sync-broken" : "",
    row.excluded ? "is-excluded" : "",
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
    const { accounts, active, fetched_at, attempted_at, any_needs_reauth, sync_broken, active_highlight } = await res.json();

    if (!accounts || accounts.length === 0) {
      container.innerHTML = "<p class='empty'>アカウントが見つかりません。<br>~/.claude-shift/accounts/ にcredentialsを追加してください。</p>";
      return;
    }

    const tokenAccount = accounts.find((a) => a.activeAs === "token")?.account ?? null;
    container.innerHTML = accounts.map((a) => renderAccount(a, active, tokenAccount, !!sync_broken, active_highlight)).join("");

    const ts = document.getElementById("timestamp");
    // 「最終取得」= 全アカウント成功した時刻 (server.js の lastFetched)。
    // needs_reauth は「取得失敗」から除外されているので、他 account の取得さえ成功していれば
    // fetched_at は更新される。真の transient failure が起きている時だけ「試行 / 成功」分岐が出る。
    // needs_reauth 自体はカード側 badge + any_needs_reauth banner で通知する (issue #7)。
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
    // - split (issue #23): login=X と token pin=Y が別アカウント。claude 実行時は
    //   env.sh の CLAUDE_CODE_OAUTH_TOKEN が credentials.json より優先されるので
    //   実質 Y (token pin) が使われる — 誤解を防ぐため明示する。
    // 独立事象なので複数同時に立つ可能性あり。
    const banner = document.getElementById("global-banner");
    if (banner) {
      const messages = [];
      const loginAccount = accounts.find((a) => a.activeAs === "login")?.account ?? null;
      const tokenAccount = accounts.find((a) => a.activeAs === "token")?.account ?? null;
      const splitBlock = loginAccount && tokenAccount && loginAccount !== tokenAccount
        ? `<div class="split-warning">login=${escapeHtml(loginAccount)} / token pin=${escapeHtml(tokenAccount)} の split 運用中。<code>claude</code> 実行時は ${escapeHtml(tokenAccount)} (token pin) が優先されます</div>`
        : null;
      if (splitBlock) messages.push(splitBlock);
      if (sync_broken) {
        messages.push(`<div>${escapeHtml("claude CLI と shift のアクティブが特定できません (shift add で再登録)")}</div>`);
      }
      if (any_needs_reauth) {
        messages.push(`<div>${escapeHtml("再ログインが必要なアカウントがあります (claude /login → shift add)")}</div>`);
      }
      if (messages.length > 0) {
        banner.innerHTML = messages.join("");
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
  const observeList = document.getElementById("observe-list");
  const msg = document.getElementById("modal-msg");
  msg.textContent = "";
  msg.className = "modal-msg";

  input.value = "";
  input.placeholder = "取得中...";
  observeList.innerHTML = "<span class='field-hint'>取得中...</span>";
  modal.classList.remove("hidden");
  input.focus();

  try {
    const [cfgRes, usageRes] = await Promise.all([
      fetch(`${SERVER}/config`),
      fetch(`${SERVER}/usage`),
    ]);
    if (!cfgRes.ok) throw new Error(`HTTP ${cfgRes.status}`);
    if (!usageRes.ok) throw new Error(`HTTP ${usageRes.status}`);
    const cfg = await cfgRes.json();
    const usage = await usageRes.json();
    input.value = cfg.pollMinutes;
    input.placeholder = "";

    const hlVal = cfg.activeHighlight ?? "effective";
    document.querySelectorAll("#active-highlight-group .seg-btn").forEach((b) => {
      b.classList.toggle("is-on", b.dataset.value === hlVal);
    });

    const excluded = new Set(cfg.pollExclude ?? []);
    const names = (usage.accounts ?? []).map((a) => a.account).sort();
    if (names.length === 0) {
      observeList.innerHTML = "<span class='field-hint'>アカウントがありません</span>";
    } else {
      // checked = 観測する (= pollExclude に入っていない)
      observeList.innerHTML = names.map((name) => `
        <label class="observe-item">
          <input type="checkbox" data-observe-account="${escapeAttr(name)}"
                 ${excluded.has(name) ? "" : "checked"} />
          <span class="account-name">${escapeHtml(name)}</span>
        </label>`).join("");
    }
  } catch (e) {
    observeList.innerHTML = "";
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

  // チェック無し = 観測しない = pollExclude 入り
  const pollExclude = [...document.querySelectorAll("[data-observe-account]")]
    .filter((cb) => !cb.checked)
    .map((cb) => cb.dataset.observeAccount);
  const activeHighlight = document.querySelector("#active-highlight-group .seg-btn.is-on")?.dataset.value ?? "effective";

  try {
    const res = await fetch(`${SERVER}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollMinutes: v, pollExclude, activeHighlight }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const excludeNote = (data.pollExclude ?? []).length
      ? `、観測対象外: ${data.pollExclude.join(", ")}`
      : "";
    msg.textContent = `保存しました (${data.pollMinutes} 分間隔${excludeNote})`;
    msg.className = "modal-msg ok";
    // 観測対象の変更をカード表示 (観測対象外 badge) に反映
    load();
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
      if (which === "metric" || which === "range") refreshChart();
    });
  });
}

async function switchTokenUI(name, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "切替中...";
  try {
    const res = await fetch(`${SERVER}/active-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    await load();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    btn.title = `切替失敗: ${e.message}`;
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

// ---- アカウント名マスキング (共有時用) ----
//
// スクリーンショットや画面共有でアカウント名を隠したいとき、ヘッダ 👁 ボタンで on/off。
// CSS side で filter: blur を掛けるので DOM は元の名前を保持したまま (表示上だけマスク)。
// 状態は chrome.storage.local に保存し popup 再オープン時も維持。
// chrome.storage が使えない環境 (テスト等) は localStorage フォールバック。
const MASK_STORAGE_KEY = "cs_account_name_masked";

function readMaskState() {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get([MASK_STORAGE_KEY], (v) => {
        resolve(!!v[MASK_STORAGE_KEY]);
      });
    } else {
      try { resolve(localStorage.getItem(MASK_STORAGE_KEY) === "1"); }
      catch { resolve(false); }
    }
  });
}

function writeMaskState(on) {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    chrome.storage.local.set({ [MASK_STORAGE_KEY]: !!on });
  } else {
    try { localStorage.setItem(MASK_STORAGE_KEY, on ? "1" : "0"); } catch {}
  }
}

function applyMaskUI(on) {
  document.body.classList.toggle("is-masked", !!on);
  const btn = document.getElementById("btn-mask");
  if (btn) {
    btn.textContent = on ? "🙈" : "👁";
    btn.title = on
      ? "マスキング中: クリックで解除"
      : "アカウント名をマスキング (共有時用)";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

async function initMask() {
  const on = await readMaskState();
  applyMaskUI(on);
}

async function toggleMask() {
  const now = document.body.classList.contains("is-masked");
  const next = !now;
  applyMaskUI(next);
  writeMaskState(next);
}

document.addEventListener("DOMContentLoaded", () => {
  initMask();
  load();
  document.getElementById("btn-refresh").addEventListener("click", () => load(true));
  document.getElementById("btn-mask").addEventListener("click", toggleMask);
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
    if (btn.dataset.mode === "token") {
      switchTokenUI(btn.dataset.account, btn);
    } else {
      switchAccountUI(btn.dataset.account, btn);
    }
  });
});
