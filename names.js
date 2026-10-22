// 暱稱過濾：不雅的暱稱不能用（自己取名時擋下，房主收到別人的暱稱也會換掉），聊天裡的髒話變成＊。
// 內建一份常見的清單，管理員可以在後台加字（config/badwords，用逗號分開）
import { getDb } from './fb.js?v=100';

const BUILTIN = [
  '幹你', '幹妳', '幹恁', '幹林', '幹拎', '操你', '操妳', '肏', '屌你', '雞掰', '機掰', '鸡巴', '雞巴', '靠北', '靠杯', '王八蛋',
  '他媽的', '他妈的', '你媽的', '你妈的', '婊子', '賤人', '贱人', '傻逼', '傻屄', '煞筆', '腦殘', '脑残', '智障', '畜生', '狗娘養',
  '幹你娘', '去死', '低能', '破麻', '妓女',
  'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'asshole', 'pussy', 'whore', 'slut', 'retard', 'motherfucker',
];
let extra = [];

// 比對前先把全形換成半形、拿掉空白和符號、轉小寫（「Ｆ u c k」「幹.你」也擋得到）
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');

export function setBadWords(text) {
  extra = String(text || '').split(/[,，、\n]+/).map(norm).filter(Boolean).slice(0, 500);
}

const words = () => [...BUILTIN.map(norm), ...extra];

export function badName(name) {
  const n = norm(name);
  return !!n && words().some((w) => n.includes(w));
}

// 別人送來的暱稱：不雅就換成「玩家」
export const cleanName = (name, fallback = '玩家') => (badName(name) ? fallback : name);

// 聊天：照原文找（不拿掉符號），找到的字換成＊
export function maskText(text) {
  let out = String(text || '');
  for (const w of words()) {
    if (!w) continue;
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => '＊'.repeat([...m].length));
  }
  return out;
}

// 載入管理員加的字（公開讀；沒設定 Firebase 就只用內建清單）
export async function watchBadWords() {
  try {
    const db = await getDb();
    db?.ref('config/badwords').on('value', (snap) => setBadWords(snap.val()), () => {});
  } catch { /* 忽略 */ }
}
