// 玩家帳號（Google 登入）：可以先不登入就玩；登入之後暱稱、頭像、戰績存在雲端（users/<uid>），換手機也還在，
// 每日挑戰排行榜也只收登入的人（資料庫規則會擋）。
// 原本沒登入時的匿名身分會直接「升級」成這個 Google 帳號（uid 不變，之前的紀錄都接得上）；
// 這個 Google 帳號以前在別的手機登入過，就換成那個帳號的身分（uid 會變，畫面重新載入一次）。
import { getDb } from './fb.js?v=103';

const GOALS = ['speed', 'steps', 'items', 'isteps', 'rush'];
const cleanStat = (s) => ({ w: num(s?.w), l: num(s?.l), d: num(s?.d), streak: num(s?.streak) });
const num = (v) => Math.max(0, Math.min(1e6, Math.floor(Number(v)) || 0));

let changeCb = () => {};
export function onAccount(cb) { changeCb = cb; }

// 現在登入的 Google 帳號（沒登入回傳 null）
export function account() {
  try {
    const u = window.firebase?.auth?.().currentUser;
    if (!u || u.isAnonymous) return null;
    const g = u.providerData?.find((p) => p.providerId === 'google.com') || {};
    return { uid: u.uid, email: u.email || g.email || '', name: u.displayName || g.displayName || '' };
  } catch { return null; }
}

// 第一次載入時等登入狀態恢復，再通知畫面
export async function initAccount() {
  if (!(await getDb())) return;
  try {
    const auth = window.firebase.auth();
    auth.onAuthStateChanged(() => changeCb(account()));
  } catch { /* 沒有登入功能 */ }
}

const LOGIN_ERR = {
  'auth/popup-blocked': '瀏覽器擋掉了登入視窗，請允許彈出視窗後再按一次',
  'auth/popup-closed-by-user': '',
  'auth/cancelled-popup-request': '',
  'auth/user-cancelled': '',
  'auth/unauthorized-domain': '這個網址還沒開放 Google 登入（請管理員到 Firebase 加上授權網域）',
  'auth/operation-not-allowed': 'Google 登入還沒開啟（請管理員到 Firebase 開啟）',
  'auth/network-request-failed': '網路不太穩，等一下再試一次',
};

// 用 Google 登入。回傳 { ok, switched }：switched＝換成另一個（之前就有的）帳號身分，畫面要重新載入
export async function login() {
  if (!(await getDb())) throw new Error('連不上伺服器，等一下再試一次');
  const fb = window.firebase;
  const auth = fb.auth();
  const before = auth.currentUser?.uid || null;
  const provider = new fb.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const u = auth.currentUser;
    if (u && u.isAnonymous) {
      try {
        await u.linkWithPopup(provider);
      } catch (e) {
        // 這個 Google 帳號已經有自己的身分（以前在別的地方登入過）：直接用那個身分
        if (e.code !== 'auth/credential-already-in-use' && e.code !== 'auth/email-already-in-use') throw e;
        const cred = e.credential || fb.auth.GoogleAuthProvider.credentialFromError?.(e);
        if (cred) await auth.signInWithCredential(cred);
        else await auth.signInWithPopup(provider);
      }
    } else {
      await auth.signInWithPopup(provider);
    }
    await auth.currentUser.getIdToken(true);  // 拿到有 email 的新憑證，資料庫規則才認得
  } catch (e) {
    const msg = LOGIN_ERR[e.code];
    if (msg === '') return { ok: false };
    throw new Error(msg || `登入失敗（${e.code || e.message}）`);
  }
  const after = auth.currentUser?.uid;
  changeCb(account());
  return { ok: true, switched: !!before && after !== before };
}

// 登出：之後又是一個新的匿名身分（重新載入頁面時自動建立）
export async function logout() {
  try { await window.firebase.auth().signOut(); } catch { /* 忽略 */ }
}

// ---------- 雲端資料 ----------
// 讀雲端的暱稱、頭像、戰績；跟這支手機的合併（每種玩法取場數多的那份），合併後寫回去
export async function syncProfile({ name, avatar, stats }) {
  const me = account();
  const db = await getDb();
  if (!me || !db) return null;
  const ref = db.ref(`users/${me.uid}`);
  let remote = null;
  try { remote = (await ref.once('value')).val(); } catch { return null; }
  const total = (s) => s.w + s.l + s.d;
  const merged = {};
  for (const g of GOALS) {
    const a = cleanStat(stats[g]);
    const b = cleanStat(remote?.st?.[g]);
    merged[g] = total(b) > total(a) ? b : a;
  }
  const out = {
    n: String(remote?.n || name || '').slice(0, 16),
    a: String(remote?.a || avatar || '').slice(0, 20),
    st: merged,
  };
  try {
    await ref.update({ ...out, e: me.email.slice(0, 100), g: me.name.slice(0, 60), at: window.firebase.database.ServerValue.TIMESTAMP });
  } catch { /* 規則還沒更新：先只存在手機上 */ }
  return out;
}

// 暱稱、頭像、某一種玩法的戰績改了：寫到雲端（沒登入就什麼都不做）
export async function saveProfile(fields) {
  const me = account();
  const db = await getDb();
  if (!me || !db) return;
  const up = {};
  if (typeof fields.n === 'string') up.n = fields.n.slice(0, 16);
  if (typeof fields.a === 'string') up.a = fields.a.slice(0, 20);
  if (fields.goal && GOALS.includes(fields.goal)) up[`st/${fields.goal}`] = cleanStat(fields.stat);
  if (!Object.keys(up).length) return;
  up.at = window.firebase.database.ServerValue.TIMESTAMP;
  try { await db.ref(`users/${me.uid}`).update(up); } catch { /* 忽略 */ }
}
