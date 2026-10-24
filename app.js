// 維基競速 © 2026 kylechen0419 保留所有權利。未經同意不得複製、修改或另外架設（見 LICENSE）。
import { Net } from './net.js?v=111';
import { initPresence, setActivity, onSpy, onBan, onAdminMsg, leaveOnline, sendLiveToAdmin } from './presence.js?v=111';
import { publishRoom, clearRoom, forgetRoom, recordGame, watchControl, watchBroadcast } from './rooms.js?v=111';
import { initNotify, notify } from './notify.js?v=111';
import { getDb, getUid, authOff, onAuth, need, onBusy } from './fb.js?v=111';
import { initAccount, onAccount, account, login, logout, syncProfile, saveProfile } from './account.js?v=111';
import { reportError, catchErrors } from './errors.js?v=111';
import { badName, cleanName, maskText, watchBadWords } from './names.js?v=111';
import { todayKey, dailyNo, puzzle, myDay, saveDay, streak, board, submit, roundKnown, roundOf, loadLog } from './daily.js?v=111';
import * as wiki from './wiki.js?v=111';
import { tw, twTree, zhReady } from './zh.js?v=111';
import { makeShareImage } from './share.js?v=111';
import { solve } from './solver.js?v=111';
import { sfx, music, unlockAudio, canClickNow, isSfxOn, setSfxOn, isMusicOn, setMusicOn, haptic, flash, shake, confetti, MUSIC_CHOICES, DEFAULT_CHOICE, getMusicChoice, setMusicChoice, saveCustomMusic, getCustomMusic, CLICK_SOUNDS, getClickSound, setClickSound } from './fx.js?v=111';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const net = new Net();

const DEFAULT_SETTINGS = {
  lang: 'zh', goal: 'speed', timeLimit: 0, lastCall: 0, start: '', target: '',
  // 對手位置怎麼顯示：dist＝只看遠近、hint＝模糊位置（條目簡介）、full＝完整條目名稱
  // 預設模糊：看得出對手大概在哪，但不知道確切的條目，沒辦法照抄路線
  oppView: 'hint', allowBack: true, trueRandom: false,
  allowFind: false,  // 比賽中可以打字找這一頁的連結（房主決定，預設不行）
  rushMin: 5, rushLevel: 'normal',  // 搶分賽：總共幾分鐘、題目難度
};
const MAX_PLAYERS = { duel: 2, party: 8 };
// 斷線後保留位置的時間：比賽中久一點，房間裡短一點
const GRACE_GAME = 60000;
const GRACE_ROOM = 15000;
// 轉移房主時，給大家重新連上新房主的時間
const GRACE_MIGRATE = 30000;
// 玩家連不回房主多久之後放棄
const HOST_GIVEUP = 150000;  // 連不回房主、也沒有人能接手：這麼久之後才放棄
const TAKEOVER_AFTER = 10000;  // 房主斷線這麼久還沒回來，就由排第一的玩家接手
const TAKEOVER_STEP = 12000;   // 排第一的人也不在：下一位再多等這麼久
const COLORS = ['#2f7bff', '#ff4d6d', '#22c55e', '#ff8a3d', '#8b5cf6', '#ff5ca8', '#14b8a6', '#eab308'];
// 玩家可以選的頭像（avatars/ 資料夾裡的 SVG）
const AVATARS = [
  ['owl', '貓頭鷹博士'], ['cat', '橘貓'], ['panda', '熊貓'], ['fox', '狐狸'], ['penguin', '企鵝'], ['frog', '青蛙王子'],
  ['rabbit', '兔兔'], ['dino', '小恐龍'], ['robot', '機器人'], ['shiba', '柴犬'], ['lion', '獅子'], ['chick', '小雞'],
];
const AVATAR_IDS = new Set(AVATARS.map(([id]) => id));
const EMOJIS = ['👍', '😂', '😱', '🔥', '😭', '🤯', '😎', '👋', '🥀'];
const PHRASES = ['快點開始啦！', '準備好了沒？', '我快到了！', '迷路了…', '等等我啦！', '懂你意思', '有感覺嗎', '何意味', '完全憤怒誘餌', '陳奕先好帥', 'GG FXXING EZ'];
const EMOTES = [...EMOJIS, ...PHRASES];
const CHAT_MAX = 50;

const state = {
  watch: { id: null, shown: null, token: 0, follow: true, ready: false, live: {} },
  migrating: null,
  banned: new Set(),
  devices: new Map(),
  roomScore: { games: 0, wins: {} },
  myName: '',
  myAvatar: null,
  myId: null,
  myKey: null,
  mode: 'duel',
  players: new Map(), // id → { id, name, avatar, ready, host, color, online }
  myReady: false,
  settings: { ...DEFAULT_SETTINGS },
  view: 'home',
  game: null,
  chat: [],
  hostLocked: false,
  solo: false,  // 單人訓練模式：沒有對手、不連線、不計勝負
  daily: null,  // 正在玩每日挑戰時：{ key, no, start, target, first }
};

// 房主用：斷線玩家的保留計時、聊天與表情的頻率限制
const graceTimers = new Map();
const lastSpeak = new Map();
let hostGiveUpTimer = null;
let myUid = '';  // 自己的登入帳號 id（記在對局紀錄裡，給後台的玩家檔案用）

// ---------- 小工具 ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無痕模式等情況 */ } },
};

// 這個分頁的連線身分，重新整理後用來自動回到房間
const session = {
  load() { try { return JSON.parse(sessionStorage.getItem('wikirace-session') || 'null'); } catch { return null; } },
  save(v) { try { sessionStorage.setItem('wikirace-session', JSON.stringify(v)); } catch { /* 忽略 */ } },
  clear() { try { sessionStorage.removeItem('wikirace-session'); } catch { /* 忽略 */ } },
};

// 房主：記下自己開的房間（存在這支手機）。不小心關掉 App、重新整理、手機把網頁收掉時，
// 其他人還在房間裡等，房主回來（重新整理、點邀請連結、輸入代碼）就能接回同一個房間繼續當房主。
const HOSTED_KEY = 'wikirace-hosted';
const HOSTED_TTL = 30 * 60e3;   // 超過這麼久沒回來就不接了
const HOSTED_RACE_TTL = 120e3;  // 比賽中斷線：太久才回來，那一局就不接了（其他人已經當作房主離開）
const hosted = {
  load(code) {
    try {
      const v = JSON.parse(localStorage.getItem(HOSTED_KEY) || 'null');
      if (!v || typeof v.code !== 'string' || v.code !== String(code || '').toUpperCase() || !(Date.now() - v.at < HOSTED_TTL) || !Array.isArray(v.players)) return null;
      return v;
    } catch { return null; }
  },
  save(v) { try { localStorage.setItem(HOSTED_KEY, JSON.stringify(v)); } catch { /* 忽略 */ } },
  clear() { try { localStorage.removeItem(HOSTED_KEY); } catch { /* 忽略 */ } },
};

// 玩家：記下自己在哪個房間用哪個身分（存在這支手機）。不小心關掉 App 再用連結或代碼回來，
// 會回到原本的位子，不會被當成新的人（1 對 1 會被擋成房間已滿、派對會多出一個自己）
const GUEST_KEY = 'wikirace-guest';
const TAB_ID = Math.random().toString(36).slice(2, 10);
// 同一支手機開兩個分頁各當一個玩家時，別拿到同一個身分互相擠掉：還開著的分頁每 2 秒報一次平安
const guestMem = {
  all() { try { const v = JSON.parse(localStorage.getItem(GUEST_KEY) || '[]'); return Array.isArray(v) ? v.filter((e) => e && Date.now() - e.at < 6 * 3600e3) : []; } catch { return []; } },
  write(list) { try { localStorage.setItem(GUEST_KEY, JSON.stringify(list.slice(-6))); } catch { /* 忽略 */ } },
  load(code) {
    code = String(code || '').toUpperCase();
    const e = this.all().reverse().find((x) => x.code === code && cleanKey(x.key) && (x.tab === TAB_ID || !(Date.now() - x.alive < 7000)));
    return e ? e.key : null;
  },
  save(code, key, alive = Date.now()) {
    const list = this.all().filter((x) => !(x.code === code && x.key === key));
    list.push({ code, key, tab: TAB_ID, at: Date.now(), alive });
    this.write(list);
  },
};
setInterval(() => { if (net.code && !net.isHost && state.myKey && state.view !== 'home') guestMem.save(net.code, state.myKey); }, 2000);
window.addEventListener('pagehide', () => { if (net.code && !net.isHost && state.myKey) guestMem.save(net.code, state.myKey, 0); });

// 「上一頁」要回去的堆疊存在這個分頁裡：重新整理後照原本的樣子接回來。
// 不能用走過的路線（path）去推：按上一頁回到的條目也會記進路線，推出來會回錯地方。
const NAV_KEY = 'wikirace-nav';
function saveNav(g) {
  try { sessionStorage.setItem(NAV_KEY, JSON.stringify({ id: g.id, cur: g.current, stack: g.stack, spots: g.spots })); } catch { /* 忽略 */ }
}
// cur：存的時候所在的條目。跟房主那邊記的目前位置對不上（例如斷線時又點了幾下才重新整理）就不用，改用路線推回去
function loadNav(id, cur, path) {
  try {
    const v = JSON.parse(sessionStorage.getItem(NAV_KEY) || 'null');
    if (!v || v.id !== id || v.cur !== cur || !Array.isArray(v.stack) || !v.stack.every((t) => typeof t === 'string' && path.includes(t))) return null;
    const spots = Array.isArray(v.spots) && v.spots.length === v.stack.length ? v.spots : v.stack.map(() => null);
    return { stack: v.stack.slice(-200), spots: spots.slice(-200) };
  } catch { return null; }
}

const randomKey = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
// 這支手機的代號：被踢出的人換個身分重新輸入代碼也進不來
const deviceId = (() => {
  let d = null;
  try { d = localStorage.getItem('wikirace-device'); } catch { /* 忽略 */ }
  if (!d || !/^[a-z0-9]{6,20}$/.test(d)) { d = randomKey(); try { localStorage.setItem('wikirace-device', d); } catch { /* 忽略 */ } }
  return d;
})();

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function showError(sel, msg) {
  const el = $(sel);
  el.textContent = msg || '';
  el.hidden = !msg;
}

// 後台「在線玩家」：這個人現在在做什麼（不含正在看哪個條目）
function reportActivity() {
  const g = state.game;
  const v = state.view;
  const a = { n: (state.myName || $('#nickname')?.value.trim() || '').slice(0, 16), av: state.myAvatar || '', s: 'home' };
  const race = (g && v !== 'home' && v !== 'room') ? { st: tw(g.settings.start).slice(0, 100), tg: tw(g.settings.target).slice(0, 100), k: g.finished?.clicks ?? g.clicks ?? 0, ok: g.finished?.reason === 'win' } : null;
  if (state.daily && race) Object.assign(a, { s: 'daily', d: state.daily.no || 0, done: !!g.finished }, race);
  else if (state.solo && race) Object.assign(a, { s: 'solo', g: cleanGoal(g.settings.goal), done: !!g.finished }, race);
  else if (net.code && v !== 'home') {
    Object.assign(a, { s: v, r: net.code, h: !!net.isHost, m: state.mode, g: cleanGoal(state.settings.goal) });
    if (race) Object.assign(a, race, { done: !!g.finished });
  }
  // 在多人房間、比賽、觀戰時一直連著 Firebase（房主要收新玩家、斷線要能換房主）；其他時候用到才連（見 fb.js）
  need('room', !!net.code && v !== 'home');
  setActivity(a);
  pushAdminLive();
}

setInterval(() => reportActivity(), 10000);
let nameReportTimer;
document.addEventListener('input', (e) => { if (e.target?.id === 'nickname') { clearTimeout(nameReportTimer); nameReportTimer = setTimeout(reportActivity, 800); } });  // 暱稱、房主身分等零碎變動，定期補報（內容沒變不會重寫）

function show(view) {
  state.view = view;
  setTimeout(reportActivity, 0);
  for (const v of ['home', 'room', 'game', 'result', 'watch']) $(`#view-${v}`).hidden = v !== view;
  $('.masthead').hidden = view === 'game' || view === 'watch';
  const fabOn = !state.solo && (view === 'room' || view === 'result' || view === 'watch');
  $('#emote-fab').hidden = !fabOn;
  document.body.classList.toggle('has-fab', fabOn);  // 有浮動表情鈕時，聊天室底下留空間，送出鈕才不會被壓到
  document.body.classList.toggle('solo', state.solo);  // 單人訓練：隱藏對手欄、聊天室等多人元素
  renderAnnounce();
  if (view !== 'watch') { stopWatchTimer(); $('#btn-follow').hidden = true; }
  if (view !== 'room' && view !== 'game') closePick(null);
  if (view !== 'game') closeHint();
  $('#item-dock').hidden = !(view === 'game' && isItems() && !state.game?.finished);
  closeEmotes();
  if (view === 'home' || view === 'room') music.play('lobby');
  if (view === 'home') renderNewbieHome();
  if (view !== 'game') clearNewbie();
  if (view === 'home') { renderStats(); renderHistory(); refreshDailyHome(); }
  if (view === 'room' || view === 'result') renderChat();
  window.scrollTo(0, 0);
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function setConn(text, ok) {
  const el = $('#conn-status');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function netBanner(text) {
  const el = $('#net-banner');
  el.hidden = !text;
  el.textContent = text || '';
}

// 頭像顯示名字的第一個字
function initial(name) {
  const ch = Array.from((name || '').trim())[0];
  return ch ? ch.toUpperCase() : '?';
}

// 有選頭像就顯示圖，沒有就顯示名字的第一個字
function paintAvatar(el, p) {
  el.replaceChildren();
  const id = p?.avatar;
  if (id && AVATAR_IDS.has(id)) {
    const img = new Image();
    img.src = `avatars/${id}.svg`;
    img.alt = '';
    img.decoding = 'async';
    el.append(img);
    el.classList.add('has-img');
  } else {
    el.textContent = initial(p?.name);
    el.classList.remove('has-img');
  }
}

function avatarEl(p, cls = '') {
  const a = document.createElement('span');
  a.className = `avatar ${cls}`;
  paintAvatar(a, p);
  if (p?.color) a.style.setProperty('--side', p.color);
  return a;
}

const cleanAvatar = (id) => (AVATAR_IDS.has(id) ? id : null);
const cleanKey = (k) => (typeof k === 'string' && /^[a-z0-9]{6,20}$/.test(k) ? k : null);
// 玩家的 key 是私密的，只有自己（存在這個分頁）和房主看得到；大家看到的是用 SHA-256 從 key 算出來的公開 id。
// 名單、聊天、進度裡只會出現公開 id，看到了也推不回 key，所以沒辦法拿別人的 id 冒充他「重新連線」把他擠掉。
async function publicId(key) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`wikirace-player:${key}`));
    return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return key;  // 不支援 crypto.subtle 的舊瀏覽器（只有非 https 才會）：退回舊做法
  }
}

function fillPath(ol, path, target) {
  ol.replaceChildren(...path.map((t) => {
    const li = document.createElement('li');
    li.textContent = tw(t);
    if (t === target) li.classList.add('hit');
    return li;
  }));
}

const isParty = () => state.mode === 'party';
const hostId = () => [...state.players.values()].find((p) => p.host)?.id || 'host';
// 比步數：抵達終點不會直接結束對手的比賽，最後比誰的步數少（一樣多再比用時）
// 玩法：比速度或比步數，兩種都可以加道具。存成一個值：speed、steps、items（比速度＋道具，舊的「道具賽」）、isteps（比步數＋道具）
const goalSteps = (goal) => goal === 'steps' || goal === 'isteps';
const goalItems = (goal) => goal === 'items' || goal === 'isteps';
const isRush = (g = state.game) => g?.settings.goal === 'rush';
const makeGoal = (steps, items) => (items ? (steps ? 'isteps' : 'items') : (steps ? 'steps' : 'speed'));
const isSteps = (g = state.game) => goalSteps(g?.settings.goal);
const isItems = (g = state.game) => goalItems(g?.settings.goal);
const GOALS = {
  speed: { icon: '⚡', name: '比速度', brief: '先抵達的贏' },
  steps: { icon: '👣', name: '比步數', brief: '步數最少的贏' },
  items: { icon: '🎁', name: '道具賽・比速度', brief: '先抵達的贏；每 40 秒發一個道具，落後的人拿到比較強的' },
  isteps: { icon: '🎁', name: '道具賽・比步數', brief: '步數最少的贏；每走 3 步發一個道具，落後的人拿到比較強的' },
  rush: { icon: '🏃', name: '搶分賽', brief: '時間內抵達一題 +1 分，馬上換下一題；大家的題目順序一樣，每人可以跳過 2 題；同分比總步數少的贏' },
};
// 搶分賽的難度：終點是從起點沿著連結隨機走幾步走到的（困難＝完全隨機的兩個條目）
const RUSH_LEVELS = {
  easy: { name: '簡單', hops: 2, desc: '終點離起點大約 2 步' },
  normal: { name: '普通', hops: 3, desc: '終點離起點大約 3 步' },
  hard: { name: '困難', hops: 0, desc: '完全隨機的兩個條目，跟一般對局一樣' },
};
const RUSH_SKIPS = 2;
const goalText = (goal) => { const g = GOALS[cleanGoal(goal)]; return `${g.icon} ${g.name}`; };
// 畫面上的顏色：有道具用道具的粉紅色，其他照比速度／比步數
const goalClass = (goal) => (goalItems(goal) ? 'items' : goalSteps(goal) ? 'steps' : 'speed');
let notifiedStart = null;  // 已經通知過「開始比賽」的房間代碼
const cleanGoal = (g) => (GOALS[g] ? g : 'speed');
const opponents = () => [...state.players.values()].filter((p) => p.id !== state.myId);
const nameOf = (id) => state.players.get(id)?.name || state.game?.others.get(id)?.name || '玩家';
const personOf = (id) => {
  if (id === state.myId) return { id, name: state.myName, avatar: state.myAvatar, color: state.players.get(id)?.color };
  return state.players.get(id) || state.game?.others.get(id) || { id, name: '玩家' };
};

// ---------- 音效、音樂、觸覺 ----------
function initSound() {
  const paint = () => {
    $('#btn-sound').classList.toggle('off', !isSfxOn());
    for (const b of [$('#btn-music'), $('#btn-music-game')]) b.classList.toggle('off', !isMusicOn());
  };
  paint();
  $('#btn-sound').onclick = () => { setSfxOn(!isSfxOn()); paint(); };
  const toggleMusic = () => { setMusicOn(!isMusicOn()); paint(); toast(isMusicOn() ? '背景音樂：開' : '背景音樂：關', 1200); };
  // 比賽中只切換開關；其他畫面打開音樂設定
  $('#btn-music').onclick = () => openMusicSettings(paint);
  $('#btn-music-game').onclick = toggleMusic;
  // 瀏覽器要求使用者先操作過才能出聲
  for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, { passive: true });
  // 手機瀏覽器不讓網站一打開就出聲，所以先顯示「點一下開始」，那一下就讓音樂響起；
  // 瀏覽器允許自動播放的話，音樂一開始就把這個畫面收起來
  const splash = $('#splash');
  const closeSplash = () => {
    if (splash.hidden || splash.classList.contains('out')) return;
    splash.classList.add('out');
    setTimeout(() => { splash.hidden = true; }, 350);
  };
  if (isMusicOn()) splash.hidden = false;
  // 用 click 而不是 touchend 收起，避免同一下點擊穿透到底下的按鈕
  splash.addEventListener('click', closeSplash);
  document.addEventListener('music-playing', closeSplash);
  // 每次點擊按鈕、選項都給一下觸覺與聲音回饋
  const soundTarget = (t) => {
    if (t.closest('.article, [data-haptic], [data-nosfx]')) return null;
    const el = t.closest('button, a, label, input, select, summary, [role=button], .splash, .coach');
    if (!el || el.disabled || (el.matches('input') && el.type !== 'checkbox' && el.type !== 'radio')) return null;
    return el;
  };
  // 按鍵聲在手指一按下就播（像手機鍵盤），不用等放開；放開時的 click 就不再重播
  let pressed = null;
  let pressedAt = 0;
  document.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.button > 0 || !canClickNow()) return;
    const el = soundTarget(e.target);
    if (!el) return;
    pressed = el;
    pressedAt = performance.now();
    sfx.tap();
  }, true);
  document.addEventListener('pointercancel', () => { pressed = null; }, true);
  document.addEventListener('click', (e) => {
    // 只回應真人的點擊；程式觸發的點擊（例如 iPhone 震動用的隱藏開關）一律略過，否則會無限循環
    if (!e.isTrusted || e.target.closest('[data-haptic]')) return;
    // 點到 label 時瀏覽器會再對裡面的 input 送一次 click，略過那一次免得響兩聲
    if (e.target.matches('input') && e.target.closest('label') && e.detail === 0) return;
    if (e.target.closest('.article')) {
      const a = e.target.closest('a');
      if (a) haptic(a.dataset.title ? 'medium' : 'light');
      return;
    }
    const el = soundTarget(e.target);
    if (!el) return;
    haptic('light');
    const already = pressed && (pressed === el || pressed.contains(el) || el.contains(pressed)) && performance.now() - pressedAt < 2000;
    pressed = null;
    if (!already) sfx.tap();
  }, true);
}

const DYK = [
  '在英文維基百科，從大部分條目開始一直點擊內文的第一個連結，最後常常會走到「哲學」條目？',
  '維基百科在 2001 年 1 月 15 日上線，中文維基百科則在同年 5 月建立？',
  '「六度分隔理論」認為，世界上任意兩個人之間平均只隔著大約六個人？',
  '高手常把「國家」、「城市」、「年份」這類連結特別多的條目當作轉運站？',
  '這種比賽在英文圈叫做 Wikiracing，也有人叫它 Wiki Game？',
  '條目最上方的資訊框（Infobox）常常藏著通往國家、首都和人物的捷徑？',
  '條目最下方的導航框（Navbox）收錄同類主題，是跳到相關條目的好地方？',
  '「上一頁」也算一步，走錯路時要想清楚是回頭還是繼續往前？',
  '派對模式可以設定「最後衝刺」：第一個人抵達後，其他人只剩一點時間？',
  '比賽中不小心斷線也別慌，60 秒內連回來就能接著原本的進度？',
];

// ---------- 音樂設定 ----------
let musicPaint = () => {};
async function renderMusicOpts() {
  for (const box of $$('.music-opts')) {
    const slot = box.dataset.slot;
    const rec = await getCustomMusic(slot);
    const cur = getMusicChoice(slot);
    box.replaceChildren(...Object.entries(MUSIC_CHOICES).map(([id, c]) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: `music-opt${id === 'custom' ? ' custom' : ''}` });
      b.classList.toggle('on', cur === id);
      if (id === 'custom') {
        const info = document.createElement('span');
        info.append(Object.assign(document.createElement('b'), { textContent: '🎧 我的音樂' }), Object.assign(document.createElement('small'), { textContent: rec?.name || '還沒選檔案，點一下選擇' }));
        b.append(info);
        if (rec) {
          const swap = Object.assign(document.createElement('span'), { className: 'swap', textContent: '換檔案' });
          swap.onclick = (e) => { e.stopPropagation(); pickMusicFile(slot); };
          b.append(swap);
        }
        b.onclick = () => (rec ? chooseMusic(slot, id) : pickMusicFile(slot));
      } else {
        const isDefault = id === DEFAULT_CHOICE[slot];
        b.append(Object.assign(document.createElement('b'), { textContent: c.name }), Object.assign(document.createElement('small'), { textContent: isDefault ? '預設' : '內建' }));
        b.onclick = () => chooseMusic(slot, id);
      }
      return b;
    }));
  }
}

async function chooseMusic(slot, id) {
  await setMusicChoice(slot, id);
  if (!isMusicOn()) { setMusicOn(true); $('#mus-on').checked = true; musicPaint(); }
  music.preview(slot);
  renderMusicOpts();
}

let musicFileSlot = 'lobby';
function pickMusicFile(slot) {
  musicFileSlot = slot;
  $('#music-file').value = '';
  $('#music-file').click();
}

// 點擊音效：選了就馬上聽一次
function renderClickOpts() {
  $('#click-opts').replaceChildren(...Object.entries(CLICK_SOUNDS).map(([id, c]) => {
    const label = document.createElement('label');
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'clickSound', value: id, checked: getClickSound() === id });
    // 用 click：已經選到的那個再點一次也能試聽
    input.onclick = () => {
      setClickSound(id);
      if (!isSfxOn()) { setSfxOn(true); $('#sfx-on').checked = true; musicPaint(); }
      sfx.tap();
    };
    label.append(input, Object.assign(document.createElement('span'), { textContent: c.name }));
    return label;
  }));
}

function openMusicSettings(paint) {
  musicPaint = paint;
  $('#mus-on').checked = isMusicOn();
  $('#sfx-on').checked = isSfxOn();
  renderMusicOpts();
  renderClickOpts();
  $('#music-modal').hidden = false;
}

function initMusicSettings() {
  $('#music-close').onclick = () => { $('#music-modal').hidden = true; };
  $('#music-modal').addEventListener('click', (e) => { if (e.target.id === 'music-modal') $('#music-modal').hidden = true; });
  $('#mus-on').onchange = () => { setMusicOn($('#mus-on').checked); musicPaint(); };
  $('#sfx-on').onchange = () => { setSfxOn($('#sfx-on').checked); musicPaint(); };
  $('#music-file').onchange = async () => {
    const f = $('#music-file').files[0];
    if (!f) return;
    if (!f.type.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name)) { toast('請選擇音樂檔'); return; }
    if (f.size > 40 * 1024 * 1024) { toast('檔案太大了（最多 40MB）'); return; }
    try {
      await saveCustomMusic(musicFileSlot, f);
      toast(`已設定「${f.name}」為${musicFileSlot === 'lobby' ? '大廳' : '比賽'}音樂`, 2500);
      if (!isMusicOn()) { setMusicOn(true); $('#mus-on').checked = true; musicPaint(); }
      music.preview(musicFileSlot);
    } catch (e) {
      toast(`沒辦法儲存音樂檔（${e.message || e}）`);
    }
    renderMusicOpts();
  };
}

// ---------- 全站公告（製作者從後台發） ----------
let announceId = '';
let announceOn = false;  // 有公告、而且這位玩家還沒按 ✕ 關掉
let announcePeek = null;
const racingView = () => state.view === 'game' || state.view === 'watch';
// 比賽中公告會蓋住上方的時間和步數：新公告只亮 8 秒就收起來，回大廳或結算畫面再顯示
function renderAnnounce(fresh = false) {
  const stopPeek = () => { clearTimeout(announcePeek); announcePeek = null; };
  if (!announceOn) { stopPeek(); $('#announce').hidden = true; return; }
  if (!racingView()) { stopPeek(); $('#announce').hidden = false; return; }
  if (fresh) {
    stopPeek();
    $('#announce').hidden = false;
    announcePeek = setTimeout(() => { announcePeek = null; if (racingView()) $('#announce').hidden = true; }, 8000);
    return;
  }
  if (!announcePeek) $('#announce').hidden = true;  // 正在亮的 8 秒就讓它亮完
}
let announceTimer = null;
function initAnnounce() {
  $('#announce-close').onclick = () => { store.set('wikirace-bcast', announceId); announceOn = false; renderAnnounce(); };
  watchBroadcast(applyBroadcast);
}
// 公告可以排程：showAt 之前先不顯示、until 之後自動收起來（時間到再檢查一次）
function applyBroadcast(b) {
  clearTimeout(announceTimer);
  const now = Date.now();
  const showAt = Number(b?.showAt) || 0;
  const until = Number(b?.until) || 0;
  let live = !!(b && b.text) && (!until || until > now);
  const next = live && showAt > now ? showAt : live && until ? until : 0;
  if (live && showAt > now) live = false;
  if (next) announceTimer = setTimeout(() => applyBroadcast(b), Math.min(next - now + 200, 2 ** 31 - 1));
  // 重新連線時 Firebase 會再送一次同一則公告，只有換了新公告才算「新」的（比賽中才會再亮）
  const id = live ? String(b.id || b.at || b.text) : '';
  const fresh = !!id && id !== announceId;
  announceId = id;
  announceOn = !!id && id !== store.get('wikirace-bcast');
  if (id) $('#announce-text').textContent = String(b.text).slice(0, 200);
  renderAnnounce(fresh);
}

// ---------- 戰績（存在這支手機上，比速度和比步數各自分開記） ----------
const statsKey = (goal) => (goal === 'steps' || goal === 'items' || goal === 'isteps' || goal === 'rush' ? `wikirace-stats-${goal}` : 'wikirace-stats');

function loadStats(goal) {
  try { return { w: 0, l: 0, d: 0, streak: 0, ...JSON.parse(store.get(statsKey(goal)) || '{}') }; } catch { return { w: 0, l: 0, d: 0, streak: 0 }; }
}

function recordResult(goal, res) {
  const st = loadStats(goal);
  if (res === 'win') { st.w++; st.streak++; } else if (res === 'lose') { st.l++; st.streak = 0; } else { st.d++; }
  store.set(statsKey(goal), JSON.stringify(st));
  saveProfile({ goal: cleanGoal(goal), stat: st });  // 登入的話也存到雲端
}

function unrecordResult(goal, res) {
  const st = loadStats(goal);
  if (res === 'win') { st.w = Math.max(0, st.w - 1); st.streak = Math.max(0, st.streak - 1); } else if (res === 'lose') st.l = Math.max(0, st.l - 1); else st.d = Math.max(0, st.d - 1);
  store.set(statsKey(goal), JSON.stringify(st));
  saveProfile({ goal: cleanGoal(goal), stat: st });
}

// 首頁顯示目前選到的模式的戰績
function renderStats() {
  const goal = selectedGoal();
  const st = loadStats(goal);
  const total = st.w + st.l + st.d;
  $('#stats-label').textContent = `${GOALS[goal].icon} ${GOALS[goal].name}戰績`;
  $('#stats-label').classList.toggle('steps', goalClass(goal) === 'steps');
  $('#stats-label').classList.toggle('items', goalClass(goal) === 'items');
  $('#stat-w').textContent = st.w;
  $('#stat-l').textContent = st.l;
  $('#stat-rate').textContent = total ? `${Math.round((st.w / total) * 100)}%` : '–';
  $('#stat-streak').textContent = st.streak;
}

// ---------- 最近對戰（最多記 20 場） ----------
function loadHistory() {
  try { const h = JSON.parse(store.get('wikirace-history') || '[]'); return Array.isArray(h) ? h : []; } catch { return []; }
}

// 一局結束時記一筆；同一局的結果被更正時就更新那一筆
function saveHistory(g, info) {
  const list = loadHistory().filter((h) => h.id !== g.id);
  const me = g.finished;
  const opps = [...g.others.values()].map((o) => o.name);
  const mine = info.entries?.find((e) => e.me);
  list.unshift({
    id: g.id, at: Date.now(), goal: cleanGoal(g.settings.goal), mode: g.mode, res: info.res,
    place: mine?.place || null, total: info.entries?.length || 2,
    start: tw(g.settings.start), target: tw(g.settings.target), clicks: me.clicks, ms: me.elapsed, reason: me.reason,
    opp: opps.slice(0, 3).join('、') + (opps.length > 3 ? ` 等 ${opps.length} 人` : ''),
  });
  store.set('wikirace-history', JSON.stringify(list.slice(0, 20)));
}

let historyAll = false;
function renderHistory() {
  const list = loadHistory();
  const shown = historyAll ? list : list.slice(0, 5);
  $('#history-more').hidden = list.length <= 5;
  $('#history-more').textContent = historyAll ? '收起' : `看全部（${list.length}）`;
  if (!list.length) {
    $('#history').replaceChildren(Object.assign(document.createElement('p'), { className: 'history-empty', textContent: '還沒有對戰紀錄，開一間房間跟朋友比一場吧！' }));
    return;
  }
  $('#history').replaceChildren(...shown.map((h) => {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    const party = h.mode === 'party';
    badge.className = `h-badge ${h.res === 'win' ? 'win' : h.res === 'lose' && !(party && h.place) ? 'lose' : ''}`;
    badge.textContent = party ? (h.place ? `#${h.place}` : '–') : ({ win: '勝', lose: '敗', draw: '和' }[h.res] || '–');
    const body = document.createElement('div');
    body.className = 'h-body';
    const d = new Date(h.at);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const how = h.reason === 'win' ? `${h.clicks} 步 · ${fmtTime(h.ms)}` : resultLabel({ reason: h.reason });
    body.append(
      Object.assign(document.createElement('span'), { className: 'h-route', textContent: `${h.start} → ${h.target}` }),
      Object.assign(document.createElement('span'), { className: 'h-meta', textContent: `${GOALS[h.goal]?.icon || ''} ${party ? '派對' : '1對1'} · ${how} · vs ${h.opp || '—'} · ${when}` }),
    );
    li.append(badge, body);
    return li;
  }));
}

// ---------- 首頁 ----------
function selectedGoal() {
  if (document.querySelector('input[name="goalHome"]:checked')?.value === 'rush') return 'rush';
  return makeGoal(document.querySelector('input[name="goalHome"]:checked')?.value === 'steps', !!$('#goal-home-items')?.checked);
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'duel';
}

// 畫面上用來指「自己」的字，不能拿來當暱稱（不然線上名單一堆人叫「你」）
const RESERVED_NAMES = ['你', '我', '玩家', '自己'];
const reservedName = (n) => RESERVED_NAMES.includes(String(n || '').trim());


async function joinAsGuest(code, { auto = false } = {}) {
  showError('#home-error');
  setConn(auto ? '重新連線中…' : '連線中…');
  $('#btn-join').disabled = true;
  try {
    await net.joinRoom(code);
    if (hosted.load(code)) hosted.clear();  // 自己開的房間已經有別人接手：之後不用再接回來
    state.myKey ||= randomKey();
    session.save({ code: net.code, key: state.myKey, role: 'guest' });
    state.players = new Map();
    sendJoin();
    setConn('已連線', true);
    if (state.view === 'home') enterRoom(net.code);
  } catch (e) {
    // 找不到房間，但這個房間是自己開的（房主不小心關掉了，其他人還在等）：接回來繼續當房主
    const mine = hosted.load(code);
    if (mine) { $('#btn-join').disabled = false; await reclaimHost(mine); return; }
    if (auto) session.clear();
    showError('#home-error', auto ? `沒辦法回到剛才的房間（${e.message}）` : e.message);
    setConn('');
  } finally {
    $('#btn-join').disabled = false;
  }
}

function sendJoin() {
  if (net.code && state.myKey) guestMem.save(net.code, state.myKey);
  net.send({ t: 'join', name: state.myName, avatar: state.myAvatar, key: state.myKey, device: deviceId, gameId: state.game?.id || null, uid: myUid });
}

function initHome() {
  $('#dyk-text').textContent = DYK[Math.floor(Math.random() * DYK.length)];
  // 閒置時預先載入題庫並顯示數量
  setTimeout(() => {
    import('./topics.js?v=111').then((m) => { $('#topic-count').textContent = m.TOPICS.length.toLocaleString('en-US'); }).catch(() => {});
  }, 1200);
  $('#nickname').value = store.get('wikirace-name') || '';
  // 第一次來隨機給一個頭像，之後記住玩家的選擇
  state.myAvatar = cleanAvatar(store.get('wikirace-avatar')) || AVATARS[Math.floor(Math.random() * AVATARS.length)][0];
  store.set('wikirace-avatar', state.myAvatar);
  const paintHomeAvatar = () => paintAvatar($('#home-avatar'), { name: $('#nickname').value, avatar: state.myAvatar });
  const grid = $('#avatar-grid');
  grid.replaceChildren(...AVATARS.map(([id, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-opt';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', label);
    b.title = label;
    b.dataset.id = id;
    b.append(Object.assign(new Image(), { src: `avatars/${id}.svg`, alt: '' }));
    b.onclick = () => {
      state.myAvatar = id;
      store.set('wikirace-avatar', id);
      saveProfile({ a: id });
      paintPicker();
      paintHomeAvatar();
      toggleAvatarPick(false);
      const home = $('#home-avatar');
      home.classList.remove('pop');
      void home.offsetWidth;
      home.classList.add('pop');
    };
    return b;
  }));
  const paintPicker = () => grid.querySelectorAll('.avatar-opt').forEach((b) => {
    const on = b.dataset.id === state.myAvatar;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  paintPicker();
  paintHomeAvatar();
  $('#nickname').addEventListener('input', paintHomeAvatar);
  // 暱稱改好（離開輸入框）：登入的話存到雲端
  $('#nickname').addEventListener('change', () => { const n = $('#nickname').value.trim(); if (n && !badName(n)) saveProfile({ n }); });
  // 頭像選單平常收起來，點自己的頭像才打開，首頁比較短
  const toggleAvatarPick = (open = $('#avatar-pick').hidden) => {
    $('#avatar-pick').hidden = !open;
    $('#home-avatar-btn').setAttribute('aria-expanded', String(open));
  };
  $('#home-avatar-btn').onclick = () => toggleAvatarPick();
  $('#history-more').onclick = () => { historyAll = !historyAll; renderHistory(); };
  renderHistory();

  const savedMode = store.get('wikirace-mode');
  if (savedMode === 'party') document.querySelector('input[name="mode"][value="party"]').checked = true;
  const savedGoal = store.get('wikirace-goal');
  if (savedGoal && GOALS[savedGoal]) {
    document.querySelector(`input[name="goalHome"][value="${savedGoal === 'rush' ? 'rush' : goalSteps(savedGoal) ? 'steps' : 'speed'}"]`).checked = true;
    $('#goal-home-items').checked = goalItems(savedGoal);
  }
  renderStats();
  const paintMode = () => {
    const goal = selectedGoal();
    const name = goal === 'rush' ? '搶分賽' : `${goalSteps(goal) ? '比步數' : '比速度'}${goalItems(goal) ? '道具' : ''}`;
    $('.goal-home').classList.toggle('is-rush', goal === 'rush');
    $('#btn-create').textContent = `建立${name}${selectedMode() === 'party' ? '派對' : '對決'}房間`;
  };
  paintMode();
  document.querySelectorAll('input[name="mode"], input[name="goalHome"], #goal-home-items').forEach((r) => r.addEventListener('change', () => {
    store.set('wikirace-mode', selectedMode());
    store.set('wikirace-goal', selectedGoal());
    paintMode();
    renderStats();
  }));

  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    $('#join-code').value = room.toUpperCase();
    ($('#nickname').value ? $('#btn-join') : $('#nickname')).focus();
  }

  $('#btn-create').onclick = async () => {
    const name = await askName();  // 沒有暱稱：跳出視窗先取一個
    if (!name) return;
    showError('#home-error');
    state.myName = name;
    state.mode = selectedMode();
    state.settings = { ...state.settings, goal: selectedGoal() };
    $('#btn-create').disabled = true;
    setConn('建立中…');
    try {
      const code = await net.createRoom();
      state.myId = 'host';
      state.chat = [];
      state.roomScore = { games: 0, wins: {} };
      state.banned = new Set();
      state.players = new Map([['host', { id: 'host', name, avatar: state.myAvatar, ready: true, host: true, color: COLORS[0], online: true }]]);
      session.save({ code, role: 'host' });
      setConn(isParty() ? '等待玩家' : '等待對手');
      enterRoom(code);
      sysChat(`${name} 建立了房間`);
      notify('room', '有人開了房間', `${isParty() ? '派對（2–8 人）' : '1 對 1'} · ${goalText(state.settings.goal)}`);
    } catch (e) {
      showError('#home-error', e.message);
      setConn('');
    } finally {
      $('#btn-create').disabled = false;
    }
  };

  const join = async () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (!code) { showError('#home-error', '請輸入房間代碼'); return; }
    const name = await askName();  // 沒有暱稱：跳出視窗先取一個
    if (!name) return;
    state.myName = name;
    state.myKey = guestMem.load(code) || randomKey();
    joinAsGuest(code);
  };
  $('#btn-join').onclick = join;
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  // 重新整理後自動回到剛才的房間
  const sess = session.load();
  const mine = sess?.role === 'host' && hosted.load(sess.code);
  if (mine) {
    // 先試著當玩家連回去：如果房間已經被其他人接手了，就加入他們；沒人在才接回自己的房間（見 joinAsGuest）
    $('#join-code').value = mine.code;
    state.myName = String(mine.name || $('#nickname').value.trim() || '玩家').slice(0, 16);
    state.myKey = randomKey();
    joinAsGuest(mine.code, { auto: true });
  } else if (sess?.role === 'guest' && sess.code && cleanKey(sess.key) && $('#nickname').value.trim()) {
    state.myName = $('#nickname').value.trim();
    state.myKey = sess.key;
    $('#join-code').value = sess.code;
    joinAsGuest(sess.code, { auto: true });
  }
}

// ---------- 房間 ----------
const form = () => $('#settings-form');

function readForm() {
  const f = form().elements;
  return {
    lang: f.lang.value,
    goal: f.roomGoal.value === 'rush' ? 'rush' : makeGoal(f.roomGoal.value === 'steps', f.roomItems.checked),
    timeLimit: Number(f.timeLimit.value),
    // 派對模式：第一個人抵達後，其他人剩這麼多秒（0＝不限）
    lastCall: Number(f.lastCall.value) || 0,
    start: f.start.value.trim(),
    target: f.target.value.trim(),
    oppView: ['dist', 'hint', 'full'].includes(f.oppView.value) ? f.oppView.value : 'hint',
    allowBack: f.allowBack.checked,
    trueRandom: f.trueRandom.checked,
    allowFind: f.allowFind.checked,
    rushMin: [3, 5, 8, 10].includes(Number(f.rushMin.value)) ? Number(f.rushMin.value) : 5,
    rushLevel: RUSH_LEVELS[f.rushLevel.value] ? f.rushLevel.value : 'normal',
  };
}

// 「對手位置」三個選項各自的說明，跟著選到的那個換
const OPP_VIEW_DESC = {
  dist: '只看得到對手走了幾步、離終點多遠，看不到他在哪個條目',
  hint: '看得到對手所在條目的簡介，但名稱會遮起來，沒辦法照抄路線',
  full: '直接看得到對手在哪個條目，比較容易照著別人的路線走',
};
function paintOppViewDesc() {
  const v = form().elements.oppView.value;
  $('#opp-view-desc').textContent = OPP_VIEW_DESC[v] || OPP_VIEW_DESC.hint;
}

function writeForm(s) {
  const f = form().elements;
  f.lang.value = s.lang;
  f.roomGoal.value = s.goal === 'rush' ? 'rush' : goalSteps(s.goal) ? 'steps' : 'speed';
  f.rushMin.value = String(s.rushMin || 5);
  f.rushLevel.value = RUSH_LEVELS[s.rushLevel] ? s.rushLevel : 'normal';
  f.roomItems.checked = goalItems(s.goal);
  $('#set-items-desc').textContent = goalSteps(s.goal) ? '每走 3 步發一個，比步數用的道具' : '每 40 秒發一個，撿道具整對手';
  f.roomMode.value = isParty() ? 'party' : 'duel';
  f.timeLimit.value = String(s.timeLimit);
  f.lastCall.value = String(s.lastCall || 0);
  if (document.activeElement !== f.start) f.start.value = tw(s.start);
  if (document.activeElement !== f.target) f.target.value = tw(s.target);
  f.oppView.value = oppViewOf(s);
  paintOppViewDesc();
  f.allowBack.checked = s.allowBack;
  f.allowFind.checked = !!s.allowFind;
  f.trueRandom.checked = s.trueRandom;
  paintRoomGoal();
  paintFoldSummaries();
}

function playerTag(p) {
  if (p.online === false) return '斷線中…';
  if (p.host) return '房主';
  return p.ready ? '✓ 準備好了' : '準備中…';
}

function renderDuelSlots() {
  const host = state.players.get(hostId());
  const guest = [...state.players.values()].find((p) => !p.host);
  const iAmHost = net.isHost;
  paintAvatar($('#slot-host .avatar'), host);
  if (guest) paintAvatar($('#slot-guest .avatar'), guest);
  else { $('#slot-guest .avatar').replaceChildren('?'); $('#slot-guest .avatar').classList.remove('has-img'); }
  $('#slot-host .pname').textContent = host?.name || '—';
  $('#slot-host .pstate').textContent = host?.online === false ? '斷線中…' : '';
  $('#slot-guest .pname').textContent = guest ? guest.name : '等待對手加入…';
  $('#slot-guest .pstate').textContent = guest ? (guest.online === false ? '斷線中…' : guest.ready ? '✓ 已準備' : '尚未準備') : '';
  $('#slot-guest').classList.toggle('ready', !!guest?.ready && guest.online !== false);
  $('#slot-guest').classList.toggle('empty', !guest);
  $('#slot-guest').classList.toggle('offline', guest?.online === false);
  $('#slot-guest .kick-btn')?.remove();
  if (iAmHost && guest && !stillRacing(guest.id)) $('#slot-guest').append(kickButton(guest));
  $('#slot-host').classList.toggle('offline', host?.online === false);
  $('#slot-host').classList.toggle('is-me', iAmHost);
  $('#slot-guest').classList.toggle('is-me', !iAmHost);
  // 自己永遠是藍隊、對手永遠是紅隊
  $('#slot-host').classList.toggle('me-side', iAmHost);
  $('#slot-host').classList.toggle('opp-side', !iAmHost);
  $('#slot-guest').classList.toggle('me-side', !iAmHost);
  $('#slot-guest').classList.toggle('opp-side', iAmHost);
}

function renderPartyBoard() {
  const list = [...state.players.values()];
  const max = MAX_PLAYERS.party;
  $('#party-count').textContent = `${list.length} / ${max} 人`;
  const items = list.map((p) => {
    const li = document.createElement('li');
    li.className = 'party-player';
    li.classList.toggle('ready', (p.ready || p.host) && p.online !== false);
    li.classList.toggle('offline', p.online === false);
    li.classList.toggle('is-me', p.id === state.myId);
    li.append(avatarEl(p));
    const name = Object.assign(document.createElement('b'), { textContent: p.name });
    const tag = Object.assign(document.createElement('span'), { className: 'party-tag', textContent: playerTag(p) });
    li.append(name, tag);
    if (net.isHost && !p.host && !stillRacing(p.id)) li.append(kickButton(p));
    return li;
  });
  for (let i = list.length; i < max; i++) {
    const li = document.createElement('li');
    li.className = 'party-player empty';
    li.append(Object.assign(document.createElement('span'), { className: 'avatar', textContent: '+' }), Object.assign(document.createElement('b'), { textContent: '等待加入' }));
    items.push(li);
  }
  $('#party-grid').replaceChildren(...items);
}

// 房間設定收起來時，標題右邊顯示目前選了什麼
function paintFoldSummaries() {
  const st = state.settings;
  // 每一項是一個小標籤
  const sum = (key, items) => { const el = $(`#fold-${key}`); if (el) el.replaceChildren(...items.filter(Boolean).map((t) => Object.assign(document.createElement('span'), { textContent: t }))); };
  const rush = st.goal === 'rush';
  sum('route', [rush ? '🏃 搶分賽：題目自動出' : `${tw(st.start) || '隨機'} → ${tw(st.target) || '隨機'}`]);
  sum('goal', [goalText(st.goal), rush ? `${st.rushMin || 5} 分鐘 · ${(RUSH_LEVELS[st.rushLevel] || RUSH_LEVELS.normal).name}` : '', isParty() ? '🎉 派對 2–8 人' : '⚔️ 1 對 1']);
  const time = rush ? '' : Number(st.timeLimit) ? `⏱ ${Number(st.timeLimit) / 60} 分鐘` : '⏱ 不限時';
  const view = { dist: '👀 只看遠近', hint: '👀 模糊位置', full: '👀 完整條目' }[oppViewOf(st)];
  sum('rule', [st.lang === 'en' ? '🌐 English' : '🌐 中文', time, view, st.allowBack ? '↩️ 可上一頁' : '🚫 不能上一頁', st.allowFind ? '🔍 可找連結' : '', st.trueRandom ? '🔥 地獄模式' : '']);
}

function paintRoomGoal() {
  const goal = cleanGoal(state.settings.goal);
  $('#room-goal').textContent = `${GOALS[goal].icon} ${GOALS[goal].name} · ${isParty() ? '派對' : '1 對 1'}`;
  $('#room-goal').classList.toggle('steps', goalClass(goal) === 'steps');
  $('#room-goal').classList.toggle('items', goalClass(goal) === 'items');
  $('#room-items-help').hidden = !goalItems(goal);
  // 搶分賽：起點終點、時間限制、道具、最後衝刺都用不到，換成搶分時間和難度
  const rush = goal === 'rush';
  for (const id of ['#rush-desc', '#row-rush-min', '#row-rush-level']) $(id).hidden = !rush;
  $('#set-items').closest('.row').hidden = rush;
  $('#row-timelimit').hidden = rush;
  form().querySelector('details[data-fold="route"]').hidden = rush;
  $('#rush-level-desc').textContent = (RUSH_LEVELS[state.settings.rushLevel] || RUSH_LEVELS.normal).desc;
  $('#room-rush-help').hidden = !rush;
  // 第一次玩搶分賽：進房間時先看一次規則
  if (rush && state.view === 'room' && !store.get('wikirace-rush-guide') && $('#rush-modal').hidden && $('#items-modal').hidden && !state.rushGuideShown) {
    state.rushGuideShown = true;
    setTimeout(() => { if (state.view === 'room') $('#rush-modal').hidden = false; }, 400);
  }
  // 第一次玩道具賽：進房間時先看一次教學
  if (goalItems(goal) && state.view === 'room' && !store.get('wikirace-items-guide') && $('#items-modal').hidden && !state.itemsGuideShown) {
    state.itemsGuideShown = true;
    setTimeout(openItemsGuide, 400);
  }
}

function renderRoom() {
  const host = net.isHost;
  const party = isParty();
  paintRoomGoal();
  paintFoldSummaries();
  renderRoomScore();
  $('#row-lastcall').hidden = !party || isRush({ settings: state.settings });
  $('#btn-transfer').hidden = !(host && onlineGuests().length);
  $('#btn-change-goal').hidden = !host;
  form().classList.toggle('readonly', !host);  // 玩家：收合按鈕寫「查看」
  // 房主第一次進房間：「玩法」先展開，讓人知道可以在這裡換（之後照自己上次的開關）
  if (host && store.get('wikirace-fold-goal') === null) { const d = form().querySelector('details[data-fold="goal"]'); if (d && !d.open) d.open = true; }
  $('.versus').hidden = party;
  $('#party-board').hidden = !party;
  if (party) renderPartyBoard(); else renderDuelSlots();

  for (const el of form().elements) if (!el.matches('#btn-ready, #btn-start')) el.disabled = !host;
  $('#host-only-hint').hidden = host;

  const guests = opponents().filter((p) => !p.host);
  const allReady = guests.length > 0 && guests.every((p) => p.ready && p.online !== false);
  const ready = $('#btn-ready');
  ready.hidden = host;
  ready.textContent = state.myReady ? '已準備 ✓（再按一次取消）' : '準備';
  ready.classList.toggle('is-ready', state.myReady);
  $('#btn-start').hidden = !host;
  $('#btn-start').disabled = !allReady;

  const waiting = guests.filter((p) => !p.ready || p.online === false).length;
  let hint = '';
  if (host && !guests.length) hint = party ? '派對最多 8 人，把房間代碼或邀請連結傳給朋友吧！' : '把房間代碼或邀請連結傳給朋友吧！';
  else if (host && waiting) hint = party ? `還有 ${waiting} 人還沒準備…` : '等待對手按下「準備」…';
  else if (host) hint = party ? `${guests.length + 1} 人都準備好了，開始派對！` : '對手準備好了，按下開始！起點或終點留空會從題庫隨機抽。';
  else if (!state.myReady) hint = '確認路線後按「準備」';
  else hint = '等待房主開始比賽…';
  $('#room-hint').textContent = hint;
}

// 後台：房主把房間概況寫到 Firebase（只有房間層級資訊，沒有誰在哪個條目）。節流，不會太頻繁。
let roomSyncAt = 0;
let controlUnsub = null;
let controlCode = null;
let leavingRoom = false;  // 正在離開／關閉房間時，別讓晚到的訊息又把房間重新發布上去
// 房主：監聽後台對這個房間下的指令（關閉／踢人）
function ensureControlWatch() {
  if (!net.isHost || !net.code) return;
  if (controlCode === net.code) return;
  if (controlUnsub) controlUnsub();
  controlCode = net.code;
  controlUnsub = watchControl(net.code, onControlCmd);
}
function stopControlWatch() {
  if (controlUnsub) { controlUnsub(); controlUnsub = null; }
  controlCode = null;
}
function onControlCmd(cmd) {
  if (!net.isHost) return;
  if (cmd.type === 'close') {
    toast('房間已被管理員關閉', 3000);
    leaveRoom();
  } else if (cmd.type === 'kick' && cmd.name) {
    const pl = [...state.players.values()].find((x) => !x.host && x.name === cmd.name);
    if (pl) {
      state.banned.add(pl.id);
      if (state.devices.get(pl.id)) state.banned.add(state.devices.get(pl.id));
      net.kick(pl.id, { t: 'kicked' });
      pl.leaving = true;
      removePlayer(pl.id, { kicked: true });
    }
  }
}

function syncRoom(force = false) {
  if (leavingRoom) return;
  if (!net.isHost || !net.code) { stopControlWatch(); return; }
  ensureControlWatch();
  const now = performance.now();
  if (!force && now - roomSyncAt < 2500) return;
  roomSyncAt = now;
  saveHosted();
  const g = state.game;
  const inGame = (state.view === 'game' || state.view === 'result') && g;
  let players;
  if (inGame) {
    players = [{ name: state.myName, steps: g.finished?.clicks ?? g.clicks, dist: g.dist || 0, done: !!g.finished }];
    for (const o of g.others.values()) players.push({ name: o.name, steps: o.clicks, dist: o.dist || 0, done: !!o.finished, left: !!o.left });
  } else {
    players = [...state.players.values()].map((pl) => ({ name: pl.name, steps: 0, dist: 0, done: false, ready: !!(pl.host || pl.ready) }));
  }
  publishRoom(net.code, {
    code: net.code, host: state.myName, mode: state.mode,
    goal: cleanGoal(state.settings.goal), state: state.view,
    count: inGame ? players.length : state.players.size,
    players, games: state.roomScore.games,
    start: inGame ? tw(g.settings.start) : '',
    target: inGame ? tw(g.settings.target) : '',
    startedAt: inGame && g.startAt ? Date.now() - (performance.now() - g.startAt) : 0,
  });
}

// 房主：把房間的樣子存在這支手機，萬一房主不見了可以接回來（見 hosted）
function saveHosted() {
  if (leavingRoom || !net.isHost || !net.code || state.solo) return;
  const g = state.game;
  const racing = g && (state.view === 'game' || state.view === 'result' || state.view === 'watch');
  hosted.save({
    code: net.code, at: Date.now(), name: state.myName, avatar: state.myAvatar,
    mode: state.mode, settings: state.settings, players: [...state.players.values()],
    chat: state.chat.slice(-30), banned: [...state.banned], score: state.roomScore,
    started: notifiedStart === net.code, game: racing ? gameSnapshot() : null,
  });
  session.save({ code: net.code, role: 'host' });
}
setInterval(saveHosted, 20000);
window.addEventListener('pagehide', saveHosted);
// 每日挑戰：切到別的 App、關掉分頁的那一刻也記一次進度
window.addEventListener('pagehide', () => saveDailyRun());
document.addEventListener('visibilitychange', () => { if (document.hidden) saveDailyRun(); });

// 房主回來了：用同一個代碼重新開房，其他人會自動連回來
async function reclaimHost(rec) {
  net.destroy();  // 剛才試著當玩家連進去的連線先關掉，才能用房間代碼重新開房
  netBanner('正在回到你的房間…');
  setConn('連線中…');
  const away = Date.now() - rec.at;
  state.myId = 'host';
  state.myName = String(rec.name || state.myName || '房主').slice(0, 16);
  state.myAvatar = cleanAvatar(rec.avatar) || state.myAvatar;
  state.mode = rec.mode === 'party' ? 'party' : 'duel';
  state.settings = { ...DEFAULT_SETTINGS, ...rec.settings };
  state.chat = Array.isArray(rec.chat) ? rec.chat.slice(-CHAT_MAX) : [];
  state.banned = new Set(Array.isArray(rec.banned) ? rec.banned.filter((k) => typeof k === 'string') : []);
  state.roomScore = rec.score?.wins ? { games: Number(rec.score.games) || 0, wins: { ...rec.score.wins } } : { games: 0, wins: {} };
  if (rec.started) notifiedStart = rec.code;
  const snap = rec.game && rec.game.id && away < HOSTED_RACE_TTL ? rec.game : null;
  // 其他人先當作斷線中：連回來就恢復；轉移房主那種「重新連線」不用一一宣布
  state.players = new Map(rec.players.filter((p) => p && typeof p.id === 'string').map((p) => [p.id, {
    ...p, avatar: cleanAvatar(p.avatar), online: p.id === 'host', migrating: p.id !== 'host', ready: p.id === 'host' || (!snap && !!p.ready),
  }]));
  if (!state.players.has('host')) state.players.set('host', { id: 'host', name: state.myName, avatar: state.myAvatar, ready: true, host: true, color: COLORS[0], online: true });
  try {
    await net.createRoom(0, rec.code, 30);  // 舊的連線可能還要一下子才會被配對伺服器放掉
  } catch (e) {
    // 代碼一直被佔著：多半是其他玩家已經接手當房主了，改用玩家身分加入他們
    hosted.clear();
    session.clear();
    netBanner('');
    state.players = new Map();
    state.myKey = randomKey();
    state.myId = null;
    show('home');
    joinAsGuest(rec.code);
    return false;
  }
  for (const p of state.players.values()) {
    if (p.id === 'host') continue;
    graceTimers.set(p.id, setTimeout(() => removePlayer(p.id), snap ? GRACE_GAME : GRACE_MIGRATE));
  }
  netBanner('');
  if (snap) {
    // 比賽中不見的：接回同一局（時間照算，不能趁機暫停）
    snap.elapsed = (Number(snap.elapsed) || 0) + away;
    if (snap.lastCall > 0) snap.lastCall = Math.max(1, snap.lastCall - away);
    state.solo = false;
    state.daily = null;
    state.hostLocked = true;
    $('#room-code').textContent = net.code;
    snap.players = [...state.players.values()];  // 其他人先顯示斷線中，連回來才恢復
    resumeGame(snap);
    syncRoom(true);
  } else {
    state.game = null;
    enterRoom(net.code);
  }
  setConn(onlineGuests().length ? '已連線' : '等待玩家', true);
  sysChat(`${state.myName} 回來了`);
  toast('已回到你的房間', 2500);
  saveHosted();
  return true;
}

function enterRoom(code) {
  state.solo = false;  // 進到真的房間就不是單人訓練了
  state.daily = null;
  $('#room-code').textContent = code;
  if (net.isHost) state.hostLocked = false;
  writeForm(state.settings);
  showError('#room-error');
  show('room');
  renderRoom();
  syncRoom(true);
}

// 房主：把玩家名單和設定同步給所有人
function lobbyMsg() {
  return { t: 'lobby', mode: state.mode, players: [...state.players.values()], settings: state.settings, score: state.roomScore };
}

// 一局的冠軍記一勝（平手或沒人抵達就只算場數）
function scoreGame(g, info) {
  g.scored = true;
  let winners = [];
  if (g.mode === 'party') winners = info.entries.filter((e) => e.place === 1).map((e) => e.id);
  else if (info.res === 'win') winners = [state.myId];
  else if (info.res === 'lose') winners = [...g.others.keys()];
  const sc = state.roomScore;
  sc.games += 1;
  for (const id of winners) sc.wins[id] = (sc.wins[id] || 0) + 1;
  broadcastLobby();
}

// 記一筆對局統計（給後台算趨勢）。只存聚合用的小資料，不含路線、不含是誰。
function recordGameStats(g, info) {
  const all = [{ finished: g.finished, clicks: g.finished?.clicks ?? g.clicks }, ...[...g.others.values()].map((o) => ({ finished: o.finished, clicks: o.clicks }))];
  // 冠軍要照最終名次挑：「抵達終點」不等於第一名（房主排在最前面，但不一定最快、步數最少）
  let champ = null;
  if (g.mode === 'party') {
    const first = info.entries?.find((e) => e.place === 1);
    if (first) champ = { finished: first.finished, clicks: first.finished?.clicks ?? first.clicks };
  } else if (info.res === 'win' || info.res === 'draw') {
    champ = all[0];
  } else if (info.res === 'lose') {
    champ = all.find((p, i) => i > 0 && p.finished?.reason === 'win') || null;
  }
  const winner = champ?.finished?.reason === 'win' ? champ : null;
  const elapsed = Math.max(0, ...all.map((p) => p.finished?.elapsed || 0));
  // 搶分賽沒有「抵達終點」：有人拿到分數就算有結果；題目記第一題（後台看每題的路線）
  const rush = isRush(g);
  const rushWin = rush && (info.entries || []).some((e) => e.score > 0);
  const q0 = rush ? g.rushQ?.[0] : null;
  recordGame({
    mode: g.mode, goal: cleanGoal(g.settings.goal), players: all.length, round: state.roomScore.games,
    start: tw(q0?.s || g.settings.start), target: tw(q0?.t || g.settings.target),
    win: rush ? rushWin : !!winner, durationMs: rush ? elapsed : (winner?.finished?.elapsed || elapsed), steps: rush ? null : (winner ? winner.clicks : null),
    ...gameExtra(g),
  });
}

// 每個人的戰績＋帳號 id（給後台的玩家檔案）、語言、有沒有開提示
function gameExtra(g) {
  const list = gameRoster(g);
  const us = ranking(g).slice(0, 8).map((e) => String((e.me ? myUid : state.players.get(e.id)?.uid) || '').slice(0, 128));
  return { list, us, lang: g.settings.lang === 'en' ? 'en' : 'zh', hint: !!g.hint?.shown, ...(isRush(g) ? rushExtra(g) : {}) };
}

// 搶分賽：每個人的分數（sc）和每一題的路線（rq，跟 list 同樣順序），給後台看
function rushExtra(g) {
  const es = ranking(g).slice(0, 8);
  return {
    sc: es.map((e) => Number(e.score) || 0),
    rq: es.map((e) => {
      const rows = (e.rr || []).map((x) => ({ s: tw(x.s), t: tw(x.t), r: x.r, p: x.p.slice(0, 60).map((t) => tw(t).slice(0, 100)) }));
      const q = g.rushQ?.[e.qi];
      if (q && e.path?.length > 1) rows.push({ s: tw(q.s), t: tw(q.t), r: 'open', p: cleanPath(e.path).slice(0, 60).map((t) => tw(t).slice(0, 100)) });
      return rows.slice(0, 40);
    }),
  };
}

// 這一局每個人的戰績（給後台的「所有對局」）：暱稱、名次、結果、步數、時間、路線
function gameRoster(g) {
  return ranking(g).slice(0, 8).map((e) => ({
    n: String(e.name || '玩家').slice(0, 16), pl: e.place || 0, r: String(e.finished?.reason || (e.left ? 'left' : '')).slice(0, 12),
    k: Number(e.clicks) || 0, t: Math.round(e.finished?.elapsed || 0),
    p: cleanPath(e.path).map((t) => tw(t).slice(0, 100)),  // 整條路線（最多 200 站，跟 cleanPath 一樣）：重播要從頭播到尾
  }));
}

// 單人訓練、每日挑戰也記一筆（後台看得到大家怎麼玩）
function recordSoloStats(g) {
  if (g.statsRecorded || !g.finished) return;
  g.statsRecorded = true;
  const win = g.finished.reason === 'win';
  recordGame({
    mode: state.daily ? 'daily' : 'solo', goal: cleanGoal(g.settings.goal), players: 1, round: 1,
    start: tw(g.settings.start), target: tw(g.settings.target),
    win, durationMs: Math.round(g.finished.elapsed || 0), steps: win ? g.finished.clicks : null,
    ...gameExtra(g),
  });
}

function renderRoomScore() {
  const sc = state.roomScore;
  $('#room-score').hidden = !sc.games;
  if (!sc.games) return;
  $('#room-score-games').textContent = `已經比了 ${sc.games} 局`;
  const rows = [...state.players.values()].map((p) => ({ p, w: sc.wins[p.id] || 0 })).sort((a, b) => b.w - a.w);
  const top = rows[0]?.w || 0;
  $('#room-score-list').replaceChildren(...rows.map(({ p, w }) => {
    const li = document.createElement('li');
    li.classList.toggle('top', w > 0 && w === top);
    li.append(avatarEl(p, 'sm'), Object.assign(document.createElement('b'), { textContent: p.id === state.myId ? `${p.name}（你）` : p.name }), Object.assign(document.createElement('span'), { textContent: `${w} 勝` }));
    return li;
  }));
}

function broadcastLobby() {
  net.send(lobbyMsg());
  if (state.view === 'room') renderRoom();
  syncRoom(true);
}

let settingsTimer;
function broadcastSettings() {
  const next = readForm();
  if (changeMode(form().elements.roomMode.value)) return;
  if (JSON.stringify(next) === JSON.stringify(state.settings)) return;
  const goalChanged = next.goal !== cleanGoal(state.settings.goal);
  state.settings = next;
  if (goalChanged) {
    // 換了比賽方式：大家重新確認一次（不然有人是照舊的玩法按準備的）
    sysChat(`房主把比賽方式改成 ${goalText(next.goal)}`);
    unreadyAll();
    net.send({ t: 'settings', settings: state.settings });
    broadcastLobby();
    return;
  }
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => net.send({ t: 'settings', settings: state.settings }), 150);
}

// 房主：換成 1 對 1／派對。人太多不能改成 1 對 1
function changeMode(mode) {
  mode = mode === 'party' ? 'party' : 'duel';
  if (mode === state.mode) return false;
  if (mode === 'duel' && state.players.size > MAX_PLAYERS.duel) {
    form().elements.roomMode.value = state.mode;
    toast(`房間裡有 ${state.players.size} 人，1 對 1 只能 2 人`, 3000);
    return true;
  }
  state.mode = mode;
  sysChat(`房主把人數改成 ${mode === 'party' ? '派對（2–8 人）' : '1 對 1'}`);
  unreadyAll();
  broadcastLobby();
  return true;
}

function unreadyAll() {
  for (const p of state.players.values()) if (!p.host) p.ready = false;
}

// 玩家：房主換人了，告訴大家誰離開、誰是新房主
function noticeHostChange(prev) {
  const now = [...state.players.values()].find((p) => p.host);
  if (!prev || !now || now.id === prev.id) return;
  const mine = now.id === state.myId;
  const stayed = [...state.players.values()].some((p) => p.name === prev.name && !p.host);
  const who = mine ? '你' : now.name;
  const gone = state.hostLeft === prev.name ? '離開了' : '離線了';  // 按了離開／直接斷線
  state.hostLeft = null;
  toast(stayed ? `${prev.name} 把房主交給 ${who}` : `${prev.name} ${gone}，${who} 成為新房主`, 4000);
}

// 玩家：房主換了玩法，跳一個提醒（準備會被取消，要重新按）
function noticeRuleChange(prevGoal, prevMode) {
  if (net.isHost || state.view !== 'room') return;
  const goal = cleanGoal(state.settings.goal);
  if (goal !== prevGoal) toast(`房主把比賽方式改成 ${goalText(goal)}`, 3000);
  else if (state.mode !== prevMode) toast(`房主把人數改成 ${isParty() ? '派對（2–8 人）' : '1 對 1'}`, 3000);
}

let suggestTimer;
function initRoom() {
  form().addEventListener('input', (e) => {
    if (!net.isHost) return;
    e.target.diceToken = null;
    broadcastSettings();
    const name = e.target.name;
    if (name === 'start' || name === 'target') {
      clearTimeout(suggestTimer);
      const text = e.target.value;
      suggestTimer = setTimeout(async () => {
        try {
          const list = await wiki.suggest(state.settings.lang, text);
          $(`#suggest-${name}`).replaceChildren(...list.map((t) => Object.assign(document.createElement('option'), { value: tw(t) })));
        } catch { /* 建議失敗不影響遊戲 */ }
      }, 250);
    }
  });
  form().addEventListener('change', () => { paintOppViewDesc(); if (net.isHost) broadcastSettings(); paintFoldSummaries(); paintRoomGoal(); });
  // 房主：上方的「換玩法」直接打開「玩法」那一段
  $('#btn-change-goal').onclick = () => {
    const d = form().querySelector('details[data-fold="goal"]');
    d.open = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'center' });
    d.classList.remove('glow');
    void d.offsetWidth;
    d.classList.add('glow');
  };
  // 收合／展開記在這支手機
  for (const d of form().querySelectorAll('details.fold')) {
    const k = `wikirace-fold-${d.dataset.fold}`;
    const saved = store.get(k);
    if (saved === '1' || saved === '0') d.open = saved === '1';
    d.addEventListener('toggle', () => store.set(k, d.open ? '1' : '0'));
  }
  form().addEventListener('submit', (e) => e.preventDefault());

  form().querySelectorAll('[data-random]').forEach((btn) => {
    btn.onclick = async () => {
      const key = btn.dataset.random;
      const field = form().elements[key];
      // 抽籤時如果自己先打了字、或已經開始比賽，就不要拿晚到的結果蓋掉
      const token = {};
      field.diceToken = token;
      btn.disabled = true;
      btn.classList.add('busy');
      try {
        const s = readForm();
        let t;
        do { t = await wiki.randomTitle(s.lang, s.trueRandom); } while (t === s[key === 'start' ? 'target' : 'start']);
        await zhReady;
        if (field.diceToken !== token || state.view !== 'room') return;
        field.value = tw(t);
        sfx.click();
        haptic('light');
        broadcastSettings();
      } catch (e) {
        showError('#room-error', e.message);
      } finally {
        btn.disabled = !net.isHost;
        btn.classList.remove('busy');
      }
    };
  });

  $('#btn-copy-link').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${net.code}`;
    const text = isParty() ? `來參加維基競速派對！房間代碼 ${net.code}` : `來跟我比維基競速！房間代碼 ${net.code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: '維基競速', text, url });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('已複製邀請連結！');
    } catch {
      prompt('複製這個連結傳給朋友：', url);
    }
  };

  $('#btn-leave').onclick = () => {
    // 房主離開時，房間交給下一位玩家，不用整間解散
    const next = net.isHost && onlineGuests()[0];
    if (next) {
      if (!confirm(`離開後房主會交給 ${next.name}，確定要離開嗎？`)) return;
      migrateHost(next.id, { leaving: true });
      return;
    }
    if (!confirm('確定要離開房間嗎？')) return;
    leaveRoom();
  };

  $('#btn-transfer').onclick = async () => {
    const list = onlineGuests();
    if (!list.length) return;
    const id = list.length === 1
      ? (confirm(`要把房主交給 ${list[0].name} 嗎？`) ? list[0].id : null)
      : await pickPlayer({ title: '轉移房主', sub: '選一位玩家成為新房主', players: list });
    if (id) migrateHost(id);
  };

  $('#btn-ready').onclick = () => {
    state.myReady = !state.myReady;
    net.send({ t: 'ready', ready: state.myReady });
    if (state.myReady) { sfx.ready(); haptic('success'); }
    renderRoom();
  };

  $('#btn-start').onclick = hostStart;
}

// 不再參加這一局（被請出、回不了房間、接手當房主）：停掉計時器並收起比賽中的畫面
function abandonGame() {
  const g = state.game;
  if (g) {
    stopGameLoops(g);
    if (!g.finished) g.finished = { reason: 'hostLeft', elapsed: elapsed(), clicks: g.clicks, path: g.path.slice() };
  }
  for (const id of ['#countdown', '#coach', '#item-dock', '#path-drawer', '#hint-bar']) $(id).hidden = true;
  closePick(null);
  music.stop();
}

// ---------- 踢出玩家 ----------
// 房主可以把人請出房間；被踢的人這個房間用同一個身分回不來
function kickButton(p) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'kick-btn', textContent: '踢出' });
  b.setAttribute('aria-label', `把 ${p.name} 請出房間`);
  b.onclick = (e) => { e.stopPropagation(); kickPlayer(p.id); };
  return b;
}

function kickPlayer(pid) {
  const p = state.players.get(pid);
  if (!p || !net.isHost || p.host || state.view !== 'room' || stillRacing(pid)) return;
  if (!confirm(`要把 ${p.name} 請出房間嗎？`)) return;
  state.banned.add(pid);
  if (state.devices.get(pid)) state.banned.add(state.devices.get(pid));
  net.kick(pid, { t: 'kicked' });
  p.leaving = true;
  removePlayer(pid, { kicked: true });
}

// ---------- 轉移房主 ----------
// 房間代碼就是房主的連線位址：舊房主放掉代碼，新房主接手同一個代碼，其他人照常自動重連
// 上一局還沒比完的人不算（房主先回到房間時，他們還在比賽中）
const stillRacing = (id) => { const o = state.game?.others.get(id); return !!o && !o.finished && !o.left; };
const onlineGuests = () => [...state.players.values()].filter((p) => !p.host && p.online !== false && !stillRacing(p.id));

async function migrateHost(toId, { leaving = false } = {}) {
  const to = state.players.get(toId);
  if (!to || !net.isHost || state.view !== 'room') return;
  const code = net.code;
  // 舊房主之後當一般玩家：新的私密 key 留在自己這裡，名單上只放公開 id
  const myNewKey = randomKey();
  const myNewId = await publicId(myNewKey);
  if (!net.isHost || state.view !== 'room' || !state.players.has(toId)) return;
  const players = [...state.players.values()]
    .filter((p) => !(leaving && p.id === state.myId))
    .map((p) => {
      if (p.id === state.myId) return { ...p, id: myNewId, host: false, ready: false };
      if (p.id === toId) return { ...p, host: true, ready: true };
      return { ...p };
    });
  // 從這裡開始已經不是房主了：別讓接下來的斷線、名單變動又把房間發布回去（會變成新房主改不動的幽靈房間）
  leavingRoom = true;
  hosted.clear();
  clearRoom(code);
  stopControlWatch();
  sysChat(leaving ? `${state.myName} 離開了，房主交給 ${to.name}` : `${state.myName} 把房主交給 ${to.name}`);
  const wins = { ...state.roomScore.wins };
  if (wins[state.myId] !== undefined) { wins[myNewId] = wins[state.myId]; delete wins[state.myId]; }
  state.roomScore = { games: state.roomScore.games, wins };
  // 先放掉房間代碼再通知：新房主收到時就能馬上接手，不用一直重試
  await net.releaseCode();
  net.send({ t: 'migrate', to: toId, code, mode: state.mode, settings: state.settings, players, chat: state.chat.slice(-30), banned: [...state.banned], score: state.roomScore, started: notifiedStart === code, scored: state.game?.scored ? state.game.id : null });
  state.hostLocked = true;
  session.clear();
  for (const t of graceTimers.values()) clearTimeout(t);
  graceTimers.clear();
  setTimeout(() => {
    net.destroy();
    if (leaving) { location.href = location.pathname; return; }
    // 自己改用一般玩家的身分回到同一個房間
    leavingRoom = false;
    state.myKey = myNewKey;
    state.myId = myNewId;
    state.myReady = false;
    state.players = new Map(players.map((p) => [p.id, p]));
    netBanner(`房主交給 ${to.name}，重新連線中…`);
    renderRoom();
    net.awaitNewHost();
    rejoinAfterMigrate(code);
  }, 400);
}

async function rejoinAfterMigrate(code, tries = 0) {
  try {
    await net.joinRoom(code);
  } catch {
    if (tries < 15) { setTimeout(() => rejoinAfterMigrate(code, tries + 1), 1200); return; }
    netBanner('');
    show('home');
    setConn('');
    showError('#home-error', '連不上新房主，房間可能已經解散了');
    return;
  }
  net.expectHost = 0;
  session.save({ code, key: state.myKey, role: 'guest' });
  sendJoin();
  netBanner('');
  setConn('已連線', true);
}

// 被選為新房主：接手房間代碼，等其他人連回來
async function takeOverHost(msg) {
  netBanner('你成為新房主，正在接手房間…');
  net.destroy();
  if (state.game && !state.game.finished) abandonGame();
  state.mode = msg.mode === 'party' ? 'party' : 'duel';
  state.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
  if (Array.isArray(msg.chat)) state.chat = msg.chat.slice(-CHAT_MAX);
  state.players = new Map((msg.players || []).map((p) => [p.id, { ...p, avatar: cleanAvatar(p.avatar), online: p.id === state.myId, migrating: p.id !== state.myId }]));
  state.myReady = false;
  state.banned = new Set(Array.isArray(msg.banned) ? msg.banned.filter((k) => typeof k === 'string') : []);
  if (msg.score?.wins) state.roomScore = { games: Number(msg.score.games) || 0, wins: { ...msg.score.wins } };
  if (msg.started) notifiedStart = msg.code;  // 舊房主已經通知過「開始比賽」，換人當房主不要再通知一次
  // 上一局舊房主已經算過分、記過統計了：新房主不要再算一次
  if (msg.scored && state.game?.id === msg.scored) state.game.scored = true;
  leavingRoom = false;
  try {
    await net.createRoom(0, msg.code);
  } catch (e) {
    netBanner('');
    show('home');
    setConn('');
    showError('#home-error', `沒辦法接手房間（${e.message}）`);
    return;
  }
  session.clear();
  state.hostLocked = false;
  for (const p of state.players.values()) {
    if (p.id === state.myId) continue;
    graceTimers.set(p.id, setTimeout(() => removePlayer(p.id), GRACE_MIGRATE));
  }
  netBanner('');
  enterRoom(net.code);
  setConn(onlineGuests().length ? '已連線' : '等待玩家', true);
  sysChat(`${state.myName} 成為新房主`);
  toast('你現在是房主了！', 2500);
  sfx.ready();
  haptic('success');
}

// ---------- 房主不見了：玩家自動接手 ----------
// 房主斷線或關掉 App，過一下還沒回來：名單上排最前面、還在線上的玩家用同一個代碼接手房間，
// 其他人照常自動重連。兩個人同時想接手時，只有一個人拿得到房間代碼（另一個就繼續當玩家連過去）。
let takeoverTimer = null;
function scheduleTakeover(extra = 0) {
  clearTimeout(takeoverTimer);
  if (state.migrating || net.isHost || !net.code || state.view === 'home' || state.solo) return;
  const order = [...state.players.values()].filter((p) => !p.host && p.online !== false && !p.leaving);
  const rank = order.findIndex((p) => p.id === state.myId);
  if (rank < 0) return;
  takeoverTimer = setTimeout(autoTakeOver, (state.takeoverAfter ?? TAKEOVER_AFTER) + rank * TAKEOVER_STEP + extra);  // takeoverAfter：自動化測試用
}

async function autoTakeOver() {
  if (net.isHost || net.connected || !net.code || state.view === 'home' || state.migrating) return;
  const code = net.code;
  const old = [...state.players.values()].find((p) => p.host);
  net.stopRetry();
  net.destroy();
  try {
    await net.createRoom(0, code, 0);  // 只試一次：代碼被佔著就是有人先接手了（或舊房主其實還在）
  } catch {
    // 代碼還被舊房主佔著、但他已經沒有心跳了（斷線還沒被清掉）：3 秒後再搶一次，不要先去連已經不在的舊房主
    if (await net.hostFresh() === false && Date.now() - (state.takeoverStart ||= Date.now()) < 40000) {
      takeoverTimer = setTimeout(autoTakeOver, 3000);
      return;
    }
    state.takeoverStart = 0;
    net.joinRoom(code).then(() => net.onHostBack(), () => { net.startRetry(); scheduleTakeover(TAKEOVER_STEP); });
    return;
  }
  state.takeoverStart = 0;
  clearTimeout(hostGiveUpTimer);
  netBanner('');
  const oldName = old?.name || '房主';
  if (old) state.players.delete(old.id);
  const g = state.game;
  const racing = !!(g && !g.finished && state.view === 'game');
  for (const p of state.players.values()) {
    const me = p.id === state.myId;
    p.host = me;
    if (me) { p.ready = true; p.online = true; continue; }
    p.online = false;      // 等他們連回來
    p.migrating = true;    // 連回來時不用一一宣布
    graceTimers.set(p.id, setTimeout(() => removePlayer(p.id), racing ? GRACE_GAME : GRACE_MIGRATE));
    const o = g?.others.get(p.id);
    if (o && racing) o.offline = true;
  }
  state.myReady = false;
  state.hostLocked = racing;
  notifiedStart = code;  // 這個房間已經通知過了
  if (old && g) onOtherLeft(old.id);  // 這一局舊房主算離開
  if (state.view === 'room') enterRoom(code);
  else { renderOppHud(); syncRoom(true); }
  setConn(onlineGuests().length ? '已連線' : (isParty() ? '等待玩家' : '等待對手'), true);
  sysChat(`${oldName} 離線了，${state.myName} 成為新房主`);
  // 舊房主在找的最佳解答跟著斷了：新房主接著找
  if (g && !g.solution?.path && !isRush(g)) { if (g.solution?.remote) g.solution = null; prefetchSolution(g); }
  // 搶分賽：舊房主出題到一半斷了，新房主接著出
  if (g && isRush(g) && !g.finished) rushFill(g);
  toast(`${oldName} 離線了，你成為新房主`, 4000);
  sfx.ready();
  haptic('success');
}

// 原本的房主回來時，房間已經被別人接手了：改用一般玩家的身分回到房間
function displacedAsHost() {
  if (!net.isHost) return;
  const code = net.code;
  hosted.clear();
  session.clear();
  stopControlWatch();
  forgetRoom();
  net.destroy();
  if (state.game && !state.game.finished) abandonGame();
  state.game = null;
  state.myKey = randomKey();
  state.myId = null;
  state.myReady = false;
  state.players = new Map();
  toast('房間已經由其他玩家接手，你用玩家身分回到房間', 4000);
  show('home');
  joinAsGuest(code);
}

// 選一位玩家（轉移房主、道具指定對象共用）
let pickResolve = null;
function pickPlayer({ title, sub = '', players }) {
  if (pickResolve) pickResolve(null);
  $('#pick-title').textContent = title;
  $('#pick-sub').textContent = sub;
  $('#pick-list').replaceChildren(...players.map((p) => {
    const li = document.createElement('li');
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'pick-item' });
    b.append(avatarEl(p, 'sm'), Object.assign(document.createElement('b'), { textContent: p.name }));
    if (p.note) b.append(Object.assign(document.createElement('small'), { textContent: p.note }));
    b.onclick = () => closePick(p.id);
    li.append(b);
    return li;
  }));
  $('#pick-modal').hidden = false;
  return new Promise((resolve) => { pickResolve = resolve; });
}

function closePick(id = null) {
  $('#pick-modal').hidden = true;
  const r = pickResolve;
  pickResolve = null;
  if (r) r(id);
}

// 主動離開：先告訴大家，房主則直接解散房間
function leaveRoom() {
  leavingRoom = true;
  session.clear();
  hosted.clear();
  if (net.isHost) { clearRoom(net.code); stopControlWatch(); }
  net.send(net.isHost ? { t: 'closed' } : { t: 'bye' });
  setTimeout(() => {
    net.destroy();
    location.href = location.pathname;
  }, 250);
}

async function hostStart() {
  const btn = $('#btn-start');
  btn.disabled = true;
  btn.textContent = '準備路線中…';
  showError('#room-error');
  try {
    const s = readForm();
    if (s.goal === 'rush') {
      // 搶分賽：房主先出好前兩題，其他的比賽中在背景繼續出，大家照同一個順序玩
      btn.textContent = '出題中…';
      s.timeLimit = s.rushMin * 60;
      s.lastCall = 0;
      s.rush = await Promise.all([rushPuzzle(s), rushPuzzle(s)]);
      s.start = s.rush[0].s;
      s.target = s.rush[0].t;
    } else {
      const pick = async (val) => (val ? val : wiki.randomTitle(s.lang, s.trueRandom));
      s.start = await wiki.resolveTitle(s.lang, await pick(s.start));
      s.target = await wiki.resolveTitle(s.lang, await pick(s.target));
      let guard = 0;
      while (s.start === s.target && !readForm().target && guard++ < 5) {
        s.target = await wiki.resolveTitle(s.lang, await wiki.randomTitle(s.lang, s.trueRandom));
      }
      if (s.start === s.target) throw new Error('起點和終點不能是同一個條目');
    }
    if (!net.connected) throw new Error(isParty() ? '其他玩家都離線了' : '對手已離線');
    state.settings = s;
    // 搶分賽的題目不寫進「路線」欄位（之後改回一般玩法時，起點終點還是原本設定的）
    writeForm(s.goal === 'rush' ? { ...s, start: form().elements.start.value, target: form().elements.target.value } : s);
    // 開局時大家的準備狀態歸零，下一局重新準備
    for (const p of state.players.values()) if (!p.host) p.ready = false;
    const id = randomKey();
    net.send({ t: 'settings', settings: s });
    net.send({ t: 'start', id, settings: s, mode: state.mode, players: [...state.players.values()] });
    startGame(s, id);
    // 製作者通知：每間房只通知第一場，再來一局就不吵
    if (!state.roomScore.games && notifiedStart !== net.code) {
      notifiedStart = net.code;
      notify('start', '比賽開始了', `${state.players.size} 位玩家 · ${goalText(s.goal)}`);
    }
  } catch (e) {
    reportError('start', e);
    showError('#room-error', e.message);
  } finally {
    btn.textContent = '開始對局';
    renderRoom();
  }
}

// ---------- 單人訓練 ----------
function openSolo() {
  $('#solo-error').hidden = true;
  $('#solo-modal').hidden = false;
}

function initSolo() {
  $('#btn-solo').onclick = async () => { if (await askName()) openSolo(); };
  $('#btn-newbie').onclick = startNewbie;
  $('#btn-rush-skip').onclick = rushSkip;
  $('#solo-close').onclick = () => { $('#solo-modal').hidden = true; };
  $('#solo-modal').addEventListener('click', (e) => { if (e.target.id === 'solo-modal') $('#solo-modal').hidden = true; });
  // 隨機出題：抽一個條目填進去（起點、終點不會抽到一樣的）
  $('#solo-modal').querySelectorAll('[data-solo-random]').forEach((btn) => {
    btn.onclick = async () => {
      const key = btn.dataset.soloRandom;
      const field = $(key === 'start' ? '#solo-start-input' : '#solo-target-input');
      const other = $(key === 'start' ? '#solo-target-input' : '#solo-start-input');
      const token = {};
      field.diceToken = token;
      btn.disabled = true; btn.classList.add('busy');
      try {
        let t;
        do { t = await wiki.randomTitle('zh', $('#solo-hell').checked); } while (tw(t) === other.value.trim());
        await zhReady;
        if (field.diceToken === token) { field.value = tw(t); sfx.click(); haptic('light'); }
      } catch { /* 抽題失敗就算了 */ } finally { btn.disabled = false; btn.classList.remove('busy'); }
    };
  });
  $('#solo-start').onclick = startTraining;
}

async function startTraining() {
  const btn = $('#solo-start');
  btn.disabled = true;
  btn.textContent = '準備路線中…';
  $('#solo-error').hidden = true;
  try {
    soloSetup($('#nickname').value.trim() || store.get('wikirace-name') || '玩家');
    state.daily = null;
    const s = {
      ...DEFAULT_SETTINGS, lang: 'zh', goal: 'speed',
      start: $('#solo-start-input').value.trim(),
      target: $('#solo-target-input').value.trim(),
      allowBack: $('#solo-back').checked,
      trueRandom: $('#solo-hell').checked,
      allowFind: $('#solo-find').checked,
    };
    const pick = async (val) => (val ? val : wiki.randomTitle(s.lang, s.trueRandom));
    s.start = await wiki.resolveTitle(s.lang, await pick(s.start));
    s.target = await wiki.resolveTitle(s.lang, await pick(s.target));
    let guard = 0;
    while (s.start === s.target && guard++ < 5) s.target = await wiki.resolveTitle(s.lang, await wiki.randomTitle(s.lang, s.trueRandom));
    if (s.start === s.target) throw new Error('起點和終點不能是同一個條目，再試一次');
    state.settings = s;
    $('#solo-modal').hidden = true;
    setConn('單人練習');
    startGame(s, randomKey());
    notify('solo', '有人在單人訓練', `${tw(s.start)} → ${tw(s.target)}`);
  } catch (e) {
    reportError('solo', e);
    showError('#solo-error', e.message || '出了點問題，再試一次');
  } finally {
    btn.disabled = false;
    btn.textContent = '開始訓練';
  }
}

// 單人訓練、每日挑戰共用：準備一個沒有對手、不連線的「房間」
function soloSetup(name) {
  state.myName = name;
  store.set('wikirace-name', name);
  state.myId = 'me';
  state.mode = 'duel';
  state.solo = true;
  state.chat = [];
  state.roomScore = { games: 0, wins: {} };
  state.players = new Map([['me', { id: 'me', name, avatar: state.myAvatar, ready: true, host: true, color: COLORS[0], online: true }]]);
  session.clear();
}

// ---------- 每日挑戰 ----------
// 全台灣每天同一題；按下開始就算用掉今天的正式機會（中途關掉、投降都不能重來刷成績），之後再玩只算練習
// 視窗正在顯示哪一天的題目（過了午夜按開始，要換成新的一天重新顯示，不能偷偷玩到別題）
let dailyModalKey = null;
// 題目讀到後先記著：分享時要馬上組出文字（iPhone 的分享和複製必須在點擊當下呼叫，不能先等網路）
const dailyPuzzles = {};
function openDaily() {
  const key = todayKey();
  dailyModalKey = key;
  $('#daily-modal').hidden = false;
  showError('#daily-error');
  $('#daily-start').textContent = '讀取中…';
  $('#daily-target').textContent = '';
  $('#daily-board').replaceChildren(Object.assign(document.createElement('li'), { className: 'daily-empty', textContent: '讀取中…' }));
  $('#daily-count').textContent = '–';
  $('#daily-best').textContent = '–';
  $('#daily-name').value = $('#nickname').value.trim();
  $('#daily-name-row').hidden = true;  // 暱稱改用跳出視窗問
  $('#daily-title').textContent = `📅 每日挑戰 #${dailyNo(key)}`;
  $('#daily-streak').textContent = streak(key);
  renderDailyMine(key);
  const loaded = puzzle(key).then(async (p) => {
    await zhReady;
    dailyPuzzles[key] = p;
    if (dailyModalKey !== key) return;
    $('#daily-start').textContent = tw(p.start);
    $('#daily-target').textContent = tw(p.target);
    // 讀到題目才知道是第幾輪（管理員可能重置過）：重新判斷今天玩過了沒
    $('#daily-streak').textContent = streak(key);
    renderDailyMine(key);
    refreshDailyHome();
  }, (e) => {
    $('#daily-start').textContent = '題目讀取失敗';
    $('#daily-target').textContent = '';
    showError('#daily-error', e.message);
  });
  loaded.finally(() => resendDaily(key).finally(() => renderDailyBoard(key)));
}

// 排行榜上「我」是哪一筆：Google 帳號的身分（資料庫規則只收 Google 登入、只准本人交、不能覆蓋）
// 沒登入就是 null：成績先記在手機上，登入之後再補送
const myBoardId = async () => { await getUid(); return account()?.uid || null; };

// 第一次完成時網路不通、成績沒送出去：之後打開時再補送
let resending = null;
function resendDaily(key) {
  const m = myDay(key);
  if (!m?.win || m.sent) return Promise.resolve();
  const rec = { n: m.n || $('#nickname').value.trim() || '玩家', a: m.a || '', s: m.s, t: m.t, h: m.h ? 1 : 0, p: Array.isArray(m.p) ? m.p : [] };
  resending ||= myBoardId()
    .then((id) => id && submit(key, id, rec))
    .then((ok) => { if (ok) saveDay(key, { ...myDay(key), sent: true }); })
    .finally(() => { resending = null; });
  return resending;
}

function renderDailyMine(key) {
  const m = myDay(key);
  const run = dailyRun(key);
  const box = $('#daily-mine');
  box.hidden = !m;
  box.classList.toggle('miss', !!m && !m.win && !run);
  box.classList.toggle('resume', !!run);
  clearInterval(resumeTicker);
  if (run) {
    // 中途跳掉、3 分鐘內回來：可以接著玩
    const paint = () => {
      const left = Math.ceil((run.at + RESUME_MS - Date.now()) / 1000);
      if (left <= 0) { clearInterval(resumeTicker); renderDailyMine(key); return; }
      box.textContent = `⏸ 你剛剛中途離開了（走了 ${run.clicks} 步）。${left} 秒內可以接著玩，計時照算`;
    };
    paint();
    resumeTicker = setInterval(paint, 1000);
  } else if (m) box.textContent = m.win ? `✅ 你今天：${m.s} 步 · ${fmtTime(m.t)}${m.h ? ' · 💡' : ''}${m.rank ? `　🏆 第 ${m.rank} 名` : ''}` : '今天的正式挑戰沒有完成，明天再來！';
  $('#daily-go').textContent = run ? '▶ 接著剛才的挑戰' : m ? '再玩一次（練習，不計成績）' : '開始挑戰';
  $('#daily-share').hidden = !m?.win;
}

// ---------- 每日挑戰中途跳掉：3 分鐘內回來可以接著玩 ----------
// 正式挑戰進行中每走一步、每隔幾秒就把進度存在這支手機。計時照算：離開的那段時間也算進去，所以不能拿來暫停偷查
const RUN_KEY = 'wikirace-daily-run';
const RESUME_MS = 180000;
let resumeTicker = null;
function saveDailyRun(g = state.game) {
  const d = state.daily;
  if (!d || !d.first || !d.started || !g || g !== state.game || g.finished || !g.current) return;
  store.set(RUN_KEY, JSON.stringify({
    key: d.key, r: roundOf(d.key), id: g.id, start: g.settings.start, target: g.settings.target,
    el: Math.round(elapsed()), clicks: g.clicks, path: g.path.slice(-200), cur: g.current,
    stack: g.stack.slice(-200), hint: !!g.hint?.shown, at: Date.now(),
  }));
}
const clearDailyRun = () => { try { localStorage.removeItem(RUN_KEY); } catch { /* 忽略 */ } };
// 這一天、這一輪、正式挑戰開始了但沒結束、離開還不到 3 分鐘：回傳存的進度
function dailyRun(key) {
  let run = null;
  try { run = JSON.parse(store.get(RUN_KEY) || 'null'); } catch { return null; }
  const m = myDay(key);
  if (!run || run.key !== key || (run.r || 1) !== roundOf(key) || !m || m.win !== undefined) return null;
  if (!(Date.now() - run.at < RESUME_MS) || typeof run.cur !== 'string' || !Array.isArray(run.path)) return null;
  return run;
}

// 接著剛才的正式挑戰：步數、路線、上一頁都照舊，計時從離開那一刻一直算到現在
async function resumeDaily(run) {
  const p = await puzzle(run.key);
  dailyPuzzles[p.key] = p;
  const name = ($('#daily-name').value || $('#nickname').value).trim() || myDay(run.key)?.n || '玩家';
  soloSetup(name);
  state.daily = { ...p, first: true, started: true, recorded: false };
  const s = { ...DEFAULT_SETTINGS, lang: 'zh', goal: 'speed', allowBack: true, trueRandom: false, start: run.start, target: run.target };
  createGame(s, run.id);
  const g = state.game;
  g.startAt = performance.now() - run.el - Math.max(0, Date.now() - run.at);
  g.clicks = run.clicks;
  g.path = run.path.slice();
  g.stack = Array.isArray(run.stack) ? run.stack.slice() : g.path.slice(0, -1);
  g.spots = g.stack.map(() => null);
  $('#daily-modal').hidden = true;
  setConn(`每日挑戰 #${p.no}`);
  show('game');
  $('#countdown').hidden = true;
  if (run.hint) setTimeout(() => { if (state.game === g) showHint({ quiet: true }); }, 800);
  music.play('race');
  g.timer = setInterval(tick, 200);
  toast('接著剛才的挑戰！計時照算', 2500);
  goTo(run.cur, { restore: true });
}

// 按「開始挑戰」：正式挑戰先跳一個提醒（只有一次、跳掉 3 分鐘內可以回來）；接著玩、練習就直接開始
async function dailyGo() {
  if (!(await askName())) return;  // 沒有暱稱：跳出視窗先取一個（排行榜要用）
  const key = todayKey();
  const run = dailyRun(key);
  if (run && key === dailyModalKey) { resumeDaily(run).catch((e) => { reportError('daily', e); showError('#daily-error', e.message || '接不回去，再試一次'); }); return; }
  if (myDay(key)) { startDaily(); return; }
  $('#daily-confirm').hidden = false;
}

async function renderDailyBoard(key) {
  const list = $('#daily-board');
  const rows = await board(key);
  const myId = await myBoardId();
  if (todayKey() !== key) return;
  const msg = (t) => list.replaceChildren(Object.assign(document.createElement('li'), { className: 'daily-empty', textContent: t }));
  if (!rows) { $('#daily-count').textContent = '–'; $('#daily-best').textContent = '–'; msg('排行榜需要網路連線，暫時讀不到'); return; }
  $('#daily-count').textContent = rows.length;
  $('#daily-best').textContent = rows.length ? rows[0].s : '–';
  if (!rows.length) { msg('還沒有人完成，搶第一個！'); return; }
  const me = rows.findIndex((r) => r.id === myId || r.id === deviceId);
  const m = myDay(key);
  if (me >= 0 && m?.win && (m.rank !== me + 1 || m.of !== rows.length)) { saveDay(key, { ...m, rank: me + 1, of: rows.length }); renderDailyMine(key); }
  const medal = ['🥇', '🥈', '🥉'];
  // 每個人的路線：自己今天的正式挑戰用掉之後才看得到（不然等於直接看答案）
  const canSee = !!m;
  const row = (r, i) => {
    const li = document.createElement('li');
    li.classList.toggle('me', i === me);
    li.append(
      Object.assign(document.createElement('span'), { className: 'rk', textContent: medal[i] || String(i + 1) }),
      avatarEl({ name: r.n, avatar: r.a }, 'sm'),
      Object.assign(document.createElement('span'), { className: 'nm', textContent: i === me ? `${r.n}（你）` : r.n }),
      Object.assign(document.createElement('span'), { className: 'sc', textContent: `${r.s} 步 · ${fmtTime(r.t)}${r.h ? ' 💡' : ''}` }),
    );
    if (canSee && r.p.length > 1) {
      li.classList.add('has-route');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-expanded', 'false');
      const route = Object.assign(document.createElement('div'), { className: 'board-route', hidden: true });
      route.append(...r.p.map((t, k) => Object.assign(document.createElement('span'), { className: k === 0 ? 'start' : k === r.p.length - 1 ? 'goal' : '', textContent: tw(t) })));
      li.append(route);
      const toggle = () => { route.hidden = !route.hidden; li.setAttribute('aria-expanded', String(!route.hidden)); li.classList.toggle('open', !route.hidden); };
      li.onclick = toggle;
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
    }
    return li;
  };
  const items = rows.slice(0, 10).map(row);
  if (me >= 10) items.push(Object.assign(document.createElement('li'), { className: 'gap', textContent: '⋯' }), row(rows[me], me));
  const hasRoutes = rows.some((r) => r.p.length > 1);
  $('#daily-route-note').hidden = !hasRoutes;
  $('#daily-route-note').textContent = canSee ? '點一下名字，看他是怎麼走的' : '🔒 完成今天的挑戰後，就能看到大家的路線';
  list.replaceChildren(...items);
}

async function startDaily() {
  const name = ($('#daily-name').value || $('#nickname').value).trim();
  if (!name) {
    $('#daily-name-row').hidden = false;
    showError('#daily-error', '請先輸入暱稱，排行榜才知道是你');
    $('#daily-name').focus();
    return;
  }
  if (badName(name)) {
    $('#daily-name-row').hidden = false;
    showError('#daily-error', '這個暱稱不太好，換一個吧');
    $('#daily-name').focus();
    return;
  }
  if (reservedName(name)) {
    $('#daily-name-row').hidden = false;
    showError('#daily-error', `「${name}」不能當暱稱，取一個專屬的名字吧`);
    $('#daily-name').focus();
    return;
  }
  if (todayKey() !== dailyModalKey) {
    openDaily();
    showError('#daily-error', '已經過了午夜，換成今天的新題目囉！');
    return;
  }
  const btn = $('#daily-go');
  btn.disabled = true;
  btn.textContent = '準備路線中…';
  showError('#daily-error');
  try {
    const p = await puzzle(dailyModalKey);
    dailyPuzzles[p.key] = p;
    const s = { ...DEFAULT_SETTINGS, lang: 'zh', goal: 'speed', allowBack: true, trueRandom: false };
    s.start = await wiki.resolveTitle('zh', p.start);
    s.target = await wiki.resolveTitle('zh', p.target);
    $('#nickname').value = name;
    soloSetup(name);
    // 正式機會要等起點條目真的載入後才算用掉（訊號不好載不出來不算）
    state.daily = { ...p, first: !myDay(p.key), started: false, recorded: false };
    state.settings = s;
    $('#daily-modal').hidden = true;
    setConn(state.daily.first ? `每日挑戰 #${p.no}` : '每日挑戰・練習');
    startGame(s, randomKey());
    notify('solo', '有人在玩每日挑戰', `#${p.no}　${tw(s.start)} → ${tw(s.target)}`);
  } catch (e) {
    reportError('daily', e);
    showError('#daily-error', e.message || '出了點問題，再試一次');
  } finally {
    btn.disabled = false;
    renderDailyMine(todayKey());
  }
}

// 每日挑戰的結算：比賽一結束就記（不等結果畫面），第一次挑戰才記成績、上排行榜；之後的都是練習
function settleDaily(g) {
  const d = state.daily;
  if (!d || !g?.finished || g !== state.game || !d.first || !d.started || d.recorded) return;
  d.recorded = true;
  clearDailyRun();
  const f = g.finished;
  const win = f.reason === 'win';
  const path = cleanPath(f.path || g.path).map((t) => t.slice(0, 100));  // 走過的路線：排行榜上給完成的人看
  saveDay(d.key, { win, s: f.clicks, t: Math.round(f.elapsed), h: !!g.hint.shown, n: state.myName, a: state.myAvatar || '', p: path, sent: false });
  if (win) d.sending = resendDaily(d.key);
}

// 每日挑戰的結算畫面
function renderDailyResult(g) {
  const d = state.daily;
  const f = g.finished;
  const win = f.reason === 'win';
  $('#daily-result').hidden = false;
  $('#daily-result').dataset.key = d.key;
  $('#dres-title').textContent = `📅 每日挑戰 #${d.no}`;
  $('#dres-rank').textContent = '';
  if (d.first && !d.started) {
    // 起點根本沒載入（訊號不好）：這次不算，還可以重新挑戰
    $('#dres-sub').textContent = '起點條目沒有載入成功，這次不算，可以回首頁重新挑戰。';
    $('#dres-share').hidden = true;
    return;
  }
  settleDaily(g);  // 通常比賽一結束就已經記好了，這裡只是保險
  const m = myDay(d.key);
  if (m?.win) $('#dres-rank').textContent = '排名計算中…';
  (d.sending || Promise.resolve()).then(() => refreshDailyRank(d));
  $('#dres-sub').textContent = d.first
    ? (win ? '正式成績已登上今日排行榜，分享給朋友比比看！' : '今天的正式機會用掉了，可以看看排行榜上別人怎麼走，明天再來！')
    : `練習模式（不計成績）　今天的正式成績：${m?.win ? `${m.s} 步 · ${fmtTime(m.t)}` : '未完成'}`;
  $('#dres-share').hidden = !m?.win;
  if (d.first && win && !account() && fbOn()) $('#dres-sub').textContent = '完成了！成績先記在這支手機上。';
  paintDailyLogin(d);
  refreshDailyHome();
}

async function refreshDailyRank(d) {
  const rows = await board(d.key);
  const myId = await myBoardId();
  const m = myDay(d.key);
  if (!m?.win) { $('#dres-rank').textContent = ''; return; }
  if (!rows) { $('#dres-rank').textContent = '排行榜暫時連不上'; return; }
  const i = rows.findIndex((r) => r.id === myId || r.id === deviceId);
  if (i < 0) { $('#dres-rank').textContent = ''; return; }
  saveDay(d.key, { ...m, rank: i + 1, of: rows.length });
  if (state.daily === d) $('#dres-rank').textContent = `🏆 第 ${i + 1} 名 / ${rows.length} 人`;
  refreshDailyHome();
}

async function shareDaily(key) {
  const m = myDay(key);
  if (!m?.win) return;
  const p = dailyPuzzles[key] || await puzzle(key);
  const blocks = m.s <= 15 ? '🟦'.repeat(Math.max(0, m.s - 1)) + '🎯' : `🟦 ×${m.s - 1} 🎯`;
  const rank = m.rank ? `　🏆 第 ${m.rank} 名／${m.of} 人` : '';
  const url = `${location.origin}${location.pathname}?daily`;
  const text = `維基競速 📅 每日挑戰 #${p.no}\n《${tw(p.start)}》→《${tw(p.target)}》\n👣 ${m.s} 步　⏱ ${fmtTime(m.t)}${m.h ? '　💡' : ''}${rank}\n${blocks}\n${url}`;
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('已複製成績，貼給朋友吧！'); } catch { toast('複製失敗，可以截圖分享'); }
}

// 首頁按鈕下的小字：今天玩了沒、第幾名、幾個人完成
let dailyHomeAt = -Infinity;
const roundAsked = new Set();
let dailyHomeN = { key: '', n: 0 };  // 上次查到今天有幾個人完成（重畫的時候沿用，不要蓋掉）  // 每一天只為了查輪數讀一次題目（讀不到也不會一直重試）
function refreshDailyHome() {
  const key = todayKey();
  // 這支手機今天有紀錄、但還不知道是第幾輪（管理員可能重置過）：先讀題目再判斷
  if (!roundKnown(key) && loadLog()[key] && !roundAsked.has(key)) { roundAsked.add(key); puzzle(key).then(refreshDailyHome, () => {}); }
  const m = myDay(key);
  const sub = $('#daily-sub');
  if (m?.win) sub.textContent = `✅ ${m.s} 步${m.rank ? ` · 第 ${m.rank} 名` : ''}`;
  else if (m) sub.textContent = '今天已挑戰 · 明天再來';
  else sub.textContent = dailyHomeN.key === key && dailyHomeN.n ? `#${dailyNo(key)} · 已有 ${dailyHomeN.n} 人完成` : `#${dailyNo(key)} · 每天一題比排名`;
  if (m?.win && !m.sent) resendDaily(key);
  if (m || performance.now() - dailyHomeAt < 60000) return;
  dailyHomeAt = performance.now();
  board(key).then((rows) => {
    if (rows) dailyHomeN = { key, n: rows.length };
    if (rows && rows.length && !myDay(key) && todayKey() === key) sub.textContent = `#${dailyNo(key)} · 已有 ${rows.length} 人完成`;
  });
}

function initDaily() {
  $('#btn-daily').onclick = openDaily;
  $('#daily-close').onclick = () => { $('#daily-modal').hidden = true; };
  $('#daily-modal').addEventListener('click', (e) => { if (e.target.id === 'daily-modal') $('#daily-modal').hidden = true; });
  $('#daily-go').onclick = dailyGo;
  $('#daily-confirm-go').onclick = () => { $('#daily-confirm').hidden = true; startDaily(); };
  $('#daily-confirm-no').onclick = () => { $('#daily-confirm').hidden = true; };
  $('#daily-confirm').addEventListener('click', (e) => { if (e.target.id === 'daily-confirm') $('#daily-confirm').hidden = true; });
  $('#daily-share').onclick = () => shareDaily(todayKey());
  $('#dres-share').onclick = () => { const k = $('#daily-result').dataset.key; if (k) shareDaily(k); };
  $('#dres-board').onclick = openDaily;
  refreshDailyHome();
}

// 單人訓練：回首頁，清掉這一局
function exitSolo() {
  state.solo = false;
  state.daily = null;
  state.game = null;
  setConn('');
  show('home');
}

// ---------- 比賽 ----------
function createGame(settings, id) {
  state.myReady = false;
  state.settings = settings;
  // 搶分賽：每個人自己的起點終點會一直換，用自己的一份設定
  const rush = settings.goal === 'rush';
  // 房間的設定不留題目的起點終點（回房間改玩一般對局時，路線欄位還是空的＝隨機）
  if (rush) { state.settings = { ...settings, start: '', target: '' }; settings = { ...settings, rush: undefined }; }
  if (net.isHost) state.hostLocked = true;
  const others = new Map(opponents().map((p) => [p.id, {
    id: p.id, name: p.name, avatar: p.avatar, color: p.color,
    clicks: 0, current: settings.start, path: [], near: false, finished: null, left: false, offline: p.online === false,
  }]));
  state.game = {
    id,
    settings,
    mode: state.mode,
    others,
    startAt: 0,
    clicks: 0,
    path: [],
    stack: [],
    spots: [],  // 跟 stack 一一對應：離開那一頁時點的是哪個連結、在畫面哪裡，按上一頁時捲回去
    current: null,
    loading: false,
    near: false,
    finished: null,
    lastSecond: null,
    lastCallEnd: 0,
    lastCallSent: false,
    hint: { offered: false, shown: false, myVote: false, yes: [], need: 0, votes: new Set() },
    hint2: { offered: false, shown: false, myVote: false, yes: [], need: 0, votes: new Set(), near: [] },  // 5 分鐘的第二個提示
    timer: null,
    heart: null,
  };
  targetSet(settings);  // 先查好終點的別名，第一頁就能標出金色連結
  if (rush) Object.assign(state.game, { rushQ: cleanRushQ(state.settings.rush), rushIdx: 0, score: 0, scoreAt: 0, skips: RUSH_SKIPS, rushWait: false, rushDone: [] });
  const party = isParty();
  const me = state.players.get(state.myId);
  $('#hud-target').textContent = tw(settings.target);
  $('#hud-clicks').textContent = '0';
  $('#hud-clicks').parentElement.lastChild.textContent = rush ? ' 分' : ' 步';
  $('#btn-rush-skip').hidden = !rush;
  disarmSkip();
  $('#btn-rush-skip').disabled = false;
  $('#hud-timer').textContent = settings.timeLimit ? fmtTime(settings.timeLimit * 1000) : '00:00';
  $('#hud-timer').className = 'hud-timer';
  paintAvatar($('#hud-me-avatar'), { name: state.myName, avatar: state.myAvatar });
  $('#hud-me-avatar').style.setProperty('--side', party && me ? me.color : '');
  $('#hud-strip').hidden = !party;
  $('#hud-timer').classList.remove('sprint');
  $('#items-modal').hidden = true;
  $('#hud').classList.remove('compact');
  $('#hint-bar').hidden = true;
  $('#btn-hint-open').hidden = true;
  $('#btn-hint-open').textContent = '💡 提示';
  $('#hint-near').hidden = true;
  closeHint();
  renderOppHud();
  $('#hud-alert-opp').hidden = true;
  $('#hud-alert-me').hidden = true;
  $('#hud').classList.remove('danger');
  $('#hud-path').replaceChildren();
  $('#path-count').textContent = '0';
  $('#path-drawer').hidden = true;
  $('#feed').replaceChildren();
  $('#btn-back').hidden = !settings.allowBack;
  $('#btn-back').disabled = true;
  $('#btn-find').hidden = !settings.allowFind;
  clearNewbie();
  closeFind();
  $('#article').replaceChildren();
  $('#article-credit').replaceChildren();
  $('#article-title').textContent = '';
  $('#breadcrumb').textContent = '';
  music.stop();
  music.setIntensity(0);
  $('#brief-start').textContent = tw(settings.start);
  $('#brief-target').textContent = tw(settings.target);
  const goal = cleanGoal(settings.goal);
  $('#brief-goal').textContent = `${GOALS[goal].icon} ${GOALS[goal].name}：${GOALS[goal].brief}`;
  $('#brief-goal').classList.toggle('steps', goalClass(goal) === 'steps');
  $('#brief-goal').classList.toggle('items', goalClass(goal) === 'items');
  renderGoal();
  resetItems();
  return state.game;
}

function startGame(settings, id) {
  createGame(settings, id);
  show('game');

  // 先在背景載入起點條目，倒數結束時直接顯示
  const preload = wiki.fetchArticle(settings.lang, settings.start);
  preload.catch(() => {});

  const overlay = $('#countdown');
  const num = $('#countdown-num');
  overlay.hidden = false;
  const ring = $('#count-ring');
  ring.style.transition = 'none';
  ring.style.strokeDashoffset = '0';
  ring.style.stroke = '';
  void ring.getBoundingClientRect();
  ring.style.transition = '';
  const showNum = (txt, isGo) => {
    num.textContent = txt;
    ring.style.strokeDashoffset = String(339.3 * (isGo ? 1 : (3 - Number(txt) + 1) / 3));
    if (isGo) ring.style.stroke = 'var(--green)';
    num.classList.toggle('go', !!isGo);
    num.classList.remove('pop');
    void num.offsetWidth;
    num.classList.add('pop');
  };
  let n = 3;
  showNum(n);
  sfx.count();
  haptic('countdown');
  const g = state.game;
  const iv = setInterval(() => {
    if (state.game !== g || g.finished) { clearInterval(iv); return; }
    n--;
    if (n > 0) { showNum(n); sfx.count(); haptic('countdown'); return; }
    clearInterval(iv);
    showNum('GO!', true);
    sfx.go();
    haptic('go');
    flash('#14866d');
    music.play('race');
    setTimeout(() => { overlay.hidden = true; }, 450);
    g.startAt = performance.now();
    g.timer = setInterval(tick, 200);
    syncRoom(true);
    goTo(settings.start, { first: true, preload });
    if (isRush(g)) { renderRush(g); setTimeout(() => rushFill(g), 1500); return; }
    // 起點讀完之後就開始在背景找最佳解答（不跟第一頁搶網路）
    setTimeout(() => prefetchSolution(g), 4000);
  }, 1000);
}

// 房主：給重新連線的玩家一份目前的比賽狀態
function gameSnapshot() {
  const g = state.game;
  if (!g) return null;
  const progress = {
    [state.myId]: {
      clicks: g.finished?.clicks ?? g.clicks, current: g.current || g.settings.start, path: g.finished?.path || g.path,
      near: g.near, finished: g.finished, left: false,
      ...(isRush(g) ? { score: g.score, qi: g.rushIdx, sk: g.skips, at: g.scoreAt, rr: g.rushDone } : {}),
    },
  };
  for (const o of g.others.values()) {
    progress[o.id] = { clicks: o.clicks, current: o.current, path: o.path, near: o.near, finished: o.finished, left: o.left, ...(isRush(g) ? rushFields(o) : {}) };
  }
  return {
    id: g.id, settings: isRush(g) ? { ...g.settings, rush: g.rushQ } : g.settings, mode: g.mode, players: [...state.players.values()],
    elapsed: g.startAt ? performance.now() - g.startAt : 0,
    lastCall: g.lastCallEnd ? Math.max(0, g.lastCallEnd - performance.now()) : 0,
    hint: g.hint.shown,
    hint2: g.hint2?.shown ? g.hint2.near : null,
    progress,
  };
}

function applyProgress(o, p) {
  if (!o || !p) return;
  o.clicks = p.clicks ?? o.clicks;
  o.current = p.current || o.current;
  if (Array.isArray(p.path)) o.path = p.path;
  o.near = !!p.near;
  if (p.finished && !o.finished) o.finished = p.finished;
  if (p.left) o.left = true;
  if (p.score !== undefined) Object.assign(o, rushFields(p, o));
}
// 搶分賽的分數欄位（別人傳來的，數字要檢查）
const rushNum = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v)) || 0));
function rushFields(m, o = {}) {
  return { score: rushNum(m.score ?? o.score, 999), qi: rushNum(m.qi ?? o.qi, 999), sk: rushNum(m.sk ?? o.sk ?? RUSH_SKIPS, RUSH_SKIPS), at: rushNum(m.at ?? o.at, 864e5), rr: cleanRoutes(m.rr ?? o.rr) };
}

// 玩家：重新整理後從房主給的狀態接回比賽
function resumeGame(snap) {
  state.mode = snap.mode === 'party' ? 'party' : 'duel';
  state.players = new Map((snap.players || []).map((p) => [p.id, { ...p, avatar: cleanAvatar(p.avatar) }]));
  const g = createGame({ ...DEFAULT_SETTINGS, ...snap.settings }, snap.id);
  // 已經比完的人先記下來，等比賽接回去之後再處理（對決時對手已經抵達就要直接判輸）
  const done = [];
  for (const [id, p] of Object.entries(snap.progress || {})) {
    if (id === state.myId || !g.others.get(id)) continue;
    applyProgress(g.others.get(id), { ...p, finished: null });
    if (p.finished) done.push([id, p.finished]);
  }
  const mine = snap.progress?.[state.myId] || {};
  if (isRush(g)) {
    // 搶分賽：接回自己做到第幾題、幾分
    const r = rushFields(mine);
    Object.assign(g, { score: r.score, rushIdx: r.qi, skips: r.sk, scoreAt: r.at, rushDone: r.rr });
    const q = g.rushQ[g.rushIdx];
    if (q) { g.settings.start = q.s; g.settings.target = q.t; $('#hud-target').textContent = tw(q.t); }
  }
  g.startAt = performance.now() - (snap.elapsed || 0);
  g.clicks = mine.clicks || 0;
  g.path = Array.isArray(mine.path) ? mine.path.slice() : [];
  const nav = loadNav(g.id, mine.current || g.settings.start, g.path);
  if (nav) { g.stack = nav.stack; g.spots = nav.spots; } else { g.stack = g.path.slice(0, -1); g.spots = g.stack.map(() => null); }
  if (snap.lastCall > 0) g.lastCallEnd = performance.now() + snap.lastCall;
  // 等畫面接好再打開提示；這段時間如果已經換成別局就不要套上去
  if (snap.hint) setTimeout(() => { if (state.game === g) showHint({ quiet: true }); }, 800);
  if (Array.isArray(snap.hint2)) setTimeout(() => { if (state.game === g) showHint2(snap.hint2, { quiet: true }); }, 900);
  renderOppHud();
  show('game');
  $('#countdown').hidden = true;
  if (mine.finished) {
    g.finished = mine.finished;
    for (const [id, f] of done) applyProgress(g.others.get(id), { finished: f, clicks: f.clicks, path: f.path });
    // 這一局的戰績在重新整理前已經記過了
    g.restored = true;
    showResult();
    return;
  }
  toast('已重新連線，繼續比賽！', 2500);
  music.play('race');
  g.timer = setInterval(tick, 200);
  if (isRush(g)) {
    renderRush(g);
    if (net.isHost) setTimeout(() => rushFill(g), 1500);
    // 斷線前剛好答對（還停在上一題的終點）：直接開下一題
    if (!g.path.length || g.path[0] !== g.settings.start) { g.path = []; g.stack = []; g.spots = []; rushGo(g); for (const [id, f] of done) onOtherFinish(id, f); return; }
  }
  goTo(mine.current || g.settings.start, { restore: true });
  for (const [id, f] of done) onOtherFinish(id, f);
}

// 右上角：對決模式顯示對手；派對模式顯示抵達人數，並在下方列出每個人
function renderOppHud() {
  const g = state.game;
  if (!g) return;
  const list = [...g.others.values()];
  if (g.mode !== 'party') {
    const o = list[0];
    $('#hud-opp-name').textContent = o?.name || '對手';
    paintAvatar($('#hud-opp-avatar'), o);
    $('#hud-opp-avatar').style.removeProperty('--side');
    $('#hud-opp-clicks').textContent = o ? (isRush(g) ? o.score || 0 : o.clicks) : 0;
    $('#hud-opp-clicks').parentElement.lastChild.textContent = isRush(g) ? ' 分' : ' 步';
    let where = '';
    if (isRush(g) && o && !o.left && !o.offline) where = o.finished ? `${o.name} 已結束（${o.score || 0} 分）` : `${o.name} 正在找第 ${(o.qi || 0) + 1} 題`;
    else if (o?.finished?.reason === 'win') where = `${o.name} 已用 ${o.finished.clicks} 步抵達`;
    else if (o?.left) where = `${o.name} 已離線`;
    else if (o?.offline) where = `${o.name} 斷線中，等待重新連線…${waitLeft(o)}`;
    else if (o) {
      // 例如「小華 在「英格蘭西北部城市」 · 差 1 步！」或只有「小華 · 約差 2 步」
      const at = oppWhere(g, o);
      where = [at ? `${o.name} 在${at}` : distLabel(o.dist) && o.name, distLabel(o.dist)].filter(Boolean).join(' · ');
    }
    $('#hud-opp-page').textContent = where;
    $('#hud-opp').classList.toggle('offline', !!o?.offline);
    return;
  }
  const arrived = list.filter((o) => o.finished?.reason === 'win').length + (g.finished?.reason === 'win' ? 1 : 0);
  $('#hud-opp-name').textContent = `${list.length} 位對手`;
  $('#hud-opp-avatar').replaceChildren(String(list.length));
  $('#hud-opp-avatar').classList.remove('has-img');
  $('#hud-opp-avatar').style.setProperty('--side', '#ffb020');
  $('#hud-opp-clicks').textContent = isRush(g) ? String(Math.max(0, ...list.map((o) => o.score || 0))) : `${arrived}/${list.length + 1}`;
  $('#hud-opp-clicks').parentElement.lastChild.textContent = isRush(g) ? ' 分最高' : ' 抵達';
  $('#hud-opp-page').textContent = '';
  const chips = list.map((o) => {
    const li = document.createElement('li');
    li.className = 'strip-chip';
    if (o.finished?.reason === 'win') li.classList.add('done');
    if (o.left || (o.finished && o.finished.reason !== 'win')) li.classList.add('out');
    if (o.offline && !o.left) li.classList.add('out');
    if (o.near && !o.finished) li.classList.add('near');
    li.dataset.id = o.id;
    li.append(avatarEl(o, 'sm'));
    const info = document.createElement('span');
    info.className = 'strip-info';
    const label = isRush(g) ? (o.left ? `離線 · ${o.score || 0} 分` : o.offline ? `斷線${waitLeft(o, true)}` : `${o.score || 0} 分 · 第 ${(o.qi || 0) + 1} 題`) : o.finished?.reason === 'win' ? '抵達！' : o.left ? '離線' : o.finished ? '出局' : o.offline ? `斷線${waitLeft(o, true)}` : `${o.clicks} 步`;
    info.append(Object.assign(document.createElement('b'), { textContent: o.name }), Object.assign(document.createElement('span'), { textContent: label }));
    const here = isRush(g) ? '' : [oppWhere(g, o).replace(/^[《「]|[》」]$/g, ''), distLabel(o.dist)].filter(Boolean).join(' · ');
    if (here && !o.finished && !o.left && !o.offline) info.append(Object.assign(document.createElement('small'), { textContent: here }));
    li.append(info);
    return li;
  });
  $('#hud-strip').replaceChildren(...chips);
}

// 離終點多遠（只說大概，不說在哪個條目，免得被照抄路線）
const distLabel = (d) => ({ 1: '差 1 步！', 2: '約差 2 步', 3: '還很遠' }[d] || '');
// 舊版只有開或關（showOpponentPage），新版分三種
const oppViewOf = (s) => (['dist', 'hint', 'full'].includes(s?.oppView) ? s.oppView : s?.showOpponentPage ? 'full' : 'hint');

// 對手在哪裡：依房間設定顯示完整條目、模糊的條目簡介，或只有離終點多遠
function oppWhere(g, o) {
  const view = oppViewOf(g.settings);
  if (view === 'full') return `《${tw(o.current)}》`;
  if (view === 'hint' && o.desc) return `「${o.desc}」`;
  return '';
}

function elapsed() {
  const g = state.game;
  return g && g.startAt ? performance.now() - g.startAt : 0;
}

let runSavedAt = 0;
function tick() {
  const g = state.game;
  if (!g || g.finished) return;
  // 每日挑戰：每 5 秒記一次進度（中途跳掉 3 分鐘內可以接著玩）
  if (state.daily?.started && performance.now() - runSavedAt > 5000) { runSavedAt = performance.now(); saveDailyRun(g); }
  const ms = elapsed();
  const limit = g.settings.timeLimit * 1000;
  const timer = $('#hud-timer');
  let left = limit ? limit - ms : Infinity;
  timer.textContent = limit ? fmtTime(left) : fmtTime(ms);

  // 派對模式的最後衝刺：計時器直接改成衝刺倒數
  if (g.lastCallEnd) {
    const lc = g.lastCallEnd - performance.now();
    left = Math.min(left, lc);
    timer.textContent = fmtTime(Math.max(0, lc));
    timer.classList.add('sprint');
  }

  if (left !== Infinity) {
    timer.classList.toggle('warn', left < 60000 && left >= 10000);
    timer.classList.toggle('crit', left < 10000);
    // 最後 10 秒每秒滴答
    const sec = Math.ceil(left / 1000);
    if (left < 10000 && sec !== g.lastSecond) { g.lastSecond = sec; sfx.tick(); haptic('light'); }
  }
  updateIntensity(left);
  syncRoom();
  if (g.fx) applyFx();
  if (isItems(g)) itemClock(g);
  // 搶分賽題目一直換，不用投票提示
  if (!isRush(g) && ms >= HINT_AFTER && !g.hint.offered && !g.hint.shown) offerHint();
  if (!isRush(g) && ms >= HINT2_AFTER && !g.hint2.offered && !g.hint2.shown) offerHint(2);
  if (left <= 0) finishGame('timeout');
}

// 音樂隨局勢加快：有對手接近終點或剩不到一分鐘時加速，最後 15 秒再加速
function updateIntensity(left = Infinity) {
  const g = state.game;
  const oppNear = [...g.others.values()].some((o) => o.near && !o.finished);
  let lvl = 0;
  if (oppNear || g.near || left < 60000) lvl = 1;
  if (left < 15000 || (oppNear && g.near)) lvl = 2;
  music.setIntensity(lvl);
}

async function goTo(title, { first = false, back = false, restore = false, preload = null, from = null, spot = null } = {}) {
  const g = state.game;
  if (!g || g.finished || g.loading) return;
  g.loading = true;
  closeFind();
  $('#article-loading').hidden = false;
  if (!first && !restore) sfx.click();
  try {
    // 被蝸牛黏住：換頁要多等一下
    if (fxOn(g, 'snail')) await new Promise((r) => { setTimeout(r, 2000); });
    const art = await (preload || wiki.fetchArticle(g.settings.lang, title));
    await zhReady;
    if (g !== state.game || g.finished) return;
    if (restore) {
      // 接回比賽：步數與路線沿用之前的，不重算
      if (g.path[g.path.length - 1] !== art.title) g.path.push(art.title);
    } else {
      if (!first) {
        // 道具：重擔這一步算 2 步、免費一步這一步不算
        let n = 1;
        if (isItems(g) && fxOn(g, 'free')) { n = 0; g.fx.free = 0; showHit('👟', '這一步免費，不算步數！', true); }
        else if (isItems(g) && fxOn(g, 'heavy')) { n = 2; g.fx.heavy = 0; showHit('🎒', '好重！這一步算 2 步'); }
        if (isItems(g)) applyFx();
        g.clicks += n;
        itemStep(g);
      }
      if (g.current && !back) { g.stack.push(g.current); g.spots.push(from); }
      g.path.push(art.title);
    }
    g.current = art.title;
    saveNav(g);
    if (state.daily) saveDailyRun(g);
    reportActivity();
    renderArticle(art);
    if (spot) restoreSpot(spot);
    if (first && state.daily && !state.daily.started) {
      state.daily.started = true;
      // 起點載入了才算正式開始：從這一刻起中途離開、投降都不能重來
      if (state.daily.first) { saveDay(state.daily.key, { tried: 1, n: state.myName, a: state.myAvatar || '' }); saveDailyRun(g); }
    }
    renderBreadcrumb(g);
    $('#hud-clicks').textContent = isRush(g) ? g.score : g.clicks;
    fillPath($('#hud-path'), g.path, g.settings.target);
    $('#path-count').textContent = g.path.length;
    $('#btn-back').disabled = g.stack.length === 0;

    const reached = art.title === g.settings.target || isTargetLink(art.title, g.settings);  // 終點用別的名字（重新導向、簡繁）也算
    const near = !reached && !!$('#article a.is-target');
    if (near && !g.near) { sfx.near(); haptic('success'); }
    g.near = near;
    $('#hud-alert-me').hidden = !near;
    $('#hud-alert-me').textContent = '終點連結就在這一頁！快找！';

    g.dist = distanceHere(g);
    sendProgress({ t: 'progress', title: art.title, clicks: g.clicks, near, path: g.path, d: g.dist ?? undefined });
    if (oppViewOf(g.settings) === 'hint') {
      const here = art.title;
      wiki.describe(g.settings.lang, here).then(async (d) => {
        if (!d || state.game !== g || g.finished || g.current !== here) return;
        await zhReady;
        const desc = maskTitle(g.settings.lang === 'zh' ? tw(d) : d, here, g.settings.lang).slice(0, 40);
        sendProgress({ t: 'progress', title: here, clicks: g.clicks, near: g.near, path: g.path, d: g.dist ?? undefined, desc });
      });
    }
    if (reached && isRush(g)) rushScore(g);
    else if (reached) finishGame('win');
    else {
      renderGoal();
      if (!checkOutstepped() && first) setTimeout(runCoach, 400);
      if (g.settings.newbie) newbieStep(g);
    }
  } catch (e) {
    reportError('article', e);
    toast(`載入失敗：${e.message}`);
  } finally {
    g.loading = false;
    $('#article-loading').hidden = true;
  }
}

// 房主自己的進度要標上 id 廣播；玩家則交給房主轉發
function sendProgress(msg) {
  // 搶分賽：每個人的終點不一樣，不送遠近和所在位置，改送分數、第幾題、還能跳過幾次
  const g = state.game;
  if (isRush(g) && (msg.t === 'progress' || msg.t === 'finish')) {
    msg = { ...msg, near: false, d: undefined, desc: undefined, score: g.score, qi: g.rushIdx, sk: g.skips, at: g.scoreAt, rr: g.rushDone };
  }
  if (net.isHost) net.send({ ...msg, id: state.myId });
  else net.send(msg);
}

function renderBreadcrumb(g) {
  const bc = $('#breadcrumb');
  const shown = g.path.slice(-4);
  const parts = [];
  if (g.path.length > shown.length) parts.push('…');
  shown.forEach((t, i) => {
    if (i === shown.length - 1) parts.push(Object.assign(document.createElement('span'), { className: 'here', textContent: tw(t) }));
    else parts.push(tw(t));
  });
  bc.replaceChildren('路線：');
  parts.forEach((p, i) => { if (i) bc.append(' › '); bc.append(p); });
}

function renderArticle(art) {
  fillArticle($('#article'), $('#article-title'), art, state.game.settings);
  window.scrollTo(0, 0);
}

// 記住點的是哪個連結：同一個關鍵字在一頁裡可能出現好幾次，記第幾個，還有它當時在畫面上的高度
function linkSpot(a) {
  const title = a.dataset.title;
  const same = [...$('#article').querySelectorAll('a.wl')].filter((x) => x.dataset.title === title);
  return { title, k: Math.max(0, same.indexOf(a)), top: a.getBoundingClientRect().top };
}

// 按上一頁回來時，捲回剛剛點的那個連結並閃一下，長條目也不用重新找
function restoreSpot(spot) {
  const same = [...$('#article').querySelectorAll('a.wl')].filter((x) => x.dataset.title === spot.title);
  const a = same[spot.k] || same[0];
  if (!a) return;
  // 盡量放回原本的高度，但不要被上方資訊列（派對模式、橫向時會比較高）或下方按鈕擋住
  const below = $('#hud').getBoundingClientRect().bottom + 16;
  const top = Math.max(Math.min(Math.max(spot.top, innerHeight * 0.25), innerHeight * 0.6), below);
  window.scrollTo(0, Math.max(0, a.getBoundingClientRect().top + scrollY - top));
  a.classList.remove('back-here');
  void a.offsetWidth;
  a.classList.add('back-here');
  setTimeout(() => a.classList.remove('back-here'), 2600);
}

// 把條目內容放進畫面：比賽和觀戰共用
// 終點的所有名字（重新導向、簡繁寫法）：條目裡的連結常常用別的名字連到終點，也要標成金色
const nameKey = (lang) => (lang === 'zh' ? (t) => tw(t) : (t) => t);
const targetNames = new Map();  // 「語言:終點」→ 名字的集合（還在查就是 Promise）
function targetSet(settings) {
  if (!settings?.target) return null;
  const k = `${settings.lang}:${settings.target}`;
  const v = targetNames.get(k);
  if (v instanceof Set) return v;
  if (!v) {
    targetNames.set(k, namesOf(settings.lang, settings.target, nameKey(settings.lang)).then(
      (set) => { targetNames.set(k, set); return set; },
      () => { targetNames.delete(k); return null; },
    ));
  }
  return null;
}
const isTargetLink = (t, settings, names = targetSet(settings)) => {
  const key = nameKey(settings.lang);
  return t === settings.target || key(t) === key(settings.target) || !!names?.has(key(t));
};
// 終點的別名查好之後，把這一頁漏掉的終點連結補標起來；比賽中的話也補上「終點就在這一頁」
function markTargets(root, settings, names) {
  let added = false;
  for (const a of root.querySelectorAll('a.wl:not(.is-target)')) {
    if (isTargetLink(a.dataset.title, settings, names)) { a.classList.add('is-target'); added = true; }
  }
  const g = state.game;
  if (!added || root !== $('#article') || !g || g.settings !== settings || g.finished || g.loading || g.near) return;
  g.near = true;
  sfx.near();
  haptic('success');
  $('#hud-alert-me').hidden = false;
  $('#hud-alert-me').textContent = '終點連結就在這一頁！快找！';
  g.dist = 1;
  sendProgress({ t: 'progress', title: g.current, clicks: g.clicks, near: true, path: g.path, d: 1 });
  if (g.settings.newbie) newbieStep(g);
}

function fillArticle(root, titleEl, art, settings) {
  const tmp = document.createElement('div');
  tmp.innerHTML = art.displayTitle || art.title;
  titleEl.textContent = tw(tmp.textContent);

  root.innerHTML = art.html;
  // 拿掉點不了的引用標記與參考文獻，條目比較清爽
  root.querySelectorAll('.mw-editsection, .mw-empty-elt, script, iframe, object, embed, sup.reference, .reflist, ol.references, .mw-references-wrap').forEach((el) => el.remove());
  // 條目內容只當文字和連結用：拿掉裡面「點了就執行」的程式（例如維基百科手機版章節標題的 onclick="mfTempOpenSection(…)"，
  // 我們這裡沒有那個函式，點了會報錯）和 javascript: 連結
  for (const el of root.querySelectorAll('*')) {
    for (const at of [...el.attributes]) {
      if (/^on/i.test(at.name) || (/^(href|src|xlink:href)$/i.test(at.name) && /^\s*javascript:/i.test(at.value))) el.removeAttribute(at.name);
    }
  }
  root.querySelectorAll('img').forEach((img) => { img.loading = 'lazy'; img.decoding = 'async'; });
  // 表格裡字多的格子給夠寬度（手機上表格在自己的框裡左右捲，不要把文字擠成一個字一行）
  root.querySelectorAll('td, th').forEach((c) => { const n = c.textContent.trim().length; if (n > 24) c.classList.add('cell-long'); else if (n > 8) c.classList.add('cell-mid'); });
  if (settings.lang === 'zh') twTree(root);
  const names = targetSet(settings);
  root.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    const t = wiki.linkToTitle(href, art.prefixes);
    if (t) {
      a.dataset.title = t;
      a.classList.add('wl');
      if (isTargetLink(t, settings, names)) a.classList.add('is-target');
    } else {
      a.classList.add('dead');
    }
    a.removeAttribute('target');
  });
  // 終點的別名還在查：查好再補標（這一頁還在畫面上才補）
  root.dataset.page = art.title;
  if (!names && settings.target) {
    const pending = targetNames.get(`${settings.lang}:${settings.target}`);
    const target = settings.target;
    pending?.then?.((set) => { if (set && root.isConnected && root.dataset.page === art.title && settings.target === target) markTargets(root, settings, set); });
  }
  // 維基百科的內容依 CC BY-SA 授權：每一頁下面標出處和授權
  const credit = root.parentElement?.querySelector('.wiki-credit');
  if (credit) {
    const name = settings.lang === 'zh' ? tw(art.title) : art.title;
    const link = (href, text) => Object.assign(document.createElement('a'), { href, textContent: text, target: '_blank', rel: 'noopener' });
    credit.replaceChildren('本頁內容取自維基百科條目', link(wiki.articleUrl(settings.lang, art.title), `《${name}》`), '，依 ', link('https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hant', 'CC BY-SA 4.0'), ' 授權使用。');
  }
}

// ---------- 管理員觀戰：管理員從後台要看的時候，把畫面送給他（畫面上方會顯示「管理員正在觀戰」） ----------
let adminWatching = false;
let lastView = null;
let lastTap = null;
function pushAdminLive() {
  if (!adminWatching) return;
  const g = state.game;
  const racing = g && ['game', 'result', 'watch'].includes(state.view);
  if (!racing) { sendLiveToAdmin({ idle: true, s: state.view }); return; }
  const cur = g.current || g.settings.start;
  const v = lastView?.p === cur ? lastView : { i: 0, f: 0 };
  const data = {
    p: String(cur).slice(0, 200), i: v.i, f: v.f, k: g.finished?.clicks ?? g.clicks ?? 0,
    path: cleanPath(g.finished?.path || g.path).slice(-40).map((t) => t.slice(0, 200)),
    st: String(g.settings.start).slice(0, 200), tg: String(g.settings.target).slice(0, 200), lang: g.settings.lang === 'en' ? 'en' : 'zh',
    el: Math.round(g.finished?.elapsed ?? elapsed()), fin: g.finished?.reason || '', near: !!g.near, gid: String(g.id || '').slice(0, 40),
  };
  if (lastTap?.p === cur) { data.n = lastTap.n; data.tapAt = lastTap.at; }
  sendLiveToAdmin(data);
}
onSpy((on) => {
  adminWatching = on;
  $('#admin-eye').hidden = !on;
  if (on) { toast('👀 管理員正在觀戰你的畫面', 3000); pushAdminLive(); }
});

// ---------- 被管理員踢出伺服器：馬上斷線，期限內整個遊戲都擋住 ----------
let banned = false;
function applyBan(b) {
  if (!b || !(b.until > Date.now())) {
    store.set('wikirace-ban', '');
    if (banned) { banned = false; $('#ban-until').textContent = '已經解除了，馬上帶你回到遊戲…'; setTimeout(() => location.reload(), 1500); }
    return;
  }
  store.set('wikirace-ban', JSON.stringify({ until: b.until }));  // 這支手機也記住（重新整理也一樣擋）
  const forever = b.until - Date.now() > 3650 * 864e5;
  $('#ban-until').textContent = forever ? '你已經不能再進入這個遊戲。' : `${new Date(b.until).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 之後才能再回來。`;
  $('#ban-screen').hidden = false;
  if (banned) return;
  banned = true;
  leaveOnline();
  // 離開房間、斷線（房主被踢：其他人會自動接手房間）
  leavingRoom = true;
  if (net.code && !net.isHost) net.send({ t: 'bye' });
  session.clear();
  hosted.clear();
  stopControlWatch();
  setTimeout(() => net.destroy(), 200);
  if (state.game && !state.game.finished) abandonGame();
  state.game = null;
  state.solo = false;
  state.daily = null;
  try { music.stop?.(); } catch { /* 忽略 */ }
  show('home');
  setConn('');
}
onBan(applyBan);

// 管理員觀戰時傳來的話：跳一個小視窗（同一則只顯示一次，重新整理也不會再跳）
onAdminMsg(({ text, id }) => {
  let seen = [];
  try { seen = (sessionStorage.getItem('wikirace-admin-msg') || '').split('\n'); } catch { /* 忽略 */ }
  if (seen.includes(id)) return;
  try { sessionStorage.setItem('wikirace-admin-msg', [...seen.slice(-20), id].join('\n')); } catch { /* 忽略 */ }
  $('#admin-msg-text').textContent = text;
  $('#admin-msg-pop').hidden = false;
  sfx.ready();
  haptic('medium');
});
$('#admin-msg-ok').onclick = () => { $('#admin-msg-pop').hidden = true; };

// 管理員那一邊（後台按「觀戰」打開 ?adminwatch=<key>）：用觀戰畫面顯示那位玩家
async function startAdminWatch(firstKey) {
  need('admin');
  document.body.classList.add('admin-watching');
  // 後台的多人觀戰把這一頁嵌在格子裡：只顯示畫面
  const embed = new URLSearchParams(location.search).has('embed');
  document.body.classList.toggle('admin-embed', embed);
  state.adminWatch = true;
  const o = { id: 'p', name: '玩家', avatar: '', color: COLORS[1], clicks: 0, current: '', path: [], near: false, finished: null, left: false, offline: false };
  const g = { id: null, finished: { reason: 'watch' }, others: new Map([['p', o]]), settings: { ...DEFAULT_SETTINGS }, startAt: performance.now(), mode: 'duel' };
  state.game = g;
  state.watch = { id: 'p', shown: null, token: 0, follow: true, ready: false, live: {} };
  show('watch');
  $('.live-badge').lastChild.textContent = '管理員觀戰中';
  $('#btn-watch-back').onclick = () => { location.href = 'admin.html'; };
  $('#btn-watch-back').setAttribute('aria-label', '回到後台');
  const status = (t) => { $('#watch-status').textContent = t; $('#watch-status').className = ''; };
  status('連線中…');
  const db = await getDb();
  if (!db) { status('連不上資料庫'); return; }
  const denied = () => status('沒有權限：請先在後台用 Google 登入，並更新資料庫規則');
  let cur = null;  // 正在看的玩家：{ key, spy, whoRef, liveRef, whoCb, liveCb }
  // 每 20 秒告訴玩家「管理員還在看」；關掉分頁或換人時收掉
  // 用 update：不要蓋掉剛傳給玩家的訊息
  const beat = () => { if (cur) cur.spy.update({ at: window.firebase.database.ServerValue.TIMESTAMP }).catch(denied); };
  // 傳一句話給正在看的玩家（他的畫面會跳出來）
  $('#admin-say').hidden = embed;
  $('#admin-say').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#admin-say-text').value.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!text || !cur) return;
    const who = o.name;
    cur.spy.update({ msg: { text, id: Date.now() }, at: window.firebase.database.ServerValue.TIMESTAMP }).then(() => {
      $('#admin-say-text').value = '';
      toast(`已傳給 ${who}`);
      db.ref('audit').push({ at: Date.now(), a: '傳訊息給玩家', d: `${who}：${text}`.slice(0, 200) }).catch(() => {});
    }, denied);
  };
  setInterval(beat, 20000);
  window.addEventListener('pagehide', () => { try { cur?.spy.remove(); } catch { /* 忽略 */ } });
  setInterval(() => { if (!o.current) $('#watch-timer').textContent = '--:--'; else if (!o.finished) $('#watch-timer').textContent = fmtTime(elapsed()); }, 500);

  // 換看另一位玩家：前一位的「管理員正在觀戰」會消失
  const watchKey = (key) => {
    if (cur?.key === key) return;
    if (cur) {
      try { cur.spy.onDisconnect().cancel(); cur.spy.remove().catch(() => {}); } catch { /* 忽略 */ }
      cur.whoRef.off('value', cur.whoCb);
      cur.liveRef.off('value', cur.liveCb);
    }
    Object.assign(o, { name: '玩家', avatar: '', clicks: 0, current: '', path: [], near: false, finished: null, left: false });
    g.settings = { ...DEFAULT_SETTINGS };
    g.startAt = performance.now();
    state.watch = { id: 'p', shown: null, token: (state.watch.token || 0) + 1, follow: true, ready: false, live: {} };
    $('#watch-goal').textContent = '—';
    $('#watch-title').textContent = '';
    $('#watch-path').textContent = '';
    $('#watch-steps').textContent = '0';
    $('#watch-article').replaceChildren();
    window.scrollTo(0, 0);
    status('連線中…');
    const spy = db.ref(`spy/${key}`);
    spy.onDisconnect().remove();
    cur = { key, spy, whoRef: db.ref(`who/${key}`), liveRef: db.ref(`live/${key}`) };
    const mine = cur;
    let lastTapAt = 0;
    let lastGame = null;
    // 名字、頭像、還在不在線上
    cur.whoCb = cur.whoRef.on('value', (snap) => {
      if (cur !== mine) return;
      const w = snap.val();
      if (!w) { o.left = true; renderWatch(); status('玩家已經離開遊戲了'); return; }
      o.name = w.n || '玩家';
      o.avatar = cleanAvatar(w.av);
      renderWatch();
    }, denied);
    cur.liveCb = cur.liveRef.on('value', (snap) => {
      if (cur !== mine) return;
      const v = snap.val();
      if (!v) { status('等待玩家的畫面…'); return; }
      if (v.idle) { status(v.s === 'room' ? '在房間裡，還沒開始比賽' : '在首頁，還沒開始比賽'); return; }
      if (v.gid !== lastGame) {
        // 換了一局（或剛開始看）：重新設定題目
        lastGame = v.gid;
        g.settings = { ...DEFAULT_SETTINGS, lang: v.lang === 'en' ? 'en' : 'zh', start: v.st, target: v.tg };
        $('#watch-goal').textContent = tw(v.tg);
        state.watch.shown = null;
        state.watch.live = {};
      }
      const moved = o.clicks !== v.k || o.current !== v.p;
      o.current = v.p;
      o.clicks = Number(v.k) || 0;
      o.path = Array.isArray(v.path) ? v.path : Object.values(v.path || {});
      o.near = !!v.near;
      o.finished = v.fin ? { reason: v.fin } : null;
      o.left = false;
      g.startAt = performance.now() - (Number(v.el) || 0);
      renderWatch(moved);
      onLive('p', { t: 'view', p: v.p, i: Number(v.i) || 0, f: Number(v.f) || 0 });
      if (v.tapAt && v.tapAt !== lastTapAt) { lastTapAt = v.tapAt; if (state.watch.shown === v.p && state.watch.ready) showTap(Number(v.n)); }
    }, denied);
    beat();
    try { history.replaceState(null, '', `${location.pathname}?adminwatch=${encodeURIComponent(key)}${embed ? '&embed=1' : ''}`); } catch { /* 忽略 */ }
    renderTabs();
  };

  // 上方的玩家列：所有正在比賽的人（房間、單人訓練、每日挑戰），點一下就換人看
  let everyone = {};
  const RACING = ['game', 'result', 'watch', 'solo', 'daily'];
  const renderTabs = () => {
    const list = Object.entries(everyone).filter(([k, w]) => w && (k === cur?.key || (w.st && RACING.includes(w.s))));
    $('#watch-tabs').hidden = list.length < 2;
    $('#watch-tabs').replaceChildren(...list.map(([k, w]) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.classList.toggle('on', k === cur?.key);
      const where = w.s === 'solo' ? '單人' : w.s === 'daily' ? '每日' : w.r || '';
      b.append(avatarEl({ name: w.n || '玩家', avatar: cleanAvatar(w.av) }, 'sm'), `${w.n || '玩家'} · ${where ? where + ' · ' : ''}${w.done ? (w.ok ? '抵達' : '結束') : `${w.k || 0} 步`}`);
      b.onclick = () => watchKey(k);
      li.append(b);
      return li;
    }));
    $('#watch-tabs').querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  };
  db.ref('who').on('value', (snap) => { everyone = snap.val() || {}; renderTabs(); }, () => { /* 沒有權限就只看這一位 */ });

  watchKey(firstKey);
}

// ---------- 觀戰的即時畫面：比賽中的人把捲動位置和點擊送給已經比完的人 ----------
// 有人比完（可能在觀戰）才送，避免比賽時浪費流量
const hasSpectators = (g) => !!g && [...g.others.values()].some((o) => o.finished && !o.left);

function sendLive(msg) {
  if (msg.t === 'view') lastView = { p: state.game?.current, i: msg.i, f: msg.f };
  else if (msg.t === 'tap') lastTap = { p: state.game?.current, n: msg.n, at: Date.now() };
  if (adminWatching) pushAdminLive();
  const g = state.game;
  if (!g || g.finished || !g.current || !hasSpectators(g)) return;
  const full = { ...msg, p: g.current };
  if (net.isHost) sendToSpectators({ ...full, id: state.myId }, null);
  else net.send(full);
}

// 房主：只轉給已經比完的人
function sendToSpectators(msg, except) {
  const g = state.game;
  if (!g) return;
  for (const o of g.others.values()) {
    if (o.finished && !o.left && o.id !== except) net.send(msg, o.id);
  }
}

function cleanLive(msg) {
  if (typeof msg.p !== 'string') return null;
  if (msg.t === 'view') {
    const i = Math.floor(Number(msg.i));
    const f = Number(msg.f);
    if (!(i >= 0 && i < 5000) || !(f >= 0 && f <= 1)) return null;
    return { t: 'view', p: msg.p, i, f };
  }
  const n = Math.floor(Number(msg.n));
  if (!(n >= 0 && n < 20000)) return null;
  return { t: 'tap', p: msg.p, n };
}

// 條目裡的段落：用「第幾段＋段內位置」對齊，手機寬度不同也能對到同一個地方
function blocksOf(root) {
  const box = root.querySelector('.mw-parser-output') || root;
  return [...box.children].filter((el) => el.getBoundingClientRect().height > 0);
}

function readView(root, line) {
  const blocks = blocksOf(root);
  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect();
    if (r.bottom > line) return { i, f: Math.min(1, Math.max(0, (line - r.top) / (r.height || 1))) };
  }
  return { i: Math.max(0, blocks.length - 1), f: 1 };
}

let liveTimer = null;
let lastLive = '';
function queueLiveView() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    if (state.view !== 'game') return;
    const v = readView($('#article'), $('#hud').getBoundingClientRect().bottom + 10);
    const sig = `${state.game?.current}|${v.i}|${v.f.toFixed(2)}`;
    if (sig === lastLive) return;
    lastLive = sig;
    sendLive({ t: 'view', i: v.i, f: Number(v.f.toFixed(3)) });
  }, 200);
}

function initGame() {
  const root = $('#article');
  // 往下捲動閱讀時把上方資訊收小，往上捲或回到頂端就展開。
  // 收合會改變版面高度，剛切換完的一小段時間不理會捲動，避免收、放來回抖動
  // 展開時記住捲到最上面的位置、收合時記住最下面的位置，跟它比才知道是往下讀還是往回找
  let turnY = 0;
  let settleUntil = 0;
  const setCompact = (on) => {
    const hud = $('#hud');
    if (hud.classList.contains('compact') === on) return;
    hud.classList.toggle('compact', on);
    settleUntil = performance.now() + 350;
    turnY = scrollY;
  };
  window.addEventListener('scroll', () => {
    if (state.view !== 'game') return;
    queueLiveView();
    const y = scrollY;
    const compact = $('#hud').classList.contains('compact');
    if (performance.now() < settleUntil) { turnY = y; return; }
    if (y < 80) { setCompact(false); turnY = y; return; }
    if (compact) {
      turnY = Math.max(turnY, y);
      if (y < turnY - 50) setCompact(false);
    } else {
      turnY = Math.min(turnY, y);
      if (y > turnY + 20) setCompact(true);
    }
  }, { passive: true });
  // 點了哪個連結馬上告訴觀戰的人，新頁面載入前就看得到他點了什麼
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a.wl');
    if (!a) return;
    const n = [...root.querySelectorAll('a.wl')].indexOf(a);
    if (n >= 0) sendLive({ t: 'tap', n });
  });
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    e.preventDefault();
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      const el = id && document.getElementById(id);
      if (el && root.contains(el)) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!a.dataset.title) { toast('只能點擊連到其他條目的連結喔'); return; }
    const g = state.game;
    if (isItems(g) && !g.loading && !g.finished) {
      if (fxOn(g, 'freeze')) { toast('🧊 被冰凍了，等一下！', 1200); haptic('error'); return; }
      if (fxOn(g, 'banana')) {
        // 踩到香蕉皮：改去這一頁隨機的一個連結
        g.fx.banana = 0;
        applyFx();
        const all = [...root.querySelectorAll('a.wl')].filter((x) => x.dataset.title !== g.current && x.dataset.title !== a.dataset.title);
        const slip = all[Math.floor(Math.random() * all.length)] || a;
        showHit('🍌', `滑倒了！跑去了《${slip.textContent.trim() || tw(slip.dataset.title)}》`);
        haptic('error');
        goTo(slip.dataset.title, { from: linkSpot(a) });
        return;
      }
    }
    goTo(a.dataset.title, { from: linkSpot(a) });
  });
  // 擋掉中鍵另開分頁
  root.addEventListener('auxclick', (e) => { if (e.target.closest('a')) e.preventDefault(); });

  $('#btn-back').onclick = () => {
    const g = state.game;
    if (!g || !g.stack.length || g.loading) return;
    if (fxOn(g, 'freeze')) { toast('🧊 被冰凍了，等一下！', 1200); return; }
    const prev = g.stack.pop();
    const spot = g.spots.pop() || null;
    goTo(prev, { back: true, spot }).then(() => {
      if (g.current !== prev) { g.stack.push(prev); g.spots.push(spot); }
    });
  };

  $('#btn-giveup').onclick = () => {
    const msg = isParty() ? '確定要投降嗎？這一局你就不會有名次了。' : '確定要投降嗎？對手會直接獲勝。';
    if (confirm(msg)) finishGame('giveup');
  };

  $('#btn-path').onclick = () => { $('#path-drawer').hidden = !$('#path-drawer').hidden; };
  $('#btn-find').onclick = () => { if ($('#find-sheet').hidden) openFind(); else closeFind(); };
  $('#btn-find-close').onclick = closeFind;
  $('#find-input').addEventListener('input', renderFind);
  $('#find-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#find-list button')?.click(); } });
  $('#btn-hint-open').onclick = () => { if ($('#hint-modal').hidden) openHint(); else closeHint(); };
  $('#hint-close').onclick = closeHint;
  $('#hint-modal').addEventListener('click', (e) => { if (e.target.id === 'hint-modal') closeHint(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#hint-modal').hidden) closeHint(); });
  $('#btn-path-close').onclick = () => { $('#path-drawer').hidden = true; };
}

// ---------- 找這頁的連結（房主允許才有）：打幾個字，列出這一頁符合的連結，點一下捲過去、標出來 ----------
function openFind() {
  const g = state.game;
  if (!g || g.finished || !g.settings.allowFind) return;
  $('#path-drawer').hidden = true;
  $('#find-sheet').hidden = false;
  $('#find-input').value = '';
  renderFind();
  setTimeout(() => $('#find-input').focus(), 50);
}
function closeFind() {
  $('#find-sheet').hidden = true;
  $('#find-input').blur();
}
function renderFind() {
  const q = $('#find-input').value.trim().toLowerCase();
  const seen = new Map();
  for (const a of $('#article').querySelectorAll('a.wl')) {
    const title = a.dataset.title;
    if (!title || seen.has(title)) continue;
    if (!a.getClientRects().length) continue;  // 藏起來的連結（看不到、也捲不過去）不列
    const text = a.textContent.replace(/\s+/g, ' ').trim();
    const name = tw(title);
    if (q && !(`${text} ${name}`.toLowerCase().includes(q) || `${text} ${name}`.toLowerCase().includes(tw(q)))) continue;
    seen.set(title, { a, text: text || name, name });
  }
  const list = [...seen.values()];
  $('#find-note').textContent = q ? (list.length ? `${list.length} 個符合的連結，點一下跳過去` : '這一頁沒有符合的連結，換個字試試') : `這一頁有 ${list.length} 個連結，打字來找`;
  $('#find-list').replaceChildren(...(q ? list.slice(0, 40) : []).map(({ a, text, name }) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.append(Object.assign(document.createElement('b'), { textContent: text }));
    if (name !== text) b.append(Object.assign(document.createElement('small'), { textContent: name }));
    b.onclick = () => jumpToLink(a);
    li.append(b);
    return li;
  }));
}
// 捲到那個連結、閃一下（要不要點還是玩家自己決定）
// 手機上鍵盤收起來時畫面高度會變，平滑捲動會被打斷、停在半路：先等鍵盤收好再捲，捲完再確認一次有沒有停在那個字上
function jumpToLink(a) {
  const kb = !!window.visualViewport && visualViewport.height < innerHeight - 80;
  closeFind();
  if (!a.isConnected) return;
  const go = (behavior) => a.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
  const visible = () => {
    const r = a.getBoundingClientRect();
    const top = $('#hud').getBoundingClientRect().bottom;
    const bottom = Math.min(innerHeight, document.querySelector('#view-game .tabbar')?.getBoundingClientRect().top || innerHeight);
    return r.height > 0 && r.top >= top && r.bottom <= bottom;
  };
  setTimeout(() => {
    go('smooth');
    a.classList.remove('find-hit');
    void a.offsetWidth;
    a.classList.add('find-hit');
    setTimeout(() => a.classList.remove('find-hit'), 2600);
    setTimeout(() => { if (a.isConnected && !visible()) go('auto'); }, 900);
  }, kb ? 350 : 0);
}

function feed(parts, tag, color) {
  const el = document.createElement('div');
  el.className = 'feed-item';
  const t = Object.assign(document.createElement('span'), { className: 'feed-time', textContent: tag });
  if (color) t.style.background = color;
  el.append(t);
  for (const p of parts) {
    if (typeof p === 'string') el.append(p);
    else {
      const b = Object.assign(document.createElement('b'), { textContent: p.b });
      if (color) b.style.color = color;
      el.append(b);
    }
  }
  const box = $('#feed');
  // 放在 HUD 正下方，避免蓋住警告
  box.style.top = `${$('#hud').getBoundingClientRect().bottom + 8}px`;
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), 2700);
}

// 有任何對手的頁面上出現終點連結就拉警報
function refreshDanger() {
  const g = state.game;
  if (!g) return;
  const near = [...g.others.values()].filter((o) => o.near && !o.finished && !o.left && !isRush(g));
  const on = near.length > 0 && !g.finished;
  const was = !!g.heart;
  $('#hud').classList.toggle('danger', on);
  $('#hud-alert-opp').hidden = !on;
  if (on) {
    const names = near.map((o) => o.name).slice(0, 2).join('、') + (near.length > 2 ? ` 等 ${near.length} 人` : '');
    $('#hud-alert-opp').textContent = `${names} 只差一步就到終點！`;
  }
  if (on && !was) {
    sfx.alarm();
    haptic('warning');
    g.heart = setInterval(() => sfx.heartbeat(), 900);
  } else if (!on && was) {
    clearInterval(g.heart);
    g.heart = null;
  }
  updateIntensity();
}

function onOtherProgress(id, msg) {
  const g = state.game;
  const o = g?.others.get(id);
  if (!o || o.finished || o.left) return;
  const moved = msg.clicks !== o.clicks || msg.title !== o.current;
  const scored = isRush(g) && Number(msg.score) > (o.score || 0);
  if (isRush(g)) Object.assign(o, rushFields(msg, o));
  o.clicks = msg.clicks;
  o.current = msg.title;
  if (Array.isArray(msg.path)) o.path = msg.path.slice(0, 200);
  else if (moved) o.path.push(msg.title);
  o.near = !!msg.near;
  if (msg.d >= 1 && msg.d <= 3) o.dist = msg.d;
  if (moved) o.desc = '';
  if (typeof msg.desc === 'string') o.desc = msg.desc;
  o.offline = false;
  renderOppHud();
  syncRoom();
  if (g.finished) {
    if (state.view === 'result') showResult(true);
    else if (state.view === 'watch') renderWatch(id === state.watch.id && moved);
    return;
  }
  refreshDanger();
  if ((moved || scored) && g.startAt) {
    const racer = $('#hud-opp');
    racer.classList.remove('bump');
    void racer.offsetWidth;
    racer.classList.add('bump');
    sfx.oppMove();
    const color = g.mode === 'party' ? o.color : null;
    if (isRush(g)) {
      if (scored) feed([{ b: o.name }, ` 搶到 1 分！現在 ${o.score} 分`], '+1', color);
    } else feed(oppViewOf(g.settings) === 'full' ? [{ b: o.name }, ` 前往《${tw(msg.title)}》`] : [{ b: o.name }, ' 又前進了一步'], `第${msg.clicks}步`, color);
    haptic('light');
  }
}

// 比步數：目前抵達者中最少的步數
function bestSteps(g) {
  const all = [...g.others.values()].map((o) => o.finished).concat(g.finished || []);
  const arrived = all.filter((f) => f?.reason === 'win').map((f) => f.clicks);
  return arrived.length ? Math.min(...arrived) : null;
}

// 終點旁的小標籤：比步數時顯示目前最佳紀錄，對決時顯示還剩幾步可以贏
function renderGoal() {
  const g = state.game;
  const el = $('#hud-goal');
  if (g && isRush(g)) { el.hidden = false; el.classList.remove('hot'); el.textContent = `🏃 第 ${g.rushIdx + 1} 題`; return; }
  if (!g || !isSteps(g)) { el.hidden = true; return; }
  el.hidden = false;
  const best = bestSteps(g);
  el.classList.remove('hot');
  if (best === null) { el.textContent = '👣 比步數'; return; }
  if (g.mode === 'party' || g.finished) { el.textContent = `最佳 ${best} 步`; return; }
  if (g.outstepped) { el.textContent = `追不上了（對手 ${best} 步）· 可以走完或投降`; return; }
  const left = best - 1 - g.clicks;
  el.textContent = `${best - 1} 步內抵達才能贏 · 剩 ${Math.max(0, left)} 步`;
  el.classList.add('hot');
}

// 對決比步數：對手已經抵達，而你再怎麼走都不會比他少——勝負已定（你輸了），
// 但比賽不會被結束：可以繼續走到終點或投降，先抵達的對手可以一直觀戰
function checkOutstepped() {
  const g = state.game;
  if (!g || g.finished || !isSteps(g) || g.mode === 'party') return false;
  if (g.outstepped) return true;
  const best = bestSteps(g);
  // 下一步就抵達也要 clicks + 1 步，一樣多步時先抵達的對手贏
  if (best === null || g.clicks + 1 < best) return false;
  g.outstepped = best;
  toast(`步數已經追不上了（對手 ${best} 步）。可以繼續走完，或按投降結束`, 4000);
  renderGoal();
  return true;
}

function stopGameLoops(g) {
  clearInterval(g.timer);
  clearInterval(g.heart);
  g.heart = null;
}

function finishGame(reason) {
  const g = state.game;
  if (!g || g.finished) return;
  stopGameLoops(g);
  closeFind();
  clearNewbie();
  if (g.settings.newbie && reason === 'win') { store.set('wikirace-newbie-done', '1'); setTimeout(() => toast('🎉 第一局完成！接下來可以開房間找朋友對決，或挑戰每日一題', 5000), 1200); }
  music.stop();
  g.finished = { reason, elapsed: elapsed(), clicks: g.clicks, path: g.path.slice() };
  if (isRush(g)) { Object.assign(g.finished, { score: g.score, at: g.scoreAt }); $('#btn-rush-skip').disabled = true; }
  if (state.solo) { settleDaily(g); recordSoloStats(g); }
  sendProgress({ t: 'finish', ...g.finished });
  if (net.isHost) { onAnyFinish(state.myId, g.finished); checkHintVotes(); }
  $('#hint-bar').hidden = true;
  $('#countdown').hidden = true;
  $('#path-drawer').hidden = true;
  $('#coach').hidden = true;
  $('#item-dock').hidden = true;
  closePick(null);
  applyFx();
  $('#hud').classList.remove('danger');
  if (reason === 'win') {
    flash('#ffc53d');
    setTimeout(() => { if (state.game === g) showResult(); }, 350);  // 這 0.35 秒內離開了就不要再畫
  } else if (reason === 'lose') {
    flash('#ff4d6d');
    setTimeout(() => { if (state.game === g) showResult(); }, 350);  // 這 0.35 秒內離開了就不要再畫
  } else {
    showResult();
  }
}

// 房主：派對模式有設定最後衝刺時，第一個人抵達就開始倒數
function onAnyFinish(id, info) {
  if (id !== state.myId) giveSolution(id);
  const g = state.game;
  const seconds = g?.settings.lastCall || 0;
  if (!g || g.mode !== 'party' || !seconds || info.reason !== 'win' || g.lastCallSent) return;
  g.lastCallSent = true;
  net.send({ t: 'lastcall', seconds, by: id });
  applyLastCall(seconds, id);
}

function applyLastCall(seconds, by) {
  const g = state.game;
  if (!g || g.lastCallEnd) return;
  g.lastCallEnd = performance.now() + seconds * 1000;
  if (g.finished) return;
  const who = by === state.myId ? '你' : by ? nameOf(by) : '有人';
  toast(`${who} 第一個抵達！剩下的人只剩 ${fmtLastCall(seconds)}`, 3500);
  sfx.alarm();
  haptic('warning');
  tick();
}

const fmtLastCall = (sec) => (sec >= 60 && sec % 60 === 0 ? `${sec / 60} 分鐘` : `${Math.round(sec)} 秒`);

function onOtherFinish(id, msg) {
  const g = state.game;
  const o = g?.others.get(id);
  if (!o) return;
  if (net.isHost && !o.finished) setTimeout(checkHintVotes, 0);
  if (state.view === 'watch' && !o.finished) setTimeout(() => watchedLeft(id, msg.reason), 0);
  // 重新連線時可能收到重複的結束訊息
  if (o.finished) { if (Array.isArray(msg.path)) o.path = msg.path; return; }
  o.finished = { reason: msg.reason, elapsed: msg.elapsed, clicks: msg.clicks, path: msg.path };
  o.clicks = msg.clicks;
  o.path = msg.path || o.path;
  o.near = false;
  if (isRush(g)) {
    // 搶分賽：別人結束（時間到、投降）不影響自己，時間到再一起比分數
    Object.assign(o, rushFields(msg, o));
    Object.assign(o.finished, { score: o.score, at: o.at });
    renderOppHud();
    if (!g.finished && msg.reason === 'giveup') feed([{ b: o.name }, ` 不玩了（${o.score} 分）`], '出局', g.mode === 'party' ? o.color : null);
    if (g.finished) refreshResult();
    return;
  }
  renderOppHud();
  if (g.mode !== 'party') {
    if (!g.finished && msg.reason === 'win' && isSteps(g)) {
      // 比步數：對手抵達了，但你還有機會用更少的步數贏
      renderGoal();
      if (!checkOutstepped()) {
        toast(`${o.name} 用 ${msg.clicks} 步抵達！你要在 ${msg.clicks - 1} 步內抵達才能贏`, 4000);
        sfx.alarm();
        haptic('warning');
      }
      return;
    }
    if (!g.finished) {
      if (msg.reason === 'win') finishGame('lose');
      else if (msg.reason === 'giveup') finishGame('oppGaveUp');
      else if (msg.reason === 'timeout') finishGame('timeout');
    } else {
      refreshResult();
    }
    return;
  }
  if (net.isHost) onAnyFinish(id, msg);
  renderGoal();
  if (!g.finished) {
    refreshDanger();
    if (msg.reason === 'win') {
      const place = ranking(g).find((e) => e.id === id)?.place;
      feed([{ b: o.name }, isSteps(g) ? ` 用 ${msg.clicks} 步抵達！目前第 ${place || '?'} 名` : ` 抵達終點！第 ${place || '?'} 名`], '抵達', o.color);
      sfx.oppMove();
    } else {
      feed([{ b: o.name }, msg.reason === 'giveup' ? ' 投降了' : ' 時間到出局'], '出局', o.color);
    }
  } else {
    refreshResult();
  }
}

function onOtherLeft(id) {
  const g = state.game;
  const o = g?.others.get(id);
  if (!o || o.left) return;
  if (net.isHost) setTimeout(checkHintVotes, 0);
  if (state.view === 'watch') setTimeout(() => watchedLeft(id, 'left'), 0);
  o.left = true;
  o.near = false;
  renderOppHud();
  if (g.mode !== 'party') {
    if (!g.finished) finishGame('oppLeft');
    else refreshResult();
    return;
  }
  if (!g.finished) refreshDanger();
  else refreshResult();
}

function onPresence(id, online, wait = 0, { quiet = false } = {}) {
  const p = state.players.get(id);
  if (p) p.online = online;
  const o = state.game?.others.get(id);
  if (o && !o.left) {
    o.offline = !online;
    o.offlineUntil = online ? 0 : performance.now() + (Number(wait) || 0);
    refreshWaitTicker();
    if (!online) o.near = false;
    renderOppHud();
    if (state.view === 'game' && !state.game.finished) {
      refreshDanger();
      if (!quiet) toast(online ? `${o.name} 重新連線了` : `${o.name} 斷線了，等待重新連線…`, 2500);
    }
  }
  if (state.view === 'room') renderRoom();
  if (state.game?.finished) refreshResult();
}

// 斷線的人還會等多久（秒）
function waitLeft(o, short = false) {
  if (!o.offlineUntil) return '';
  const sec = Math.max(0, Math.ceil((o.offlineUntil - performance.now()) / 1000));
  return short ? ` ${sec}s` : `（還等 ${sec} 秒）`;
}

// 有人斷線時，每秒更新畫面上的倒數
let waitTicker = null;
function refreshWaitTicker() {
  const g = state.game;
  const any = g && [...g.others.values()].some((o) => o.offline && !o.left && !o.finished);
  if (any && !waitTicker) {
    waitTicker = setInterval(() => {
      const gg = state.game;
      if (!gg || ![...gg.others.values()].some((o) => o.offline && !o.left && !o.finished)) { clearInterval(waitTicker); waitTicker = null; return; }
      if (state.view === 'game') renderOppHud();
      else if (state.view === 'result' && gg.mode === 'party') renderRanking(gg, ranking(gg));
      else if (state.view === 'watch') renderWatch();
    }, 1000);
  }
}

// ---------- 結果 ----------
function outcomeDuel(g) {
  const me = g.finished;
  const o = [...g.others.values()][0];
  const opp = o?.finished;
  if (isSteps(g)) {
    if (me.reason === 'win' && opp?.reason === 'win') {
      if (me.clicks !== opp.clicks) return me.clicks < opp.clicks ? 'win' : 'lose';
      return me.elapsed === opp.elapsed ? 'draw' : (me.elapsed < opp.elapsed ? 'win' : 'lose');
    }
    // 你先抵達，對手還在走：他還有機會用更少的步數抵達就要等；已經追不上了（下一步就到也不會比你少）就算你贏，他可以繼續走完
    if (me.reason === 'win') return !opp && o && !o.left && (o.clicks || 0) + 1 < me.clicks ? 'pending' : 'win';
    if (me.reason === 'over') return 'lose';
  }
  if (me.reason === 'win' && opp && opp.reason === 'win') {
    if (me.elapsed !== opp.elapsed) return me.elapsed < opp.elapsed ? 'win' : 'lose';
    return me.clicks === opp.clicks ? 'draw' : (me.clicks < opp.clicks ? 'win' : 'lose');
  }
  if (me.reason === 'win' || me.reason === 'oppGaveUp' || me.reason === 'oppLeft') return 'win';
  if (me.reason === 'lose' || me.reason === 'giveup') return 'lose';
  if (opp && opp.reason === 'win') return 'lose';
  return 'draw';
}

// 派對排名：抵達者依用時排序，接著是還在跑的人，最後是出局與離線
function ranking(g) {
  const meP = state.players.get(state.myId);
  const entries = [
    { id: state.myId, name: state.myName, avatar: state.myAvatar, color: meP?.color || COLORS[0], me: true, finished: g.finished, clicks: g.finished?.clicks ?? g.clicks, path: g.finished?.path || g.path, left: false, score: g.score || 0, at: g.scoreAt || 0, qi: g.rushIdx || 0, rr: g.rushDone || [], cur: { s: g.settings.start, t: g.settings.target } },
    ...[...g.others.values()].map((o) => ({ id: o.id, name: o.name, avatar: o.avatar, color: o.color, me: false, finished: o.finished, clicks: o.clicks, path: o.path, left: o.left, offline: o.offline, offlineUntil: o.offlineUntil, score: o.score || 0, at: o.at || 0, qi: o.qi || 0, rr: o.rr || [] })),
  ];
  if (isRush(g)) {
    // 搶分賽：分數多的在前；一樣多分的，總步數少的贏；分數、步數都一樣才平手
    entries.sort((a, b) => (b.score - a.score) || (a.clicks - b.clicks));
    let place = 0;
    let prev = null;
    entries.forEach((e, i) => { place = prev && prev.score === e.score && prev.clicks === e.clicks ? place : i + 1; e.place = place; prev = e; });
    return entries;
  }
  const group = (e) => {
    if (e.finished?.reason === 'win') return 0;
    if (!e.finished && !e.left) return 1;
    if (e.finished?.reason === 'timeout') return 2;
    if (e.finished?.reason === 'giveup') return 3;
    return 4;
  };
  entries.sort((a, b) => group(a) - group(b)
    || (group(a) === 0
      ? (isSteps(g) ? (a.clicks - b.clicks) || (a.finished.elapsed - b.finished.elapsed) : (a.finished.elapsed - b.finished.elapsed) || (a.clicks - b.clicks))
      : b.clicks - a.clicks));
  let place = 0;
  for (const e of entries) e.place = group(e) === 0 ? ++place : null;
  return entries;
}

function allDone(g) {
  return !!g.finished && [...g.others.values()].every((o) => o.finished || o.left);
}

function resultLabel(f) {
  if (!f) return '—';
  return {
    win: '抵達終點', lose: '未抵達', over: '步數超過', giveup: '投降', timeout: '時間到', oppGaveUp: '對手投降', oppLeft: '對手離線', hostLeft: '房主離線',
  }[f.reason] || '—';
}

function rankStatus(e) {
  if (isRush()) {
    if (e.left && !e.finished) return `離線 · ${e.score} 分`;
    if (!e.finished && e.offline) return `斷線中${waitLeft(e)} · ${e.score} 分`;
    if (!e.finished) return `比賽中… ${e.score} 分`;
    return `${e.score} 分${e.finished.reason === 'giveup' ? ' · 中途放棄' : ''} · 共 ${e.clicks} 步`;
  }
  if (e.finished?.reason === 'win') return `${e.clicks} 步 · ${fmtTime(e.finished.elapsed)}`;
  if (e.left && !e.finished) return '離線';
  if (!e.finished && e.offline) return `斷線中${waitLeft(e)}`;
  if (!e.finished) return `比賽中… ${e.clicks} 步`;
  if (e.finished.reason === 'timeout') return `時間到 · ${e.clicks} 步`;
  if (e.finished.reason === 'giveup') return `投降 · ${e.clicks} 步`;
  return resultLabel(e.finished);
}

function renderRanking(g, entries) {
  const done = allDone(g);
  $('#ranking-status').textContent = done ? '最終排名' : '比賽進行中…';
  const target = g.settings.target;
  // 重畫前記住哪些人的路線是展開的：還在比的人每走一步都會重畫，不能每次都收起來
  const mine = (d) => d.parentElement.dataset.gid === String(g.id);
  const opened = new Set([...$('#rank-list').querySelectorAll('li.rank-item > details[open]')].filter(mine).map((d) => d.parentElement.dataset.id));
  // 搶分賽：每個人每一題的路線一開始就全部展開給大家看（自己收起來的才收著）
  const closed = new Set([...$('#rank-list').querySelectorAll('li.rank-item > details:not([open])')].filter(mine).map((d) => d.parentElement.dataset.id));
  const items = entries.map((e) => {
    const li = document.createElement('li');
    li.className = 'rank-item';
    li.dataset.id = e.id;
    li.dataset.gid = String(g.id);  // 新的一局就全部收起來
    li.classList.toggle('is-me', e.me);
    if (e.place && e.place <= 3) li.classList.add(`p${e.place}`);
    const badge = Object.assign(document.createElement('span'), { className: 'rank-badge', textContent: e.place ? String(e.place) : '–' });
    const body = document.createElement('details');
    const sum = document.createElement('summary');
    const name = Object.assign(document.createElement('b'), { textContent: e.me ? `${e.name}（你）` : e.name });
    const stat = Object.assign(document.createElement('span'), { className: 'rank-stat', textContent: rankStatus(e) });
    sum.append(avatarEl(e, 'sm'), name, stat);
    const ol = document.createElement('ol');
    ol.className = 'metro';
    ol.style.setProperty('--side', e.color);
    fillPath(ol, e.path || [], target);
    body.append(sum);
    if (isRush(g)) body.append(rushRoutesEl(g, e));
    else body.append(ol);
    body.open = isRush(g) ? !closed.has(e.id) : opened.has(e.id);
    if ((e.finished || e.left) && !isRush(g)) body.append(routeReplayButton(e.me ? '你' : e.name, e.path || [], g.settings, e.finished?.reason === 'win'));
    li.append(badge, body);
    if (g.finished && !e.me && !e.finished && !e.left) {
      if (e.offline && net.isHost) {
        // 房主不想等斷線的人：直接當他離開，排名馬上結算
        const w = Object.assign(document.createElement('button'), { type: 'button', className: 'wait-btn', textContent: '不等了' });
        w.onclick = () => { if (confirm(`不等 ${e.name} 了嗎？他會被當成離開。`)) { const p = state.players.get(e.id); if (p) p.leaving = true; removePlayer(e.id); } };
        li.append(w);
      } else if (!e.offline) {
        const w = Object.assign(document.createElement('button'), { type: 'button', className: 'rank-watch', textContent: '👀 觀戰' });
        w.onclick = () => openWatch(e.id);
        li.append(w);
      }
    }
    return li;
  });
  $('#rank-list').replaceChildren(...items);
}

// 搶分賽：依題目整理（每一題大家各走了幾步、誰跳過、誰還沒走到）
function renderRushQs(g, entries) {
  const at = (e, i) => {
    if (e.rr?.[i]) return e.rr[i];
    if (i === e.qi && e.path?.length) return { p: e.path, r: 'open' };
    return null;
  };
  const n = Math.max(0, ...entries.map((e) => (e.rr?.length || 0) + (e.path?.length ? 1 : 0)));
  const opened = new Set([...$('#rush-qs-list').querySelectorAll('details')].filter((d) => d.dataset.gid === String(g.id) && !d.open).map((d) => d.dataset.i));
  const blocks = [];
  for (let i = 0; i < n; i++) {
    const q = g.rushQ?.[i];
    if (!q) break;
    const rows = entries.map((e) => ({ e, x: at(e, i) })).filter((r) => r.x);
    const okRows = rows.filter((r) => r.x.r === 'ok').sort((a, b) => a.x.p.length - b.x.p.length);
    const rest = rows.filter((r) => r.x.r !== 'ok');
    const d = document.createElement('details');
    d.className = 'rq-block';
    d.dataset.gid = String(g.id);
    d.dataset.i = String(i);
    d.open = !opened.has(String(i));
    const sum = document.createElement('summary');
    sum.append(Object.assign(document.createElement('b'), { textContent: `第 ${i + 1} 題` }), ` 《${tw(q.s)}》→《${tw(q.t)}》`,
      Object.assign(document.createElement('span'), { className: 'rq-n', textContent: `${okRows.length} 人抵達` }));
    d.append(sum);
    for (const { e, x } of [...okRows, ...rest]) {
      const row = document.createElement('div');
      row.className = `rq-row ${x.r}`;
      const nm = Object.assign(document.createElement('b'), { textContent: e.me ? `${e.name}（你）` : e.name });
      nm.style.color = e.color || '';
      const mark = x.r === 'ok' ? `✅ ${Math.max(0, x.p.length - 1)} 步` : x.r === 'skip' ? '⏭️ 跳過' : '⏱️ 沒走完';
      row.append(avatarEl(e, 'sm'), nm, Object.assign(document.createElement('span'), { className: 'rq-mark', textContent: mark }),
        Object.assign(document.createElement('small'), { className: 'rq-path', textContent: x.p.map(tw).join(' › ') }));
      d.append(row);
    }
    blocks.push(d);
  }
  $('#rush-qs-list').replaceChildren(...(blocks.length ? blocks : [Object.assign(document.createElement('p'), { className: 'rush-route-none', textContent: '還沒有人走完任何一題' })]));
}

// 搶分賽的路線：每一題一段（抵達的、跳過的、最後沒走完的那題）
function rushRoutesEl(g, e) {
  const box = document.createElement('div');
  box.className = 'rush-routes';
  const rows = (e.rr || []).map((x) => ({ ...x }));
  const q = g.rushQ?.[e.qi];
  if (q && e.path?.length) rows.push({ s: q.s, t: q.t, p: e.path, r: 'open' });
  if (!rows.length) { box.append(Object.assign(document.createElement('p'), { className: 'rush-route-none', textContent: '還沒有走過任何一題' })); return box; }
  rows.forEach((x, i) => {
    const head = document.createElement('div');
    head.className = `rush-route-h ${x.r}`;
    const mark = x.r === 'ok' ? `✅ ${Math.max(0, x.p.length - 1)} 步` : x.r === 'skip' ? '⏭️ 跳過' : '⏱️ 沒走完';
    head.append(Object.assign(document.createElement('b'), { textContent: `第 ${i + 1} 題` }), ` 《${tw(x.s)}》→《${tw(x.t)}》`, Object.assign(document.createElement('span'), { textContent: mark }));
    const ol = document.createElement('ol');
    ol.className = 'metro';
    ol.style.setProperty('--side', e.color);
    fillPath(ol, x.p, x.r === 'ok' ? x.p[x.p.length - 1] : x.t);
    box.append(head, ol);
  });
  return box;
}

// 結果畫面的資料，也用來產生分享圖
function resultInfo(g) {
  if (isRush(g)) {
    const entries = ranking(g);
    const mine = entries.find((e) => e.me);
    const first = mine.place === 1;
    const tie = first && entries.filter((e) => e.place === 1).length > 1;
    const res = !allDone(g) ? 'pending' : tie ? 'draw' : first ? 'win' : 'lose';
    // 同分的人裡贏在步數比較少
    const sameScore = entries.some((e) => !e.me && e.score === mine.score);
    const title = !allDone(g) ? `你拿到 ${mine.score} 分！等其他人比完…` : tie ? `平手！都是 ${mine.score} 分、${mine.clicks} 步` : first ? (sameScore ? `第 1 名！同分，你步數最少！` : `第 1 名！搶到 ${mine.score} 分！`) : `第 ${mine.place} 名・${mine.score} 分`;
    return { res, kicker: res === 'pending' ? '…' : String(mine.place), title, tone: res === 'pending' ? 'place' : first ? 'win' : 'place', entries };
  }
  if (g.mode === 'party') {
    const entries = ranking(g);
    const mine = entries.find((e) => e.me);
    const res = mine.place === 1 ? 'win' : 'lose';
    let title;
    if (mine.place === 1) title = isSteps(g) ? '第 1 名！你步數最少！' : '第 1 名！你最快！';
    else if (mine.place) title = `第 ${mine.place} 名！`;
    else title = g.finished.reason === 'giveup' ? '你投降了' : g.finished.reason === 'hostLeft' ? '房主離線了' : '沒能在時限內抵達…';
    return { res, kicker: mine.place ? String(mine.place) : '–', title, tone: mine.place === 1 ? 'win' : mine.place ? 'place' : 'lose', entries };
  }
  const res = outcomeDuel(g);
  if (res === 'pending') return { res, kicker: '…', title: `你用 ${g.finished.clicks} 步抵達！等待對手…`, tone: 'place' };
  const map = isSteps(g)
    ? { win: ['勝', '步數最少，你贏了！'], lose: ['敗', g.finished.reason === 'over' ? '步數追不上對手…' : '對手的步數更少…'], draw: ['和', '平手！'] }
    : { win: ['勝', '你贏了！'], lose: ['敗', '對手搶先一步…'], draw: ['和', '平手！'] };
  return { res, kicker: map[res][0], title: map[res][1], tone: res };
}

let lastOutcome = null;
// 一局的結算（自己的勝負紀錄、最近對戰、本房戰績、後台統計），跟「現在有沒有在看結果畫面」無關：
// 例如房主先按再來一局回大廳，別人之後才抵達，也要照最終名次算完。
// 每次有人抵達、投降、離線都會呼叫；勝負因幾乎同時抵達而更正時，戰績也跟著改正，本房戰績只記一次。
function settleGame(g) {
  if (!g || !g.finished || state.solo || g !== state.game) return;
  const party = g.mode === 'party' || isRush(g);
  const info = resultInfo(g);
  const { res } = info;
  if (res === 'pending') { /* 勝負未定，先不記戰績 */ }
  else if (!g.recorded && g.restored) g.recorded = res;
  else if (!g.recorded) { recordResult(g.settings.goal, res); g.recorded = res; }
  else if (g.recorded !== res) { unrecordResult(g.settings.goal, g.recorded); recordResult(g.settings.goal, res); g.recorded = res; }
  // 最近對戰：派對要等名次確定才記（同一局會更新成最終結果，不會重複）
  if (res !== 'pending' && (!party || allDone(g))) saveHistory(g, info);
  // 房主：這一局大家都比完了，記到本房戰績和後台
  if (net.isHost && allDone(g) && !g.scored) { scoreGame(g, info); recordGameStats(g, info); }
}

// 比賽狀態有變（有人抵達、離線、回來）：先結算，正在看結果畫面才重畫
function refreshResult() {
  const g = state.game;
  if (g?.finished) settleGame(g);
  if (state.view === 'result' && g) showResult(true);
}

function showResult(update = false) {
  const g = state.game;
  if (!g || !g.finished) return;
  if (state.solo) return showSoloResult(g);
  const party = g.mode === 'party' || isRush(g);  // 搶分賽 1 對 1 也用排名表
  // 從單人訓練切回一般對局時，把被訓練結算改過的元素還原
  $('#btn-share').hidden = false;
  $('#btn-solo-home').hidden = true;
  $('#daily-result').hidden = true;
  const info = resultInfo(g);
  const { res } = info;
  if (party) renderRanking(g, info.entries);
  else renderDuelResult(g, res);
  $('#rush-qs').hidden = !isRush(g);
  if (isRush(g)) renderRushQs(g, info.entries);
  renderSolution(g);
  const racing = racers(g);
  $('#btn-watch').hidden = !racing.length;
  $('#watch-cta-text').textContent = `觀戰：還有 ${racing.length} 人在比`;
  $('#result-hero').className = `cover result-hero ${info.tone}`;
  $('#ranking').hidden = !party;
  $('#score-card').hidden = party;
  $('#route-grid').hidden = party;
  $('#result-kicker').textContent = info.kicker;
  $('#result-kicker').classList.remove('emoji');
  $('#result-title').textContent = info.title;
  let sub = isRush(g) ? `🏃 搶分賽 ${g.settings.rushMin || 5} 分鐘・${(RUSH_LEVELS[g.settings.rushLevel] || RUSH_LEVELS.normal).name}` : `《${tw(g.settings.start)}》→《${tw(g.settings.target)}》`;
  if (g.finished.reason === 'oppGaveUp') sub += '（對手投降）';
  if (g.finished.reason === 'oppLeft') sub += '（對手離線）';
  if (g.finished.reason === 'timeout' && !isRush(g)) sub += '（時間到）';
  if (party && !allDone(g)) sub += '　等待其他玩家…';
  if (isSteps(g)) sub = `👣 比步數　${sub}`;
  $('#btn-share').disabled = res === 'pending';
  $('#result-sub').textContent = sub;
  $('#btn-rematch').disabled = !net.connected;
  $('#btn-rematch').textContent = net.connected ? '再來一局' : (party ? '其他人都離線了' : '對手已離線');

  syncRoom(true);
  settleGame(g);
  refreshWaitTicker();

  const hero = $('#result-hero');
  const changed = !update || res !== lastOutcome;
  lastOutcome = res;
  if (state.view !== 'result') show('result');
  if (!changed) return;
  if (res === 'win') { sfx.win(); confetti(); haptic('success'); }
  else if (res === 'pending' || (party && g.finished.reason === 'win')) { sfx.ready(); haptic('success'); }
  else { sfx.lose(); shake(hero.querySelector('.medal')); haptic('error'); }
  // 結算音效播完後回到大廳音樂
  setTimeout(() => { if (state.view === 'result') music.play('lobby'); }, 3500);
}

// 單人訓練的結算：只看自己的成績＋最短解答，不計勝負、不記戰績
function showSoloResult(g) {
  if (state.daily) renderDailyResult(g); else $('#daily-result').hidden = true;
  const reason = g.finished.reason;
  const win = reason === 'win';
  const tone = win ? 'win' : 'lose';
  $('#result-hero').className = `cover result-hero ${tone}`;
  // 單人沒有輸贏，圓圈裡用圖示：抵達 🎯（每日挑戰 🏆）、投降 💪 下次加油、時間到 ⏰
  $('#result-kicker').textContent = win ? (state.daily ? '🏆' : '🎯') : (reason === 'timeout' ? '⏰' : '💪');
  $('#result-kicker').classList.add('emoji');
  $('#result-title').textContent = win ? '抵達終點！' : (reason === 'timeout' ? '時間到了' : '這次先放棄');
  const stat = win
    ? `你的成績：${g.finished.clicks} 步 · ${fmtTime(g.finished.elapsed)}`
    : `走了 ${g.finished.clicks} 步，還沒抵達`;
  $('#result-sub').textContent = `${state.daily ? `📅 每日挑戰 #${state.daily.no}` : '🎯 單人訓練'}　《${tw(g.settings.start)}》→《${tw(g.settings.target)}》\n${stat}`;
  // 只留自己的路線，藏掉排行榜、對手欄、觀戰
  $('#ranking').hidden = true;
  $('#score-card').hidden = true;
  $('#btn-watch').hidden = true;
  $('#rush-qs').hidden = true;
  $('#route-grid').hidden = false;
  const meCard = $('#res-me-path').closest('.card');
  meCard.querySelector('.card-title').textContent = '你走過的路線';
  fillPath($('#res-me-path'), g.finished.path, g.settings.target);
  $('#res-me-replay').replaceWith(Object.assign(routeReplayButton('你', g.finished.path, g.settings, win), { id: 'res-me-replay' }));
  // 最短解答（訓練最有用的部分）
  renderSolution(g);
  // 按鈕：再練一題 / 回首頁，藏掉分享
  $('#btn-share').hidden = true;
  $('#btn-solo-home').hidden = false;
  $('#btn-rematch').disabled = false;
  $('#btn-rematch').textContent = state.daily ? '📅 再挑戰一次' : '🎯 再練一題';
  if (state.view !== 'result') show('result');
  if (win) { sfx.win(); confetti(); haptic('success'); }
  else { sfx.lose(); shake($('#result-hero').querySelector('.medal')); haptic('error'); }
  setTimeout(() => { if (state.view === 'result') music.play('lobby'); }, 3500);
}

function renderDuelResult(g, res) {
  const me = g.finished;
  $('#res-me-path').closest('.card').querySelector('.card-title').textContent = '你的路線';
  const o = [...g.others.values()][0] || { name: '對手', clicks: 0, path: [], finished: null, left: true };
  const opp = o.finished;
  $('#res-me-name').textContent = `${state.myName}（你）`;
  paintAvatar($('#res-me-avatar'), { name: state.myName, avatar: state.myAvatar });
  paintAvatar($('#res-opp-avatar'), o);
  $('#res-opp-name').textContent = o.name;
  $('#res-opp-path-head').textContent = `${o.name} 的路線`;
  $('#res-me-result').textContent = resultLabel(me);
  $('#res-opp-result').textContent = o.left && !opp ? '離線' : resultLabel(opp);
  $('#res-me-result').classList.toggle('win', res === 'win');
  $('#res-opp-result').classList.toggle('win', res === 'lose');
  $('#res-me-steps').textContent = `${me.clicks} 步`;
  $('#res-opp-steps').textContent = opp ? `${opp.clicks} 步` : `${o.clicks} 步`;
  $('#res-me-time').textContent = fmtTime(me.elapsed);
  $('#res-opp-time').textContent = opp ? fmtTime(opp.elapsed) : '—';
  fillPath($('#res-me-path'), me.path, g.settings.target);
  fillPath($('#res-opp-path'), o.path, g.settings.target);
  // 對手還在比的時候不給重播（看得到他的路線，但影片等他結束再看）
  $('#res-me-replay').replaceWith(Object.assign(routeReplayButton('你', me.path, g.settings, me.reason === 'win'), { id: 'res-me-replay' }));
  const oppDone = !!opp || o.left;
  $('#res-opp-replay').replaceWith(Object.assign(routeReplayButton(o.name, oppDone ? o.path : [], g.settings, opp?.reason === 'win'), { id: 'res-opp-replay' }));
}

// ---------- 正確解答：最短路線 ----------
// 結果畫面顯示解答區；沒有人抵達終點時自動開始找，有人抵達就按按鈕再找。
// 找到的路線每一步都會實際打開條目確認「遊戲畫面上點得到」，點不到的那一步就排除再找。
// 房間裡任何一個比完的人找到解答，房主就轉給其他比完的人，大家都不用再按一次。
const SOLVE_STAGE = {
  start: '讀取起點和終點…',
  search: (s) => `找路線中…已看過 ${s.checked || 0} 個條目${s.depth ? `，正在找 ${s.depth} 步的路線` : ''}`,
  verify: '確認每一步在遊戲裡都點得到…',
  host: '房主那邊正在找最佳路線，找到會直接出現…',
  busy: '維基百科有點忙，休息幾秒再接著找…',
};
const SOLVE_FAIL = {
  'no-links': '起點這一頁沒有任何可以點的條目連結，沒辦法出發。',
  'no-backlinks': '沒有任何條目連到終點，從哪裡出發都到不了。',
  unreachable: '從起點出發，怎麼點都到不了終點（這兩頁之間真的沒有路）。',
  timeout: '這題很難，找了很久還沒找到，按「再找一次」繼續找。',
};

function renderSolution(g) {
  // 搶分賽題目很多，不找單一題的最短路線
  $('#solution').hidden = isRush(g);
  if (isRush(g)) return;
  const sol = g.solution;
  const nobody = ![g.finished, ...[...g.others.values()].map((o) => o.finished)].some((f) => f?.reason === 'win');
  const done = g.mode === 'party' ? allDone(g) : true;
  $('#btn-solve').hidden = !!sol;
  $('#solution-progress').hidden = !(sol && sol.running);
  $('#solution-path').hidden = !(sol && sol.path);
  $('#btn-replay').hidden = !(sol && sol.path && sol.path.length > 1);
  if (!sol) {
    $('#solution-note').textContent = nobody ? '沒有人抵達，看看可以怎麼走' : '';
    // 房間裡的玩家：房主比賽一開始就在找了，等它傳過來
    if (!state.solo && net.code && !net.isHost && g.mode) { waitHostSolution(g); renderSolution(g); return; }
    if (nobody && done) findSolution(g);
    return;
  }
  if (sol.running) {
    const st = SOLVE_STAGE[sol.stage] || '搜尋中…';
    $('#solution-status').textContent = typeof st === 'function' ? st(sol) : st;
    $('#solution-note').textContent = '';
    return;
  }
  if (sol.path) {
    fillSolutionPath($('#solution-path'), sol.path, g.settings);
    const steps = sol.path.length - 1;
    $('#solution-note').textContent = `${sol.exact ? `最短 ${steps} 步` : `可行路線 ${steps} 步`}${sol.by && sol.by !== state.myName ? ` · ${sol.by} 找到的` : ''}`;
  } else {
    $('#btn-solve').hidden = false;
    $('#btn-solve').lastChild.textContent = '再找一次';
    $("#solution-note").textContent = sol.error ? `維基百科現在太忙或連不上（${sol.error}），等一分鐘再按「再找一次」` : SOLVE_FAIL[sol.reason] || SOLVE_FAIL.timeout;
  }
}

// 解答路線：每一站都是連到維基百科的超連結（另開分頁）
function fillSolutionPath(ol, path, settings) {
  ol.replaceChildren(...path.map((t) => {
    const li = document.createElement('li');
    const a = Object.assign(document.createElement('a'), { href: wiki.articleUrl(settings.lang, t), target: '_blank', rel: 'noopener', textContent: tw(t), className: 'sol-link' });
    a.title = '在維基百科打開這一頁';
    li.append(a);
    if (t === settings.target) li.classList.add('hit');
    return li;
  }));
}

const getArticle = (lang, title) => {
  const k = `${lang}:${title}`;
  if (!artCache.has(k)) artCache.set(k, wiki.fetchArticle(lang, title).catch((e) => { artCache.delete(k); throw e; }));
  return artCache.get(k);
};

// 這一頁在遊戲畫面上點得到哪些條目（跟比賽時一樣的處理方式）
async function clickableLinks(settings, title) {
  const art = await getArticle(settings.lang, title);
  const root = document.createElement('div');
  fillArticle(root, document.createElement('h1'), art, settings);
  return [...root.querySelectorAll('a.wl')].map((a) => a.dataset.title);
}

// 某個條目的所有名稱（本名＋重新導向到它的名稱），比對連結用
const namesCache = new Map();
function namesOf(lang, title, key) {
  const k = `${lang}:${title}`;
  if (!namesCache.has(k)) {
    namesCache.set(k, (async () => {
      const set = new Set([key(title)]);
      let cont = {};
      do {
        const d = await wiki.api(lang, { action: 'query', titles: title, prop: 'redirects', rdnamespace: '0', rdlimit: 'max', redirects: '1', ...cont });
        for (const p of d.query?.pages || []) { set.add(key(p.title)); for (const r of p.redirects || []) set.add(key(r.title)); }
        cont = d.continue || null;
      } while (cont);
      return set;
    })().catch((e) => { namesCache.delete(k); throw e; }));
  }
  return namesCache.get(k);
}

// 逐步確認路線點得到；回傳每一步要點的連結（給示範播放用），或第一個點不到的步驟
// limit：比賽中在背景找的時候，一步一步慢慢確認（跟找路線一樣讓玩家換頁優先）
async function verifyPath(settings, path, key, limit = null) {
  const check = async (i) => {
    const from = path[i];
    const to = path[i + 1];
    try {
      const [links, names] = limit
        ? [await limit(() => clickableLinks(settings, from)), await limit(() => namesOf(settings.lang, to, key))]
        : await Promise.all([clickableLinks(settings, from), namesOf(settings.lang, to, key)]);
      const via = links.find((t) => names.has(key(t)));
      return via ? { via } : { bad: [from, to] };
    } catch {
      return { via: null };  // 網路問題沒辦法確認：先當作可以（示範時再找）
    }
  };
  const steps = path.slice(0, -1).map((_, i) => i);
  const res = [];
  if (limit) for (const i of steps) res.push(await check(i));
  else res.push(...await Promise.all(steps.map(check)));
  const bad = res.find((r) => r.bad);
  return bad ? { bad: bad.bad } : { via: res.map((r) => r.via) };
}

// background：比賽一開始就在背景找（見 prefetchSolution）。自己還在比的時候放慢：一次只問一個、
// 自己正在換頁就先讓路，比賽才不會因為找答案變卡；自己比完就全速找完
async function findSolution(g, { background = false } = {}) {
  if (g.solution?.running && !g.solution.remote) return;
  g.solution = { running: true, stage: 'start', checked: 0 };
  const key = g.settings.lang === 'zh' ? (t) => tw(t) : (t) => t;
  const show = () => { if (state.game === g && state.view === 'result') renderSolution(g); };
  show();
  const gentle = () => background && state.game === g && !g.finished;
  let chain = Promise.resolve();
  const limit = (fn) => {
    if (!gentle()) return fn();
    const run = chain.then(async () => {
      while (gentle() && g.loading) await wait(200);
      if (gentle()) await wait(150);
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
  await zhReady;
  const banned = new Set();
  let found = null;
  let final = null;  // 確定找不到的原因（真的沒有路）
  let lastErr = null;
  // 一定要找到：維基百科太忙（429）、網路斷掉、找太久，都休息一下接著找，最多 4 輪（大約 20 分鐘）
  for (let round = 0; round < 4 && !found && !final; round++) {
    if (round) {
      Object.assign(g.solution, { stage: 'busy' });
      show();
      await wait(5000 * round);
      if (!g.solution?.running) return;
    }
    try {
      for (let attempt = 0; attempt < 8 && !found; attempt++) {
        const res = await solve(g.settings.lang, g.settings.start, g.settings.target, {
          key, banned, limit,
          timeLimit: background ? 1800000 : undefined,  // 背景找可以慢慢來（比賽可能很久）
          onProgress: ({ stage, checked, depth }) => {
            if (state.game !== g || !g.solution?.running) return;
            Object.assign(g.solution, { stage, checked, depth });
            show();
          },
        });
        if (!g.solution?.running) return;  // 等的時候別人已經把解答傳過來了
        if (!res.path) {
          if (res.reason !== 'timeout' && res.reason !== 'aborted') final = res.reason;
          break;  // 找太久：下一輪接著找
        }
        Object.assign(g.solution, { stage: 'verify' });
        show();
        const v = await verifyPath(g.settings, res.path, key, background ? limit : null);
        if (!g.solution?.running) return;
        if (v.bad) { banned.add(`${key(v.bad[0])}→${key(v.bad[1])}`); continue; }
        found = { path: res.path, exact: res.exact, via: v.via };
      }
    } catch (e) {
      lastErr = e;  // 維基百科一直不回應：下一輪再試
    }
  }
  if (found) {
    g.solution = { ...found, by: state.myName };
    shareSolution(g);
  } else if (g.solution?.running) {
    if (lastErr && !final) reportError('solution', lastErr);
    g.solution = final ? { path: null, reason: final } : lastErr ? { path: null, error: lastErr.message } : { path: null, reason: 'timeout' };
  }
  show();
}

// 比賽開始就先找最佳解答：多人房間只有房主找（一間房找一次，找到後只傳給比完的人），單人訓練、每日挑戰自己找
function prefetchSolution(g) {
  if (!g || state.game !== g || g.solution || state.adminWatch) return;
  if (!state.solo && !net.isHost) return;
  findSolution(g, { background: true });
}

// 玩家比完了：房主那邊已經在找，先等它傳過來；等太久（例如房主是舊版、或房主斷線）就自己找
const REMOTE_WAIT = 60000;
function waitHostSolution(g) {
  g.solution = { running: true, stage: 'host', remote: true };
  setTimeout(() => {
    if (state.game === g && g.solution?.remote && g.solution.running) {
      g.solution = null;
      findSolution(g);
    }
  }, REMOTE_WAIT);
}

// ---------- 解答分享：一個人找到，房間裡比完的人都看得到 ----------
const cleanSolution = (m) => {
  const list = (a) => (Array.isArray(a) ? a.slice(0, 200).map((t) => (typeof t === 'string' ? t.slice(0, 200) : null)) : []);
  const path = list(m.path).filter(Boolean);
  if (path.length < 1) return null;
  return { path, via: list(m.via), exact: !!m.exact, by: String(m.by || '').slice(0, 16) };
};
function solutionMsg(g) {
  const s = g.solution;
  return { t: 'solution', gid: g.id, path: s.path, via: s.via || [], exact: !!s.exact, by: s.by || '' };
}
function shareSolution(g) {
  if (state.solo || !g.solution?.path || !net.code) return;
  if (net.isHost) { for (const o of g.others.values()) if (o.finished && !o.left) net.send(solutionMsg(g), o.id); }
  else net.send(solutionMsg(g));
}
// 房主：有人比完了，已經有解答就直接給他（還在比的人收不到，避免偷看）
function giveSolution(id) {
  const g = state.game;
  if (net.isHost && g?.solution?.path) net.send(solutionMsg(g), id);
}
function receiveSolution(m) {
  const g = state.game;
  if (!g || m.gid !== g.id || g.solution?.path) return;
  const s = cleanSolution(m);
  if (!s) return;
  g.solution = s;
  if (net.isHost) shareSolution(g);
  if (state.view === 'result') renderSolution(g);
}

// ---------- 解答影片：一步一步播放「在哪一頁點哪個連結」，可以暫停、上一步、下一步、調速度 ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 也用來重播任何人走過的路線（結算畫面、後台的對局紀錄）：r = { path, via?, settings, who? }
const player = { r: null, i: 0, playing: true, speed: 1, token: 0, arts: [], backs: [] };
function playReplay(g) {
  if (g.solution?.path) playRoute({ path: g.solution.path, via: g.solution.via, settings: g.settings });
}
// 哪幾步是按「上一頁」：照遊戲的規則模擬一次（往前走把目前這頁放進堆疊，上一頁從堆疊拿出來）
function backSteps(path) {
  const stack = [];
  return path.slice(0, -1).map((t, i) => {
    if (stack.length && stack[stack.length - 1] === path[i + 1]) { stack.pop(); return true; }
    stack.push(t);
    return false;
  });
}
function playRoute(r) {
  const path = (r.path || []).filter(Boolean);
  if (path.length < 2) return;
  const n = path.length - 1;
  const sol = { ...r, path };
  Object.assign(player, { r: sol, i: 0, playing: true, backs: backSteps(path), arts: [] });
  $('#replay').hidden = false;
  document.body.classList.add('replaying');
  $('#replay-dots').replaceChildren(...path.map((t, i) => {
    const li = Object.assign(document.createElement('li'), { textContent: tw(t), className: i === 0 ? 'start' : i === n ? 'goal' : '' });
    li.onclick = () => replayGo(i);
    return li;
  }));
  paintSpeed();
  replayGo(0);
}

// 跳到第 i 頁：顯示那一頁、捲到要點的連結、手指點一下；播放中就接著下一頁
async function replayGo(i) {
  const sol = player.r;
  if (!sol?.path) return;
  const { path } = sol;
  const n = path.length - 1;
  i = Math.max(0, Math.min(n, i));
  player.i = i;
  const token = ++player.token;
  const alive = () => token === player.token && !$('#replay').hidden;
  const slow = (ms) => wait(ms / player.speed);
  const settings = { ...sol.settings };
  const key = settings.lang === 'zh' ? (t) => tw(t) : (t) => t;
  $('#replay-finger').hidden = true;
  $('#replay-backtap').hidden = true;
  $('#replay-dots').querySelectorAll('li').forEach((li, k) => { li.classList.toggle('on', k === i); li.classList.toggle('past', k < i); });
  $('#replay-dots').children[i]?.scrollIntoView({ block: 'nearest', inline: 'center' });
  const won = sol.reached ?? true;
  $('#replay-step').textContent = (sol.who ? `${sol.who}・` : '') + (i < n ? `第 ${i + 1} 步 / 共 ${n} 步` : won ? '🎉 抵達終點！' : '走到這裡為止');
  const back = i < n && player.backs[i];
  $('#replay-hint').textContent = i < n ? (back ? `按「上一頁」回到《${tw(path[i + 1])}》` : `在《${tw(path[i])}》找到「${tw(path[i + 1])}」`) : `《${tw(path[i])}》`;
  $('#replay-prev').disabled = i === 0;
  $('#replay-next').disabled = i === n;
  paintPlay();
  $('#replay-loading').hidden = false;
  // 播到哪一頁才讀那一頁，順便先讀下一頁（長路線一次全部讀會被維基百科擋）
  const artAt = (k) => (k <= n ? (player.arts[k] ||= getArticle(settings.lang, path[k]).catch(() => { player.arts[k] = null; return null; })) : null);
  const art = await artAt(i);
  artAt(i + 1);
  if (!alive()) return;
  $('#replay-loading').hidden = true;
  if (art) fillArticle($('#replay-article'), $('#replay-title'), art, settings);
  else { $('#replay-title').textContent = tw(path[i]); $('#replay-article').replaceChildren(); }
  $('#replay-scroll').scrollTo(0, 0);
  if (i === n) { player.playing = false; paintPlay(); if (won) confetti(); return; }
  await slow(700);
  if (!alive()) return;
  if (back) {
    // 按上一頁：沒有連結可以點，顯示「↩️ 上一頁」被按了一下
    const b = $('#replay-backtap');
    b.hidden = false;
    b.classList.remove('tap');
    void b.offsetWidth;
    b.classList.add('tap');
    await slow(1400);
    if (alive() && player.playing) replayGo(i + 1);
    return;
  }
  // 要點的連結：驗證時記下的那一個，或任何連到下一站（含重新導向名稱）的連結
  const links = [...$('#replay-article').querySelectorAll('a.wl')];
  let a = sol.via?.[i] ? links.find((x) => x.dataset.title === sol.via[i]) : null;
  if (!a) {
    const names = await namesOf(settings.lang, path[i + 1], key).catch(() => new Set([key(path[i + 1])]));
    if (!alive()) return;
    a = links.find((x) => names.has(key(x.dataset.title)));
  }
  if (a) {
    a.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await slow(900);
    if (!alive()) return;
    a.classList.add('replay-hit');
    const r = a.getBoundingClientRect();
    const f = $('#replay-finger');
    f.style.left = `${r.left + Math.min(r.width / 2, 60)}px`;
    f.style.top = `${r.bottom - 6}px`;
    f.hidden = false;
    f.classList.remove('tap');
    void f.offsetWidth;
    f.classList.add('tap');
    await slow(1400);
  } else {
    $('#replay-hint').textContent += '（連結在頁面裡比較隱蔽）';
    await slow(1500);
  }
  if (alive() && player.playing) replayGo(i + 1);
}

function paintPlay() {
  const end = player.r?.path && player.i >= player.r.path.length - 1;
  const b = $('#replay-play');
  const label = player.playing ? ['⏸', '暫停'] : end ? ['⟲', '重播'] : ['▶', '播放'];
  b.firstChild.textContent = label[0];
  b.querySelector('small').textContent = label[1];
  b.setAttribute('aria-label', label[1]);
}
function paintSpeed() {
  $('#replay-speed').firstChild.textContent = `${player.speed}×`;
}
function replayToggle() {
  const n = (player.r?.path.length || 1) - 1;
  if (!player.playing && player.i >= n) { player.playing = true; replayGo(0); return; }  // 播完了：從頭再播
  player.playing = !player.playing;
  paintPlay();
  if (player.playing) replayGo(player.i);  // 從這一頁接著播
}
function closeReplay() {
  player.token++;
  $('#replay').hidden = true;
  document.body.classList.remove('replaying');
  // 從連結直接打開的重播（#replay=…）：關掉後把網址清乾淨
  if (location.hash.startsWith('#replay=')) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* 忽略 */ } }
}

// 結算畫面「🎬 重播」：重播某個人走過的路線
function routeReplayButton(name, path, settings, reached) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'route-replay', textContent: '🎬 重播' });
  b.hidden = !path || path.length < 2;
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); playRoute({ path, settings, who: name, reached }); };
  return b;
}

// 網址帶 #replay=<資料>：直接播放一段路線（後台「所有對局」的重播用）
function openReplayFromHash() {
  if (!location.hash.startsWith('#replay=')) return false;
  try {
    const d = JSON.parse(decodeURIComponent(location.hash.slice(8)));
    const path = (Array.isArray(d.p) ? d.p : []).map((t) => String(t).slice(0, 200)).slice(0, 200);
    if (path.length < 2) return false;
    playRoute({ path, settings: { ...DEFAULT_SETTINGS, lang: d.l === 'en' ? 'en' : 'zh', start: path[0], target: String(d.t || path[path.length - 1]) }, who: String(d.n || '').slice(0, 16), reached: d.r === 'win' });
    return true;
  } catch { return false; }
}

// ---------- 全體投票拿提示 ----------
// 比賽超過 3 分鐘，還在比的人都同意，就給大家看終點條目的簡介（把終點的名字遮起來）
const HINT_MIN = 3;
const HINT_AFTER = HINT_MIN * 60 * 1000;

// 第二個提示（5 分鐘）：列出幾個「有連結直接通到終點」的條目，走到其中一個，下一步就能到。
// 一樣要還在比的人都同意；房主挑好後傳給大家（每個人看到的都一樣）
const HINT2_MIN = 5;
const HINT2_AFTER = HINT2_MIN * 60 * 1000;
const hintOf = (g, lv) => (lv === 2 ? g.hint2 : g.hint);
// 提示列現在在問哪一個提示：第二個提示開放之後就問第二個
const hintLv = (g) => (g.hint2?.offered && !g.hint2.shown ? 2 : 1);

function offerHint(lv = 1) {
  const g = state.game;
  const h = g && hintOf(g, lv);
  if (!g || g.finished || h.offered || h.shown) return;
  h.offered = true;
  $('#hint-bar').hidden = false;
  renderHintBar();
  const min = lv === 2 ? HINT2_MIN : HINT_MIN;
  const what = lv === 2 ? '第二個提示（直接通到終點的條目）' : '提示';
  toast(state.solo ? `已經 ${min} 分鐘了！卡住的話可以看${what}` : `已經 ${min} 分鐘了！大家都同意就能看${what}`, 3000);
  sfx.near();
}

function renderHintBar() {
  const g = state.game;
  const lv = hintLv(g);
  const h = hintOf(g, lv);
  const btn = $('#btn-hint-vote');
  if (state.solo) {
    btn.disabled = false;
    btn.textContent = lv === 2 ? '🧭 看第二個提示' : '💡 看提示';
    $('#hint-ask-text').textContent = lv === 2 ? '還是卡住？看看哪些條目直接通到終點' : '卡住了嗎？看一下終點的提示';
    return;
  }
  btn.disabled = h.myVote;
  btn.textContent = h.myVote ? '✓ 已同意' : lv === 2 ? '🧭 我要第二個提示' : '💡 我要提示';
  $('#hint-ask-text').textContent = h.need
    ? `${lv === 2 ? '第二個提示' : '提示'}投票：${h.yes.length} / ${h.need} 人同意${h.myVote && h.yes.length < h.need ? '，等其他人…' : ''}`
    : lv === 2 ? `比了 ${HINT2_MIN} 分鐘還沒到？大家都同意就能看「直接通到終點的條目」` : `比了 ${HINT_MIN} 分鐘還沒到？大家都同意就能看提示`;
}

function voteHint() {
  const g = state.game;
  if (!g || g.finished) return;
  const lv = hintLv(g);
  const h = hintOf(g, lv);
  if (h.myVote || h.shown) return;
  h.myVote = true;
  if (state.solo) { revealHint(lv); return; }  // 單人訓練：不用投票，直接看提示
  renderHintBar();
  if (net.isHost) hostHintVote(state.myId, lv);
  else net.send({ t: 'hintvote', lv });
}

// 房主：統計還在比、還連著線的人有沒有都同意
function hostHintVote(pid, lv = 1) {
  const g = state.game;
  if (!g || hintOf(g, lv).shown) return;
  hintOf(g, lv).votes.add(pid);
  checkHintVotes(lv);
}

function checkHintVotes(lv) {
  // 沒指定哪一個：有人比完、離開、斷線時兩個提示的投票都要重算（還在比的人變少，可能就全體同意了）
  if (lv === undefined) { checkHintVotes(1); checkHintVotes(2); return; }
  const g = state.game;
  const h = g && hintOf(g, lv);
  if (!g || h.shown || !h.votes.size) return;
  const racers = [...g.others.values()].filter((o) => !o.finished && !o.left && !o.offline).map((o) => o.id);
  if (!g.finished) racers.push(state.myId);
  const yes = racers.filter((id) => h.votes.has(id));
  const tally = { t: 'hinttally', lv, yes, need: racers.length };
  net.send(tally);
  applyHintTally(tally);
  if (racers.length && yes.length >= racers.length) revealHint(lv);
}

// 大家都同意了（或單人訓練）：打開提示；第二個提示由房主挑好再傳給大家
async function revealHint(lv) {
  const g = state.game;
  if (lv !== 2) {
    if (!state.solo) net.send({ t: 'hint' });
    showHint();
    return;
  }
  if (g.hint2.picking) return;
  g.hint2.picking = true;
  const near = await nearTarget(g).catch(() => []);
  if (state.game !== g) return;
  if (!state.solo) net.send({ t: 'hint', lv: 2, near });
  showHint2(near);
}

function applyHintTally(msg) {
  const g = state.game;
  const lv = msg.lv === 2 ? 2 : 1;
  const h = g && hintOf(g, lv);
  if (!g || h.shown) return;
  h.yes = Array.isArray(msg.yes) ? msg.yes : [];
  h.need = Number(msg.need) || 0;
  if (!h.offered && !g.finished) offerHint(lv);
  if (!g.finished) renderHintBar();
}

// 挑 3 個有連結直接通到終點、而且比較有名（在題庫裡）的條目；用這一局的代號決定順序，同一局每次挑的都一樣
async function nearTarget(g) {
  const { set, key } = await loadBackSet(g);
  let pop = new Set();
  try { pop = await popularOf(g.settings.lang); } catch { /* 題庫讀不到：照名字長短挑 */ }
  const avoid = new Set([key(g.settings.target), key(g.settings.start), ...g.path.map(key)]);
  const all = [...set].filter((t) => !avoid.has(t) && !/[:：]/.test(t));
  const hash = (t) => { let h = 2166136261; for (const c of `${g.id}|${t}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const famous = all.filter((t) => pop.has(t)).sort((a, b) => hash(a) - hash(b));
  const rest = all.filter((t) => !pop.has(t)).sort((a, b) => a.length - b.length || hash(a) - hash(b));
  return [...famous, ...rest].slice(0, 3);
}

// 打開第二個提示（第一個提示還沒看的話一起打開）
function showHint2(near, { quiet = false } = {}) {
  const g = state.game;
  if (!g || g.hint2.shown) return;
  g.hint2.shown = true;
  g.hint2.offered = true;
  g.hint2.near = near;
  if (!g.hint.shown) showHint({ quiet: true });
  $('#hint-bar').hidden = true;
  $('#hint-near').hidden = false;
  $('#hint-near-list').replaceChildren(...(near.length ? near : ['（這一題找不到，只能靠自己了！）']).map((t) => Object.assign(document.createElement('span'), { textContent: tw(t) })));
  if (g.finished) return;
  $('#btn-hint-open').hidden = false;
  $('#btn-hint-open').textContent = '💡 提示 ×2';
  if (!quiet) { sfx.ready(); haptic('success'); openHint(); }
}

// quiet：重新整理或斷線重連回來時，只把「💡 提示」按鈕放回去，不再跳視窗、不再響
async function showHint({ quiet = false } = {}) {
  const g = state.game;
  if (!g || g.hint.shown) return;
  g.hint.shown = true;
  // 第一個提示看完了，但第二個提示已經開放投票：提示列繼續留著問第二個
  $('#hint-bar').hidden = !(g.hint2?.offered && !g.hint2.shown);
  if (!$('#hint-bar').hidden) renderHintBar();
  if (g.finished) return;
  $('#hint-text').textContent = '讀取提示中…';
  // 目標列出現「💡 提示」按鈕，第一次直接打開給大家看，之後隨時可以再點開
  const btn = $('#btn-hint-open');
  btn.hidden = false;
  if (!quiet) {
    sfx.ready();
    haptic('success');
    btn.classList.remove('fresh');
    void btn.offsetWidth;
    btn.classList.add('fresh');
    openHint();
  }
  try {
    const d = await wiki.api(g.settings.lang, { action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', exsentences: '4', redirects: '1', titles: g.settings.target });
    await zhReady;
    let text = d.query?.pages?.[0]?.extract || '';
    if (g.settings.lang === 'zh') text = tw(text);
    text = maskTitle(text.replace(/\s+/g, ' ').trim(), g.settings.target, g.settings.lang);
    $('#hint-text').textContent = text || '找不到這個條目的簡介，只能靠你自己了！';
  } catch (e) {
    reportError('hint', e);
    $('#hint-text').textContent = `提示讀取失敗（${e.message}）`;
  }
}

function openHint() { $('#hint-modal').hidden = false; }
function closeHint() { $('#hint-modal').hidden = true; }

// 把終點的名字（含去掉括號的版本）換成底線，免得提示直接說出答案
function maskTitle(text, title, lang) {
  const names = new Set([title, title.replace(/\s*[（(].*?[）)]\s*$/, '')]);
  if (lang === 'zh') for (const n of [...names]) names.add(tw(n));
  let out = text;
  for (const n of [...names].filter((x) => x.length >= 1).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), lang === 'en' ? 'gi' : 'g');
    out = out.replace(re, '＿＿＿');
  }
  return out;
}

// ---------- 道具賽 ----------
// 每 40 秒自動發一個道具（最多帶 2 個）；離終點越遠的人拿到越強的道具
const ITEMS = {
  fog: { icon: '🌫️', name: '迷霧', desc: '對手的條目變得模糊 8 秒', kind: 'attack', ms: 8000 },
  flip: { icon: '🙃', name: '天旋地轉', desc: '對手的條目上下顛倒 8 秒', kind: 'attack', ms: 8000 },
  freeze: { icon: '🧊', name: '冰凍', desc: '對手 5 秒內什麼都不能點', kind: 'attack', ms: 5000 },
  banana: { icon: '🍌', name: '香蕉皮', desc: '對手下一次點連結會滑倒，跑去隨機的條目', kind: 'attack', ms: 30000 },
  snail: { icon: '🐌', name: '蝸牛', desc: '對手 15 秒內每次換頁都慢 2 秒', kind: 'attack', ms: 15000 },
  bolt: { icon: '⚡', name: '閃電', desc: '所有對手一起冰凍 3 秒', kind: 'all', ms: 3000 },
  shield: { icon: '🛡️', name: '護盾', desc: '擋下 30 秒內的下一次攻擊', kind: 'self', ms: 30000 },
  crystal: { icon: '🔮', name: '水晶球', desc: '標出這一頁「下一步就能到終點」的連結', kind: 'self' },
  // 比步數專用：直接影響步數
  heavy: { icon: '🎒', name: '重擔', desc: '對手下一次點連結算 2 步', kind: 'attack', ms: 120000, only: 'steps' },
  free: { icon: '👟', name: '免費一步', desc: '自己下一次點連結不算步數', kind: 'self', ms: 120000, only: 'steps' },
};
// 拖時間的道具在比步數沒有用，只在比速度出現
for (const k of ['freeze', 'bolt', 'snail']) ITEMS[k].only = 'speed';
// 這一局（或這個玩法）用得到的道具
const itemsFor = (steps) => Object.entries(ITEMS).filter(([, it]) => !it.only || it.only === (steps ? 'steps' : 'speed'));
// 比步數的人會想比較久：香蕉皮、重擔留到他下一次點為止（最多 2 分鐘），不會因為想太久就失效
const fxMs = (g, item) => (isSteps(g) && (item === 'banana' || item === 'heavy') ? 120000 : ITEMS[item].ms);
// 持續型效果在畫面上的樣子：壞的紅色、好的綠色
const FX = {
  fog: { icon: '🌫️', bad: true }, flip: { icon: '🙃', bad: true }, freeze: { icon: '🧊', bad: true },
  banana: { icon: '🍌', bad: true }, snail: { icon: '🐌', bad: true }, shield: { icon: '🛡️', bad: false },
  heavy: { icon: '🎒', bad: true, text: '下一步算 2 步' }, free: { icon: '👟', bad: false, text: '下一步免費' },
};
const MAX_ITEMS = 2;
const ITEM_EVERY = 40000;
const ITEM_EVERY_STEPS = 3;  // 比步數：每走 3 步發一個
// 依照離終點的遠近發道具：落後的人拿強的，領先的人拿弱的
const ITEM_TIERS = {
  behind: { bolt: 3, freeze: 3, banana: 3, crystal: 3, snail: 2 },
  even: { fog: 3, flip: 2, snail: 2, freeze: 1, banana: 1, shield: 2, crystal: 2 },
  lead: { fog: 3, flip: 3, shield: 3, snail: 1 },
};
// 比步數用的另一組：香蕉皮、重擔、水晶球、免費一步
const ITEM_TIERS_STEPS = {
  behind: { banana: 3, heavy: 3, crystal: 3, free: 2 },
  even: { fog: 2, flip: 2, banana: 2, heavy: 2, shield: 2, crystal: 2, free: 1 },
  lead: { fog: 3, flip: 3, shield: 3, heavy: 1 },
};
const TIER_NOTE = { behind: '落後補給', even: '', lead: '領先者' };

function resetItems() {
  const g = state.game;
  if (!g) return;
  g.items = [];
  g.fx = {};
  g.backSet = null;
  g.dist = null;
  g.nextItemAt = 0;
  g.itemSteps = 0;  // 比步數：上一個道具之後走了幾步
  $('#item-dock').hidden = !isItems(g);
  // 先在背景查好「哪些條目會連到終點」，用來判斷大家離終點多遠
  // 每一種玩法都先查好「哪些條目會連到終點」，用來顯示大家離終點多遠（道具賽也用來決定道具強弱）
  {
    loadBackSet(g).then(() => {
      if (state.game !== g || g.finished || !g.current) return;
      g.dist = distanceHere(g);
      sendProgress({ t: 'progress', title: g.current, clicks: g.clicks, near: g.near, path: g.path, d: g.dist });
    }, () => {});
  }
  renderItems();
  applyFx();
}

function renderItems() {
  const g = state.game;
  $$('.item-slot').forEach((b, i) => {
    const it = g?.items?.[i];
    b.textContent = it ? ITEMS[it].icon : '';
    b.hidden = !it;
    b.setAttribute('aria-label', it ? `使用${ITEMS[it].name}` : `道具欄 ${i + 1}（空）`);
  });
  renderItemTimer();
}

// 下一個道具的倒數（點一下看道具說明）
function renderItemTimer() {
  const g = state.game;
  if (!g || !isItems(g)) return;
  const el = $('#item-timer');
  if (g.items.length >= MAX_ITEMS) { el.textContent = '🎁 滿了'; return; }
  if (isSteps(g)) { el.textContent = `🎁 再 ${Math.max(1, ITEM_EVERY_STEPS - (g.itemSteps || 0))} 步`; return; }
  if (!g.nextItemAt) { el.textContent = '🎁 準備中'; return; }
  el.textContent = `🎁 ${Math.max(0, Math.ceil((g.nextItemAt - performance.now()) / 1000))}s`;
}

// 離終點幾步：這頁有終點連結＝1，有連到「會連到終點的條目」＝2，其他＝3
function distanceHere(g) {
  if ($('#article a.is-target')) return 1;
  const bs = g.backReady;
  if (!bs) return null;
  if ([...$('#article').querySelectorAll('a.wl')].some((a) => bs.set.has(bs.key(a.dataset.title)))) return 2;
  return 3;
}

// 跟其他還在比的人比遠近，決定這次發哪一級的道具
function itemTier(g) {
  const mine = g.dist ?? 3;
  const others = [...g.others.values()].filter((o) => !o.left).map((o) => (o.finished?.reason === 'win' ? 0 : o.finished ? null : o.dist ?? 3)).filter((d) => d !== null);
  if (!others.length) return 'even';
  const best = Math.min(...others);
  if (mine > best) return 'behind';
  if (mine < best) return 'lead';
  return 'even';
}

function rollItem(tier, steps = false) {
  const w = (steps ? ITEM_TIERS_STEPS : ITEM_TIERS)[tier];
  let r = Math.random() * Object.values(w).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(w)) { r -= v; if (r < 0) return k; }
  return 'fog';
}

// 發一個道具（欄位滿了就不發）
function giveItem(g) {
  if (g.items.length >= MAX_ITEMS) return;
  const tier = itemTier(g);
  const it = rollItem(tier, isSteps(g));
  g.items.push(it);
  renderItems();
  sfx.ready();
  haptic('success');
  toast(`🎁 拿到 ${ITEMS[it].icon} ${ITEMS[it].name}！${TIER_NOTE[tier] ? `（${TIER_NOTE[tier]}）` : ''}`, 2200);
}

// 比步數：每走 3 步發一個（換頁成功後呼叫）
function itemStep(g) {
  if (!isItems(g) || !isSteps(g) || g.finished) return;
  if (g.items.length >= MAX_ITEMS) { g.itemSteps = 0; renderItemTimer(); return; }  // 滿了就不累積
  g.itemSteps = (g.itemSteps || 0) + 1;
  if (g.itemSteps >= ITEM_EVERY_STEPS) { g.itemSteps = 0; giveItem(g); }
  renderItemTimer();
}

// 計時器每次跑都檢查：時間到就發一個道具（比步數改成看走了幾步，見 itemStep）
function itemClock(g) {
  if (!g.startAt) return;
  if (isSteps(g)) { renderItemTimer(); return; }
  // 下一次發道具的時間（重新整理接回來時，不補發錯過的道具）
  if (!g.nextItemAt) g.nextItemAt = g.startAt + Math.max(1, Math.ceil(elapsed() / ITEM_EVERY)) * ITEM_EVERY;
  if (performance.now() >= g.nextItemAt) {
    g.nextItemAt += ITEM_EVERY;
    giveItem(g);
  }
  renderItemTimer();
}

const fxOn = (g, k) => (g?.fx?.[k] || 0) > performance.now();

// 依照效果剩餘時間更新畫面（跟著計時器每 0.2 秒跑一次）
function applyFx() {
  const g = state.game;
  const now = performance.now();
  const on = (k) => !!g && !g.finished && fxOn(g, k);
  $('#article').classList.toggle('fx-fog', on('fog'));
  $('#article').classList.toggle('fx-flip', on('flip'));
  $('#view-game .paper').classList.toggle('fx-freeze', on('freeze'));
  const chips = g && !g.finished ? Object.entries(FX).filter(([k]) => on(k)).map(([k, f]) => {
    const el = document.createElement('span');
    el.className = `fx-chip ${f.bad ? 'bad' : 'good'}`;
    el.textContent = k === 'banana' ? `${f.icon} 小心腳下` : f.text ? `${f.icon} ${f.text}` : `${f.icon} ${Math.ceil((g.fx[k] - now) / 1000)}s`;
    return el;
  }) : [];
  $('#fx-bar').hidden = !chips.length;
  $('#fx-bar').replaceChildren(...chips);
}

async function useItem(slot) {
  const g = state.game;
  const it = g?.items?.[slot];
  if (!it || g.finished) return;
  const def = ITEMS[it];
  if (def.kind === 'self') {
    g.items.splice(slot, 1);
    renderItems();
    if (it === 'shield') {
      g.fx.shield = performance.now() + def.ms;
      toast('🛡️ 護盾展開！下一次攻擊會被擋下', 2000);
      sfx.ready();
    } else if (it === 'crystal') {
      runCrystal();
    } else if (it === 'free') {
      g.fx.free = performance.now() + def.ms;
      toast('👟 下一次點連結不算步數！', 2000);
      sfx.ready();
    }
    applyFx();
    return;
  }
  const targets = [...g.others.values()].filter((o) => !o.finished && !o.left);
  if (!targets.length) { toast('沒有可以攻擊的對手'); return; }
  let to = 'all';
  if (def.kind === 'attack') {
    to = targets.length === 1 ? targets[0].id : await pickPlayer({
      title: `${def.icon} ${def.name}要丟給誰？`,
      sub: def.desc,
      players: targets.map((o) => ({ ...o, note: o.near ? '快到了！' : `${o.clicks} 步` })),
    });
    if (!to || state.game !== g || g.finished || g.items[slot] !== it) return;
  }
  g.items.splice(slot, 1);
  renderItems();
  sfx.go();
  haptic('medium');
  const toName = to === 'all' ? '所有對手' : nameOf(to);
  feed([`你對 `, { b: toName }, ` 使用了 ${def.icon} ${def.name}`], '道具');
  const msg = { t: 'item', item: it, to };
  if (net.isHost) net.send({ ...msg, from: state.myId });
  else net.send(msg);
}

// 收到有人用了道具：打到自己就套用效果（有護盾就擋下），其他人只看到戰報
function onItem(from, item, to) {
  const g = state.game;
  const def = ITEMS[item];
  if (!g || !def || from === state.myId) return;
  const fromName = nameOf(from);
  const hitsMe = (to === state.myId || to === 'all') && !g.finished;
  if (!hitsMe) {
    if (!g.finished) feed([{ b: fromName }, ` 對 ${to === 'all' ? '所有人' : nameOf(to)} 用了 ${def.icon} ${def.name}`], '道具');
    return;
  }
  if (fxOn(g, 'shield')) {
    g.fx.shield = 0;
    applyFx();
    showHit('🛡️', `擋下了 ${fromName} 的 ${def.icon} ${def.name}！`, true);
    sfx.ready();
    const msg = { t: 'itemblock', item, from };
    if (net.isHost) net.send({ ...msg, by: state.myId });
    else net.send(msg);
    return;
  }
  const key = item === 'bolt' ? 'freeze' : item;
  g.fx[key] = performance.now() + fxMs(g, item);
  applyFx();
  showHit(def.icon, `${fromName} 對你用了「${def.name}」！`);
  sfx.alarm();
  haptic('error');
  shake($('#hud'));
}

function onItemBlocked(by, item, from) {
  const g = state.game;
  if (!g || g.finished || by === state.myId) return;
  const def = ITEMS[item];
  if (!def) return;
  if (from === state.myId) toast(`🛡️ ${nameOf(by)} 用護盾擋下了你的 ${def.icon} ${def.name}！`, 2500);
  else feed([{ b: nameOf(by) }, ` 用 🛡️ 擋下了 ${def.icon} ${def.name}`], '道具');
}

let hitTimer;
function showHit(icon, text, good = false) {
  const el = $('#item-hit');
  $('#item-hit-icon').textContent = icon;
  $('#item-hit-text').textContent = text;
  el.classList.toggle('good', good);
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(hitTimer);
  hitTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

// 「會連到終點的條目」名單：水晶球和判斷遠近共用，一局只查一次
function loadBackSet(g) {
  g.backSet ||= (async () => {
    await zhReady;
    const key = g.settings.lang === 'zh' ? (t) => tw(t) : (t) => t;
    const set = new Set();
    let cont = {};
    for (let i = 0; i < 4 && cont; i++) {
      const d = await wiki.api(g.settings.lang, { action: 'query', list: 'backlinks', bltitle: g.settings.target, blnamespace: '0', bllimit: 'max', blredirect: '1', ...cont });
      for (const b of d.query?.backlinks || []) {
        if (!b.redirect) set.add(key(b.title));
        for (const r of b.redirlinks || []) set.add(key(r.title));
      }
      cont = d.continue || null;
    }
    g.backReady = { set, key };
    return g.backReady;
  })();
  g.backSet.catch(() => { g.backSet = null; });
  return g.backSet;
}

// 水晶球：找出這一頁裡「會連到終點」的條目，下一步就能到
async function runCrystal() {
  const g = state.game;
  toast('🔮 水晶球占卜中…', 1500);
  try {
    const { set, key } = await loadBackSet(g);
    if (state.game !== g || g.finished) return;
    const hits = [...$('#article').querySelectorAll('a.wl')].filter((a) => a.dataset.title === g.settings.target || set.has(key(a.dataset.title)));
    hits.forEach((a) => a.classList.add('crystal'));
    if (hits.length) {
      showHit('🔮', `這頁有 ${new Set(hits.map((a) => a.dataset.title)).size} 個連結，下一步就能到終點！`, true);
      hits[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      showHit('🔮', '這頁沒有能直達終點的連結，換個方向吧！', true);
    }
    sfx.near();
  } catch (e) {
    reportError('crystal', e);
    g.backSet = null;
    toast(`水晶球失靈了（${e.message}）`);
  }
}

// 道具說明：照目前的玩法（比賽中看這一局，房間裡看房間設定）列出用得到的道具
function openItemsGuide() {
  const steps = goalSteps(state.game && !state.game.finished ? state.game.settings.goal : state.settings.goal);
  const row = (it) => {
    const li = document.createElement('li');
    li.className = it.kind === 'self' ? 'self' : 'atk';
    li.append(Object.assign(document.createElement('i'), { textContent: it.icon }));
    const d = document.createElement('div');
    d.append(Object.assign(document.createElement('b'), { textContent: it.name }), Object.assign(document.createElement('small'), { textContent: it.desc }));
    li.append(d);
    return li;
  };
  const list = itemsFor(steps).map(([, it]) => it);
  $('#items-list-atk').replaceChildren(...list.filter((it) => it.kind !== 'self').map(row));
  $('#items-list-self').replaceChildren(...list.filter((it) => it.kind === 'self').map(row));
  $('#items-title').textContent = steps ? '🎁 道具賽教學（比步數）' : '🎁 道具賽教學（比速度）';
  $('#items-step1').innerHTML = steps
    ? '<b>道具會自動發</b>：每走 3 步發一個，最多帶 2 個，右下角會顯示還要走幾步。'
    : '<b>道具會自動發</b>：比賽開始後每 40 秒發一個，最多帶 2 個，右下角會顯示下一個還要幾秒。';
  $('#items-step2').innerHTML = steps
    ? '<b>落後的人拿比較強的</b>：離終點越遠，越容易拿到香蕉皮、重擔這種會讓對手多走步數的道具；領先的人只拿得到比較弱的。'
    : '<b>落後的人拿比較強的</b>：離終點越遠，越容易拿到閃電、冰凍這種強力道具；領先的人只拿得到比較弱的。';
  $('#items-modal').hidden = false;
}

function initItems() {
  $$('.item-slot').forEach((b) => { b.onclick = () => useItem(Number(b.dataset.slot)); });
  const close = () => { $('#items-modal').hidden = true; store.set('wikirace-items-guide', '1'); };
  $('#item-timer').onclick = openItemsGuide;
  $('#item-guide').onclick = openItemsGuide;
  $('#room-items-help').onclick = openItemsGuide;
  $('#items-ok').onclick = close;
  $('#items-close').onclick = close;
  $('#items-modal').addEventListener('click', (e) => { if (e.target.id === 'items-modal') close(); });
  // 搶分賽規則
  const closeRush = () => { $('#rush-modal').hidden = true; store.set('wikirace-rush-guide', '1'); };
  $('#room-rush-help').onclick = () => { $('#rush-modal').hidden = false; };
  $('#rush-ok').onclick = closeRush;
  $('#rush-close').onclick = closeRush;
  $('#rush-modal').addEventListener('click', (e) => { if (e.target.id === 'rush-modal') closeRush(); });
}

// ---------- 觀戰：比完的人看還在比的人 ----------
const racers = (g) => (g?.finished ? [...g.others.values()].filter((o) => !o.finished && !o.left) : []);
let watchTimer = null;
const artCache = new Map();
function stopWatchTimer() { clearInterval(watchTimer); watchTimer = null; }

function openWatch(id) {
  const g = state.game;
  const list = racers(g);
  if (!list.length) { toast('大家都比完了'); return; }
  state.watch.id = list.some((o) => o.id === id) ? id : list[0].id;
  state.watch.shown = null;
  setFollow(true);
  show('watch');
  $('#watch-goal').textContent = tw(g.settings.target);
  stopWatchTimer();
  const paintTime = () => { $('#watch-timer').textContent = fmtTime(elapsed()); };
  paintTime();
  watchTimer = setInterval(paintTime, 500);
  renderWatch(true);
}

function renderWatch(moved = false) {
  const g = state.game;
  const o = g?.others.get(state.watch.id);
  if (!o || state.view !== 'watch') return;
  paintAvatar($('#watch-avatar'), o);
  $('#watch-avatar').style.setProperty('--side', o.color || '#fff');
  $('#watch-name').textContent = o.name;
  $('#watch-steps').textContent = o.clicks;
  const st = $('#watch-status');
  st.className = '';
  if (o.finished?.reason === 'win') { st.textContent = '抵達終點！'; st.classList.add('done'); }
  else if (o.finished) st.textContent = o.finished.reason === 'giveup' ? '投降了' : '時間到';
  else if (o.left) st.textContent = '離線了';
  else if (o.offline) st.textContent = `斷線中，等待重新連線…${waitLeft(o)}`;
  else if (o.near) { st.textContent = '終點連結就在這一頁！'; st.classList.add('near'); }
  else st.textContent = `正在看《${tw(o.current)}》`;
  if (moved) {
    const box = $('#watch-steps').parentElement;
    box.classList.remove('bump');
    void box.offsetWidth;
    box.classList.add('bump');
  }
  // 路線：只顯示最後幾站
  const path = o.path.length ? o.path : [g.settings.start];
  const shown = path.slice(-4).map((t) => tw(t));
  $('#watch-path').textContent = `路線：${path.length > 4 ? '… › ' : ''}${shown.join(' › ')}`;
  // 上方切換觀戰對象（管理員觀戰時由 startAdminWatch 自己畫）
  if (state.adminWatch) { if (o.current && state.watch.shown !== o.current) loadWatchArticle(o.current); return; }
  const tabs = [...g.others.values()].filter((p) => !p.left).map((p) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.classList.toggle('on', p.id === o.id);
    b.classList.toggle('near', !!p.near && !p.finished);
    b.disabled = !!p.finished;
    b.append(avatarEl(p, 'sm'), `${p.name} · ${p.finished?.reason === 'win' ? '抵達' : p.finished ? '出局' : `${p.clicks} 步`}`);
    b.onclick = () => { if (p.id !== state.watch.id) { state.watch.id = p.id; setFollow(true); renderWatch(true); } };
    li.append(b);
    return li;
  });
  $('#watch-tabs').replaceChildren(...tabs);
  if (state.watch.shown !== o.current) loadWatchArticle(o.current);
}

async function loadWatchArticle(title) {
  const g = state.game;
  const token = (state.watch.token = (state.watch.token || 0) + 1);
  state.watch.shown = title;
  state.watch.ready = false;
  $('#watch-loading').hidden = false;
  const key = `${g.settings.lang}:${title}`;
  try {
    if (!artCache.has(key)) artCache.set(key, wiki.fetchArticle(g.settings.lang, title));
    const art = await artCache.get(key);
    if (token !== state.watch.token || state.view !== 'watch') return;
    fillArticle($('#watch-article'), $('#watch-title'), art, g.settings);
    state.watch.ready = true;
    window.scrollTo(0, 0);
    applyLiveView();
  } catch (e) {
    reportError('watch', e);
    artCache.delete(key);
    if (token === state.watch.token) { state.watch.shown = null; toast(`載入失敗：${e.message}`); }
  } finally {
    if (token === state.watch.token) $('#watch-loading').hidden = true;
  }
}

// 收到比賽中玩家的即時畫面
function onLive(id, live) {
  const w = state.watch;
  w.live ||= {};
  if (live.t === 'view') w.live[id] = live;
  if (state.view !== 'watch' || id !== w.id || live.p !== w.shown || !w.ready) return;
  if (live.t === 'view') applyLiveView();
  else showTap(live.n);
}

function applyLiveView() {
  const w = state.watch;
  const v = w.live?.[w.id];
  if (!w.follow || !v || v.p !== w.shown || !w.ready) return;
  const blocks = blocksOf($('#watch-article'));
  const el = blocks[Math.min(v.i, blocks.length - 1)];
  if (!el) return;
  const r = el.getBoundingClientRect();
  const line = $('.watch-bar').getBoundingClientRect().bottom + 10;
  const top = Math.max(0, scrollY + r.top + v.f * r.height - line);
  // 距離很遠就直接跳過去，近的才用滑的，才不會跟不上
  window.scrollTo({ top, behavior: Math.abs(top - scrollY) > innerHeight * 1.5 ? 'auto' : 'smooth' });
}

function showTap(n) {
  const a = $('#watch-article').querySelectorAll('a.wl')[n];
  if (!a) return;
  $('#watch-article').querySelectorAll('a.peek').forEach((x) => x.classList.remove('peek'));
  a.classList.add('peek');
  setTimeout(() => a.classList.remove('peek'), 1600);
  const st = $('#watch-status');
  st.textContent = `👆 點了《${a.textContent.trim() || tw(a.dataset.title)}》`;
  st.className = 'tap';
  const r = a.getBoundingClientRect();
  const top = $('.watch-bar').getBoundingClientRect().bottom;
  if (state.watch.follow && (r.top < top || r.bottom > innerHeight)) {
    a.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// 自己動手捲動就先不跟著他，按按鈕再跟回去
function setFollow(on) {
  state.watch.follow = on;
  $('#btn-follow').hidden = on;
  if (on) applyLiveView();
}

// 正在看的人比完或離開：告訴大家，然後換看下一位，沒人可看就回到結果
function watchedLeft(id, reason) {
  if (state.view !== 'watch') return;
  const g = state.game;
  const o = g?.others.get(id);
  if (!o) return;
  if (id !== state.watch.id) { renderWatch(); return; }
  const what = { win: '抵達終點了！', giveup: '投降了', timeout: '時間到了', left: '離線了' }[reason] || '比完了';
  toast(`${o.name} ${what}`, 2500);
  if (reason === 'win') sfx.ready();
  renderWatch();
  setTimeout(() => {
    if (state.view !== 'watch' || state.watch.id !== id) return;
    const next = racers(g)[0];
    if (next) { state.watch.id = next.id; renderWatch(true); } else showResult(true);
  }, 2200);
}

// ---------- 分享戰績圖 ----------
let shareUrl = null;
let shareFile = null;
async function openShare() {
  const g = state.game;
  if (!g?.finished) return;
  const btn = $('#btn-share');
  btn.disabled = true;
  try {
    await zhReady;
    const info = resultInfo(g);
    const me = g.finished;
    const meP = state.players.get(state.myId);
    const data = {
      mode: g.mode, kicker: info.kicker, title: info.title, tone: info.tone,
      start: tw(g.settings.start), target: tw(g.settings.target),
      url: `${location.host}${location.pathname}`.replace(/\/$/, ''),
      me: {
        name: state.myName, avatar: state.myAvatar, color: g.mode === 'party' ? meP?.color : '#2f7bff', steps: me.clicks,
        time: fmtTime(me.elapsed), result: resultLabel(me), path: me.path.map((t) => tw(t)),
      },
    };
    if (g.mode === 'party') {
      data.ranking = info.entries.map((e) => ({ place: e.place, name: e.name, avatar: e.avatar, color: e.color, stat: rankStatus(e), me: e.me }));
    } else {
      const o = [...g.others.values()][0];
      if (o) data.opp = { name: o.name, avatar: o.avatar, color: o.color, result: o.finished ? `${resultLabel(o.finished)} · ${o.clicks} 步` : (o.left ? '離線' : `${o.clicks} 步`) };
    }
    const blob = await makeShareImage(data);
    if (!blob) throw new Error('圖片產生失敗');
    if (shareUrl) URL.revokeObjectURL(shareUrl);
    shareUrl = URL.createObjectURL(blob);
    shareFile = new File([blob], '維基競速戰績.png', { type: 'image/png' });
    $('#share-img').src = shareUrl;
    $('#share-save').href = shareUrl;
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [shareFile] }));
    $('#share-go').hidden = !canShare;
    $('#share-tip').textContent = canShare ? '按「分享」直接傳給朋友，或長按圖片儲存' : '長按圖片可以儲存到相簿';
    $('#share-modal').hidden = false;
    sfx.ready();
  } catch (e) {
    reportError('share', e);
    toast(`沒辦法產生戰績圖：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function initResult() {
  $('#btn-rematch').onclick = () => {
    if (state.solo) { if (state.daily) openDaily(); else openSolo(); return; }  // 單人訓練：再出一題；每日挑戰：回到今天的題目
    // 派對還沒全部比完就先回房間：用目前的名次記進最近對戰
    const g = state.game;
    if (g?.finished && !loadHistory().some((h) => h.id === g.id)) saveHistory(g, resultInfo(g));
    enterRoom(net.code);
  };
  $('#btn-solo-home').onclick = exitSolo;
  $('#btn-share').onclick = openShare;
  $('#pick-close').onclick = () => closePick(null);
  $('#pick-modal').addEventListener('click', (e) => { if (e.target.id === 'pick-modal') closePick(null); });
  $('#btn-solve').onclick = () => { if (state.game) findSolution(state.game); };
  $('#btn-replay').onclick = () => { if (state.game) playReplay(state.game); };
  $('#replay-close').onclick = closeReplay;
  $('#replay-again').onclick = () => { player.playing = true; replayGo(0); };
  $('#replay-play').onclick = replayToggle;
  // 上一步、下一步：停在那一頁讓人看清楚（不自動往下播）
  $('#replay-prev').onclick = () => { player.playing = false; replayGo(player.i - 1); };
  $('#replay-next').onclick = () => { player.playing = false; replayGo(player.i + 1); };
  $('#replay-speed').onclick = () => { player.speed = player.speed === 1 ? 2 : player.speed === 2 ? 0.5 : 1; paintSpeed(); };
  // 示範畫面裡的連結只是給人看，不能點
  $('#replay-article').addEventListener('click', (e) => { if (e.target.closest('a')) e.preventDefault(); });
  $('#btn-watch').onclick = () => openWatch();
  $('#btn-watch-back').onclick = () => showResult(true);
  $('#btn-follow').onclick = () => setFollow(true);
  // 只有真的用手指或滑鼠捲動才算「自己在看」
  for (const ev of ['touchmove', 'wheel']) {
    window.addEventListener(ev, () => { if (state.view === 'watch' && state.watch.follow) setFollow(false); }, { passive: true });
  }
  $('#share-close').onclick = () => { $('#share-modal').hidden = true; };
  $('#share-modal').addEventListener('click', (e) => { if (e.target.id === 'share-modal') $('#share-modal').hidden = true; });
  $('#share-go').onclick = async () => {
    if (!shareFile) return;
    try {
      await navigator.share({ files: [shareFile], title: '維基競速', text: '來挑戰我的維基競速戰績！' });
    } catch (e) {
      if (e.name !== 'AbortError') toast('分享失敗，可以長按圖片儲存');
    }
  };
}

// ---------- 聊天室 ----------
function renderChat() {
  for (const box of $$('[data-chat]')) {
    const log = box.querySelector('.chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const items = state.chat.map((m) => {
      const li = document.createElement('li');
      if (m.kind === 'sys') {
        li.className = 'chat-sys';
        li.textContent = m.text;
        return li;
      }
      li.className = 'chat-msg';
      if (m.id === state.myId) li.classList.add('mine');
      li.append(avatarEl(m, 'sm'));
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.append(Object.assign(document.createElement('b'), { textContent: m.name }), Object.assign(document.createElement('span'), { textContent: m.text }));
      li.append(bubble);
      return li;
    });
    if (!items.length) items.push(Object.assign(document.createElement('li'), { className: 'chat-sys', textContent: '還沒有人說話，打聲招呼吧！' }));
    log.replaceChildren(...items);
    if (atBottom || log.dataset.init !== '1') { log.scrollTop = log.scrollHeight; log.dataset.init = '1'; }
  }
}

function pushChat(m) {
  state.chat.push(m);
  if (state.chat.length > CHAT_MAX) state.chat.splice(0, state.chat.length - CHAT_MAX);
  renderChat();
  if (m.kind === 'msg' && m.id !== state.myId && (state.view === 'room' || state.view === 'result')) { sfx.tick(); haptic('light'); }
}

// 房主：所有聊天訊息經過房主整理後再廣播
function hostChat(m) {
  if (m.kind === 'msg') m = { ...m, text: maskText(m.text) };
  pushChat(m);
  net.send({ t: 'chat', m });
}

function sysChat(text) {
  if (!net.isHost) return;
  hostChat({ kind: 'sys', text, ts: Date.now() });
}

// 同一個人太頻繁就擋掉
function tooFast(id, ms) {
  const now = Date.now();
  if (now - (lastSpeak.get(id) || 0) < ms) return true;
  lastSpeak.set(id, now);
  return false;
}

function sendChat(text) {
  text = text.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!text) return false;
  if (tooFast(`chat:${state.myId}`, 600)) { toast('說慢一點喔'); return false; }
  if (net.isHost) {
    const p = state.players.get(state.myId);
    hostChat({ kind: 'msg', id: state.myId, name: state.myName, avatar: state.myAvatar, color: p?.color, text, ts: Date.now() });
  } else {
    net.send({ t: 'chat', text });
  }
  return true;
}

function initChat() {
  for (const f of $$('.chat-form')) {
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = f.querySelector('.chat-input');
      if (sendChat(input.value)) input.value = '';
    });
  }
}

// ---------- 快速表情 ----------
function closeEmotes() { $('#emote-tray').hidden = true; }

function sendEmote(e) {
  if (!EMOTES.includes(e)) return;
  if (tooFast(`emote:${state.myId}`, 2000)) { toast('表情冷卻中…', 1000); return; }
  showEmote(state.myId, e);
  if (net.isHost) net.send({ t: 'emote', id: state.myId, e });
  else net.send({ t: 'emote', e });
}

// 屏蔽表情：別人的表情和快捷語都不顯示（自己的照常）
let emotesMuted = store.get('wikirace-emote-mute') === '1';

function showEmote(id, e) {
  if (emotesMuted && id !== state.myId) return;
  const p = personOf(id);
  const el = document.createElement('div');
  el.className = 'emote-pop';
  if (id === state.myId) el.classList.add('mine');
  const isText = !/\p{Extended_Pictographic}/u.test(e);
  // 快捷語比較寬，靠中間一點才不會超出畫面
  el.style.left = isText ? `${32 + Math.random() * 36}%` : `${12 + Math.random() * 64}%`;
  el.append(avatarEl(p, 'sm'));
  const body = document.createElement('div');
  body.className = 'emote-body';
  body.append(Object.assign(document.createElement('span'), { className: isText ? 'emote-text' : 'emote-emoji', textContent: e }));
  body.append(Object.assign(document.createElement('small'), { textContent: id === state.myId ? '你' : p.name }));
  el.append(body);
  $('#emote-layer').append(el);
  setTimeout(() => el.remove(), 2800);
  if (id !== state.myId) { sfx.oppMove(); haptic('light'); }
}

function initEmotes() {
  const make = (e, cls) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: e });
    b.onclick = () => { sendEmote(e); closeEmotes(); };
    return b;
  };
  $('#emote-grid').replaceChildren(...EMOJIS.map((e) => make(e, 'emote-btn')));
  $('#phrase-grid').replaceChildren(...PHRASES.map((e) => make(e, 'phrase-btn')));
  $('#emote-mute').checked = emotesMuted;
  $('#emote-mute').onchange = () => {
    emotesMuted = $('#emote-mute').checked;
    store.set('wikirace-emote-mute', emotesMuted ? '1' : '0');
    if (emotesMuted) $$('.emote-pop:not(.mine)').forEach((el) => el.remove());
    toast(emotesMuted ? '已屏蔽別人的表情' : '已顯示別人的表情', 1500);
  };
  for (const b of $$('[data-emote-open]')) {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const tray = $('#emote-tray');
      tray.hidden = !tray.hidden;
      tray.classList.toggle('in-game', state.view === 'game');
    });
  }
  document.addEventListener('click', (ev) => {
    // iPhone 震動用的隱藏開關也會觸發點擊，不能把它當成點了外面
    if (!ev.isTrusted || ev.target.closest('[data-haptic]')) return;
    if (!$('#emote-tray').hidden && !ev.target.closest('#emote-tray')) closeEmotes();
  });
}

// ---------- 新手教學 ----------
let openTutorial = () => {};
function initTutorial() {
  const track = $('#tut-track');
  const slides = [...track.children];
  const dots = $('#tut-dots');
  dots.replaceChildren(...slides.map((_, n) => {
    const d = Object.assign(document.createElement('button'), { type: 'button', className: 'tut-dot' });
    d.setAttribute('aria-label', `第 ${n + 1} 頁`);
    d.onclick = () => go(n);
    return d;
  }));
  let i = 0;
  const go = (n) => {
    i = Math.max(0, Math.min(slides.length - 1, n));
    track.style.transform = `translateX(-${i * 100}%)`;
    dots.querySelectorAll('.tut-dot').forEach((d, k) => d.classList.toggle('on', k === i));
    slides.forEach((s, k) => s.classList.toggle('active', k === i));
    $('#tut-prev').disabled = i === 0;
    $('#tut-next').textContent = i === slides.length - 1 ? (newbieAfter() ? '🐣 玩第一局！' : '開始玩！') : '下一步';
  };
  // 第一次玩、不是從邀請連結來的：看完教學直接玩一局簡單的
  const newbieAfter = () => isNewPlayer() && state.view === 'home' && !$('#join-code').value;
  const close = (play = false) => {
    $('#tutorial').hidden = true;
    store.set('wikirace-tutorial-done', '1');
    if (play && newbieAfter()) { startNewbie(); return; }
    // 從邀請連結進來的人看完教學，直接接著填暱稱
    if (state.view === 'home' && $('#join-code').value) ($('#nickname').value ? $('#btn-join') : $('#nickname')).focus();
  };
  $('#tut-next').onclick = () => (i === slides.length - 1 ? close(true) : go(i + 1));
  $('#tut-prev').onclick = () => go(i - 1);
  $('#tut-skip').onclick = () => close();
  // 左右滑動換頁
  let sx = null;
  track.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    sx = null;
    if (Math.abs(dx) > 40) go(i + (dx < 0 ? 1 : -1));
  });
  openTutorial = () => { go(0); $('#tutorial').hidden = false; };
  $('#btn-tutorial').onclick = openTutorial;
}

// 第一次比賽時，指出畫面上的重點
const COACH = [
  { sel: ['.hud-target'], title: '這是你的終點', text: '抵達這個條目就贏了！計時已經開始囉。' },
  { sel: ['#article a.wl'], title: '點藍色連結前進', text: '每點一次算一步，看到金色的連結就是終點！' },
  { sel: ['.tabbar'], title: '下方的小工具', text: '走錯了按「上一頁」，也能看路線、丟表情或投降。' },
];
// 第一次玩搶分賽：指出分數、這一題的終點、跳過鍵
const COACH_RUSH = [
  { sel: ['.hud-target'], title: '這一題的終點', text: '抵達就 +1 分，馬上換下一題！旁邊會顯示現在是第幾題。' },
  { sel: ['.racer-steps'], title: '這是你的分數', text: '時間內搶越多分越好；同分時比總步數，步數少的贏。' },
  { sel: ['#btn-rush-skip'], title: '卡住就跳過', text: '每局可以跳過 2 題（不加分）。按一下會先問你，再按一次才會跳。' },
  { sel: ['#article a.wl'], title: '點藍色連結前進', text: '跟一般比賽一樣，只能點條目裡的連結。開始搶分吧！' },
];

function runCoach() {
  const rush = isRush();
  const steps = rush ? COACH_RUSH : COACH, key = rush ? 'wikirace-rush-coach-done' : 'wikirace-coach-done';
  if (store.get(key) || state.view !== 'game' || state.game?.finished) return;
  const coach = $('#coach');
  let step = 0;
  const place = () => {
    const s = steps[step];
    const el = s.sel.flatMap((q) => [...document.querySelectorAll(q)]).find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
    });
    if (!el) { next(); return; }
    const r = el.getBoundingClientRect();
    const pad = 6;
    const ring = $('#coach-ring');
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    $('#coach-title').textContent = s.title;
    $('#coach-text').textContent = s.text;
    $('#coach-step').textContent = `${step + 1} / ${steps.length}　點一下繼續`;
    const bubble = $('#coach-bubble');
    const below = r.bottom + 160 < innerHeight;
    bubble.style.top = below ? `${r.bottom + 14}px` : '';
    bubble.style.bottom = below ? '' : `${innerHeight - r.top + 14}px`;
    bubble.classList.toggle('above', !below);
  };
  const next = () => {
    step++;
    if (step >= steps.length || state.view !== 'game' || state.game?.finished) {
      coach.hidden = true;
      store.set(key, '1');
      return;
    }
    place();
  };
  coach.onclick = next;
  coach.hidden = false;
  place();
}

// ---------- 暱稱一定要取 ----------
// 單人訓練、新手第一局：還沒有暱稱就先跳出視窗取一個（線上名單、排行榜上才不會一堆人沒名字）
function askName() {
  const cur = $('#nickname').value.trim();
  if (cur && !badName(cur) && !reservedName(cur)) { store.set('wikirace-name', cur); return Promise.resolve(cur); }
  return new Promise((resolve) => {
    const m = $('#name-modal');
    m.hidden = false;
    $('#name-input').value = cur;
    showError('#name-error', !cur ? '' : reservedName(cur) ? `「${cur}」不能當暱稱，取一個專屬的名字吧` : '這個暱稱不太好，換一個吧');
    setTimeout(() => $('#name-input').focus(), 60);
    const done = (v) => { m.hidden = true; resolve(v); };
    $('#name-go').onclick = () => {
      const n = $('#name-input').value.trim();
      if (!n) { showError('#name-error', '請輸入暱稱'); $('#name-input').focus(); return; }
      if (badName(n)) { showError('#name-error', '這個暱稱不太好，換一個吧'); $('#name-input').focus(); return; }
      if (reservedName(n)) { showError('#name-error', `「${n}」不能當暱稱，取一個專屬的名字吧`); $('#name-input').focus(); return; }
      $('#nickname').value = n;
      store.set('wikirace-name', n);
      $('#nickname').dispatchEvent(new Event('input'));
      saveProfile({ n });
      done(n);
    };
    $('#name-input').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#name-go').click(); } };
    $('#name-cancel').onclick = () => done(null);
  });
}

// ---------- 閒置檢查 ----------
// 10 分鐘沒有任何動作（點、滑、打字）就問「你還在嗎？」，1 分鐘內沒按就離開：
// 在房間或多人比賽中＝離開房間（房主交給下一位），其他時候＝離開線上名單、顯示「你離開一陣子了」。
// 觀戰中、倒數中不檢查（本來就不用碰螢幕）。
const IDLE_MS = 10 * 60 * 1000;
let idleGrace = 60 * 1000;
let lastAct = Date.now();
let idleTimer = null;
let away = false;
function idleExempt() {
  return state.view === 'watch' || !$('#countdown').hidden || !!adminWatchKey || !$('#away-screen').hidden;
}
function checkIdle() {
  if (away || !$('#idle-modal').hidden) return;
  if (idleExempt()) { lastAct = Date.now(); return; }
  if (Date.now() - lastAct >= IDLE_MS) openIdle();
}
const inRoomNow = () => !!net.code && !state.solo;
function openIdle() {
  const m = $('#idle-modal');
  m.hidden = false;
  $('#idle-what').textContent = inRoomNow() ? '離開房間' : '離開線上名單';
  sfx.alarm();
  haptic('warning');
  const end = Date.now() + idleGrace;
  const tickIdle = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    $('#idle-left').textContent = String(left);
    if (left <= 0) { clearInterval(idleTimer); goAway(); }
  };
  tickIdle();
  clearInterval(idleTimer);
  idleTimer = setInterval(tickIdle, 250);
  $('#idle-stay').onclick = () => { clearInterval(idleTimer); m.hidden = true; lastAct = Date.now(); };
}
function goAway() {
  $('#idle-modal').hidden = true;
  away = true;
  try { sessionStorage.setItem('wikirace-away', inRoomNow() ? 'room' : 'online'); } catch { /* 忽略 */ }
  if (inRoomNow()) {
    // 房主不見：房間交給下一位（跟按「離開」一樣），沒有其他人就直接關掉
    const next = net.isHost && onlineGuests()[0];
    if (next) migrateHost(next.id, { leaving: true });
    else leaveRoom();
    return;
  }
  showAway('online');
}
function showAway(kind) {
  away = true;
  leaveOnline();
  $('#away-text').textContent = kind === 'room' ? '超過 10 分鐘沒有動作，已經幫你離開房間了。' : '超過 10 分鐘沒有動作，已經先把你從線上名單拿掉。';
  $('#away-screen').hidden = false;
}
function initIdle() {
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    addEventListener(ev, () => { if (!away && $('#idle-modal').hidden) lastAct = Date.now(); }, { capture: true, passive: true });
  }
  setInterval(checkIdle, 5000);
  // 分頁從背景回來（手機凍結期間計時器都停了）：馬上檢查一次
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkIdle(); });
  window.addEventListener('pageshow', checkIdle);
  window.addEventListener('focus', checkIdle);
  $('#away-back').onclick = () => { try { sessionStorage.removeItem('wikirace-away'); } catch { /* 忽略 */ } location.reload(); };
}

// ---------- 帳號（Google 登入） ----------
// 不登入也能玩；登入之後暱稱、頭像、戰績存在雲端，每日挑戰的成績才會上排行榜
const fbOn = () => !!window.WIKIRACE_FIREBASE?.databaseURL;
let syncedUid = null;
function paintAccount() {
  const me = account();
  const btn = $('#acct-btn');
  btn.hidden = !fbOn();
  btn.classList.toggle('on', !!me);
  $('#acct-label').textContent = me ? `✓ ${me.name || me.email || '已登入'}` : '用 Google 登入';
  btn.title = me ? `已用 Google 登入：${me.email}（按一下可以登出）` : '登入後戰績存在雲端，也能登上每日排行榜';
  $('#daily-login').hidden = !!me || !fbOn();
  const d = state.daily;
  if (d && !$('#daily-result').hidden) paintDailyLogin(d);
}
function paintDailyLogin(d) {
  const m = myDay(d.key);
  const need = fbOn() && !account() && d.first && d.started && !!m?.win && !m.sent;
  $('#dres-login').hidden = !need;
  if (need) $('#dres-sub').textContent = '完成了！成績先記在這支手機上。';
}
async function onAccountChange(me) {
  paintAccount();
  if (!me || syncedUid === me.uid) return;
  syncedUid = me.uid;
  // 雲端和這支手機的資料合併：暱稱、頭像以雲端為準，戰績取場數多的
  // 這支手機上的戰績是誰的：之前是別的帳號（同一支手機換人登入）就不要合併進來，直接用雲端的
  const owner = store.get('wikirace-stats-owner');
  const mine = !owner || owner === me.uid;
  const stats = Object.fromEntries(Object.keys(GOALS).map((g) => [g, mine ? loadStats(g) : { w: 0, l: 0, d: 0, streak: 0 }]));
  const p = await syncProfile({ name: $('#nickname').value.trim() || store.get('wikirace-name') || '', avatar: state.myAvatar, stats });
  if (p) {
    if (p.n && !badName(p.n)) {
      store.set('wikirace-name', p.n);
      if (document.activeElement !== $('#nickname')) $('#nickname').value = p.n;
    }
    if (cleanAvatar(p.a)) { state.myAvatar = cleanAvatar(p.a); store.set('wikirace-avatar', state.myAvatar); }
    paintAvatar($('#home-avatar'), { name: $('#nickname').value, avatar: state.myAvatar });
    for (const [g, st] of Object.entries(p.st || {})) store.set(statsKey(g), JSON.stringify(st));
    store.set('wikirace-stats-owner', me.uid);
    renderStats();
  }
  // 今天的每日挑戰：之前沒登入、成績還沒上榜的，現在補上
  const key = todayKey();
  resendDaily(key).then(() => {
    refreshDailyHome();
    const d = state.daily;
    if (d && d.key === key && !$('#daily-result').hidden) { paintDailyLogin(d); refreshDailyRank(d); if (myDay(key)?.sent) $('#dres-sub').textContent = '正式成績已登上今日排行榜，分享給朋友比比看！'; }
    if (!$('#daily-modal').hidden) renderDailyBoard(key);
  });
}
async function doLogin(btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await login();
    // 這個 Google 帳號以前就登入過（別的手機）：換成那個身分，重新載入一次
    if (r.switched) { toast('已登入！換成你原本的帳號…', 2000); setTimeout(() => location.reload(), 700); return; }
    if (r.ok) { toast('✅ 已用 Google 登入：戰績會存在雲端', 2500); onAccountChange(account()); }
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    if (btn) btn.disabled = false;
  }
}
function initAccountUi() {
  onAccount((me) => onAccountChange(me));
  initAccount();
  paintAccount();
  $('#acct-btn').onclick = async () => {
    const me = account();
    if (!me) { doLogin($('#acct-btn')); return; }
    if (!confirm(`已用 Google 登入：${me.email}\n要登出嗎？（登出後這支手機的戰績還在，之後再登入會接回來）`)) return;
    await logout();
    location.reload();
  };
  $('#dres-login-btn').onclick = () => doLogin($('#dres-login-btn'));
  $('#daily-login-btn').onclick = () => doLogin($('#daily-login-btn'));
}

// ---------- 搶分賽 ----------
// 房主出題：從熱門條目出發，沿著連結隨機走幾步，走到的地方就是終點（保證走得到）；困難就是完全隨機的兩個條目
const cleanRushQ = (list) => (Array.isArray(list) ? list.slice(0, 120).filter((q) => q && typeof q.s === 'string' && typeof q.t === 'string').map((q) => ({ s: q.s.slice(0, 200), t: q.t.slice(0, 200) })) : []);
// 年份、日期、列表、其他命名空間：當終點太無聊也太難猜
const junkTitle = (t) => /^\d|年$|年代|世紀$|月\d+日|^\d+月|列表|:/.test(t);
let popularKeys = null;
const popularSets = new Map();  // 語言 → 轉換好的集合（一萬多個條目，只轉一次）
async function popularOf(lang) {
  popularKeys ||= import('./topics.js?v=111').then((m) => m.TOPICS).catch(() => []);
  if (!popularSets.has(lang)) popularSets.set(lang, new Set((await popularKeys).map(nameKey(lang))));
  return popularSets.get(lang);
}
async function rushPuzzle(s) {
  const lvl = RUSH_LEVELS[s.rushLevel] || RUSH_LEVELS.normal;
  const key = nameKey(s.lang);
  const start = await wiki.resolveTitle(s.lang, await wiki.randomTitle(s.lang, false));
  if (lvl.hops) {
    try {
      const pop = await popularOf(s.lang);
      const seen = new Set([key(start)]);
      let cur = start;
      for (let i = 0; i < lvl.hops; i++) {
        const links = [...new Set(await clickableLinks(s, cur))].filter((t) => !seen.has(key(t)) && !junkTitle(t));
        if (!links.length) throw new Error('走不下去');
        const good = links.filter((t) => pop.has(key(t)));
        const list = good.length ? good : links;
        cur = list[Math.floor(Math.random() * list.length)];
        seen.add(key(cur));
      }
      const target = await wiki.resolveTitle(s.lang, cur);
      if (key(target) !== key(start)) return { s: start, t: target };
    } catch { /* 走不出去：改用隨機的終點 */ }
  }
  let target = start;
  for (let i = 0; i < 5 && target === start; i++) target = await wiki.resolveTitle(s.lang, await wiki.randomTitle(s.lang, false));
  return { s: start, t: target };
}
// 房主：比賽中在背景繼續出題，出好一題就傳給大家（每個人拿到的順序都一樣）
async function rushFill(g) {
  if (!net.isHost || g.rushFilling) return;
  g.rushFilling = true;
  // 只比跑最快的人多準備幾題就好（出題要下載好幾個條目，不要一次出太多）
  const want = () => Math.max(g.rushIdx, ...[...g.others.values()].map((o) => o.qi || 0)) + 4;
  let fails = 0;
  while (state.game === g && !allDone(g) && g.rushQ.length < 120) {
    if (g.rushQ.length >= want()) { await new Promise((r) => { setTimeout(r, 1000); }); continue; }
    try {
      const q = await rushPuzzle(g.settings);
      if (state.game !== g) break;
      g.rushQ.push(q);
      net.send({ t: 'rushq', gid: g.id, list: g.rushQ });
      if (g.rushWait && !g.finished) rushGo(g);
      fails = 0;
    } catch {
      fails++;  // 網路不穩、維基百科忙：等久一點再試（不放棄，不然大家會卡在「下一題準備中」）
    }
    await new Promise((r) => { setTimeout(r, fails ? Math.min(10000, 1000 * fails) : 300); });
  }
  g.rushFilling = false;
}
function receiveRushQ(msg) {
  const g = state.game;
  if (!g || !isRush(g) || msg.gid !== g.id) return;
  const list = cleanRushQ(msg.list);
  if (list.length <= g.rushQ.length) return;
  g.rushQ = list;
  if (g.rushWait && !g.finished) rushGo(g);
}

// 換到第 rushIdx 題：題目還沒出好就先等
function rushGo(g) {
  if (state.game !== g || g.finished) return;
  if (g.loading) { setTimeout(() => rushGo(g), 200); return; }
  const q = g.rushQ[g.rushIdx];
  renderRush(g);
  if (!q) {
    g.rushWait = true;
    $('#article-title').textContent = '下一題準備中…';
    $('#article').replaceChildren(Object.assign(document.createElement('p'), { className: 'rush-wait', textContent: '房主正在出下一題，馬上就好！' }));
    $('#breadcrumb').textContent = '';
    return;
  }
  g.rushWait = false;
  g.settings.start = q.s;
  g.settings.target = q.t;
  targetSet(g.settings);
  g.path = [];
  g.stack = [];
  g.spots = [];
  g.current = null;
  g.near = false;
  g.dist = null;
  g.backSet = null;
  g.backReady = null;
  $('#hud-target').textContent = tw(q.t);
  $('#hud-alert-me').hidden = true;
  $('#btn-back').disabled = true;
  closeFind();
  goTo(q.s, { first: true });
}
function disarmSkip() {
  skipArmed = 0;
  const btn = $('#btn-rush-skip');
  btn.classList.remove('armed');
  btn.lastElementChild.replaceChildren('跳過 ', Object.assign(document.createElement('b'), { id: 'rush-skips', textContent: String(state.game?.skips ?? RUSH_SKIPS) }));
}
function renderRush(g) {
  $('#hud-clicks').textContent = String(g.score);
  if (!skipArmed) $('#rush-skips').textContent = String(g.skips);
  $('#btn-rush-skip').disabled = g.skips <= 0 || g.finished || g.rushWait;
  renderGoal();
}
// 抵達這一題的終點：+1 分，馬上換下一題
// 這一題走完了（抵達或跳過）：記下路線，結算時給大家看
function rushRecord(g, r) {
  (g.rushDone ||= []).push({ s: g.settings.start, t: g.settings.target, p: [...g.path], r });
}
function rushScore(g) {
  rushRecord(g, 'ok');
  g.score++;
  g.scoreAt = elapsed();
  g.rushIdx++;
  flash('#ffc53d');
  sfx.near();
  haptic('success');
  toast(`🎯 +1 分！抵達《${tw(g.settings.target)}》`, 1800);
  sendProgress({ t: 'progress', title: g.current || g.settings.start, clicks: g.clicks, near: false, path: g.path });
  renderRush(g);
  setTimeout(() => rushGo(g), 500);
}
// 按一下先問「確定跳過？」，3 秒內再按一次才跳（比賽中不跳視窗，也不會不小心跳掉）
let skipArmed = 0;
function rushSkip() {
  const g = state.game;
  if (!g || !isRush(g) || g.finished || g.skips <= 0 || g.rushWait) return;
  const btn = $('#btn-rush-skip');
  if (Date.now() - skipArmed > 3000) {
    skipArmed = Date.now();
    btn.classList.add('armed');
    btn.lastElementChild.textContent = '確定跳過？';
    toast(`再按一次就跳過這一題（不加分，這一局還能跳過 ${g.skips} 次）`, 2500);
    setTimeout(() => { if (Date.now() - skipArmed >= 3000) disarmSkip(); }, 3050);
    return;
  }
  disarmSkip();
  rushRecord(g, 'skip');
  g.skips--;
  g.rushIdx++;
  toast(`⏭️ 跳過《${tw(g.settings.target)}》`, 1800);
  sendProgress({ t: 'progress', title: g.current || g.settings.start, clicks: g.clicks, near: false, path: g.path });  // 還在載入（current 是空的）也要有標題，不然房主會丟掉這筆
  rushGo(g);
}

// ---------- 新手第一局 ----------
// 第一次玩的人先玩一題保證簡單（兩步就到）的題目，邊玩邊提示：先給方向，停太久就直接指出要點哪個連結
// path：在真的維基百科上確認過每一步都點得到（scripts/solvecheck.mjs 的 PATHS）
const NEWBIE = [
  ['珍珠奶茶', '臺灣', '臺北市'],
  ['珍珠奶茶', '臺灣', '玉山'],
  ['披薩', '義大利', '羅馬'],
  ['大熊貓', '中國', '北京市'],
  ['可口可樂', '美國', '紐約'],
  ['漢堡', '美國', '自由女神像'],
  ['拉麵', '日本', '富士山'],
  ['咖哩', '印度', '恆河'],
  ['足球', '巴西', '亞馬遜河'],
];
const NEWBIE_NUDGE = 10000;  // 這麼久還沒動：說出要找哪個連結
const NEWBIE_SHOW = 20000;   // 再久一點：直接捲過去閃給他看
const isNewPlayer = () => !store.get('wikirace-newbie-done') && !store.get('wikirace-coach-done') && !loadHistory().length;
function renderNewbieHome() {
  $('#btn-newbie').hidden = !isNewPlayer();
}

let newbieBusy = false;
async function startNewbie() {
  if (newbieBusy) return;
  const path = NEWBIE[Math.floor(Math.random() * NEWBIE.length)];
  if (!(await askName())) return;  // 一定要先取暱稱
  newbieBusy = true;
  const btn = $('#btn-newbie');
  btn.disabled = true;
  const s = { ...DEFAULT_SETTINGS, lang: 'zh', goal: 'speed', start: path[0], target: path[path.length - 1], allowBack: true, trueRandom: false, allowFind: false, newbie: path };
  try {
    // 換成維基百科上的正式標題（抵達終點要比對標題）
    s.start = await wiki.resolveTitle(s.lang, s.start);
    s.target = await wiki.resolveTitle(s.lang, s.target);
  } catch (e) {
    toast('網路好像不太穩，等一下再試一次');
    return;
  } finally {
    newbieBusy = false;
    btn.disabled = false;
  }
  if (state.view !== 'home') return;
  soloSetup($('#nickname').value.trim());
  state.daily = null;
  state.settings = s;
  for (const m of ['#solo-modal', '#tutorial', '#daily-modal']) $(m).hidden = true;
  setConn('新手第一局');
  startGame(s, randomKey());
  notify('solo', '有新玩家在玩新手第一局', `${tw(s.start)} → ${tw(s.target)}`);
}

let newbieTimers = [];
function clearNewbie() {
  newbieTimers.forEach(clearTimeout);
  newbieTimers = [];
  $('#newbie-tip').hidden = true;
  $('#btn-back').classList.remove('newbie-glow');
}
function newbieSay(text, { find = null } = {}) {
  $('#newbie-text').textContent = text;
  const b = $('#newbie-find');
  b.hidden = !find;
  b.onclick = find;
  const tip = $('#newbie-tip');
  tip.hidden = false;
  tip.classList.remove('pop');
  void tip.offsetWidth;
  tip.classList.add('pop');
}
// 每到一頁：看看這一頁該點哪個連結，分段給提示
async function newbieStep(g) {
  clearNewbie();
  const path = g.settings.newbie;
  if (!Array.isArray(path) || g.finished) return;
  const here = g.current;
  const alive = () => state.game === g && !g.finished && g.current === here;
  // 第一次比賽的畫面導覽還開著：等他看完再開始提示和計時
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
  await wait(500);
  while (alive() && !$('#coach').hidden) await wait(300);
  if (!alive()) return;
  const target = tw(g.settings.target);
  if (g.near) {
    const flash = () => { const a = $('#article a.is-target'); if (a) jumpToLink(a); };
    newbieSay(`這一頁就有終點《${target}》的連結（金色的），找到它點下去！`, { find: flash });
    newbieTimers.push(setTimeout(() => { if (alive()) flash(); }, NEWBIE_NUDGE));
    return;
  }
  const key = (t) => tw(t);
  // 現在在路線上的第幾站（用重新導向名稱比對，簡繁、別名都算）
  let idx = -1;
  for (let i = path.length - 2; i >= 0 && idx < 0; i--) {
    const names = await namesOf('zh', path[i], key).catch(() => new Set([key(path[i])]));
    if (names.has(key(here))) idx = i;
  }
  if (!alive()) return;
  if (idx < 0) {
    newbieSay(g.stack.length ? '走到別的地方了，沒關係！按下面的「上一頁」回去再找找看' : `想想看，什麼跟《${target}》有關？`);
    if (g.stack.length) $('#btn-back').classList.add('newbie-glow');
    return;
  }
  $('#btn-back').classList.remove('newbie-glow');
  const next = path[idx + 1];
  newbieSay(idx === 0 ? `終點是《${target}》。想一想：這一頁哪個藍色連結跟它有關？` : `很好！離《${target}》更近了，再找找看`);
  let link = null;
  const findLink = async () => {
    if (link?.isConnected) return link;
    const names = await namesOf('zh', next, key).catch(() => new Set([key(next)]));
    link = [...$('#article').querySelectorAll('a.wl')].find((a) => names.has(key(a.dataset.title))) || null;
    return link;
  };
  const show = async () => { const a = await findLink(); if (alive() && a) jumpToLink(a); };
  newbieTimers.push(setTimeout(() => { if (alive()) newbieSay(`提示：找找看「${tw(next)}」這個連結，${tw(next)}跟《${target}》很有關係`, { find: show }); }, NEWBIE_NUDGE));
  newbieTimers.push(setTimeout(() => { if (alive()) show(); }, NEWBIE_SHOW));
}

// ---------- 連線：房主這一側 ----------
function removePlayer(pid, { kicked = false } = {}) {
  const p = state.players.get(pid);
  clearTimeout(graceTimers.get(pid));
  graceTimers.delete(pid);
  if (!p) return;
  state.players.delete(pid);
  toast(kicked ? `已把 ${p.name} 請出房間` : `${p.name} 離開了`, 3000);
  sysChat(kicked ? `${p.name} 被房主請出房間` : `${p.name} 離開了`);
  net.send({ t: 'left', id: pid });
  onOtherLeft(pid);
  if (!net.connected) setConn(isParty() ? '等待玩家' : '對手已離線');
  broadcastLobby();
}

function markOffline(pid) {
  const p = state.players.get(pid);
  if (!p || p.online === false) return;
  p.online = false;
  const wait = stillRacing(pid) ? GRACE_GAME : GRACE_ROOM;
  net.send({ t: 'presence', id: pid, online: false, wait });
  onPresence(pid, false, wait);
  broadcastLobby();
  // 還在比賽中的人多給一點時間回來（就算房主已經回到房間也一樣）
  const inRace = stillRacing(pid);
  clearTimeout(graceTimers.get(pid));
  graceTimers.set(pid, setTimeout(() => removePlayer(pid), inRace ? GRACE_GAME : GRACE_ROOM));
  if (state.game) checkHintVotes();
}

net.onPeerLeave = (pid) => {
  if (!pid) return;
  const p = state.players.get(pid);
  if (!p) return;
  if (p.leaving) removePlayer(pid);
  else markOffline(pid);
};

// 玩家送來的進度與結果先整理過，格式不對就丟掉，免得轉給大家後讓別人的畫面出錯
const cleanPath = (p) => (Array.isArray(p) ? p.filter((t) => typeof t === 'string').slice(0, 200).map((t) => t.slice(0, 200)) : []);
// 搶分賽每一題走過的路線：{ s 起點, t 終點, p 路線, r 'ok' 抵達／'skip' 跳過 }
const cleanRoutes = (rr) => (Array.isArray(rr) ? rr.slice(0, 100).filter((x) => x && typeof x.s === 'string' && typeof x.t === 'string')
  .map((x) => ({ s: x.s.slice(0, 200), t: x.t.slice(0, 200), p: cleanPath(x.p).slice(0, 60), r: x.r === 'skip' ? 'skip' : 'ok' })) : []);
const cleanNum = (n) => (Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : 0);
function cleanProgress(msg) {
  if (typeof msg.title !== 'string' || !msg.title) return null;
  const out = { t: 'progress', title: msg.title.slice(0, 200), clicks: Math.floor(cleanNum(msg.clicks)), near: !!msg.near, path: cleanPath(msg.path) };
  if (msg.d >= 1 && msg.d <= 3) out.d = Math.floor(msg.d);
  if (typeof msg.desc === 'string') out.desc = msg.desc.slice(0, 40);
  if (msg.score !== undefined) Object.assign(out, cleanRush(msg));
  return out;
}
// 搶分賽的分數：第幾題一定是「答對的題數＋跳過的題數」
function cleanRush(msg) {
  const r = rushFields(msg);
  r.qi = r.score + (RUSH_SKIPS - r.sk);
  return r;
}
function cleanFinish(msg) {
  const reasons = ['win', 'lose', 'giveup', 'timeout', 'over', 'oppGaveUp', 'oppLeft', 'hostLeft'];
  if (!reasons.includes(msg.reason)) return null;
  return { t: 'finish', reason: msg.reason, elapsed: cleanNum(msg.elapsed), clicks: Math.floor(cleanNum(msg.clicks)), path: cleanPath(msg.path), ...(msg.score !== undefined ? cleanRush(msg) : {}) };
}

// 房主：處理玩家加入或重新連線。用玩家私密 key 算出的公開 id 認人（見 publicId）
async function hostJoin(msg, cid) {
  const secret = cleanKey(msg.key);
  // 以下的 key 都是公開 id。沒帶私密 key 的舊版連線用連線代號算一個，加前綴才不會撞到別人的 id 或 'host'
  const key = secret ? await publicId(secret) : `c:${await publicId(cid)}`;
  if (!net.isHost || !net.conns.has(cid)) return;  // 算 id 的這一下連線斷了，或已經不是房主
  const bound = net.alias.get(cid);
  if (bound && bound !== key) return;  // 已經報到過的連線不能再用別的身分 join 一次
  const name = cleanName(String(msg.name || '玩家').slice(0, 16));
  const avatar = cleanAvatar(msg.avatar);
  const uid = /^[\w-]{6,128}$/.test(msg.uid || '') ? msg.uid : '';
  const device = cleanKey(msg.device);
  if (state.banned.has(key) || (device && state.banned.has(device))) { net.reject(cid, { t: 'full', kicked: true }); return; }
  if (device) state.devices.set(key, device);
  const existing = state.players.get(key);
  if (existing && !existing.host) {
    // 同一位玩家重新連線
    net.bind(cid, key);
    clearTimeout(graceTimers.get(key));
    graceTimers.delete(key);
    const wasOffline = existing.online === false;
    existing.online = true;
    existing.name = name;
    existing.avatar = avatar;
    if (uid) existing.uid = uid;
    existing.leaving = false;
    // 房主已經回到房間，但這個人還在比上一局：一樣把比賽狀態給他，重新整理才接得回去
    const snap = state.game && (state.view !== 'room' || stillRacing(key)) ? gameSnapshot() : null;
    net.send({ t: 'welcome', you: key, game: snap, gameId: state.game?.id || null, chat: state.chat.slice(-30) }, key);
    net.send({ t: 'presence', id: key, online: true }, null, key);
    if (wasOffline) {
      onPresence(key, true, 0, { quiet: existing.migrating });
      // 轉移房主後大家本來就會連回來，不用一一宣布
      if (!existing.migrating) sysChat(`${name} 重新連線了`);
    }
    existing.migrating = false;
    broadcastLobby();
    setConn('已連線', true);
    return;
  }
  const max = MAX_PLAYERS[state.mode];
  if (state.hostLocked) { net.reject(cid, { t: 'full', started: true }); return; }
  if (state.players.size >= max) { net.reject(cid, { t: 'full' }); return; }
  net.bind(cid, key);
  const used = new Set([...state.players.values()].map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[state.players.size % COLORS.length];
  state.players.set(key, { id: key, name, avatar, ready: false, host: false, color, online: true, uid });
  net.send({ t: 'welcome', you: key, game: null, chat: state.chat.slice(-30) }, key);
  broadcastLobby();
  toast(`${name} 加入了房間`);
  sysChat(`${name} 加入了房間`);
  sfx.ready();
  haptic('medium');
  setConn('已連線', true);
}

function handleGuestMessage(msg, from, cid) {
  // 還沒報上名字的連線只接受 join
  if (msg.t !== 'join' && !state.players.has(from)) return;
  switch (msg.t) {
    case 'solution': {
      // 比完的人找到解答：房主收下並轉給其他比完的人
      if (state.game?.others.get(from)?.finished) receiveSolution(msg);
      break;
    }
    case 'join':
      hostJoin(msg, cid);
      break;
    case 'bye': {
      const p = state.players.get(from);
      if (p) { p.leaving = true; removePlayer(from); }
      break;
    }
    case 'ready': {
      const p = state.players.get(from);
      if (!p) return;
      p.ready = !!msg.ready;
      if (p.ready) { sfx.ready(); haptic('medium'); }
      broadcastLobby();
      break;
    }
    case 'progress': {
      if (!state.game || state.game.others.get(from)?.finished) return;
      const clean = cleanProgress(msg);
      if (!clean) return;
      net.send({ ...clean, id: from }, null, from);
      onOtherProgress(from, clean);
      break;
    }
    case 'finish': {
      msg = cleanFinish(msg);
      if (!msg) return;
      const already = state.game?.others.get(from)?.finished;
      if (!already) net.send({ ...msg, id: from }, null, from);
      onOtherFinish(from, msg);
      break;
    }
    case 'chat': {
      const p = state.players.get(from);
      const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!p || !text || tooFast(`chat:${from}`, 500)) return;
      hostChat({ kind: 'msg', id: from, name: p.name, avatar: p.avatar, color: p.color, text, ts: Date.now() });
      break;
    }
    case 'emote':
      if (!EMOTES.includes(msg.e) || tooFast(`emote:${from}`, 1800)) return;
      net.send({ t: 'emote', id: from, e: msg.e }, null, from);
      showEmote(from, msg.e);
      break;
    case 'hintvote':
      if (state.game?.others.get(from) && !state.game.others.get(from).finished) hostHintVote(from, msg.lv === 2 ? 2 : 1);
      break;
    case 'item':
    case 'itemblock': {
      const g = state.game;
      if (!g || !ITEMS[msg.item] || !g.others.has(from)) return;
      if (msg.t === 'item') {
        const to = msg.to === 'all' ? 'all' : String(msg.to || '');
        if (to !== 'all' && to !== state.myId && !g.others.has(to)) return;
        if (tooFast(`item:${from}:${msg.item}`, 400)) return;
        net.send({ t: 'item', item: msg.item, to, from }, null, from);
        onItem(from, msg.item, to);
      } else {
        net.send({ t: 'itemblock', item: msg.item, from: msg.from, by: from }, null, from);
        onItemBlocked(from, msg.item, msg.from);
      }
      break;
    }
    case 'view':
    case 'tap': {
      const live = cleanLive(msg);
      if (!live || !state.game?.others.has(from)) return;
      sendToSpectators({ ...live, id: from }, from);
      onLive(from, live);
      break;
    }
  }
}

// ---------- 連線：玩家這一側 ----------
function handleHostMessage(msg) {
  switch (msg.t) {
    case 'solution':
      receiveSolution(msg);
      break;
    case 'welcome': {
      state.myId = msg.you;
      if (Array.isArray(msg.chat)) { state.chat = msg.chat.slice(-CHAT_MAX); renderChat(); }
      const snap = msg.game;
      const g = state.game;
      if (snap && g && g.id === snap.id) {
        // 同一局：補上斷線期間錯過的進度，並把自己的最新狀態再送一次
        for (const [id, p] of Object.entries(snap.progress || {})) {
          if (id === state.myId) continue;
          const o = g.others.get(id);
          if (!o) continue;
          const pending = p.finished && !o.finished ? p.finished : null;
          applyProgress(o, { ...p, finished: null });
          if (pending) onOtherFinish(id, pending);
        }
        if (snap.lastCall > 0 && !g.lastCallEnd) applyLastCall(snap.lastCall / 1000, null);
        if (snap.hint && !g.hint.shown) showHint({ quiet: true });
        if (Array.isArray(snap.hint2) && !g.hint2.shown) showHint2(snap.hint2, { quiet: true });
        renderOppHud();
        if (g.finished) net.send({ t: 'finish', ...g.finished });
        else if (g.current) net.send({ t: 'progress', title: g.current, clicks: g.clicks, near: g.near, path: g.path });
        refreshResult();
      } else if (snap) {
        resumeGame(snap);
      } else if (g && msg.gameId === g.id) {
        // 房主已經回到房間，但這一局還算數：把自己的結果或進度補給房主
        if (g.finished) net.send({ t: 'finish', ...g.finished });
        else if (g.current) net.send({ t: 'progress', title: g.current, clicks: g.clicks, near: g.near, path: g.path });
      }
      break;
    }
    case 'lobby': {
      if (msg.score && Number.isFinite(msg.score.games) && msg.score.wins && typeof msg.score.wins === 'object') state.roomScore = { games: msg.score.games, wins: { ...msg.score.wins } };
      const seen = state.lobbySeen === net.code;  // 這個房間之前就收過名單（剛進來的第一份不用提醒）
      const prevMode = state.mode;
      const prevGoal = cleanGoal(state.settings.goal);
      const prevHost = [...state.players.values()].find((p) => p.host);
      state.mode = msg.mode === 'party' ? 'party' : 'duel';
      state.players = new Map((msg.players || []).map((p) => [p.id, { ...p, avatar: cleanAvatar(p.avatar) }]));
      state.lobbySeen = net.code;
      if (state.myId && state.players.get(state.myId)) state.myReady = !!state.players.get(state.myId).ready;
      if (state.view !== 'game' && state.view !== 'result') {
        state.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
        writeForm(state.settings);
      }
      if (state.view === 'room') renderRoom();
      if (seen) {
        noticeHostChange(prevHost);
        noticeRuleChange(prevGoal, prevMode);
      }
      // 比賽中：名單上已經沒有的人（例如斷線的舊房主）當作離開了這一局
      const g = state.game;
      if (g && !g.finished && state.view === 'game') for (const o of g.others.values()) if (!state.players.has(o.id) && !o.left && !o.finished) onOtherLeft(o.id);
      reportActivity();  // 剛進房時還不知道房間模式：收到房主的名單才回報正確的
      break;
    }
    case 'full':
      session.clear();
      net.destroy();
      state.migrating = null;
      abandonGame();
      show('home');
      setConn('');
      showError('#home-error', msg.kicked ? '你已經被房主請出這個房間了' : msg.started ? '這個房間正在比賽中，請等這局結束再加入' : '這個房間已經滿了');
      break;
    case 'kicked':
      session.clear();
      net.destroy();
      state.migrating = null;
      abandonGame();
      netBanner('');
      show('home');
      setConn('');
      showError('#home-error', '你被房主請出房間了');
      break;
    case 'closed':
      session.clear();
      net.destroy();
      netBanner('');
      if (state.view === 'game' && state.game && !state.game.finished) {
        if (state.game.mode === 'party') finishGame('hostLeft'); else onOtherLeft(hostId());
      } else if (state.view === 'result') {
        if (state.game) for (const o of state.game.others.values()) o.left = true;
        showResult(true);
        toast('房主關閉了房間', 3000);
      } else {
        abandonGame();
        show('home');
        setConn('');
        showError('#home-error', '房主關閉了房間');
      }
      break;
    case 'migrate': {
      if (msg.to === state.myId) { takeOverHost(msg); break; }
      // 其他人：等新房主上線後會自動重連
      const to = (msg.players || []).find((p) => p.id === msg.to);
      state.migrating = to?.name || '新房主';
      net.awaitNewHost();  // 舊房主斷開後，等新房主一掛好號就連過去
      const oldHost = [...state.players.values()].find((p) => p.host);
      if (oldHost && !(msg.players || []).some((p) => p.name === oldHost.name && !p.host)) state.hostLeft = oldHost.name;
      if (Array.isArray(msg.players)) state.players = new Map(msg.players.map((p) => [p.id, { ...p, avatar: cleanAvatar(p.avatar) }]));
      if (state.view === 'room') renderRoom();
      break;
    }
    case 'settings': {
      const prevGoal = cleanGoal(state.settings.goal);
      state.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      writeForm(state.settings);
      if (state.view === 'room') renderRoom();
      noticeRuleChange(prevGoal, state.mode);
      break;
    }
    case 'start':
      state.mode = msg.mode === 'party' ? 'party' : 'duel';
      if (msg.players) state.players = new Map(msg.players.map((p) => [p.id, { ...p, avatar: cleanAvatar(p.avatar) }]));
      startGame({ ...DEFAULT_SETTINGS, ...msg.settings }, msg.id);
      break;
    case 'progress':
      if (msg.id) onOtherProgress(msg.id, msg);
      break;
    case 'finish':
      if (msg.id) onOtherFinish(msg.id, msg);
      break;
    case 'rushq':
      receiveRushQ(msg);
      break;
    case 'lastcall':
      applyLastCall(Number(msg.seconds) || 60, msg.by);
      break;
    case 'left':
      onOtherLeft(msg.id);
      break;
    case 'presence':
      onPresence(msg.id, !!msg.online, Math.min(120000, Number(msg.wait) || 0));
      break;
    case 'chat':
      if (msg.m && typeof msg.m.text === 'string') pushChat({ ...msg.m, avatar: cleanAvatar(msg.m.avatar), text: msg.m.text.slice(0, 100) });
      break;
    case 'emote':
      if (EMOTES.includes(msg.e) && msg.id) showEmote(msg.id, msg.e);
      break;
    case 'view':
    case 'tap': {
      const live = cleanLive(msg);
      if (live && msg.id) onLive(msg.id, live);
      break;
    }
    case 'item':
      if (msg.from) onItem(msg.from, msg.item, msg.to);
      break;
    case 'hinttally':
      applyHintTally(msg);
      break;
    case 'hint':
      if (msg.lv === 2) showHint2(Array.isArray(msg.near) ? msg.near.filter((t) => typeof t === 'string').slice(0, 5).map((t) => t.slice(0, 200)) : []);
      else showHint();
      break;
    case 'itemblock':
      if (msg.by) onItemBlocked(msg.by, msg.item, msg.from);
      break;
  }
}

net.onDisplaced = displacedAsHost;

net.onHostLost = () => {
  netBanner(state.migrating ? `房主交給 ${state.migrating}，重新連線中…` : '與房主的連線中斷，正在重新連線…');
  setConn('重新連線中…');
  clearTimeout(hostGiveUpTimer);
  hostGiveUpTimer = setTimeout(giveUpHost, HOST_GIVEUP);
  scheduleTakeover();
};

net.onHostBack = () => {
  state.takeoverStart = 0;
  clearTimeout(hostGiveUpTimer);
  clearTimeout(takeoverTimer);
  state.migrating = null;
  netBanner('');
  setConn('已連線', true);
  toast('已重新連線！', 2000);
  sendJoin();
};

// 一直連不回房主：當作房主離開
function giveUpHost() {
  if (net.isHost) return;  // 自己已經接手當房主了
  clearTimeout(takeoverTimer);
  net.stopRetry();
  session.clear();
  state.migrating = null;
  netBanner('');
  setConn('房主已離線');
  toast('連不回房主，房間已解散', 4000);
  const g = state.game;
  if (state.view === 'game' && g && !g.finished) {
    if (g.mode === 'party') finishGame('hostLeft');
    else onOtherLeft(hostId());
    return;
  }
  if (g) for (const o of g.others.values()) o.left = true;
  if (g?.finished) settleGame(g);
  if (state.view === 'result') showResult(true);
  else if (state.view === 'room') {
    show('home');
    showError('#home-error', '房主已離開房間');
  }
}

net.onMessage = (msg, from, cid) => {
  if (net.isHost) handleGuestMessage(msg, from, cid);
  else handleHostMessage(msg);
};

// 回到畫面時馬上檢查連線
document.addEventListener('visibilitychange', () => { if (!document.hidden) net.nudge(); });
window.addEventListener('online', () => net.nudge());
window.addEventListener('pageshow', (e) => { if (e.persisted) net.nudge(); });

window.addEventListener('beforeunload', (e) => {
  if (state.view === 'game' && state.game && !state.game.finished) e.preventDefault();
});

// 真的要離開頁面時才斷線（放到背景快取的頁面之後可能會回來）
window.addEventListener('pagehide', (e) => { if (!e.persisted) net.destroy(); });

// 測試用：讓自動化測試可以模擬斷線
window.__wikirace = { net, state, idle: { ago(ms) { lastAct = Date.now() - ms; checkIdle(); }, grace(ms) { idleGrace = ms; } } };  // idle：測試用（不用真的等 10 分鐘）

// ---------- 自動更新：網站更新後，開著的分頁（或加到主畫面的捷徑）不會自己換新版 ----------
// 每隔一下、或切回這個分頁時，偷看伺服器上的 index.html 用的是第幾版；比自己新就更新：
// 在首頁直接重新載入；在房間或比賽中不打斷，顯示一條「有新版本」讓玩家自己點
const MY_VERSION = Number(new URL(import.meta.url).searchParams.get('v')) || 0;
let updateShown = false;
function reloadFresh() {
  // 加一個每次都不一樣的參數，瀏覽器才不會又拿暫存的舊頁面
  const u = new URL(location.href);
  u.searchParams.set('_u', Date.now().toString(36));
  location.replace(u.toString());
}
async function checkUpdate() {
  if (!MY_VERSION || updateShown) return;
  try {
    const html = await (await fetch(`index.html?check=${Date.now()}`, { cache: 'no-store' })).text();
    const latest = Number((html.match(/app\.js\?v=(\d+)/) || [])[1]) || 0;
    if (latest <= MY_VERSION) return;
    const busy = state.view !== 'home' || session.load() || state.solo || !$('#ban-screen').hidden;
    if (!busy) { reloadFresh(); return; }
    updateShown = true;
    $('#update-bar').hidden = false;
  } catch { /* 沒網路就算了 */ }
}
$('#update-bar').onclick = reloadFresh;
setInterval(checkUpdate, 120000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) checkUpdate(); });
setTimeout(checkUpdate, 3000);
// 用來強制更新的參數用完就拿掉，網址比較乾淨
if (new URLSearchParams(location.search).has('_u')) { try { const u = new URL(location.href); u.searchParams.delete('_u'); history.replaceState(null, '', u.toString()); } catch { /* 忽略 */ } }

catchErrors();
watchBadWords();
// 管理員從題庫拿掉的條目：隨機抽題時跳過
getDb().then((db) => db?.ref('config/topicBan').on('value', (snap) => wiki.setTopicBan(snap.val()), () => {})).catch(() => {});
getUid().then((u) => { myUid ||= u || ''; }, () => {});
onAuth((u) => { if (u) myUid = u; });
initSound();
initHome();
// 線上人數（有設定 firebase-config.js 才會顯示）
// 管理員從後台打開觀戰（?adminwatch=<玩家 key>）：這個分頁只用來觀戰，不算一個在線玩家
const adminWatchKey = new URLSearchParams(location.search).get('adminwatch');
// 從後台打開的重播連結（#replay=…）也不算一個在線玩家
// 上次因為閒置太久被請出去：先顯示「你離開一陣子了」，按「我回來了」才重新算在線上
let awayKind = null;
try { awayKind = sessionStorage.getItem('wikirace-away'); } catch { /* 忽略 */ }
if (awayKind) showAway(awayKind);
else if (!adminWatchKey) initIdle();
if (!adminWatchKey && !awayKind && !location.hash.startsWith('#replay=')) {
  initPresence((n) => {
    $('#online-count').textContent = n.toLocaleString('en-US');
    $('#online-chip').hidden = !(n > 0);
  });
  // 同時連線的人太多（Firebase 免費方案有上限）：告訴大家哪些照樣能玩
  onBusy((b) => { $('#busy-note').hidden = !b; if (b) $('#online-chip').hidden = true; });
}
initAccountUi();
initRoom();
initGame();
initResult();
initChat();
initEmotes();
initTutorial();
initItems();
initMusicSettings();
initSolo();
initDaily();
$('#btn-hint-vote').onclick = voteHint;
initAnnounce();
initNotify();
show('home');
if (adminWatchKey && /^[-\w]{4,40}$/.test(adminWatchKey)) startAdminWatch(adminWatchKey);
const fromReplay = !adminWatchKey && openReplayFromHash();
window.addEventListener('hashchange', () => { if (state.view === 'home') openReplayFromHash(); });
// 之前被踢出、期限還沒到：一打開就擋住
try { const b = JSON.parse(store.get('wikirace-ban') || 'null'); if (b && b.until > Date.now() && !adminWatchKey) applyBan(b); } catch { /* 忽略 */ }
// 第一次來的人先看教學（重新整理回房間時不打擾）
// 第一次來的人先看教學；從邀請連結來的人只顯示提示，不擋住加入（重新整理回房間時都不打擾）
// 朋友分享的每日挑戰連結（?daily）：直接打開今天的題目，新玩家也不被教學擋住
const fromDaily = new URLSearchParams(location.search).has('daily');
if (!store.get('wikirace-tutorial-done') && !session.load() && !adminWatchKey && !fromReplay) {
  if (new URLSearchParams(location.search).get('room') || fromDaily) $('#tut-hint').hidden = false;
  else openTutorial();
}
// 每日挑戰中途跳掉、3 分鐘內回來：直接打開每日挑戰，按一下就能接著玩
if (!fromDaily && !adminWatchKey && !fromReplay && !session.load() && dailyRun(todayKey())) openDaily();
if (fromDaily && !session.load()) {
  openDaily();
  try { history.replaceState(null, '', location.pathname); } catch { /* 忽略 */ }
}
renderNewbieHome();
$('#tut-hint').onclick = () => { $('#tut-hint').hidden = true; openTutorial(); };
