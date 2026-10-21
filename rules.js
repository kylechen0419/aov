// Firebase Realtime Database 的安全規則。後台用你的 Google 帳號 UID 產生完整規則，貼到 Firebase 主控台。
// 原則：玩家（匿名登入）只能寫自己的東西、成績不能覆蓋、欄位要合理；公告、踢人、關房、通知設定只有管理員能改。
export function rulesFor(adminUid) {
  const uid = String(adminUid || '').replace(/[^A-Za-z0-9_-]/g, '');
  const admin = `auth != null && auth.uid === '${uid}'`;
  // 台灣時間今天是 1970-01-01 之後的第幾天（伺服器時間，玩家改不了）
  const DAY = '((now + 28800000 - (now + 28800000) % 86400000) / 86400000)';
  const roomOwner = "root.child('rooms').child($code).child('owner').val() === auth.uid";
  return {
    rules: {
      // 線上人數：每個分頁一筆，只能動自己的
      online: {
        '.read': true,
        $id: {
          '.write': "auth != null && (!data.exists() || data.child('u').val() === auth.uid)",
          '.validate': "newData.child('u').val() === auth.uid && newData.child('t').isNumber()",
          u: { '.validate': true },
          t: { '.validate': true },
          $other: { '.validate': false },
        },
      },
      // 在線玩家在做什麼（暱稱、在哪個房間、什麼模式）：本人寫、只有管理員看得到
      who: {
        '.read': admin,
        $id: {
          '.write': "auth != null && (!data.exists() || data.child('u').val() === auth.uid)",
          '.validate': "newData.child('u').val() === auth.uid && newData.child('t').isNumber() && newData.child('s').isString() && newData.child('s').val().length <= 12",
          u: { '.validate': true },
          t: { '.validate': true },
          s: { '.validate': true },
          since: { '.validate': 'newData.isNumber()' },
          at: { '.validate': 'newData.isNumber()' },
          n: { '.validate': 'newData.isString() && newData.val().length <= 16' },
          av: { '.validate': 'newData.isString() && newData.val().length <= 32' },
          r: { '.validate': 'newData.isString() && newData.val().length <= 8' },
          m: { '.validate': 'newData.isString() && newData.val().length <= 8' },
          g: { '.validate': 'newData.isString() && newData.val().length <= 8' },
          st: { '.validate': 'newData.isString() && newData.val().length <= 100' },
          tg: { '.validate': 'newData.isString() && newData.val().length <= 100' },
          k: { '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() <= 9999' },
          d: { '.validate': 'newData.isNumber()' },
          h: { '.validate': 'newData.isBoolean()' },
          ok: { '.validate': 'newData.isBoolean()' },
          done: { '.validate': 'newData.isBoolean()' },
          $other: { '.validate': false },
        },
      },
      // 房間概況：房主寫、只有管理員看得到（裡面有暱稱）
      rooms: {
        '.read': admin,
        $code: {
          '.write': `auth != null && (!data.exists() || data.child('owner').val() === auth.uid || ${admin})`,
          '.validate': "newData.child('owner').val() === auth.uid && newData.child('code').val() === $code",
        },
      },
      // 後台對房間下的指令：管理員送，該房的房主讀完刪掉
      control: {
        $code: {
          '.read': `${admin} || ${roomOwner}`,
          '.write': `${admin} || (!newData.exists() && ${roomOwner})`,
          '.validate': "newData.child('type').val() === 'close' || newData.child('type').val() === 'kick'",
        },
      },
      stats: {
        // 每局一筆，只能新增不能改
        games: {
          '.read': admin,
          $id: {
            '.write': 'auth != null && !data.exists()',
            '.validate': "newData.hasChildren(['mode', 'players', 'at']) && newData.child('players').isNumber() && newData.child('players').val() <= 8",
          },
        },
        // 史上尖峰只能往上加、不能刪（只是一個數字，公開讀；更新用 transaction 要先讀得到）。管理員可以重設
        peakOnline: {
          '.read': true,
          '.write': `auth != null && (newData.exists() || ${admin})`,
          '.validate': `newData.isNumber() && newData.val() >= 0 && newData.val() <= 100000 && (!data.exists() || newData.val() >= data.val() || ${admin})`,
        },
        // 每日挑戰排行榜：每個帳號每天一筆，不能覆蓋
        daily: {
          $date: {
            '.read': true,
            $uid: {
              '.write': 'auth != null && auth.uid === $uid && !data.exists()',
              '.validate': "newData.child('n').isString() && newData.child('n').val().length <= 16 && newData.child('s').isNumber() && newData.child('t').isNumber()",
            },
          },
        },
        // 每日題目：第一個算出來的人存，之後不能改。key 是 d＋台灣日期的天數，只能存昨天到明天（不能預先亂塞未來的題目）；
        // 管理員可以刪掉重算
        dailyPuzzle: {
          $day: {
            '.read': true,
            '.write': `(auth != null && !data.exists() && (${[-1, 0, 1].map((d) => `$day === 'd' + (${DAY} + ${d})`).join(' || ')})) || ${admin}`,
            '.validate': "newData.child('start').isString() && newData.child('target').isString() && newData.child('start').val().length < 200 && newData.child('target').val().length < 200",
          },
        },
      },
      // 全站公告：大家讀、管理員寫
      broadcast: {
        '.read': true,
        '.write': admin,
        '.validate': "newData.child('text').isString() && newData.child('text').val().length <= 200",
      },
      // 手機通知設定：遊戲要讀頻道名稱，只有管理員能改
      config: {
        '.read': true,
        $key: { '.write': admin },
      },
    },
  };
}
