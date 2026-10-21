// 在真的維基百科上跑一次「找最佳解答」（跟遊戲裡同一份 solver.js、wiki.js），檢查某一題找不找得到。
// GitHub → Actions → Solve check → Run workflow，填起點和終點；結果和花的時間會印在紀錄裡。
const UA = 'WikiRaceSolveCheck/1.0 (https://github.com/kylechen0419/aov)';
const realFetch = globalThis.fetch;
const stat = { req: 0, s429: 0, s5xx: 0, fail: 0 };
globalThis.fetch = async (url, opt = {}) => {
  stat.req++;
  try {
    const r = await realFetch(url, { ...opt, headers: { ...(opt.headers || {}), 'User-Agent': UA, 'Api-User-Agent': UA } });
    if (r.status === 429) stat.s429++;
    if (r.status >= 500) stat.s5xx++;
    return r;
  } catch (e) { stat.fail++; throw e; }
};
const { solve } = await import('../solver.js');
const start = process.env.START, target = process.env.TARGET, lang = process.env.LANG_CODE || 'zh';
// 新手題目檢查：PATHS="珍珠奶茶>臺灣>臺北市;壽司>日本>東京"，每一段都要一步就點得到
if (process.env.PATHS) {
  let bad = 0;
  for (const chain of process.env.PATHS.split(';').map((c) => c.split('>').map((t) => t.trim()).filter(Boolean)).filter((c) => c.length > 1)) {
    const hops = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const r = await solve(lang, chain[i], chain[i + 1], { timeLimit: 60000 }).catch((e) => ({ reason: e.message }));
      hops.push(r.path ? `${r.path[0]}→${r.path.at(-1)} ${r.path.length - 1} 步` : `${chain[i]}→${chain[i + 1]} ❌ ${r.reason}`);
      if (!r.path || r.path.length !== 2) bad++;
    }
    const all = await solve(lang, chain[0], chain.at(-1), { timeLimit: 60000 }).catch((e) => ({ reason: e.message }));
    const ok = hops.every((h) => / 1 步$/.test(h));
    console.log(`${ok ? '✅' : '❌'} ${chain.join(' › ')}｜${hops.join('，')}｜最短 ${all.path ? `${all.path.length - 1} 步：${all.path.join(' › ')}` : all.reason}`);
  }
  console.log(`請求 ${stat.req} 次，429 × ${stat.s429}，5xx × ${stat.s5xx}，連線失敗 × ${stat.fail}`);
  process.exit(bad ? 1 : 0);
}
console.log(`題目：${start} → ${target}（${lang}）`);
const t0 = Date.now();
let last = 0;
const res = await solve(lang, start, target, {
  onProgress: ({ stage, checked, depth }) => { if (Date.now() - last > 5000) { last = Date.now(); console.log(`  …${Math.round((Date.now() - t0) / 1000)} 秒：看過 ${checked} 個條目，正在找 ${depth} 步的路線`); } },
});
const sec = Math.round((Date.now() - t0) / 1000);
if (res.path) console.log(`✅ 找到了（${res.path.length - 1} 步，${sec} 秒）：${res.path.join(' › ')}`);
else console.log(`❌ 沒找到（${res.reason}，${sec} 秒）`);
console.log(`請求 ${stat.req} 次，429 × ${stat.s429}，5xx × ${stat.s5xx}，連線失敗 × ${stat.fail}`);
if (!res.path) process.exit(1);
