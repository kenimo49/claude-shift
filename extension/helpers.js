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
