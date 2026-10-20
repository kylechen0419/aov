// Firebase 的共用進入點：線上人數和後台都透過這裡連到同一個資料庫。
// 沒有在 firebase-config.js 填設定的話，getDb() 會回傳 null，相關功能就安靜地關閉。
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

let dbPromise = null;

// 回傳 Realtime Database 實例（只會初始化一次）；連不上或沒設定就回傳 null
export function getDb() {
  if (!CFG || !CFG.databaseURL) return Promise.resolve(null);
  dbPromise ||= (async () => {
    try {
      if (!window.firebase) {
        await loadScript(`https://www.gstatic.com/firebasejs/${VER}/firebase-app-compat.js`);
        await loadScript(`https://www.gstatic.com/firebasejs/${VER}/firebase-database-compat.js`);
      }
      const app = window.firebase.apps?.length ? window.firebase.app() : window.firebase.initializeApp(CFG);
      return window.firebase.database(app);
    } catch {
      return null;
    }
  })();
  return dbPromise;
}
