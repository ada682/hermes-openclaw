/**
 * deepseek-reverse-proxy.js — Full DeepSeek reverse proxy with ByteDance telemetry
 *
 * Features (semua dari kode asli + telemetry):
 *  • OpenAI-compatible /v1/chat/completions  (streaming + non-streaming)
 *  • /v1/models endpoint
 *  • Multi-token pool (DEEPSEEK_TOKEN_1..10) + auto-refresh access token
 *  • Custom tool calling (system-prompt injection + <tool_calling> XML parser)
 *  • Web search: native search_enabled flag (x-deepseek-search header)
 *  • Thinking mode: deepseek-reasoner / -thinking / -think suffix
 *  • Vision: upload gambar ke /api/v0/file/upload_file, poll sampai ready
 *  • POW Challenge solver via WASM (sha3.wasm)
 *  • Image + Doc file-ID cache (10/30 menit) — context continuity multi-turn
 *  • Retry otomatis (overloaded/timeout) — rotate slot, SSE keep-alive comment
 *  • HIF integrity tokens (x-hif-dliq / x-hif-leim) auto-fetch
 *  • Settings token (x-settings-token) fetch
 *  • ByteDance telemetry (gator.volces.com) dengan event realistis
 *  • Pre-create session & delete session (seperti browser)
 *  • Throttling & cooldown anti-ban
 *
 * Env vars:
 *   DEEPSEEK_TOKEN_1..10             – DeepSeek refresh tokens
 *   DEEPSEEK_COOKIE_1..10            – cookie (ds_session_id, smidV2, dll)
 *   DEEPSEEK_PROXY_PORT              – port (default: 4893)
 *   DEEPSEEK_MODEL                   – default model (default: deepseek-chat)
 *   DEEPSEEK_SHOW_THINKING           – emit reasoning_content delta (default: false)
 *   DEEPSEEK_WASM_PATH               – path ke .wasm (default: ./sha3.wasm)
 *   DEEPSEEK_IMAGE_CACHE_TTL         – ms (default: 600000 = 10 menit)
 *   DEEPSEEK_DOC_CACHE_TTL           – ms (default: 1800000 = 30 menit)
 *   DEEPSEEK_STREAM_IDLE_TIMEOUT     – ms (default: 90000)
 *   DEEPSEEK_STREAM_TOTAL_TIMEOUT    – ms (default: 300000)
 *   DEEPSEEK_OVERLOADED_RETRY        – max retry attempts (default: 3)
 *   DEEPSEEK_OVERLOADED_DELAY        – base delay ms per retry (default: 3000)
 *   DEEPSEEK_GLOBAL_GAP_MS           – min gap antar request (default: 1500)
 *   DEEPSEEK_SLOT_GAP_MS             – per-slot gap (default: 8000)
 *   DEEPSEEK_BAN_COOLDOWN_MS         – cooldown jika kena ban (default: 24h)
 *   DEEPSEEK_HIF_REFRESH_MS          – HIF refresh interval (default: 8m)
 *   DEEPSEEK_TELEMETRY_ENABLED       – set "false" to disable (default: true)
 */

import http   from "http";
import https  from "https";
import crypto from "crypto";
import zlib   from "zlib";
import fs     from "fs";
import path   from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env.deepseek (lalu fallback .env) SEBELUM semua konstanta ──────────
// Key yang sudah ada di process.env (set manual / via `source`) tidak ditimpa.
(function loadDotEnv() {
  for (const envFile of [".env.deepseek", ".env"]) {
    try {
      const lines = fs.readFileSync(path.join(__dirname, envFile), "utf8").split(/\r?\n/);
      let loaded = 0;
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq < 1) continue;
        const key = t.slice(0, eq).trim();
        const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, ""); // strip quotes
        if (key && !(key in process.env)) { process.env[key] = val; loaded++; }
      }
      if (loaded > 0) {
        console.log(`[DeepSeekProxy] Loaded ${loaded} var(s) from ${envFile}`);
        break;
      }
    } catch { /* file nggak ada → lanjut */ }
  }
})();


// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const PORT          = parseInt(process.env.DEEPSEEK_PROXY_PORT  || "4893", 10);
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL                || "deepseek-chat";
const SHOW_THINKING = process.env.DEEPSEEK_SHOW_THINKING       === "true";
const WASM_PATH     = process.env.DEEPSEEK_WASM_PATH            || path.join(__dirname, "sha3.wasm");

const STREAM_IDLE_TIMEOUT_MS  = parseInt(process.env.DEEPSEEK_STREAM_IDLE_TIMEOUT  || "90000",  10);
const STREAM_TOTAL_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_STREAM_TOTAL_TIMEOUT || "300000", 10);
const IMAGE_CACHE_TTL_MS      = parseInt(process.env.DEEPSEEK_IMAGE_CACHE_TTL      || String(5 * 60 * 1000), 10);
const DOC_CACHE_TTL_MS        = parseInt(process.env.DEEPSEEK_DOC_CACHE_TTL        || String(30 * 60 * 1000), 10);
const OVERLOADED_RETRY_MAX    = parseInt(process.env.DEEPSEEK_OVERLOADED_RETRY     || "3",    10);
const OVERLOADED_RETRY_DELAY  = parseInt(process.env.DEEPSEEK_OVERLOADED_DELAY     || "3000", 10);
const HIF_REFRESH_MS          = parseInt(process.env.DEEPSEEK_HIF_REFRESH_MS       || String(8 * 60 * 1000), 10);
const TELEMETRY_ENABLED       = process.env.DEEPSEEK_TELEMETRY_ENABLED !== "false";

const BASE = "https://chat.deepseek.com";

// ── HTTPS agent ───────────────────────────────────────────────────────────────
const AGENT = new https.Agent({
  keepAlive: true, keepAliveMsecs: 30_000,
  maxSockets: 20,  timeout: 120_000,
});

// ── Fake browser headers ──────────────────────────────────────────────────────
const FAKE_HEADERS = {
  "Accept":                   "*/*",
  "Accept-Encoding":          "gzip, deflate, br, zstd",
  "Accept-Language":          "en-US,en;q=0.9",
  "Cache-Control":            "no-cache",
  "Origin":                   BASE,
  "Pragma":                   "no-cache",
  "Referer":                  BASE + "/",
  "User-Agent":               "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "X-App-Version":            "2.0.0",
  "X-Client-Bundle-Id":       "com.deepseek.chat",
  "X-Client-Locale":          "en_US",
  "X-Client-Platform":        "web",
  "X-Client-Version":         "2.0.0",
  "X-Client-Timezone-Offset": "25200",
};

// ── HIF integrity tokens (x-hif-dliq / x-hif-leim) ──────────────────────────
// DeepSeek butuh header integrity ini. Browser dapet dari endpoint khusus:
//   GET https://hif-dliq.deepseek.com/query → {data:{biz_data:{value:"<token>"}}}
// Endpoint ini STATELESS (no auth/cookie) & global (sama buat semua slot).
// Dari IP rumah sering timeout, tapi dari VPS/datacenter kebuka (200).
// Kita fetch otomatis + cache + refresh background (token basi ~10 mnt).
// Kalau env DEEPSEEK_HIF_* diisi, itu tetap menang (override manual).
const HIF_HOSTS = { dliq: "hif-dliq.deepseek.com", leim: "hif-leim.deepseek.com" };
const _hifCache = { dliq: null, leim: null };

async function fetchHifToken(host) {
  try {
    const r = await fetch(`https://${host}/query`, {
      headers: {
        "User-Agent": FAKE_HEADERS["User-Agent"],
        "Referer": BASE + "/",
        "Accept": "*/*",
        "X-Client-Platform": "web",
        "X-Client-Version": "2.0.0",
        "X-App-Version": "2.0.0",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const val = j?.data?.biz_data?.value;
    return (typeof val === "string" && val.length > 8) ? val : null;
  } catch { return null; }
}

async function refreshHif() {
  const [dliq, leim] = await Promise.all([
    fetchHifToken(HIF_HOSTS.dliq),
    fetchHifToken(HIF_HOSTS.leim),
  ]);
  if (dliq) _hifCache.dliq = dliq;
  if (leim) _hifCache.leim = leim;
  console.log(`[DeepSeekProxy] HIF refresh — dliq=${_hifCache.dliq ? "ok" : "MISS"} leim=${_hifCache.leim ? "ok" : "miss"}`);
}
// fetch sekali di startup (jangan blok listen — fire & forget), lalu periodik
refreshHif();
setInterval(refreshHif, HIF_REFRESH_MS);


// ── Model mapping ─────────────────────────────────────────────────────────────
const MODEL_ALIASES = {
  "deepseek-v4-flash": "deepseek-chat",
  "deepseek-v4-pro":   "deepseek-reasoner",
  "deepseek-r1":       "deepseek-reasoner",
  "flash":             "deepseek-chat",
  "pro":               "deepseek-reasoner",
  "r1":                "deepseek-reasoner",
  "reasoner":          "deepseek-reasoner",
};

const ALL_MODELS = [
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-r1",
  "deepseek-chat-thinking",
];

function mapModel(name) {
  let m = (name || DEFAULT_MODEL).toLowerCase();
  let thinking = false;
  if (m.endsWith("-thinking")) { thinking = true; m = m.slice(0, -9); }
  else if (m.endsWith("-think")) { thinking = true; m = m.slice(0, -6); }
  const modelId = MODEL_ALIASES[m] || m;
  if (!thinking)
    thinking = modelId === "deepseek-reasoner" || m.includes("r1") || m.includes("reasoner");
  return { modelId, thinking };
}

// ══════════════════════════════════════════════════════════════════════════════
// IMAGE CACHE (sama pola seperti kimi-reverse-proxy)
// ══════════════════════════════════════════════════════════════════════════════

const _imgHashMap    = new Map();
const _recentUploads = [];

function _imgHash(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
function _imgCacheStore(hash, fileId) {
  const ts = Date.now();
  _imgHashMap.set(hash, { fileId, ts });
  _recentUploads.push({ fileId, ts });
}
function _imgCacheGet(hash) {
  const e = _imgHashMap.get(hash);
  if (!e) return null;
  if (Date.now() - e.ts > IMAGE_CACHE_TTL_MS) { _imgHashMap.delete(hash); return null; }
  return e.fileId;
}
function _recentFileIds() {
  const cutoff = Date.now() - IMAGE_CACHE_TTL_MS;
  while (_recentUploads.length && _recentUploads[0].ts < cutoff) _recentUploads.shift();
  return [...new Set(_recentUploads.map(r => r.fileId))];
}

// ── Document MIME types ───────────────────────────────────────────────────────
const DOC_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "text/markdown",
]);
function isDocMime(m) {
  return DOC_MIME_TYPES.has((m || "").toLowerCase().split(";")[0].trim());
}

// ── Document cache (TTL lebih panjang: 30 menit default) ─────────────────────
const _docHashMap       = new Map();
const _recentDocUploads = [];

function _docCacheStore(hash, fileId) {
  const ts = Date.now();
  _docHashMap.set(hash, { fileId, ts });
  _recentDocUploads.push({ fileId, ts });
}
function _docCacheGet(hash) {
  const e = _docHashMap.get(hash);
  if (!e) return null;
  if (Date.now() - e.ts > DOC_CACHE_TTL_MS) { _docHashMap.delete(hash); return null; }
  return e.fileId;
}
function _recentDocFileIds() {
  const cutoff = Date.now() - DOC_CACHE_TTL_MS;
  while (_recentDocUploads.length && _recentDocUploads[0].ts < cutoff) _recentDocUploads.shift();
  return [...new Set(_recentDocUploads.map(r => r.fileId))];
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

async function decompress(buf, encoding) {
  const enc = (encoding || "").toLowerCase();
  if (enc.includes("gzip") || enc.includes("deflate"))
    return new Promise((rs, rj) => zlib.gunzip(buf, (e, b) => e ? rj(e) : rs(b)));
  if (enc.includes("br"))
    return new Promise((rs, rj) => zlib.brotliDecompress(buf, (e, b) => e ? rj(e) : rs(b)));
  return buf;
}

function collectBody(res) {
  return new Promise((rs, rj) => {
    const chunks = [];
    res.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    res.on("end",  () => decompress(Buffer.concat(chunks), res.headers["content-encoding"]).then(rs).catch(rj));
    res.on("error", rj);
  });
}

// ── Custom error classes (sama seperti kimi-reverse-proxy) ────────────────────
/** Dilempar kalau DeepSeek return 429 atau error overloaded di stream. */
class OverloadedError extends Error {
  constructor(msg) { super(msg); this.name = "OverloadedError"; this.isOverloaded = true; }
}

/** Dilempar kalau stream idle/total timeout — retry dengan slot berbeda. */
class StreamTimeoutError extends Error {
  constructor(msg) { super(msg); this.name = "StreamTimeoutError"; this.isTimeout = true; }
}

// ── Generate DID (device ID) untuk settings ──────────────────────────────────
function generateDid() {
  const didPath = path.join(__dirname, ".did");
  try {
    if (fs.existsSync(didPath)) return fs.readFileSync(didPath, "utf8").trim();
  } catch {}
  const did = crypto.randomUUID();
  fs.writeFileSync(didPath, did, "utf8");
  return did;
}

// ══════════════════════════════════════════════════════════════════════════════
// TELEMETRY — ByteDance Gator (gator.volces.com)
// ══════════════════════════════════════════════════════════════════════════════

const GATOR_URL = "https://gator.volces.com/list";
const TELEMETRY_USER = {
  user_unique_id: process.env.DEEPSEEK_USER_UNIQUE_ID || "0e14a5a9-8582-43d5-87cd-6f891bc7a682",
  web_id: process.env.DEEPSEEK_WEB_ID || "7651991877188626947",
};

// Bangun objek user telemetry dari slot (per-akun). Fallback ke global jika kosong.
function telemetryUserFromSlot(slot) {
  if (slot && slot.webId && slot.userUniqueId) {
    return { user_unique_id: slot.userUniqueId, web_id: slot.webId };
  }
  return TELEMETRY_USER;
}
const TELEMETRY_HEADER = {
  app_id: 20006317,
  os_name: "windows",
  os_version: "10",
  device_model: "Windows NT 10.0",
  browser: "Chrome",
  browser_version: "131.0.0.0",
  custom: JSON.stringify({
    commit_id: "df125ee4",
    commit_datetime: "2026/06/25 19:55:48",
    origin_referrer: "",
    origin_referrer_host: "",
  }),
  height: 768,
  language: "id-ID",
  platform: "web",
  referrer: "",
  referrer_host: "",
  resolution: "1366x768",
  screen_height: 768,
  screen_width: 1366,
  sdk_lib: "js",
  sdk_version: "5.2.11_tob",
  timezone: 7,
  tz_offset: -25200,
  width: 1366,
};

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function getWindowSize() {
  return {
    width: randomInt(784, 1200),
    height: randomInt(607, 900),
    screenWidth: 1366,
    screenHeight: 768,
  };
}
function jitterTimestamp(base = Date.now()) {
  const jitter = randomInt(-50, 50);
  return Math.round((base + jitter) / 10) * 10;
}
function generateRuntimeSessionId() {
  return `session_v0_${crypto.randomBytes(6).toString('hex')}`;
}

function buildTelemetryEvent(eventName, extraParams = {}, sessionIdOverride = null) {
  const win = getWindowSize();
  const now = jitterTimestamp();
  const runtimeSid = generateRuntimeSessionId();
  const sid = sessionIdOverride || "";
  const baseParams = {
    event_level: "info",
    event_message: "",
    dsp__appVersion: "2.0.0",
    dsp__commitId: "df125ee4",
    dsp__runtimeSessionId: runtimeSid,
    dsp__windowWidth: win.width,
    dsp__windowHeight: win.height,
    dsp__documentHidden: "false",
    dsp__location: sid ? `https://chat.deepseek.com/a/chat/s/${sid}` : "https://chat.deepseek.com/",
    dsp__host: "chat.deepseek.com",
    event_index: String(now + randomInt(1, 1000)),
    ...extraParams,
  };
  return {
    event: eventName,
    is_bav: 0,
    local_time_ms: now,
    params: JSON.stringify(baseParams),
    session_id: sid || "222349a3-906f-4064-9587-0552874acc84",
  };
}

async function sendTelemetry(eventsArray, user = TELEMETRY_USER) {
  if (!TELEMETRY_ENABLED || !eventsArray || eventsArray.length === 0) return;
  // Acak urutan event (seperti perilaku manusia yang tidak selalu teratur)
  const shuffled = eventsArray.sort(() => Math.random() - 0.5);
  const payload = [{
    events: shuffled,
    header: TELEMETRY_HEADER,
    local_time: Math.floor(Date.now() / 1000),
    user,
    verbose: 1,
  }];
  try {
    const r = await fetch(GATOR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "User-Agent": FAKE_HEADERS["User-Agent"],
        "Origin": "https://chat.deepseek.com",
        "Referer": "https://chat.deepseek.com/",
      },
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      console.log(`[Telemetry] Gator → HTTP ${r.status} (${shuffled.length} events)`);
    } else {
      const body = await r.text().catch(() => "");
      console.warn(`[Telemetry] Gator → HTTP ${r.status} (${shuffled.length} events) | ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[Telemetry] Gator gagal: ${e.message}`);
  }
}

/**
 * Telemetry untuk flow FILE UPLOAD — meniru event yang dikirim web asli saat
 * paste/upload gambar atau dokumen. Dipanggil dari uploadFileToDeepSeek.
 * Urutan & field disesuaikan dengan capture jaringan chat.deepseek.com.
 *
 * @param {object} info
 * @param {string} info.sessionId   chat session id (boleh "" saat belum ada sesi)
 * @param {string} info.fileId      file-xxxx dari response upload
 * @param {string} info.fileName    nama file
 * @param {string} info.ext         ekstensi (png/pdf/...)
 * @param {number} info.fileSize    ukuran byte
 * @param {string} info.modelType   default/vision/...
 * @param {boolean} info.success    upload sukses?
 * @param {string} [info.status]    PENDING/SUCCESS/...
 * @param {number} [info.tokenUsage]
 * @param {number} [info.width]
 * @param {number} [info.height]
 * @param {string} [info.auditResult]
 * @param {number} [info.elapsedMs] lama parse
 */
function sendUploadTelemetry(info) {
  if (!TELEMETRY_ENABLED) return;
  const {
    sessionId = "", fileId = "", fileName = "file", ext = "bin",
    fileSize = 0, modelType = "default", success = true,
    status = "SUCCESS", tokenUsage = null, width = null, height = null,
    auditResult = "pass", elapsedMs = randomInt(400, 700),
    user = TELEMETRY_USER,
  } = info || {};
  const ok = success ? 1 : 0;
  const sid = sessionId || "";

  // ── Fase 1: pilih & mulai upload + hasil upload ──────────────────────────
  const phase1 = [
    buildTelemetryEvent("uploadFile", {
      event_message: "选取并开始上传文件",
      ds_fileName: fileName,
    }, sid),
    buildTelemetryEvent("file_upload", {
      event_message: "文件上传",
      ds_chat_session_id: sid,
      ds_model_type: modelType,
      ds_file_source: "paste",
      ds_file_count: 1,
      ds_is_success: ok,
      ds_error_reason: "",
    }, sid),
  ];
  if (success) {
    phase1.push(
      buildTelemetryEvent("file_upload_result", {
        event_message: "文件上传结果",
        ds_file_id: fileId,
        ds_file_extension: ext,
        ds_file_size: fileSize,
        ds_is_success: 1,
        ds_error_reason: "",
        ds_model_type: modelType,
        ds_file_source: "paste",
        ds_chat_session_id: sid,
        ds_time_elapsed: elapsedMs,
      }, sid),
      buildTelemetryEvent("uploadFileSuccess", {
        event_message: "文件上传成功",
        ds_fileName: fileName,
        ds_fileId: fileId,
        ds_status: "PENDING",
      }, sid),
    );
  }
  sendTelemetry(phase1, user);

  if (!success) return;

  // ── Fase 2: fetch file info ──────────────────────────────────────────────
  sendTelemetry([
    buildTelemetryEvent("fetchFilesInfo", {
      event_message: "获取文件信息",
      ds_fileIds: fileId,
    }, sid),
  ], user);

  // ── Fase 3: hasil parse file (sukses) ────────────────────────────────────
  const parseParams = {
    event_message: "文件解析结果",
    ds_file_id: fileId,
    ds_file_extension: ext,
    ds_file_size: fileSize,
    ds_is_success: 1,
    ds_time_elapsed: elapsedMs + randomInt(5000, 7000),
    ds_error_reason: "",
    ds_model_type: modelType,
    ds_file_source: "paste",
    ds_chat_session_id: sid,
    ds_token_usage: tokenUsage,
    ds_audit_result: auditResult,
  };
  if (width != null)  parseParams.ds_image_width  = width;
  if (height != null) parseParams.ds_image_height = height;
  sendTelemetry([
    buildTelemetryEvent("file_parse_result", parseParams, sid),
    buildTelemetryEvent("parseFileSuccess", {
      event_message: "解析文件成功",
      ds_fileId: fileId,
      ds_file_name: fileName,
      ds_status: status,
      ds_error_code: "null",
      ds_stage: "parse",
    }, sid),
  ], user);
}

let _wasmExports = null;

async function loadWasm() {
  if (_wasmExports) return _wasmExports;
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(
      `[DeepSeekProxy] WASM tidak ditemukan: ${WASM_PATH}\n` +
      `Taruh 'sha3.wasm' di folder yang sama dengan deepseek-reverse-proxy.js`
    );
  }
  const bytes = fs.readFileSync(WASM_PATH);
  // Module tidak punya imports (wasmtime Python instantiate dengan [] = no imports)
  const { instance } = await WebAssembly.instantiate(bytes, {});
  _wasmExports = instance.exports;
  return _wasmExports;
}

/**
 * Encode string ASCII ke WASM linear memory.
 * Mengikuti logika coba.py: allocate(strLen, 1) → tulis bytes.
 * Challenge + prefix selalu ASCII-only.
 */
function _encodeStrToWasm(str, memory, malloc) {
  const bytes  = Buffer.from(str, "utf-8");
  const strLen = str.length;              // ASCII: char count == byte count
  const ptr    = malloc(strLen, 1) >>> 0; // unsigned 32-bit
  new Uint8Array(memory.buffer).set(bytes, ptr);
  return [ptr, bytes.length];
}

/**
 * Solve POW challenge menggunakan WASM (logika identik coba.py).
 * wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty: f64) → void
 * Return di memory[retptr]: [i32 status | 4B padding | f64 answer]
 */
async function solvePow(challengeObj) {
  const { algorithm, challenge: cStr, salt, difficulty, expire_at } = challengeObj;
  if (algorithm !== "DeepSeekHashV1")
    throw new Error(`Unsupported POW algorithm: ${algorithm}`);

  const prefix  = `${salt}_${expire_at}_`;
  const exp     = await loadWasm();
  const memory  = exp.memory;
  const addToSP = exp.__wbindgen_add_to_stack_pointer;
  const malloc  = exp.__wbindgen_export_0;
  const wSolve  = exp.wasm_solve;

  const retptr = addToSP(-16) >>> 0;
  try {
    const [ptr0, len0] = _encodeStrToWasm(cStr,   memory, malloc);
    const [ptr1, len1] = _encodeStrToWasm(prefix, memory, malloc);
    wSolve(retptr, ptr0, len0, ptr1, len1, difficulty);
    const view   = new DataView(memory.buffer);
    const status = view.getInt32(retptr,     true); // little-endian i32
    const answer = view.getFloat64(retptr+8, true); // little-endian f64 (offset+8: setelah 4B padding)
    return status === 0 ? null : Math.trunc(answer);
  } finally {
    addToSP(16);
  }
}

async function buildPowAnswer(challengeObj, targetPath = "/api/v0/chat/completion") {
  const answer = await solvePow(challengeObj);
  if (answer === null) throw new Error("POW challenge solve gagal");
  const payload = {
    algorithm:   challengeObj.algorithm,
    challenge:   challengeObj.challenge,
    salt:        challengeObj.salt,
    answer,
    signature:   challengeObj.signature,
    target_path: targetPath,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

// ══════════════════════════════════════════════════════════════════════════════
// TOKEN SLOT — access token lifecycle + session management
// ══════════════════════════════════════════════════════════════════════════════

class TokenSlot {
  constructor(raw, slotNum, cookie = "", hifDliq = "", hifLeim = "", webId = "", userUniqueId = "") {
    this.slot         = slotNum;
    this.dead         = false;
    this.refreshToken = raw;   // token asli dari user (Bearer dari browser)
    this.accessToken  = null;  // short-lived token dari /api/v0/users/current
    this.accessExpiry = 0;
    this.sessionId    = null;
    this.sessionAt    = 0;
    this._refreshing  = false;
    this._waiters     = [];
    // ── Throttle + cooldown (anti-ban) ──────────────────────────────────────
    this.lastUsedAt   = 0;     // timestamp terakhir slot ini dipakai (untuk per-slot gap)
    this.bannedUntil  = 0;     // kalau ke-ban/suspend: timestamp kapan boleh dipakai lagi
    this.banCount     = 0;     // berapa kali slot ini kena ban (untuk backoff)
    // ── Anti-bot headers (wajib diisi dari browser session) ─────────────────
    this.cookie   = cookie;    // ds_session_id=...; smidV2=...
    this.hifDliq  = hifDliq;   // x-hif-dliq  (integrity token DeepSeek)
    this.hifLeim  = hifLeim;   // x-hif-leim  (integrity token DeepSeek)
    this.settingsToken = null; // x-settings-token (didapat dari /api/v0/client/settings)
    // ── Telemetry identity (per-akun, dari telemetry payload browser) ────────
    this.webId        = webId;        // user.web_id di payload gator
    this.userUniqueId = userUniqueId; // user.user_unique_id di payload gator
  }

  baseHeaders(extra = {}) {
    const antiBot = {};
    if (this.cookie)  antiBot["Cookie"]      = this.cookie;
    // env override menang; kalau kosong, pakai token auto-fetch dari endpoint hif-*
    const dliq = this.hifDliq || _hifCache.dliq;
    const leim = this.hifLeim || _hifCache.leim;
    if (dliq) antiBot["x-hif-dliq"]  = dliq;
    if (leim) antiBot["x-hif-leim"]  = leim;
    if (this.settingsToken) antiBot["x-settings-token"] = this.settingsToken;
    return { ...FAKE_HEADERS, ...antiBot, ...extra };
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessExpiry - 60_000)
      return this.accessToken;
    if (this._refreshing) {
      await new Promise(r => this._waiters.push(r));
      return this.accessToken;
    }
    this._refreshing = true;
    try { await this._fetchAccessToken(); }
    finally {
      this._refreshing = false;
      this._waiters.splice(0).forEach(r => r());
    }
    return this.accessToken;
  }

  _fetchAccessToken() {
    return new Promise((resolve, reject) => {
      // Endpoint ini auth via Bearer SAJA. Pakai header MINIMAL — persis seperti
      // curl yang terbukti sukses (Bearer + UA + Accept). Inject Cookie / hif-* /
      // Origin / X-Client-* malah bikin DeepSeek balik 40003 "invalid token".
      const hdrs = {
        "Authorization":   `Bearer ${this.refreshToken}`,
        "User-Agent":      FAKE_HEADERS["User-Agent"],
        "Accept":          "application/json",
        "Accept-Encoding": "identity",
      };
      if (process.env.DEEPSEEK_DEBUG_AUTH === "true") {
        console.error(`[DeepSeekProxy][DBG] auth req headers:`, JSON.stringify(hdrs));
        console.error(`[DeepSeekProxy][DBG] token len=${this.refreshToken.length} head=${this.refreshToken.slice(0,6)} tail=${this.refreshToken.slice(-6)}`);
      }
      const req = https.request({
        hostname: "chat.deepseek.com",
        path:     "/api/v0/users/current",
        method:   "GET",
        headers:  hdrs,
        agent: AGENT,
      }, res => {
        collectBody(res).then(buf => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            this.dead = true;
            return reject(new Error(`Token invalid (HTTP ${res.statusCode})`));
          }
          const _raw = buf.toString("utf8");
          if (process.env.DEEPSEEK_DEBUG_AUTH === "true") {
            console.error(`[DeepSeekProxy][DBG] users/current status=${res.statusCode} ct=${res.headers["content-type"]} enc=${res.headers["content-encoding"]||"-"}`);
            console.error(`[DeepSeekProxy][DBG] body(400):`, _raw.slice(0, 400));
          }
          try {
            const d   = JSON.parse(_raw);
            // Deteksi suspend/ban: DeepSeek balikin code 40003 (invalid token) atau
            // pesan suspend. Tandai slot supaya caller bisa cooldown, bukan langsung dead.
            const code = d?.code;
            const msg  = (d?.msg || "") + (d?.data?.biz_msg || "");
            const looksBanned = code === 40003 || /suspend|violation|banned|disabled|frozen/i.test(msg);
            const biz = d?.data?.biz_data || d?.biz_data || {};
            const tok = biz.token;
            if (!tok) {
              const err = new Error("No access token in refresh response");
              if (looksBanned) err.isBanned = true;   // sinyal buat cooldown
              return reject(err);
            }
            this.accessToken  = tok;
            this.accessExpiry = Date.now() + 3_600_000;
            this.banCount     = 0; // sukses → reset
            console.log(`[DeepSeekProxy] slot ${this.slot} token refreshed ✓`);
            resolve();
          } catch (e) { reject(new Error(`Token refresh parse: ${e.message}`)); }
        }).catch(reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  async getSettingsToken() {
    if (this.settingsToken) return this.settingsToken;
    const tok = await this.getAccessToken();
    const did = generateDid();
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "chat.deepseek.com",
        path:     `/api/v0/client/settings?did=${did}&scope=model`,
        method:   "GET",
        headers:  this.baseHeaders({
          "Authorization": `Bearer ${tok}`,
          "Accept":        "application/json",
          "Accept-Encoding": "identity",
        }),
        agent: AGENT,
      }, res => {
        collectBody(res).then(() => {
          const token = res.headers["x-settings-token"];
          if (token && typeof token === "string") {
            this.settingsToken = token;
            console.log(`[DeepSeekProxy] slot ${this.slot} settings token fetched`);
            resolve(token);
          } else {
            resolve(null);
          }
        }).catch(reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  async preCreateSession() {
    // Selalu buat session baru per request — supaya tiap request punya
    // chat session bersih di DeepSeek dan tidak akumulasi prompt history
    // dari request-request sebelumnya dalam session yang sama.
    if (this.sessionId) {
      const oldId = this.sessionId;
      this.sessionId = null;
      this.deleteSession(oldId).catch(e =>
        console.warn(`[DeepSeekProxy] slot ${this.slot} — delete sesi lama gagal (lanjut): ${e.message}`)
      );
    }

    const tok  = await this.getAccessToken();
    const body = Buffer.from(JSON.stringify({ character_id: null }));
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "chat.deepseek.com",
        path:     "/api/v0/chat_session/create",
        method:   "POST",
        headers:  this.baseHeaders({
          "Authorization":   `Bearer ${tok}`,
          "Content-Type":    "application/json",
          "Content-Length":  String(body.length),
          "Accept":          "application/json",
          "Accept-Encoding": "identity",
        }),
        agent: AGENT,
      }, res => {
        collectBody(res).then(buf => {
          try {
            const d   = JSON.parse(buf.toString("utf8"));
            const biz = d?.data?.biz_data || d?.biz_data || {};
            const cs  = biz.chat_session;
            const sid = (cs && typeof cs === "object" ? cs.id : null) || biz.id;
            if (!sid) return reject(new Error("No session id in create response"));
            this.sessionId = sid;
            this.sessionAt = Date.now();
            console.log(`[DeepSeekProxy] slot ${this.slot} — sesi baru: ${sid}`);
            resolve(sid);
          } catch (e) { reject(new Error(`Session create parse: ${e.message}`)); }
        }).catch(reject);
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /** Hapus satu sesi spesifik via POST /api/v0/chat_session/delete */
  deleteSession(sessionId) {
    return new Promise(async (resolve, reject) => {
      let tok;
      try { tok = await this.getAccessToken(); }
      catch (e) { return reject(new Error(`deleteSession: gagal ambil token — ${e.message}`)); }

      const body = Buffer.from(JSON.stringify({ chat_session_id: sessionId }));
      const req  = https.request({
        hostname: "chat.deepseek.com",
        path:     "/api/v0/chat_session/delete",
        method:   "POST",
        headers:  this.baseHeaders({
          "Authorization":   `Bearer ${tok}`,
          "Content-Type":    "application/json",
          "Content-Length":  String(body.length),
          "Accept":          "application/json",
          "Accept-Encoding": "identity",
        }),
        agent: AGENT,
      }, res => {
        collectBody(res).then(buf => {
          try {
            const d    = JSON.parse(buf.toString("utf8"));
            const code = d?.code ?? d?.data?.biz_code ?? -1;
            if (res.statusCode !== 200 || code !== 0)
              return reject(new Error(`delete_session HTTP ${res.statusCode} code=${code}: ${buf.toString("utf8",0,200)}`));
            console.log(`[DeepSeekProxy] slot ${this.slot} — sesi ${sessionId} dihapus ✓`);
            resolve();
          } catch (e) { reject(new Error(`delete_session parse: ${e.message}`)); }
        }).catch(reject);
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  async getChallenge(targetPath = "/api/v0/chat/completion") {
    const tok  = await this.getAccessToken();
    const body = Buffer.from(JSON.stringify({ target_path: targetPath }));
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "chat.deepseek.com",
        path:     "/api/v0/chat/create_pow_challenge",
        method:   "POST",
        headers:  this.baseHeaders({
          "Authorization":   `Bearer ${tok}`,
          "Content-Type":    "application/json",
          "Content-Length":  String(body.length),
          "Accept":          "application/json",
          "Accept-Encoding": "identity",
        }),
        agent: AGENT,
      }, res => {
        collectBody(res).then(buf => {
          try {
            const d   = JSON.parse(buf.toString("utf8"));
            const biz = d?.data?.biz_data || d?.biz_data || {};
            if (!biz.challenge)
              return reject(new Error(`No challenge in response: ${buf.toString("utf8",0,200)}`));
            resolve(biz.challenge);
          } catch (e) { reject(new Error(`Challenge parse: ${e.message}`)); }
        }).catch(reject);
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

// ── Token pool ────────────────────────────────────────────────────────────────
const POOL = [];
const _missingTelemetryId = [];
for (let i = 1; i <= 20; i++) {
  const t = (process.env[`DEEPSEEK_TOKEN_${i}`]   || "").trim();
  if (!t) continue;
  const cookie  = (process.env[`DEEPSEEK_COOKIE_${i}`]  || process.env["DEEPSEEK_COOKIE"]  || "").trim();
  const hifDliq = (process.env[`DEEPSEEK_HIF_DLIQ_${i}`] || process.env["DEEPSEEK_HIF_DLIQ"] || "").trim();
  const hifLeim = (process.env[`DEEPSEEK_HIF_LEIM_${i}`] || process.env["DEEPSEEK_HIF_LEIM"] || "").trim();
  const webId        = (process.env[`DEEPSEEK_WEB_ID_${i}`]         || "").trim();
  const userUniqueId = (process.env[`DEEPSEEK_USER_UNIQUE_ID_${i}`] || "").trim();
  if (!cookie)  console.warn(`[DeepSeekProxy] Info: DEEPSEEK_COOKIE_${i} kosong → slot ${i} jalan tanpa cookie (opsional, biasanya OK)`);
  if (!webId || !userUniqueId) _missingTelemetryId.push(i);
  // hif-dliq/hif-leim TIDAK perlu diisi manual: auto-fetch dari endpoint hif-*
  // (lihat baris 'HIF refresh — dliq=ok'). Env hanya sebagai override opsional.
  POOL.push(new TokenSlot(t, i, cookie, hifDliq, hifLeim, webId, userUniqueId));
}
if (!POOL.length) {
  console.error("[DeepSeekProxy] ERROR: Tidak ada token! Set DEEPSEEK_TOKEN_1 dulu.");
  process.exit(1);
}
if (_missingTelemetryId.length && TELEMETRY_ENABLED) {
  console.error(`[DeepSeekProxy] ERROR: DEEPSEEK_WEB_ID / DEEPSEEK_USER_UNIQUE_ID wajib diisi untuk slot: ${_missingTelemetryId.join(", ")}`);
  console.error(`[DeepSeekProxy]   Cara ambil: buka chat.deepseek.com → F12 → Network → kirim 1 pesan →`);
  console.error(`[DeepSeekProxy]   cari request ke 'gator.volces.com/list' → tab Payload → bagian "user":`);
  console.error(`[DeepSeekProxy]   { "user_unique_id": "...", "web_id": "..." } → salin ke .env.deepseek`);
  console.error(`[DeepSeekProxy]   Atau set DEEPSEEK_TELEMETRY_ENABLED=false untuk matikan telemetry.`);
  process.exit(1);
}
console.log(`[DeepSeekProxy] ${POOL.length} token dimuat | port=${PORT} | model=${DEFAULT_MODEL} | showThinking=${SHOW_THINKING} | imgCache=${IMAGE_CACHE_TTL_MS/60000}m | docCache=${DOC_CACHE_TTL_MS/60000}m | retry=${OVERLOADED_RETRY_MAX}x${OVERLOADED_RETRY_DELAY}ms | sessionMode=delete-per-session | telemetry=${TELEMETRY_ENABLED}`);

let rrIdx = 0;

// ── THROTTLE + AUTO-COOLDOWN CONFIG ──────────────────────────────────────────
// Tujuan: kurangi pola "bot" (request paralel + bertubi) yang bikin DeepSeek ban.
//  - GLOBAL_MIN_GAP : jarak minimum antar request APAPUN (serialize, anti-paralel)
//  - PER_SLOT_GAP   : jarak minimum sebelum SLOT YANG SAMA dipakai lagi.
//      Dengan N akun sehat, throughput efektif ≈ N / PER_SLOT_GAP.
//      Jadi makin banyak akun → makin cepet (persis logika: 1 akun lambat,
//      banyak akun lebih longgar). Slot di-pilih round-robin yang paling "dingin".
//  - BAN_COOLDOWN   : kalau slot ke-ban/suspend, istirahatkan sekian jam.
const GLOBAL_MIN_GAP_MS = parseInt(process.env.DEEPSEEK_GLOBAL_GAP_MS || "1500", 10);  // 0=off
const PER_SLOT_GAP_MS   = parseInt(process.env.DEEPSEEK_SLOT_GAP_MS   || "8000", 10);  // per akun
const BAN_COOLDOWN_MS   = parseInt(process.env.DEEPSEEK_BAN_COOLDOWN_MS || String(24 * 60 * 60 * 1000), 10);
let _lastGlobalAt = 0;

function _now() { return Date.now(); }

// slot "tersedia" = tidak dead DAN tidak sedang cooldown ban
function available() {
  const t = _now();
  return POOL.filter(s => !s.dead && t >= s.bannedUntil);
}
// dipakai oleh kode lama (vision/dll). Sekarang = available, fallback ke semua.
function alive() {
  let a = available();
  if (!a.length) {
    // semua lagi cooldown/dead → ambil yang paling cepat pulih (biar ga mati total)
    const soonest = POOL.slice().sort((x, y) => x.bannedUntil - y.bannedUntil)[0];
    if (soonest) { soonest.dead = false; return [soonest]; }
    POOL.forEach(s => s.dead = false); a = POOL;
  }
  return a;
}

// Tandai slot ke-ban → cooldown (dipanggil saat deteksi suspend/invalid berulang)
function markBanned(slot, reason = "") {
  slot.banCount++;
  // backoff ringan: ban pertama = cooldown penuh; kalau berulang, tetap penuh
  slot.bannedUntil = _now() + BAN_COOLDOWN_MS;
  slot.accessToken = null; // paksa refresh kalau nanti dipakai lagi
  const mins = Math.round(BAN_COOLDOWN_MS / 60000);
  const healthy = available().length;
  console.warn(`[DeepSeekProxy] ⚠ slot ${slot.slot} COOLDOWN ${mins}m (ban #${slot.banCount}) ${reason} | sehat tersisa: ${healthy}/${POOL.length}`);
}

// Pilih slot paling "dingin" (lastUsedAt terlama) yang available, hormati PER_SLOT_GAP.
// Mengembalikan { slot, waitMs } — waitMs = berapa lama harus nunggu sebelum boleh pakai.
function pickColdestSlot() {
  const t = _now();
  const av = available();
  if (!av.length) {
    // semua cooldown → kasih tau kapan yang tercepat pulih
    const soonest = POOL.slice().sort((x, y) => x.bannedUntil - y.bannedUntil)[0];
    return { slot: soonest || null, waitMs: soonest ? Math.max(0, soonest.bannedUntil - t) : 0, allCooling: true };
  }
  // urutkan: yang paling lama nggak dipakai duluan
  av.sort((x, y) => x.lastUsedAt - y.lastUsedAt);
  const slot = av[0];
  const sinceUsed = t - slot.lastUsedAt;
  const slotWait  = Math.max(0, PER_SLOT_GAP_MS - sinceUsed);
  return { slot, waitMs: slotWait, allCooling: false };
}

// Gate utama: dipanggil sebelum tiap request. Serialize global + per-slot gap.
// Mengembalikan slot yang siap dipakai (sudah menunggu bila perlu).
async function acquireSlot() {
  // 1) global gap (anti paralel / burst)
  if (GLOBAL_MIN_GAP_MS > 0) {
    const t = _now();
    const wait = Math.max(0, GLOBAL_MIN_GAP_MS - (t - _lastGlobalAt));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastGlobalAt = _now();
  }
  // 2) pilih slot paling dingin + tunggu per-slot gap
  let { slot, waitMs, allCooling } = pickColdestSlot();
  if (!slot) { // bener-bener nggak ada slot (pool kosong) — seharusnya nggak terjadi
    return nextSlot();
  }
  if (allCooling && waitMs > 0) {
    const secs = Math.ceil(waitMs / 1000);
    console.warn(`[DeepSeekProxy] semua ${POOL.length} akun cooldown — nunggu ${secs}s sampai slot ${slot.slot} pulih`);
  }
  if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  slot.lastUsedAt = _now();
  console.log(`[DeepSeekProxy] acquire → slot ${slot.slot} | sehat: ${available().length}/${POOL.length} | gap_tunggu=${waitMs}ms`);
  return slot;
}

function nextSlot() {
  const a = alive();
  const s = a[rrIdx % a.length];
  rrIdx++;
  s.lastUsedAt = _now();
  console.log(`[DeepSeekProxy] nextSlot → slot ${s.slot}`);
  return s;
}
function rotate(reason) {
  rrIdx++;
  console.log(`[DeepSeekProxy] rotate → slot ${alive()[rrIdx % alive().length]?.slot} | ${reason}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOL CALLING — XML-based <tool_calling> (format native DeepSeek)
// ══════════════════════════════════════════════════════════════════════════════

function toolsToSystemPrompt(tools, toolChoice = "auto") {
  if (!tools?.length || toolChoice === "none") return "";

  const descs = tools.map(t => {
    const f      = t.function || t;
    const name   = f.name || t.name || "";
    const desc   = f.description || t.description || "";
    const params = f.parameters || f.input_schema || t.parameters || {};
    let d = `<tool>\n<name>${name}</name>\n<description>${desc}</description>`;
    if (params && Object.keys(params).length > 0)
      d += `\n<parameters>\n${JSON.stringify(params, null, 2)}\n</parameters>`;
    d += "\n</tool>";
    return d;
  });

  const isRequired = toolChoice === "required" ||
                     (typeof toolChoice === "object" && toolChoice?.type === "function");
  const forcedFn   = typeof toolChoice === "object" ? toolChoice?.function?.name : null;
  const forceNote  = isRequired
    ? `\n\nIMPORTANT: You MUST call ${forcedFn ? `the \`${forcedFn}\` tool` : "one of the available tools"} — do NOT answer in plain text.`
    : "";

  const names = tools.map(t => (t.function || t).name || t.name).join(", ");
  console.log(`[DeepSeekProxy] Injecting ${tools.length} tool(s): ${names} | tool_choice=${JSON.stringify(toolChoice)}`);

  return (
    `Available Tools:\n` +
    `CRITICAL: Tool names are CASE-SENSITIVE. Use exact names as listed.\n` +
    `To call a tool respond ONLY with this format (nothing else):\n` +
    `<tool_calling>\n<name>tool_name</name>\n<arguments>{"key": "value"}</arguments>\n</tool_calling>\n\n` +
    `RULES:\n1. One [tool_calling] block per tool call\n` +
    `2. JSON arguments on ONE LINE\n` +
    `3. Multiple tools: multiple separate blocks\n` +
    `4. Output NOTHING else when calling tools\n\n` +
    descs.join("\n\n") +
    forceNote
  );
}

function hasToolUse(content) {
  return content.includes("<tool_calling");
}

/** Repair + validate JSON args — return fixed string atau null kalau gagal total */
function _repairArgs(raw, toolName) {
  // Pass 1: as-is
  try { JSON.parse(raw); return raw; } catch {}

  // Pass 2: trailing commas, collapse newlines
  const p2 = raw.replace(/,\s*([}\]])/g, "$1").replace(/\n+/g, " ").trim();
  try { JSON.parse(p2); console.warn(`[DeepSeekProxy] parseToolUse: JSON repaired (p2) "${toolName}"`); return p2; } catch {}

  // Pass 3: kutip kunci yang tidak terkutip  { key: "val" } → { "key": "val" }
  const p3 = p2.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, '$1"$2"$3');
  try { JSON.parse(p3); console.warn(`[DeepSeekProxy] parseToolUse: JSON repaired (p3) "${toolName}"`); return p3; } catch {}

  // Pass 4: potong di karakter JSON valid terakhir (handle truncated)
  for (let i = raw.length - 1; i >= 0; i--) {
    if ("}\"]0123456789truefalsnil".includes(raw[i])) {
      const candidate = raw.slice(0, i + 1);
      // Tutup semua bracket yang belum tertutup
      const opens  = (candidate.match(/\{/g) || []).length - (candidate.match(/\}/g) || []).length;
      const closes = "}".repeat(Math.max(0, opens));
      try {
        const fixed = candidate + closes;
        JSON.parse(fixed);
        console.warn(`[DeepSeekProxy] parseToolUse: JSON truncated+repaired (p4) "${toolName}"`);
        return fixed;
      } catch { continue; }
    }
  }

  console.warn(`[DeepSeekProxy] parseToolUse: args invalid JSON "${toolName}" → drop | ${raw.slice(0,80)}`);
  return null;
}

/** Ekstrak nama tool dari blok — toleran terhadap berbagai format malformed */
function _extractName(block) {
  // Normal:         <name>memory</name>
  let m = block.match(/<name>([^<]+)<\/name>/);
  if (m) return m[1].trim();

  // Malformed attr:  <name="memory atau <name="memory">
  m = block.match(/<name\s*=\s*["']?([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (m) return m[1].trim();

  // Tag tidak tertutup: <name>memory (tanpa </name>)
  m = block.match(/<name>([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (m) return m[1].trim();

  // Baris pertama blok yang kelihatan seperti nama tool
  m = block.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*[\n{]/);
  if (m) return m[1].trim();

  return null;
}

/** Strict parser — regex yang sudah ada sebelumnya */
function _parseStrict(content) {
  const calls = [];
  const re = /<tool_calling>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]+?)<\/arguments>\s*<\/tool_calling>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name  = m[1].trim();
    const fixed = _repairArgs(m[2].trim(), name);
    if (!fixed) continue;
    calls.push({ id: `tool_${calls.length}`, type: "function", function: { name, arguments: fixed } });
  }
  return calls;
}

/** Tolerant fallback — handle tag malformed, truncated, atau tanpa closing tag */
function _parseFallback(content) {
  const calls = [];

  // Split per blok <tool_calling> — dengan atau tanpa closing tag
  const blocks = content.split(/<tool_calling>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/tool_calling>/i)[0]; // ambil sampai </tool_calling> atau akhir

    const name = _extractName(block);
    if (!name) { console.warn("[DeepSeekProxy] fallback parser: nama tidak ditemukan di blok, skip"); continue; }

    // Cari argumen: antara <arguments> dan </arguments> atau akhir blok
    let args = "{}";
    const argsM = block.match(/<arguments>([\s\S]+?)(?:<\/arguments>|$)/i);
    if (argsM) {
      const fixed = _repairArgs(argsM[1].trim(), name);
      if (fixed) args = fixed;
    }

    calls.push({ id: `tool_${calls.length}`, type: "function", function: { name, arguments: args } });
    console.warn(`[DeepSeekProxy] fallback parser: recovered tool "${name}"`);
  }
  return calls;
}

function parseToolUse(content) {
  // Coba strict dulu
  const strict = _parseStrict(content);
  if (strict.length) return strict;

  // Kalau tidak ada hasil tapi ada marker → coba fallback tolerant
  if (!content.includes("<tool_calling")) return null;
  console.warn("[DeepSeekProxy] parseToolUse: strict gagal → coba fallback tolerant");
  const fallback = _parseFallback(content);
  return fallback.length ? fallback : null;
}

const TOOL_MARKER = "<tool_calling";
function safeFlushPoint(buf) {
  const fi = buf.indexOf(TOOL_MARKER);
  if (fi !== -1) return fi;
  for (let l = Math.min(TOOL_MARKER.length - 1, buf.length); l > 0; l--) {
    if (buf.slice(-l) === TOOL_MARKER.slice(0, l)) return buf.length - l;
  }
  return buf.length;
}

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE FORMATTING — OpenAI messages[] → DeepSeek prompt string
// ══════════════════════════════════════════════════════════════════════════════

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter(p => p.type === "text").map(p => p.text || "").join("\n");
  return String(content || "");
}

function buildPrompt(messages, tools = [], toolChoice = "auto") {
  const toolPrompt = toolsToSystemPrompt(tools, toolChoice);

  const raw = [];
  for (const msg of messages) {
    const role = msg.role;
    let text;

    if (role === "assistant" && msg.tool_calls?.length) {
      text = msg.tool_calls.map(tc => {
        const fn = tc.function || {};
        return `<tool_calling>\n<name>${fn.name || ""}</name>\n<arguments>${fn.arguments || "{}"}</arguments>\n</tool_calling>`;
      }).join("\n");
    } else if (role === "tool" && msg.tool_call_id) {
      let result = extractText(msg.content);
      result = result
        .replace(/\\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, " ")
        .replace(/\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\n?/gi, " ")
        .replace(/\s{2,}/g, " ").trim();
      const truncated = result.length > 6000 ? result.slice(0, 6000) + "… [truncated]" : result;
      text = `<tool_response tool_call_id="${msg.tool_call_id}">\n${truncated}\n</tool_response>`;
    } else {
      text = extractText(msg.content);
    }

    raw.push({ role, text });
  }

  if (!raw.length) return "";

  // Merge consecutive same-role messages
  const merged = [{ ...raw[0] }];
  for (const r of raw.slice(1)) {
    if (r.role === merged[merged.length - 1].role)
      merged[merged.length - 1].text += `\n\n${r.text}`;
    else
      merged.push({ ...r });
  }

  // Prepend tool prompt ke blok pertama
  if (toolPrompt) {
    if (merged[0].role === "system") {
      merged[0] = { role: "system", text: toolPrompt + "\n\n" + merged[0].text };
    } else if (merged[0].role === "user") {
      merged[0] = { role: "user", text: toolPrompt + "\n\n" + merged[0].text };
    } else {
      merged.unshift({ role: "system", text: toolPrompt });
    }
  }

  // Build string dengan DeepSeek special tokens
  const parts = [];
  for (let i = 0; i < merged.length; i++) {
    const { role, text } = merged[i];
    if (role === "assistant") {
      parts.push(`<\u{FF5C}Assistant\u{FF5C}>${text}<\u{FF5C}end of sentence\u{FF5C}>`);
    } else if (role === "tool") {
      parts.push(`<\u{FF5C}User\u{FF5C}>${text}`);
    } else {
      // system atau user: index 0 tanpa prefix
      parts.push(i > 0 ? `<\u{FF5C}User\u{FF5C}>${text}` : text);
    }
  }

  return parts.join("").replace(/!\[.+?\]\(.+?\)/g, "");
}

// ══════════════════════════════════════════════════════════════════════════════
// VISION — extract, upload, poll
// ══════════════════════════════════════════════════════════════════════════════

function extractImagesFromMessages(messages) {
  const images = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== "image_url") continue;
      const url = part.image_url?.url || part.image_url || "";
      const m   = url.match(/^data:([^;]+);base64,(.+)$/s);
      if (!m) continue;
      const mimetype = m[1];
      if (isDocMime(mimetype)) continue;  // dokumen dihandle extractDocsFromMessages
      const buf  = Buffer.from(m[2], "base64");
      const ext  = mimetype.split("/")[1]?.split("+")[0] || "jpg";
      const hash = _imgHash(buf);
      images.push({ buffer: buf, mimetype, filename: `img_${Date.now()}_${images.length}.${ext}`, hash });
    }
  }
  return images;
}

/** Scan messages[] → extract base64-encoded documents (PDF, DOCX, XLSX, dll) */
function extractDocsFromMessages(messages) {
  const docs = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      let mimetype = "";
      let b64      = "";
      let filename = "";

      // Format 1: Anthropic-style document block
      if (part.type === "document" && part.source?.type === "base64") {
        mimetype = (part.source.media_type || "").toLowerCase().split(";")[0].trim();
        b64      = part.source.data || "";
        filename = part.name || "";

      // Format 2: data: URL di image_url / file_url / url
      } else {
        const raw = part.image_url?.url || part.file_url?.url || part.url || "";
        const m   = raw.match(/^data:([^;]+);base64,(.+)$/s);
        if (!m) continue;
        mimetype = m[1].toLowerCase().split(";")[0].trim();
        b64      = m[2];
        filename = part.file_url?.filename || part.name || "";
      }

      if (!isDocMime(mimetype)) continue;
      if (!b64) continue;

      const buf = Buffer.from(b64, "base64");
      const ext = mimetype.split("/")[1]?.split(".").pop()?.split("-").pop() || "bin";
      const hash = _imgHash(buf);
      if (!filename) filename = `doc_${Date.now()}_${docs.length}.${ext}`;
      docs.push({ buffer: buf, mimetype, filename, hash });
    }
  }
  return docs;
}

async function uploadFileToDeepSeek(slot, buffer, filename, mimetype) {
  const UPLOAD_PATH = "/api/v0/file/upload_file";
  const tok      = await slot.getAccessToken();
  // DeepSeek butuh POW per-path. Upload pakai challenge dgn target_path = upload_file.
  const upCh     = await slot.getChallenge(UPLOAD_PATH);
  const upPow    = await buildPowAnswer(upCh, UPLOAD_PATH);
  const boundary = `----DeepSeekBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const CRLF     = "\r\n";
  const head = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: ${mimetype}${CRLF}${CRLF}`
  );
  const foot = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([head, buffer, foot]);

  // Gambar → jalur VISION (DeepSeek "lihat" gambar). Dokumen → NORMAL (OCR/teks).
  // Tanpa header ini, gambar di-route ke NORMAL → status CONTENT_EMPTY utk foto tanpa teks.
  const isImageUpload = !isDocMime(mimetype) && mimetype.startsWith("image/");
  const modelTypeHdr  = isImageUpload ? "vision" : "default";

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "chat.deepseek.com",
      path:     UPLOAD_PATH,
      method:   "POST",
      headers:  slot.baseHeaders({
        "Authorization":      `Bearer ${tok}`,
        "X-Ds-Pow-Response":  upPow,
        "X-Model-Type":       modelTypeHdr,
        "X-File-Size":        String(buffer.length),
        "X-Thinking-Enabled": "1",
        "Content-Type":       `multipart/form-data; boundary=${boundary}`,
        "Content-Length":     String(body.length),
        "Accept":             "application/json",
        "Accept-Encoding":    "identity",
      }),
      agent: AGENT,
    }, res => {
      collectBody(res).then(buf => {
        if (res.statusCode !== 200)
          return reject(new Error(`Upload HTTP ${res.statusCode}: ${buf.toString("utf8",0,200)}`));
        try {
          const d      = JSON.parse(buf.toString("utf8"));
          const biz    = d?.data?.biz_data || d?.biz_data || {};
          const fileId = biz.id;
          if (!fileId) {
            sendUploadTelemetry({ sessionId: "", fileId: "", fileName: filename, ext: (filename.split(".").pop() || "bin"), fileSize: buffer.length, success: false, user: telemetryUserFromSlot(slot) });
            return reject(new Error("No file id in upload response"));
          }
          const isImage = biz.is_image !== undefined ? !!biz.is_image : mimetype.startsWith("image/");
          console.log(`[Vision] Uploaded: ${filename} → ${fileId} isImage=${isImage}`);
          sendUploadTelemetry({
            sessionId:   "",
            fileId,
            fileName:    biz.file_name || filename,
            ext:         (filename.split(".").pop() || "bin").toLowerCase(),
            fileSize:    biz.file_size || buffer.length,
            modelType:   biz.model_kind === "NORMAL" ? "default" : (biz.model_kind || "default"),
            success:     true,
            status:      biz.status || "PENDING",
            tokenUsage:  biz.token_usage ?? null,
            width:       biz.width ?? (isImage ? null : undefined),
            height:      biz.height ?? (isImage ? null : undefined),
            auditResult: biz.audit_result === "unknown" ? "pass" : (biz.audit_result || "pass"),
            user:        telemetryUserFromSlot(slot),
          });
          resolve({ fileId, isImage });
        } catch (e) { reject(new Error(`Upload parse: ${e.message}`)); }
      }).catch(reject);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function waitForFile(slot, fileId, maxWait = 30_000) {
  const tok      = await slot.getAccessToken();
  const deadline = Date.now() + maxWait;
  let _lastStatus = "";

  for (let i = 0; Date.now() < deadline; i++) {
    const data = await new Promise(resolve => {
      const req = https.request({
        hostname: "chat.deepseek.com",
        path:     `/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
        method:   "GET",
        headers:  slot.baseHeaders({
          "Authorization":   `Bearer ${tok}`,
          "Accept":          "application/json",
          "Accept-Encoding": "identity",
        }),
        agent: AGENT,
      }, res => {
        collectBody(res)
          .then(buf => { try { resolve(JSON.parse(buf.toString("utf8"))); } catch { resolve({ _raw: buf.toString("utf8", 0, 300) }); } })
          .catch(() => resolve({}));
      });
      req.on("error", () => resolve({}));
      req.end();
    });

    const biz   = data?.data?.biz_data || data?.biz_data || {};
    const files = biz.files || [];
    if (files.length) {
      const info   = files[0];
      const status = info.status || "";
      if (status !== _lastStatus) {
        console.log(`[Vision] waitForFile ${fileId.slice(0, 16)}… status=${status}`);
        _lastStatus = status;
      }
      if (status === "SUCCESS")
        return { ready: true, isImage: !!info.is_image };
      if (status === "FAILED" || status === "ERROR") {
        console.warn(`[Vision] File ${fileId} FAILED — audit=${info.audit_result} err=${info.error_code}`);
        return { ready: false, isImage: false };
      }
      if (status === "CONTENT_EMPTY") {
        console.warn(`[Vision] File ${fileId} CONTENT_EMPTY — parse selesai tanpa konten`);
        return { ready: true, isImage: !!info.is_image };
      }
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  console.warn(`[Vision] waitForFile timeout ${fileId} — tetap dipakai`);
  return { ready: true, isImage: false };
}

// ══════════════════════════════════════════════════════════════════════════════
// SSE HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function sseChunk(id, model, content, done = false) {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: done ? {} : { content }, finish_reason: done ? "stop" : null }],
  })}\n\n`;
}

function emitToolCalls(res, id, model, answerBuf) {
  const toolCalls = parseToolUse(answerBuf);
  if (!toolCalls) {
    // parseToolUse gagal — mungkin truncated atau args invalid JSON.
    // Tetap kirim finish_reason supaya agent tidak dapat "empty stream with no finish_reason".
    // Pakai "tool_calls" bukan "stop" supaya agent tahu ada tool call yang gagal parse,
    // bukan response teks biasa yang selesai normal.
    const hasMarker = hasToolUse(answerBuf);
    console.warn(`[DeepSeekProxy] emitToolCalls: parseToolUse return null${hasMarker ? " (ada marker tapi truncated/invalid)" : ""}`);
    res.write(`data: ${JSON.stringify({
      id, model, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta: {}, finish_reason: hasMarker ? "tool_calls" : "stop" }],
    })}\n\n`);
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  toolCalls.forEach((tc, i) => {
    res.write(`data: ${JSON.stringify({
      id, model, object: "chat.completion.chunk", created: now,
      choices: [{ index: 0, finish_reason: null, delta: {
        tool_calls: [{ index: i, id: tc.id, type: "function",
                       function: { name: tc.function.name, arguments: "" } }],
      }}],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id, model, object: "chat.completion.chunk", created: now,
      choices: [{ index: 0, finish_reason: null, delta: {
        tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }],
      }}],
    })}\n\n`);
  });
  res.write(`data: ${JSON.stringify({
    id, model, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  })}\n\n`);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// CORE STREAMER — DeepSeek SSE → OpenAI SSE
//
// DeepSeek SSE chunk formats:
//  1. {v: {response: {fragments: [{type:"THINK"|"ANSWER", content:"..."}]}}}
//  2. {p: "response/fragments", v: [{type:..., content:...}], o:"APPEND"}
//  3. {p: "response/search_results", v: [...]} — skip
//  4. {v: "string"} — simple string delta
// ══════════════════════════════════════════════════════════════════════════════

function streamDeepSeek(slot, chatPayload, res, id, modelId, activeTools) {
  return new Promise(async (resolve, reject) => {
    let tok, powAnswer;
    try {
      tok       = await slot.getAccessToken();
      const ch  = await slot.getChallenge();
      powAnswer = await buildPowAnswer(ch);
    } catch (e) { return reject(e); }

    const bodyBuf = Buffer.from(JSON.stringify(chatPayload));
    const req     = https.request({
      hostname: "chat.deepseek.com",
      path:     "/api/v0/chat/completion",
      method:   "POST",
      headers:  slot.baseHeaders({
        "Authorization":     `Bearer ${tok}`,
        "X-Ds-Pow-Response": powAnswer,
        "Content-Type":      "application/json",
        "Content-Length":    String(bodyBuf.length),
        "Accept":            "text/event-stream",
        "Accept-Encoding":   "identity",
      }),
      agent: AGENT,
    }, dsRes => {
      // ── HTTP-level error detection ──────────────────────────────────────────
      if (dsRes.statusCode !== 200) {
        let b = "";
        dsRes.on("data", c => b += c);
        dsRes.on("end", () => {
          const msg = `HTTP ${dsRes.statusCode}: ${b.slice(0, 200)}`;
          if (dsRes.statusCode === 429 || dsRes.statusCode === 503 || dsRes.statusCode === 502)
            reject(new OverloadedError(msg));
          else
            reject(new Error(msg));
        });
        return;
      }

      let answerBuf     = "";
      let sentUpTo      = 0;
      let reasoningSent = false;
      let resolved      = false;
      let lineBuf       = "";
      let currentType   = "";  // "thinking" | "content"
      let finishReasonSent = false;  // safety flag: pastikan finish_reason selalu dikirim sebelum [DONE]


      let _idleTimer = null, _totalTimer = null;
      function _clearTimers() {
        if (_idleTimer)  { clearTimeout(_idleTimer);  _idleTimer  = null; }
        if (_totalTimer) { clearTimeout(_totalTimer); _totalTimer = null; }
      }
      function _kickIdle() {
        if (_idleTimer) clearTimeout(_idleTimer);
        _idleTimer = setTimeout(() => {
          if (resolved) return;
          _clearTimers(); resolved = true;
          try { dsRes.destroy(); } catch {}
          console.error(`[DeepSeekProxy] stream idle timeout (${STREAM_IDLE_TIMEOUT_MS/1000}s)`);
          reject(new StreamTimeoutError(`Stream idle timeout (${STREAM_IDLE_TIMEOUT_MS/1000}s)`));
        }, STREAM_IDLE_TIMEOUT_MS);
      }
      _totalTimer = setTimeout(() => {
        if (resolved) return;
        _clearTimers(); resolved = true;
        try { dsRes.destroy(); } catch {}
        console.error(`[DeepSeekProxy] stream total timeout (${STREAM_TOTAL_TIMEOUT_MS/1000}s)`);
        reject(new StreamTimeoutError(`Stream total timeout (${STREAM_TOTAL_TIMEOUT_MS/1000}s)`));
      }, STREAM_TOTAL_TIMEOUT_MS);
      _kickIdle();

      function done() {
        if (resolved) return;
        _clearTimers();
        resolved = true;

        if (activeTools && hasToolUse(answerBuf)) {
          const emitted = emitToolCalls(res, id, modelId, answerBuf);
          finishReasonSent = true;
          if (!emitted) {
            // parseToolUse gagal — flush sisa teks yang belum keluar sebagai konten biasa
            const tail = answerBuf.slice(sentUpTo).replace(/<tool_calling[\s\S]*$/i, "").trim();
            if (tail) res.write(sseChunk(id, modelId, tail));
          }
        } else {
          const tail = answerBuf.slice(sentUpTo);
          if (tail) res.write(sseChunk(id, modelId, tail));
          res.write(sseChunk(id, modelId, "", true));
          finishReasonSent = true;
        }
        // Safety net: kalau finish_reason belum terkirim karena path yang tidak terduga
        if (!finishReasonSent) {
          console.warn("[DeepSeekProxy] done() safety net: force emit finish_reason=stop");
          res.write(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", model: modelId,
            created: Math.floor(Date.now() / 1000),
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        resolve();
      }

      function processLine(line) {
        if (!line.startsWith("data:")) return;

        const data = line.slice(5).trim();
        if (data === "[DONE]") { done(); return; }

        let chunk;
        try { chunk = JSON.parse(data); } catch { return; }

        // ── Deteksi error event dari DeepSeek di dalam SSE stream ─────────────
        if (chunk.error || chunk.err) {
          const errObj = chunk.error || chunk.err;
          const code   = errObj?.code || errObj?.error_code || 0;
          const msg    = errObj?.message || errObj?.error_msg || JSON.stringify(errObj);
          if (!resolved) {
            _clearTimers(); resolved = true;
            try { dsRes.destroy(); } catch {}
            const isOverload = code === 429 || code === 503 || /429|overload|rate.?limit/i.test(msg);
            reject(isOverload ? new OverloadedError(msg) : new Error(msg));
          }
          return;
        }

        const frags = [];

        if (chunk.v && typeof chunk.v === "object" && chunk.v.response) {
          for (const f of chunk.v.response.fragments || [])
            frags.push({ type: f.type, content: f.content || "" });
        } else if (chunk.p === "response/fragments" && Array.isArray(chunk.v)) {
          for (const f of chunk.v)
            frags.push({ type: f.type, content: f.content || "" });
        } else if (chunk.p === "response/search_results") {
          return; // skip search results
        } else if (typeof chunk.v === "string") {
          const c = chunk.v.replace(/FINISHED/g, "");
          if (c) frags.push({ type: currentType === "thinking" ? "THINK" : "ANSWER", content: c });
        }

        for (const { type, content } of frags) {
          if (!content) continue;
          const text = content
            .replace(/FINISHED/g, "")
            .replace(/^\(?(SEARCH|WEB_SEARCH|SEARCHING)\)?\s*/i, "")
            .replace(/\[citation:(\d+)\]/g, "[$1]");
          if (!text) continue;

          if (type === "THINK") {
            currentType = "thinking";
            if (SHOW_THINKING) {
              if (!reasoningSent) {
                res.write(`data: ${JSON.stringify({
                  id, object: "chat.completion.chunk", model: modelId,
                  created: Math.floor(Date.now() / 1000),
                  choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "" }, finish_reason: null }],
                })}\n\n`);
                reasoningSent = true;
              }
              res.write(`data: ${JSON.stringify({
                id, object: "chat.completion.chunk", model: modelId,
                created: Math.floor(Date.now() / 1000),
                choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
              })}\n\n`);
            }
          } else if (type === "ANSWER" || type === "RESPONSE") {
            currentType = "content";
            answerBuf  += text;
            const safe  = safeFlushPoint(answerBuf);
            if (safe > sentUpTo) {
              res.write(sseChunk(id, modelId, answerBuf.slice(sentUpTo, safe)));
              sentUpTo = safe;
            }
            if (activeTools && hasToolUse(answerBuf) && !resolved) {
              if (answerBuf.includes("</tool_calling>")) {
                resolved = true;
                _clearTimers();
                emitToolCalls(res, id, modelId, answerBuf);
                finishReasonSent = true;
                res.write("data: [DONE]\n\n");
                resolve();
              }
            }
          }
        }
      }

      dsRes.on("data", chunk => {
        _kickIdle();
        lineBuf += chunk.toString("utf-8");
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop();
        for (const line of lines) processLine(line.trim());
      });
      dsRes.on("end", () => {
        _clearTimers();
        if (lineBuf.trim()) processLine(lineBuf.trim());
        if (!resolved) done();
      });
      dsRes.on("error", e => {
        _clearTimers();
        if (!resolved) { resolved = true; reject(e); }
      });
    });

    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// RETRY WRAPPER — sama pola seperti streamKimiWithRetry di kimi-reverse-proxy
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Wrap streamDeepSeek dengan retry logic:
 *  - OverloadedError (429 / server overload): delay lalu coba slot berikutnya
 *  - StreamTimeoutError (idle/total): langsung coba slot berikutnya tanpa delay
 *  - Error lain: throw langsung tanpa retry
 *
 * Selama nunggu retry, kirim SSE keep-alive comment supaya connection tidak putus.
 */
async function streamDeepSeekWithRetry(slot, chatPayload, res, id, modelId, activeTools) {
  let attempt = 0;

  while (true) {
    const currentSlot = attempt === 0 ? slot : nextSlot();
    try {
      return await streamDeepSeek(currentSlot, chatPayload, res, id, modelId, activeTools);
    } catch (e) {
      attempt++;
      const isOverload = e.isOverloaded === true;
      const isTimeout  = e.isTimeout    === true;

      if (!isOverload && !isTimeout) throw e;             // error lain langsung throw
      if (attempt > OVERLOADED_RETRY_MAX) {
        console.error(`[DeepSeekProxy] max retry (${OVERLOADED_RETRY_MAX}) tercapai — give up`);
        throw e;
      }

      if (isOverload) {
        // Tandai slot ini mungkin overloaded, rotate
        rotate(`overloaded (attempt ${attempt}/${OVERLOADED_RETRY_MAX})`);
        const delay = OVERLOADED_RETRY_DELAY * attempt;
        console.warn(`[DeepSeekProxy] overloaded — tunggu ${delay}ms lalu retry...`);

        // SSE keep-alive comment supaya client tahu kita masih hidup
        try { res.write(`: deepseek overloaded, retrying in ${Math.round(delay/1000)}s...\n\n`); } catch {}

        await sleep(delay);
      } else {
        // Timeout — langsung retry tanpa delay, rotate slot
        rotate(`timeout (attempt ${attempt}/${OVERLOADED_RETRY_MAX})`);
        console.warn(`[DeepSeekProxy] timeout — retry langsung ke slot berikutnya...`);
        try { res.write(`: stream timeout, retrying...\n\n`); } catch {}
      }
    }
  }
}

// ── SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-deepseek-search");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── GET /v1/models ─────────────────────────────────────────────────────────
  if (req.method === "GET" && (
      req.url === "/v1" || req.url === "/v1/" || req.url === "/health" ||
      req.url?.startsWith("/v1/models"))) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: ALL_MODELS.map(id => ({ id, object: "model", created: 0, owned_by: "deepseek-reverse" })),
    }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // ── POST /v1/chat/completions ──────────────────────────────────────────────
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }

    const rawModel   = parsed.model    || DEFAULT_MODEL;
    const messages   = parsed.messages || [];
    const tools      = parsed.tools    || [];
    const toolChoice = parsed.tool_choice ?? "auto";

    const nativeSearchToolNames = ["web_search", "search", "browser_search", "web_browse"];
    const hasNativeSearchTool = tools.some(t =>
      nativeSearchToolNames.includes((t.function?.name || t.name || "").toLowerCase())
    );

    const useSearch = req.headers["x-deepseek-search"] === "true" ||
                      parsed.enable_search === true;

    const customTools = useSearch
      ? tools.filter(t => !nativeSearchToolNames.includes((t.function?.name || t.name || "").toLowerCase()))
      : tools;

    const { modelId, thinking } = mapModel(rawModel);
    const activeTools = !!(customTools.length && toolChoice !== "none");

    if (useSearch) {
      console.log(`[DeepSeekProxy] native search aktif${hasNativeSearchTool ? " | web_search di-strip" : ""}`);
    } else if (hasNativeSearchTool) {
      console.log(`[DeepSeekProxy] web_search → relay sebagai custom tool`);
    }
    console.log(`[DeepSeekProxy] ← model=${rawModel}→${modelId} | msgs=${messages.length} tools=${customTools.length} thinking=${thinking} search=${useSearch}`);

    // ── Vision: upload images ────────────────────────────────────────────────
    let fileIds   = [];
    let hasImages = false;
    const rawImages = extractImagesFromMessages(messages);

    if (rawImages.length) {
      console.log(`[Vision] ${rawImages.length} gambar terdeteksi...`);
      const vSlot = alive()[rrIdx % alive().length];
      try {
        for (const img of rawImages) {
          const cached = _imgCacheGet(img.hash);
          if (cached) {
            console.log(`[Vision] Cache hit: ${img.filename} → ${cached}`);
            fileIds.push(cached);
            hasImages = true;
            continue;
          }
          const { fileId, isImage } = await uploadFileToDeepSeek(vSlot, img.buffer, img.filename, img.mimetype);
          const { ready } = await waitForFile(vSlot, fileId);
          if (ready) {
            fileIds.push(fileId);
            _imgCacheStore(img.hash, fileId);
            if (isImage) hasImages = true;
          } else {
            console.warn(`[Vision] File ${fileId} belum ready, skip.`);
          }
        }
      } catch (e) {
        console.warn(`[Vision] Upload gambar gagal (lanjut tanpa gambar): ${e.message}`);
      }
    }

    // ── Documents: upload PDF/DOCX/XLSX dll ───────────────────────────────────
    const rawDocs = extractDocsFromMessages(messages);
    if (rawDocs.length) {
      console.log(`[Vision] ${rawDocs.length} dokumen terdeteksi...`);
      const dSlot = alive()[rrIdx % alive().length];
      try {
        for (const doc of rawDocs) {
          const cached = _docCacheGet(doc.hash);
          if (cached) {
            console.log(`[Vision] Doc cache hit: ${doc.filename} → ${cached}`);
            fileIds.push(cached);
            continue;
          }
          const { fileId } = await uploadFileToDeepSeek(dSlot, doc.buffer, doc.filename, doc.mimetype);
          const { ready }  = await waitForFile(dSlot, fileId);
          if (ready) {
            fileIds.push(fileId);
            _docCacheStore(doc.hash, fileId);
          } else {
            console.warn(`[Vision] Doc ${fileId} belum ready, skip.`);
          }
        }
      } catch (e) {
        console.warn(`[Vision] Upload dokumen gagal (lanjut tanpa doc): ${e.message}`);
      }
    }

    // ── Context continuity: inject cached file IDs ────────────────────────────
    // PENTING: ref_file_ids gambar + tools = DeepSeek balik 0B (vision & tool-calling
    // tidak bisa barengan). Jadi:
    //  - Request yg BAWA GAMBAR FRESH  → vision mode, inject gambar, tools dimatikan.
    //  - Request TEKS (gambar cuma dari history) → JANGAN inject gambar ke ref_file_ids
    //    (biar tools tetap hidup & tdk 0B). Context tekstualnya tetap nyambung lewat
    //    `messages` dari Hermes (mis. jawaban vision sebelumnya).
    //  - Dokumen continuity tetap di-inject (OCR/teks tdk bentrok dgn tools).
    const requestHasFreshImage = rawImages.length > 0 && hasImages;

    const freshImgs = _recentFileIds().filter(id => !fileIds.includes(id));
    const freshDocs = _recentDocFileIds().filter(id => !fileIds.includes(id));

    if (requestHasFreshImage) {
      // Vision turn: gambar fresh sudah di fileIds. Tambahkan continuity gambar+doc.
      if (freshImgs.length + freshDocs.length > 0) {
        console.log(`[Vision] Inject context: ${freshImgs.length} img + ${freshDocs.length} doc`);
        fileIds.push(...freshImgs, ...freshDocs);
      }
    } else {
      // Text turn: HANYA inject dokumen, JANGAN gambar (hindari 0B, jaga tools hidup).
      if (freshDocs.length > 0) {
        console.log(`[Vision] Inject context: ${freshDocs.length} doc (gambar di-skip agar tools aktif)`);
        fileIds.push(...freshDocs);
      }
      hasImages = false;  // pastikan tidak masuk vision mode di text turn
    }

    // ── Suppress tools per-request ────────────────────────────────────────────
    // hasImages kini HANYA true saat request membawa gambar fresh (vision turn).
    // Vision turn → matikan semua tools (DeepSeek vision tdk support tool-calling).
    // Text turn → tools tetap hidup walau ada gambar di history Hermes.
    // Dokumen → cuma buang tool analisis-file.
    const FILE_TOOL_NAMES = new Set([
      "vision_analyze", "image_analyze", "document_analyze", "file_analyze",
      "analyze_image", "analyze_document", "analyze_file", "ocr",
    ]);
    let filteredTools;
    if (hasImages) {
      // Mode vision murni → buang SEMUA tools.
      filteredTools = [];
      if (customTools.length)
        console.log(`[Vision] Mode vision: suppress SEMUA ${customTools.length} tool (DeepSeek vision tdk support tool-calling)`);
    } else if (fileIds.length > 0) {
      // Dokumen → cuma buang tool analisis-file, sisanya boleh.
      filteredTools = customTools.filter(t => !FILE_TOOL_NAMES.has((t.function?.name || t.name || "").toLowerCase()));
      if (filteredTools.length < customTools.length)
        console.log(`[Vision] Suppress ${customTools.length - filteredTools.length} file-analysis tool(s) karena ada lampiran`);
    } else {
      filteredTools = customTools;
    }

    const finalActiveTools = !!(filteredTools.length && toolChoice !== "none");

    const prompt = buildPrompt(messages, filteredTools, toolChoice);

    let modelType = "default";
    if (hasImages)     modelType = "vision";
    else if (thinking) modelType = "expert";

    // Throttle + cooldown gate: pilih slot paling dingin, hormati gap, hindari paralel.
    let slot = await acquireSlot();
    let sessionId;
    // Coba dapatkan session; kalau slot ke-ban → cooldown & pindah slot sehat lain.
    {
      let tries = 0;
      const maxTries = Math.min(POOL.length, 5);
      while (true) {
        try {
          sessionId = await slot.preCreateSession();
          break;
        } catch (e) {
          tries++;
          if (e.isBanned) {
            markBanned(slot, `(session: ${e.message})`);
          } else {
            console.warn(`[DeepSeekProxy] Session error slot ${slot.slot}: ${e.message}`);
            slot.sessionId = null;
          }
          // masih ada slot sehat & belum exceed → ambil slot lain dan ulang
          if (tries < maxTries && available().length > 0) {
            slot = await acquireSlot();
            continue;
          }
          // satu percobaan terakhir di slot yang sama (mungkin cuma session basi)
          try { slot.sessionId = null; sessionId = await slot.preCreateSession(); break; }
          catch (e2) {
            if (e2.isBanned) markBanned(slot, `(session retry: ${e2.message})`);
            const healthy = available().length;
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: {
              message: `All accounts unavailable: ${e2.message} (sehat: ${healthy}/${POOL.length})`,
              type: "proxy_error"
            } }));
            return;
          }
        }
      }
    }

    // ── Ambil settings token (jika belum) ─────────────────────────────────────
    if (!slot.settingsToken) {
      try { await slot.getSettingsToken(); } catch { /* ignore */ }
    }

    // ── Kirim telemetry awal (pre‑chat events) ─────────────────────────────
    const did = generateDid();
    const preEvents = [
      buildTelemetryEvent("input_text_paste", {
        ds_chat_session_id: sessionId,
        ds_model_type: modelType,
        ds_is_edit_mode: 0,
        ds_paste_text_length: prompt.length,
        ds_prompt_length_before: 0,
        ds_prompt_length_after: prompt.length,
      }, sessionId),
      buildTelemetryEvent("loadRemoteFeaturesSuccess", { ds_storageKey: "__ds_remote_feature_store_model" }, sessionId),
      buildTelemetryEvent("hifRequestSuccess", { ds_url: "https://hif-leim.deepseek.com/query", ds_ttl: 600 }, sessionId),
      buildTelemetryEvent("chatCompletionApi", {
        ds_scene: "completion",
        ds_chatSessionId: sessionId,
        ds_modelType: modelType,
        ds_withFile: fileIds.length > 0 ? "true" : "false",
        ds_fileExtensions: "[]",
        ds_thinkingEnabled: String(thinking),
        ds_messageId: "",
        ds_challengeResponse: "true",
        ds_searchEnabled: String(useSearch),
        ds_promptLength: prompt.length,
      }, sessionId),
      buildTelemetryEvent("retrievePowAnswer", {
        ds_expireInfo: "valid",
        ds_expireAt: Date.now() + 300000,
        ds_scene: "completion_like",
        ds_answer: randomInt(10000, 99999),
        ds_expireAfter: 300000,
      }, sessionId),
      buildTelemetryEvent("powCleared", { ds_scene: "completion_like" }, sessionId),
      buildTelemetryEvent("send_button_click", {
        ds_chat_session_id: "",
        ds_model_type: modelType,
        ds_is_send_button_new_chat: 1,
        ds_prompt_length: prompt.length,
        ds_is_think_enable: thinking ? 1 : 0,
        ds_is_search_enable: useSearch ? 1 : 0,
        ds_is_edit_mode: 0,
        ds_file_count: fileIds.length,
        ds_file_extensions: "[]",
        ds_file_sources: "[]",
      }, sessionId),
    ];
    sendTelemetry(preEvents, telemetryUserFromSlot(slot));

    const chatPayload = {
      chat_session_id:   sessionId,
      parent_message_id: null,
      model_type:        modelType,
      prompt,
      ref_file_ids:      fileIds,
      thinking_enabled:  thinking,
      search_enabled:    useSearch,
      preempt:           false,
    };

    const id       = `chatcmpl-${uuid()}`;
    const isStream = parsed.stream === true;

    // ── Streaming ──────────────────────────────────────────────────────────
    if (isStream) {
      res.writeHead(200, {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: modelId,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`);

      try {
        const t0 = Date.now();
        await streamDeepSeekWithRetry(slot, chatPayload, res, id, modelId, finalActiveTools);
        console.log(`[DeepSeekProxy] stream done in ${Date.now()-t0}ms`);
      } catch (e) {
        const msg = e.message || "";
        console.error("[DeepSeekProxy] stream error (no more retries):", msg);
        if (/401|403|token/i.test(msg)) { slot.dead = true; rotate(msg); }
        slot.sessionId = null;
        try {
          res.write(sseChunk(id, modelId, `\n\n[Proxy error: ${msg.slice(0,200)}]`));
          res.write(sseChunk(id, modelId, "", true));
          res.write("data: [DONE]\n\n");
        } catch {}
      } finally {
        try { res.end(); } catch {}
      }

    // ── Non-streaming ──────────────────────────────────────────────────────
    } else {
      const chunks = [];
      let toolCallsResult = null;

      const fakeRes = {
        write(data) {
          if (typeof data !== "string") return;
          const raw = data.startsWith("data: ") ? data.slice(6).trim() : data.trim();
          if (!raw || raw === "[DONE]") return;
          try {
            const d     = JSON.parse(raw);
            const delta = d.choices?.[0]?.delta;
            if (!delta) return;
            if (delta.content) chunks.push(delta.content);
            if (delta.tool_calls) {
              if (!toolCallsResult) toolCallsResult = [];
              delta.tool_calls.forEach(tc => {
                const idx = tc.index ?? 0;
                if (!toolCallsResult[idx])
                  toolCallsResult[idx] = { id: tc.id || `tool_${idx}`, type: "function",
                                            function: { name: "", arguments: "" } };
                if (tc.function?.name)      toolCallsResult[idx].function.name      += tc.function.name;
                if (tc.function?.arguments) toolCallsResult[idx].function.arguments += tc.function.arguments;
              });
            }
          } catch {}
        },
      };

      try {
        await streamDeepSeekWithRetry(slot, chatPayload, fakeRes, id, modelId, finalActiveTools);
      } catch (e) {
        const msg = e.message || "";
        if (/401|403|token/i.test(msg)) { slot.dead = true; rotate(msg); }
        slot.sessionId = null;
        chunks.push(`[Proxy error: ${msg.slice(0,200)}]`);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      if (toolCallsResult?.length) {
        res.end(JSON.stringify({
          id, object: "chat.completion",
          created: Math.floor(Date.now() / 1000), model: modelId,
          choices: [{ index: 0,
            message: { role: "assistant", content: null, tool_calls: toolCallsResult },
            finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      } else {
        res.end(JSON.stringify({
          id, object: "chat.completion",
          created: Math.floor(Date.now() / 1000), model: modelId,
          choices: [{ index: 0,
            message: { role: "assistant", content: chunks.join("") },
            finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      }
    }

    // ── Hapus session secara acak (seperti browser) ─────────────────────────
    if (slot.sessionId && Math.random() > 0.7) {
      slot.deleteSession(slot.sessionId).catch(() => {});
      slot.sessionId = null;
    }
  });
});

server.listen(PORT, async () => {
  console.log(`[DeepSeekProxy] ✓ http://127.0.0.1:${PORT}/v1  (${POOL.length} token siap)`);
  console.log(`[DeepSeekProxy] WASM path: ${WASM_PATH}`);
  // Pre-load WASM supaya error ketahuan dari awal
  try {
    await loadWasm();
    console.log(`[DeepSeekProxy] ✓ WASM POW solver siap`);
  } catch (e) {
    console.warn(`[DeepSeekProxy] ⚠ ${e.message}`);
    console.warn(`[DeepSeekProxy] Chat requests akan gagal sampai file .wasm tersedia!`);
  }
});