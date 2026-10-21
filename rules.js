// Firebase Realtime Database 的安全規則。後台用你的 Google 帳號 UID 產生完整規則，貼到 Firebase 主控台。
// 原則：玩家（匿名登入）只能寫自己的東西、成績不能覆蓋、欄位要合理；公告、踢人、關房、通知設定只有管理員能改。
export function rulesFor(adminUid) {
  const uid = String(adminUid || '').replace(/[^A-Za-z0-9_-]/g, '');
  const admin = `auth != null && auth.uid === '${uid}'`;
  const roomOwner = "root.child('rooms').child($code).child('owner').val() === auth.uid";
  return {
    rules: {
      // 線上人數：每個分頁一筆，只能動自己的
      online: {
        '.read': true,
        $id: {
          '.write': "auth != null && (!data.exists() || data.child('u').val() === auth.uid)",
          '.validate': "newData.child('u').val() === auth.uid && newData.child('t').isNumber()",
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
        // 史上尖峰只能往上加（只是一個數字，公開讀；更新用 transaction 要先讀得到）
        peakOnline: {
          '.read': true,
          '.write': 'auth != null',
          '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() <= 100000 && (!data.exists() || newData.val() >= data.val())',
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
        // 每日題目：第一個算出來的人存，之後不能改
        dailyPuzzle: {
          $date: {
            '.read': true,
            '.write': 'auth != null && !data.exists()',
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
