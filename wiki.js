// 維基百科 API 包裝：讀取條目、解析標題、搜尋建議、隨機條目
const LANGS = {
  zh: { host: 'zh.wikipedia.org', variant: 'zh-tw' },
  en: { host: 'en.wikipedia.org', variant: null },
};

// 備用熱門條目（隨機條目池載入失敗時使用）
const POPULAR = {
  zh: [
    '臺灣', '日本', '珍珠奶茶', '周杰倫', 'IPhone', '披薩', '吉薩金字塔', '威廉·莎士比亞', '貓', '恐龍',
    '月球', '奧林匹克運動會', '咖啡', '籃球', '蒸汽機', '阿爾伯特·愛因斯坦', '長城', '黑洞', '寶可夢', '漫威電影宇宙',
    '台北101', '鐵達尼號', '巧克力', '莫札特', '羅馬帝國', '第二次世界大戰', '網際網路', '比特幣', '泰勒絲', '哈利波特',
    '富士山', '巴黎', '紐約', '熊貓', '鯨', '火山', '太陽', '電腦', '維京人', '武士',
    '豆腐', '拉麵', '足球', '電子遊戲', '超級瑪利歐兄弟', '李白', '孔子', '成吉思汗', '拿破崙·波拿巴', '埃及豔后',
  ],
  en: [
    'Taiwan', 'Japan', 'Bubble tea', 'Pizza', 'Great Pyramid of Giza', 'William Shakespeare', 'Cat', 'Dinosaur', 'Moon',
    'Olympic Games', 'Coffee', 'Basketball', 'Steam engine', 'Albert Einstein', 'Great Wall of China', 'Black hole',
    'Pokémon', 'Marvel Cinematic Universe', 'Titanic', 'Chocolate', 'Wolfgang Amadeus Mozart', 'Roman Empire',
    'World War II', 'Internet', 'Bitcoin', 'Taylor Swift', 'Harry Potter', 'Mount Fuji', 'Paris', 'New York City',
    'Giant panda', 'Whale', 'Volcano', 'Sun', 'Computer', 'Vikings', 'Samurai', 'Tofu', 'Ramen', 'Association football',
    'Video game', 'Super Mario Bros.', 'Confucius', 'Genghis Khan', 'Napoleon', 'Cleopatra', 'Beatles', 'Elvis Presley',
  ],
};

const nsCache = {};

// 維基百科說「太多請求了」（429）或暫時出錯（5xx、網路斷掉）時：等一下再試，不要直接放棄。
// 被擋的時候整個頁面一起放慢（coolUntil），其他同時在發的請求也先等，才不會一直被擋。
let coolUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (i) => Math.min(16000, 1000 * 2 ** i) * (0.75 + Math.random() * 0.5);
export async function api(lang, params, { retries = 3 } = {}) {
  const { host, variant } = LANGS[lang];
  const url = new URL(`https://${host}/w/api.php`);
  const all = { format: 'json', formatversion: '2', origin: '*', ...params };
  if (variant) { all.variant = variant; all.uselang = variant; }
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  for (let i = 0; ; i++) {
    const wait = coolUntil - Date.now();
    if (wait > 0) await sleep(wait);
    let r;
    try {
      r = await fetch(url);
    } catch {
      if (i >= retries) throw new Error('連不上維基百科，請檢查網路');
      await sleep(backoff(i));
      continue;
    }
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < retries) {
      const after = Number(r.headers.get('retry-after')) * 1000;
      const ms = after > 0 ? Math.min(after, 30000) : backoff(i);
      if (r.status === 429) coolUntil = Math.max(coolUntil, Date.now() + ms);
      await sleep(ms);
      continue;
    }
    throw new Error(`維基百科回應錯誤（${r.status}）`);
  }
}

export function normTitle(t) {
  return (t || '').replace(/_/g, ' ').trim();
}

// 確認條目存在並取得正規化（重新導向後）的標題
export async function resolveTitle(lang, title) {
  title = normTitle(title);
  if (!title) throw new Error('請輸入條目名稱');
  const data = await api(lang, { action: 'query', titles: title, redirects: '1', converttitles: '1' });
  const page = data.query?.pages?.[0];
  if (!page || page.missing || page.invalid) throw new Error(`找不到條目「${title}」`);
  if (page.ns !== 0) throw new Error(`「${title}」不是一般條目`);
  return page.title;
}

export async function suggest(lang, text) {
  if (!text.trim()) return [];
  const data = await api(lang, { action: 'opensearch', search: text, limit: '8', namespace: '0' });
  return Array.isArray(data) ? data[1] : [];
}

let topicsPromise = null;
const loadTopics = () => (topicsPromise ||= import('./topics.js?v=109').then((m) => m.TOPICS));
const recent = [];
// 管理員從題庫拿掉的條目（後台「題庫管理」，config/topicBan，一行一個）：隨機抽題時跳過
let banned = new Set();
export function setTopicBan(text) {
  banned = new Set(String(text || '').split('\n').map(normTitle).filter(Boolean));
}
export const topicBanned = (t) => banned.has(normTitle(t));

// 隨機抽到的條目至少要有這麼多瀏覽量（近 30 天），太冷門、大概看不懂的就跳過
const MIN_VIEWS = { zh: 3000, en: 15000 };

// 確認條目存在、不是消歧義頁、而且夠熱門；回傳實際標題或 null
async function checkTitle(lang, title) {
  const data = await api(lang, {
    action: 'query', titles: title, redirects: '1', converttitles: '1',
    prop: 'pageprops|pageviews', ppprop: 'disambiguation', pvipdays: '30',
  });
  const page = data.query?.pages?.[0];
  if (!page || page.missing || page.invalid || page.ns !== 0) return null;
  if (page.pageprops && 'disambiguation' in page.pageprops) return null;
  if (page.pageviews) {
    const views = Object.values(page.pageviews).reduce((sum, v) => sum + (v || 0), 0);
    if (views < MIN_VIEWS[lang]) return null;
  }
  return page.title;
}

// 中文條目透過跨語言連結找到英文條目
async function toEnglish(zhTitle) {
  const data = await api('zh', {
    action: 'query', titles: zhTitle, redirects: '1', converttitles: '1', prop: 'langlinks', lllang: 'en',
  });
  const en = data.query?.pages?.[0]?.langlinks?.[0]?.title;
  return en ? checkTitle('en', en) : null;
}

export async function randomTitle(lang, trueRandom) {
  if (trueRandom) {
    const data = await api(lang, { action: 'query', list: 'random', rnnamespace: '0', rnlimit: '1' });
    return data.query.random[0].title;
  }
  try {
    const topics = await loadTopics();
    for (let i = 0; i < 12; i++) {
      const pick = topics[Math.floor(Math.random() * topics.length)];
      if (recent.includes(pick) || banned.has(pick)) continue;
      const title = lang === 'zh' ? await checkTitle('zh', pick) : await toEnglish(pick);
      if (title && !banned.has(title)) {
        recent.push(pick);
        if (recent.length > 50) recent.shift();
        return title;
      }
    }
  } catch { /* 網路錯誤時退回內建清單 */ }
  const list = POPULAR[lang].filter((t) => !banned.has(t));
  return list[Math.floor(Math.random() * list.length)] || POPULAR[lang][0];
}

// 取得非主命名空間的前綴（例如 File:、檔案:、Category:），用來判斷連結是否為一般條目
async function namespacePrefixes(lang) {
  if (nsCache[lang]) return nsCache[lang];
  const set = new Set(['special', 'media']);
  try {
    const data = await api(lang, { action: 'query', meta: 'siteinfo', siprop: 'namespaces|namespacealiases' });
    for (const ns of Object.values(data.query.namespaces)) {
      if (ns.id === 0) continue;
      if (ns.name) set.add(ns.name.toLowerCase());
      if (ns.canonical) set.add(ns.canonical.toLowerCase());
    }
    for (const a of data.query.namespacealiases) if (a.id !== 0) set.add(a.alias.toLowerCase());
  } catch {
    ['file', 'image', 'category', 'help', 'wikipedia', 'template', 'portal', 'talk', 'user', 'draft', 'module',
      '檔案', '文件', '分類', '幫助', '維基百科', '模板', '主題'].forEach((x) => set.add(x));
  }
  return (nsCache[lang] = set);
}

// 把 <a href> 轉成條目標題；若不是可前往的條目則回傳 null
export function linkToTitle(href, prefixes) {
  if (!href || !href.startsWith('/wiki/')) return null;
  let title;
  try { title = decodeURIComponent(href.slice(6).split('#')[0]); } catch { return null; }
  title = normTitle(title);
  if (!title) return null;
  const idx = title.indexOf(':');
  if (idx > 0 && prefixes.has(title.slice(0, idx).trim().toLowerCase())) return null;
  return title;
}

// 讀取條目 HTML，回傳 { title, displayTitle, html, prefixes }
export async function fetchArticle(lang, title, retried = false) {
  const [data, prefixes] = await Promise.all([
    api(lang, {
      action: 'parse', page: title, prop: 'text|displaytitle', redirects: '1',
      disableeditsection: '1', disabletoc: '1',
    }),
    namespacePrefixes(lang),
  ]);
  if (data.error) {
    // 連結可能用了不同的中文變體寫法（例如 台/臺），先轉換成實際標題再試一次
    if (data.error.code === 'missingtitle' && !retried) {
      return fetchArticle(lang, await resolveTitle(lang, title), true);
    }
    throw new Error(data.error.info || '無法讀取條目');
  }
  return { title: data.parse.title, displayTitle: data.parse.displaytitle, html: data.parse.text, prefixes };
}

export function articleUrl(lang, title) {
  // 中文用台灣正體的網址（/zh-tw/），跟遊戲裡看到的一樣
  const { host, variant } = LANGS[lang];
  return `https://${host}/${variant || 'wiki'}/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

// 條目的一句話簡介（例如「英格蘭西北部城市」），用來模糊顯示對手在哪裡；查過的會記住
const descCache = new Map();
export function describe(lang, title) {
  const k = `${lang}:${title}`;
  if (!descCache.has(k)) {
    descCache.set(k, api(lang, { action: 'query', prop: 'description', titles: title, redirects: '1' })
      .then((d) => d.query?.pages?.[0]?.description || '')
      .catch(() => { descCache.delete(k); return ''; }));
  }
  return descCache.get(k);
}
