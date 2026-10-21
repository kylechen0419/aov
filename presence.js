// 線上人數：統計現在有多少人打開這個網站（online：大家都看得到的總數，不會記下是誰）。
// 另外給製作者後台一份「誰在線上、在做什麼」（who：只有管理員讀得到）：暱稱、在首頁／房間／比賽／單人訓練、
// 房間代碼、模式、題目和步數。不會記下正在看哪個條目、也看不到任何人的畫面。
// 沒有在 firebase-config.js 填設定的話，整個功能會安靜地關閉，不影響遊戲其他部分。
import { getDb, getUid, onAuth, authOff } from './fb.js?v=75';
import { bumpPeak } from './rooms.js?v=75';

let started = false;
let retries = 0;
let activity = { s: 'home' };  // 目前在做什麼（app.js 透過 setActivity 更新）
let since = Date.now();        // 這個狀態從什麼時候開始
let pushWho = () => {};

// 遊戲畫面或進度改變時呼叫；內容一樣就不重寫
export function setActivity(a) {
  if (JSON.stringify(a) === JSON.stringify(activity)) return;
  if (a.s !== activity.s || a.r !== activity.r) since = Date.now();
  activity = a;
  pushWho();
}

// onCount(n) 會在人數變動時被呼叫；沒設定或連不上就不會呼叫，首頁那塊就維持隱藏
export async function initPresence(onCount) {
  if (started) return;
  started = true;
  const db = await getDb();
  if (!db) {
    // 一開始連不上（例如網路不穩）：過一下再試，網路恢復後人數就會出現
    started = false;
    if (window.WIKIRACE_FIREBASE?.databaseURL && retries++ < 20) setTimeout(() => initPresence(onCount), 15000);
    return;
  }
  try {
    const online = db.ref('online');
    // 自己的存在：給一個隨機節點，斷線時 Firebase 會自動幫忙移除
    const me = online.push();
    const who = db.ref(`who/${me.key}`);
    const opened = Date.now();
    let live = false;
    let uid = '';
    const ready = () => live && (uid || authOff());  // 還沒登入好：規則會擋，等登入好（onAuth）再寫
    const off = (p) => p?.catch?.(() => {});
    // 給後台看的詳細資料：每次狀態改變就更新
    pushWho = () => {
      if (!ready()) return;
      try { off(who.set({ ...activity, u: uid, t: opened, since, at: Date.now() })); } catch { /* 忽略 */ }
    };
    // u：是誰的（資料庫規則只准本人刪改）。每次都重新拿登入身分：網路慢的話會晚一點才登入好
    const write = async () => {
      uid = (await getUid()) || '';
      if (!ready()) return;
      try {
        off(me.onDisconnect().remove());
        off(who.onDisconnect().remove());
        await me.set({ u: uid, t: opened });
        pushWho();
      } catch { /* 規則擋下（還沒登入）就等登入好再寫 */ }
    };
    db.ref('.info/connected').on('value', (snap) => { live = snap.val() === true; if (live) write(); });
    onAuth((id) => { if (id) write(); });
    online.on('value', (snap) => { const n = snap.numChildren(); onCount(n); bumpPeak(n); });
    window.addEventListener('pagehide', (e) => { if (!e.persisted) { try { off(me.remove()); off(who.remove()); } catch { /* 忽略 */ } } });
  } catch { /* 連不上就安靜放棄 */ }
}
