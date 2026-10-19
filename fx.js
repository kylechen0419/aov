// 音效（WebAudio 合成，不需要音檔）與畫面特效
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('wikirace-muted') === '1'; } catch { /* 忽略 */ }

// 瀏覽器規定要在使用者操作後才能播放聲音
export function unlockAudio() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* 不支援就安靜 */ }
}

export function isMuted() { return muted; }
export function setMuted(v) {
  muted = v;
  try { localStorage.setItem('wikirace-muted', v ? '1' : '0'); } catch { /* 忽略 */ }
}

function tone(freq, dur, { type = 'square', vol = 0.06, at = 0, to = null } = {}) {
  if (muted || !ctx) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  count: () => tone(440, 0.18),
  go: () => { tone(880, 0.12); tone(1320, 0.35, { at: 0.1 }); },
  click: () => tone(660, 0.05, { type: 'triangle', vol: 0.05, to: 990 }),
  oppMove: () => tone(220, 0.09, { type: 'sawtooth', vol: 0.035, to: 160 }),
  tick: () => tone(1000, 0.04, { type: 'square', vol: 0.04 }),
  heartbeat: () => { tone(70, 0.12, { type: 'sine', vol: 0.35 }); tone(60, 0.14, { type: 'sine', vol: 0.28, at: 0.18 }); },
  alarm: () => { for (let i = 0; i < 3; i++) { tone(880, 0.12, { type: 'sawtooth', vol: 0.05, at: i * 0.2 }); tone(660, 0.08, { type: 'sawtooth', vol: 0.05, at: i * 0.2 + 0.1 }); } },
  near: () => { tone(523, 0.1, { type: 'triangle', at: 0 }); tone(784, 0.18, { type: 'triangle', at: 0.1 }); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i === 3 ? 0.5 : 0.14, { type: 'square', vol: 0.06, at: i * 0.12 })),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, i === 3 ? 0.6 : 0.2, { type: 'sawtooth', vol: 0.05, at: i * 0.18 })),
};

export function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* iOS 不支援 */ }
}

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// 全螢幕閃光
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

// 勝利彩帶
export function confetti() {
  if (reduceMotion()) return;
  const canvas = document.getElementById('confetti');
  const c = canvas.getContext('2d');
  canvas.hidden = false;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  c.scale(dpr, dpr);
  const colors = ['#ffc53d', '#22d3ee', '#ff4d6d', '#3ddc84', '#ffffff'];
  const bits = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 14 - 4,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    w: 6 + Math.random() * 6,
    h: 3 + Math.random() * 4,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    c.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.35; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      c.save(); c.translate(b.x, b.y); c.rotate(b.r);
      c.fillStyle = b.color; c.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      c.restore();
    }
    if (now - start < 3500) requestAnimationFrame(frame);
    else { canvas.hidden = true; c.setTransform(1, 0, 0, 1, 0, 0); }
  })(start);
}
