# hongguo_downloader

紅果短劇（hongguoduanju.com）劇集清單 / MP4 網址工具。

## 檔案

| 檔案 | 說明 |
|------|------|
| `hongguo_list.mjs` | **主程式**：搜尋 → 選劇 → 分集 → 逐集取流／下載管理（Node.js，無 npm 依賴） |
| `hongguo/main.js` | 內嵌的紅果站源模組（快照自 [video-src/hongguo](https://github.com/gentoobreaking/video-src)，`--module` 可指向其他位置） |
| `.gitignore` | 排除執行期產物（見下） |
| `downloads/`、`index*.json`、`*_urls.txt` | 執行期產生，**不入版控** |
| `test/` | 舊版探索腳本（留本機，不入版控） |

### 相依

- Node.js ≥ 18（僅用內建模組：`node:child_process` / `node:fs` / `node:crypto` …）
- `curl`（分段下載與全部 HTTP 請求）
- `ffmpeg`（CENC 解密；只在 `-d` 下載到加密影片時用到）

## 用法

```bash
./hongguo_list.mjs "成家徒四壁"            # 互動式選擇劇集
./hongguo_list.mjs "成家徒四壁" 2          # 直接選第 2 個搜尋結果
./hongguo_list.mjs "成家徒四壁" 2 --range 1-20
./hongguo_list.mjs "成家徒四壁" 2 --all --web-360p
./hongguo_list.mjs "成家徒四壁" 2 --json > eps.json
```

| 參數 | 說明 |
|------|------|
| `--module <path>` | 指定站源模組 main.js（預設 `./hongguo/main.js`） |
| `--page <n>` | 搜尋結果頁（預設 1） |
| `--range <a[-b]>` | 只處理指定集數，如 `3`、`5-12`、`1,3,7` |
| `--all` | 列出所有清晰度線路（另存 `*_variants.txt`） |
| `--web-360p` | 額外列出網頁端 360p 明文預覽網址（免解密、網站 CDN 速度快） |
| `--stop` | 遇到失敗即停止（預設繼續處理其餘集數） |
| `--no-media` | 只列分集，不逐集取播放網址 |
| `--json` | 機器可讀輸出（含 cencKey、referer、variants） |
| `--out <file>` | 自定網址輸出檔（預設 `hongguo_<劇ID>_urls.txt`） |
| `--timeout <sec>` | HTTP 逾時秒數（預設 20） |
| `--debug` | 印出每個 HTTP 請求與回應狀態 |

## 下載與管理（index.json）

解密的播放網址有時間性，`-d` 採「取一集 → 立刻下載 → 下一集」，
所有狀態存於 `index.json`，隨時可中斷、續傳、暫停。

```bash
./hongguo_list.mjs "成家徒四壁" 2 -d                # 逐集下載全部
./hongguo_list.mjs "成家徒四壁" 2 -d --range 1-20   # 只下載 1-20 集
./hongguo_list.mjs "成家徒四壁" 2 -d --web-360p     # 下載網站自架 360p 明文（快、免解密）
./hongguo_list.mjs "成家徒四壁" 2 -d --threads 4    # 4 執行緒並行分段下載
./hongguo_list.mjs -d                              # 沿用既有 index.json 續下
./hongguo_list.mjs --resume                        # 恢復暫停的下載並繼續

./hongguo_list.mjs --status                        # 顯示下載狀態
./hongguo_list.mjs --pause                         # 暫停（分段處存檔，可續傳）
./hongguo_list.mjs --remove 1,3,5-10               # 移除指定集數
./hongguo_list.mjs --clear-queued                  # 清除所有佇列中的項目
./hongguo_list.mjs --clear-all                     # 清除全部項目
./hongguo_list.mjs --clear-all --with-files        # 連已下載的檔案一起刪
./hongguo_list.mjs --index index.<sid>.json --status  # 檢視舊劇的狀態
```

- 檔案落在 `downloads/hongguo_<劇ID>/ep-<集數>.mp4`（檔名只用集數，避免與「第N集」標題重複）。
- **CENC 解密**：下載完成後自動用 ffmpeg（`-decryption_key`）把加密 MP4 轉成明文，
  成功即取代原檔（`--status` 會標記「已解密」）並移除 `.cenc.key`；解密失敗會保留
  加密原檔與金鑰、在 `--status` 顯示「解密失敗」，不中斷整個佇列。
- 換一部劇下載時，舊的 `index.json` 會自動輪轉為 `index.<舊劇ID>.json`。
- `--remove`／`--clear-*` 預設只刪狀態、保留檔案；加 `--with-files` 才刪檔案。
- `--threads > 1` 先用 HEAD 取得總長度，再用 `curl --parallel` 分段併行下載；
  取不到長度（CDN 不支援 HEAD）自動退回單執行緒續傳。

### 狀態（status）

| 狀態 | 意義 |
|------|------|
| `queued` | 在佇列中，尚未開始 |
| `downloading` | 正在下載（進度寫入 `bytes`／`totalBytes`） |
| `paused` | 暫停／中斷於分段處，`--resume` 可續傳 |
| `done` | 已完成（檔案完整） |
| `failed` | 連續失敗（`error` 有原因），`-d`／`--resume` 會重試 |

## 運作原理

`hongguo_list.mjs` 在 Node 裡實作 videoapp 提供給 goja 的 `host` 橋接，
直接載入 `./hongguo/main.js` 站源模組，走完整 App 流程：

1. **設備註冊**：`log.snssdk.com/service/2/device_register/` 取得 device_id / install_id
   （結果快取在 `~/.cache/hongguo-downloader/`，重跑不必重複註冊）
2. **搜尋**：網頁 `incent_resource/suggestion` ＋ App `reading/bookapi/search/tab/v/`
3. **分集**：App `novel/player/video_detail/v1/`（失敗時改用網頁 `_ROUTER_DATA`）
4. **逐集取流**：App `reading/bookapi/video_tab/...` 或 `novel/player/multi_video_model/player/v1`
5. **簽名**：目錄介面用 X-Gorgon / X-Argus / X-Ladon（SM3 + AES-CBC + 自製 Feistel），
   播放介面用 V5 簽名 X-Medusa / X-Helios
6. **解密**：備用線路 URL 走 SHA-512 派生金鑰 + AES-CBC 解密

### 為什麼舊的 Python 版不行

舊版只從網頁播放頁（`/player/<vid>`）正則抓 `/video/public/<id>/360p.mp4`，
該頁面對多數分集並不回傳明文網址（404／僅試看），所以第 2 集就中斷。
`hongguo_list.mjs` 走 App 簽名介面，每集都能拿到真實的 1080p 網址。

### 注意事項

- App 線路的 CDN 網址**帶時效簽名**，重新整理請重跑程式（`-d` 每集重取就是為此）。
- App 線路多為 **CENC 加密**影片：`-d` 會在下載完成後自動用 ffmpeg 解密；
  要完全免加密就用 `-d --web-360p`（網站自架 360p 預覽，唯部分集數沒有）。
- 本機實測 CDN（qznovelvod.com）連線極慢（~1KB/s），網站自架 360p 則正常；
  大批下載建議先確認網路到 CDN 的速度，或使用 `--threads`。
- 換站源模組版本：把新的 `main.js` 放進 `./hongguo/main.js` 即可（或用 `--module` 指向它）。
- `preserveIntegers`、嚴格 base64、同 realm 載入三個 host 細節都與
  `videoapp/native/core/module_host.go` 對齊，缺一個就會讓 19 位劇集 ID 或
  播放資訊解析失敗。

### 補充
- 安卓電視（Android TV / Google TV）可以直接使用 VLC、NOVA Video Player 或 Kodi 等播放器來播放 MP4 影片。
