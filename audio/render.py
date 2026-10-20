# 離線合成背景音樂與音效，輸出 mp3（不在手機上即時合成，避免雜音）
import numpy as np, subprocess, os, sys, wave
SR = 44100
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)

def midi(n): return 440.0 * 2 ** ((n - 69) / 12)

def env_ad(n, a, d_tau):
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-6), np.exp(-(t - a) / d_tau))
    return e

def fade(x, fin=0.005, fout=0.02):
    n_in, n_out = int(fin * SR), int(fout * SR)
    if n_in: x[:n_in] *= np.linspace(0, 1, n_in)
    if n_out: x[-n_out:] *= np.linspace(1, 0, n_out)
    return x

def tone(freq, dur, partials=((1, 1.0),), a=0.006, tau=0.4, vib=0.0):
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.zeros(n)
    for mult, amp in partials:
        f = freq * mult
        if f > SR / 2.2: continue
        ph = 2 * np.pi * f * t
        if vib: ph += vib * np.sin(2 * np.pi * 5 * t)
        x += amp * np.sin(ph)
    return fade(x * env_ad(n, a, tau))

def piano(freq, dur=1.8, vel=1.0):
    # 柔和的鋼琴／鋼片琴：高次泛音衰減得比較快
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.zeros(n)
    for k, amp, tau in [(1, 1.0, 0.9), (2, 0.35, 0.5), (3, 0.12, 0.3), (4, 0.05, 0.2)]:
        x += amp * np.sin(2 * np.pi * freq * k * t) * np.exp(-t / tau)
    att = np.minimum(1, t / 0.006)
    return fade(x * att * vel)

def pad(freqs, dur, vol):
    n = int(dur * SR); t = np.arange(n) / SR
    x = sum(np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * f * 2.003 * t) for f in freqs)
    e = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    return x * e * vol

def bass(freq, dur, vol):
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) + 0.2 * np.sin(2 * np.pi * freq * 2 * t)
    return fade(x * np.minimum(1, t / 0.01) * np.exp(-t / (dur * 0.6)) * vol, 0.005, 0.03)

def kick(vol):
    n = int(0.28 * SR); t = np.arange(n) / SR
    f = 45 + 85 * np.exp(-t / 0.035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return fade(np.sin(ph) * np.exp(-t / 0.09) * vol, 0.001, 0.02)

def tick(vol, f=5200):
    # 用高頻正弦短音代替噪音做的鼓組，避免沙沙聲
    n = int(0.05 * SR); t = np.arange(n) / SR
    x = (np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 1.48 * t)) * np.exp(-t / 0.012)
    return fade(x * vol, 0.001, 0.005)

def pluck(freq, dur, vol, bright=6):
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.zeros(n)
    for k in range(1, bright + 1):
        x += (1 / k) * np.sin(2 * np.pi * freq * k * t) * np.exp(-t * (6 + k * 5))
    return fade(x * np.minimum(1, t / 0.003) * vol, 0.002, 0.01)

def place(buf, x, at):
    i = int(at * SR)
    j = min(len(buf), i + len(x))
    if i < len(buf): buf[i:j] += x[:j - i]

def reverb(x, mix=0.18):
    # 簡單的 Schroeder 殘響（離線計算，不影響手機效能）
    out = np.zeros_like(x)
    for d, g in [(1557, .77), (1617, .76), (1491, .75), (1422, .74)]:
        y = x.copy()
        for i in range(d, len(y), d):
            y[i:i + d] += g * y[i - d:i][:len(y[i:i + d])]
        out += y
    out /= 4
    for d, g in [(225, .5), (556, .5)]:
        y = np.zeros_like(out); buf = out
        y[:d] = -g * buf[:d]
        for i in range(d, len(buf)):
            y[i] = -g * buf[i] + buf[i - d] + g * y[i - d]
        out = y
    return x * (1 - mix) + out * mix

def loopify(x, length):
    # 把尾巴疊回開頭，讓循環接得起來
    n = int(length * SR)
    y = x[:n].copy()
    tail = x[n:]
    y[:len(tail)] += tail[:n]
    return y

def normalize(x, peak_db):
    p = np.max(np.abs(x)) or 1
    return x / p * 10 ** (peak_db / 20)

def write(name, x, br='96k'):
    x = np.clip(x, -1, 1)
    wav = os.path.join(OUT, name + '.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', br, os.path.join(OUT, name + '.mp3')], check=True)
    os.remove(wav)

# ---------- 大廳：輕快的鋼琴（D 大調，84 BPM） ----------
bpm = 84; beat = 60 / bpm; bar = beat * 4
prog = [(50, [62, 66, 69, 73]), (47, [59, 62, 66, 69]), (43, [59, 62, 67, 71]), (45, [61, 64, 69, 73])]
bars = 16
L = bars * bar
x = np.zeros(int((L + 4) * SR))
melody_patterns = [[0, 2, 1, 3, 2, 1, 3, 2], [3, 2, 1, 2, 0, 1, 2, 3], [0, 1, 2, 3, 3, 2, 1, 0], [2, 3, 1, 2, 0, 2, 1, 3]]
for b in range(bars):
    root, tones = prog[b % 4]
    t0 = b * bar
    place(x, bass(midi(root), bar * 0.95, 0.30), t0)
    place(x, bass(midi(root + 7), bar * 0.45, 0.12), t0 + beat * 2)
    place(x, pad([midi(n) for n in tones[:3]], bar, 0.035), t0)
    pat = melody_patterns[(b // 4) % 4]
    for s in range(8):
        if b % 8 == 7 and s >= 6: continue
        n = tones[pat[s]] + (12 if (b // 4) % 2 and s % 4 == 0 else 0)
        vel = 0.22 if s % 2 == 0 else 0.15
        place(x, piano(midi(n), 1.6, vel), t0 + s * beat / 2)
x = reverb(x, 0.22)
lobby = normalize(loopify(x, L), -11)
write('lobby', lobby, '80k')

# ---------- 比賽：有推進感的節奏（A 小調，120 BPM） ----------
bpm = 120; beat = 60 / bpm; bar = beat * 4; six = beat / 4
prog = [(45, [57, 60, 64, 69]), (41, [57, 60, 65, 69]), (38, [57, 62, 65, 69]), (40, [56, 59, 64, 68])]
bars = 16
L = bars * bar
x = np.zeros(int((L + 3) * SR))
arp = [0, 1, 2, 3, 2, 1, 2, 3]
for b in range(bars):
    root, tones = prog[b % 4]
    t0 = b * bar
    for s in range(16):
        t = t0 + s * six
        if s % 4 == 0: place(x, kick(0.55), t)
        if s % 4 == 2: place(x, tick(0.06), t)
        if s % 2 == 0: place(x, bass(midi(root + (12 if s % 8 == 6 else 0)), six * 1.8, 0.28), t)
        oct_up = 12 if b >= 8 and s % 8 == 0 else 0
        place(x, pluck(midi(tones[arp[s % 8]] + oct_up), six * 2.2, 0.09), t)
    if b % 2 == 1:
        place(x, piano(midi(tones[3] + 12), 0.9, 0.12), t0 + beat * 3)
x = reverb(x, 0.12)
race = normalize(loopify(x, L), -9)
write('race', race, '96k')

# ---------- 音效 ----------
def seq(notes, gap, **kw):
    out = np.zeros(int((gap * len(notes) + 1.2) * SR))
    for i, (n, dur) in enumerate(notes):
        place(out, tone(midi(n), dur, **kw), i * gap)
    nz = np.nonzero(np.abs(out) > 1e-4)[0]
    return out[:nz[-1] + int(0.05 * SR)] if len(nz) else out

bell = ((1, 1.0), (2, 0.3), (3, 0.08))
sfx = {
    'tap': tone(1320, 0.07, ((1, 1),), a=0.002, tau=0.025),
    'flip': seq([(84, 0.1), (91, 0.18)], 0.05, partials=bell, a=0.003, tau=0.06),
    'count': tone(midi(72), 0.35, bell, a=0.004, tau=0.15),
    'go': seq([(79, 0.15), (84, 0.6)], 0.11, partials=bell, a=0.004, tau=0.25),
    'opp': seq([(64, 0.12), (59, 0.2)], 0.08, partials=((1, 1), (2, .2)), a=0.004, tau=0.08),
    'tick': tone(midi(96), 0.06, ((1, 1),), a=0.001, tau=0.015),
    'heart': None,
    'alarm': seq([(81, .12), (76, .12)] * 3, 0.13, partials=((1, 1), (3, .15)), a=0.004, tau=0.08),
    'near': seq([(76, .15), (83, .4)], 0.1, partials=bell, a=0.004, tau=0.18),
    'ready': seq([(72, .12), (76, .12), (79, .35)], 0.08, partials=bell, a=0.004, tau=0.14),
    'win': seq([(72, .16), (76, .16), (79, .16), (84, .16), (88, 1.0)], 0.11, partials=bell, a=0.004, tau=0.35),
    'lose': seq([(67, .25), (66, .25), (65, .25), (60, .9)], 0.2, partials=((1, 1), (2, .25)), a=0.006, tau=0.35),
}
hb = np.zeros(int(0.6 * SR))
for i, f in enumerate([62, 55]):
    n = int(0.22 * SR); t = np.arange(n) / SR
    place(hb, fade(np.sin(2 * np.pi * f * t) * np.exp(-t / 0.06), 0.004, 0.02) * (1 if i == 0 else 0.8), i * 0.18)
sfx['heart'] = hb
levels = {'tap': -14, 'flip': -10, 'tick': -10, 'heart': -3, 'opp': -8}
for name, s in sfx.items():
    write('sfx-' + name, normalize(reverb(s, 0.1) if name in ('win', 'go', 'near', 'ready') else s, levels.get(name, -5)), '64k')
print('done')
