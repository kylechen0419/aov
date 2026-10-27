# 🌐 Chat Translate：Minecraft 遊戲內容即時翻成中文（Fabric 模組，1.21.4）

裝在**你自己的電腦**上的客戶端模組，不需要伺服器配合。進任何伺服器（例如 saominecraft.com 的 SAO 伺服器）時，伺服器送來的英文（或法文等）文字都會直接變成繁體中文：

- **聊天**：別人說的話直接換成中文顯示，滑鼠移上去看原文。
- **介面**：任務追蹤（例如 *Go to the marshes north of Hanaka*）、選單（Backpack、Class、Quests…）、物品名稱和說明、角色資訊、標題、Boss 血條等。第一次看到的文字會先顯示英文，大約 1 秒後變成中文；翻過的會存起來，下次一打開就是中文。
- **你說話**：在聊天打 `>>` 開頭（例如 `>>你好，要一起解任務嗎？`），會先翻成英文再送出。沒有 `>>` 就照原樣送出。

翻譯用的是 Claude（Anthropic 的 AI），需要你自己的 API key（見下面）。

## 安裝

### 用 Triggers Client（SAO 伺服器的啟動器）

它本身就是 Fabric 1.21.4，不用另外裝 Fabric：

1. **先關掉遊戲和啟動器。**
2. 到這個 GitHub 專案的 Releases，下載「聊天即時翻譯模組」裡的 `chattranslate-….jar`。
3. 放進 `%appdata%\.Triggers Client\instances\Sword Art Online\mods`（按 `Win + R` 貼上這個路徑就會打開）。
4. 確認同一個資料夾裡有 `fabric-api-….jar` 和 `fabric-language-kotlin-….jar`（Triggers Client 的 SAO 版本兩個都有）。
5. 用 Triggers Client 開遊戲，進伺服器後輸入 `/ct`，有看到「聊天翻譯」的設定就代表裝好了。

> 如果啟動器更新時把多出來的 `.jar` 刪掉，再放一次就好。

### 用官方啟動器

1. **安裝 Fabric**：到 <https://fabricmc.net/use/installer/> 下載安裝程式，選 Minecraft **1.21.4** 安裝。啟動器裡會多一個「fabric-loader-1.21.4」的版本。
   （如果你已經在用 Fabric＋光影、小地圖這些模組，就直接用原本的。）
2. **下載 Fabric API** 和 **Fabric Language Kotlin**（1.21.4 版）：
   <https://modrinth.com/mod/fabric-api/versions?g=1.21.4>、<https://modrinth.com/mod/fabric-language-kotlin>
3. **下載這個模組**：到這個 GitHub 專案的 Releases，找「聊天即時翻譯模組」那一個，下載 `chattranslate-….jar`。
4. 把三個 `.jar` 放進 `.minecraft/mods` 資料夾
   （Windows：按 `Win + R`，輸入 `%appdata%\.minecraft\mods`）。
5. 用啟動器的 Fabric 1.21.4 版本開遊戲。

## 設定 API key（只要一次）

1. 到 <https://console.anthropic.com/> 註冊、儲值，在 **API Keys** 建立一把 key（`sk-ant-` 開頭）。
2. 進遊戲後在聊天輸入：
   ```
   /ct key sk-ant-你的key
   ```
   看到「API key 已儲存，開始翻譯！」就好了。key 存在 `.minecraft/config/chattranslate.json`，**不要把這個檔案或 key 給別人**。

> 小提醒：Minecraft 本身的文字（原版物品、選項、成就）請直接在「選項 → 語言」改成**繁體中文（台灣）**，那是免費的；這個模組負責翻伺服器自己的英文內容。

## 指令

| 指令 | 作用 |
|---|---|
| `/ct` | 看目前設定、已經存了幾句翻譯 |
| `/ct on`、`/ct off` | 開關翻譯 |
| `/ct ui on`、`/ct ui off` | 介面文字要不要翻（關掉就只翻聊天） |
| `/ct model fast` | 改用快又便宜的模型（Claude Haiku 5.5），翻譯稍微沒那麼好 |
| `/ct model best` | 改回翻得最好的模型（Claude Opus 5.5，預設） |
| `/ct chat on`、`/ct chat off` | 聊天室要不要翻（關掉後任務、選單、物品還是會翻） |
| `/ct system on`、`/ct system off` | 伺服器訊息（公告、任務提示）要不要翻 |
| `/ct mode replace` | 直接換成中文（預設，滑鼠移上去看原文） |
| `/ct mode below` | 原文照樣顯示，下面多一行中文 |
| `/ct lang zh-tw` | 別人的話翻成什麼語言（`zh-tw` `zh-cn` `en` `ja` `ko` …） |
| `/ct out en` | 你打 `>>` 時翻成什麼語言 |

## 費用

- 會花 Anthropic API 的錢（照用量計費）。同一句話只翻一次：**數字會先遮起來**，所以 `350m`、`349m` 這種一直在變的距離、金錢、血量不會重翻；介面文字翻過就存在 `.minecraft/config/chattranslate/` 裡，之後完全不再花錢。
- 一次會把同一個畫面上的很多句一起送出翻譯，而不是一句一次。
- 想更省可以打開 `.minecraft/config/chattranslate.json`，把 `"model"` 改成 `"claude-haiku-5-5"`（便宜很多，翻得稍微沒那麼好），存檔後重開遊戲。

## 常見問題

- **伺服器准用嗎？** 這個模組只改「你自己畫面上顯示的文字」，不會自動操作、不會給你任何遊戲上的優勢，跟材質包、小地圖同一類。但每個伺服器規定不同，若伺服器有「允許模組清單」，請先確認。
- **有些字還是英文**：伺服器用圖片（材質包裡畫好的字）做的按鈕沒辦法翻；只有真的「文字」才能翻。
- **出現「翻譯失敗：API key 不對」**：重新 `/ct key …`；或確認 Anthropic 帳戶還有餘額。
- **介面排版跑掉**：中文字比英文寬，少數地方可能擠在一起。可以用 `/ct ui off` 只翻聊天。

## 給開發者

- 模組原始碼在 `src/main/java/io/github/kylechen0419/chattranslate/`：
  - `mixin/LiteralTextMixin.java`：所有「伺服器送來的文字」在畫到畫面上時換成翻譯（`getString()` 不變，其他模組讀到的還是原文）。
  - `core/BatchTranslator.java`：遮數字、批次呼叫 Claude、存檔快取（不依賴 Minecraft）。
  - `ChatTranslateClient.java`：聊天事件、`>>` 送出翻譯、`/ct` 指令。
- Anthropic Java SDK 打包在模組 jar 裡（OkHttp、Jackson 等搬到 `…chattranslate.shaded`，避免跟其他模組衝突）。
- 測試（不需要 Minecraft）：`cd devtest && gradle test smoke`，會用假的 API 伺服器測翻譯、批次、遮數字、快取，並實際跑一次打包後的 jar。
- 模組本體用 GitHub Actions 編譯（`.github/workflows/chattranslate-mod.yml`），會自動抓 1.21.4 最新的 Fabric 版本；要換 Minecraft 版本改 `gradle.properties` 的 `minecraft_version`（1.21.5 以後文字 API 有變，需要改程式）。
