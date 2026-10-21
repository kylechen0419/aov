// 每晚的今日摘要：GitHub Actions 每天晚上 10 點左右（台灣時間）跑一次，
// 讀 Firebase 上公開的數字（今天幾局、幾人次、每日挑戰幾人完成、現在在線、尖峰、錯誤數），
// 推播到後台設定的 ntfy 頻道。只讀公開資料，不需要任何密碼；後台「手機通知」可以關掉。
// 手動測試：GitHub → Actions → Nightly summary → Run workflow（或本機 node scripts/nightly.mjs）
import fs from 'fs';

const cfgText = fs.readFileSync(new URL('../firebase-config.js', import.meta.url), 'utf8');
const DB = process.env.DB_URL || (cfgText.match(/databaseURL:\s*'([^']+)'/) || [])[1];
if (!DB) { console.log('firebase-config.js 沒有 databaseURL，跳過'); process.exit(0); }

const get = async (path, shallow = false) => {
  const u = new URL(DB);
  u.pathname = `${u.pathname.replace(/\/$/, '')}/${path}.json`;
  if (shallow) u.searchParams.set('shallow', 'true');
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
};
const count = (v) => (v && typeof v === 'object' ? Object.keys(v).length : 0);
// 台灣日期；晚一點才跑（GitHub 排程常常延遲）也算前一天：往回推 3 小時
const twDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const now = Date.now() - 3 * 3600e3;
const today = twDay(now);
const yesterday = twDay(now - 864e5);

const notify = await get('config/notify').catch(() => null);
if (!notify || !notify.topic) { console.log('還沒開啟手機通知，跳過'); process.exit(0); }
if (notify.nightly === false) { console.log('後台關掉了每晚摘要，跳過'); process.exit(0); }

// 今天的每日挑戰被管理員重置過的話，排行榜在 <日期>_r<輪數>
const pz = await get(`stats/dailyPuzzle/d${Math.round(Date.parse(today) / 864e5)}`).catch(() => null);
const round = Math.max(1, Math.floor(Number(pz?.round)) || 1);
const [day, prev, daily, online, peak] = await Promise.all([
  get(`stats/dayCount/${today}`).catch(() => null),
  get(`stats/dayCount/${yesterday}`).catch(() => null),
  get(`stats/daily/${round > 1 ? `${today}_r${round}` : today}`, true).catch(() => null),
  get('online', true).catch(() => null),
  get('stats/peakOnline').catch(() => null),
]);
const n = (v) => Number(v) || 0;
const games = n(day?.games), players = n(day?.players), errors = n(day?.errors);
const diff = (a, b) => (b ? `（昨天 ${b}）` : '');
const lines = [
  `🎮 對局 ${games} 局${diff(games, n(prev?.games))}・玩家 ${players} 人次`,
  `📅 每日挑戰 ${count(daily)} 人完成`,
  `👥 現在在線 ${count(online)} 人・史上尖峰 ${n(peak)} 人`,
];
if (errors) lines.push(`🐞 今天有 ${errors} 筆錯誤紀錄，到後台看看`);
if (!games && !count(daily)) lines.push('今天比較安靜，沒有人玩 😴');

const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'kylechen0419/aov').split('/');
const admin = process.env.ADMIN_URL || `https://${owner}.github.io/${repo}/admin.html`;
const q = new URLSearchParams({ title: `維基競速・今日摘要（${today.slice(5).replace('-', '/')}）`, tags: 'bar_chart', click: admin });
const res = await fetch(`${process.env.NTFY_URL || 'https://ntfy.sh'}/${encodeURIComponent(notify.topic)}?${q}`, { method: 'POST', body: lines.join('\n') });
console.log(res.status, lines.join(' / '));
if (!res.ok) process.exit(1);
