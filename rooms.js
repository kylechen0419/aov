// 後台用：房主把房間概況寫到 Firebase，製作者的後台頁面就能看到「現在有哪些房間在玩」。
// 只有房間層級的資訊（代碼、暱稱、模式、進度摘要），沒有任何人確切在哪個條目、也不會鏡像畫面。
import { getDb, getUid, authOff } from './fb.js?v=97';

let roomRef = null;
let curCode = null;
let lastData = null;  // 最近一次的房間概況：Firebase 斷線重連後要重新寫回去
let gen = 0;          // 每清掉一次房間就加一：還在路上的舊寫入看到號碼變了就放棄
let published = Promise.resolve();  // 最近一次寫入房間的結果：聽後台指令前要等房間先寫進去
let connWatch = false;

// 寫入房間，成功後才登記「斷線時刪掉」（規則要先確認這間房是你的，才准你登記刪除）
function writeRoom(db, code, data, myGen) {
  const ref = db.ref(`rooms/${code}`);
  const p = Promise.resolve(ref.set(data)).then(() => {
    if (myGen !== gen) { ref.remove()?.catch?.(() => {}); return; }  // 寫進去的時候房間已經清掉了：收回
    ref.onDisconnect().remove()?.catch?.(() => {});
  });
  p.catch(() => {});
  return p;
}

// 房主：更新目前房間的概況（頻繁呼叫沒關係，資料很小）
export async function publishRoom(code, data) {
  if (!code) return;
  const myGen = gen;
  const db = await getDb();
  if (!db) return;
  const uid = (await getUid()) || '';
  if (myGen !== gen) return;  // 等的這一下房間已經清掉了（例如剛把房主交出去）
  try {
    if (curCode !== code) { curCode = code; roomRef = db.ref(`rooms/${code}`); }
    // owner：房主的登入身分；資料庫規則只讓這個人改這間房、讀這間房的後台指令
    lastData = { ...data, owner: uid };
    published = writeRoom(db, code, { ...lastData, updatedAt: Date.now() }, myGen);
    if (!connWatch) {
      connWatch = true;
      // Firebase 斷線時伺服器會照「斷線時刪掉」把房間清掉；重連後要寫回去，後台才看得到、指令才收得到
      db.ref('.info/connected').on('value', (snap) => {
        if (snap.val() !== true || !curCode || !lastData) return;
        published = writeRoom(db, curCode, { ...lastData, updatedAt: Date.now() }, gen);
      });
    }
  } catch { /* 忽略 */ }
}

// 房主：房間關了／自己不再是房主時，清掉這筆
export async function clearRoom(code) {
  gen++;  // 先同步標記：之後才到的寫入都不算數
  const target = code || curCode;
  const ref = roomRef;
  roomRef = null;
  curCode = null;
  lastData = null;
  const db = await getDb();
  if (!db || !target) return;
  try {
    if (ref) ref.onDisconnect().cancel()?.catch?.(() => {});
    await db.ref(`rooms/${target}`).remove();
  } catch { /* 忽略 */ }
}

// 房間被別人接手了：忘掉自己寫過的房間（不刪除，那已經是新房主的了），也取消「斷線時刪掉」
export function forgetRoom() {
  gen++;
  try { roomRef?.onDisconnect().cancel()?.catch?.(() => {}); } catch { /* 忽略 */ }
  roomRef = null;
  curCode = null;
  lastData = null;
}

// 一局結束時，房主記一筆（給後台算歷史統計）。只存聚合用的小資料。
export async function recordGame(record) {
  const db = await getDb();
  if (!db) return;
  try { await db.ref('stats/games').push({ ...record, at: Date.now() }); } catch { /* 忽略 */ }
  countToday('games', 1);
  countToday('players', Math.min(8, Number(record.players) || 1));
}

// 今天（台灣時間）的公開計數：每晚的摘要通知讀這個（只有數字，不含是誰）
export async function countToday(k, n = 1) {
  const db = await getDb();
  if (!db) return;
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  try { db.ref(`stats/dayCount/${day}/${k}`).transaction((cur) => (Number(cur) || 0) + n)?.catch?.(() => {}); } catch { /* 忽略 */ }
}

// 更新「史上最多同時在線」（用 transaction 避免多人同時寫互相蓋掉）
export async function bumpPeak(n) {
  const db = await getDb();
  if (!db) return;
  if (!(await getUid()) && !authOff()) return;  // 還沒登入好：規則會擋，等下次人數變動再更新
  try { db.ref('stats/peakOnline').transaction((cur) => Math.max(Number(cur) || 0, n))?.catch?.(() => {}); } catch { /* 忽略 */ }
}

// 房主：監聽後台對這個房間下的指令（關閉房間、踢人）。馬上回傳取消監聽的函式（還在準備中也能取消）。
export function watchControl(code, handler) {
  let stopped = false;
  let ref = null;
  let cb = null;
  let timer = null;
  let fails = 0;
  (async () => {
    const db = await getDb();
    if (!db || !code || stopped) return;
    ref = db.ref(`control/${code}`);
    // 規則只讓這間房的房主讀指令：房間還沒寫進去（或斷線後被清掉、還沒寫回去）時會被拒絕，過一下再試
    const listen = async () => {
      try { await published; } catch { /* 寫入失敗也照樣試著聽 */ }
      if (stopped) return;
      cb = ref.on('value', (snap) => {
        fails = 0;
        const cmd = snap.val();
        if (cmd && cmd.type) { ref.remove()?.catch?.(() => {}); handler(cmd); }
      }, () => {
        cb = null;
        if (!stopped) timer = setTimeout(listen, Math.min(30000, 3000 * 2 ** Math.min(fails++, 4)));
      });
    };
    listen();
  })();
  return () => {
    stopped = true;
    clearTimeout(timer);
    try { if (ref && cb) ref.off('value', cb); } catch { /* 忽略 */ }
  };
}

// 全站公告：訂閱製作者從後台發的訊息
export async function watchBroadcast(handler) {
  const db = await getDb();
  if (!db) return;
  try { db.ref('broadcast').on('value', (snap) => handler(snap.val())); } catch { /* 忽略 */ }
}
