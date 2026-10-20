// 找出起點到終點的最短路線（給大家都找不到時看解答）
// 維基百科沒有「最短路徑」的 API，所以在瀏覽器裡一層一層往外找：
//   1 步：起點直接連到終點
//   2 步：起點連到的條目裡，有沒有連到終點的
//   3 步：起點連到的條目，再連到「會連到終點的條目」
//   4 步：再往外多找一層（只找部分，找到的不一定最短）
import { api } from './wiki.js?v=57';

const BATCH = 50;
const PARALLEL = 3;
const MAX_BACKLINKS = 5000;
const TIME_LIMIT = 40000;

export async function solve(lang, start, target, { key = (t) => t, onProgress = () => {} } = {}) {
  const t0 = performance.now();
  const late = () => performance.now() - t0 > TIME_LIMIT;
  let checked = 0;
  const report = (stage) => onProgress({ stage, checked });

  // 終點本身和所有重新導向到終點的名稱都算抵達
  const goal = new Set([key(target)]);
  const goalNames = [target];
  {
    const d = await api(lang, { action: 'query', titles: target, prop: 'redirects', rdnamespace: '0', rdlimit: 'max' });
    for (const r of d.query?.pages?.[0]?.redirects || []) { goal.add(key(r.title)); goalNames.push(r.title); }
  }
  const isGoal = (t) => goal.has(key(t));

  // 起點頁面上的所有連結
  report('start');
  const first = await linksOf(lang, [start]);
  const L1 = [...new Set((first.get(start) || []).filter((t) => t !== start))];
  if (L1.some(isGoal)) return { path: [start, target], exact: true };

  // 2 步：一次問 50 個條目「有沒有連到終點」
  report('two');
  const pt = goalNames.slice(0, 50).join('|');
  for (const batch of chunks(L1, BATCH)) {
    const d = await api(lang, { action: 'query', titles: batch.join('|'), prop: 'links', pltitles: pt, pllimit: 'max', redirects: '1' });
    checked += batch.length;
    report('two');
    const hit = (d.query?.pages || []).find((p) => p.links?.length);
    if (hit) return { path: [start, hit.title, target], exact: true };
    if (late()) return null;
  }

  // 會連到終點的條目（包含透過重新導向連過去的）
  report('back');
  const back = new Map();
  let cont = {};
  do {
    const d = await api(lang, { action: 'query', list: 'backlinks', bltitle: target, blnamespace: '0', bllimit: 'max', blredirect: '1', ...cont });
    for (const b of d.query?.backlinks || []) {
      if (!b.redirect) back.set(key(b.title), b.title);
      for (const r of b.redirlinks || []) back.set(key(r.title), r.title);
    }
    cont = d.continue || null;
  } while (cont && back.size < MAX_BACKLINKS && !late());
  // 名單完整、三步也找完了，四步找到的就一定是最短
  const backComplete = !cont;
  back.delete(key(start));

  // 3 步：把起點連到的條目逐批展開，看有沒有連到上面那些條目
  const parentOf = new Map();
  let found = null;
  const queue = chunks(L1, BATCH);
  const worker = async () => {
    while (queue.length && !found && !late()) {
      const batch = queue.shift();
      const map = await linksOf(lang, batch).catch(() => new Map());
      checked += batch.length;
      report('three');
      for (const [page, links] of map) {
        for (const l of links) {
          const k = key(l);
          if (back.has(k) && !found) found = [start, page, back.get(k), target];
          if (!parentOf.has(k)) parentOf.set(k, [page, l]);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (found) return { path: found, exact: true };
  if (late()) return null;
  const threeExhausted = backComplete && !late();

  // 4 步：從「會連到終點的條目」再往回找一層，碰到起點走兩步就能到的條目就成功
  report('four');
  const backQueue = chunks([...back.values()], BATCH);
  const worker4 = async () => {
    while (backQueue.length && !found && !late()) {
      const batch = backQueue.shift();
      let c = {};
      do {
        const d = await api(lang, { action: 'query', titles: batch.join('|'), prop: 'linkshere', lhnamespace: '0', lhlimit: 'max', ...c }).catch(() => null);
        if (!d) break;
        for (const p of d.query?.pages || []) {
          for (const x of p.linkshere || []) {
            const hit = parentOf.get(key(x.title));
            if (hit && !found) found = [start, hit[0], hit[1], p.title, target];
          }
        }
        c = d.continue || null;
      } while (c && !found && !late());
      checked += batch.length;
      report('four');
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker4));
  return found ? { path: found, exact: threeExhausted } : null;
}

// 多個條目各自連到哪些條目（自動處理分頁與重新導向）
async function linksOf(lang, titles) {
  const out = new Map();
  let cont = {};
  do {
    const d = await api(lang, { action: 'query', titles: titles.join('|'), prop: 'links', plnamespace: '0', pllimit: 'max', redirects: '1', ...cont });
    for (const p of d.query?.pages || []) {
      if (!p.links) continue;
      if (!out.has(p.title)) out.set(p.title, []);
      out.get(p.title).push(...p.links.map((l) => l.title));
    }
    cont = d.continue || null;
  } while (cont);
  return out;
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
