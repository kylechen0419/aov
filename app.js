import { Net } from './net.js?v=48';
import * as wiki from './wiki.js?v=48';
import { tw, twTree, zhReady } from './zh.js?v=48';
import { makeShareImage } from './share.js?v=48';
import { solve } from './solver.js?v=48';
import { sfx, music, unlockAudio, canClickNow, isSfxOn, setSfxOn, isMusicOn, setMusicOn, haptic, flash, shake, confetti, MUSIC_CHOICES, getMusicChoice, setMusicChoice, saveCustomMusic, getCustomMusic, CLICK_SOUNDS, getClickSound, setClickSound } from './fx.js?v=48';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const net = new Net();

const DEFAULT_SETTINGS = {
  lang: 'zh', goal: 'speed', timeLimit: 0, lastCall: 0, start: '', target: '',
  showOpponentPage: true, allowBack: true, trueRandom: false,
};
const MAX_PLAYERS = { duel: 2, party: 8 };
// 斷線後保留位置的時間：比賽中久一點，房間裡短一點
const GRACE_GAME = 60000;
const GRACE_ROOM = 15000;
// 轉移房主時，給大家重新連上新房主的時間
const GRACE_MIGRATE = 30000;
// 玩家連不回房主多久之後放棄
const HOST_GIVEUP = 90000;
const COLORS = ['#2f7bff', '#ff4d6d', '#22c55e', '#ff8a3d', '#8b5cf6', '#ff5ca8', '#14b8a6', '#eab308'];
// 玩家可以選的頭像（avatars/ 資料夾裡的 SVG）
const AVATARS = [
  ['owl', '貓頭鷹博士'], ['cat', '橘貓'], ['panda', '熊貓'], ['fox', '狐狸'], ['penguin', '企鵝'], ['frog', '青蛙王子'],
  ['rabbit', '兔兔'], ['dino', '小恐龍'], ['robot', '機器人'], ['shiba', '柴犬'], ['lion', '獅子'], ['chick', '小雞'],
];
const AVATAR_IDS = new Set(AVATARS.map(([id]) => id));
const EMOJIS = ['👍', '😂', '😱', '🔥', '😭', '🤯', '😎', '👋', '🥀'];
const PHRASES = ['我快到了！', '迷路了…', '等等我啦！', '懂你意思', '有感覺嗎', '何意味', '完全憤怒誘餌', 'GG FXXING EZ'];
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
};

// 房主用：斷線玩家的保留計時、聊天與表情的頻率限制
const graceTimers = new Map();
const lastSpeak = new Map();
let hostGiveUpTimer = null;

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

function show(view) {
  state.view = view;
  for (const v of ['home', 'room', 'game', 'result', 'watch']) $(`#view-${v}`).hidden = v !== view;
  $('.masthead').hidden = view === 'game' || view === 'watch';
  $('#emote-fab').hidden = !(view === 'room' || view === 'result' || view === 'watch');
  if (view !== 'watch') { stopWatchTimer(); $('#btn-follow').hidden = true; }
  if (view !== 'room' && view !== 'game') closePick(null);
  $('#item-dock').hidden = !(view === 'game' && isItems() && !state.game?.finished);
  closeEmotes();
  if (view === 'home' || view === 'room') music.play('lobby');
  if (view === 'home') { renderStats(); renderHistory(); }
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
const isSteps = (g = state.game) => g?.settings.goal === 'steps';
const isItems = (g = state.game) => g?.settings.goal === 'items';
// 三種玩法：比速度、比步數、道具賽（道具賽也是先抵達的贏）
const GOALS = {
  speed: { icon: '⚡', name: '比速度', brief: '先抵達的贏' },
  steps: { icon: '👣', name: '比步數', brief: '步數最少的贏' },
  items: { icon: '🎁', name: '道具賽', brief: '每 40 秒發一個道具，落後的人拿到比較強的' },
};
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
        const isDefault = id === (slot === 'lobby' ? 'piano' : 'tense');
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
    input.onchange = () => {
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

// ---------- 戰績（存在這支手機上，比速度和比步數各自分開記） ----------
const statsKey = (goal) => (goal === 'steps' || goal === 'items' ? `wikirace-stats-${goal}` : 'wikirace-stats');

function loadStats(goal) {
  try { return { w: 0, l: 0, d: 0, streak: 0, ...JSON.parse(store.get(statsKey(goal)) || '{}') }; } catch { return { w: 0, l: 0, d: 0, streak: 0 }; }
}

function recordResult(goal, res) {
  const st = loadStats(goal);
  if (res === 'win') { st.w++; st.streak++; } else if (res === 'lose') { st.l++; st.streak = 0; } else { st.d++; }
  store.set(statsKey(goal), JSON.stringify(st));
}

function unrecordResult(goal, res) {
  const st = loadStats(goal);
  if (res === 'win') { st.w = Math.max(0, st.w - 1); st.streak = Math.max(0, st.streak - 1); } else if (res === 'lose') st.l = Math.max(0, st.l - 1); else st.d = Math.max(0, st.d - 1);
  store.set(statsKey(goal), JSON.stringify(st));
}

// 首頁顯示目前選到的模式的戰績
function renderStats() {
  const goal = selectedGoal();
  const st = loadStats(goal);
  const total = st.w + st.l + st.d;
  $('#stats-label').textContent = `${GOALS[goal].icon} ${GOALS[goal].name}戰績`;
  $('#stats-label').classList.toggle('steps', goal === 'steps');
  $('#stats-label').classList.toggle('items', goal === 'items');
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
  return cleanGoal(document.querySelector('input[name="goalHome"]:checked')?.value);
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'duel';
}

function getName() {
  const n = $('#nickname').value.trim();
  if (!n) { showError('#home-error', '請先輸入暱稱'); $('#nickname').focus(); return null; }
  store.set('wikirace-name', n);
  return n;
}

async function joinAsGuest(code, { auto = false } = {}) {
  showError('#home-error');
  setConn(auto ? '重新連線中…' : '連線中…');
  $('#btn-join').disabled = true;
  try {
    await net.joinRoom(code);
    state.myKey ||= randomKey();
    session.save({ code: net.code, key: state.myKey, role: 'guest' });
    state.players = new Map();
    sendJoin();
    setConn('已連線', true);
    if (state.view === 'home') enterRoom(net.code);
  } catch (e) {
    if (auto) session.clear();
    showError('#home-error', auto ? `沒辦法回到剛才的房間（${e.message}）` : e.message);
    setConn('');
  } finally {
    $('#btn-join').disabled = false;
  }
}

function sendJoin() {
  net.send({ t: 'join', name: state.myName, avatar: state.myAvatar, key: state.myKey, device: deviceId, gameId: state.game?.id || null });
}

function initHome() {
  $('#dyk-text').textContent = DYK[Math.floor(Math.random() * DYK.length)];
  // 閒置時預先載入題庫並顯示數量
  setTimeout(() => {
    import('./topics.js').then((m) => { $('#topic-count').textContent = m.TOPICS.length.toLocaleString('en-US'); }).catch(() => {});
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
  if (savedGoal && GOALS[savedGoal]) document.querySelector(`input[name="goalHome"][value="${savedGoal}"]`).checked = true;
  renderStats();
  const paintMode = () => {
    const goal = GOALS[selectedGoal()].name;
    $('#btn-create').textContent = `建立${goal}${selectedMode() === 'party' ? '派對' : '對決'}房間`;
  };
  paintMode();
  document.querySelectorAll('input[name="mode"], input[name="goalHome"]').forEach((r) => r.addEventListener('change', () => {
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
    const name = getName();
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
      session.clear();
      setConn(isParty() ? '等待玩家' : '等待對手');
      enterRoom(code);
      sysChat(`${name} 建立了房間`);
    } catch (e) {
      showError('#home-error', e.message);
      setConn('');
    } finally {
      $('#btn-create').disabled = false;
    }
  };

  const join = () => {
    const name = getName();
    if (!name) return;
    const code = $('#join-code').value.trim().toUpperCase();
    if (!code) { showError('#home-error', '請輸入房間代碼'); return; }
    state.myName = name;
    state.myKey = randomKey();
    joinAsGuest(code);
  };
  $('#btn-join').onclick = join;
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  // 重新整理後自動回到剛才的房間
  const sess = session.load();
  if (sess?.role === 'guest' && sess.code && cleanKey(sess.key) && $('#nickname').value.trim()) {
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
    goal: cleanGoal(state.settings.goal),
    timeLimit: Number(f.timeLimit.value),
    // 派對模式：第一個人抵達後，其他人剩這麼多秒（0＝不限）
    lastCall: Number(f.lastCall.value) || 0,
    start: f.start.value.trim(),
    target: f.target.value.trim(),
    showOpponentPage: f.showOpponentPage.checked,
    allowBack: f.allowBack.checked,
    trueRandom: f.trueRandom.checked,
  };
}

function writeForm(s) {
  const f = form().elements;
  f.lang.value = s.lang;
  f.timeLimit.value = String(s.timeLimit);
  f.lastCall.value = String(s.lastCall || 0);
  if (document.activeElement !== f.start) f.start.value = tw(s.start);
  if (document.activeElement !== f.target) f.target.value = tw(s.target);
  f.showOpponentPage.checked = s.showOpponentPage;
  f.allowBack.checked = s.allowBack;
  f.trueRandom.checked = s.trueRandom;
  paintRoomGoal();
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

function paintRoomGoal() {
  const goal = cleanGoal(state.settings.goal);
  $('#room-goal').textContent = `${GOALS[goal].icon} ${GOALS[goal].name} · ${isParty() ? '派對' : '1 對 1'}`;
  $('#room-goal').classList.toggle('steps', goal === 'steps');
  $('#room-goal').classList.toggle('items', goal === 'items');
  $('#room-items-help').hidden = goal !== 'items';
  // 第一次玩道具賽：進房間時先看一次教學
  if (goal === 'items' && state.view === 'room' && !store.get('wikirace-items-guide') && $('#items-modal').hidden && !state.itemsGuideShown) {
    state.itemsGuideShown = true;
    setTimeout(openItemsGuide, 400);
  }
}

function renderRoom() {
  const host = net.isHost;
  const party = isParty();
  paintRoomGoal();
  renderRoomScore();
  $('#row-lastcall').hidden = !party;
  $('#btn-transfer').hidden = !(host && onlineGuests().length);
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

function enterRoom(code) {
  $('#room-code').textContent = code;
  if (net.isHost) state.hostLocked = false;
  writeForm(state.settings);
  showError('#room-error');
  show('room');
  renderRoom();
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
}

let settingsTimer;
function broadcastSettings() {
  const next = readForm();
  if (JSON.stringify(next) === JSON.stringify(state.settings)) return;
  state.settings = next;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => net.send({ t: 'settings', settings: state.settings }), 150);
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
  form().addEventListener('change', () => { if (net.isHost) broadcastSettings(); });
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

function migrateHost(toId, { leaving = false } = {}) {
  const to = state.players.get(toId);
  if (!to || !net.isHost || state.view !== 'room') return;
  const code = net.code;
  const myNewKey = randomKey();
  const players = [...state.players.values()]
    .filter((p) => !(leaving && p.id === state.myId))
    .map((p) => {
      if (p.id === state.myId) return { ...p, id: myNewKey, host: false, ready: false };
      if (p.id === toId) return { ...p, host: true, ready: true };
      return { ...p };
    });
  sysChat(leaving ? `${state.myName} 離開了，房主交給 ${to.name}` : `${state.myName} 把房主交給 ${to.name}`);
  const wins = { ...state.roomScore.wins };
  if (wins[state.myId] !== undefined) { wins[myNewKey] = wins[state.myId]; delete wins[state.myId]; }
  state.roomScore = { games: state.roomScore.games, wins };
  net.send({ t: 'migrate', to: toId, code, mode: state.mode, settings: state.settings, players, chat: state.chat.slice(-30), banned: [...state.banned], score: state.roomScore });
  state.hostLocked = true;
  session.clear();
  for (const t of graceTimers.values()) clearTimeout(t);
  graceTimers.clear();
  setTimeout(() => {
    net.destroy();
    if (leaving) { location.href = location.pathname; return; }
    // 自己改用一般玩家的身分回到同一個房間
    state.myKey = myNewKey;
    state.myId = myNewKey;
    state.myReady = false;
    state.players = new Map(players.map((p) => [p.id, p]));
    netBanner(`房主交給 ${to.name}，重新連線中…`);
    renderRoom();
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
  session.clear();
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
    const pick = async (val) => (val ? val : wiki.randomTitle(s.lang, s.trueRandom));
    s.start = await wiki.resolveTitle(s.lang, await pick(s.start));
    s.target = await wiki.resolveTitle(s.lang, await pick(s.target));
    let guard = 0;
    while (s.start === s.target && !readForm().target && guard++ < 5) {
      s.target = await wiki.resolveTitle(s.lang, await wiki.randomTitle(s.lang, s.trueRandom));
    }
    if (s.start === s.target) throw new Error('起點和終點不能是同一個條目');
    if (!net.connected) throw new Error(isParty() ? '其他玩家都離線了' : '對手已離線');
    state.settings = s;
    writeForm(s);
    // 開局時大家的準備狀態歸零，下一局重新準備
    for (const p of state.players.values()) if (!p.host) p.ready = false;
    const id = randomKey();
    net.send({ t: 'settings', settings: s });
    net.send({ t: 'start', id, settings: s, mode: state.mode, players: [...state.players.values()] });
    startGame(s, id);
  } catch (e) {
    showError('#room-error', e.message);
  } finally {
    btn.textContent = '開始對局';
    renderRoom();
  }
}

// ---------- 比賽 ----------
function createGame(settings, id) {
  state.myReady = false;
  state.settings = settings;
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
    current: null,
    loading: false,
    near: false,
    finished: null,
    lastSecond: null,
    lastCallEnd: 0,
    lastCallSent: false,
    hint: { offered: false, shown: false, myVote: false, yes: [], need: 0, votes: new Set() },
    timer: null,
    heart: null,
  };
  const party = isParty();
  const me = state.players.get(state.myId);
  $('#hud-target').textContent = tw(settings.target);
  $('#hud-clicks').textContent = '0';
  $('#hud-timer').textContent = settings.timeLimit ? fmtTime(settings.timeLimit * 1000) : '00:00';
  $('#hud-timer').className = 'hud-timer';
  paintAvatar($('#hud-me-avatar'), { name: state.myName, avatar: state.myAvatar });
  $('#hud-me-avatar').style.setProperty('--side', party && me ? me.color : '');
  $('#hud-strip').hidden = !party;
  $('#hud-timer').classList.remove('sprint');
  $('#items-modal').hidden = true;
  $('#hud').classList.remove('compact');
  $('#hint-bar').hidden = true;
  $('#hint-card').hidden = true;
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
  $('#article').replaceChildren();
  $('#article-title').textContent = '';
  $('#breadcrumb').textContent = '';
  music.stop();
  music.setIntensity(0);
  $('#brief-start').textContent = tw(settings.start);
  $('#brief-target').textContent = tw(settings.target);
  const goal = cleanGoal(settings.goal);
  $('#brief-goal').textContent = `${GOALS[goal].icon} ${GOALS[goal].name}：${GOALS[goal].brief}`;
  $('#brief-goal').classList.toggle('steps', goal === 'steps');
  $('#brief-goal').classList.toggle('items', goal === 'items');
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
    goTo(settings.start, { first: true, preload });
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
    },
  };
  for (const o of g.others.values()) {
    progress[o.id] = { clicks: o.clicks, current: o.current, path: o.path, near: o.near, finished: o.finished, left: o.left };
  }
  return {
    id: g.id, settings: g.settings, mode: g.mode, players: [...state.players.values()],
    elapsed: g.startAt ? performance.now() - g.startAt : 0,
    lastCall: g.lastCallEnd ? Math.max(0, g.lastCallEnd - performance.now()) : 0,
    hint: g.hint.shown,
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
  g.startAt = performance.now() - (snap.elapsed || 0);
  g.clicks = mine.clicks || 0;
  g.path = Array.isArray(mine.path) ? mine.path.slice() : [];
  g.stack = g.path.slice(0, -1);
  if (snap.lastCall > 0) g.lastCallEnd = performance.now() + snap.lastCall;
  if (snap.hint) setTimeout(showHint, 800);
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
    $('#hud-opp-clicks').textContent = o ? o.clicks : 0;
    $('#hud-opp-clicks').parentElement.lastChild.textContent = ' 步';
    let where = '';
    if (o?.finished?.reason === 'win') where = `${o.name} 已用 ${o.finished.clicks} 步抵達`;
    else if (o?.left) where = `${o.name} 已離線`;
    else if (o?.offline) where = `${o.name} 斷線中，等待重新連線…${waitLeft(o)}`;
    else if (o && g.settings.showOpponentPage) where = `${o.name} 在《${tw(o.current)}》`;
    $('#hud-opp-page').textContent = where;
    $('#hud-opp').classList.toggle('offline', !!o?.offline);
    return;
  }
  const arrived = list.filter((o) => o.finished?.reason === 'win').length + (g.finished?.reason === 'win' ? 1 : 0);
  $('#hud-opp-name').textContent = `${list.length} 位對手`;
  $('#hud-opp-avatar').replaceChildren(String(list.length));
  $('#hud-opp-avatar').classList.remove('has-img');
  $('#hud-opp-avatar').style.setProperty('--side', '#ffb020');
  $('#hud-opp-clicks').textContent = `${arrived}/${list.length + 1}`;
  $('#hud-opp-clicks').parentElement.lastChild.textContent = ' 抵達';
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
    const label = o.finished?.reason === 'win' ? '抵達！' : o.left ? '離線' : o.finished ? '出局' : o.offline ? `斷線${waitLeft(o, true)}` : `${o.clicks} 步`;
    info.append(Object.assign(document.createElement('b'), { textContent: o.name }), Object.assign(document.createElement('span'), { textContent: label }));
    if (g.settings.showOpponentPage && !o.finished && !o.left && !o.offline) {
      info.append(Object.assign(document.createElement('small'), { textContent: tw(o.current) }));
    }
    li.append(info);
    return li;
  });
  $('#hud-strip').replaceChildren(...chips);
}

function elapsed() {
  const g = state.game;
  return g && g.startAt ? performance.now() - g.startAt : 0;
}

function tick() {
  const g = state.game;
  if (!g || g.finished) return;
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
  if (g.fx) applyFx();
  if (isItems(g)) itemClock(g);
  if (ms >= HINT_AFTER && !g.hint.offered && !g.hint.shown) offerHint();
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

async function goTo(title, { first = false, back = false, restore = false, preload = null } = {}) {
  const g = state.game;
  if (!g || g.finished || g.loading) return;
  g.loading = true;
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
      if (!first) g.clicks++;
      if (g.current && !back) g.stack.push(g.current);
      g.path.push(art.title);
    }
    g.current = art.title;
    renderArticle(art);
    renderBreadcrumb(g);
    $('#hud-clicks').textContent = g.clicks;
    fillPath($('#hud-path'), g.path, g.settings.target);
    $('#path-count').textContent = g.path.length;
    $('#btn-back').disabled = g.stack.length === 0;

    const reached = art.title === g.settings.target;
    const near = !reached && !!$('#article a.is-target');
    if (near && !g.near) { sfx.near(); haptic('success'); }
    g.near = near;
    $('#hud-alert-me').hidden = !near;
    $('#hud-alert-me').textContent = '終點連結就在這一頁！快找！';

    if (isItems(g)) g.dist = distanceHere(g);
    sendProgress({ t: 'progress', title: art.title, clicks: g.clicks, near, path: g.path, d: g.dist ?? undefined });
    if (reached) finishGame('win');
    else {
      renderGoal();
      if (!checkOutstepped() && first) setTimeout(runCoach, 400);
    }
  } catch (e) {
    toast(`載入失敗：${e.message}`);
  } finally {
    g.loading = false;
    $('#article-loading').hidden = true;
  }
}

// 房主自己的進度要標上 id 廣播；玩家則交給房主轉發
function sendProgress(msg) {
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

// 把條目內容放進畫面：比賽和觀戰共用
function fillArticle(root, titleEl, art, settings) {
  const tmp = document.createElement('div');
  tmp.innerHTML = art.displayTitle || art.title;
  titleEl.textContent = tw(tmp.textContent);

  root.innerHTML = art.html;
  // 拿掉點不了的引用標記與參考文獻，條目比較清爽
  root.querySelectorAll('.mw-editsection, .mw-empty-elt, script, sup.reference, .reflist, ol.references, .mw-references-wrap').forEach((el) => el.remove());
  root.querySelectorAll('img').forEach((img) => { img.loading = 'lazy'; img.decoding = 'async'; });
  if (settings.lang === 'zh') twTree(root);
  const target = settings.target;
  root.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    const t = wiki.linkToTitle(href, art.prefixes);
    if (t) {
      a.dataset.title = t;
      a.classList.add('wl');
      if (t === target) a.classList.add('is-target');
    } else {
      a.classList.add('dead');
    }
    a.removeAttribute('target');
  });
}

// ---------- 觀戰的即時畫面：比賽中的人把捲動位置和點擊送給已經比完的人 ----------
// 有人比完（可能在觀戰）才送，避免比賽時浪費流量
const hasSpectators = (g) => !!g && [...g.others.values()].some((o) => o.finished && !o.left);

function sendLive(msg) {
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
        goTo(slip.dataset.title);
        return;
      }
    }
    goTo(a.dataset.title);
  });
  // 擋掉中鍵另開分頁
  root.addEventListener('auxclick', (e) => { if (e.target.closest('a')) e.preventDefault(); });

  $('#btn-back').onclick = () => {
    const g = state.game;
    if (!g || !g.stack.length || g.loading) return;
    if (fxOn(g, 'freeze')) { toast('🧊 被冰凍了，等一下！', 1200); return; }
    const prev = g.stack.pop();
    goTo(prev, { back: true }).then(() => {
      if (g.current !== prev) g.stack.push(prev);
    });
  };

  $('#btn-giveup').onclick = () => {
    const msg = isParty() ? '確定要投降嗎？這一局你就不會有名次了。' : '確定要投降嗎？對手會直接獲勝。';
    if (confirm(msg)) finishGame('giveup');
  };

  $('#btn-path').onclick = () => { $('#path-drawer').hidden = !$('#path-drawer').hidden; };
  $('#btn-path-close').onclick = () => { $('#path-drawer').hidden = true; };
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
  const near = [...g.others.values()].filter((o) => o.near && !o.finished && !o.left);
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
  o.clicks = msg.clicks;
  o.current = msg.title;
  if (Array.isArray(msg.path)) o.path = msg.path.slice(0, 200);
  else if (moved) o.path.push(msg.title);
  o.near = !!msg.near;
  if (msg.d >= 1 && msg.d <= 3) o.dist = msg.d;
  o.offline = false;
  renderOppHud();
  if (g.finished) {
    if (state.view === 'result') showResult(true);
    else if (state.view === 'watch') renderWatch(id === state.watch.id && moved);
    return;
  }
  refreshDanger();
  if (moved && g.startAt) {
    const racer = $('#hud-opp');
    racer.classList.remove('bump');
    void racer.offsetWidth;
    racer.classList.add('bump');
    sfx.oppMove();
    const color = g.mode === 'party' ? o.color : null;
    feed(g.settings.showOpponentPage ? [{ b: o.name }, ` 前往《${tw(msg.title)}》`] : [{ b: o.name }, ' 又前進了一步'], `第${msg.clicks}步`, color);
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
  if (!g || !isSteps(g)) { el.hidden = true; return; }
  el.hidden = false;
  const best = bestSteps(g);
  el.classList.remove('hot');
  if (best === null) { el.textContent = '👣 比步數'; return; }
  if (g.mode === 'party' || g.finished) { el.textContent = `最佳 ${best} 步`; return; }
  const left = best - 1 - g.clicks;
  el.textContent = `${best - 1} 步內抵達才能贏 · 剩 ${Math.max(0, left)} 步`;
  el.classList.add('hot');
}

// 對決比步數：對手已經抵達，而你再怎麼走都不會比他少，就直接結束
function checkOutstepped() {
  const g = state.game;
  if (!g || g.finished || !isSteps(g) || g.mode === 'party') return false;
  const best = bestSteps(g);
  // 下一步就抵達也要 clicks + 1 步，一樣多步時先抵達的對手贏
  if (best === null || g.clicks + 1 < best) return false;
  toast(`步數已經追不上了（對手 ${best} 步）`, 3000);
  finishGame('over');
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
  music.stop();
  g.finished = { reason, elapsed: elapsed(), clicks: g.clicks, path: g.path.slice() };
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
    setTimeout(showResult, 350);
  } else if (reason === 'lose') {
    flash('#ff4d6d');
    setTimeout(showResult, 350);
  } else {
    showResult();
  }
}

// 房主：派對模式有設定最後衝刺時，第一個人抵達就開始倒數
function onAnyFinish(id, info) {
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
    } else if (state.view === 'result') {
      showResult(true);
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
  } else if (state.view === 'result') {
    showResult(true);
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
    else if (state.view === 'result') showResult(true);
    return;
  }
  if (!g.finished) refreshDanger();
  else if (state.view === 'result') showResult(true);
}

function onPresence(id, online, wait = 0) {
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
      toast(online ? `${o.name} 重新連線了` : `${o.name} 斷線了，等待重新連線…`, 2500);
    }
  }
  if (state.view === 'room') renderRoom();
  if (state.view === 'result' && state.game) showResult(true);
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
    // 你先抵達，對手還在走：等他走完才知道勝負
    if (me.reason === 'win') return !opp && o && !o.left ? 'pending' : 'win';
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
    { id: state.myId, name: state.myName, avatar: state.myAvatar, color: meP?.color || COLORS[0], me: true, finished: g.finished, clicks: g.finished?.clicks ?? g.clicks, path: g.finished?.path || g.path, left: false },
    ...[...g.others.values()].map((o) => ({ id: o.id, name: o.name, avatar: o.avatar, color: o.color, me: false, finished: o.finished, clicks: o.clicks, path: o.path, left: o.left, offline: o.offline, offlineUntil: o.offlineUntil })),
  ];
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
  const items = entries.map((e) => {
    const li = document.createElement('li');
    li.className = 'rank-item';
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
    body.append(sum, ol);
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

// 結果畫面的資料，也用來產生分享圖
function resultInfo(g) {
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
function showResult(update = false) {
  const g = state.game;
  const party = g.mode === 'party';
  const info = resultInfo(g);
  const { res } = info;
  if (party) renderRanking(g, info.entries);
  else renderDuelResult(g, res);
  renderSolution(g);
  const racing = racers(g);
  $('#btn-watch').hidden = !racing.length;
  $('#watch-cta-text').textContent = `觀戰：還有 ${racing.length} 人在比`;
  $('#result-hero').className = `cover result-hero ${info.tone}`;
  $('#ranking').hidden = !party;
  $('#score-card').hidden = party;
  $('#route-grid').hidden = party;
  $('#result-kicker').textContent = info.kicker;
  $('#result-title').textContent = info.title;
  let sub = `《${tw(g.settings.start)}》→《${tw(g.settings.target)}》`;
  if (g.finished.reason === 'oppGaveUp') sub += '（對手投降）';
  if (g.finished.reason === 'oppLeft') sub += '（對手離線）';
  if (g.finished.reason === 'timeout') sub += '（時間到）';
  if (party && !allDone(g)) sub += '　等待其他玩家…';
  if (isSteps(g)) sub = `👣 比步數　${sub}`;
  $('#btn-share').disabled = res === 'pending';
  $('#result-sub').textContent = sub;
  $('#btn-rematch').disabled = !net.connected;
  $('#btn-rematch').textContent = net.connected ? '再來一局' : (party ? '其他人都離線了' : '對手已離線');

  // 結果可能因為幾乎同時抵達而更正，戰績也跟著更正
  if (res === 'pending') { /* 勝負未定，先不記戰績 */ }
  else if (!g.recorded && g.restored) g.recorded = res;
  else if (!g.recorded) { recordResult(g.settings.goal, res); g.recorded = res; }
  else if (g.recorded !== res) { unrecordResult(g.settings.goal, g.recorded); recordResult(g.settings.goal, res); g.recorded = res; }
  // 最近對戰：派對要等名次確定才記
  if (res !== 'pending' && (!party || allDone(g))) saveHistory(g, info);
  // 房主：這一局大家都比完了，記到本房戰績
  if (net.isHost && allDone(g) && !g.scored) scoreGame(g, info);
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

function renderDuelResult(g, res) {
  const me = g.finished;
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
}

// ---------- 正確解答：最短路線 ----------
// 結果畫面顯示解答區；沒有人抵達終點時自動開始找，有人抵達就按按鈕再找
function renderSolution(g) {
  const sol = g.solution;
  const nobody = ![g.finished, ...[...g.others.values()].map((o) => o.finished)].some((f) => f?.reason === 'win');
  const done = g.mode === 'party' ? allDone(g) : true;
  $('#btn-solve').hidden = !!sol;
  $('#solution-progress').hidden = !(sol && sol.running);
  $('#solution-path').hidden = !(sol && sol.path);
  if (!sol) {
    $('#solution-note').textContent = nobody ? '沒有人抵達，看看可以怎麼走' : '';
    if (nobody && done) findSolution(g);
    return;
  }
  if (sol.running) {
    const stage = { start: '讀取起點的連結…', two: '找兩步可以到的路線…', back: '整理會連到終點的條目…', three: '找三步可以到的路線…', four: '往更遠的地方找…' }[sol.stage] || '搜尋中…';
    $('#solution-status').textContent = `${stage}${sol.checked ? `（已看過 ${sol.checked} 個條目）` : ''}`;
    $('#solution-note').textContent = '';
    return;
  }
  if (sol.path) {
    fillPath($('#solution-path'), sol.path, g.settings.target);
    const steps = sol.path.length - 1;
    $('#solution-note').textContent = sol.exact ? `最短 ${steps} 步` : `可行路線 ${steps} 步（不一定最短）`;
  } else {
    $('#btn-solve').hidden = false;
    $('#btn-solve').lastChild.textContent = '再找一次';
    $('#solution-note').textContent = sol.error ? `找不到：${sol.error}` : '找了很久還是沒找到，這題真的很難！';
  }
}

async function findSolution(g) {
  if (g.solution?.running) return;
  g.solution = { running: true, stage: 'start', checked: 0 };
  renderSolution(g);
  const key = g.settings.lang === 'zh' ? (t) => tw(t) : (t) => t;
  try {
    await zhReady;
    const res = await solve(g.settings.lang, g.settings.start, g.settings.target, {
      key,
      onProgress: ({ stage, checked }) => {
        if (state.game !== g) return;
        Object.assign(g.solution, { stage, checked });
        renderSolution(g);
      },
    });
    g.solution = res ? { path: res.path, exact: res.exact } : { path: null };
  } catch (e) {
    g.solution = { path: null, error: e.message };
  }
  if (state.game === g && state.view === 'result') renderSolution(g);
}

// ---------- 全體投票拿提示 ----------
// 比賽超過 5 分鐘，還在比的人都同意，就給大家看終點條目的簡介（把終點的名字遮起來）
const HINT_AFTER = 5 * 60 * 1000;

function offerHint() {
  const g = state.game;
  if (!g || g.finished || g.hint.offered || g.hint.shown) return;
  g.hint.offered = true;
  $('#hint-bar').hidden = false;
  renderHintBar();
  toast('已經 5 分鐘了！大家都同意就能看提示', 3000);
  sfx.near();
}

function renderHintBar() {
  const g = state.game;
  const h = g.hint;
  const btn = $('#btn-hint-vote');
  btn.disabled = h.myVote;
  btn.textContent = h.myVote ? '✓ 已同意' : '💡 我要提示';
  $('#hint-ask-text').textContent = h.need
    ? `提示投票：${h.yes.length} / ${h.need} 人同意${h.myVote && h.yes.length < h.need ? '，等其他人…' : ''}`
    : '比了 5 分鐘還沒到？大家都同意就能看提示';
}

function voteHint() {
  const g = state.game;
  if (!g || g.finished || g.hint.myVote || g.hint.shown) return;
  g.hint.myVote = true;
  renderHintBar();
  if (net.isHost) hostHintVote(state.myId);
  else net.send({ t: 'hintvote' });
}

// 房主：統計還在比、還連著線的人有沒有都同意
function hostHintVote(pid) {
  const g = state.game;
  if (!g || g.hint.shown) return;
  g.hint.votes.add(pid);
  checkHintVotes();
}

function checkHintVotes() {
  const g = state.game;
  if (!g || g.hint.shown || !g.hint.votes.size) return;
  const racers = [...g.others.values()].filter((o) => !o.finished && !o.left && !o.offline).map((o) => o.id);
  if (!g.finished) racers.push(state.myId);
  const yes = racers.filter((id) => g.hint.votes.has(id));
  const tally = { t: 'hinttally', yes, need: racers.length };
  net.send(tally);
  applyHintTally(tally);
  if (racers.length && yes.length >= racers.length) {
    net.send({ t: 'hint' });
    showHint();
  }
}

function applyHintTally(msg) {
  const g = state.game;
  if (!g || g.hint.shown) return;
  g.hint.yes = Array.isArray(msg.yes) ? msg.yes : [];
  g.hint.need = Number(msg.need) || 0;
  if (!g.hint.offered && !g.finished) offerHint();
  if (!g.finished) renderHintBar();
}

async function showHint() {
  const g = state.game;
  if (!g || g.hint.shown) return;
  g.hint.shown = true;
  $('#hint-bar').hidden = true;
  if (g.finished) return;
  toast('💡 全體同意！提示來了', 2500);
  sfx.ready();
  haptic('success');
  $('#hint-text').textContent = '讀取提示中…';
  $('#hint-card').hidden = false;
  $('#hint-card').open = true;
  try {
    const d = await wiki.api(g.settings.lang, { action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', exsentences: '4', redirects: '1', titles: g.settings.target });
    await zhReady;
    let text = d.query?.pages?.[0]?.extract || '';
    if (g.settings.lang === 'zh') text = tw(text);
    text = maskTitle(text.replace(/\s+/g, ' ').trim(), g.settings.target, g.settings.lang);
    $('#hint-text').textContent = text || '找不到這個條目的簡介，只能靠你自己了！';
  } catch (e) {
    $('#hint-text').textContent = `提示讀取失敗（${e.message}）`;
  }
}

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
};
// 持續型效果在畫面上的樣子：壞的紅色、好的綠色
const FX = {
  fog: { icon: '🌫️', bad: true }, flip: { icon: '🙃', bad: true }, freeze: { icon: '🧊', bad: true },
  banana: { icon: '🍌', bad: true }, snail: { icon: '🐌', bad: true }, shield: { icon: '🛡️', bad: false },
};
const MAX_ITEMS = 2;
const ITEM_EVERY = 40000;
// 依照離終點的遠近發道具：落後的人拿強的，領先的人拿弱的
const ITEM_TIERS = {
  behind: { bolt: 3, freeze: 3, banana: 3, crystal: 3, snail: 2 },
  even: { fog: 3, flip: 2, snail: 2, freeze: 1, banana: 1, shield: 2, crystal: 2 },
  lead: { fog: 3, flip: 3, shield: 3, snail: 1 },
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
  $('#item-dock').hidden = !isItems(g);
  // 先在背景查好「哪些條目會連到終點」，用來判斷大家離終點多遠
  if (isItems(g)) {
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
  if (!g.nextItemAt) { el.textContent = '🎁 準備中'; return; }
  el.textContent = g.items.length >= MAX_ITEMS ? '🎁 滿了' : `🎁 ${Math.max(0, Math.ceil((g.nextItemAt - performance.now()) / 1000))}s`;
}

// 離終點幾步：這頁有終點連結＝1，有連到「會連到終點的條目」＝2，其他＝3
function distanceHere(g) {
  if ($('#article a.is-target')) return 1;
  const bs = g.backReady;
  if (bs && [...$('#article').querySelectorAll('a.wl')].some((a) => bs.set.has(bs.key(a.dataset.title)))) return 2;
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

function rollItem(tier) {
  const w = ITEM_TIERS[tier];
  let r = Math.random() * Object.values(w).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(w)) { r -= v; if (r < 0) return k; }
  return 'fog';
}

// 計時器每次跑都檢查：時間到就發一個道具
function itemClock(g) {
  if (!g.startAt) return;
  // 下一次發道具的時間（重新整理接回來時，不補發錯過的道具）
  if (!g.nextItemAt) g.nextItemAt = g.startAt + Math.max(1, Math.ceil(elapsed() / ITEM_EVERY)) * ITEM_EVERY;
  if (performance.now() >= g.nextItemAt) {
    g.nextItemAt += ITEM_EVERY;
    if (g.items.length < MAX_ITEMS) {
      const tier = itemTier(g);
      const it = rollItem(tier);
      g.items.push(it);
      renderItems();
      sfx.ready();
      haptic('success');
      toast(`🎁 拿到 ${ITEMS[it].icon} ${ITEMS[it].name}！${TIER_NOTE[tier] ? `（${TIER_NOTE[tier]}）` : ''}`, 2200);
    }
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
    el.textContent = k === 'banana' ? `${f.icon} 小心腳下` : `${f.icon} ${Math.ceil((g.fx[k] - now) / 1000)}s`;
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
  g.fx[key] = performance.now() + def.ms;
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
    g.backSet = null;
    toast(`水晶球失靈了（${e.message}）`);
  }
}

function openItemsGuide() { $('#items-modal').hidden = false; }

function initItems() {
  $$('.item-slot').forEach((b) => { b.onclick = () => useItem(Number(b.dataset.slot)); });
  const row = (it) => {
    const li = document.createElement('li');
    li.className = it.kind === 'self' ? 'self' : 'atk';
    li.append(Object.assign(document.createElement('i'), { textContent: it.icon }));
    const d = document.createElement('div');
    d.append(Object.assign(document.createElement('b'), { textContent: it.name }), Object.assign(document.createElement('small'), { textContent: it.desc }));
    li.append(d);
    return li;
  };
  $('#items-list-atk').replaceChildren(...Object.values(ITEMS).filter((it) => it.kind !== 'self').map(row));
  $('#items-list-self').replaceChildren(...Object.values(ITEMS).filter((it) => it.kind === 'self').map(row));
  const close = () => { $('#items-modal').hidden = true; store.set('wikirace-items-guide', '1'); };
  $('#item-timer').onclick = openItemsGuide;
  $('#item-guide').onclick = openItemsGuide;
  $('#room-items-help').onclick = openItemsGuide;
  $('#items-ok').onclick = close;
  $('#items-close').onclick = close;
  $('#items-modal').addEventListener('click', (e) => { if (e.target.id === 'items-modal') close(); });
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
  // 上方切換觀戰對象
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
    toast(`沒辦法產生戰績圖：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function initResult() {
  $('#btn-rematch').onclick = () => {
    // 派對還沒全部比完就先回房間：用目前的名次記進最近對戰
    const g = state.game;
    if (g?.finished && !loadHistory().some((h) => h.id === g.id)) saveHistory(g, resultInfo(g));
    enterRoom(net.code);
  };
  $('#btn-share').onclick = openShare;
  $('#pick-close').onclick = () => closePick(null);
  $('#pick-modal').addEventListener('click', (e) => { if (e.target.id === 'pick-modal') closePick(null); });
  $('#btn-solve').onclick = () => { if (state.game) findSolution(state.game); };
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
  if (tooFast(`emote:${state.myId}`, 1200)) { toast('表情冷卻中…', 1000); return; }
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
    $('#tut-next').textContent = i === slides.length - 1 ? '開始玩！' : '下一步';
  };
  const close = () => {
    $('#tutorial').hidden = true;
    store.set('wikirace-tutorial-done', '1');
    // 從邀請連結進來的人看完教學，直接接著填暱稱
    if (state.view === 'home' && $('#join-code').value) ($('#nickname').value ? $('#btn-join') : $('#nickname')).focus();
  };
  $('#tut-next').onclick = () => (i === slides.length - 1 ? close() : go(i + 1));
  $('#tut-prev').onclick = () => go(i - 1);
  $('#tut-skip').onclick = close;
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

function runCoach() {
  if (store.get('wikirace-coach-done') || state.view !== 'game' || state.game?.finished) return;
  const coach = $('#coach');
  let step = 0;
  const place = () => {
    const s = COACH[step];
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
    $('#coach-step').textContent = `${step + 1} / ${COACH.length}　點一下繼續`;
    const bubble = $('#coach-bubble');
    const below = r.bottom + 160 < innerHeight;
    bubble.style.top = below ? `${r.bottom + 14}px` : '';
    bubble.style.bottom = below ? '' : `${innerHeight - r.top + 14}px`;
    bubble.classList.toggle('above', !below);
  };
  const next = () => {
    step++;
    if (step >= COACH.length || state.view !== 'game' || state.game?.finished) {
      coach.hidden = true;
      store.set('wikirace-coach-done', '1');
      return;
    }
    place();
  };
  coach.onclick = next;
  coach.hidden = false;
  place();
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
const cleanNum = (n) => (Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : 0);
function cleanProgress(msg) {
  if (typeof msg.title !== 'string' || !msg.title) return null;
  const out = { t: 'progress', title: msg.title.slice(0, 200), clicks: Math.floor(cleanNum(msg.clicks)), near: !!msg.near, path: cleanPath(msg.path) };
  if (msg.d >= 1 && msg.d <= 3) out.d = Math.floor(msg.d);
  return out;
}
function cleanFinish(msg) {
  const reasons = ['win', 'lose', 'giveup', 'timeout', 'over', 'oppGaveUp', 'oppLeft', 'hostLeft'];
  if (!reasons.includes(msg.reason)) return null;
  return { t: 'finish', reason: msg.reason, elapsed: cleanNum(msg.elapsed), clicks: Math.floor(cleanNum(msg.clicks)), path: cleanPath(msg.path) };
}

function handleGuestMessage(msg, from, cid) {
  // 還沒報上名字的連線只接受 join
  if (msg.t !== 'join' && !state.players.has(from)) return;
  switch (msg.t) {
    case 'join': {
      const key = cleanKey(msg.key) || cid;
      const name = String(msg.name || '玩家').slice(0, 16);
      const avatar = cleanAvatar(msg.avatar);
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
        existing.leaving = false;
        // 房主已經回到房間，但這個人還在比上一局：一樣把比賽狀態給他，重新整理才接得回去
        const snap = state.game && (state.view !== 'room' || stillRacing(key)) ? gameSnapshot() : null;
        net.send({ t: 'welcome', you: key, game: snap, gameId: state.game?.id || null, chat: state.chat.slice(-30) }, key);
        net.send({ t: 'presence', id: key, online: true }, null, key);
        if (wasOffline) {
          onPresence(key, true);
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
      state.players.set(key, { id: key, name, avatar, ready: false, host: false, color, online: true });
      net.send({ t: 'welcome', you: key, game: null, chat: state.chat.slice(-30) }, key);
      broadcastLobby();
      toast(`${name} 加入了房間`);
      sysChat(`${name} 加入了房間`);
      sfx.ready();
      haptic('medium');
      setConn('已連線', true);
      break;
    }
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
      if (!EMOTES.includes(msg.e) || tooFast(`emote:${from}`, 1000)) return;
      net.send({ t: 'emote', id: from, e: msg.e }, null, from);
      showEmote(from, msg.e);
      break;
    case 'hintvote':
      if (state.game?.others.get(from) && !state.game.others.get(from).finished) hostHintVote(from);
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
        if (snap.hint && !g.hint.shown) showHint();
        renderOppHud();
        if (g.finished) net.send({ t: 'finish', ...g.finished });
        else if (g.current) net.send({ t: 'progress', title: g.current, clicks: g.clicks, near: g.near, path: g.path });
        if (state.view === 'result') showResult(true);
      } else if (snap) {
        resumeGame(snap);
      } else if (g && msg.gameId === g.id) {
        // 房主已經回到房間，但這一局還算數：把自己的結果或進度補給房主
        if (g.finished) net.send({ t: 'finish', ...g.finished });
        else if (g.current) net.send({ t: 'progress', title: g.current, clicks: g.clicks, near: g.near, path: g.path });
      }
      break;
    }
    case 'lobby':
      if (msg.score && Number.isFinite(msg.score.games) && msg.score.wins && typeof msg.score.wins === 'object') state.roomScore = { games: msg.score.games, wins: { ...msg.score.wins } };
      state.mode = msg.mode === 'party' ? 'party' : 'duel';
      state.players = new Map((msg.players || []).map((p) => [p.id, { ...p, avatar: cleanAvatar(p.avatar) }]));
      if (state.myId && state.players.get(state.myId)) state.myReady = !!state.players.get(state.myId).ready;
      if (state.view !== 'game' && state.view !== 'result') {
        state.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
        writeForm(state.settings);
      }
      if (state.view === 'room') renderRoom();
      break;
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
      if (Array.isArray(msg.players)) state.players = new Map(msg.players.map((p) => [p.id, { ...p, avatar: cleanAvatar(p.avatar) }]));
      if (state.view === 'room') renderRoom();
      break;
    }
    case 'settings':
      state.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      writeForm(state.settings);
      if (state.view === 'room') renderRoom();
      break;
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
      showHint();
      break;
    case 'itemblock':
      if (msg.by) onItemBlocked(msg.by, msg.item, msg.from);
      break;
  }
}

net.onHostLost = () => {
  netBanner(state.migrating ? `房主交給 ${state.migrating}，重新連線中…` : '與房主的連線中斷，正在重新連線…');
  setConn('重新連線中…');
  clearTimeout(hostGiveUpTimer);
  hostGiveUpTimer = setTimeout(giveUpHost, HOST_GIVEUP);
};

net.onHostBack = () => {
  clearTimeout(hostGiveUpTimer);
  state.migrating = null;
  netBanner('');
  setConn('已連線', true);
  toast('已重新連線！', 2000);
  sendJoin();
};

// 一直連不回房主：當作房主離開
function giveUpHost() {
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
window.__wikirace = { net, state };

initSound();
initHome();
initRoom();
initGame();
initResult();
initChat();
initEmotes();
initTutorial();
initItems();
initMusicSettings();
$('#btn-hint-vote').onclick = voteHint;
show('home');
// 第一次來的人先看教學（重新整理回房間時不打擾）
// 第一次來的人先看教學；從邀請連結來的人只顯示提示，不擋住加入（重新整理回房間時都不打擾）
if (!store.get('wikirace-tutorial-done') && !session.load()) {
  if (new URLSearchParams(location.search).get('room')) $('#tut-hint').hidden = false;
  else openTutorial();
}
$('#tut-hint').onclick = () => { $('#tut-hint').hidden = true; openTutorial(); };
