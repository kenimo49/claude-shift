// e2e fixture: 隔離 HOME の SQLite に usage snapshot を seed する。
// HOME (または CLAUDE_SHIFT_DATA_DIR) を差し替えた subprocess として実行することで、
// server 本体と同じコードパス (cli/db.js) でデータを作る。
import { saveSnapshots } from "../../cli/db.js";

const now = Date.now();
const in3h = new Date(now + 3 * 3600 * 1000).toISOString();
const in5d = new Date(now + 5 * 86400 * 1000).toISOString();

saveSnapshots([
  {
    name: "alpha",
    five_hour: { utilization: 42, resets_at: in3h },
    seven_day: { utilization: 63, resets_at: in5d },
  },
  {
    name: "bravo",
    five_hour: { utilization: 7, resets_at: in3h },
    seven_day: { utilization: 18, resets_at: in5d },
  },
]);

console.log("seeded");
