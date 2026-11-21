#!/usr/bin/env node
/**
 * hongguo_list.mjs — 紅果劇集清單 / MP4 網址工具（Node.js + 站源模組版）
 *
 * 參考專案：
 *   ./hongguo/main.js   站源模組（搜尋、分集、取流、簽名、解密）
 *   ~/Projects/videoapp/native/core        host 橋接行為（preserveIntegers 等）
 *
 * 與舊版 hongguo_list_py.sh 的差異：
 *   - 舊版只從網頁播放頁正則抓明文 MP4，第 2 集開始就會因權限/驗證失敗；
 *   - 本版直接載入站源模組，完成「設備註冊 → 搜尋 → 分集 → 逐集取流」全流程，
 *     包含 X-Gorgon/X-Argus/X-Ladon（目錄介面）與 X-Medusa/X-Helios（播放 V5 簽名），
 *     以及備用線路 AES-CBC 解密，因此可穩定取得每一集的真實 MP4 網址。
 *
 * 用法：
 *   ./hongguo_list.mjs "劇名關鍵字"           # 互動式選擇劇集
 *   ./hongguo_list.mjs "劇名關鍵字" 2         # 直接選第 2 個搜尋結果
 *   ./hongguo_list.mjs "劇名關鍵字" 2 --range 1-20 --all
 *   ./hongguo_list.mjs "劇名關鍵字" 2 -d      # 直接逐集下載（取一流→下一集）
 *   ./hongguo_list.mjs "劇名關鍵字" 2 -d --threads 4  # 4 執行緒並行下載
 *
 * 參數：
 *   --module <path>   指定 main.js 路徑（預設依序尋找下列位置）
 *   --page <n>        搜尋結果頁，預設 1
 *   --range <a[-b]>   只處理指定集數，如 3、5-12、1,3,7
 *   --all             列出所有清晰度線路（預設只列最佳線路）
 *   --web-360p        額外列出網頁端 360p 明文預覽網址（免解密、網站 CDN 速度快，
 *                     寫入 hongguo_<劇ID>_web360p_urls.txt）
 *   --stop            遇到失敗即停止（預設繼續處理其餘集數）
 *   --no-media        只列分集，不逐集取播放網址
 *   --json            輸出 JSON 到 stdout（機器可讀模式）
 *   --out <file>      自定網址輸出檔（預設 hongguo_<劇ID>_urls.txt）
 *   --timeout <sec>   HTTP 逾時秒數，預設 20
 *   --debug           印出每個 HTTP 請求與回應狀態
 *   -h, --help        顯示說明
 *
 * 下載與管理（狀態存於 index.json，可中斷續傳）：
 *   -d, --download    逐集下載；解密的播放網址有時間性，故「取一集→立刻下載→下一集」
 *   --resume          恢復暫停的下載並繼續（不需要關鍵字）
 *   --status          顯示目前下載狀態
 *   --pause           暫停所有下載（進行中的檔案在分段處存檔，下次可續傳）
 *   --remove <範圍>   移除指定集數，如 --remove 1,3,5-10（配 --with-files 連檔案一起刪）
 *   --clear-queued    清除所有「佇列中」的項目
 *   --clear-all       清除全部項目（配 --with-files 連檔案一起刪）
 *   --index <file>    指定狀態檔（預設 ./index.json）
 *   --with-files      搭配 --remove/--clear-*：同時刪除已下載檔案
 *   --threads <n>     下載執行緒數（預設 1，單執行緒續傳；>1 使用 curl --parallel 多執行緒分段下載）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";

// --------------------------------------------------------------------------
// 基本工具
// --------------------------------------------------------------------------

const CACHE_DIR = path.join(os.homedir(), ".cache", "hongguo-downloader");
const CACHE_FILE = path.join(CACHE_DIR, "cache.json");
const SITE_BASE = "https://hongguoduanju.com";
const WEB_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";

function fail(text, flags) {
  const error = new Error(text);
  if (flags) Object.assign(error, flags);
  return error;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  // ArrayBuffer.isView 可跨 realm 判斷（vm context 內建立的 Uint8Array 也能識別），
  // 用 instanceof Uint8Array 會因跨 realm 而誤判成字串，導致簽名資料全錯。
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Buffer.from(value);
  return Buffer.from(String(value));
}

// --------------------------------------------------------------------------
// preserveIntegers —— 與 videoapp/native/core/module_host.go 相同行為：
// 把超過 2^53-1 的 JSON 整數加上引號，避免 JS 數字精度破壞 19 位劇集 ID。
// （舊 run_main.js 用 identity 實作，導致 series_id 被四捨五入成 ...000）
// --------------------------------------------------------------------------

function preserveIntegers(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let index = 0;
  const numberChars = "0123456789+-.eE";
  while (index < text.length) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      let end = index + 1;
      while (end < text.length && numberChars.includes(text[end])) end += 1;
      const token = text.slice(index, end);
      const plainInteger = !/[.eE+]/.test(token);
      let beyondSafe = false;
      if (plainInteger) {
        const value = Number(token);
        beyondSafe = !Number.isSafeInteger(value) || Math.abs(value) > 9007199254740991;
      }
      out += plainInteger && beyondSafe ? '"' + token + '"' : token;
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

// --------------------------------------------------------------------------
// 快取（記憶體 + 磁碟，TTL 語意與 Go 橋接一致：0 = 永不過期）
// --------------------------------------------------------------------------

class Cache {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [key, entry] of Object.entries(raw)) {
          if (entry && typeof entry === "object" && "value" in entry) this.map.set(key, entry);
        }
      }
    } catch { /* 沒有快取檔就忽略 */ }
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expires && Date.now() > entry.expires) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }
  set(key, value, ttlMs) {
    this.map.set(key, {
      value,
      expires: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : 0,
    });
    this.save();
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const plain = {};
      for (const [key, entry] of this.map) {
        if (entry.expires && Date.now() > entry.expires) continue;
        try {
          plain[key] = { value: JSON.parse(JSON.stringify(entry.value)), expires: entry.expires };
        } catch { /* 不可序列化的值只留在記憶體 */ }
      }
      fs.writeFileSync(this.file, JSON.stringify(plain), "utf8");
    } catch { /* 磁碟快取寫入失敗不影響流程 */ }
  }
}

// --------------------------------------------------------------------------
// host 橋接（對應 videoapp/native/core/module_host.go 提供給 goja 的 API）
// --------------------------------------------------------------------------

function createHost({ modulePath, verbose, timeoutSec }) {
  const cache = new Cache(CACHE_FILE);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hongguo-fetch-"));
  let tmpCounter = 0;
  let requestCount = 0;
  const webUserAgent = WEB_USER_AGENT;

  function httpFetch(request) {
    requestCount += 1;
    const seq = requestCount;
    const method = (request.method || "GET").toUpperCase();
    const timeoutMs = Math.max(1000, Math.min(request.timeoutMs || 20000, timeoutSec * 1000));
    const args = [
      "-sS",
      "--compressed",
      "--max-time", String(Math.ceil(timeoutMs / 1000)),
      "-X", method,
    ];
    if (request.followRedirects !== false) args.push("-L");
    for (const [key, value] of Object.entries(request.headers || {})) {
      args.push("-H", `${key}: ${value}`);
    }
    const body = request.body ? String(request.body) : "";
    if (body !== "") args.push("--data-binary", "@-");
    const bodyFile = path.join(tmpDir, `body-${(tmpCounter += 1)}.bin`);
    args.push("-o", bodyFile, "-w", "%{http_code}", request.url);

    const started = Date.now();
    const result = spawnSync("curl", args, {
      input: body,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const statusText = (result.stdout || "").trim();
    const status = Number.parseInt(statusText, 10);

    let responseBody = "";
    try {
      responseBody = fs.readFileSync(bodyFile, "utf8");
    } catch { /* 空 body */ }
    try { fs.unlinkSync(bodyFile); } catch { /* 忽略 */ }

    if (verbose) {
      const label = `${method} ${request.url.slice(0, 150)}`;
      console.error(`    [http#${seq}] ${label} -> ${result.status === 0 ? status : "curl:" + result.status} ` +
        `(${Date.now() - started}ms, ${responseBody.length}B)`);
    }
    if (process.env.HONGGUO_DUMP) {
      try {
        fs.mkdirSync(process.env.HONGGUO_DUMP, { recursive: true });
        fs.writeFileSync(path.join(process.env.HONGGUO_DUMP, `${String(seq).padStart(3, "0")}-${method}-${status}.txt`),
          request.url + "\n\n" + responseBody, "utf8");
      } catch { /* 忽略 */ }
    }

    if (result.error) throw fail("網路錯誤：" + result.error.message);
    if (result.status !== 0) {
      if (result.status === 28) throw fail("紅果請求超時", { timeout: true });
      const stderr = String(result.stderr || "").trim().slice(0, 200);
      throw fail("curl 失敗（exit " + result.status + "）：" + stderr);
    }
    if (!Number.isFinite(status)) throw fail("curl 未回傳 HTTP 狀態碼");
    const limit = request.limit || 20 * 1024 * 1024;
    if (Buffer.byteLength(responseBody) > limit) {
      throw fail("紅果回應過大", { oversized: true });
    }
    return { status, headers: {}, body: responseBody, blocked: false, oversized: false };
  }

  function sleepSync(ms) {
    if (!(ms > 0)) return;
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch { /* 忽略 */ }
  }

  const host = {
    source: "hongguo",
    dramaId: (sourceId) => `hongguo:${sourceId}`,
    chapterId: (seriesId, videoId) => `hongguo:${seriesId}:${videoId}`,
    finishMedia: (media) => Object.assign({}, media, { source: "hongguo" }),
    catalogContext: () => ({ background: false, more: false }),
    maxPages: () => 50,
    isKnown: () => false,
    reportProgress: () => undefined,
    retries: () => 2,
    reserve: () => 1,
    exclusive: (fn) => fn(),
    sleep: sleepSync,
    cacheGet: (key) => cache.get(key),
    cacheSet: (key, value, ttlMs) => cache.set(key, value, ttlMs),
    utf8Encode: (text) => Buffer.from(String(text), "utf8"),
    utf8Decode: (value) => toBuffer(value).toString("utf8"),
    hexEncode: (value) => toBuffer(value).toString("hex"),
    hexDecode: (value) => Buffer.from(String(value), "hex"),
    base64Encode: (value) => toBuffer(value).toString("base64"),
    // 嚴格 base64 解碼：非合法 base64 必須丟擲錯誤。
    // （與 ./test/playback.test.cjs 的 host 行為一致；
    //  寬鬆解碼會把 video_model 的 JSON 字串解成垃圾，導致播放資訊格式異常）
    base64Decode: (value) => {
      const text = String(value);
      const raw = Buffer.from(text, "base64");
      if (raw.toString("base64").replace(/=+$/, "") !== text.replace(/=+$/, "")) {
        throw new Error("Invalid Base64");
      }
      return raw;
    },
    md5: (value) => crypto.createHash("md5").update(toBuffer(value)).digest(),
    sha256: (value) => crypto.createHash("sha256").update(toBuffer(value)).digest(),
    sha512: (value) => crypto.createHash("sha512").update(toBuffer(value)).digest(),
    randomBytes: (size) => crypto.randomBytes(size),
    aesCbcEncrypt: (key, iv, data) => {
      const cipher = crypto.createCipheriv("aes-128-cbc", toBuffer(key), toBuffer(iv));
      cipher.setAutoPadding(false);
      return Buffer.concat([cipher.update(toBuffer(data)), cipher.final()]);
    },
    aesCbcDecrypt: (key, iv, data) => {
      const decipher = crypto.createDecipheriv("aes-128-cbc", toBuffer(key), toBuffer(iv));
      decipher.setAutoPadding(false);
      return Buffer.concat([decipher.update(toBuffer(data)), decipher.final()]);
    },
    parseUrl: (value) => {
      const url = new URL(value);
      return {
        scheme: url.protocol.replace(":", ""),
        hostname: url.hostname,
        userInfo: !!(url.username || url.password),
      };
    },
    resolveUrl: (base, relative) => {
      try { return new URL(relative, base).toString(); } catch { return ""; }
    },
    preserveIntegers,
    parseHtml: () => {
      throw new Error("命令列工具不提供 HTML 解析（僅影響網頁備援元資料）");
    },
    fetch: httpFetch,
    fetchText: (options) => {
      const response = httpFetch({
        method: "GET",
        url: options.url,
        timeoutMs: 30000,
        followRedirects: true,
        headers: {
          "User-Agent": webUserAgent,
          Referer: options.referer || "https://hongguoduanju.com/",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      });
      return { body: response.body, url: options.url };
    },
  };
  host.__cache = cache;
  host.__httpCount = () => requestCount;
  return host;
}

// --------------------------------------------------------------------------
// 模組載入
// --------------------------------------------------------------------------

function findModule(explicit) {
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  if (process.env.HONGGUO_MAIN_JS) candidates.push(path.resolve(process.env.HONGGUO_MAIN_JS));
  candidates.push(path.join(process.cwd(), "hongguo", "main.js"));
  candidates.push(path.join(path.dirname(new URL(import.meta.url).pathname), "hongguo", "main.js"));
  candidates.push(path.join(path.dirname(new URL(import.meta.url).pathname), "main.js"));
  candidates.push(path.join(path.dirname(new URL(import.meta.url).pathname), "test", "main.js"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "找不到 main.js，請用 --module 指定站源模組路徑（曾嘗試：\n  " +
    candidates.join("\n  ") + "）"
  );
}

function loadModule(modulePath, host) {
  const source = fs.readFileSync(modulePath, "utf8");
  // 用 new Function 在「同一 realm」執行 main.js：
  // 若用 vm.createContext，模組內 new Uint8Array() 與外層 Buffer/Uint8Array 不同原型，
  // instanceof 判斷會失敗，簽名用的位元組會被錯誤轉成字串。
  const moduleObject = { exports: {} };
  const factory = new Function(
    "host", "module", "exports", "console",
    source + "\nreturn module.exports;"
  );
  const api = factory(host, moduleObject, moduleObject.exports, console);
  if (!api || typeof api.search !== "function" || typeof api.detail !== "function") {
    throw new Error("main.js 未匯出 search/detail，可能不是紅果站源模組");
  }
  return api;
}

// --------------------------------------------------------------------------
// 命令列
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    keyword: null,
    choice: null,
    module: null,
    page: 1,
    range: null,
    all: false,
    web360: false,
    stop: false,
    noMedia: false,
    json: false,
    out: null,
    timeout: 20,
    verbose: false,
    help: false,
    // 下載 / 管理
    download: false,
    resume: false,
    status: false,
    pause: false,
    remove: null,
    clearQueued: false,
    clearAll: false,
    index: null,
    withFiles: false,
    threads: 1,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--module": options.module = argv[++index]; break;
      case "--page": options.page = Math.max(1, Number.parseInt(argv[++index], 10) || 1); break;
      case "--range": options.range = argv[++index]; break;
      case "--all": options.all = true; break;
      case "--web-360p": options.web360 = true; break;
      case "--stop": options.stop = true; break;
      case "--no-media": options.noMedia = true; break;
      case "--json": options.json = true; break;
      case "--out": options.out = argv[++index]; break;
      case "--timeout": options.timeout = Math.max(1, Number.parseInt(argv[++index], 10) || 20); break;
      case "--debug": options.verbose = true; break;
      case "-d": case "--download": options.download = true; break;
      case "--resume": options.resume = true; break;
      case "--status": options.status = true; break;
      case "--pause": options.pause = true; break;
      case "--remove":
        options.remove = argv[++index];
        if (options.remove === undefined || options.remove.startsWith("-")) {
          throw new Error("--remove 需要指定集數範圍，例如 --remove 1,3,5-10");
        }
        break;
      case "--clear-queued": options.clearQueued = true; break;
      case "--clear-all": options.clearAll = true; break;
      case "--index": options.index = argv[++index]; break;
      case "--with-files": options.withFiles = true; break;
      case "--threads": options.threads = Math.max(1, Number.parseInt(argv[++index], 10) || 1); break;
      case "-h": case "--help": options.help = true; break;
      default:
        if (arg.startsWith("--")) throw new Error("未知參數：" + arg);
        positional.push(arg);
    }
  }
  if (positional.length > 0) options.keyword = positional[0];
  if (positional.length > 1) {
    const choice = Number.parseInt(positional[1], 10);
    if (Number.isNaN(choice)) throw new Error("劇集編號必須是數字：" + positional[1]);
    options.choice = choice;
  }
  if (positional.length > 2) throw new Error("過多的位置參數：" + positional.slice(2).join(" "));
  return options;
}

// 解析 "1,3,5-10" 這類的集數清單（不限制上限）
function parseEpisodes(text) {
  const picked = new Set();
  for (const part of String(text).split(",")) {
    const piece = part.trim();
    if (piece === "") continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(piece);
    if (!match) throw new Error("集數範圍格式錯誤：" + piece);
    const from = Number.parseInt(match[1], 10);
    const to = match[2] ? Number.parseInt(match[2], 10) : from;
    if (from < 1 || to < from) throw new Error("集數範圍無效：" + piece);
    for (let episode = from; episode <= to; episode += 1) picked.add(episode);
  }
  return [...picked].sort((a, b) => a - b);
}

function parseRange(text, total) {
  if (!text) return null;
  const list = parseEpisodes(text).filter((episode) => episode <= total);
  if (list.length === 0) throw new Error(`指定的集數範圍超出 1-${total}`);
  return list;
}

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

function stripScheme(url, schemes) {
  for (const scheme of schemes) {
    if (url.startsWith(scheme)) return url.slice(scheme.length);
  }
  return url;
}

function displayWidth(text) {
  let width = 0;
  for (const character of String(text)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(character) ? 2 : 1;
  }
  return width;
}

function padDisplay(text, width) {
  const value = String(text);
  const padding = width - displayWidth(value);
  return value + " ".repeat(Math.max(0, padding));
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return value.toFixed(digits) + " " + units[unit];
}

// --------------------------------------------------------------------------
// 下載狀態管理（index.json）
// --------------------------------------------------------------------------

const CENC_SCHEME = "hongguo-cenc://";
const AUDIO_SCHEME = "hongguo-audio://";
const DOWNLOAD_UA =
  "com.phoenix.read/74532 (Linux; U; Android 12; zh_CN-#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)";

function newEpisodeRecord(episode, videoId, scheme) {
  return {
    episode,
    videoId,
    scheme,
    title: "",
    status: "queued", // queued | downloading | paused | done | failed
    url: "",
    web360p: "",
    quality: 0,
    durationMs: 0,
    referer: "",
    cencKey: "",
    decrypted: false,
    decryptError: "",
    stopQueue: false,
    downgraded: "",
    file: "",
    bytes: 0,
    totalBytes: 0,
    error: "",
    attempts: 0,
    resolvedAt: 0,
    updatedAt: new Date().toISOString(),
  };
}

function loadIndex(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && raw.episodes) return raw;
  } catch { /* 沒有或壞掉就當不存在 */ }
  return null;
}

function saveIndex(file, state) {
  state.updatedAt = new Date().toISOString();
  const target = path.resolve(file);
  const tmp = target + ".tmp";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

// 檔名只用集數（ep-004.mp4）：標題多為「第4集」與編號重複，不放入檔名
function episodeFileName(record) {
  return `ep-${String(record.episode).padStart(3, "0")}.mp4`;
}

function episodeFilePath(record, state) {
  return path.join("downloads", `hongguo_${state.drama.sourceId}`, episodeFileName(record));
}

function chapterOfRecord(record, state) {
  return {
    id: `hongguo:${state.drama.sourceId}:${record.videoId}`,
    source: "hongguo",
    title: record.title || `第${record.episode}集`,
    videoUrl: record.scheme + record.videoId,
    currentEpisode: record.episode,
  };
}

// 單次 curl 分段下載（-C - 續傳；逾時視為正常分段，非錯誤）
function curlChunk(url, dest, referer, maxSec) {
  const headerFile = path.join(os.tmpdir(),
    `hg-h-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const args = [
    "-sS", "-L", "--compressed", "-C", "-",
    "--max-time", String(maxSec),
    "--speed-time", "60", "--speed-limit", "1000",
    "-H", `User-Agent: ${DOWNLOAD_UA}`,
    "-H", `Referer: ${referer || "https://novel.snssdk.com/"}`,
    "-o", dest, "-D", headerFile,
    "-w", "%{http_code} %{size_download}",
    url,
  ];
  const result = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  let total = 0;
  try {
    const headers = fs.readFileSync(headerFile, "utf8");
    const range = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(headers);
    const length = /content-length:\s*(\d+)/i.exec(headers);
    if (range) total = Number.parseInt(range[1], 10);
    else if (length) total = Number.parseInt(length[1], 10);
  } catch { /* 沒有表頭就略過 */ }
  try { fs.unlinkSync(headerFile); } catch { /* 忽略 */ }
  const parts = String(result.stdout || "").trim().split(/\s+/);
  const httpStatus = Number.parseInt(parts[0], 10);
  const transferred = Number.parseInt(parts[1] || "0", 10) || 0;
  let bytes = 0;
  try { bytes = fs.statSync(dest).size; } catch { /* 尚未建立 */ }
  return {
    exit: result.status === null ? -1 : result.status,
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : 0,
    transferred,
    bytes,
    total,
    error: result.error ? String(result.error.message) : String(result.stderr || "").trim().slice(0, 200),
  };
}

// 多執行緒並行下載：使用 curl --parallel 分段下載
async function curlParallel(url, dest, referer, maxSec, threads) {
  // 先取得檔案總大小
  const headArgs = [
    "-sS", "-L", "-I",
    "--max-time", "30",
    "-H", `User-Agent: ${DOWNLOAD_UA}`,
    "-H", `Referer: ${referer || "https://novel.snssdk.com/"}`,
    url,
  ];
  const headResult = spawnSync("curl", headArgs, { encoding: "utf8" });
  let totalSize = 0;
  const headOutput = String(headResult.stdout || "");
  const contentLengthMatch = /content-length:\s*(\d+)/i.exec(headOutput);
  if (contentLengthMatch) totalSize = Number.parseInt(contentLengthMatch[1], 10);
  
  if (totalSize === 0) {
    // 無法取得大小，退回單執行緒
    return curlChunk(url, dest, referer, maxSec);
  }
  
  // 分段
  const segmentSize = Math.ceil(totalSize / threads);
  const segmentFiles = [];
  const curlConfigFile = path.join(os.tmpdir(), `hg-parallel-${process.pid}-${Date.now()}.txt`);
  
  try {
    let configContent = "";
    for (let i = 0; i < threads; i++) {
      const start = i * segmentSize;
      const end = Math.min(start + segmentSize - 1, totalSize - 1);
      if (start > end) break;
      const segmentFile = `${dest}.part${i}`;
      segmentFiles.push({ file: segmentFile, start, end });
      configContent += `url = "${url.replace(/"/g, '\\"')}"\n`;
      configContent += `range = "${start}-${end}"\n`;
      configContent += `output = "${segmentFile}"\n`;
      configContent += `header = "User-Agent: ${DOWNLOAD_UA}"\n`;
      configContent += `header = "Referer: ${referer || "https://novel.snssdk.com/"}"\n`;
      configContent += `max-time = ${maxSec}\n`;
      configContent += `speed-time = 60\n`;
      configContent += `speed-limit = 1000\n`;
      configContent += `continue_at = -\n`;  // 續傳
      configContent += `\n`;
    }
    fs.writeFileSync(curlConfigFile, configContent, "utf8");
    
    // 執行並行下載
    const parallelArgs = [
      "--parallel",
      "--parallel-max", String(threads),
      "--config", curlConfigFile,
      "-sS", "-L", "--compressed",
    ];
    const result = spawnSync("curl", parallelArgs, { 
      encoding: "utf8", 
      maxBuffer: 1024 * 1024,
      timeout: maxSec * 1000 * 2 
    });
    
    // 檢查結果並合併
    let downloaded = 0;
    let allOk = true;
    for (const seg of segmentFiles) {
      try {
        const stat = fs.statSync(seg.file);
        downloaded += stat.size;
        if (stat.size === 0) allOk = false;
      } catch {
        allOk = false;
      }
    }
    
    if (allOk && downloaded > 0) {
      // 合併分段
      const writeStream = fs.createWriteStream(dest);
      for (const seg of segmentFiles) {
        const data = fs.readFileSync(seg.file);
        writeStream.write(data);
        try { fs.unlinkSync(seg.file); } catch { /* 忽略 */ }
      }
      writeStream.end();
      
      // 等待寫入完成
      await new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
      
      return {
        exit: 0,
        httpStatus: 200,
        transferred: downloaded,
        bytes: downloaded,
        total: totalSize,
        error: "",
      };
    }
    
    // 失敗時清理並退回單執行緒
    for (const seg of segmentFiles) {
      try { fs.unlinkSync(seg.file); } catch { /* 忽略 */ }
    }
    return curlChunk(url, dest, referer, maxSec);
  } finally {
    try { fs.unlinkSync(curlConfigFile); } catch { /* 忽略 */ }
  }
}

// 解析度策略：優先 target → 1080 → 720；都沒有但最高仍 ≥720 就用最高；
// 最高低於 720p 回傳 variant=null（呼叫端應停止整條佇列）。
// 同一部劇以第一集實際選到的解析度為 target，之後各集对齐，缺檔才降級並提示。
function selectQuality(media, target) {
  const all = (Array.isArray(media.variants) ? media.variants : [])
    .filter((variant) => variant && variant.url);
  if (all.length === 0 && media.url) {
    all.push({ url: media.url, quality: media.quality || 0 });
  }
  const usable = all.filter((variant) => variant.quality >= 720).sort((a, b) => b.quality - a.quality);
  const best = all.reduce((maximum, variant) => Math.max(maximum, variant.quality || 0), 0);
  if (usable.length === 0) {
    return { variant: null, best, downgraded: false };
  }
  const order = [target, 1080, 720].filter((height, index, array) =>
    array.indexOf(height) === index && height >= 720);
  for (const height of order) {
    const found = usable.find((variant) => variant.quality === height);
    if (found) {
      return { variant: found, best, downgraded: found.quality !== target };
    }
  }
  // 沒有 target/1080/720，但有其他 ≥720 的解析度 → 用最高的
  return { variant: usable[0], best, downgraded: usable[0].quality !== target };
}

// 寫入狀態檔前先讀回磁碟上的 paused，
// 避免下載流程用自己的記憶體狀態把外部的 --pause 覆寫掉（lost update）。
function saveCtx(ctx) {
  const disk = loadIndex(ctx.indexFile);
  if (disk && typeof disk.paused === "boolean") ctx.state.paused = disk.paused;
  saveIndex(ctx.indexFile, ctx.state);
}

// 下載單集：取流（每集重取，避免網址過期）→ 分段續傳下載
// 回傳 "done" | "failed" | "paused" | "removed"
async function downloadEpisode(ctx, record) {
  const chapter = chapterOfRecord(record, ctx.state);
  record.status = "downloading";
  record.attempts += 1;
  record.error = "";
  saveCtx(ctx);

  let media = null;
  try {
    media = ctx.api.resolveMedia({ dramaId: ctx.state.drama.id, chapter });
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
    saveCtx(ctx);
    ctx.onProgress(record, "取流失敗");
    return "failed";
  }
  if (!media || !media.url) {
    record.status = "failed";
    record.error = "未回傳播放地址";
    saveCtx(ctx);
    return "failed";
  }
  record.url = media.url;
  record.quality = media.quality || 0;
  record.durationMs = media.durationMs || 0;
  record.referer = media.referer || "";
  record.cencKey = media.cencKey || "";
  record.resolvedAt = Date.now();
  record.file = record.file || episodeFilePath(record, ctx.state);

  // 解析度策略（僅 App 線路；--web-360p 是明示要 360p，聽書也不適用）
  if (!ctx.options.web360 && !record.scheme.startsWith(AUDIO_SCHEME)) {
    const target = ctx.state.qualityTarget || 1080;
    const picked = selectQuality(media, target);
    if (!picked.variant) {
      record.status = "failed";
      record.error = `最高僅 ${picked.best}p，低於 720p，停止下載`;
      record.stopQueue = true;
      saveCtx(ctx);
      ctx.onProgress(record, "解析度過低");
      return "failed";
    }
    record.url = picked.variant.url;
    record.quality = picked.variant.quality;
    if (!ctx.state.qualityTarget) ctx.state.qualityTarget = picked.variant.quality;
    if (picked.downgraded) {
      const message = `第 ${record.episode} 集沒有 ${target}p，改用 ${picked.variant.quality}p`;
      record.downgraded = message;
      if (!ctx.options.json) console.log(`\r⚠️  ${message}`);
    }
  }

  // --web-360p：改用網站自架的 360p 明文（免解密、網站 CDN 速度快），取不到再退回 App 線路
  if (ctx.options.web360 && !record.scheme.startsWith(AUDIO_SCHEME)) {
    const webUrl = `${SITE_BASE}/video/public/${record.videoId}/360p.mp4`;
    try {
      const probe = ctx.host.fetch({
        method: "GET",
        url: webUrl,
        timeoutMs: 15000,
        followRedirects: true,
        headers: { "User-Agent": WEB_USER_AGENT, Accept: "*/*", Range: "bytes=0-0" },
      });
      if (probe.status === 200 || probe.status === 206) {
        record.web360p = webUrl;
        record.url = webUrl;
        record.referer = SITE_BASE + "/";
        record.quality = 360;
        record.cencKey = "";
      }
    } catch { /* 沒有網頁預覽就用 App 線路 */ }
  }
  saveCtx(ctx);
  if (record.cencKey) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(record.file)), { recursive: true });
      fs.writeFileSync(path.resolve(record.file) + ".cenc.key", record.cencKey + "\n", "utf8");
    } catch { /* 金鑰檔寫不進來不影響下載 */ }
  }

  // 解密：下載完成後用 ffmpeg 把 CENC 加密的 MP4 轉成明文。
  // 失敗不丟擲（不中斷整個佇列），改回報結果讓上層記錄。
  async function decryptIfNeeded(filePath, cencKey) {
    if (!cencKey) return { ok: true, skipped: true };
    const decryptedPath = filePath + ".dec.mp4";
    try {
      const keyHex = Buffer.from(cencKey, "base64").toString("hex");
      const result = spawnSync("ffmpeg", [
        "-v", "error",
        "-y",
        "-decryption_key", keyHex,
        "-i", filePath,
        "-c", "copy",
        "-movflags", "+faststart",
        decryptedPath,
      ], { encoding: "utf8", timeout: 300000 });
      const decryptedOk = result.status === 0 && fs.existsSync(decryptedPath)
        && fs.statSync(decryptedPath).size > 0;
      if (!decryptedOk) {
        throw new Error(String(result.stderr || "").trim().slice(0, 300) || ("ffmpeg exit " + result.status));
      }
      // 解密成功：用解密後檔案取代原檔，金鑰檔即可移除
      fs.renameSync(decryptedPath, filePath);
      try { fs.unlinkSync(filePath + ".cenc.key"); } catch { /* 忽略 */ }
      return { ok: true };
    } catch (error) {
      try { fs.unlinkSync(decryptedPath); } catch { /* 保留加密原檔與金鑰，之後可手動重試 */ }
      return { ok: false, error: error.message };
    }
  }
 
  const dest = path.resolve(record.file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const maxSec = Math.max(5, Math.min(ctx.options.timeout, 30));
  let failures = 0;
  let resolveAttempts = 0;

  for (;;) {
    // 另一個行程可能已下 --pause / --remove，每段都重新讀磁碟狀態
    const disk = loadIndex(ctx.indexFile);
    if (disk) {
      if (disk.paused === true) {
        record.status = "paused";
        saveCtx(ctx);
        return "paused";
      }
      if (!disk.episodes[String(record.episode)]) {
        return "removed";
      }
    }
    let bytes = 0;
    try { bytes = fs.statSync(dest).size; } catch { /* 尚未建立 */ }
    record.bytes = bytes;
    if (record.totalBytes > 0 && bytes >= record.totalBytes) {
      record.status = "done";
      record.error = "";
      saveCtx(ctx);
      ctx.onProgress(record, "完成");
      if (record.cencKey) {
        ctx.onProgress(record, "解密中");
        const dec = await decryptIfNeeded(dest, record.cencKey);
        record.decrypted = dec.ok === true;
        record.decryptError = dec.ok === true ? "" : (dec.error || "解密失敗");
        if (dec.ok === true) record.error = "";
        saveCtx(ctx);
      }
      return "done";
    }
    ctx.onProgress(record, "下載中");
    let chunk;
    if (ctx.options.threads > 1) {
      chunk = await curlParallel(record.url, dest, record.referer, maxSec, ctx.options.threads);
    } else {
      chunk = curlChunk(record.url, dest, record.referer, maxSec);
    }
    record.bytes = chunk.bytes;

    if (chunk.httpStatus === 416 || (chunk.exit === 0 && chunk.httpStatus >= 200 && chunk.httpStatus < 300)) {
      // 完整回應（或檔案早已下完而收到 416）
      const complete = record.totalBytes === 0 || chunk.bytes >= record.totalBytes;
      if (complete) {
        record.status = "done";
        record.error = "";
        saveCtx(ctx);
        ctx.onProgress(record, "完成");
        if (record.cencKey) {
          ctx.onProgress(record, "解密中");
          const dec = await decryptIfNeeded(dest, record.cencKey);
          record.decrypted = dec.ok === true;
          record.decryptError = dec.ok === true ? "" : (dec.error || "解密失敗");
          if (dec.ok === true) record.error = "";
          saveCtx(ctx);
        }
        return "done";
      }
      // 檔案已有部分長度卻收到完整 200（伺服器不支援續傳）→ 砍掉重下
      try { fs.unlinkSync(dest); } catch { /* 忽略 */ }
      record.bytes = 0;
      record.totalBytes = chunk.total;
      saveCtx(ctx);
      failures += 1;
    } else if (chunk.exit === 28 && chunk.transferred > 0) {
      // 正常分段（本段有進度），繼續下一段
      saveCtx(ctx);
      continue;
    } else {
      failures += 1;
    }

    if (failures < 3) {
      saveCtx(ctx);
      continue;
    }
    failures = 0;
    resolveAttempts += 1;
    if (resolveAttempts >= 3) {
      record.status = "failed";
      record.error = chunk.error || `curl exit ${chunk.exit} / HTTP ${chunk.httpStatus}`;
      saveCtx(ctx);
      ctx.onProgress(record, "失敗");
      return "failed";
    }
    // 連續失敗：重新解析新網址（舊網址可能已過期）再試
    try {
      media = ctx.api.resolveMedia({ dramaId: ctx.state.drama.id, chapter });
      record.url = media.url || record.url;
      record.referer = media.referer || record.referer;
      record.resolvedAt = Date.now();
      saveCtx(ctx);
    } catch (error) {
      record.status = "failed";
      record.error = error.message;
      saveCtx(ctx);
      return "failed";
    }
  }
}

function orderedRecords(state) {
  return Object.values(state.episodes || {})
    .map((record) => ({ ...record, episode: Number(record.episode) }))
    .sort((left, right) => left.episode - right.episode);
}

function resetStaleDownloads(state) {
  for (const record of Object.values(state.episodes || {})) {
    if (record.status === "downloading") record.status = "paused"; // 上次被中斷的部分檔案
  }
}

// 跑整個下載佇列；回傳摘要
async function runDownloader(ctx) {
  const records = orderedRecords(ctx.state);
  const pending = records.filter((record) => record.status !== "done");
  let done = 0;
  let failed = 0;
  const stopped = { reason: "" };
  if (!ctx.options.json) {
    console.log(`\n開始下載：${pending.length} 集待處理（共 ${records.length} 集）`);
    console.log(`狀態檔：${ctx.indexFile}`);
    console.log(`目標解析度：${ctx.state.qualityTarget || 1080}p（沒有才 720p；低於 720p 停止）`);
    console.log("（下載途中可用 --status 看進度、--pause 暫停、Ctrl-C 中斷於分段處）\n");
  }
  for (const [index, record] of pending.entries()) {
    const disk = loadIndex(ctx.indexFile);
    if (disk && disk.paused === true) {
      stopped.reason = "paused";
      ctx.state.paused = true;
      saveCtx(ctx);
      if (!ctx.options.json) console.log(`\n已暫停（第 ${record.episode} 集之前）。--resume 可繼續。`);
      break;
    }
    if (!ctx.options.json) {
      process.stdout.write(`\r[${index + 1}/${pending.length}] 第 ${record.episode} 集 ${record.title || record.videoId} ...`.padEnd(120));
    }
    const result = await downloadEpisode(ctx, ctx.state.episodes[String(record.episode)]);
    if (result === "done") done += 1;
    else if (result === "failed") failed += 1;
    else if (result === "paused") { stopped.reason = "paused"; break; }
    // "removed" — 已被另一個行程移除，直接跳過
    if (ctx.state.episodes[String(record.episode)]?.stopQueue === true) {
      stopped.reason = "quality";
      if (!ctx.options.json) {
        console.log(`\n⛔ 第 ${record.episode} 集解析度低於 720p，已停止後續下載。`);
      }
      break;
    }
  }
  const summary = { done, failed, stopped: stopped.reason };
  if (!ctx.options.json) {
    process.stdout.write("\r");
    const counts = orderedRecords(ctx.state).reduce((acc, record) => {
      acc[record.status] = (acc[record.status] || 0) + 1;
      return acc;
    }, {});
    console.log("-".repeat(100));
    console.log(`本輪完成 ${done} 集${failed > 0 ? `，失敗 ${failed} 集` : ""}` +
      `${stopped.reason === "paused" ? "，已暫停" : ""}` +
      `${stopped.reason === "quality" ? "，因解析度低於 720p 停止" : ""}`);
    console.log(`目前狀態：完成 ${counts.done || 0}｜佇列 ${counts.queued || 0}｜暫停 ${counts.paused || 0}｜失敗 ${counts.failed || 0}`);
  }
  return summary;
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// 管理指令（--status / --pause / --remove / --clear-* / --resume）
// --------------------------------------------------------------------------

function manageCommands(options) {
  const indexFile = options.index || "index.json";
  const state = loadIndex(indexFile);
  if (!state) {
    console.error(`找不到下載狀態檔：${indexFile}（先以 -d 下載過就會產生）`);
    process.exitCode = 1;
    return true;
  }
  if (options.pause) {
    state.paused = true;
    saveIndex(indexFile, state);
    console.log(`已暫停：${indexFile}（進行中的檔案會在下一個分段處停損，--resume 可續傳）`);
    return true;
  }
  if (options.clearQueued) {
    const removed = [];
    for (const record of Object.values(state.episodes)) {
      if (record.status === "queued") {
        removed.push(Number(record.episode));
        delete state.episodes[String(record.episode)];
      }
    }
    saveIndex(indexFile, state);
    console.log(`已清除佇列項目 ${removed.length} 筆${removed.length > 0 ? "：" + removed.join(", ") : ""}`);
    return true;
  }
  if (options.clearAll) {
    const files = [];
    for (const record of Object.values(state.episodes)) {
      if (record.file) files.push(path.resolve(record.file));
    }
    const count = Object.keys(state.episodes).length;
    state.episodes = {};
    state.paused = false;
    saveIndex(indexFile, state);
    if (options.withFiles) {
      for (const file of files) {
        try { fs.unlinkSync(file); } catch { /* 可能已不存在 */ }
        try { fs.unlinkSync(file + ".cenc.key"); } catch { /* 忽略 */ }
      }
    }
    console.log(`已清除全部 ${count} 筆項目${options.withFiles ? "（含檔案）" : "（保留檔案，加 --with-files 可一併刪除）"}`);
    return true;
  }
  if (options.remove !== null && options.remove !== undefined) {
    const wanted = parseEpisodes(options.remove);
    const removed = [];
    const files = [];
    for (const episode of wanted) {
      const record = state.episodes[String(episode)];
      if (!record) continue;
      removed.push(episode);
      if (record.file) files.push(path.resolve(record.file));
      delete state.episodes[String(episode)];
    }
    saveIndex(indexFile, state);
    if (options.withFiles) {
      for (const file of files) {
        try { fs.unlinkSync(file); } catch { /* 可能已不存在 */ }
        try { fs.unlinkSync(file + ".cenc.key"); } catch { /* 忽略 */ }
      }
    }
    const missing = wanted.filter((episode) => !removed.includes(episode));
    console.log(`已移除 ${removed.length} 集${removed.length > 0 ? "：" + removed.join(", ") : ""}` +
      (missing.length > 0 ? `（不在狀態檔中：${missing.join(", ")}）` : "") +
      (options.withFiles ? "（含檔案）" : ""));
    return true;
  }
  if (options.status) {
    printStatus(indexFile, state);
    return true;
  }
  return false;
}

function printStatus(indexFile, state) {
  const records = orderedRecords(state);
  const counts = records.reduce((acc, record) => {
    acc[record.status] = (acc[record.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`狀態檔：${indexFile}`);
  console.log(`劇集：${state.drama.title || ""} [${state.drama.sourceId}]`);
  console.log(`下載目錄：downloads/hongguo_${state.drama.sourceId}`);
  console.log(`暫停狀態：${state.paused === true ? "已暫停（--resume 繼續）" : "下載中/可下載"}`);
  console.log(`總覽：完成 ${counts.done || 0}｜佇列 ${counts.queued || 0}｜暫停 ${counts.paused || 0}｜下載中 ${counts.downloading || 0}｜失敗 ${counts.failed || 0}｜共計 ${records.length}`);
  if (records.length === 0) return;
  console.log(`\n${padDisplay("集數", 6)} ${padDisplay("狀態", 10)} ${padDisplay("進度", 22)} ${padDisplay("大小", 14)} 檔案`);
  console.log("-".repeat(110));
  for (const record of records) {
    let progress = "-";
    if (record.status === "done") progress = "100%";
    else if (record.totalBytes > 0) progress = `${Math.floor(record.bytes / record.totalBytes * 100)}%`;
    const size = record.totalBytes > 0
      ? `${formatBytes(record.bytes)}/${formatBytes(record.totalBytes)}`
      : formatBytes(record.bytes);
    const flags = [];
    if (record.decrypted === true) flags.push("已解密");
    if (record.cencKey && record.decrypted !== true && record.status === "done") flags.push("待解密");
    console.log(`${padDisplay(record.episode, 6)} ${padDisplay(record.status, 10)} ${padDisplay(progress, 22)} ${padDisplay(size, 14)} ${record.file || ""}${flags.length > 0 ? "（" + flags.join("、") + "）" : ""}`);
    if (record.error) console.log(`${" ".repeat(18)}錯誤：${record.error}`);
    if (record.decryptError) console.log(`${" ".repeat(18)}解密失敗：${record.decryptError}`);
  }
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const indexFile = options.index || "index.json";
  const management = options.status || options.pause || options.remove !== null
    || options.clearQueued || options.clearAll;
  if (options.help || (!options.keyword && !management && !options.resume && !options.download)) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8")
      .split("/**")[1].split("*/")[0]
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, ""))
      .join("\n").trim());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  // 不需要連網的管理指令
  if (management && manageCommands(options)) return;

  const modulePath = findModule(options.module);
  const host = createHost({ modulePath, verbose: options.verbose, timeoutSec: options.timeout });
  const api = loadModule(modulePath, host);

  const downloadCtx = {
    api,
    host,
    options,
    indexFile,
    state: null,
    onProgress: (record, phase) => {
      if (!options.json) {
        const pct = record.totalBytes > 0 ? Math.floor(record.bytes / record.totalBytes * 100) : 0;
        process.stdout.write(`\r[${record.episode}] ${phase} ${pct}% ` +
          `${formatBytes(record.bytes)}/${formatBytes(record.totalBytes)} ${record.title || record.videoId}`.padEnd(120));
      }
    },
  };

  // --resume（或沒給關鍵字的 -d）：直接沿用既有狀態檔續下
  if ((options.resume || options.download) && !options.keyword) {
    const state = loadIndex(indexFile);
    if (!state) {
      console.error(`找不到下載狀態檔：${indexFile}，無法續傳（請用 -d 搭配關鍵字重新開始）`);
      process.exitCode = 1;
      return;
    }
    state.paused = false;
    resetStaleDownloads(state);
    saveIndex(indexFile, state);
    downloadCtx.state = state;
    const summary = await runDownloader(downloadCtx);
    if (options.json) console.log(JSON.stringify(state, null, 2));
    if (summary.failed > 0) process.exitCode = 1;
    return;
  }

  const keyword = options.keyword.trim();
  if (!options.json) {
    console.log(`搜索關鍵字：${keyword}`);
    console.log(`（站源模組：${modulePath}）`);
  }

  let search;
  try {
    search = api.search(options.page, keyword);
  } catch (error) {
    console.error("搜尋失敗：" + error.message);
    process.exitCode = 1;
    return;
  }
  const items = Array.isArray(search.items) ? search.items : [];
  if (search.warning && !options.json) console.log(`（提示：${search.warning}）`);
  if (items.length === 0) {
    console.error("未搜索到任何劇集。");
    process.exitCode = 1;
    return;
  }

  if (!options.json) {
    console.log("\n搜尋結果：");
    items.forEach((item, index) => {
      const kind = String(item.id).includes(":book-") ? "听书" : "短剧";
      console.log(`  ${index + 1}. [${item.sourceId || ""}] ${item.title || item.name || ""}（${kind}）`);
    });
  }

  let choice = options.choice;
  if (choice === null) {
    if (!process.stdin.isTTY) {
      console.error("\n非互動環境，請在第二個參數指定編號，例如：" + path.basename(process.argv[1]) + ' "' + keyword + '" 1');
      process.exitCode = 1;
      return;
    }
    const answer = await askQuestion("\n請輸入要列出 URL 的劇集編號（預設 1）：");
    const parsed = Number.parseInt(String(answer).trim(), 10);
    choice = Number.isNaN(parsed) ? 1 : parsed;
  }
  if (choice < 1 || choice > items.length) {
    console.log(`\n編號無效（範圍 1-${items.length}），已自動選擇第 1 個。`);
    choice = 1;
  }

  const drama = items[choice - 1];
  const dramaId = String(drama.id || "");
  const sourceId = String(drama.sourceId || dramaId.replace(/^hongguo:/, ""));
  const title = String(drama.title || drama.name || sourceId);
  if (!options.json) console.log(`\n已選擇：[${choice}] [${sourceId}] ${title}`);

  let detail;
  try {
    detail = api.detail(sourceId);
  } catch (error) {
    console.error("取得分集失敗：" + error.message);
    process.exitCode = 1;
    return;
  }
  const chapters = Array.isArray(detail.chapters) ? detail.chapters : [];
  if (chapters.length === 0) {
    console.error("未找到分集，可能是頁面結構已變更或需要登入。");
    process.exitCode = 1;
    return;
  }
  if (!options.json) console.log(`\n共 ${chapters.length} 集數`);

  // 沒給 --range 就是全部集數（下載路徑曾漏掉這個預設，picked 為 null 會擲 "picked is not iterable"）
  const picked = parseRange(options.range, chapters.length) || chapters.map((_, index) => index + 1);

  // -d：建立/更新下載狀態檔並逐集下載（取一流→馬上下載→下一集，避開網址時效）
  if (options.download) {
    let state = loadIndex(indexFile);
    if (state && state.drama && state.drama.sourceId !== sourceId) {
      const rotated = `index.${state.drama.sourceId}.json`;
      try {
        fs.renameSync(path.resolve(indexFile), path.resolve(rotated));
        if (!options.json) console.log(`（既有狀態檔屬於其他劇集，已轉存為 ${rotated}）`);
      } catch { /* 搬不動就覆蓋 */ }
      state = null;
    }
    if (!state) {
      state = {
        version: 1,
        drama: { id: dramaId, sourceId, title },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        paused: false,
        qualityTarget: 1080, // 目標解析度：優先 1080p，沒有才 720p，低於 720p 停止
        episodes: {},
      };
    } else {
      state.drama = { id: dramaId, sourceId, title };
    }
    for (const episode of picked) {
      const chapter = chapters[episode - 1];
      const key = String(episode);
      const videoId = stripScheme(String(chapter.videoUrl || ""), [CENC_SCHEME, AUDIO_SCHEME]);
      const scheme = String(chapter.videoUrl || "").startsWith(AUDIO_SCHEME) ? AUDIO_SCHEME : CENC_SCHEME;
      const existing = state.episodes[key];
      if (existing && existing.videoId === videoId) {
        existing.title = chapter.title || existing.title;
        existing.scheme = scheme;
        if (existing.status === "downloading") existing.status = "paused";
      } else {
        state.episodes[key] = newEpisodeRecord(episode, videoId, scheme);
        state.episodes[key].title = chapter.title || `第${episode}集`;
        state.episodes[key].file = path.join("downloads", `hongguo_${sourceId}`, episodeFileName(state.episodes[key]));
      }
    }
    resetStaleDownloads(state);
    saveIndex(indexFile, state);
    if (!options.json) {
      console.log(`\n已建立/更新下載狀態：${indexFile}（${picked.length} 集）`);
    }
    downloadCtx.state = state;
    const summary = await runDownloader(downloadCtx);
    if (options.json) console.log(JSON.stringify(state, null, 2));
    if (summary.failed > 0) process.exitCode = 1;
    return;
  }

  if (options.noMedia) {
    if (!options.json) {
      console.log(`\n${"集數".padEnd(8)}${"影片 ID".padEnd(24)}標題`);
      console.log("-".repeat(80));
      picked.forEach((episode) => {
        const chapter = chapters[episode - 1];
        const videoId = stripScheme(String(chapter.videoUrl || ""), ["hongguo-cenc://", "hongguo-audio://"]);
        console.log(`${padDisplay(episode, 6)}   ${padDisplay(videoId, 24)}${chapter.title || ""}`);
      });
      console.log("-".repeat(80));
      console.log(`（--no-media：未逐集取播放網址）`);
    } else {
      console.log(JSON.stringify(picked.map((episode) => {
        const chapter = chapters[episode - 1];
        return {
          episode,
          videoId: stripScheme(String(chapter.videoUrl || ""), ["hongguo-cenc://", "hongguo-audio://"]),
          title: chapter.title || "",
        };
      }), null, 2));
    }
    return;
  }

  const outFile = options.out || `hongguo_${sourceId}_urls.txt`;
  const episodes = [];
  const failures = [];
  const urlLines = [];

  if (!options.json) {
    console.log("\n正在逐集取得播放地址...\n");
    console.log(`${padDisplay("集數", 6)} ${padDisplay("影片 ID", 22)} ${padDisplay("清晰度", 8)} MP4 下載網址`);
    console.log("-".repeat(120));
  }

  const targets = picked || chapters.map((_, index) => index + 1);
  const web360Lines = [];
  for (const episode of targets) {
    const chapter = chapters[episode - 1];
    const videoId = stripScheme(String(chapter.videoUrl || ""), ["hongguo-cenc://", "hongguo-audio://"]);
    if (!options.json) process.stdout.write(`\r[${episode}/${chapters.length}] 第 ${episode} 集 ${videoId} ...`.padEnd(100));
    let media = null;
    let error = null;
    try {
      media = api.resolveMedia({ dramaId, chapter });
    } catch (thrown) {
      error = thrown;
    }
    if (error || !media || !media.url) {
      failures.push({ episode, videoId, message: error ? error.message : "未回傳播放地址" });
      if (!options.json) {
        process.stdout.write("\r");
        console.log(`${padDisplay(episode, 6)} ${padDisplay(videoId, 22)} [獲取失敗]`);
      }
      if (options.stop) break;
      continue;
    }
    const variants = (Array.isArray(media.variants) ? media.variants : []).filter((item) => item && item.url);
    const quality = media.quality > 0 ? `${media.quality}p` : "";
    const record = {
      episode,
      videoId,
      url: media.url,
      quality: media.quality || 0,
      durationMs: media.durationMs || 0,
      referer: media.referer || "",
      cencKey: media.cencKey || "",
      web360p: "",
      variants: variants.map((item) => ({ url: item.url, quality: item.quality || 0 })),
    };
    if (options.web360 && !String(chapter.videoUrl || "").startsWith("hongguo-audio://")) {
      const address = `${SITE_BASE}/video/public/${videoId}/360p.mp4`;
      try {
        const probe = host.fetch({
          method: "GET",
          url: address,
          timeoutMs: 15000,
          followRedirects: true,
          headers: { "User-Agent": WEB_USER_AGENT, Accept: "*/*", Range: "bytes=0-0" },
        });
        if (probe.status === 200 || probe.status === 206) {
          record.web360p = address;
          web360Lines.push(address);
        }
      } catch { /* 該集沒有網頁預覽就略過 */ }
    }
    episodes.push(record);
    for (const variant of (options.all ? variants : variants.slice(0, 1))) {
      urlLines.push(variant.url);
    }
    if (!options.json) {
      process.stdout.write("\r");
      console.log(`${padDisplay(episode, 6)} ${padDisplay(videoId, 22)} ${padDisplay(quality, 8)} ${media.url}`);
      if (record.web360p) {
        console.log(`${" ".repeat(6)} ${" ".repeat(22)} ${" ".repeat(8)} └─ web 360p：${record.web360p}`);
      }
    }
  }

  fs.writeFileSync(outFile, urlLines.join("\n") + (urlLines.length > 0 ? "\n" : ""), "utf8");

  if (!options.json) {
    console.log("-".repeat(120));
    if (failures.length > 0) {
      console.log(`完成：成功 ${episodes.length} 集，失敗 ${failures.length} 集。`);
      for (const failure of failures) {
        console.log(`  第 ${failure.episode} 集（${failure.videoId}）：${failure.message}`);
      }
    } else {
      console.log(`完成：成功 ${episodes.length} 集，失敗 0 集。`);
    }
    const encrypted = episodes.filter((episode) => episode.cencKey);
    if (encrypted.length > 0) {
      console.log(`注意：${encrypted.length} 集的 App 線路為 CENC 加密影片，需搭配 cencKey 解密才能播放；` +
        `需要明文離線檔時可用 --web-360p（網站自架 360p 預覽）。`);
    }
    if (episodes.some((episode) => episode.referer && episode.referer !== SITE_BASE + "/")) {
      console.log(`提示：CDN 網址需帶 Referer，例如：wget --referer=${episodes.find((e) => e.referer).referer} -i ${outFile}`);
    }
    console.log(`所有可用的 MP4 網址已儲存至：${outFile}`);
    console.log("若需批量下載，可使用：wget -i " + outFile);
    console.log("（CDN 網址帶時效簽名，重新整理請重跑本程式；--json 可輸出含 cencKey 的完整資訊）");
    if (options.web360) {
      const webFile = (options.out || `hongguo_${sourceId}_urls.txt`).replace(/\.txt$/, "") + "_web360p_urls.txt";
      fs.writeFileSync(webFile, web360Lines.join("\n") + (web360Lines.length > 0 ? "\n" : ""), "utf8");
      console.log(`網頁 360p 明文預覽網址（${web360Lines.length} 集）已儲存至：${webFile}`);
    }
    if (options.all) {
      const variantFile = (options.out || `hongguo_${sourceId}_urls.txt`).replace(/\.txt$/, "") + "_variants.txt";
      const lines = episodes.flatMap((episode) => episode.variants.map((variant) =>
        `${episode.episode}\t${variant.quality}p\t${variant.url}`));
      fs.writeFileSync(variantFile, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
      console.log(`所有清晰度線路已儲存至：${variantFile}`);
    }
  } else {
    console.log(JSON.stringify({
      drama: { id: dramaId, sourceId, title },
      module: modulePath,
      outFile,
      web360pOutFile: options.web360 ? (options.out || `hongguo_${sourceId}_urls.txt`).replace(/\.txt$/, "") + "_web360p_urls.txt" : null,
      episodes,
      failures,
    }, null, 2));
  }

  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Fatal: " + (error && error.message ? error.message : error));
  process.exit(1);
});

