// 線上人數：統計現在有多少人打開這個網站（online：大家都看得到的總數，不會記下是誰）。
// 另外給製作者後台一份「誰在線上、在做什麼」（who：只有管理員讀得到）：暱稱、在首頁／房間／比賽／單人訓練、
// 房間代碼、模式、題目和步數。不會記下正在看哪個條目、也看不到任何人的畫面。
// 沒有在 firebase-config.js 填設定的話，整個功能會安靜地關閉，不影響遊戲其他部分。
import { getDb, getUid, onAuth, authOff } from './fb.js?v=97';
import { bumpPeak } from './rooms.js?v=97';

let started = false;
let retries = 0;
let activity = { s: 'home' };  // 目前在做什麼（app.js 透過 setActivity 更新）
let since = Date.now();        // 這個狀態從什麼時候開始
let pushWho = () => {};
let liveRef = null;        // live/<自己的 key>：管理員觀戰時才寫
let spyCb = () => {};
const VERSION = Number(new URL(import.meta.url).searchParams.get('v')) || 0;  // 這個分頁是第幾版（後台看版本分布）
let withV = true;  // Firebase 上還是舊規則（不認得 v）就不帶

// 管理員要看我的畫面時通知 app.js（on=true 開始、false 結束）
export function onSpy(cb) { spyCb = cb; }

// 管理員觀戰時傳來的一句話（{ text, id }）
let msgCb = () => {};
export function onAdminMsg(cb) { msgCb = cb; }

// 被管理員踢出伺服器時通知 app.js（{ until }；解除了就是 null）
let banCb = () => {};
export function onBan(cb) { banCb = cb; }

// 被踢出：從線上名單拿掉自己，之後也不再寫
let dropMe = () => {};
export function leaveOnline() { dropMe(); }

// 管理員觀戰中：把目前的畫面（條目、捲到哪、點了什麼、步數）寫上去，只有管理員讀得到
export function sendLiveToAdmin(data) {
  if (!liveRef) return;
  try { liveRef.set({ ...data, at: Date.now() })?.catch?.(() => {}); } catch { /* 忽略 */ }
}

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
    let gone = false;
    const ready = () => live && !gone && (uid || authOff());  // 還沒登入好：規則會擋，等登入好（onAuth）再寫
    const off = (p) => p?.catch?.(() => {});
    dropMe = () => { gone = true; try { off(me.remove()); off(who.remove()); } catch { /* 忽略 */ } };
    // 給後台看的詳細資料：每次狀態改變就更新
    const whoRec = () => ({ ...activity, u: uid, t: opened, since, at: Date.now(), ...(withV && VERSION ? { v: VERSION } : {}) });
    // 被規則擋下：可能是舊規則不認得 v，拿掉再試一次
    const setWho = () => who.set(whoRec()).catch((e) => {
      if (!withV || !VERSION || !/permission/i.test(String(e?.code || e?.message))) throw e;
      withV = false;
      return who.set(whoRec());
    });
    pushWho = () => {
      if (!ready()) return;
      try { off(setWho()); } catch { /* 忽略 */ }
    };
    // u：是誰的（資料庫規則只准本人刪改）。每次都重新拿登入身分：網路慢的話會晚一點才登入好
    let banFor = null;
    const watchBan = () => {
      if (!uid || banFor === uid) return;
      banFor = uid;
      db.ref(`ban/${uid}`).on('value', (snap) => { const v = snap.val(); banCb(v && Number(v.until) > Date.now() ? { until: Number(v.until) } : null); }, () => { banFor = null; });
    };
    const write = async () => {
      uid = (await getUid()) || '';
      watchBan();  // 被踢的人寫不進資料（規則會擋），所以先聽踢出名單
      if (!ready()) return;
      try {
        off(me.onDisconnect().remove());
        off(who.onDisconnect().remove());
        await me.set({ u: uid, t: opened });
        await setWho();
        watchSpy();  // 規則要先確認這筆是我的，才讓我讀管理員的觀戰要求
      } catch { /* 規則擋下（還沒登入）就等登入好再寫 */ }
    };
    // 管理員觀戰：spy/<key> 有值就是管理員正在看。管理員的頁面每 20 秒更新一次，
    // 超過 60 秒沒看到更新就當作沒在看了（用自己看到更新的時間算，手機時間不準也沒關係）
    const spyRef = db.ref(`spy/${me.key}`);
    const lref = db.ref(`live/${me.key}`);
    let spyMark = null;
    let spySeen = 0;
    let spyOn = false;
    const checkSpy = () => {
      const on = spyMark !== null && Date.now() - spySeen < 60000;
      if (on === spyOn) return;
      spyOn = on;
      liveRef = on ? lref : null;
      if (on) off(lref.onDisconnect().remove());
      else { try { off(lref.remove()); } catch { /* 忽略 */ } }
      spyCb(on);
    };
    let spying = false;
    const watchSpy = () => {
      if (spying) return;
      spying = true;
      spyRef.on('value', (snap) => {
        const m = snap.val()?.msg;
        if (m && typeof m.text === 'string' && m.text.trim()) msgCb({ text: m.text.trim().slice(0, 100), id: String(m.id || m.text) });
        const at = snap.val()?.at ?? null;
        if (at !== spyMark) { spyMark = at; spySeen = Date.now(); }
        checkSpy();
      }, () => { spying = false; /* 規則還沒更新：沒有觀戰功能 */ });
    };
    setInterval(checkSpy, 10000);
    db.ref('.info/connected').on('value', (snap) => { live = snap.val() === true; if (live) write(); });
    onAuth((id) => { if (id) write(); });
    online.on('value', (snap) => { const n = snap.numChildren(); onCount(n); bumpPeak(n); });
    window.addEventListener('pagehide', (e) => { if (!e.persisted) { try { off(me.remove()); off(who.remove()); } catch { /* 忽略 */ } } });
  } catch { /* 連不上就安靜放棄 */ }
}
