// popup.js から切り出した純粋関数 — Node でそのままテスト可能

export function formatCountdown(ms, now = Date.now()) {
  if (!ms) return null;
  const diff = ms - now;
  if (diff <= 0) return "リセット済み";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}日 ${h % 24}時間後`;
  if (h > 0) return `${h}時間 ${m}分後`;
  return `${m}分後`;
}

// captured_at からの相対経過を「N 秒前 / N 分前 / N 時間前」に整形する。
// UI では fetched_at の代わりに snapshot の age をユーザに示すために使う。
export function formatRelativeAgo(ms, now = Date.now()) {
  if (!ms) return "未取得";
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  return `${d}日前`;
}

export function formatResetClock(ms) {
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

export function renderBar(pct) {
  if (pct == null) return "";
  const c = Math.min(100, Math.max(0, Math.round(pct)));
  const cls = c >= 85 ? "danger" : c >= 55 ? "warning" : "";
  return `
    <div class="bar-wrap">
      <div class="bar-fill ${cls}" style="width:${c}%"></div>
    </div>
    <div class="bar-label">${c}% 使用中</div>`;
}

// 0-100 の数列を折れ線 SVG (0..W x 0..H, y 反転) にする。2 点未満なら空文字。
export function renderSparkline(pcts, width = 100, height = 18) {
  if (!Array.isArray(pcts)) return "";
  const filtered = pcts.filter((p) => typeof p === "number");
  if (filtered.length < 2) return "";
  const n = filtered.length;
  const pts = filtered
    .map((p, i) => {
      const x = (i / (n - 1)) * width;
      const clamped = Math.min(100, Math.max(0, p));
      const y = height - (clamped / 100) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `
    <svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <polyline points="${pts}"/>
    </svg>`;
}
