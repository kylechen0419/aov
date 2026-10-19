import { Net } from './net.js';
import * as wiki from './wiki.js';
import { sfx, unlockAudio, isMuted, setMuted, vibrate, flash, shake, confetti } from './fx.js';

const $ = (sel) => document.querySelector(sel);
const net = new Net();

const DEFAULT_SETTINGS = {
  lang: 'zh', timeLimit: 0, start: '', target: '',
  showOpponentPage: true, allowBack: true, trueRandom: false,
};

const state = {
  myName: '',
  oppName: '',
  settings: { ...DEFAULT_SETTINGS },
  guestReady: false,
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
  $('.topbar').hidden = view === 'game';
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

function fillPath(ol, path, target) {
  ol.replaceChildren(...path.map((t) => {
    const li = document.createElement('li');
    li.textContent = t;
    if (t === target) li.classList.add('hit');
    return li;
  }));
}

// ---------- 音效開關 ----------
function initSound() {
  const btn = $('#btn-sound');
  const paint = () => { btn.textContent = isMuted() ? '🔇' : '🔊'; };
  paint();
  btn.onclick = () => { setMuted(!isMuted()); paint(); if (!isMuted()) { unlockAudio(); sfx.click(); } };
  // 瀏覽器要求使用者先操作過才能出聲
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlockAudio, { passive: true });
}

// ---------- 首頁 ----------
function initHome() {
  $('#nickname').value = store.get('wikirace-name') || '';
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
    $('#btn-create').disabled = true;
    setConn('建立中…');
    try {
      const code = await net.createRoom();
      setConn('等待對手');
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
  if (document.activeElement !== f.start) f.start.value = s.start;
  if (document.activeElement !== f.target) f.target.value = s.target;
  f.showOpponentPage.checked = s.showOpponentPage;
  f.allowBack.checked = s.allowBack;
  f.trueRandom.checked = s.trueRandom;
}

function renderRoom() {
  const host = net.isHost;
  const hostName = host ? state.myName : state.oppName;
  const guestName = host ? state.oppName : state.myName;
  const hasGuest = net.connected;

  $('#slot-host .pname').textContent = hostName || '—';
  $('#slot-host .pstate').textContent = '';
  $('#slot-guest .pname').textContent = hasGuest && guestName ? guestName : '等待對手加入…';
  $('#slot-guest .pstate').textContent = hasGuest ? (state.guestReady ? 'READY' : '準備中…') : '';
  $('#slot-guest').classList.toggle('ready', hasGuest && state.guestReady);
  $('#slot-guest').classList.toggle('empty', !hasGuest);
  $('#slot-host').classList.toggle('is-me', host);
  $('#slot-guest').classList.toggle('is-me', !host);
  // 自己永遠是青色、對手永遠是洋紅
  $('#slot-host').classList.toggle('me-side', host);
  $('#slot-host').classList.toggle('opp-side', !host);
  $('#slot-guest').classList.toggle('me-side', !host);
  $('#slot-guest').classList.toggle('opp-side', host);

  for (const el of form().elements) el.disabled = !host;
  $('#host-only-hint').hidden = host;

  const ready = $('#btn-ready');
  ready.hidden = host;
  ready.textContent = state.guestReady ? '已準備 ✓（點擊取消）' : '準備';
  ready.classList.toggle('is-ready', state.guestReady);
  $('#btn-start').hidden = !host;
  $('#btn-start').disabled = !(hasGuest && state.guestReady);

  let hint = '';
  if (host && !hasGuest) hint = '把房間代碼或邀請連結傳給朋友吧！';
  else if (host && !state.guestReady) hint = '等待對手按下「準備」…';
  else if (host) hint = '對手準備好了，按下開始！';
  else if (!state.guestReady) hint = '確認路線後按「準備」';
  else hint = '等待房主開始比賽…';
  $('#room-hint').textContent = hint;
}

function enterRoom(code) {
  $('#room-code').textContent = code;
  state.guestReady = false;
  writeForm(state.settings);
  showError('#room-error');
  show('room');
  renderRoom();
}

let settingsTimer;
function broadcastSettings() {
  const next = readForm();
  if (JSON.stringify(next) === JSON.stringify(state.settings)) return;
  state.settings = next;
  // 設定變動時讓對手重新確認
  if (state.guestReady) { state.guestReady = false; renderRoom(); }
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
          $(`#suggest-${name}`).replaceChildren(...list.map((t) => Object.assign(document.createElement('option'), { value: t })));
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
      try {
        const s = readForm();
        let t;
        do { t = await wiki.randomTitle(s.lang, s.trueRandom); } while (t === s[key === 'start' ? 'target' : 'start']);
        form().elements[key].value = t;
        sfx.click();
        broadcastSettings();
      } catch (e) {
        showError('#room-error', e.message);
      } finally {
        btn.disabled = false;
      }
    };
  });

  $('#btn-copy-link').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${net.code}`;
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
    state.guestReady = !state.guestReady;
    net.send({ t: 'ready', ready: state.guestReady });
    if (state.guestReady) sfx.near();
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
    if (!net.connected) throw new Error('對手已離線');
    state.settings = s;
    writeForm(s);
    net.send({ t: 'settings', settings: s });
    net.send({ t: 'start', settings: s });
    startGame(s);
  } catch (e) {
    showError('#room-error', e.message);
  } finally {
    btn.textContent = '開始比賽';
    renderRoom();
  }
}

// ---------- 比賽 ----------
function startGame(settings) {
  state.guestReady = false;
  state.settings = settings;
  state.game = {
    settings,
    startAt: 0,
    clicks: 0,
    path: [],
    stack: [],
    current: null,
    loading: false,
    near: false,
    finished: null,
    lastSecond: null,
    opp: { clicks: 0, current: settings.start, path: [], finished: null, left: false, near: false },
    timer: null,
    heart: null,
  };
  $('#hud-target').textContent = settings.target;
  $('#hud-clicks').textContent = '0';
  $('#hud-timer').textContent = settings.timeLimit ? fmtTime(settings.timeLimit * 1000) : '00:00';
  $('#hud-timer').className = 'hud-timer';
  $('#hud-opp-name').textContent = state.oppName || '對手';
  $('#hud-opp-clicks').textContent = '0';
  $('#hud-opp-page').textContent = settings.showOpponentPage ? `在：${settings.start}` : '';
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
  $('#brief-start').textContent = settings.start;
  $('#brief-target').textContent = settings.target;
  show('game');

  // 先在背景載入起點條目，倒數結束時直接顯示
  const preload = wiki.fetchArticle(settings.lang, settings.start);
  preload.catch(() => {});

  const overlay = $('#countdown');
  const num = $('#countdown-num');
  overlay.hidden = false;
  const showNum = (txt, isGo) => {
    num.textContent = txt;
    num.classList.toggle('go', !!isGo);
    num.classList.remove('pop');
    void num.offsetWidth;
    num.classList.add('pop');
  };
  let n = 3;
  showNum(n);
  sfx.count();
  const iv = setInterval(() => {
    n--;
    if (n > 0) { showNum(n); sfx.count(); vibrate(40); return; }
    clearInterval(iv);
    showNum('GO!', true);
    sfx.go();
    vibrate([80, 40, 80]);
    flash('#3ddc84');
    setTimeout(() => { overlay.hidden = true; }, 450);
    const g = state.game;
    g.startAt = performance.now();
    g.timer = setInterval(tick, 200);
    goTo(settings.start, { first: true, preload });
  }, 1000);
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
  if (!limit) { timer.textContent = fmtTime(ms); return; }
  const left = limit - ms;
  timer.textContent = fmtTime(left);
  timer.classList.toggle('warn', left < 60000 && left >= 10000);
  timer.classList.toggle('crit', left < 10000);
  // 最後 10 秒每秒滴答
  const sec = Math.ceil(left / 1000);
  if (left < 10000 && sec !== g.lastSecond) { g.lastSecond = sec; sfx.tick(); vibrate(20); }
  if (left <= 0) finishGame('timeout');
}

async function goTo(title, { first = false, back = false, preload = null } = {}) {
  const g = state.game;
  if (!g || g.finished || g.loading) return;
  g.loading = true;
  $('#article-loading').hidden = false;
  if (!first) sfx.click();
  try {
    const art = await (preload || wiki.fetchArticle(g.settings.lang, title));
    if (g !== state.game || g.finished) return;
    if (!first) g.clicks++;
    if (g.current && !back) g.stack.push(g.current);
    g.current = art.title;
    g.path.push(art.title);
    renderArticle(art);
    $('#hud-clicks').textContent = g.clicks;
    fillPath($('#hud-path'), g.path, g.settings.target);
    $('#path-count').textContent = g.path.length;
    $('#btn-back').disabled = g.stack.length === 0;

    const reached = art.title === g.settings.target;
    const near = !reached && !!$('#article a.is-target');
    if (near && !g.near) { sfx.near(); vibrate(60); }
    g.near = near;
    $('#hud-alert-me').hidden = !near;
    $('#hud-alert-me').textContent = '🎯 終點連結就在這一頁！快找！';

    net.send({ t: 'progress', title: art.title, clicks: g.clicks, near });
    if (reached) finishGame('win');
  } catch (e) {
    toast(`載入失敗：${e.message}`);
  } finally {
    g.loading = false;
    $('#article-loading').hidden = true;
  }
}

function renderArticle(art) {
  const tmp = document.createElement('div');
  tmp.innerHTML = art.displayTitle || art.title;
  $('#article-title').textContent = tmp.textContent;

  const root = $('#article');
  root.innerHTML = art.html;
  root.querySelectorAll('.mw-editsection, .mw-empty-elt, script').forEach((el) => el.remove());
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
    if (confirm('確定要投降嗎？對手會直接獲勝。')) finishGame('giveup');
  };

  $('#btn-path').onclick = () => { $('#path-drawer').hidden = !$('#path-drawer').hidden; };
  $('#btn-path-close').onclick = () => { $('#path-drawer').hidden = true; };
}

function feed(parts) {
  const el = document.createElement('div');
  el.className = 'feed-item';
  for (const p of parts) {
    if (typeof p === 'string') el.append(p);
    else el.append(Object.assign(document.createElement('b'), { textContent: p.b }));
  }
  const box = $('#feed');
  // 放在 HUD 正下方，避免蓋住警告
  box.style.top = `${$('#hud').getBoundingClientRect().bottom + 8}px`;
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), 2700);
}

function setOppDanger(on) {
  const g = state.game;
  $('#hud').classList.toggle('danger', on);
  $('#hud-alert-opp').hidden = !on;
  $('#hud-alert-opp').textContent = `⚠️ ${state.oppName || '對手'} 只差一步就到終點！`;
  clearInterval(g.heart);
  g.heart = null;
  if (on) {
    sfx.alarm();
    vibrate([120, 60, 120, 60, 120]);
    g.heart = setInterval(() => sfx.heartbeat(), 900);
  }
}

function onOppProgress(msg) {
  const g = state.game;
  if (!g || g.opp.finished || g.finished) return;
  const moved = msg.clicks !== g.opp.clicks || msg.title !== g.opp.current;
  g.opp.clicks = msg.clicks;
  g.opp.current = msg.title;
  g.opp.path.push(msg.title);
  $('#hud-opp-clicks').textContent = msg.clicks;
  $('#hud-opp-page').textContent = g.settings.showOpponentPage ? `在：${msg.title}` : '';
  const near = !!msg.near;
  if (near !== g.opp.near) { g.opp.near = near; setOppDanger(near); }
  if (moved && g.startAt) {
    const racer = $('#hud-opp');
    racer.classList.remove('bump');
    void racer.offsetWidth;
    racer.classList.add('bump');
    sfx.oppMove();
    const name = state.oppName || '對手';
    feed(g.settings.showOpponentPage ? [{ b: name }, ` 衝到《${msg.title}》`] : [{ b: name }, ' 又前進了一步']);
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
  g.finished = { reason, elapsed: elapsed(), clicks: g.clicks, path: g.path.slice() };
  net.send({ t: 'finish', ...g.finished });
  $('#countdown').hidden = true;
  $('#path-drawer').hidden = true;
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

// 對手的結束訊息會決定我方的結果
function onOppFinish(msg) {
  const g = state.game;
  if (!g) return;
  g.opp.finished = msg;
  g.opp.clicks = msg.clicks;
  g.opp.path = msg.path || [];
  if (!g.finished) {
    if (msg.reason === 'win') finishGame('lose');
    else if (msg.reason === 'giveup') finishGame('oppGaveUp');
    else if (msg.reason === 'timeout') finishGame('timeout');
  } else if (state.view === 'result') {
    showResult(true);
  }
}

function outcome(g) {
  const me = g.finished;
  const opp = g.opp.finished;
  if (me.reason === 'win' && opp && opp.reason === 'win') {
    if (me.elapsed !== opp.elapsed) return me.elapsed < opp.elapsed ? 'win' : 'lose';
    return me.clicks === opp.clicks ? 'draw' : (me.clicks < opp.clicks ? 'win' : 'lose');
  }
  if (me.reason === 'win' || me.reason === 'oppGaveUp' || me.reason === 'oppLeft') return 'win';
  if (me.reason === 'lose' || me.reason === 'giveup') return 'lose';
  if (opp && opp.reason === 'win') return 'lose';
  return 'draw';
}

function describe(f, target) {
  if (!f) return '等待資料…';
  const time = fmtTime(f.elapsed);
  switch (f.reason) {
    case 'win': return `抵達終點 · ${f.clicks} 步 · ${time}`;
    case 'giveup': return `投降 · ${f.clicks} 步 · ${time}`;
    case 'timeout': return `時間到 · ${f.clicks} 步`;
    default: return `${f.clicks} 步 · ${time}${f.path?.at(-1) && f.path.at(-1) !== target ? ` · 停在《${f.path.at(-1)}》` : ''}`;
  }
}

let lastOutcome = null;
function showResult(update = false) {
  const g = state.game;
  const res = outcome(g);
  const map = {
    win: ['VICTORY', '你贏了！'],
    lose: ['DEFEAT', '你輸了…'],
    draw: ['DRAW', '平手！'],
  };
  const hero = $('#result-hero');
  hero.className = `result-hero ${res}`;
  $('#result-kicker').textContent = map[res][0];
  $('#result-title').textContent = map[res][1];
  let sub = `${g.settings.start} → ${g.settings.target}`;
  if (g.finished.reason === 'oppGaveUp') sub += '（對手投降）';
  if (g.finished.reason === 'oppLeft') sub += '（對手離線）';
  if (g.finished.reason === 'timeout') sub += '（時間到）';
  $('#result-sub').textContent = sub;

  $('#res-me-name').textContent = `${state.myName}（你）`;
  $('#res-me-stat').textContent = describe(g.finished, g.settings.target);
  fillPath($('#res-me-path'), g.finished.path, g.settings.target);
  $('#res-opp-name').textContent = state.oppName || '對手';
  $('#res-opp-stat').textContent = g.opp.left && !g.opp.finished ? '已離線' : describe(g.opp.finished, g.settings.target);
  fillPath($('#res-opp-path'), g.opp.path, g.settings.target);
  $('.result-card.me-side').classList.toggle('winner', res === 'win');
  $('.result-card.opp-side').classList.toggle('winner', res === 'lose');
  $('#btn-rematch').disabled = !net.connected;
  $('#btn-rematch').textContent = net.connected ? '再來一局' : '對手已離線';

  const changed = !update || res !== lastOutcome;
  lastOutcome = res;
  show('result');
  if (!changed) return;
  if (res === 'win') { sfx.win(); confetti(); vibrate([60, 40, 60, 40, 200]); }
  else if (res === 'lose') { sfx.lose(); shake(hero); vibrate(400); }
}

function initResult() {
  $('#btn-rematch').onclick = () => enterRoom(net.code);
}

// ---------- 連線訊息 ----------
net.onPeerJoin = () => {
  setConn('已連線', true);
};

net.onPeerLeave = () => {
  setConn('對手已離線');
  toast('對手已離線', 4000);
  const g = state.game;
  if (state.view === 'game' && g && !g.finished) {
    g.opp.left = true;
    finishGame('oppLeft');
    return;
  }
  if (g) g.opp.left = true;
  if (state.view === 'result') showResult(true);
  if (net.isHost) {
    state.oppName = '';
    state.guestReady = false;
    if (state.view === 'room') renderRoom();
  } else if (state.view === 'room') {
    show('home');
    showError('#home-error', '房主已離開房間');
  }
};

net.onMessage = (msg) => {
  switch (msg.t) {
    case 'join':
      if (!net.isHost) return;
      state.oppName = String(msg.name || '對手').slice(0, 16);
      state.guestReady = false;
      net.send({ t: 'welcome', name: state.myName, settings: readForm() });
      toast(`${state.oppName} 加入了房間`);
      sfx.near();
      vibrate(80);
      if (state.view === 'room') renderRoom();
      break;
    case 'welcome':
      state.oppName = String(msg.name || '房主').slice(0, 16);
      state.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      writeForm(state.settings);
      renderRoom();
      break;
    case 'full':
      net.destroy();
      show('home');
      setConn('');
      showError('#home-error', '這個房間已經滿了');
      break;
    case 'settings':
      if (net.isHost) return;
      state.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      writeForm(state.settings);
      if (state.guestReady) {
        state.guestReady = false;
        net.send({ t: 'ready', ready: false });
      }
      if (state.view === 'room') renderRoom();
      break;
    case 'ready':
      if (!net.isHost) return;
      state.guestReady = !!msg.ready;
      if (state.guestReady) sfx.near();
      if (state.view === 'room') renderRoom();
      break;
    case 'start':
      if (net.isHost) return;
      startGame({ ...DEFAULT_SETTINGS, ...msg.settings });
      break;
    case 'progress':
      onOppProgress(msg);
      break;
    case 'finish':
      onOppFinish(msg);
      break;
  }
};

window.addEventListener('beforeunload', (e) => {
  if (state.view === 'game' && state.game && !state.game.finished) e.preventDefault();
});

// 關閉分頁時主動斷線，讓對手立刻收到通知
window.addEventListener('pagehide', () => net.destroy());

initSound();
initHome();
initRoom();
initGame();
initResult();
show('home');
