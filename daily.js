// 每日挑戰：全台灣每天同一題（台灣時間午夜換題），每支手機第一次完成的成績進今日排行榜。
// 題目用日期當種子從題庫抽，只看「條目存在、不是消歧義頁」這種每個人查都一樣的條件，所以大家算出來的題目相同。
// 排行榜存在 Firebase 的 stats/daily/<日期>/<手機代號>；沒設定 Firebase 時一樣能玩，只是沒有排行榜。
import { getDb } from './fb.js?v=65';
import { api } from './wiki.js?v=65';

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

// 條目存在、在主命名空間、不是消歧義頁：回傳正式標題，否則 null
async function realTitle(title) {
  const d = await api('zh', { action: 'query', titles: title, redirects: '1', converttitles: '1', prop: 'pageprops', ppprop: 'disambiguation' });
  const p = d.query?.pages?.[0];
  if (!p || p.missing || p.invalid || p.ns !== 0) return null;
  if (p.pageprops && 'disambiguation' in p.pageprops) return null;
  return p.title;
}

// 起點那一頁是不是直接就有終點的連結（一步就到太無聊，換一題）
async function linksDirectly(from, to) {
  const d = await api('zh', { action: 'query', titles: from, prop: 'links', pltitles: to, plnamespace: '0', redirects: '1' });
  return !!d.query?.pages?.[0]?.links?.length;
}

const puzzles = {};
export function puzzle(key = todayKey()) {
  puzzles[key] ||= (async () => {
    const { TOPICS } = await import('./topics.js?v=65');
    const rnd = seeded(`wikirace-daily-${key}`);
    const pick = async (avoid) => {
      for (let i = 0; i < 25; i++) {
        const t = await realTitle(TOPICS[Math.floor(rnd() * TOPICS.length)]);
        if (t && !avoid.includes(t)) return t;
      }
      throw new Error('今天的題目讀取失敗，請稍後再試');
    };
    const start = await pick([]);
    let target = await pick([start]);
    for (let i = 0; i < 6 && await linksDirectly(start, target); i++) {
      try { target = await pick([start, target]); } catch { break; }  // 換不到就用原本的
    }
    return { key, no: dailyNo(key), start, target };
  })();
  puzzles[key].catch(() => { delete puzzles[key]; });
  return puzzles[key];
}

// ---------- 這支手機的紀錄 ----------
export function loadLog() {
  try { const v = JSON.parse(localStorage.getItem(LOG) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export const myDay = (key) => loadLog()[key] || null;
export function saveDay(key, rec) {
  const log = loadLog();
  log[key] = rec;
  const keys = Object.keys(log).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete log[k];
  try { localStorage.setItem(LOG, JSON.stringify(log)); } catch { /* 忽略 */ }
}
// 連續完成幾天：今天還沒玩不算斷，從昨天往回數
export function streak(key = todayKey()) {
  const log = loadLog();
  let k = log[key]?.win ? key : prevKey(key);
  let n = 0;
  while (log[k]?.win) { n++; k = prevKey(k); }
  return n;
}

// ---------- 今日排行榜 ----------
const clean = (id, r) => {
  if (!r || typeof r !== 'object') return null;
  const s = Math.round(Number(r.s)), t = Math.round(Number(r.t));
  if (!(s >= 1 && s <= 500 && t >= 1000 && t <= 6 * 3600e3)) return null;
  return { id, n: String(r.n || '').trim().slice(0, 16) || '玩家', a: typeof r.a === 'string' ? r.a.slice(0, 32) : '', s, t, h: !!r.h };
};
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

// 回傳依「步數少→時間短」排好的成績；沒有 Firebase 或連不上回傳 null
export async function board(key) {
  const db = await getDb();
  if (!db) return null;
  try {
    const snap = await withTimeout(db.ref(`stats/daily/${key}`).once('value'), 6000);
    const v = snap.val() || {};
    return Object.entries(v).map(([id, r]) => clean(id, r)).filter(Boolean).sort((a, b) => a.s - b.s || a.t - b.t);
  } catch { return null; }
}

// 送出今天的成績（只有第一次完成會呼叫）
export async function submit(key, id, rec) {
  const db = await getDb();
  if (!db) return false;
  try { await withTimeout(db.ref(`stats/daily/${key}/${id}`).set({ ...rec, at: Date.now() }), 6000); return true; } catch { return false; }
}
