// 音效、背景音樂、觸覺回饋與畫面特效
// 聲音全部是事先錄好的 mp3（由 audio/render.py 離線合成），用瀏覽器原生的 <audio> 播放。
// 不在手機上即時合成，避免 iPhone 上 WebAudio 出現雜音。

const prefs = { sfx: true, music: true };
try {
  prefs.sfx = localStorage.getItem('wikirace-sfx') !== '0';
  prefs.music = localStorage.getItem('wikirace-music') !== '0';
} catch { /* 忽略 */ }

function savePref(k, v) {
  prefs[k] = v;
  try { localStorage.setItem(`wikirace-${k}`, v ? '1' : '0'); } catch { /* 忽略 */ }
}

function makeAudio(src, loop = false) {
  const a = new Audio(src);
  a.preload = 'auto';
  a.loop = loop;
  a.playsInline = true;
  a.setAttribute('playsinline', '');
  return a;
}

// 每個音效準備幾個播放器，讓連續觸發時可以重疊
// 點擊音效可以自己選：蘋果風（預設）、鍵盤、泡泡
export const CLICK_SOUNDS = {
  tock: { name: '🍎 蘋果風', file: 'sfx-click-tock' },
  key: { name: '⌨️ 鍵盤', file: 'sfx-click' },
  pop: { name: '🫧 泡泡', file: 'sfx-click-pop' },
};
let clickChoice = 'tock';
try { const c = localStorage.getItem('wikirace-click'); if (CLICK_SOUNDS[c]) clickChoice = c; } catch { /* 忽略 */ }
export const getClickSound = () => clickChoice;
export function setClickSound(c) {
  if (!CLICK_SOUNDS[c]) return;
  clickChoice = c;
  try { localStorage.setItem('wikirace-click', c); } catch { /* 忽略 */ }
}

const SFX_NAMES = ['click-tock', 'click-key', 'click-pop', 'flip', 'count', 'go', 'opp', 'tick', 'heart', 'alarm', 'near', 'ready', 'win', 'lose'];
const pools = {};
for (const name of SFX_NAMES) {
  // 按鍵聲用 wav：mp3 開頭有一小段靜音，點下去會慢半拍
  const isClick = name.startsWith('click-');
  const src = isClick ? `audio/${CLICK_SOUNDS[name.slice(6)].file}.wav?v=5` : `audio/sfx-${name}.mp3`;
  const n = isClick ? 4 : name === 'tick' || name === 'flip' ? 3 : 2;
  pools[name] = { els: Array.from({ length: n }, () => makeAudio(src)), i: 0 };
}

// 低延遲播放：音效先解碼放在記憶體，用 Web Audio 播放，比 <audio> 快很多。
// 還不能用時（第一次點擊之前、或瀏覽器不支援）才退回 <audio>。
const AC = window.AudioContext || window.webkitAudioContext;
let ctx = null;
const buffers = {};
try {
  // iOS 17 以上：讓音效跟音樂一樣，不受靜音鍵影響
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
  if (AC) {
    ctx = new AC({ latencyHint: 'interactive' });
    for (const name of SFX_NAMES) {
      fetch(pools[name].els[0].src)
        .then((r) => r.arrayBuffer())
        .then((data) => new Promise((ok, bad) => ctx.decodeAudioData(data, ok, bad)))
        .then((buf) => { buffers[name] = buf; }, () => {});
    }
  }
} catch { ctx = null; }

// iPhone 切到背景回來後 Web Audio 會被暫停，每次點擊都順手叫醒
function wakeCtx() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}
for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, wakeCtx, { passive: true, capture: true });

const fastReady = (name) => !!(ctx && ctx.state === 'running' && buffers[name]);
// 現在播放按鍵聲會不會馬上有聲音（手指一按下就播的前提）
export const canClickNow = () => prefs.sfx && (fastReady(`click-${clickChoice}`) || unlocked);

function playSfx(name) {
  if (!prefs.sfx) return;
  if (fastReady(name)) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = buffers[name];
      src.connect(ctx.destination);
      src.start(0);
      return;
    } catch { /* 退回 <audio> */ }
  }
  const pool = pools[name];
  const a = pool.els[pool.i++ % pool.els.length];
  try {
    a.live = true;
    a.muted = false;
    a.currentTime = 0;
    const p = a.play();
    if (p) p.catch(() => {});
  } catch { /* 忽略 */ }
}

// ---------- 可以自選的背景音樂 ----------
// 大廳和比賽各自選一首：內建曲目，或玩家自己上傳的音樂檔（存在這支手機的瀏覽器裡）
export const MUSIC_CHOICES = {
  piano: { name: '輕快鋼琴', src: 'audio/lobby.mp3' },
  chip: { name: '8-bit 冒險', src: 'audio/chip.mp3' },
  lofi: { name: 'Lo-fi 放鬆', src: 'audio/lofi.mp3' },
  tense: { name: '緊張節奏', src: 'audio/race.mp3' },
  custom: { name: '我的音樂', src: null },
};
const DEFAULT_CHOICE = { lobby: 'piano', race: 'tense' };
const choice = {};
for (const slot of ['lobby', 'race']) {
  let c = null;
  try { c = localStorage.getItem(`wikirace-music-${slot}`); } catch { /* 忽略 */ }
  choice[slot] = MUSIC_CHOICES[c] ? c : DEFAULT_CHOICE[slot];
}

const tracks = { lobby: makeAudio(MUSIC_CHOICES[choice.lobby].src || '', true), race: makeAudio(MUSIC_CHOICES[choice.race].src || '', true) };

// 自己的音樂檔存在 IndexedDB
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('wikirace-music', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const customUrl = {};
export async function getCustomMusic(slot) {
  try { return await idbDo('readonly', (st) => st.get(slot)); } catch { return null; }
}

async function loadSlot(slot) {
  const a = tracks[slot];
  const c = choice[slot];
  let src = MUSIC_CHOICES[c].src;
  if (c === 'custom') {
    const rec = await getCustomMusic(slot);
    if (rec?.blob) {
      if (customUrl[slot]) URL.revokeObjectURL(customUrl[slot]);
      customUrl[slot] = URL.createObjectURL(rec.blob);
      src = customUrl[slot];
    } else {
      src = MUSIC_CHOICES[DEFAULT_CHOICE[slot]].src;
    }
  }
  if (a.getAttribute('src') !== src) {
    a.src = src;
    a.load();
  }
  if (music.mode === slot) music.apply();
}
if (choice.lobby === 'custom') loadSlot('lobby');
if (choice.race === 'custom') loadSlot('race');

export const getMusicChoice = (slot) => choice[slot];
export async function setMusicChoice(slot, c) {
  if (!MUSIC_CHOICES[c]) return;
  choice[slot] = c;
  try { localStorage.setItem(`wikirace-music-${slot}`, c); } catch { /* 忽略 */ }
  await loadSlot(slot);
}
export async function saveCustomMusic(slot, file) {
  await idbDo('readwrite', (st) => st.put({ blob: file, name: file.name }, slot));
  await setMusicChoice(slot, 'custom');
}

// iPhone 規定每個播放器都要在使用者點擊時先播過一次，之後才能自動播放
let unlocked = false;
export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  const all = [...Object.values(tracks), ...Object.values(pools).flatMap((p) => p.els)];
  for (const a of all) {
    if (a === tracks[music.mode] && prefs.music) continue;
    if (a.live) continue;
    a.muted = true;
    const p = a.play();
    // 解鎖的同一下點擊如果已經在播按鍵聲，就不要把它停掉
    const reset = () => { if (!a.live) { a.pause(); a.currentTime = 0; } a.muted = false; };
    if (p) p.then(reset, () => { a.muted = false; }); else reset();
  }
  if (music.mode) music.apply();
}

export const isSfxOn = () => prefs.sfx;
export const isMusicOn = () => prefs.music;
export function setSfxOn(v) { savePref('sfx', v); }
export function setMusicOn(v) { savePref('music', v); music.apply(); }

// ---------- 背景音樂 ----------
const notify = (name) => document.dispatchEvent(new CustomEvent(name));

const RATES = [1, 1.12, 1.25];

export const music = {
  mode: null,
  intensity: 0,

  play(mode) {
    clearTimeout(this.previewTimer);
    if (mode === this.mode) { this.apply(); return; }
    this.mode = mode;
    for (const [name, a] of Object.entries(tracks)) {
      if (name !== mode) { a.pause(); a.currentTime = 0; }
    }
    this.apply();
  },

  stop() { this.play(null); },

  // 試聽：在大廳也能先聽聽比賽音樂，幾秒後回到原本的音樂
  preview(slot, ms = 8000) {
    const back = this.mode;
    if (slot === back) { this.apply(); return; }
    this.play(slot);
    this.previewTimer = setTimeout(() => { if (this.mode === slot) this.play(back); }, ms);
  },

  setIntensity(n) {
    this.intensity = n;
    const a = tracks.race;
    const rate = RATES[n] || 1;
    if (a.playbackRate !== rate) {
      a.preservesPitch = true;
      a.webkitPreservesPitch = true;
      a.playbackRate = rate;
    }
  },

  apply() {
    const a = this.mode && tracks[this.mode];
    for (const t of Object.values(tracks)) if (t !== a) t.pause();
    if (!a) return;
    if (!prefs.music) { a.pause(); return; }
    // 還沒點過畫面也先試著播放；被瀏覽器擋下就通知畫面顯示提示，等第一次點擊再播
    const p = a.play();
    if (p) p.then(() => notify('music-playing'), () => { if (!unlocked) notify('music-blocked'); });
    else notify('music-playing');
  },
};

// 回到分頁時恢復音樂，離開時暫停
document.addEventListener('visibilitychange', () => {
  if (document.hidden) for (const t of Object.values(tracks)) t.pause();
  else music.apply();
});

// ---------- 音效 ----------
export const sfx = {
  count: () => playSfx('count'),
  go: () => playSfx('go'),
  click: () => playSfx('flip'),
  tap: () => playSfx(`click-${clickChoice}`),
  oppMove: () => playSfx('opp'),
  tick: () => playSfx('tick'),
  heartbeat: () => playSfx('heart'),
  alarm: () => playSfx('alarm'),
  near: () => playSfx('near'),
  ready: () => playSfx('ready'),
  win: () => playSfx('win'),
  lose: () => playSfx('lose'),
};

// ---------- 觸覺回饋 ----------
// Android 用 navigator.vibrate；iPhone（iOS 18 以上的 Safari）用切換開關元件觸發系統觸覺
let iosSwitch = null;
let ticking = false;
function iosTick() {
  if (ticking) return;
  ticking = true;
  try { iosTickInner(); } finally { ticking = false; }
}
function iosTickInner() {
  if (!iosSwitch) {
    const id = 'haptic-switch';
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', id });
    input.setAttribute('switch', '');
    const label = Object.assign(document.createElement('label'), { htmlFor: id });
    const wrap = document.createElement('div');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.dataset.haptic = '';
    wrap.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    wrap.append(input, label);
    document.body.append(wrap);
    iosSwitch = label;
  }
  iosSwitch.click();
}

const PATTERNS = {
  light: [12],
  medium: [25],
  heavy: [45],
  success: [30, 60, 30, 60, 90],
  warning: [80, 50, 80, 50, 80],
  error: [250],
  countdown: [35],
  go: [60, 40, 120],
};

export function haptic(kind = 'light') {
  const pattern = PATTERNS[kind] || PATTERNS.light;
  try {
    // 瀏覽器規定使用者點過畫面之後才能震動
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    if (navigator.vibrate) { navigator.vibrate(pattern); return; }
    // iOS 只有單次輕觸，用多次輕觸模擬節奏
    const pulses = Math.ceil(pattern.length / 2);
    for (let i = 0; i < pulses; i++) setTimeout(iosTick, i * 120);
  } catch { /* 不支援就略過 */ }
}

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---------- 畫面特效 ----------
export function flash(color) {
  const el = document.getElementById('flash');
  el.style.setProperty('--flash', color);
  el.hidden = false;
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
  setTimeout(() => { el.hidden = true; }, 600);
}

export function shake(el) {
  if (reduceMotion()) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

// 勝利時灑下知識符號
export function confetti() {
  if (reduceMotion()) return;
  const canvas = document.getElementById('confetti');
  const c = canvas.getContext('2d');
  canvas.hidden = false;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  c.scale(dpr, dpr);
  const glyphs = ['知', '識', '文', '史', '典', 'Ω', 'π', '∑', '∞', 'Æ', 'W', '¶', '§', '★', '?', '√'];
  const colors = ['#ffd23f', '#2f7bff', '#ff4d6d', '#22c55e', '#ff5ca8', '#8b5cf6'];
  const bits = Array.from({ length: 90 }, () => ({
    x: Math.random() * innerWidth,
    y: -20 - Math.random() * innerHeight * 0.6,
    vy: 2 + Math.random() * 3,
    vx: (Math.random() - 0.5) * 1.2,
    r: (Math.random() - 0.5) * 0.6,
    vr: (Math.random() - 0.5) * 0.05,
    size: 16 + Math.random() * 18,
    g: glyphs[Math.floor(Math.random() * glyphs.length)],
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    c.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.y += b.vy; b.x += b.vx + Math.sin((now + b.size * 50) / 400) * 0.6; b.r += b.vr;
      c.save(); c.translate(b.x, b.y); c.rotate(b.r);
      c.font = `900 ${b.size}px "Noto Sans TC", system-ui, sans-serif`;
      c.fillStyle = b.color; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(b.g, 0, 0);
      c.restore();
    }
    if (now - start < 4200) requestAnimationFrame(frame);
    else { canvas.hidden = true; c.setTransform(1, 0, 0, 1, 0, 0); }
  })(start);
}
