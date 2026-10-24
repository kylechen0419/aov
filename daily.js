// 每日挑戰：全台灣每天同一題（台灣時間午夜換題），每支手機第一次完成的成績進今日排行榜。
// 題目用日期當種子從題庫抽，只看「條目存在、不是消歧義頁」這種每個人查都一樣的條件。
// 第一個算出今天題目的人會把它存進 Firebase（stats/dailyPuzzle/d<天數>），之後大家都讀這一份，
// 所以就算當天維基百科有人改了條目、或題庫更新，同一天的題目也不會變。
// 排行榜存在 stats/daily/<日期>/<手機代號>；沒設定 Firebase 時一樣能玩（題目靠自己算），只是沒有排行榜。
import { getDb } from './fb.js?v=115';
import { api } from './wiki.js?v=115';

const LAUNCH = '2026-10-21';  // 第 1 期
const LOG = 'wikirace-daily-log';

// 台灣時間的日期，例如 2026-10-21
export const todayKey = (now = Date.now()) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
export const dailyNo = (key) => Math.round((Date.parse(key) - Date.parse(LAUNCH)) / 864e5) + 1;
const prevKey = (key) => new Date(Date.parse(key) - 864e5).toISOString().slice(0, 10);

function seeded(text) {
  let h = 2166136261;
  for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
// Firebase SDK 載不下來也不要卡住
const database = () => withTimeout(getDb(), 14000).catch(() => null);

// 維基百科有時回 200 但內容是錯誤（太忙、維護中）：一定要當成失敗重試，
// 不能當成「條目不存在」跳過，不然這支手機抽到的題目會跟別人不一樣
async function ask(params) {
  const d = await api('zh', params);
  if (!d || d.error || !d.query) throw new Error('維基百科暫時沒有回應，請稍後再試');
  return d;
}

// 條目存在、在主命名空間、不是消歧義頁：回傳正式標題，否則 null
async function realTitle(title) {
  const d = await ask({ action: 'query', titles: title, redirects: '1', converttitles: '1', prop: 'pageprops', ppprop: 'disambiguation' });
  const p = d.query?.pages?.[0];
  if (!p || p.missing || p.invalid || p.ns !== 0) return null;
  if (p.pageprops && 'disambiguation' in p.pageprops) return null;
  return p.title;
}

// 起點那一頁是不是直接就有終點的連結（一步就到太無聊，換一題）
async function linksDirectly(from, to) {
  const d = await ask({ action: 'query', titles: from, prop: 'links', pltitles: to, plnamespace: '0', redirects: '1' });
  return !!d.query?.pages?.[0]?.links?.length;
}

// 自己從題庫算出今天的題目
async function compute(key) {
  const { TOPICS } = await import('./topics.js?v=115');
  const rnd = seeded(`wikirace-daily-${key}`);
  const pick = async (avoid) => {
    for (let i = 0; i < 25; i++) {
      const t = await realTitle(TOPICS[Math.floor(rnd() * TOPICS.length)]);
      if (t && !avoid.includes(t)) return t;
    }
    throw Object.assign(new Error('今天的題目讀取失敗，請稍後再試'), { exhausted: true });
  };
  const start = await pick([]);
  let target = await pick([start]);
  for (let i = 0; i < 6 && await linksDirectly(start, target); i++) {
    // 真的換不到就用原本的；網路錯誤要整個重來，不能各手機各自決定
    try { target = await pick([start, target]); } catch (e) { if (!e.exhausted) throw e; break; }
  }
  return { start, target };
}

// 第幾輪：管理員在後台「重置今天的挑戰」會把輪數加一，大家都能再正式挑戰一次、排行榜重新開始。
// 這支手機的紀錄和排行榜都照輪數分開（第 1 輪沿用原本的位置，舊資料不受影響）
const rounds = {};
export const roundOf = (key) => rounds[key] || 1;
export const roundKnown = (key) => key in rounds;
const boardKey = (key) => (roundOf(key) > 1 ? `${key}_r${roundOf(key)}` : key);
const setRound = (key, v) => { rounds[key] = Math.max(1, Math.floor(Number(v?.round)) || 1); };

const okPuzzle = (v) => !!(v && typeof v.start === 'string' && typeof v.target === 'string' && v.start && v.target && v.start !== v.target && v.start.length < 200 && v.target.length < 200);
const puzzles = {};
export function puzzle(key = todayKey()) {
  if (puzzles[key]) return puzzles[key];
  const raw = (async () => {
    const base = { key, no: dailyNo(key) };
    const db = await database();
    // 存在 d＋天數 底下：資料庫規則用伺服器時間檢查，只准存昨天到明天的題目
    const ref = db && db.ref(`stats/dailyPuzzle/d${Math.round(Date.parse(key) / 864e5)}`);
    // 已經有人算好今天的題目：直接用那一份
    if (ref) {
      try {
        const v = (await withTimeout(ref.once('value'), 6000)).val();
        if (okPuzzle(v)) { setRound(key, v); return { ...base, start: v.start, target: v.target, round: roundOf(key) }; }
      } catch { /* 讀不到就自己算 */ }
    }
    const mine = await compute(key);
    // 搶著存：如果有人剛好先存了，就用他的（transaction 保證只會有一份）
    if (ref) {
      try {
        const res = await withTimeout(ref.transaction((cur) => (okPuzzle(cur) ? undefined : { start: mine.start, target: mine.target, at: Date.now() })), 6000);
        const v = res?.snapshot?.val();
        if (okPuzzle(v)) { setRound(key, v); return { ...base, start: v.start, target: v.target, round: roundOf(key) }; }
      } catch { /* 存不進去也照樣用自己算的 */ }
    }
    return { ...base, ...mine };
  })();
  const mine = raw.then((p) => { if (!(key in rounds)) rounds[key] = 1; return { round: roundOf(key), ...p }; });  // 讀不到資料庫：就是第 1 輪
  puzzles[key] = mine;
  // 過一陣子再打開就重新讀一次（管理員可能剛重置或換題）
  mine.then(() => setTimeout(() => { if (puzzles[key] === mine) delete puzzles[key]; }, 20000), () => { delete puzzles[key]; });
  return mine;
}

// ---------- 這支手機的紀錄 ----------
export function loadLog() {
  try { const v = JSON.parse(localStorage.getItem(LOG) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
// 只算這一輪的紀錄（管理員重置之後，之前那一輪的紀錄就不算「今天已經玩過」）
export const myDay = (key) => { const r = loadLog()[key]; return r && (r.r || 1) === roundOf(key) ? r : null; };
export function saveDay(key, rec) {
  const log = loadLog();
  log[key] = { ...rec, r: roundOf(key) };
  const keys = Object.keys(log).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete log[k];
  try { localStorage.setItem(LOG, JSON.stringify(log)); } catch { /* 忽略 */ }
}
// 連續完成幾天：今天還沒玩不算斷，從昨天往回數
export function streak(key = todayKey()) {
  const log = loadLog();
  let k = myDay(key)?.win ? key : prevKey(key);
  let n = 0;
  while (log[k]?.win) { n++; k = prevKey(k); }
  return n;
}

// ---------- 今日排行榜 ----------
const clean = (id, r) => {
  if (!r || typeof r !== 'object') return null;
  const s = Math.round(Number(r.s)), t = Math.round(Number(r.t));
  if (!(s >= 1 && s <= 999 && t >= 1000 && t <= 24 * 3600e3)) return null;
  // p：走過的路線（舊的成績沒有）
  const p = (Array.isArray(r.p) ? r.p : r.p && typeof r.p === 'object' ? Object.values(r.p) : []).filter((x) => typeof x === 'string').slice(0, 200).map((x) => x.slice(0, 100));
  return { id, n: String(r.n || '').trim().slice(0, 16) || '玩家', a: typeof r.a === 'string' ? r.a.slice(0, 32) : '', s, t, h: !!r.h, p };
};
// 回傳依「步數少→時間短」排好的成績；沒有 Firebase 或連不上回傳 null
export async function board(key) {
  const db = await database();
  if (!db) return null;
  try {
    const snap = await withTimeout(db.ref(`stats/daily/${boardKey(key)}`).once('value'), 6000);
    const v = snap.val() || {};
    return Object.entries(v).map(([id, r]) => clean(id, r)).filter(Boolean).sort((a, b) => a.s - b.s || a.t - b.t);
  } catch { return null; }
}

// 送出今天的成績（只有第一次完成會呼叫）
export async function submit(key, id, rec) {
  const db = await database();
  if (!db) return false;
  try { await withTimeout(db.ref(`stats/daily/${boardKey(key)}/${id}`).set({ ...rec, at: Date.now() }), 6000); return true; } catch { return false; }
}
