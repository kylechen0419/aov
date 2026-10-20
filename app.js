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

function fillPath(ol, path, target) {
  ol.replaceChildren(...path.map((t) => {
    const li = document.createElement('li');
    li.textContent = tw(t);
    if (t === target) li.classList.add('hit');
    return li;
  }));
}

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
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlockAudio, { passive: true });
  // 每次點擊按鈕、選項都給一下觸覺與聲音回饋
  document.addEventListener('click', (e) => {
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

function renderStats() {
  const st = loadStats();
  const total = st.w + st.l + st.d;
  $('#stat-w').textContent = st.w;
  $('#stat-l').textContent = st.l;
  $('#stat-rate').textContent = total ? `${Math.round((st.w / total) * 100)}%` : '–';
  $('#stat-streak').textContent = st.streak;
}

// ---------- 首頁 ----------
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
  if (document.activeElement !== f.start) f.start.value = tw(s.start);
  if (document.activeElement !== f.target) f.target.value = tw(s.target);
  f.showOpponentPage.checked = s.showOpponentPage;
  f.allowBack.checked = s.allowBack;
  f.trueRandom.checked = s.trueRandom;
}

function renderRoom() {
  const host = net.isHost;
  const hostName = host ? state.myName : state.oppName;
  const guestName = host ? state.oppName : state.myName;
  const hasGuest = net.connected;

  $('#slot-host .avatar').textContent = initial(hostName);
  $('#slot-guest .avatar').textContent = hasGuest ? initial(guestName) : '?';
  $('#slot-host .pname').textContent = hostName || '—';
  $('#slot-host .pstate').textContent = '';
  $('#slot-guest .pname').textContent = hasGuest && guestName ? guestName : '等待對手加入…';
  $('#slot-guest .pstate').textContent = hasGuest ? (state.guestReady ? '✓ 已準備' : '尚未準備') : '';
  $('#slot-guest').classList.toggle('ready', hasGuest && state.guestReady);
  $('#slot-guest').classList.toggle('empty', !hasGuest);
  $('#slot-host').classList.toggle('is-me', host);
  $('#slot-guest').classList.toggle('is-me', !host);
  // 自己永遠是青色、對手永遠是洋紅
  $('#slot-host').classList.toggle('me-side', host);
  $('#slot-host').classList.toggle('opp-side', !host);
  $('#slot-guest').classList.toggle('me-side', !host);
  $('#slot-guest').classList.toggle('opp-side', host);

  for (const el of form().elements) if (!el.matches('#btn-ready, #btn-start')) el.disabled = !host;
  $('#host-only-hint').hidden = host;

  const ready = $('#btn-ready');
  ready.hidden = host;
  ready.textContent = state.guestReady ? '已準備 ✓（再按一次取消）' : '準備';
  ready.classList.toggle('is-ready', state.guestReady);
  $('#btn-start').hidden = !host;
  $('#btn-start').disabled = !(hasGuest && state.guestReady);

  let hint = '';
  if (host && !hasGuest) hint = '把房間代碼或邀請連結傳給朋友吧！';
  else if (host && !state.guestReady) hint = '等待對手按下「準備」…';
  else if (host) hint = '對手準備好了，按下開始！起點或終點留空會從題庫隨機抽。';
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
    if (navigator.share) {
      try {
        await navigator.share({ title: '維基競速', text: `來跟我比維基競速！房間代碼 ${net.code}`, url });
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
    state.guestReady = !state.guestReady;
    net.send({ t: 'ready', ready: state.guestReady });
    if (state.guestReady) { sfx.ready(); haptic('success'); }
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
    btn.textContent = '開始對局';
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
  $('#hud-target').textContent = tw(settings.target);
  $('#hud-clicks').textContent = '0';
  $('#hud-timer').textContent = settings.timeLimit ? fmtTime(settings.timeLimit * 1000) : '00:00';
  $('#hud-timer').className = 'hud-timer';
  $('#hud-opp-name').textContent = state.oppName || '對手';
  $('#hud-me-avatar').textContent = initial(state.myName);
  $('#hud-opp-avatar').textContent = initial(state.oppName);
  $('#hud-opp-clicks').textContent = '0';
  $('#hud-opp-page').textContent = settings.showOpponentPage ? `${state.oppName || '對手'} 在《${tw(settings.start)}》` : '';
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
  if (!limit) { timer.textContent = fmtTime(ms); updateIntensity(); return; }
  const left = limit - ms;
  timer.textContent = fmtTime(left);
  timer.classList.toggle('warn', left < 60000 && left >= 10000);
  timer.classList.toggle('crit', left < 10000);
  // 最後 10 秒每秒滴答
  const sec = Math.ceil(left / 1000);
  if (left < 10000 && sec !== g.lastSecond) { g.lastSecond = sec; sfx.tick(); haptic('light'); }
  updateIntensity(left);
  if (left <= 0) finishGame('timeout');
}

// 音樂隨局勢加快：對手接近終點或剩不到一分鐘時加速，最後 15 秒再加速
function updateIntensity(left = Infinity) {
  const g = state.game;
  let lvl = 0;
  if (g.opp.near || g.near || left < 60000) lvl = 1;
  if (left < 15000 || (g.opp.near && g.near)) lvl = 2;
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

    net.send({ t: 'progress', title: art.title, clicks: g.clicks, near });
    if (reached) finishGame('win');
  } catch (e) {
    toast(`載入失敗：${e.message}`);
  } finally {
    g.loading = false;
    $('#article-loading').hidden = true;
  }
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
    if (confirm('確定要投降嗎？對手會直接獲勝。')) finishGame('giveup');
  };

  $('#btn-path').onclick = () => { $('#path-drawer').hidden = !$('#path-drawer').hidden; };
  $('#btn-path-close').onclick = () => { $('#path-drawer').hidden = true; };
}

function feed(parts, step) {
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.append(Object.assign(document.createElement('span'), { className: 'feed-time', textContent: `第${step}步` }));
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
  $('#hud-alert-opp').textContent = `${state.oppName || '對手'} 只差一步就到終點！`;
  clearInterval(g.heart);
  g.heart = null;
  if (on) {
    sfx.alarm();
    haptic('warning');
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
  $('#hud-opp-page').textContent = g.settings.showOpponentPage ? `${state.oppName || '對手'} 在《${tw(msg.title)}》` : '';
  const near = !!msg.near;
  if (near !== g.opp.near) { g.opp.near = near; setOppDanger(near); updateIntensity(); }
  if (moved && g.startAt) {
    const racer = $('#hud-opp');
    racer.classList.remove('bump');
    void racer.offsetWidth;
    racer.classList.add('bump');
    sfx.oppMove();
    const name = state.oppName || '對手';
    feed(g.settings.showOpponentPage ? [{ b: name }, ` 前往《${tw(msg.title)}》`] : [{ b: name }, ' 又前進了一步'], msg.clicks);
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

function resultLabel(f) {
  if (!f) return '—';
  return {
    win: '抵達終點', lose: '未抵達', giveup: '投降', timeout: '時間到', oppGaveUp: '對手投降', oppLeft: '對手離線',
  }[f.reason] || '—';
}

let lastOutcome = null;
function showResult(update = false) {
  const g = state.game;
  const res = outcome(g);
  const map = {
    win: ['勝', '你贏了！'],
    lose: ['敗', '對手搶先一步…'],
    draw: ['和', '平手！'],
  };
  const hero = $('#result-hero');
  hero.className = `cover result-hero ${res}`;
  $('#result-kicker').textContent = map[res][0];
  $('#result-title').textContent = map[res][1];
  let sub = `《${tw(g.settings.start)}》→《${tw(g.settings.target)}》`;
  if (g.finished.reason === 'oppGaveUp') sub += '（對手投降）';
  if (g.finished.reason === 'oppLeft') sub += '（對手離線）';
  if (g.finished.reason === 'timeout') sub += '（時間到）';
  $('#result-sub').textContent = sub;

  const me = g.finished;
  const opp = g.opp.finished;
  $('#res-me-name').textContent = `${state.myName}（你）`;
  $('#res-me-avatar').textContent = initial(state.myName);
  $('#res-opp-avatar').textContent = initial(state.oppName);
  $('#res-opp-name').textContent = state.oppName || '對手';
  $('#res-opp-path-head').textContent = `${state.oppName || '對手'} 的路線`;
  $('#res-me-result').textContent = resultLabel(me);
  $('#res-opp-result').textContent = g.opp.left && !opp ? '離線' : resultLabel(opp);
  $('#res-me-result').classList.toggle('win', res === 'win');
  $('#res-opp-result').classList.toggle('win', res === 'lose');
  $('#res-me-steps').textContent = `${me.clicks} 步`;
  $('#res-opp-steps').textContent = opp ? `${opp.clicks} 步` : `${g.opp.clicks} 步`;
  $('#res-me-time').textContent = fmtTime(me.elapsed);
  $('#res-opp-time').textContent = opp ? fmtTime(opp.elapsed) : '—';
  fillPath($('#res-me-path'), me.path, g.settings.target);
  fillPath($('#res-opp-path'), g.opp.path, g.settings.target);
  $('#btn-rematch').disabled = !net.connected;
  $('#btn-rematch').textContent = net.connected ? '再來一局' : '對手已離線';

  const changed = !update || res !== lastOutcome;
  if (!g.recorded) { recordResult(res); g.recorded = res; }
  else if (g.recorded !== res) {
    // 雙方幾乎同時抵達時結果可能被更正，戰績也跟著更正
    const st = loadStats();
    if (g.recorded === 'win') { st.w--; st.streak = Math.max(0, st.streak - 1); } else if (g.recorded === 'lose') st.l--; else st.d--;
    store.set('wikirace-stats', JSON.stringify(st));
    recordResult(res);
    g.recorded = res;
  }
  lastOutcome = res;
  show('result');
  if (!changed) return;
  if (res === 'win') { sfx.win(); confetti(); haptic('success'); }
  else if (res === 'lose') { sfx.lose(); shake(hero); haptic('error'); }
  // 結算音效播完後回到大廳音樂
  setTimeout(() => { if (state.view === 'result') music.play('lobby'); }, 3500);
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
      sfx.ready();
      haptic('medium');
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
      if (state.view === 'room') renderRoom();
      break;
    case 'ready':
      if (!net.isHost) return;
      state.guestReady = !!msg.ready;
      if (state.guestReady) { sfx.ready(); haptic('medium'); }
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
