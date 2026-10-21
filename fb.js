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
    s.onerror = () => { s.remove(); reject(new Error('load fail')); };  // 拿掉失敗的標籤，下次重試才會重新下載
    document.head.appendChild(s);
  });
}

let dbPromise = null;
let failedAt = -Infinity;
const RETRY_MS = 10000;  // 載入失敗後，至少隔這麼久才再試（不要一直狂下載）

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

// 玩家在背景匿名登入，拿到一個這個瀏覽器專屬的身分（看不到任何畫面）。
// 資料庫規則靠這個身分判斷「只能寫自己的東西」；匿名登入沒開或連不上時就照舊，不影響遊戲。
async function signIn(app) {
  try {
    const auth = window.firebase.auth(app);
    // 先等之前登入過的身分恢復（記在這個瀏覽器裡），沒有才建立新的
    await withTimeout(new Promise((ok) => { const off = auth.onAuthStateChanged(() => { off(); ok(); }); }), 4000);
    if (!auth.currentUser) await withTimeout(auth.signInAnonymously(), 8000);
  } catch { /* 忽略 */ }
}

// 回傳 Realtime Database 實例（成功後只會初始化一次）；連不上或沒設定就回傳 null。
// 第一次載入失敗（例如剛打開時網路不穩）不會被記住：之後再呼叫會重新載入，網路恢復就能用。
export function getDb() {
  if (!CFG || !CFG.databaseURL) return Promise.resolve(null);
  if (!dbPromise && Date.now() - failedAt < RETRY_MS) return Promise.resolve(null);
  if (!dbPromise) {
    const p = (async () => {
      try {
        // 分開檢查每個 SDK：上次可能只載入了一半
        if (!window.firebase?.initializeApp) await loadScript(`https://www.gstatic.com/firebasejs/${VER}/firebase-app-compat.js`);
        if (!window.firebase.database) await loadScript(`https://www.gstatic.com/firebasejs/${VER}/firebase-database-compat.js`);
        if (!window.firebase.auth && window.firebase.SDK_VERSION) {
          try { await loadScript(`https://www.gstatic.com/firebasejs/${VER}/firebase-auth-compat.js`); } catch { /* 沒有登入功能也能用 */ }
        }
        const app = window.firebase.apps?.length ? window.firebase.app() : window.firebase.initializeApp(CFG);
        if (window.firebase.auth) await signIn(app);
        return window.firebase.database(app);
      } catch {
        return null;
      }
    })();
    dbPromise = p;
    p.then((db) => { if (!db && dbPromise === p) { dbPromise = null; failedAt = Date.now(); } });
  }
  return dbPromise;
}

// 這個瀏覽器的登入身分（匿名）；沒有登入時回傳 null
export async function getUid() {
  await getDb();
  try { return window.firebase?.auth?.().currentUser?.uid || null; } catch { return null; }
}
