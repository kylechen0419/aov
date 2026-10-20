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
const SFX_NAMES = ['tap', 'flip', 'count', 'go', 'opp', 'tick', 'heart', 'alarm', 'near', 'ready', 'win', 'lose'];
const pools = {};
for (const name of SFX_NAMES) {
  const n = name === 'tap' || name === 'tick' || name === 'flip' ? 3 : 2;
  pools[name] = { els: Array.from({ length: n }, () => makeAudio(`audio/sfx-${name}.mp3`)), i: 0 };
}

function playSfx(name) {
  if (!prefs.sfx) return;
  const pool = pools[name];
  const a = pool.els[pool.i++ % pool.els.length];
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p) p.catch(() => {});
  } catch { /* 忽略 */ }
}

const tracks = { lobby: makeAudio('audio/lobby.mp3', true), race: makeAudio('audio/race.mp3', true) };

// iPhone 規定每個播放器都要在使用者點擊時先播過一次，之後才能自動播放
let unlocked = false;
export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  const all = [...Object.values(tracks), ...Object.values(pools).flatMap((p) => p.els)];
  for (const a of all) {
    if (a === tracks[music.mode] && prefs.music) continue;
    a.muted = true;
    const p = a.play();
    const reset = () => { a.pause(); a.currentTime = 0; a.muted = false; };
    if (p) p.then(reset, () => { a.muted = false; }); else reset();
  }
  if (music.mode) music.apply();
}

export const isSfxOn = () => prefs.sfx;
export const isMusicOn = () => prefs.music;
export function setSfxOn(v) { savePref('sfx', v); }
export function setMusicOn(v) { savePref('music', v); music.apply(); }

// ---------- 背景音樂 ----------
const RATES = [1, 1.12, 1.25];

export const music = {
  mode: null,
  intensity: 0,

  play(mode) {
    if (mode === this.mode) { this.apply(); return; }
    this.mode = mode;
    for (const [name, a] of Object.entries(tracks)) {
      if (name !== mode) { a.pause(); a.currentTime = 0; }
    }
    this.apply();
  },

  stop() { this.play(null); },

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
    if (!unlocked) return;
    const p = a.play();
    if (p) p.catch(() => {});
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
  tap: () => playSfx('tap'),
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
