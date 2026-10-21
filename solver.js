// 找出起點到終點的最短路線（比賽結束後的「正確解答」）
// 維基百科沒有「最短路徑」的 API，所以在瀏覽器裡做「雙向廣度搜尋」：
//   從起點往外一層一層展開（這頁連到哪些條目），同時從終點往回展開（哪些條目連到這頁），
//   每次挑目前比較小的那一邊多走一層，兩邊碰到就是一條路線。
// 沒有步數上限：只要路線存在，遲早會碰到。兩邊都是一整層一整層地展開，
// 第一次碰到的那條就一定是最短的（之前的層都沒碰到，表示更短的路線不存在）。
// 重新導向（例如「台灣」→「臺灣」）不算一步：連到重新導向頁就等於連到它指向的條目。
import { api } from './wiki.js?v=82';

const BATCH = 50;          // 一次問 50 個條目（API 上限）
const PARALLEL = 4;        // 同時發幾個請求
const TIME_LIMIT = 150000; // 最多找 2.5 分鐘

// banned：驗證時發現「其實點不到」的步驟（`${key(從)}→${key(到)}`），重找時避開
export async function solve(lang, start, target, { key = (t) => t, onProgress = () => {}, banned = new Set(), signal = null } = {}) {
  const t0 = performance.now();
  const late = () => performance.now() - t0 > TIME_LIMIT || !!signal?.aborted;
  let checked = 0;
  let depthF = 0;
  let depthB = 0;
  const report = () => onProgress({ stage: 'search', checked, depth: depthF + depthB + 1 });
  const isBanned = (from, to) => banned.size > 0 && banned.has(`${from}→${to}`);

  // 起點、終點先換成正式標題（處理重新導向和簡繁寫法）
  const ends = await api(lang, { action: 'query', titles: `${start}|${target}`, redirects: '1', converttitles: '1' });
  const resolved = resolveMap(ends.query);
  start = resolved(start);
  target = resolved(target);
  for (const p of ends.query?.pages || []) {
    if (p.missing || p.invalid) throw new Error(`找不到條目「${p.title}」`);
  }
  if (key(start) === key(target)) return { path: [start], exact: true };

  // 往前：key → { title, parent }；往回：key → { title, child }
  const fwd = new Map([[key(start), { title: start, parent: null }]]);
  const bwd = new Map([[key(target), { title: target, child: null }]]);
  const fwdCanon = new Map();  // 往前碰到的重新導向名稱 → 正式條目的 key（展開後才知道）
  const alias = new Map();     // 往回那邊的重新導向名稱 → 正式條目的 key
  const aliasTitle = new Map(); // 重新導向名稱的 key → 原本的寫法（查詢用）
  const aliasesOf = new Map();  // 正式條目的 key → 它的重新導向名稱們
  let frontF = [key(start)];
  let frontB = [key(target)];
  let meet = null;             // { f: 往前那邊的 key, b: 往回那邊的 key }

  // 往前的 key 有沒有碰到往回那邊（直接碰到，或透過重新導向）
  const hitB = (k) => (bwd.has(k) ? k : alias.has(k) ? alias.get(k) : null);
  const hitF = (k) => (fwd.has(k) ? k : fwdCanon.has(k) ? fwdCanon.get(k) : null);

  // 終點的重新導向名稱也算到達終點
  await expandRedirects([key(target)]);

  // 往前展開一層：這些條目連到哪些條目
  async function stepForward() {
    const next = [];
    const queue = chunks(frontF, BATCH);
    const worker = async () => {
      while (queue.length && !meet && !late()) {
        const batch = queue.shift();
        const titles = batch.map((k) => fwd.get(k).title);
        let cont = {};
        do {
          const d = await api(lang, { action: 'query', titles: titles.join('|'), prop: 'links', plnamespace: '0', pllimit: 'max', redirects: '1', ...cont });
          const res = resolveMap(d.query);
          // 回應裡的條目是正式標題：對回當初查的是哪一個節點
          const nodeOf = new Map();
          for (const k of batch) {
            const page = res(fwd.get(k).title);
            nodeOf.set(key(page), k);
            if (key(page) !== k) {
              fwdCanon.set(key(page), k);
              const b = hitB(key(page));
              if (b && !meet) meet = { f: k, b };
            }
          }
          for (const p of d.query?.pages || []) {
            const from = nodeOf.get(key(p.title));
            if (!from || !p.links) continue;
            const fromKey = key(p.title);
            for (const l of p.links) {
              const k = key(l.title);
              if (isBanned(fromKey, k) || (alias.has(k) && isBanned(fromKey, alias.get(k))) || fwd.has(k)) continue;
              fwd.set(k, { title: l.title, parent: from });
              next.push(k);
              const b = hitB(k);
              if (b && !meet) meet = { f: k, b };
            }
          }
          cont = d.continue || null;
        } while (cont && !meet && !late());
        checked += batch.length;
        report();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    frontF = next;
    depthF++;
  }

  // 往回展開一層：哪些條目連到這些條目（連到它們的重新導向也算）
  async function stepBackward() {
    // 這一層的條目和它們的重新導向名稱一起查
    const names = [];
    for (const k of frontB) {
      names.push({ title: bwd.get(k).title, to: k });
      for (const a of aliasesOf.get(k) || []) names.push({ title: aliasTitle.get(a), to: k });
    }
    const next = [];
    const queue = chunks(names, BATCH);
    const worker = async () => {
      while (queue.length && !meet && !late()) {
        const batch = queue.shift();
        const byKey = new Map(batch.map((n) => [key(n.title), n.to]));
        let cont = {};
        do {
          const d = await api(lang, { action: 'query', titles: batch.map((n) => n.title).join('|'), prop: 'linkshere', lhnamespace: '0', lhprop: 'title|redirect', lhlimit: 'max', ...cont });
          for (const p of d.query?.pages || []) {
            const to = byKey.get(key(p.title));
            if (!to || !p.linkshere) continue;
            for (const x of p.linkshere) {
              const k = key(x.title);
              if (x.redirect) continue;  // 重新導向頁本身不是一步（它的名稱已經在 alias 裡）
              if (isBanned(k, to) || bwd.has(k)) continue;
              bwd.set(k, { title: x.title, child: to });
              next.push(k);
              const f = hitF(k);
              if (f && !meet) meet = { f, b: k };
            }
          }
          cont = d.continue || null;
        } while (cont && !meet && !late());
        checked += batch.length;
        report();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (!meet && !late()) await expandRedirects(next);
    frontB = next;
    depthB++;
  }

  // 往回那邊新加入的條目：查出所有重新導向到它們的名稱（往前碰到這些名稱也算碰到）
  async function expandRedirects(keys) {
    const queue = chunks(keys, BATCH);
    const worker = async () => {
      while (queue.length && !meet && !late()) {
        const batch = queue.shift();
        let cont = {};
        do {
          const d = await api(lang, { action: 'query', titles: batch.map((k) => bwd.get(k).title).join('|'), prop: 'redirects', rdnamespace: '0', rdlimit: 'max', ...cont }).catch(() => null);
          if (!d) break;
          for (const p of d.query?.pages || []) {
            const to = key(p.title);
            if (!bwd.has(to)) continue;
            for (const r of p.redirects || []) {
              const a = key(r.title);
              if (bwd.has(a) || alias.has(a)) continue;
              alias.set(a, to);
              aliasTitle.set(a, r.title);
              if (!aliasesOf.has(to)) aliasesOf.set(to, []);
              aliasesOf.get(to).push(a);
              const f = hitF(a);
              if (f && !meet) meet = { f, b: to };
            }
          }
          cont = d.continue || null;
        } while (cont && !meet && !late());
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }

  report();
  while (!meet) {
    if (late()) return { path: null, reason: signal?.aborted ? 'aborted' : 'timeout', checked };
    // 走不下去了：只剩起點自己＝起點沒有任何連結；只剩終點自己＝沒有條目連到終點
    if (!frontF.length) return { path: null, reason: fwd.size === 1 ? 'no-links' : 'unreachable', checked };
    if (!frontB.length) return { path: null, reason: bwd.size === 1 ? 'no-backlinks' : 'unreachable', checked };
    // 挑小的那一邊展開；一樣大就往前（往前通常比較省）
    if (frontF.length <= frontB.length) await stepForward(); else await stepBackward();
  }

  // 接起來：起點 … 碰面的地方 … 終點
  const left = [];
  for (let k = meet.f; k; k = fwd.get(k).parent) left.unshift(fwd.get(k).title);
  const right = [];
  for (let k = bwd.get(meet.b)?.child ?? null; k; k = bwd.get(k).child) right.push(bwd.get(k).title);
  // 碰面點用正式標題（往前那邊可能是重新導向的名稱）
  left[left.length - 1] = bwd.get(meet.b).title;
  return { path: [...left, ...right], exact: true, checked };
}

// API 回應裡的 normalized、converted、redirects：把查詢時用的標題對到最後的正式標題
function resolveMap(query) {
  const step = new Map();
  for (const list of [query?.normalized, query?.converted, query?.redirects]) {
    for (const r of list || []) step.set(r.from, r.to);
  }
  return (t) => {
    let cur = t;
    for (let i = 0; i < 5 && step.has(cur); i++) cur = step.get(cur);
    return cur;
  };
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
