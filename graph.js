// 首頁封面的動態知識網：條目節點彼此相連，一顆金色光點沿著連結一路跳到下一個條目
const WORDS = ['貓', '埃及', '金字塔', '月球', '咖啡', '孔子', '黑洞', '珍珠奶茶', '莫札特', '恐龍', '長城', '富士山', '鯨', '火山', '巴黎', '絲綢之路', '愛因斯坦', '颱風', '玉山', '圍棋'];

export function startGraph(canvas, isVisible) {
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, nodes = [], edges = [], walker = null, raf = 0;

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth; h = canvas.clientHeight;
    if (!w || !h) return false;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(8, Math.min(16, Math.round(w / 32)));
    const words = [...WORDS].sort(() => Math.random() - 0.5).slice(0, count);
    // 用網格加抖動擺放，避免擠在一起
    const cols = Math.ceil(Math.sqrt(count * w / h));
    const rows = Math.ceil(count / cols);
    nodes = words.map((word, i) => {
      const cx = ((i % cols) + 0.5) / cols, cy = (Math.floor(i / cols) + 0.5) / rows;
      return {
        word,
        bx: (cx + (Math.random() - 0.5) * 0.5 / cols) * w,
        by: (cy + (Math.random() - 0.5) * 0.5 / rows) * h,
        phase: Math.random() * Math.PI * 2,
        glow: 0,
      };
    });
    edges = [];
    nodes.forEach((n, i) => {
      const near = nodes.map((m, j) => ({ j, d: Math.hypot(m.bx - n.bx, m.by - n.by) }))
        .filter((o) => o.j !== i).sort((a, b) => a.d - b.d).slice(0, 2);
      for (const { j } of near) if (!edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) edges.push([i, j]);
    });
    walker = { from: 0, to: neighbor(0), t: 0 };
    return true;
  }

  function neighbor(i, avoid) {
    const opts = edges.filter(([a, b]) => a === i || b === i).map(([a, b]) => (a === i ? b : a));
    const pick = opts.filter((o) => o !== avoid);
    const list = pick.length ? pick : opts;
    return list[Math.floor(Math.random() * list.length)];
  }

  const pos = (n, time) => ({ x: n.bx + Math.sin(time / 2600 + n.phase) * 6, y: n.by + Math.cos(time / 3100 + n.phase) * 5 });

  function draw(time) {
    ctx.clearRect(0, 0, w, h);
    const P = nodes.map((n) => pos(n, time));
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(214, 166, 64, .22)';
    ctx.setLineDash([3, 5]);
    for (const [a, b] of edges) {
      ctx.beginPath(); ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // 光點走過的這段連結
    if (walker) {
      const a = P[walker.from], b = P[walker.to];
      const x = a.x + (b.x - a.x) * walker.t, y = a.y + (b.y - a.y) * walker.t;
      ctx.strokeStyle = 'rgba(245, 220, 150, .85)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(x, y); ctx.stroke();
      const g = ctx.createRadialGradient(x, y, 0, x, y, 14);
      g.addColorStop(0, 'rgba(255, 236, 170, 1)');
      g.addColorStop(1, 'rgba(255, 236, 170, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = '600 13px "Noto Serif TC", Georgia, serif';
    ctx.textAlign = 'center';
    nodes.forEach((n, i) => {
      const { x, y } = P[i];
      const glow = n.glow;
      ctx.fillStyle = glow > 0.01 ? `rgba(245, 220, 150, ${0.4 + glow * 0.6})` : 'rgba(169, 179, 204, .55)';
      ctx.beginPath(); ctx.arc(x, y, 3 + glow * 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = glow > 0.01 ? `rgba(245, 220, 150, ${0.5 + glow * 0.5})` : 'rgba(169, 179, 204, .45)';
      ctx.fillText(n.word, x, y - 9);
    });
  }

  let last = 0;
  function frame(time) {
    raf = 0;
    if (!isVisible() || document.hidden) { last = 0; return; }
    const dt = last ? Math.min(50, time - last) : 16;
    last = time;
    if (walker) {
      walker.t += dt / 1400;
      if (walker.t >= 1) {
        nodes[walker.to].glow = 1;
        walker = { from: walker.to, to: neighbor(walker.to, walker.from), t: 0 };
      }
    }
    for (const n of nodes) n.glow = Math.max(0, n.glow - dt / 1800);
    draw(time);
    raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (!layout()) return;
    if (reduce) { draw(0); return; }
    if (!raf) raf = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => { if (isVisible()) kick(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && isVisible() && !raf && !reduce) raf = requestAnimationFrame(frame); });
  kick();
  // 回到首頁時重新開始
  return { resume: kick };
}
