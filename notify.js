// 製作者的手機通知：有人開房間、開始比賽、單人訓練時，透過 ntfy（免費的推播 App）通知製作者的手機。
// 頻道名稱和要通知哪些事件，由後台存在 Firebase 的 config/notify；沒設定就什麼都不送。
// 通知內容刻意不放暱稱和房間代碼：ntfy 的頻道知道名字就看得到，詳細資料請到後台看。
import { getDb } from './fb.js?v=68';

export const NTFY = 'https://ntfy.sh';
const TAGS = { room: 'video_game', start: 'checkered_flag', solo: 'dart', test: 'bell' };
const COOLDOWN = 60000;  // 同一支手機、同一種通知，一分鐘最多一則，避免洗版

let cfg = null;
let ready = null;
const last = {};

function load() {
  ready ||= (async () => {
    const db = await getDb();
    if (!db) return;
    await new Promise((done) => {
      setTimeout(done, 4000);  // 連不上就算了，不要卡住
      try {
        db.ref('config/notify').on('value', (snap) => { cfg = snap.val(); done(); }, () => done());
      } catch { done(); }
    });
  })();
  return ready;
}

// 直接送一則到 ntfy 頻道（後台的「測試通知」也用這個）
export function sendNtfy(topic, kind, title, message) {
  const q = new URLSearchParams({ title, tags: TAGS[kind] || 'bell', click: new URL('admin.html', location.href).href });
  // no-cors＋純文字內容：瀏覽器不用先問伺服器，送出去就好，不需要讀回應
  return fetch(`${NTFY}/${encodeURIComponent(topic)}?${q}`, { method: 'POST', body: message, mode: 'no-cors', keepalive: true }).catch(() => {});
}

export function initNotify() { load(); }

// 遊戲裡發生某件事時呼叫；製作者有開這種通知才會送出
export async function notify(kind, title, message) {
  await load();
  if (!cfg || !cfg.topic || !cfg[kind]) return;
  try { if (localStorage.getItem('wikirace-notify-self') === '1') return; } catch { /* 忽略 */ }
  const now = Date.now();
  if (last[kind] && now - last[kind] < COOLDOWN) return;
  last[kind] = now;
  sendNtfy(cfg.topic, kind, title, message);
}
