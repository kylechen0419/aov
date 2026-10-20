// 線上人數計數器的設定（選填）。
// 沒有填的話，首頁的「人在線上」就會自動隱藏，遊戲其他功能一切正常。
//
// 要開啟線上人數，請照 README 的「線上人數」步驟，在 Firebase 建一個免費專案，
// 把它給你的設定貼到下面 window.WIKIRACE_FIREBASE = { ... } 裡（記得填 databaseURL）。
//
// 範例：
// window.WIKIRACE_FIREBASE = {
//   apiKey: 'AIza...............',
//   authDomain: 'your-project.firebaseapp.com',
//   databaseURL: 'https://your-project-default-rtdb.firebaseio.com',
//   projectId: 'your-project',
//   appId: '1:1234567890:web:abcdef',
// };

window.WIKIRACE_FIREBASE = null;
