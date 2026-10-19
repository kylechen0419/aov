// 簡體 → 台灣正體轉換（含台灣慣用詞，例如 软件→軟體、信息→資訊）
// 維基百科的條目標題是以原始寫法儲存的，常常是簡體，所以所有顯示出來的標題與內文都經過這裡
let convert = null;

export const zhReady = import('./vendor/opencc-cn2t.js')
  .then((m) => { convert = m.Converter({ from: 'cn', to: 'twp' }); })
  .catch(() => { /* 載入失敗就維持原文 */ });

export function tw(text) {
  if (text == null) return '';
  return convert ? convert(String(text)) : String(text);
}

// 轉換一整塊 DOM 裡的文字
export function twTree(root) {
  if (!convert) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue;
    if (v.trim()) n.nodeValue = convert(v);
  }
}
