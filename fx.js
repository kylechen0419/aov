// 音效、背景音樂（WebAudio 即時合成，不需要音檔）、觸覺回饋與畫面特效
let ctx = null;
let master, sfxBus, musicBus, reverb;

const prefs = { sfx: true, music: true };
try {
  prefs.sfx = localStorage.getItem('wikirace-sfx') !== '0';
  prefs.music = localStorage.getItem('wikirace-music') !== '0';
} catch { /* 忽略 */ }

function savePref(k, v) {
  prefs[k] = v;
  try { localStorage.setItem(`wikirace-${k}`, v ? '1' : '0'); } catch { /* 忽略 */ }
}

function makeImpulse(seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
  }
  return buf;
}

// 瀏覽器規定要在使用者操作後才能播放聲音
export function unlockAudio() {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(ctx.destination);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = prefs.sfx ? 1 : 0;
      sfxBus.connect(master);
      musicBus = ctx.createGain();
      musicBus.gain.value = prefs.music ? MUSIC_VOL : 0;
      musicBus.connect(master);
      // 輕量的回音（延遲線），取代吃效能的摺積殘響，避免手機上爆音
      reverb = ctx.createDelay(1);
      reverb.delayTime.value = 0.32;
      const fb = ctx.createGain();
      fb.gain.value = 0.28;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 2200;
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      reverb.connect(damp).connect(fb).connect(reverb);
      damp.connect(wet).connect(musicBus);
    }
    if (ctx.state === 'suspended') ctx.resume();
    if (music.pending) music.play(music.pending);
  } catch { /* 不支援就安靜 */ }
}

const MUSIC_VOL = 0.5;

export const isSfxOn = () => prefs.sfx;
export const isMusicOn = () => prefs.music;
export function setSfxOn(v) {
  savePref('sfx', v);
  if (sfxBus) sfxBus.gain.setTargetAtTime(v ? 1 : 0, ctx.currentTime, 0.05);
}
export function setMusicOn(v) {
  savePref('music', v);
  if (musicBus) musicBus.gain.setTargetAtTime(v ? MUSIC_VOL : 0, ctx.currentTime, 0.2);
}

// ---------- 音色 ----------
function env(gain, t, a, peak, d) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + a);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function tone(freq, dur, { type = 'square', vol = 0.06, at = 0, to = null, bus = sfxBus } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  env(gain, t, 0.005, vol, dur);
  osc.connect(gain).connect(bus);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// 柔和的音色：只用正弦／三角波，起音與收尾都有斜坡，避免爆音
function softEnv(gain, t, a, peak, len) {
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + a);
  gain.gain.setTargetAtTime(0, t + a, len / 4);
}

// 像鋼片琴的音色
function bell(t, note, vol, len = 1.6) {
  const f = midi(note);
  const g = ctx.createGain();
  softEnv(g, t, 0.012, vol, len);
  g.connect(musicBus);
  g.connect(reverb);
  for (const [mult, amp] of [[1, 1], [2, 0.18], [4, 0.04]]) {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f * mult;
    og.gain.value = amp;
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + len + 0.3);
  }
}

function pad(t, notes, vol, len) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + len * 0.4);
  g.gain.linearRampToValueAtTime(0, t + len);
  g.connect(musicBus);
  for (const n of notes) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = midi(n);
    o.connect(g);
    o.start(t);
    o.stop(t + len + 0.05);
  }
}

function bass(t, note, vol, len) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = midi(note);
  softEnv(g, t, 0.015, vol, len);
  o.connect(g).connect(musicBus);
  o.start(t);
  o.stop(t + len + 0.3);
}

function pluck(t, note, vol, len, cutoff) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  o.type = 'triangle';
  o.frequency.value = midi(note);
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(cutoff, t);
  lp.frequency.exponentialRampToValueAtTime(300, t + len);
  env(g, t, 0.003, vol, len);
  o.connect(lp).connect(g).connect(musicBus);
  g.connect(reverb);
  o.start(t);
  o.stop(t + len + 0.05);
}

let noiseBuf = null;
function hat(t, vol) {
  noiseBuf ||= makeImpulse(0.08, 1);
  const s = ctx.createBufferSource();
  const hp = ctx.createBiquadFilter();
  const g = ctx.createGain();
  s.buffer = noiseBuf;
  hp.type = 'highpass';
  hp.frequency.value = 7000;
  env(g, t, 0.001, vol, 0.05);
  s.connect(hp).connect(g).connect(musicBus);
  s.start(t);
}

function kick(t, vol) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.15);
  env(g, t, 0.002, vol, 0.2);
  o.connect(g).connect(musicBus);
  o.start(t);
  o.stop(t + 0.25);
}

// ---------- 背景音樂 ----------
// 大廳：慢板、明亮的大調，像在圖書館翻書
const LOBBY = {
  bpm: 76,
  chords: [
    { root: 50, tones: [62, 66, 69, 73] }, // Dmaj7
    { root: 47, tones: [59, 62, 66, 69] }, // Bm7
    { root: 43, tones: [59, 62, 67, 71] }, // Gmaj7
    { root: 45, tones: [61, 64, 69, 71] }, // A6sus
  ],
};
// 比賽：小調、十六分音符推進
const RACE = {
  chords: [
    { root: 45, tones: [57, 60, 64, 69] }, // Am
    { root: 41, tones: [57, 60, 65, 69] }, // F
    { root: 38, tones: [57, 62, 65, 69] }, // Dm
    { root: 40, tones: [56, 59, 64, 68] }, // E
  ],
};

export const music = {
  mode: null,
  pending: null,
  intensity: 0,
  step: 0,
  nextTime: 0,
  timer: null,

  play(mode) {
    if (!ctx || ctx.state !== 'running') { this.pending = mode; return; }
    this.pending = null;
    if (mode === this.mode) return;
    this.mode = mode;
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.1;
    clearInterval(this.timer);
    this.timer = mode ? setInterval(() => this.schedule(), 60) : null;
  },

  stop() { this.play(null); this.pending = null; },

  setIntensity(n) { this.intensity = n; },

  bpm() {
    if (this.mode === 'lobby') return LOBBY.bpm;
    return [116, 132, 148][this.intensity] || 116;
  },

  schedule() {
    // 若分頁曾被暫停，跳過落後的音符，不要一次全部擠出來
    if (this.nextTime < ctx.currentTime - 0.1) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + 0.3) {
      if (prefs.music) {
        if (this.mode === 'lobby') this.lobbyStep(this.nextTime, this.step);
        else if (this.mode === 'race') this.raceStep(this.nextTime, this.step);
      }
      this.nextTime += 60 / this.bpm() / (this.mode === 'lobby' ? 2 : 4);
      this.step++;
    }
  },

  // 每格是八分音符，一小節 8 格
  lobbyStep(t, s) {
    const bar = Math.floor(s / 8) % LOBBY.chords.length;
    const pos = s % 8;
    const c = LOBBY.chords[bar];
    if (pos === 0) {
      bass(t, c.root, 0.1, 2.4);
      pad(t, c.tones.slice(0, 3), 0.012, 60 / LOBBY.bpm * 4);
    }
    const pattern = [0, 2, 1, 3, 2, 1, 3, 2];
    if (pos !== 7 || Math.random() < 0.5) {
      const n = c.tones[pattern[pos]] + (Math.random() < 0.15 ? 12 : 0);
      bell(t, n, 0.045 + Math.random() * 0.015);
    }
  },

  // 每格是十六分音符，一小節 16 格
  raceStep(t, s) {
    const bar = Math.floor(s / 16) % RACE.chords.length;
    const pos = s % 16;
    const c = RACE.chords[bar];
    const lvl = this.intensity;
    if (pos % 4 === 0) kick(t, lvl ? 0.5 : 0.35);
    if (pos % 4 === 2) hat(t, 0.06 + lvl * 0.02);
    if (lvl >= 1 && pos % 2 === 1) hat(t, 0.03);
    if (pos % 2 === 0) bass(t, c.root + (pos % 8 === 6 ? 12 : 0), 0.14, 0.14);
    const arp = [0, 1, 2, 3, 2, 1, 2, 3];
    pluck(t, c.tones[arp[pos % 8]] + (lvl >= 2 ? 12 : 0), 0.04, 0.12, 2200 + lvl * 1200);
    if (lvl >= 1 && pos % 8 === 0) bell(t, c.tones[3] + 12, 0.035, 0.6);
  },
};

// ---------- 音效 ----------
export const sfx = {
  count: () => tone(523, 0.18, { type: 'triangle', vol: 0.12 }),
  go: () => { tone(784, 0.12, { type: 'triangle', vol: 0.12 }); tone(1047, 0.4, { type: 'triangle', vol: 0.12, at: 0.1 }); },
  // 翻頁聲
  click: () => {
    if (!ctx) return;
    noiseBuf ||= makeImpulse(0.08, 1);
    const s = ctx.createBufferSource();
    const bp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const t = ctx.currentTime;
    s.buffer = makeImpulse(0.12, 2);
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, t);
    bp.frequency.exponentialRampToValueAtTime(4500, t + 0.1);
    env(g, t, 0.005, 0.5, 0.12);
    s.connect(bp).connect(g).connect(sfxBus);
    s.start(t);
  },
  tap: () => tone(880, 0.04, { type: 'sine', vol: 0.05 }),
  oppMove: () => tone(330, 0.12, { type: 'triangle', vol: 0.07, to: 247 }),
  tick: () => tone(1200, 0.04, { type: 'square', vol: 0.04 }),
  heartbeat: () => { tone(70, 0.12, { type: 'sine', vol: 0.4 }); tone(60, 0.14, { type: 'sine', vol: 0.32, at: 0.18 }); },
  alarm: () => { for (let i = 0; i < 3; i++) { tone(880, 0.12, { type: 'sawtooth', vol: 0.05, at: i * 0.2 }); tone(660, 0.08, { type: 'sawtooth', vol: 0.05, at: i * 0.2 + 0.1 }); } },
  near: () => { tone(659, 0.12, { type: 'triangle', vol: 0.1 }); tone(988, 0.25, { type: 'triangle', vol: 0.1, at: 0.1 }); },
  ready: () => { tone(523, 0.1, { type: 'triangle', vol: 0.09 }); tone(659, 0.1, { type: 'triangle', vol: 0.09, at: 0.08 }); tone(784, 0.2, { type: 'triangle', vol: 0.09, at: 0.16 }); },
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i === 4 ? 0.8 : 0.16, { type: 'triangle', vol: 0.12, at: i * 0.11 })),
  lose: () => [392, 370, 349, 262].forEach((f, i) => tone(f, i === 3 ? 0.8 : 0.25, { type: 'sawtooth', vol: 0.05, at: i * 0.22 })),
};

// ---------- 觸覺回饋 ----------
// Android 用 navigator.vibrate；iPhone（iOS 18 以上的 Safari）用切換開關元件觸發系統觸覺
let iosSwitch = null;
function iosTick() {
  if (!iosSwitch) {
    const id = 'haptic-switch';
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', id });
    input.setAttribute('switch', '');
    const label = Object.assign(document.createElement('label'), { htmlFor: id });
    const wrap = document.createElement('div');
    wrap.setAttribute('aria-hidden', 'true');
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
  const colors = ['#3366cc', '#ac6600', '#14866d', '#d73333', '#202122'];
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
      c.font = `700 ${b.size}px "Noto Serif TC", Georgia, serif`;
      c.fillStyle = b.color; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(b.g, 0, 0);
      c.restore();
    }
    if (now - start < 4200) requestAnimationFrame(frame);
    else { canvas.hidden = true; c.setTransform(1, 0, 0, 1, 0, 0); }
  })(start);
}
