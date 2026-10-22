// 錯誤回報：遊戲出錯時記一筆到 errors/（只有管理員讀得到），後台看得到是哪一版、在哪裡、多少人遇到。
// 同一個錯誤只報一次、一個分頁最多報 10 筆，不會洗版；沒設定 Firebase 就什麼都不做
import { getDb, getUid } from './fb.js?v=101';

const VERSION = Number(new URL(import.meta.url).searchParams.get('v')) || 0;
const sent = new Set();
let count = 0;

export async function reportError(where, err) {
  const msg = String(err?.message || err || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!msg || msg === 'Script error.') return;  // 別的網站的程式（外掛、廣告）出錯，看不到內容
  const k = `${where}|${msg}`;
  if (sent.has(k) || count >= 10) return;
  sent.add(k);
  count++;
  try {
    const db = await getDb();
    const u = db && (await getUid());
    if (!u) return;
    const st = String(err?.stack || '').split('\n').slice(0, 5).map((x) => x.trim()).join(' | ').slice(0, 600);
    import('./rooms.js?v=101').then((m) => m.countToday('errors', 1)).catch(() => {});
    await db.ref('errors').push({ at: Date.now(), v: VERSION, msg, where: String(where).slice(0, 40), ua: navigator.userAgent.slice(0, 200), u, ...(st ? { st } : {}) });
  } catch { /* 回報失敗就算了 */ }
}

// 沒有被接住的錯誤：只回報這個網站自己的程式（瀏覽器外掛、外部套件的錯誤不算）
export function catchErrors() {
  window.addEventListener('error', (e) => {
    if (e.filename && !e.filename.startsWith(location.origin)) return;
    if (e.error || e.message) reportError('window', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason));
}
