// 產生戰績分享圖（1080×1350，適合 LINE 與限時動態）
const W = 1080;
const H = 1350;
const INK = '#2b2160';

function loadImg(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// 超出寬度就加上省略號
function fit(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return text;
  const chars = Array.from(text);
  while (chars.length && c.measureText(chars.join('') + '…').width > maxW) chars.pop();
  return chars.join('') + '…';
}

function font(weight, size) {
  return `${weight} ${size}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif`;
}

function strokeText(c, text, x, y, stroke, lw) {
  c.lineJoin = 'round';
  c.lineWidth = lw;
  c.strokeStyle = stroke;
  c.strokeText(text, x, y);
  c.fillText(text, x, y);
}

function drawAvatar(c, img, p, x, y, r, ring) {
  c.save();
  c.beginPath();
  c.arc(x, y, r + 6, 0, Math.PI * 2);
  c.fillStyle = '#fff';
  c.fill();
  if (ring) {
    c.lineWidth = 6;
    c.strokeStyle = ring;
    c.beginPath();
    c.arc(x, y, r + 9, 0, Math.PI * 2);
    c.stroke();
  }
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.clip();
  if (img) {
    c.drawImage(img, x - r, y - r, r * 2, r * 2);
  } else {
    c.fillStyle = p.color || '#2f7bff';
    c.fillRect(x - r, y - r, r * 2, r * 2);
    c.fillStyle = '#fff';
    c.font = font(900, r);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(Array.from(p.name || '?')[0] || '?', x, y + r * 0.05);
  }
  c.restore();
}

function chip(c, text, x, y, bg, fg) {
  c.font = font(900, 34);
  const w = c.measureText(text).width + 44;
  rr(c, x, y, w, 60, 30);
  c.fillStyle = bg;
  c.fill();
  c.fillStyle = fg;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText(text, x + 22, y + 31);
  return w;
}

// 路線太長時只留頭尾
function shortRoute(path, max = 7) {
  if (path.length <= max) return path;
  return [...path.slice(0, 3), '…', ...path.slice(-3)];
}

/**
 * data: {
 *   mode: 'duel'|'party', kicker, title, tone: 'win'|'lose'|'place'|'draw',
 *   start, target, url,
 *   me: { name, avatar, color, steps, time, result, path },
 *   opp?: { name, avatar, color, steps, time, result },
 *   ranking?: [{ place, name, avatar, color, stat, me }]
 * }
 */
export async function makeShareImage(data) {
  try { await document.fonts?.ready; } catch { /* 字型沒載入就用系統字 */ }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d');

  // 背景：跟遊戲一樣的漸層天空與圓點
  const bg = c.createLinearGradient(0, 0, W * 0.6, H);
  bg.addColorStop(0, '#5b3df5');
  bg.addColorStop(0.5, '#3b6cf6');
  bg.addColorStop(1, '#19b3f0');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(255,255,255,.12)';
  for (let y = 22; y < H; y += 44) for (let x = 22; x < W; x += 44) { c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fill(); }

  // 標題列
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillStyle = '#fff';
  c.font = font(900, 60);
  strokeText(c, '維基競速', 64, 86, '#2a1d9e', 10);
  const modeText = data.mode === 'party' ? '派對模式' : '1 對 1 對決';
  c.font = font(900, 32);
  const mw = c.measureText(modeText).width + 44;
  rr(c, W - 64 - mw, 58, mw, 58, 29);
  c.fillStyle = '#ffd23f';
  c.fill();
  c.fillStyle = '#5b3a00';
  c.textAlign = 'center';
  c.fillText(modeText, W - 64 - mw / 2, 88);

  // 獎章
  const mx = W / 2;
  const my = 262;
  const tones = {
    win: ['#fff6c2', '#ffd23f', '#e6a100', '#5b3a00'],
    place: ['#ffffff', '#cfd8e8', '#8f9bb5', '#3e4a63'],
    draw: ['#ffffff', '#cfd6e6', '#98a2bd', '#3e4a63'],
    lose: ['#ffd0d8', '#ff4d6d', '#d22d4f', '#ffffff'],
  };
  const [t1, t2, t3, tInk] = tones[data.tone] || tones.win;
  c.beginPath();
  c.arc(mx, my, 132, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,.25)';
  c.fill();
  const mg = c.createRadialGradient(mx - 36, my - 44, 10, mx, my, 114);
  mg.addColorStop(0, t1);
  mg.addColorStop(0.5, t2);
  mg.addColorStop(1, t3);
  c.beginPath();
  c.arc(mx, my, 112, 0, Math.PI * 2);
  c.fillStyle = mg;
  c.fill();
  c.lineWidth = 10;
  c.strokeStyle = '#fff';
  c.stroke();
  c.fillStyle = tInk;
  c.font = font(900, String(data.kicker).length > 1 ? 104 : 130);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(data.kicker, mx, my + 8);

  // 標題與路線
  c.fillStyle = '#fff';
  c.font = font(900, 76);
  strokeText(c, fit(c, data.title, W - 120), mx, 452, '#2a1d9e', 12);
  c.font = font(700, 40);
  c.fillStyle = 'rgba(255,255,255,.95)';
  c.fillText(fit(c, `《${data.start}》 → 《${data.target}》`, W - 120), mx, 528);

  // 白色卡片
  const cx = 56;
  const cy = 584;
  const cw = W - 112;
  const ch = 646;
  c.save();
  c.shadowColor = 'rgba(30,20,90,.25)';
  c.shadowBlur = 40;
  c.shadowOffsetY = 12;
  rr(c, cx, cy, cw, ch, 48);
  c.fillStyle = '#fff';
  c.fill();
  c.restore();

  const meImg = await loadImg(data.me.avatar ? `avatars/${data.me.avatar}.svg` : null);

  if (data.mode === 'party' && data.ranking?.length) {
    c.textAlign = 'left';
    c.fillStyle = INK;
    c.font = font(900, 44);
    c.fillText('排行榜', cx + 48, cy + 70);
    const rows = data.ranking.slice(0, 5);
    const imgs = await Promise.all(rows.map((r) => loadImg(r.avatar ? `avatars/${r.avatar}.svg` : null)));
    rows.forEach((r, i) => {
      const y = cy + 140 + i * 84;
      if (r.me) {
        rr(c, cx + 28, y - 38, cw - 56, 76, 24);
        c.fillStyle = '#e6efff';
        c.fill();
      }
      const badge = { 1: ['#ffd23f', '#5b3a00'], 2: ['#dfe5ef', '#4b5872'], 3: ['#f4c9a0', '#7a4313'] }[r.place] || ['#ece9f8', '#8a84a8'];
      c.beginPath();
      c.arc(cx + 84, y, 26, 0, Math.PI * 2);
      c.fillStyle = badge[0];
      c.fill();
      c.fillStyle = badge[1];
      c.font = font(900, 30);
      c.textAlign = 'center';
      c.fillText(r.place ? String(r.place) : '–', cx + 84, y + 2);
      drawAvatar(c, imgs[i], r, cx + 164, y, 28, r.color);
      c.textAlign = 'left';
      c.fillStyle = INK;
      c.font = font(900, 36);
      c.fillText(fit(c, r.me ? `${r.name}（你）` : r.name, 360), cx + 214, y + 2);
      c.textAlign = 'right';
      c.fillStyle = '#8a84a8';
      c.font = font(700, 30);
      c.fillText(fit(c, r.stat, 330), cx + cw - 48, y + 2);
    });
  } else {
    // 對決：我的資料、對手、路線
    drawAvatar(c, meImg, data.me, cx + 110, cy + 110, 58, data.me.color || '#2f7bff');
    c.textAlign = 'left';
    c.fillStyle = INK;
    c.font = font(900, 50);
    c.fillText(fit(c, data.me.name, cw - 260), cx + 200, cy + 86);
    let x = cx + 200;
    x += chip(c, `${data.me.steps} 步`, x, cy + 120, '#e6efff', '#1c55c9') + 14;
    chip(c, data.me.time, x, cy + 120, '#fff4cc', '#a06a00');

    if (data.opp) {
      const oppImg = await loadImg(data.opp.avatar ? `avatars/${data.opp.avatar}.svg` : null);
      const oy = cy + 236;
      rr(c, cx + 40, oy - 40, cw - 80, 80, 40);
      c.fillStyle = '#f2f0fb';
      c.fill();
      c.fillStyle = '#8a84a8';
      c.font = font(900, 30);
      c.textAlign = 'left';
      c.fillText('VS', cx + 72, oy + 2);
      drawAvatar(c, oppImg, data.opp, cx + 160, oy, 28, '#ff4d6d');
      c.fillStyle = INK;
      c.font = font(900, 34);
      c.fillText(fit(c, data.opp.name, 330), cx + 206, oy + 2);
      c.textAlign = 'right';
      c.fillStyle = '#8a84a8';
      c.font = font(700, 30);
      c.fillText(fit(c, data.opp.result, 330), cx + cw - 72, oy + 2);
    }

    // 路線（地鐵線）
    const route = shortRoute(data.me.path || []);
    c.textAlign = 'left';
    c.fillStyle = INK;
    c.font = font(900, 34);
    c.fillText('我的路線', cx + 48, cy + 322);
    const top = cy + 376;
    const room = cy + ch - 56 - top;
    const step = Math.min(56, room / Math.max(1, route.length - 1));
    route.forEach((t, i) => {
      const y = top + i * step;
      const hit = t === data.target;
      if (i < route.length - 1) {
        c.strokeStyle = 'rgba(47,123,255,.3)';
        c.lineWidth = 8;
        c.beginPath();
        c.moveTo(cx + 66, y);
        c.lineTo(cx + 66, y + step);
        c.stroke();
      }
      c.beginPath();
      c.arc(cx + 66, y, 13, 0, Math.PI * 2);
      c.fillStyle = hit ? '#ffd23f' : (i === 0 ? '#2f7bff' : '#fff');
      c.fill();
      c.lineWidth = 6;
      c.strokeStyle = hit ? '#e6a100' : '#2f7bff';
      c.stroke();
      c.fillStyle = hit ? '#a06a00' : INK;
      c.font = font(hit ? 900 : 700, step < 44 ? 28 : 32);
      c.textBaseline = 'middle';
      c.fillText(fit(c, t, cw - 160), cx + 100, y + 1);
    });
  }

  // 頁尾
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#fff';
  c.font = font(900, 38);
  strokeText(c, '來挑戰我！', mx, 1272, 'rgba(42,29,158,.6)', 8);
  c.font = font(700, 30);
  c.fillStyle = 'rgba(255,255,255,.92)';
  c.fillText(data.url, mx, 1318);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}
