// 線上人數：統計現在有多少人打開這個網站（只是一個總數，不會記下是誰、也看不到任何人的畫面）。
// 沒有在 firebase-config.js 填設定的話，整個功能會安靜地關閉，不影響遊戲其他部分。
import { getDb } from './fb.js?v=57';

let started = false;

// onCount(n) 會在人數變動時被呼叫；沒設定或連不上就不會呼叫，首頁那塊就維持隱藏
export async function initPresence(onCount) {
  if (started) return;
  started = true;
  const db = await getDb();
  if (!db) return;
  try {
    const online = db.ref('online');
    // 自己的存在：給一個隨機節點，斷線時 Firebase 會自動幫忙移除
    const me = online.push();
    db.ref('.info/connected').on('value', (snap) => {
      if (snap.val() === true) {
        me.onDisconnect().remove();
        me.set(Date.now());
      }
    });
    online.on('value', (snap) => { onCount(snap.numChildren()); });
    window.addEventListener('pagehide', (e) => { if (!e.persisted) { try { me.remove(); } catch { /* 忽略 */ } } });
  } catch { /* 連不上就安靜放棄 */ }
}
