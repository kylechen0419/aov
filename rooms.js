// 後台用：房主把房間的概況寫到 Firebase，製作者的後台頁面就能看到「現在有哪些房間在玩」。
// 只有房間層級的資訊（代碼、暱稱、模式、進度摘要），沒有任何人確切在哪個條目、也不會鏡像畫面。
import { getDb } from './fb.js?v=57';

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
