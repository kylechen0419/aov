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
