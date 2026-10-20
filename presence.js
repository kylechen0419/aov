// 線上人數：用 Firebase Realtime Database 統計現在有多少人打開這個網站。
// 只是一個「現在有幾個人在線上」的總數，不會記下是誰、也看不到任何人的畫面。
// 沒有在 firebase-config.js 填設定的話，整個功能會安靜地關閉，不影響遊戲其他部分。
const CFG = (typeof window !== 'undefined' && window.WIKIRACE_FIREBASE) || null;
const VER = '10.12.2';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('load fail'));
    document.head.appendChild(s);
  });
}

let started = false;

// onCount(n) 會在人數變動時被呼叫；沒設定或連不上就不會呼叫，首頁那塊就維持隱藏
export async function initPresence(onCount) {
  if (!CFG || !CFG.databaseURL || started) return;
  started = true;
  try {
    if (!window.firebase) {
      await loadScript(`https://www.gstatic.com/firebasejs/${VER}/firebase-app-compat.js`);
      await loadScript(`https://www.gstatic.com/firebasejs/${VER}/firebase-database-compat.js`);
    }
    const app = firebase.initializeApp(CFG);
    const db = firebase.database(app);
    const online = db.ref('online');
    // 自己的存在：給一個隨機節點，斷線時 Firebase 會自動幫忙移除
    const me = online.push();
    db.ref('.info/connected').on('value', (snap) => {
      if (snap.val() === true) {
        me.onDisconnect().remove();
        me.set(Date.now());
      }
    });
    // 人數有變動就更新畫面
    online.on('value', (snap) => { onCount(snap.numChildren()); });
    // 主動離開頁面時也移除一次（手機切到背景不算離開）
    window.addEventListener('pagehide', (e) => { if (!e.persisted) { try { me.remove(); } catch { /* 忽略 */ } } });
  } catch { /* 連不上就安靜放棄，不影響遊戲 */ }
}
