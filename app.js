import { Net } from './net.js';
import * as wiki from './wiki.js';
import { tw, twTree, zhReady } from './zh.js';

import { sfx, music, unlockAudio, isSfxOn, setSfxOn, isMusicOn, setMusicOn, haptic, flash, shake, confetti } from './fx.js';

const $ = (sel) => document.querySelector(sel);
const net = new Net();

const DEFAULT_SETTINGS = {
  lang: 'zh', timeLimit: 0, start: '', target: '',
  showOpponentPage: true, allowBack: true, trueRandom: false,
};
const MAX_PLAYERS = { duel: 2, party: 8 };
// 派對模式：第一個人抵達後，其他人剩這麼多秒
const LAST_CALL = 60;
const COLORS = ['#2f7bff', '#ff4d6d', '#22c55e', '#ff8a3d', '#8b5cf6', '#ff5ca8', '#14b8a6', '#eab308'];

const state = {
  myName: '',
  myId: null,
  mode: 'duel',
  players: new Map(), // id → { id, name, ready, host, color }
  myReady: false,
  settings: { ...DEFAULT_SETTINGS },
  view: 'home',
  game: null,
};

// ---------- 小工具 ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無痕模式等情況 */ } },
};

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
  for (const v of ['home', 'room', 'game', 'result']) $(`#view-${v}`).hidden = v !== view;
  $('.masthead').hidden = view === 'game';
  if (view === 'home' || view === 'room') music.play('lobby');
  if (view === 'home') renderStats();
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

// 頭像顯示名字的第一個字
function initial(name) {
  const ch = Array.from((name || '').trim())[0];
  return ch ? ch.toUpperCase() : '?';
}

function avatarEl(name, color, cls = '') {
  const a = document.createElement('span');
  a.className = `avatar ${cls}`;
  a.textContent = initial(name);
  if (color) a.style.setProperty('--side', color);
  return a;
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
const opponents = () => [...state.players.values()].filter((p) => p.id !== state.myId);
const nameOf = (id) => state.players.get(id)?.name || state.game?.others.get(id)?.name || '玩家';

// ---------- 音效、音樂、觸覺 ----------
function initSound() {
  const paint = () => {
    $('#btn-sound').classList.toggle('off', !isSfxOn());
    for (const b of [$('#btn-music'), $('#btn-music-game')]) b.classList.toggle('off', !isMusicOn());
  };
  paint();
  $('#btn-sound').onclick = () => { setSfxOn(!isSfxOn()); paint(); };
  const toggleMusic = () => { setMusicOn(!isMusicOn()); paint(); toast(isMusicOn() ? '背景音樂：開' : '背景音樂：關', 1200); };
  $('#btn-music').onclick = toggleMusic;
  $('#btn-music-game').onclick = toggleMusic;
  // 瀏覽器要求使用者先操作過才能出聲
  for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, { passive: true });
  // 每次點擊按鈕、選項都給一下觸覺與聲音回饋
  document.addEventListener('click', (e) => {
    // 只回應真人的點擊；程式觸發的點擊（例如 iPhone 震動用的隱藏開關）一律略過，否則會無限循環
    if (!e.isTrusted || e.target.closest('[data-haptic]')) return;
    const el = e.target.closest('button, input[type=checkbox], input[type=radio], .article a');
    if (!el || el.disabled) return;
    if (el.matches('.article a')) { haptic(el.dataset.title ? 'medium' : 'light'); return; }
    haptic('light');
    sfx.tap();
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
  '派對模式最多可以 8 個人一起比，第一個人抵達後其他人只剩 60 秒？',
];

// ---------- 戰績（存在這支手機上） ----------
function loadStats() {
  try { return { w: 0, l: 0, d: 0, streak: 0, ...JSON.parse(store.get('wikirace-stats') || '{}') }; } catch { return { w: 0, l: 0, d: 0, streak: 0 }; }
}

function recordResult(res) {
  const st = loadStats();
  if (res === 'win') { st.w++; st.streak++; } else if (res === 'lose') { st.l++; st.streak = 0; } else { st.d++; }
  store.set('wikirace-stats', JSON.stringify(st));
}

function unrecordResult(res) {
  const st = loadStats();
  if (res === 'win') { st.w = Math.max(0, st.w - 1); st.streak = Math.max(0, st.streak - 1); } else if (res === 'lose') st.l = Math.max(0, st.l - 1); else st.d = Math.max(0, st.d - 1);
  store.set('wikirace-stats', JSON.stringify(st));
}

function renderStats() {
  const st = loadStats();
  const total = st.w + st.l + st.d;
  $('#stat-w').textContent = st.w;
  $('#stat-l').textContent = st.l;
  $('#stat-rate').textContent = total ? `${Math.round((st.w / total) * 100)}%` : '–';
  $('#stat-streak').textContent = st.streak;
}

// ---------- 首頁 ----------
function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'duel';
}

function initHome() {
  $('#dyk-text').textContent = DYK[Math.floor(Math.random() * DYK.length)];
  // 閒置時預先載入題庫並顯示數量
  setTimeout(() => {
    import('./topics.js').then((m) => { $('#topic-count').textContent = m.TOPICS.length.toLocaleString('en-US'); }).catch(() => {});
  }, 1200);
  $('#nickname').value = store.get('wikirace-name') || '';
  const paintAvatar = () => { $('#home-avatar').textContent = initial($('#nickname').value); };
  paintAvatar();
  $('#nickname').addEventListener('input', paintAvatar);

  const savedMode = store.get('wikirace-mode');
  if (savedMode === 'party') document.querySelector('input[name="mode"][value="party"]').checked = true;
  const paintMode = () => {
    $('#btn-create').textContent = selectedMode() === 'party' ? '建立派對房間' : '建立對決房間';
  };
  paintMode();
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
    store.set('wikirace-mode', selectedMode());
    paintMode();
  }));

  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    $('#join-code').value = room.toUpperCase();
    ($('#nickname').value ? $('#btn-join') : $('#nickname')).focus();
  }

  const getName = () => {
    const n = $('#nickname').value.trim();
    if (!n) { showError('#home-error', '請先輸入暱稱'); $('#nickname').focus(); return null; }
    store.set('wikirace-name', n);
    return n;
  };

  $('#btn-create').onclick = async () => {
    const name = getName();
    if (!name) return;
    showError('#home-error');
    state.myName = name;
    state.mode = selectedMode();
    $('#btn-create').disabled = true;
    setConn('建立中…');
    try {
      const code = await net.createRoom(MAX_PLAYERS[state.mode] - 1);
      state.myId = 'host';
      state.players = new Map([['host', { id: 'host', name, ready: true, host: true, color: COLORS[0] }]]);
      setConn(isParty() ? '等待玩家' : '等待對手');
      enterRoom(code);
    } catch (e) {
      showError('#home-error', e.message);
      setConn('');
    } finally {
      $('#btn-create').disabled = false;
    }
  };

  const join = async () => {
    const name = getName();
    if (!name) return;
    const code = $('#join-code').value.trim().toUpperCase();
    if (!code) { showError('#home-error', '請輸入房間代碼'); return; }
    showError('#home-error');
    state.myName = name;
    $('#btn-join').disabled = true;
    setConn('連線中…');
    try {
      await net.joinRoom(code);
      net.send({ t: 'join', name });
      setConn('已連線', true);
      state.players = new Map();
      enterRoom(code);
    } catch (e) {
      showError('#home-error', e.message);
      setConn('');
    } finally {
      $('#btn-join').disabled = false;
    }
  };
  $('#btn-join').onclick = join;
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
}

// ---------- 房間 ----------
const form = () => $('#settings-form');

function readForm() {
  const f = form().elements;
  return {
    lang: f.lang.value,
    timeLimit: Number(f.timeLimit.value),
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
  if (document.activeElement !== f.start) f.start.value = tw(s.start);
  if (document.activeElement !== f.target) f.target.value = tw(s.target);
  f.showOpponentPage.checked = s.showOpponentPage;
  f.allowBack.checked = s.allowBack;
  f.trueRandom.checked = s.trueRandom;
}

function renderDuelSlots() {
  const host = state.players.get('host');
  const guest = [...state.players.values()].find((p) => !p.host);
  const iAmHost = net.isHost;
  $('#slot-host .avatar').textContent = initial(host?.name);
  $('#slot-guest .avatar').textContent = guest ? initial(guest.name) : '?';
  $('#slot-host .pname').textContent = host?.name || '—';
  $('#slot-host .pstate').textContent = '';
  $('#slot-guest .pname').textContent = guest ? guest.name : '等待對手加入…';
  $('#slot-guest .pstate').textContent = guest ? (guest.ready ? '✓ 已準備' : '尚未準備') : '';
  $('#slot-guest').classList.toggle('ready', !!guest?.ready);
  $('#slot-guest').classList.toggle('empty', !guest);
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
    li.classList.toggle('ready', p.ready || p.host);
    li.classList.toggle('is-me', p.id === state.myId);
    li.append(avatarEl(p.name, p.color));
    const name = Object.assign(document.createElement('b'), { textContent: p.name });
    const tag = Object.assign(document.createElement('span'), {
      className: 'party-tag',
      textContent: p.host ? '房主' : (p.ready ? '✓ 準備好了' : '準備中…'),
    });
    li.append(name, tag);
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

function renderRoom() {
  const host = net.isHost;
  const party = isParty();
  $('.versus').hidden = party;
  $('#party-board').hidden = !party;
  if (party) renderPartyBoard(); else renderDuelSlots();

  for (const el of form().elements) if (!el.matches('#btn-ready, #btn-start')) el.disabled = !host;
  $('#host-only-hint').hidden = host;

  const guests = opponents().filter((p) => !p.host);
  const allReady = guests.length > 0 && guests.every((p) => p.ready);
  const ready = $('#btn-ready');
  ready.hidden = host;
  ready.textContent = state.myReady ? '已準備 ✓（再按一次取消）' : '準備';
  ready.classList.toggle('is-ready', state.myReady);
  $('#btn-start').hidden = !host;
  $('#btn-start').disabled = !allReady;

  const waiting = guests.filter((p) => !p.ready).length;
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
  if (net.isHost) net.locked = false;
  writeForm(state.settings);
  showError('#room-error');
  show('room');
  renderRoom();
}

// 房主：把玩家名單和設定同步給所有人
function lobbyMsg() {
  return { t: 'lobby', mode: state.mode, players: [...state.players.values()], settings: state.settings };
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
      btn.disabled = true;
      btn.classList.add('busy');
      try {
        const s = readForm();
        let t;
        do { t = await wiki.randomTitle(s.lang, s.trueRandom); } while (t === s[key === 'start' ? 'target' : 'start']);
        await zhReady;
        form().elements[key].value = tw(t);
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
    if (!confirm('確定要離開房間嗎？')) return;
    net.destroy();
    location.href = location.pathname;
  };

  $('#btn-ready').onclick = () => {
    state.myReady = !state.myReady;
    net.send({ t: 'ready', ready: state.myReady });
    if (state.myReady) { sfx.ready(); haptic('success'); }
    renderRoom();
  };

  $('#btn-start').onclick = hostStart;
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
    net.send({ t: 'settings', settings: s });
    net.send({ t: 'start', settings: s, mode: state.mode, players: [...state.players.values()] });
    startGame(s);
  } catch (e) {
    showError('#room-error', e.message);
  } finally {
    btn.textContent = '開始對局';
    renderRoom();
  }
}

// ---------- 比賽 ----------
function startGame(settings) {
  state.myReady = false;
  state.settings = settings;
  if (net.isHost) net.locked = true;
  const others = new Map(opponents().map((p) => [p.id, {
    id: p.id, name: p.name, color: p.color,
    clicks: 0, current: settings.start, path: [], near: false, finished: null, left: false,
  }]));
  state.game = {
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
    timer: null,
    heart: null,
  };
  const party = isParty();
  const me = state.players.get(state.myId);
  $('#hud-target').textContent = tw(settings.target);
  $('#hud-clicks').textContent = '0';
  $('#hud-timer').textContent = settings.timeLimit ? fmtTime(settings.timeLimit * 1000) : '00:00';
  $('#hud-timer').className = 'hud-timer';
  $('#hud-me-avatar').textContent = initial(state.myName);
  $('#hud-me-avatar').style.setProperty('--side', party && me ? me.color : '');
  $('#hud-strip').hidden = !party;
  $('#hud-lastcall').hidden = true;
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
  const iv = setInterval(() => {
    n--;
    if (n > 0) { showNum(n); sfx.count(); haptic('countdown'); return; }
    clearInterval(iv);
    showNum('GO!', true);
    sfx.go();
    haptic('go');
    flash('#14866d');
    music.play('race');
    setTimeout(() => { overlay.hidden = true; }, 450);
    const g = state.game;
    g.startAt = performance.now();
    g.timer = setInterval(tick, 200);
    goTo(settings.start, { first: true, preload });
  }, 1000);
}

// 右上角：對決模式顯示對手；派對模式顯示抵達人數，並在下方列出每個人
function renderOppHud() {
  const g = state.game;
  if (!g) return;
  const list = [...g.others.values()];
  if (g.mode !== 'party') {
    const o = list[0];
    $('#hud-opp-name').textContent = o?.name || '對手';
    $('#hud-opp-avatar').textContent = initial(o?.name);
    $('#hud-opp-avatar').style.removeProperty('--side');
    $('#hud-opp-clicks').textContent = o ? o.clicks : 0;
    $('#hud-opp-clicks').parentElement.lastChild.textContent = ' 步';
    let where = '';
    if (o?.left) where = `${o.name} 已離線`;
    else if (o && g.settings.showOpponentPage) where = `${o.name} 在《${tw(o.current)}》`;
    $('#hud-opp-page').textContent = where;
    return;
  }
  const arrived = list.filter((o) => o.finished?.reason === 'win').length + (g.finished?.reason === 'win' ? 1 : 0);
  $('#hud-opp-name').textContent = `${list.length} 位對手`;
  $('#hud-opp-avatar').textContent = String(list.length);
  $('#hud-opp-avatar').style.setProperty('--side', '#ffb020');
  $('#hud-opp-clicks').textContent = `${arrived}/${list.length + 1}`;
  $('#hud-opp-clicks').parentElement.lastChild.textContent = ' 抵達';
  $('#hud-opp-page').textContent = '';
  const chips = list.map((o) => {
    const li = document.createElement('li');
    li.className = 'strip-chip';
    if (o.finished?.reason === 'win') li.classList.add('done');
    if (o.left || (o.finished && o.finished.reason !== 'win')) li.classList.add('out');
    if (o.near && !o.finished) li.classList.add('near');
    li.dataset.id = o.id;
    li.append(avatarEl(o.name, o.color, 'sm'));
    const info = document.createElement('span');
    info.className = 'strip-info';
    const label = o.finished?.reason === 'win' ? '抵達！' : o.left ? '離線' : o.finished ? '出局' : `${o.clicks} 步`;
    info.append(Object.assign(document.createElement('b'), { textContent: o.name }), Object.assign(document.createElement('span'), { textContent: label }));
    if (g.settings.showOpponentPage && !o.finished && !o.left) {
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

  // 派對模式的最後衝刺倒數
  if (g.lastCallEnd) {
    const lc = g.lastCallEnd - performance.now();
    left = Math.min(left, lc);
    $('#hud-lastcall').hidden = false;
    $('#hud-lastcall').textContent = `最後衝刺！剩 ${Math.max(0, Math.ceil(lc / 1000))} 秒`;
  }
  if (left !== Infinity) {
    timer.classList.toggle('warn', left < 60000 && left >= 10000);
    timer.classList.toggle('crit', left < 10000);
    // 最後 10 秒每秒滴答
    const sec = Math.ceil(left / 1000);
    if (left < 10000 && sec !== g.lastSecond) { g.lastSecond = sec; sfx.tick(); haptic('light'); }
  }
  updateIntensity(left);
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

async function goTo(title, { first = false, back = false, preload = null } = {}) {
  const g = state.game;
  if (!g || g.finished || g.loading) return;
  g.loading = true;
  $('#article-loading').hidden = false;
  if (!first) sfx.click();
  try {
    const art = await (preload || wiki.fetchArticle(g.settings.lang, title));
    await zhReady;
    if (g !== state.game || g.finished) return;
    if (!first) g.clicks++;
    if (g.current && !back) g.stack.push(g.current);
    g.current = art.title;
    g.path.push(art.title);
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

    sendProgress({ t: 'progress', title: art.title, clicks: g.clicks, near });
    if (reached) finishGame('win');
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
  const tmp = document.createElement('div');
  tmp.innerHTML = art.displayTitle || art.title;
  $('#article-title').textContent = tw(tmp.textContent);

  const root = $('#article');
  root.innerHTML = art.html;
  root.querySelectorAll('.mw-editsection, .mw-empty-elt, script').forEach((el) => el.remove());
  if (state.game.settings.lang === 'zh') twTree(root);
  const target = state.game.settings.target;
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
  window.scrollTo(0, 0);
}

function initGame() {
  const root = $('#article');
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
    if (a.dataset.title) goTo(a.dataset.title);
    else toast('只能點擊連到其他條目的連結喔');
  });
  // 擋掉中鍵另開分頁
  root.addEventListener('auxclick', (e) => { if (e.target.closest('a')) e.preventDefault(); });

  $('#btn-back').onclick = () => {
    const g = state.game;
    if (!g || !g.stack.length || g.loading) return;
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
  o.path.push(msg.title);
  o.near = !!msg.near;
  renderOppHud();
  if (g.finished) { if (state.view === 'result') showResult(true); return; }
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
  if (net.isHost) onAnyFinish(state.myId, g.finished);
  $('#countdown').hidden = true;
  $('#path-drawer').hidden = true;
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

// 房主：派對模式中第一個人抵達時，宣布最後衝刺
function onAnyFinish(id, info) {
  const g = state.game;
  if (!g || g.mode !== 'party' || info.reason !== 'win' || g.lastCallSent) return;
  g.lastCallSent = true;
  net.send({ t: 'lastcall', seconds: LAST_CALL, by: id });
  applyLastCall(LAST_CALL, id);
}

function applyLastCall(seconds, by) {
  const g = state.game;
  if (!g || g.lastCallEnd) return;
  g.lastCallEnd = performance.now() + seconds * 1000;
  if (g.finished) return;
  const who = by === state.myId ? '你' : nameOf(by);
  toast(`${who} 第一個抵達！剩下的人只剩 ${seconds} 秒`, 3500);
  sfx.alarm();
  haptic('warning');
  tick();
}

function onOtherFinish(id, msg) {
  const g = state.game;
  const o = g?.others.get(id);
  if (!o) return;
  o.finished = msg;
  o.clicks = msg.clicks;
  o.path = msg.path || o.path;
  o.near = false;
  renderOppHud();
  if (g.mode !== 'party') {
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
  if (!g.finished) {
    refreshDanger();
    if (msg.reason === 'win') {
      const place = ranking(g).find((e) => e.id === id)?.place;
      feed([{ b: o.name }, ` 抵達終點！第 ${place || '?'} 名`], '抵達', o.color);
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

// ---------- 結果 ----------
function outcomeDuel(g) {
  const me = g.finished;
  const opp = [...g.others.values()][0]?.finished;
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
    { id: state.myId, name: state.myName, color: meP?.color || COLORS[0], me: true, finished: g.finished, clicks: g.finished?.clicks ?? g.clicks, path: g.finished?.path || g.path, left: false },
    ...[...g.others.values()].map((o) => ({ id: o.id, name: o.name, color: o.color, me: false, finished: o.finished, clicks: o.clicks, path: o.path, left: o.left })),
  ];
  const group = (e) => {
    if (e.finished?.reason === 'win') return 0;
    if (!e.finished && !e.left) return 1;
    if (e.finished?.reason === 'timeout') return 2;
    if (e.finished?.reason === 'giveup') return 3;
    return 4;
  };
  entries.sort((a, b) => group(a) - group(b)
    || (group(a) === 0 ? (a.finished.elapsed - b.finished.elapsed) || (a.clicks - b.clicks) : b.clicks - a.clicks));
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
    win: '抵達終點', lose: '未抵達', giveup: '投降', timeout: '時間到', oppGaveUp: '對手投降', oppLeft: '對手離線', hostLeft: '房主離線',
  }[f.reason] || '—';
}

function rankStatus(e) {
  if (e.finished?.reason === 'win') return `${e.clicks} 步 · ${fmtTime(e.finished.elapsed)}`;
  if (e.left && !e.finished) return '離線';
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
    sum.append(avatarEl(e.name, e.color, 'sm'), name, stat);
    const ol = document.createElement('ol');
    ol.className = 'metro';
    ol.style.setProperty('--side', e.color);
    fillPath(ol, e.path || [], target);
    body.append(sum, ol);
    li.append(badge, body);
    return li;
  });
  $('#rank-list').replaceChildren(...items);
}

let lastOutcome = null;
function showResult(update = false) {
  const g = state.game;
  const party = g.mode === 'party';
  let res;
  let kicker;
  let title;
  if (party) {
    const entries = ranking(g);
    const mine = entries.find((e) => e.me);
    res = mine.place === 1 ? 'win' : 'lose';
    kicker = mine.place ? String(mine.place) : '–';
    if (mine.place === 1) title = '第 1 名！你最快！';
    else if (mine.place) title = `第 ${mine.place} 名！`;
    else title = g.finished.reason === 'giveup' ? '你投降了' : g.finished.reason === 'hostLeft' ? '房主離線了' : '沒能在時限內抵達…';
    renderRanking(g, entries);
    $('#result-hero').className = `cover result-hero ${mine.place === 1 ? 'win' : mine.place ? 'place' : 'lose'}`;
  } else {
    res = outcomeDuel(g);
    const map = { win: ['勝', '你贏了！'], lose: ['敗', '對手搶先一步…'], draw: ['和', '平手！'] };
    [kicker, title] = map[res];
    $('#result-hero').className = `cover result-hero ${res}`;
    renderDuelResult(g, res);
  }
  $('#ranking').hidden = !party;
  $('#score-card').hidden = party;
  $('#route-grid').hidden = party;
  $('#result-kicker').textContent = kicker;
  $('#result-title').textContent = title;
  let sub = `《${tw(g.settings.start)}》→《${tw(g.settings.target)}》`;
  if (g.finished.reason === 'oppGaveUp') sub += '（對手投降）';
  if (g.finished.reason === 'oppLeft') sub += '（對手離線）';
  if (g.finished.reason === 'timeout') sub += '（時間到）';
  if (party && !allDone(g)) sub += '　等待其他玩家…';
  $('#result-sub').textContent = sub;
  $('#btn-rematch').disabled = !net.connected;
  $('#btn-rematch').textContent = net.connected ? '再來一局' : (party ? '其他人都離線了' : '對手已離線');

  // 結果可能因為幾乎同時抵達而更正，戰績也跟著更正
  if (!g.recorded) { recordResult(res); g.recorded = res; }
  else if (g.recorded !== res) { unrecordResult(g.recorded); recordResult(res); g.recorded = res; }

  const hero = $('#result-hero');
  const changed = !update || res !== lastOutcome;
  lastOutcome = res;
  show('result');
  if (!changed) return;
  if (res === 'win') { sfx.win(); confetti(); haptic('success'); }
  else if (party && g.finished.reason === 'win') { sfx.ready(); haptic('success'); }
  else { sfx.lose(); shake(hero); haptic('error'); }
  // 結算音效播完後回到大廳音樂
  setTimeout(() => { if (state.view === 'result') music.play('lobby'); }, 3500);
}

function renderDuelResult(g, res) {
  const me = g.finished;
  const o = [...g.others.values()][0] || { name: '對手', clicks: 0, path: [], finished: null, left: true };
  const opp = o.finished;
  $('#res-me-name').textContent = `${state.myName}（你）`;
  $('#res-me-avatar').textContent = initial(state.myName);
  $('#res-opp-avatar').textContent = initial(o.name);
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

function initResult() {
  $('#btn-rematch').onclick = () => enterRoom(net.code);
}

// ---------- 連線訊息 ----------
net.onPeerJoin = () => {
  setConn('已連線', true);
};

net.onPeerLeave = (id) => {
  if (!net.isHost) {
    // 房主離開：房間就解散了
    setConn('房主已離線');
    toast('房主已離線', 4000);
    const g = state.game;
    if (state.view === 'game' && g && !g.finished) {
      if (g.mode === 'party') finishGame('hostLeft');
      else { onOtherLeft('host'); }
      return;
    }
    if (g) for (const o of g.others.values()) o.left = true;
    if (state.view === 'result') showResult(true);
    else if (state.view === 'room') {
      show('home');
      showError('#home-error', '房主已離開房間');
    }
    return;
  }
  const name = nameOf(id);
  state.players.delete(id);
  toast(`${name} 離開了`, 3000);
  net.send({ t: 'left', id });
  onOtherLeft(id);
  if (!net.connected) setConn(isParty() ? '等待玩家' : '對手已離線');
  broadcastLobby();
};

function handleGuestMessage(msg, from) {
  switch (msg.t) {
    case 'join': {
      const used = new Set([...state.players.values()].map((p) => p.color));
      const color = COLORS.find((c) => !used.has(c)) || COLORS[state.players.size % COLORS.length];
      const name = String(msg.name || '玩家').slice(0, 16);
      state.players.set(from, { id: from, name, ready: false, host: false, color });
      net.send({ t: 'welcome', you: from }, from);
      broadcastLobby();
      toast(`${name} 加入了房間`);
      sfx.ready();
      haptic('medium');
      setConn('已連線', true);
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
    case 'progress':
      net.send({ ...msg, id: from }, null, from);
      onOtherProgress(from, msg);
      break;
    case 'finish':
      net.send({ ...msg, id: from }, null, from);
      onOtherFinish(from, msg);
      break;
  }
}

function handleHostMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      state.myId = msg.you;
      break;
    case 'lobby':
      state.mode = msg.mode === 'party' ? 'party' : 'duel';
      state.players = new Map((msg.players || []).map((p) => [p.id, p]));
      if (state.myId && state.players.get(state.myId)) state.myReady = !!state.players.get(state.myId).ready;
      if (state.view !== 'game' && state.view !== 'result') {
        state.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
        writeForm(state.settings);
      }
      if (state.view === 'room') renderRoom();
      break;
    case 'full':
      net.destroy();
      show('home');
      setConn('');
      showError('#home-error', msg.started ? '這個房間正在比賽中，請等這局結束再加入' : '這個房間已經滿了');
      break;
    case 'settings':
      state.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      writeForm(state.settings);
      if (state.view === 'room') renderRoom();
      break;
    case 'start':
      state.mode = msg.mode === 'party' ? 'party' : 'duel';
      if (msg.players) state.players = new Map(msg.players.map((p) => [p.id, p]));
      startGame({ ...DEFAULT_SETTINGS, ...msg.settings });
      break;
    case 'progress':
      if (msg.id) onOtherProgress(msg.id, msg);
      break;
    case 'finish':
      if (msg.id) onOtherFinish(msg.id, msg);
      break;
    case 'left':
      onOtherLeft(msg.id);
      break;
    case 'lastcall':
      applyLastCall(msg.seconds || LAST_CALL, msg.by);
      break;
  }
}

net.onMessage = (msg, from) => {
  if (net.isHost) handleGuestMessage(msg, from);
  else handleHostMessage(msg);
};

window.addEventListener('beforeunload', (e) => {
  if (state.view === 'game' && state.game && !state.game.finished) e.preventDefault();
});

// 關閉分頁時主動斷線，讓其他人立刻收到通知
window.addEventListener('pagehide', () => net.destroy());

initSound();
initHome();
initRoom();
initGame();
initResult();
show('home');
