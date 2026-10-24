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
// authState：none＝沒有登入功能、pending＝登入中、ok＝登入了、retry＝這次失敗（網路）待會再試、off＝專案沒開匿名登入
let authState = 'none';
let authDone = Promise.resolve();
const OFF_CODES = ['auth/operation-not-allowed', 'auth/admin-restricted-operation', 'auth/configuration-not-found', 'auth/invalid-api-key'];
function signIn(app) {
  let auth;
  try { auth = window.firebase.auth(app); } catch { authState = 'off'; return authDone; }
  authState = 'pending';
  // 不設時限：手機網路慢的話晚一點登入好也要算數（getDb 只等一下，不會卡住遊戲）
  authDone = (async () => {
    // 先等之前登入過的身分恢復（記在這個瀏覽器裡），沒有才建立新的
    await new Promise((ok) => { const off = auth.onAuthStateChanged(() => { off(); ok(); }); });
    if (!auth.currentUser) await auth.signInAnonymously();
  })().then(() => { authState = 'ok'; }, (e) => { authState = OFF_CODES.includes(e?.code) ? 'off' : 'retry'; });
  return authDone;
}

// 回傳 Realtime Database 實例（成功後只會初始化一次）；連不上或沒設定就回傳 null。
// 第一次載入失敗（例如剛打開時網路不穩）不會被記住：之後再呼叫會重新載入，網路恢復就能用。
export function getDb() {
  touch();
  return dbOnly();
}

// 跟 getDb 一樣，但不算「要用連線」（線上狀態自己的回報用：不要因為回報就一直連著）
function dbOnly() {
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
        if (window.firebase.auth) await withTimeout(signIn(app), 12000).catch(() => {});
        const db = window.firebase.database(app);
        watchConn(db);
        return db;
      } catch {
        return null;
      }
    })();
    dbPromise = p;
    p.then((db) => { if (!db && dbPromise === p) { dbPromise = null; failedAt = Date.now(); } });
  }
  return dbPromise;
}

// 這個瀏覽器的登入身分（匿名）；沒有登入時回傳 null。登入還在跑的話會再多等一下。
export async function getUid() {
  if (!(await dbOnly())) return null;
  const fb = window.firebase;
  try {
    // 登入功能上次沒載入成功、或上次登入因為網路失敗：再試一次
    if (!fb.auth && fb.SDK_VERSION) {
      await loadScript(`https://www.gstatic.com/firebasejs/${VER}/firebase-auth-compat.js`);
      signIn(fb.app());
    } else if (authState === 'retry') signIn(fb.app());
    await withTimeout(authDone, 15000);
  } catch { /* 忽略 */ }
  try { return fb.auth?.().currentUser?.uid || null; } catch { return null; }
}

// 確定這個網站用不了登入（沒有登入功能、或 Firebase 專案沒開匿名登入）：這時才用手機代號當身分
export const authOff = () => !window.firebase?.SDK_VERSION || authState === 'off';

// 登入身分改變時通知（例如網路慢、晚一點才登入好）；沒有登入功能就什麼都不做
export async function onAuth(cb) {
  if (!(await dbOnly())) return;
  try { window.firebase.auth().onAuthStateChanged((u) => cb(u?.uid || null)); } catch { /* 忽略 */ }
}

// ===== 只在需要時才連線 =====
// Firebase 免費方案同時最多 100 個連線，所以平常不一直連著：
// 有東西要讀寫時（getDb）連上，用完 GRACE_MS 後斷開；在多人房間、後台這種需要一直收訊息的地方（need）才一直連著。
// 斷線時已經掛著的監聽會暫停，連回來後 Firebase 會自動補上最新資料。
const T = (typeof window !== 'undefined' && window.__wrConn) || {};  // 測試用：縮短時間
const GRACE_MS = T.grace || 30000;
const BUSY_MS = T.busy || 12000;  // 想連卻連不上超過這麼久：多半是同時連線的人太多（或網路不好）
const needs = new Set();
let until = 0;
let conn = null;     // 連上之後的 db
let offline = false; // 是不是我們主動斷開的
let offTimer = null;
let connected = false;
let busyTimer = null;
let busy = false;
const busyCbs = [];
const connWaits = [];

function setBusy(b) {
  if (b === busy) return;
  busy = b;
  for (const cb of busyCbs) { try { cb(b); } catch { /* 忽略 */ } }
}

function checkBusy() {
  clearTimeout(busyTimer);
  if (connected || offline || !conn) { setBusy(false); return; }
  busyTimer = setTimeout(() => { if (!connected && !offline && navigator.onLine !== false) setBusy(true); }, BUSY_MS);
}

function settle() {
  clearTimeout(offTimer);
  if (!conn) return;
  const left = until - Date.now();
  if (needs.size || left > 0) {
    if (offline) { offline = false; try { conn.goOnline(); } catch { /* 忽略 */ } checkBusy(); }
    if (!needs.size) offTimer = setTimeout(settle, left + 50);
    return;
  }
  if (!offline) { offline = true; try { conn.goOffline(); } catch { /* 忽略 */ } checkBusy(); }
}

function watchConn(db) {
  conn = db;
  try {
    db.ref('.info/connected').on('value', (snap) => {
      connected = snap.val() === true;
      if (connected) while (connWaits.length) connWaits.shift()();
      checkBusy();
    });
  } catch { /* 忽略 */ }
  settle();
  checkBusy();
}

// 接下來 ms 毫秒內要用連線（getDb 會自動呼叫）
export function touch(ms = GRACE_MS) {
  until = Math.max(until, Date.now() + ms);
  settle();
}

// 某件事需要一直連著（例如 'room'：在多人房間裡；'admin'：後台）；on=false 就不需要了
export function need(tag, on = true) {
  if (on === needs.has(tag)) return;
  if (on) needs.add(tag); else needs.delete(tag);
  if (!on) until = Math.max(until, Date.now() + GRACE_MS);  // 剛離開房間：留一下，收尾的寫入才送得出去
  settle();
}

// 等連上伺服器，最多等 ms 毫秒；連得上回傳 true
export function whenConnected(ms) {
  if (connected) return Promise.resolve(true);
  return new Promise((ok) => {
    const done = () => { clearTimeout(t); ok(true); };
    const t = setTimeout(() => { const i = connWaits.indexOf(done); if (i >= 0) connWaits.splice(i, 1); ok(false); }, ms);
    connWaits.push(done);
  });
}

export const isConnected = () => connected;

// 連不上（人太多）的狀態改變時通知：cb(true) 連不上、cb(false) 恢復了
export function onBusy(cb) { busyCbs.push(cb); if (busy) cb(true); }
