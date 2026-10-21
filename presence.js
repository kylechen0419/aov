// 線上人數：統計現在有多少人打開這個網站（只是一個總數，不會記下是誰、也看不到任何人的畫面）。
// 沒有在 firebase-config.js 填設定的話，整個功能會安靜地關閉，不影響遊戲其他部分。
import { getDb, getUid } from './fb.js?v=72';
import { bumpPeak } from './rooms.js?v=72';

let started = false;
let retries = 0;

// onCount(n) 會在人數變動時被呼叫；沒設定或連不上就不會呼叫，首頁那塊就維持隱藏
export async function initPresence(onCount) {
  if (started) return;
  started = true;
  const db = await getDb();
  if (!db) {
    // 一開始連不上（例如網路不穩）：過一下再試，網路恢復後人數就會出現
    started = false;
    if (window.WIKIRACE_FIREBASE && retries++ < 20) setTimeout(() => initPresence(onCount), 15000);
    return;
  }
  const uid = (await getUid()) || '';
  try {
    const online = db.ref('online');
    // 自己的存在：給一個隨機節點，斷線時 Firebase 會自動幫忙移除
    const me = online.push();
    db.ref('.info/connected').on('value', (snap) => {
      if (snap.val() === true) {
        me.onDisconnect().remove();
        me.set({ u: uid, t: Date.now() });  // u：是誰的（資料庫規則只准本人刪改）
      }
    });
    online.on('value', (snap) => { const n = snap.numChildren(); onCount(n); bumpPeak(n); });
    window.addEventListener('pagehide', (e) => { if (!e.persisted) { try { me.remove(); } catch { /* 忽略 */ } } });
  } catch { /* 連不上就安靜放棄 */ }
}
