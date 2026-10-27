# 🌐 Minecraft 伺服器聊天即時翻譯

讓說不同語言的玩家在同一個 Minecraft 伺服器裡直接聊天：有人說話，其他人都會**立刻收到翻成自己語言的版本**（只有自己看得到），原文照常顯示在公開聊天裡。

```
<Steve> watch out, creeper behind you!
[譯] <Steve> 小心，你後面有苦力怕！        ← Kim（繁中）看到的
[譯] <Steve> 気をつけて、後ろにクリーパー！  ← Alex（日文）看到的
```

滑鼠移到翻譯上會顯示原文。

## 怎麼運作

不用裝任何模組或插件，是一支跑在伺服器旁邊的小程式：

1. 一直讀伺服器的 `logs/latest.log`，看到聊天訊息就抓下來。
2. 看線上玩家各自選了什麼語言，一次請 Claude 把這句翻成所有需要的語言（同一句話會快取，不重複翻）。
3. 透過 RCON 用 `/tellraw` 把翻譯私下送給每個玩家（說話的人自己、和原本就同語言的人不會收到）。

所以 **原版、Paper／Spigot／Purpur、Fabric、Forge／NeoForge** 都能用（Java 版；用 Geyser 進來的基岩版玩家也收得到）。

## 安裝

需要 Python 3.10 以上、一把 [Anthropic API key](https://console.anthropic.com/)。

1. 在 `server.properties` 打開 RCON，然後重開伺服器：
   ```properties
   enable-rcon=true
   rcon.port=25575
   rcon.password=換成一組夠長的密碼
   ```
   ⚠️ 防火牆**不要**對外開放 25575，翻譯程式跟伺服器在同一台機器上連 127.0.0.1 就好。

2. 安裝並啟動：
   ```bash
   cd minecraft-translator
   python3 -m venv venv
   venv/bin/pip install -r requirements.txt

   export ANTHROPIC_API_KEY=sk-ant-...
   export MCT_RCON_PASSWORD=你的rcon密碼
   venv/bin/python mc_translator.py --log /伺服器資料夾/logs/latest.log
   ```
   要一直開著的話可以參考 `mc-translator.service`（systemd）。

## 玩家怎麼用

在遊戲聊天輸入：

| 指令 | 作用 |
|---|---|
| `!lang zh-tw` | 別人的話翻成繁體中文給我（`zh`、`tw`、`中文` 也可以） |
| `!lang en` / `ja` / `ko` / `zh-cn` / `es` / `fr` / `de` / `pt` / `ru` / `th` / `vi` / `id` | 其他語言 |
| `!lang off` | 不要翻譯 |
| `!lang` | 看目前設定和可用語言 |

設定存在 `players_lang.json`，下次上線還在。玩家進伺服器時會收到一行提示告訴他怎麼設定。

## 設定

| 參數 | 環境變數 | 預設 | 說明 |
|---|---|---|---|
| `--log` | `MCT_LOG` | `logs/latest.log` | 伺服器 log 路徑 |
| `--rcon-host` / `--rcon-port` | `MCT_RCON_HOST` / `MCT_RCON_PORT` | `127.0.0.1` / `25575` | |
| `--rcon-password` | `MCT_RCON_PASSWORD` | （必填） | |
| `--default-lang` | `MCT_DEFAULT_LANG` | 不設 | 還沒用 `!lang` 的玩家預設收哪種語言，例如整個伺服器以台灣玩家為主就設 `zh-tw` |
| `--players-file` | `MCT_PLAYERS_FILE` | `players_lang.json` | |
| `--chat-regex` | `MCT_CHAT_REGEX` | 原版格式 `<名字> 訊息` | 聊天插件（EssentialsX Chat、LuckPerms 前綴…）改了聊天格式時用，見下方 |
| `--model` | `MCT_MODEL` | `claude-opus-5-5` | |
| | `MCT_EFFORT` | `low` | 聊天要快，`low` 對短句就夠；想要翻得更細可改 `medium` |

### 聊天格式被插件改過

先看一行 log 裡聊天長什麼樣子，例如 `[12:00:00 INFO]: [會員] Steve: 你好`，那就設定：

```bash
--chat-regex '^\[[^\]]+\] (?P<name>[A-Za-z0-9_]+): (?P<msg>.+)$'
```

（比對的是 log 裡 `]: ` 後面的部分，一定要有 `name` 和 `msg` 兩個群組。）

## 費用與延遲

- 只有「有人需要翻譯」時才會呼叫 API；同一句話（例如 `gg`）翻過一次就快取起來。
- 一句聊天一次 API 呼叫，不管要翻成幾種語言。
- 一般 1～3 秒內會出現翻譯。想省錢可以用 `--model claude-haiku-5-5`（便宜很多，翻譯品質稍差）。

## 測試

```bash
venv/bin/python -m unittest discover -s tests -v
```

不需要 API key 或真的伺服器：測試會模擬 RCON 伺服器和翻譯結果，涵蓋原版／Paper／Forge 的 log 格式、log 輪替、`!lang` 指令、翻譯送給誰。

## 限制

- 只翻**公開聊天**；`/msg`、`/tell` 私訊和指令不會被翻（伺服器不會把私訊內容寫進 log）。
- 玩家輸入的 `!lang` 那一行大家都看得到（因為是一般聊天）。
- 告示牌、書本、伺服器訊息不翻。
