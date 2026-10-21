// 後台用：房主把房間概況寫到 Firebase，製作者的後台頁面就能看到「現在有哪些房間在玩」。
// 只有房間層級的資訊（代碼、暱稱、模式、進度摘要），沒有任何人確切在哪個條目、也不會鏡像畫面。
import { getDb } from './fb.js?v=69';

let roomRef = null;
let curCode = null;

// 房主：更新目前房間的概況（頻繁呼叫沒關係，資料很小）
export async function publishRoom(code, data) {
  if (!code) return;
  const db = await getDb();
  if (!db) return;
  try {
    if (curCode !== code) {
      curCode = code;
      roomRef = db.ref(`rooms/${code}`);
      roomRef.onDisconnect().remove();  // 房主手機斷線時自動清掉
    }
    roomRef.set({ ...data, updatedAt: Date.now() });
  } catch { /* 忽略 */ }
}

// 房主：房間關了／自己不再是房主時，清掉這筆
export async function clearRoom(code) {
  const db = await getDb();
  if (!db) return;
  try {
    if (roomRef) { roomRef.onDisconnect().cancel(); }
    await db.ref(`rooms/${code || curCode}`).remove();
  } catch { /* 忽略 */ }
  roomRef = null;
  curCode = null;
}

// 一局結束時，房主記一筆（給後台算歷史統計）。只存聚合用的小資料。
export async function recordGame(record) {
  const db = await getDb();
  if (!db) return;
  try { await db.ref('stats/games').push({ ...record, at: Date.now() }); } catch { /* 忽略 */ }
}

// 更新「史上最多同時在線」（用 transaction 避免多人同時寫互相蓋掉）
export async function bumpPeak(n) {
  const db = await getDb();
  if (!db) return;
  try { db.ref('stats/peakOnline').transaction((cur) => Math.max(Number(cur) || 0, n)); } catch { /* 忽略 */ }
}

// 房主：監聽後台對這個房間下的指令（關閉房間、踢人）。回傳取消監聽的函式。
export async function watchControl(code, handler) {
  const db = await getDb();
  if (!db || !code) return () => {};
  const ref = db.ref(`control/${code}`);
  const cb = ref.on('value', (snap) => {
    const cmd = snap.val();
    if (cmd && cmd.type) { ref.remove().catch(() => {}); handler(cmd); }
  });
  return () => { try { ref.off('value', cb); } catch { /* 忽略 */ } };
}

// 全站公告：訂閱製作者從後台發的訊息
export async function watchBroadcast(handler) {
  const db = await getDb();
  if (!db) return;
  try { db.ref('broadcast').on('value', (snap) => handler(snap.val())); } catch { /* 忽略 */ }
}
