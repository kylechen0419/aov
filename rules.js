// Firebase Realtime Database 的安全規則。後台用你的 Google 帳號 UID 產生完整規則，貼到 Firebase 主控台。
// 原則：玩家（匿名登入）只能寫自己的東西、成績不能覆蓋、欄位要合理；公告、踢人、關房、通知設定只有管理員能改。
// 規則的版本：每次改規則就加一。後台會試著讀 rulesv/v<版本>（只有這一版的規則開放這個路徑），
// 讀得到就是 Firebase 上已經發布最新的規則，讀不到就提醒管理員重新複製發布
export const RULES_VERSION = 7;

export function rulesFor(adminUid) {
  const uid = String(adminUid || '').replace(/[^A-Za-z0-9_-]/g, '');
  const admin = `auth != null && auth.uid === '${uid}'`;
  // 台灣時間今天是 1970-01-01 之後的第幾天（伺服器時間，玩家改不了）
  const DAY = '((now + 28800000 - (now + 28800000) % 86400000) / 86400000)';
  // 被管理員踢出伺服器的人：期限內什麼都不能寫
  const ok = "(!root.child('ban').child(auth.uid).exists() || root.child('ban').child(auth.uid).child('until').val() < now)";
  // 用 Google 登入的玩家（匿名身分沒有 email）
  const google = 'auth.token.email != null && auth.token.email_verified === true';
  const roomOwner = "root.child('rooms').child($code).child('owner').val() === auth.uid";
  return {
    rules: {
      // 線上人數：每個分頁一筆，只能動自己的（管理員可以清掉很久沒心跳的幽靈連線；
      // 超過 10 分鐘沒更新的，誰都可以順手清掉：平常不一直連著，斷線時不會自動刪）
      online: {
        '.read': true,
        $id: {
          '.write': `(auth != null && (!data.exists() || data.child('u').val() === auth.uid) && (!newData.exists() || ${ok})) || (${admin} && !newData.exists()) || (auth != null && !newData.exists() && data.child('t').val() < now - 600000)`,
          '.validate': "newData.child('u').val() === auth.uid && newData.child('t').isNumber()",
          u: { '.validate': true },
          t: { '.validate': true },
          $other: { '.validate': false },
        },
      },
      // 玩家帳號（Google 登入）：暱稱、頭像、戰績；本人讀寫，管理員看得到（認出同一個人）
      users: {
        '.read': admin,
        $uid: {
          '.read': `auth != null && (auth.uid === $uid || ${admin})`,
          '.write': `auth != null && auth.uid === $uid && ${google} && ${ok}`,
          n: { '.validate': 'newData.isString() && newData.val().length <= 16' },
          a: { '.validate': 'newData.isString() && newData.val().length <= 20' },
          e: { '.validate': 'newData.isString() && newData.val() === auth.token.email' },
          g: { '.validate': 'newData.isString() && newData.val().length <= 60' },
          at: { '.validate': 'newData.isNumber() && newData.val() <= now + 60000' },
          st: {
            $goal: {
              '.validate': "$goal === 'speed' || $goal === 'steps' || $goal === 'items' || $goal === 'isteps' || $goal === 'rush'",
              w: { '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() <= 1000000' },
              l: { '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() <= 1000000' },
              d: { '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() <= 1000000' },
              streak: { '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() <= 1000000' },
              $other: { '.validate': false },
            },
          },
          $other: { '.validate': false },
        },
      },
      // 連線牽線（fbpeer.js）：房主在 sigh/<代碼> 掛號，25 秒沒心跳別人才能接手；登入的人都能看有沒有這個房間
      sigh: {
        $id: {
          '.read': 'auth != null',
          '.write': `auth != null && ${ok} && (!data.exists() || data.child('u').val() === auth.uid || data.child('t').val() < now - 25000) && (!newData.exists() || newData.child('u').val() === auth.uid)`,
          '.validate': "newData.child('u').isString() && newData.child('s').isString() && newData.child('s').val().length <= 40 && newData.child('t').isNumber() && newData.child('t').val() <= now + 60000",
          u: { '.validate': true },
          s: { '.validate': true },
          t: { '.validate': true },
          $other: { '.validate': false },
        },
      },
      // 連線邀請：玩家放進房主的信箱，只有房主和放的人自己看得到；房主寫回答覆
      sigi: {
        $id: {
          '.read': "auth != null && root.child('sigh').child($id).child('u').val() === auth.uid",
          '.write': "auth != null && root.child('sigh').child($id).child('u').val() === auth.uid",
          $c: {
            '.read': "auth != null && data.child('u').val() === auth.uid",
            '.write': `auth != null && ${ok} && ((!data.exists() && newData.child('u').val() === auth.uid) || data.child('u').val() === auth.uid)`,
            '.validate': "newData.child('u').isString() && newData.child('f').isString() && newData.child('f').val().length <= 60 && newData.child('o').isString() && newData.child('o').val().length <= 30000",
            u: { '.validate': true },
            f: { '.validate': true },
            o: { '.validate': true },
            a: { '.validate': 'newData.isString() && newData.val().length <= 30000' },
            $other: { '.validate': false },
          },
        },
      },
      // 在線玩家在做什麼（暱稱、在哪個房間、什麼模式）：本人寫、只有管理員看得到
      who: {
        '.read': admin,
        $id: {
          '.write': `(auth != null && (!data.exists() || data.child('u').val() === auth.uid) && (!newData.exists() || ${ok})) || (${admin} && !newData.exists()) || (auth != null && !newData.exists() && data.child('at').val() < now - 600000)`,
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
          v: { '.validate': 'newData.isNumber()' },
          $other: { '.validate': false },
        },
      },
      // 管理員觀戰：管理員寫 spy/<key>（要看誰），那位玩家讀得到就開始把畫面寫到 live/<key>（只有管理員讀得到）
      spy: {
        $id: {
          '.read': `${admin} || (auth != null && root.child('who').child($id).child('u').val() === auth.uid)`,
          '.write': admin,
        },
      },
      live: {
        $id: {
          '.read': admin,
          '.write': `auth != null && root.child('who').child($id).child('u').val() === auth.uid && (!newData.exists() || ${ok})`,
          '.validate': "newData.child('at').isNumber()",
          at: { '.validate': true },
          idle: { '.validate': 'newData.isBoolean()' },
          s: { '.validate': 'newData.isString() && newData.val().length <= 12' },
          p: { '.validate': 'newData.isString() && newData.val().length <= 200' },
          st: { '.validate': 'newData.isString() && newData.val().length <= 200' },
          tg: { '.validate': 'newData.isString() && newData.val().length <= 200' },
          lang: { '.validate': 'newData.isString() && newData.val().length <= 4' },
          fin: { '.validate': 'newData.isString() && newData.val().length <= 12' },
          gid: { '.validate': 'newData.isString() && newData.val().length <= 40' },
          path: { $i: { '.validate': 'newData.isString() && newData.val().length <= 200' } },
          i: { '.validate': 'newData.isNumber()' },
          f: { '.validate': 'newData.isNumber()' },
          k: { '.validate': 'newData.isNumber()' },
          el: { '.validate': 'newData.isNumber()' },
          n: { '.validate': 'newData.isNumber()' },
          tapAt: { '.validate': 'newData.isNumber()' },
          near: { '.validate': 'newData.isBoolean()' },
          $other: { '.validate': false },
        },
      },
      // 房間概況：房主寫、只有管理員看得到（裡面有暱稱）
      rooms: {
        '.read': admin,
        $code: {
          '.write': `(auth != null && (!data.exists() || data.child('owner').val() === auth.uid) && (!newData.exists() || ${ok})) || ${admin}`,
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
            '.write': `auth != null && !data.exists() && ${ok}`,
            '.validate': "newData.hasChildren(['mode', 'players', 'at']) && newData.child('players').isNumber() && newData.child('players').val() <= 8",
            lang: { '.validate': 'newData.isString() && newData.val().length <= 4' },
            hint: { '.validate': 'newData.isBoolean()' },
            // 每個人的帳號 id（跟 list 同樣順序，給後台的玩家檔案用）
            us: { $i: { '.validate': 'newData.isString() && newData.val().length <= 128' } },
            // 每個人的戰績（暱稱、名次、結果、步數、時間、路線）
            list: {
              $i: {
                n: { '.validate': 'newData.isString() && newData.val().length <= 16' },
                pl: { '.validate': 'newData.isNumber()' },
                r: { '.validate': 'newData.isString() && newData.val().length <= 12' },
                k: { '.validate': 'newData.isNumber()' },
                t: { '.validate': 'newData.isNumber()' },
                p: { $j: { '.validate': 'newData.isString() && newData.val().length <= 120' } },
                $other: { '.validate': false },
              },
            },
          },
        },
        // 每天的公開計數（每晚的摘要通知用）：只能一次加一點點、不能減少、不能刪
        dayCount: {
          '.read': true,
          $date: {
            $k: {
              '.write': `auth != null && newData.exists() && ${ok}`,
              '.validate': "($k === 'games' || $k === 'players' || $k === 'errors') && newData.isNumber() && newData.val() > (data.exists() ? data.val() : 0) && newData.val() <= (data.exists() ? data.val() : 0) + 8",
            },
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
              // 只收用 Google 登入的玩家（一個帳號一筆，不能開一堆匿名身分刷榜）
              '.write': `auth != null && auth.uid === $uid && !data.exists() && ${google} && ${ok}`,
              '.validate': "newData.child('n').isString() && newData.child('n').val().length <= 16 && newData.child('s').isNumber() && newData.child('t').isNumber()",
              // 走過的路線：每一站是條目名稱
              p: { $i: { '.validate': 'newData.isString() && newData.val().length <= 120' } },
            },
          },
        },
        // 每日題目：第一個算出來的人存，之後不能改。key 是 d＋台灣日期的天數，只能存昨天到明天（不能預先亂塞未來的題目）；
        // 管理員可以刪掉重算
        dailyPuzzle: {
          $day: {
            '.read': true,
            '.write': `(auth != null && !data.exists() && ${ok} && (${[-1, 0, 1].map((d) => `$day === 'd' + (${DAY} + ${d})`).join(' || ')})) || ${admin}`,
            '.validate': "newData.child('start').isString() && newData.child('target').isString() && newData.child('start').val().length < 200 && newData.child('target').val().length < 200",
          },
        },
      },
      // 踢出伺服器：管理員寫，被踢的人讀得到自己的（遊戲才知道要擋）
      ban: {
        '.read': admin,
        $uid: {
          '.read': `${admin} || auth.uid === $uid`,
          '.write': admin,
          '.validate': "newData.child('until').isNumber() && (!newData.child('n').exists() || (newData.child('n').isString() && newData.child('n').val().length <= 16))",
        },
      },
      // 錯誤回報：遊戲出錯時記一筆，只能新增；只有管理員看得到、清得掉
      errors: {
        '.read': admin,
        '.write': admin,
        $id: {
          '.write': `${admin} || (auth != null && !data.exists() && ${ok})`,
          '.validate': "newData.child('u').val() === auth.uid && newData.child('at').isNumber() && newData.child('msg').isString() && newData.child('msg').val().length <= 300",
          u: { '.validate': true },
          at: { '.validate': true },
          msg: { '.validate': true },
          v: { '.validate': 'newData.isNumber()' },
          where: { '.validate': 'newData.isString() && newData.val().length <= 40' },
          ua: { '.validate': 'newData.isString() && newData.val().length <= 200' },
          st: { '.validate': 'newData.isString() && newData.val().length <= 600' },
          $other: { '.validate': false },
        },
      },
      // 管理員操作紀錄：只有管理員讀寫
      audit: { '.read': admin, '.write': admin },
      // 管理員對玩家的備註
      notes: { '.read': admin, '.write': admin },
      // 規則版本標記（見 RULES_VERSION）
      rulesv: { [`v${RULES_VERSION}`]: { '.read': true } },
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
