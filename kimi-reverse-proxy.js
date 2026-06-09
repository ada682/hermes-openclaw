/**
 * kimi-reverse-proxy.js — Kimi reverse API → OpenAI-compat local proxy (ESM)
 *
 * Features:
 *  • OpenAI-compatible /v1/chat/completions  (streaming + non-streaming)
 *  • /v1/models endpoint
 *  • Multi-token pool (KIMI_TOKEN_1..10) dengan auto-refresh JWT
 *  • Custom tool calling (injected as system-prompt; parsed [function_calls])
 *  • Web search: KIMI native TOOL_TYPE_SEARCH (via x-kimi-search header)
 *    — auto-detect tool bernama "web_search" di tools[] → pakai native search Kimi
 *  • Thinking mode (-thinking / -think suffix atau options.thinking)
 *  • Vision: upload gambar ke Kimi files API, poll sampai ready
 *  • Connect Protocol binary framing (encode + incremental decode)
 *
 * Env vars:
 *   KIMI_TOKEN_1..10         – Kimi tokens (refresh: cpmt_xxx  atau JWT: eyJ...)
 *   KIMI_PROXY_PORT          – port (default: 4892)
 *   KIMI_MODEL               – default model (default: kimi-k2.6)
 *   KIMI_SHOW_THINKING       – emit reasoning_content delta (default: false)
 *   KIMI_STREAM_IDLE_TIMEOUT – ms tanpa data sebelum stream dikill (default: 90000 = 90s)
 *   KIMI_STREAM_TOTAL_TIMEOUT– ms hard cap per stream (default: 300000 = 5min)
 */

import http   from "http";
import https  from "https";
import zlib   from "zlib";
import crypto from "crypto";
import { URL } from "url";

const PORT          = parseInt(process.env.KIMI_PROXY_PORT  || "4892", 10);
const BASE          = "https://www.kimi.com";
const CHAT_PATH     = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const REFRESH_PATH  = "/api/auth/token/refresh";
const MODELS_PATH   = "/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels";
const UPLOAD_PATH   = "/apiv2-files/file/upload";
const PROGRESS_PATH = "/apiv2-files/kimi.gateway.file.v1.FileService/GetFileParseProgress";

const DEFAULT_MODEL    = process.env.KIMI_MODEL         || "kimi-k2.6";
const DEFAULT_SCENARIO = "SCENARIO_K2D5";
const SHOW_THINKING    = process.env.KIMI_SHOW_THINKING  === "true";
const REFRESH_BUFFER   = 300_000; // refresh 5 menit sebelum expire (ms)
const OVERLOADED_RETRY_MAX   = parseInt(process.env.KIMI_OVERLOADED_RETRY  || "3",    10); // max retry attempts
const OVERLOADED_RETRY_DELAY = parseInt(process.env.KIMI_OVERLOADED_DELAY  || "3000", 10); // base delay ms (x attempt#)
const IMAGE_CACHE_TTL_MS     = parseInt(process.env.KIMI_IMAGE_CACHE_TTL   || String(10 * 60 * 1000), 10); // default: 10 min
const STREAM_IDLE_TIMEOUT_MS  = parseInt(process.env.KIMI_STREAM_IDLE_TIMEOUT  || "90000",  10); // 90s tanpa data → hang
const STREAM_TOTAL_TIMEOUT_MS = parseInt(process.env.KIMI_STREAM_TOTAL_TIMEOUT || "300000", 10); // 5min hard cap

// ── Image file-ID cache ──────────────────────────────────────────────────────
//
// WHY: Agent frameworks like Hermes strip base64 images from conversation
// history in later turns (to save context tokens). Without this cache, every
// request after the first would arrive at the proxy WITHOUT the image bytes,
// so no file block would be sent to Kimi and it would say "can't see image".
//
// HOW: We hash every uploaded image and store (hash → fileId). We also keep
// a recency list so that file IDs uploaded within IMAGE_CACHE_TTL_MS are
// re-injected into ALL subsequent Chat requests, even when the base64 is gone.
//
// ENV: KIMI_IMAGE_CACHE_TTL  (ms, default 10 min)

const _imgHashMap    = new Map();  // sha256[:16] → { fileId, ts }
const _recentUploads = [];         // [{fileId, ts}] ordered oldest→newest

function _imgHash(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/** Store a newly-uploaded file in both caches. */
function _imgCacheStore(hash, fileId) {
  const ts = Date.now();
  _imgHashMap.set(hash, { fileId, ts });
  _recentUploads.push({ fileId, ts });
}

/** Look up a cached file ID by image hash. Returns null if missing/expired. */
function _imgCacheGet(hash) {
  const e = _imgHashMap.get(hash);
  if (!e) return null;
  if (Date.now() - e.ts > IMAGE_CACHE_TTL_MS) { _imgHashMap.delete(hash); return null; }
  return e.fileId;
}

/**
 * Returns all file IDs uploaded within IMAGE_CACHE_TTL_MS (deduped).
 * Used to inject previously-uploaded images into requests where the base64
 * has already been stripped from the conversation history.
 */
function _recentFileIds() {
  const cutoff = Date.now() - IMAGE_CACHE_TTL_MS;
  while (_recentUploads.length && _recentUploads[0].ts < cutoff) _recentUploads.shift();
  return [...new Set(_recentUploads.map(r => r.fileId))];
}

// ── HTTPS agent ─────────────────────────────────────────────────────────────
const AGENT = new https.Agent({
  keepAlive: true, keepAliveMsecs: 30_000,
  maxSockets: 20,  timeout: 120_000,
});

// ── Fake browser headers ─────────────────────────────────────────────────────
const FAKE_HEADERS = {
  "Accept":              "*/*",
  "Accept-Encoding":     "gzip, deflate, br, zstd",
  "Accept-Language":     "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control":       "no-cache",
  "Pragma":              "no-cache",
  "Origin":              BASE,
  "R-Timezone":          "Asia/Shanghai",
  "Sec-Ch-Ua":           '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile":    "?0",
  "Sec-Ch-Ua-Platform":  '"Windows"',
  "Sec-Fetch-Dest":      "empty",
  "Sec-Fetch-Mode":      "cors",
  "Sec-Fetch-Site":      "same-origin",
  "User-Agent":          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Priority":            "u=1, i",
  "X-Msh-Platform":      "web",
};

// ── Model + scenario map ─────────────────────────────────────────────────────
// Kimi model ID  →  scenario string
const MODEL_SCENARIO = {
  "kimi-k2.6":               "SCENARIO_K2D5",
  "kimi-k2.6-agent":         "SCENARIO_K2D5",
  "kimi-k2.6-agent-swarm":   "SCENARIO_K2D5",
  "kimi-k1":                 "SCENARIO_K1",
  "kimi-k1-thinking":        "SCENARIO_K1",
};

// Short alias → canonical model ID
const MODEL_ALIAS = {
  "kimi":            "kimi-k2.6",
  "kimi-k2":         "kimi-k2.6",
  "kimi-k2-think":   "kimi-k2.6",
  "kimi-k2-thinking":"kimi-k2.6",
};

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN SLOT — handles refresh lifecycle per token
// ═══════════════════════════════════════════════════════════════════════════════

function newDeviceId()  { return String(Math.floor(7e18 + Math.random() * 9e17)); }
function newSessionId() { return String(Math.floor(1.7e18 + Math.random() * 9e16)); }

function parseJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    payload += "=".repeat((4 - payload.length % 4) % 4);
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch { return null; }
}

function isJwt(token) {
  if (!token?.startsWith("eyJ")) return false;
  const p = parseJwt(token);
  return !!(p && p.app_id === "kimi" && p.typ === "access");
}

class TokenSlot {
  constructor(raw, slotNum) {
    this.slot      = slotNum;
    this.dead      = false;
    this.deviceId  = newDeviceId();
    this.sessionId = newSessionId();
    this._refreshing = false;
    this._waiters    = [];

    if (isJwt(raw)) {
      const p         = parseJwt(raw);
      this.accessToken  = raw;
      this.refreshToken = null;       // JWT-only: no refresh token
      this.expiresAt    = p?.exp ? p.exp * 1000 : 0;
      this._hasJwt      = true;
    } else {
      // Refresh token (cpmt_xxx...) — must refresh to get first JWT
      this.accessToken  = raw;
      this.refreshToken = raw;
      this.expiresAt    = 0;
      this._hasJwt      = false;
    }
  }

  _needsRefresh() {
    if (!this._hasJwt) return true;                              // never refreshed yet
    if (this.expiresAt === 0) return false;                      // unknown expiry → trust it
    return Date.now() > (this.expiresAt - REFRESH_BUFFER);
  }

  makeHeaders(extra = {}) {
    return {
      ...FAKE_HEADERS,
      "Authorization":    `Bearer ${this.accessToken}`,
      "X-Msh-Device-Id":  this.deviceId,
      "X-Msh-Session-Id": this.sessionId,
      ...extra,
    };
  }

  async getAccessToken() {
    if (!this._needsRefresh()) return this.accessToken;

    // Serialise concurrent refresh attempts
    if (this._refreshing) {
      await new Promise(r => this._waiters.push(r));
      return this.accessToken;
    }
    this._refreshing = true;
    try {
      await this._doRefresh();
    } finally {
      this._refreshing = false;
      this._waiters.splice(0).forEach(r => r());
    }
    return this.accessToken;
  }

  _doRefresh() {
    const rt = this.refreshToken || this.accessToken;
    const headers = {
      ...FAKE_HEADERS,
      // Override Accept-Encoding ke identity — Node http tidak auto-decompress,
      // jadi kalau server kirim gzip/br response body jadi binary garbage.
      "Accept-Encoding":  "identity",
      "Accept":           "application/json",
      "Authorization":    `Bearer ${rt}`,
      "X-Msh-Device-Id":  this.deviceId,
      "X-Msh-Session-Id": this.sessionId,
    };
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "www.kimi.com", path: REFRESH_PATH, method: "GET",
        headers, agent: AGENT,
      }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const preview = Buffer.concat(chunks).toString("utf8", 0, 120);
            return reject(new Error(`Token refresh HTTP ${res.statusCode}: ${preview}`));
          }
          // Dekompresi kalau server tetap kirim gzip/br (safety net)
          const rawBuf = Buffer.concat(chunks);
          const enc    = (res.headers["content-encoding"] || "").toLowerCase();
          const decompress = enc.includes("gzip") || enc.includes("deflate")
            ? () => new Promise((rs, rj) => zlib.gunzip(rawBuf, (e, b) => e ? rj(e) : rs(b)))
            : enc.includes("br")
            ? () => new Promise((rs, rj) => zlib.brotliDecompress(rawBuf, (e, b) => e ? rj(e) : rs(b)))
            : () => Promise.resolve(rawBuf);

          decompress().then(buf => {
            try {
              const text     = buf.toString("utf8");
              const data     = JSON.parse(text);
              const newToken = data.access_token || data.token;
              if (!newToken) return reject(new Error(`Refresh response: no access_token. body=${text.slice(0, 120)}`));
              const p          = parseJwt(newToken);
              this.accessToken = newToken;
              this.expiresAt   = p?.exp ? p.exp * 1000 : 0;
              this._hasJwt     = true;
              console.log(`[KimiProxy] slot ${this.slot} token refreshed | exp=${
                this.expiresAt ? new Date(this.expiresAt).toISOString() : "unknown"
              }`);
              resolve();
            } catch (e) {
              const preview = buf.toString("utf8", 0, 120).replace(/[\x00-\x1f]/g, "·");
              reject(new Error(`Refresh parse error: ${e.message} | body=${preview}`));
            }
          }).catch(e => reject(new Error(`Refresh decompress error: ${e.message}`)));
        });
      });
      req.on("error", reject);
      req.end();
    });
  }
}

// ── Token pool ───────────────────────────────────────────────────────────────
const POOL = [];
for (let i = 1; i <= 10; i++) {
  const t = (process.env[`KIMI_TOKEN_${i}`] || "").trim();
  if (t) POOL.push(new TokenSlot(t, i));
}
if (!POOL.length) {
  console.error("[KimiProxy] ERROR: Tidak ada token! Set KIMI_TOKEN_1 dulu.");
  process.exit(1);
}
console.log(`[KimiProxy] ${POOL.length} token dimuat | port=${PORT} | model=${DEFAULT_MODEL} | showThinking=${SHOW_THINKING}`);

let rrIdx = 0;
function alive() {
  let a = POOL.filter(t => !t.dead);
  if (!a.length) { POOL.forEach(t => t.dead = false); a = POOL; }
  return a;
}
function nextSlot() {
  const a    = alive();
  const slot = a[rrIdx % a.length];
  rrIdx++;
  console.log(`[KimiProxy] nextSlot → slot ${slot.slot}`);
  return slot;
}
function rotate(reason) {
  rrIdx++;
  console.log(`[KimiProxy] rotate → slot ${alive()[rrIdx % alive().length]?.slot} | ${reason}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

/** Promise-based sleep */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Thrown when Kimi returns REASON_COMPLETION_OVERLOADED.
 * Caught by the HTTP handler to trigger a retry loop.
 */
class OverloadedError extends Error {
  constructor(msg) { super(msg); this.name = "OverloadedError"; this.isOverloaded = true; }
}

/**
 * Thrown when Kimi stream hangs (idle timeout atau total timeout).
 * Di-retry dengan slot berbeda — slot saat ini kemungkinan sedang "stuck".
 */
class StreamTimeoutError extends Error {
  constructor(msg) { super(msg); this.name = "StreamTimeoutError"; this.isTimeout = true; }
}

/**
 * Resolve model name → { modelId, thinking, scenario }
 *
 * Suffix rules:
 *   -thinking / -think  → thinking: true
 *   (none)              → thinking: false
 */
function mapModel(name) {
  let m       = (name || DEFAULT_MODEL).toLowerCase();
  let thinking = false;

  if (m.endsWith("-thinking")) { thinking = true; m = m.slice(0, -9); }
  else if (m.endsWith("-think")) { thinking = true; m = m.slice(0, -6); }

  const modelId  = MODEL_ALIAS[m] || m;
  const scenario = MODEL_SCENARIO[modelId] || DEFAULT_SCENARIO;
  return { modelId, thinking, scenario };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECT PROTOCOL BINARY FRAMING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Encode JSON payload → 5-byte header + body
 * Header: [flag:1 byte][length:4 bytes big-endian]
 * flag 0x00 = data frame
 */
function encodeFrame(payload) {
  const body   = Buffer.from(JSON.stringify(payload, null, 0), "utf8");
  const header = Buffer.alloc(5);
  header[0] = 0x00;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/**
 * Returns a stateful chunk processor that calls onEvent(parsed) for each
 * complete data frame in the binary stream.
 * Handles frames split across multiple TCP chunks.
 */
function makeFrameParser(onEvent) {
  let buf = Buffer.alloc(0);

  return function processChunk(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const flag   = buf[0];
      const length = buf.readUInt32BE(1);
      if (buf.length < 5 + length) break;     // incomplete frame, wait for more

      const payload = buf.slice(5, 5 + length);
      buf = buf.slice(5 + length);

      if (flag & 0x80) continue;              // trailer frame (0x80), skip

      const text = payload.toString("utf8").trim();
      if (!text) continue;

      let event;
      try { event = JSON.parse(text); }
      catch { continue; }

      onEvent(event);
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISION — file upload + progress poll
// ═══════════════════════════════════════════════════════════════════════════════

/** Upload satu gambar ke Kimi → return { fileId, alreadyReady } */
async function uploadImageToKimi(slot, buffer, filename, mimetype) {
  const token    = await slot.getAccessToken();
  const boundary = `----KimiBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const CRLF     = "\r\n";

  const head   = Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: ${mimetype}${CRLF}${CRLF}`);
  const foot   = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body   = Buffer.concat([head, buffer, foot]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.kimi.com", path: UPLOAD_PATH, method: "POST",
      headers: {
        ...slot.makeHeaders({
          // Override ke identity supaya server tidak kirim gzip/br —
          // Node http tidak auto-decompress, binary jadi garbage string.
          "Accept-Encoding": "identity",
          "Accept":          "application/json",
          "Content-Type":    `multipart/form-data; boundary=${boundary}`,
          "Content-Length":  String(body.length),
          "Referer":         `${BASE}/`,
        }),
      },
      agent: AGENT,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
      res.on("end", () => {
        const rawBuf = Buffer.concat(chunks);
        const enc    = (res.headers["content-encoding"] || "").toLowerCase();
        const decompress = enc.includes("gzip") || enc.includes("deflate")
          ? () => new Promise((rs, rj) => zlib.gunzip(rawBuf, (e, b) => e ? rj(e) : rs(b)))
          : enc.includes("br")
          ? () => new Promise((rs, rj) => zlib.brotliDecompress(rawBuf, (e, b) => e ? rj(e) : rs(b)))
          : () => Promise.resolve(rawBuf);

        decompress().then(buf => {
          const d = buf.toString("utf8");
          if (res.statusCode !== 200)
            return reject(new Error(`Upload HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
          try {
            const r      = JSON.parse(d);
            const fileId = r?.file?.id;
            if (!fileId) return reject(new Error(`Upload: no file.id in response. body=${d.slice(0, 120)}`));
            // parseResult.thumbnail sudah ada di upload response → gambar langsung ready
            const alreadyReady = !!(r?.file?.parseResult?.thumbnail?.thumbnailUrl ||
                                    r?.file?.parseResult?.thumbnail?.previewUrl);
            resolve({ fileId, alreadyReady });
          } catch (e) {
            const preview = buf.toString("utf8", 0, 120).replace(/[\x00-\x1f]/g, "·");
            reject(new Error(`Upload parse error: ${e.message} | body=${preview}`));
          }
        }).catch(e => reject(new Error(`Upload decompress error: ${e.message}`)));
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Poll file parse progress — wait PROCESS_STATUS_SUCCESS (max ~10s) */
async function waitFileReady(slot, fileId) {
  // GetFileParseProgress adalah plain JSON REST (bukan binary-framed),
  // walaupun URL-nya punya pola gRPC-style.
  const reqBody = Buffer.from(JSON.stringify({ file_ids: [fileId] }));

  for (let i = 0; i < 20; i++) {
    const data = await new Promise(resolve => {
      const req = https.request({
        hostname: "www.kimi.com", path: PROGRESS_PATH, method: "POST",
        headers: {
          ...slot.makeHeaders({
            "Accept-Encoding": "identity",
            "Content-Type":    "application/json",
            "Accept":          "application/json",
          }),
          "Content-Length": String(reqBody.length),
        },
        agent: AGENT,
      }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
        res.on("end", () => {
          const rawBuf = Buffer.concat(chunks);
          const enc    = (res.headers["content-encoding"] || "").toLowerCase();
          const decompress = enc.includes("gzip") || enc.includes("deflate")
            ? () => new Promise((rs, rj) => zlib.gunzip(rawBuf, (e, b) => e ? rj(e) : rs(b)))
            : enc.includes("br")
            ? () => new Promise((rs, rj) => zlib.brotliDecompress(rawBuf, (e, b) => e ? rj(e) : rs(b)))
            : () => Promise.resolve(rawBuf);
          decompress()
            .then(buf => { try { resolve(JSON.parse(buf.toString("utf8"))); } catch { resolve({}); } })
            .catch(() => resolve({}));
        });
      });
      req.on("error", () => resolve({}));
      req.write(reqBody);
      req.end();
    });

    const prog = data?.progresses?.[0];
    if (prog) {
      const st = prog.status || "";
      if (i === 0) console.log(`[Vision] progress status[0]: ${st}`);
      if (st === "PROCESS_STATUS_SUCCESS") return true;
      if (st === "PROCESS_STATUS_FAILED") {
        console.warn(`[Vision] file ${fileId} parse FAILED`);
        return false;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Timeout — gambar (JPEG/PNG/GIF) sudah bisa dipakai setelah upload
  // walaupun progress belum confirm. Lanjutkan daripada skip.
  console.warn(`[Vision] waitFileReady timeout for ${fileId} — tetap dipakai`);
  return true;
}

/** Scan OpenAI messages[] → extract base64 image_url entries (with content hash) */
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
      const buf      = Buffer.from(m[2], "base64");
      const ext      = mimetype.split("/")[1]?.split("+")[0] || "jpg";
      const hash     = _imgHash(buf);
      images.push({ buffer: buf, mimetype, filename: `img_${Date.now()}_${images.length}.${ext}`, hash });
    }
  }
  return images;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL CALLING (same inject-parse approach as Qwen proxy)
// ═══════════════════════════════════════════════════════════════════════════════

function toolsToSystemPrompt(tools, toolChoice = "auto") {
  if (!tools?.length || toolChoice === "none") return "";

  const defs = tools.map(t => {
    const f      = t.function || t;
    const name   = f.name        || t.name        || "";
    const desc   = f.description || t.description || "";
    const params = f.parameters  || f.input_schema || t.parameters || {};
    return `Tool \`${name}\`: ${desc}.\nArguments JSON schema:\n${JSON.stringify(params, null, 2)}`;
  });

  const isRequired   = toolChoice === "required" ||
                       (typeof toolChoice === "object" && toolChoice?.type === "function");
  const forcedFnName = typeof toolChoice === "object" ? toolChoice?.function?.name : null;
  const forceNote    = isRequired
    ? `\n\nIMPORTANT: You MUST call ${forcedFnName ? `the \`${forcedFnName}\` tool` : "one of the available tools"} — do NOT answer in plain text.`
    : "";

  const toolNames = tools.map(t => (t.function || t).name || t.name).join(", ");
  console.log(`[KimiProxy] Injecting ${tools.length} tool(s): ${toolNames} | tool_choice=${JSON.stringify(toolChoice)}`);

  return `## Available Tools
You can invoke the following tools. Only call when genuinely needed; follow each JSON schema exactly.

CRITICAL: Tool names are CASE-SENSITIVE. Use the exact name as listed below.

${defs.join("\n\n")}

## Tool Call Protocol
To call a tool, respond with NOTHING except a single [function_calls] block:

[function_calls]
[call:exact_tool_name]{"argument": "value"}[/call]
[/function_calls]

RULES:
1. Every call MUST use [call:name]{...}[/call] syntax
2. JSON arguments MUST be on ONE LINE — no newlines inside the braces
3. To call multiple tools, put multiple [call:...][/call] lines inside ONE block
4. Output NOTHING else when calling tools${forceNote}`;
}

function hasToolUse(content) {
  return content.includes("[function_calls") || content.includes("<tool_use>");
}

function parseToolUse(content) {
  const calls = [];

  if (content.includes("[function_calls")) {
    const re = /\[call:([\w.\-]+)\]([\s\S]*?)\[\/call\]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const args = m[2].trim().replace(/\s+/g, " ");
      calls.push({ id: `tool_${calls.length}`, type: "function",
                   function: { name: m[1], arguments: args } });
    }
  }

  if (content.includes("<tool_use>")) {
    const re = /<tool_use>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<arguments>([\s\S]+?)<\/arguments>[\s\S]*?<\/tool_use>/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const args = m[2].trim().replace(/\s+/g, " ");
      calls.push({ id: `tool_${calls.length}`, type: "function",
                   function: { name: m[1].trim(), arguments: args } });
    }
  }

  return calls.length ? calls : null;
}

// ── Build Kimi message blocks from OpenAI messages[] ────────────────────────
// Semua history disatukan jadi satu content string + optional file blocks.
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter(p => p.type === "text").map(p => p.text || "").join("\n");
  return String(content || "");
}

function buildKimiBlocks(messages, tools = [], toolChoice = "auto", imageFileIds = []) {
  const toolPrompt  = toolsToSystemPrompt(tools, toolChoice);
  const systemLines = [];
  const bodyParts   = [];
  let pendingUser   = null;

  for (const msg of messages) {
    const text = extractText(msg.content);

    if (msg.role === "system") {
      systemLines.push(text);

    } else if (msg.role === "user") {
      if (pendingUser !== null) bodyParts.push(`user:${pendingUser}`);
      pendingUser = text;

    } else if (msg.role === "assistant") {
      let assistantText = text;
      if (!assistantText && msg.tool_calls?.length) {
        const lines = msg.tool_calls
          .map(tc => `[call:${tc.function.name}]${tc.function.arguments}[/call]`)
          .join("\n");
        assistantText = `[function_calls]\n${lines}\n[/function_calls]`;
      }
      if (pendingUser !== null) { bodyParts.push(`user:${pendingUser}`); pendingUser = null; }
      bodyParts.push(`assistant:${assistantText}`);

    } else if (msg.role === "tool") {
      const label   = msg.name || msg.tool_call_id || "call";
      let rawText   = extractText(msg.content);
      rawText = rawText
        .replace(/\\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, " ")
        .replace(/\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\n?/gi, " ")
        .replace(/\s{2,}/g, " ").trim();
      const truncated  = rawText.length > 6000 ? rawText.slice(0, 6000) + "… [truncated]" : rawText;
      const toolResult = `[Tool result for ${label}: ${truncated}]`;
      pendingUser = pendingUser !== null ? `${pendingUser}\n${toolResult}` : toolResult;
    }
  }

  if (pendingUser !== null) {
    if (pendingUser.startsWith("[Tool result")) {
      pendingUser += "\n\nGunakan informasi dari tool results di atas untuk memberikan jawaban LANGSUNG dan RINGKAS. JANGAN ulangi isi tool result.";
    }
    bodyParts.push(`user:${pendingUser}`);
  }

  let fullContent = "";
  if (toolPrompt)          fullContent += toolPrompt + "\n\n";
  if (systemLines.length)  fullContent += systemLines.join("\n") + "\n\n";
  fullContent += bodyParts.join("\n");

  // ── Native vision hint saat gambar dilampirkan sebagai file blocks ─────────
  // Tanpa hint ini, Kimi sebagai agent cenderung memanggil tool vision_analyze
  // (Hermes local cache) yang pasti gagal karena base64 sudah di-strip.
  // Hint ini memberitahu Kimi untuk memakai kemampuan vision natifnya langsung.
  if (imageFileIds.length > 0) {
    fullContent += `\n\n[SISTEM: ${imageFileIds.length} gambar dilampirkan langsung dalam percakapan ini sebagai Kimi file block. Kamu BISA melihat dan menganalisis gambar tersebut menggunakan kemampuan vision natifmu — JANGAN memanggil tool vision_analyze atau tool vision eksternal lainnya, karena gambar sudah ada di konteks ini dan bisa kamu lihat langsung.]`;
  }

  // Text block + optional file blocks
  const blocks = [
    { message_id: "", text: { content: fullContent.trim() } },
    ...imageFileIds.map(id => ({ file: { id, status: "PROCESS_STATUS_SUCCESS" } })),
  ];
  return blocks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function sseChunk(id, model, content, done = false) {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: done ? {} : { content }, finish_reason: done ? "stop" : null }],
  })}\n\n`;
}

function sseReasoningChunk(id, model, text) {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
  })}\n\n`;
}

function emitToolCalls(res, id, model, answerBuf) {
  const toolCalls = parseToolUse(answerBuf);
  if (!toolCalls) {
    // Parse gagal — emit finish_reason "stop" supaya Hermes tidak dapat empty stream
    res.write(`data: ${JSON.stringify({
      id, model, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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

// Safe flush — stop before any tool-marker (or partial prefix thereof)
const TOOL_MARKERS = ["[function_calls", "<tool_use>"];

function safeFlushPoint(buf) {
  let safe = buf.length;
  for (const marker of TOOL_MARKERS) {
    const fi = buf.indexOf(marker);
    if (fi !== -1) { safe = Math.min(safe, fi); continue; }
    for (let l = Math.min(marker.length - 1, buf.length); l > 0; l--) {
      if (buf.slice(-l) === marker.slice(0, l)) { safe = Math.min(safe, buf.length - l); break; }
    }
  }
  return safe;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE STREAMER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Stream Kimi chat → forward as OpenAI-compatible SSE
 *
 * Event parsing (Kimi Connect Protocol binary frames → JSON events):
 *
 *  mask contains "block.think"  → reasoning_content delta  (if SHOW_THINKING)
 *  mask contains "block.text"   → answer content delta
 *    phase == "thinking"        → route to reasoning_content instead
 *  event.done === true          → stream finished
 *
 * Tool call detection works the same as Qwen proxy:
 *   answerBuf accumulates; if [function_calls] marker detected → emit tool_calls chunks
 */
function streamKimi(slot, blocks, scenario, thinking, useSearch, res, id, modelId, activeTools = false) {
  return new Promise(async (resolve, reject) => {
    let token;
    try { token = await slot.getAccessToken(); }
    catch (e) { return reject(e); }

    const payload = {
      scenario,
      tools: useSearch ? [{ type: "TOOL_TYPE_SEARCH", search: {} }] : [],
      message: { role: "user", blocks, scenario },
      options: { thinking },
    };

    const frame   = encodeFrame(payload);
    const headers = slot.makeHeaders({
      "Content-Type":             "application/connect+json",
      "Accept":                   "application/connect+json",
      "Connect-Protocol-Version": "1",
      "Content-Length":           String(frame.length),
      "Referer":                  `${BASE}/`,
    });

    const req = https.request({
      hostname: "www.kimi.com", path: CHAT_PATH, method: "POST",
      headers, agent: AGENT,
    }, kimiRes => {
      if (kimiRes.statusCode !== 200) {
        let b = "";
        kimiRes.on("data", c => b += c);
        kimiRes.on("end", () => reject(new Error(`HTTP ${kimiRes.statusCode}: ${b.slice(0, 200)}`)));
        return;
      }

      let answerBuf    = "";
      let sentUpTo     = 0;
      let currentPhase = "answer";   // "thinking" | "answer"
      let reasoningSent = false;
      let resolved      = false;

      // ── Stream timeouts ─────────────────────────────────────────────────────
      // Kimi kadang biarkan koneksi TCP tetap hidup tanpa kirim data / event.done.
      // Tanpa timer ini proxy nunggu selamanya (jam-jaman).
      // - IDLE timeout  : reset setiap kali ada chunk data masuk
      // - TOTAL timeout : hard cap untuk satu stream, apapun yang terjadi
      let _idleTimer  = null;
      let _totalTimer = null;

      function _clearTimers() {
        if (_idleTimer)  { clearTimeout(_idleTimer);  _idleTimer  = null; }
        if (_totalTimer) { clearTimeout(_totalTimer); _totalTimer = null; }
      }

      function _kickIdle() {
        if (_idleTimer) clearTimeout(_idleTimer);
        _idleTimer = setTimeout(() => {
          if (resolved) return;
          _clearTimers();
          resolved = true;
          console.error(`[KimiProxy] ✗ stream idle timeout — tidak ada data selama ${STREAM_IDLE_TIMEOUT_MS/1000}s`);
          try { kimiRes.destroy(); } catch {}
          reject(new StreamTimeoutError(`Kimi stream idle timeout (${STREAM_IDLE_TIMEOUT_MS/1000}s)`));
        }, STREAM_IDLE_TIMEOUT_MS);
      }

      _totalTimer = setTimeout(() => {
        if (resolved) return;
        _clearTimers();
        resolved = true;
        console.error(`[KimiProxy] ✗ stream total timeout — melebihi ${STREAM_TOTAL_TIMEOUT_MS/1000}s`);
        try { kimiRes.destroy(); } catch {}
        reject(new StreamTimeoutError(`Kimi stream total timeout (${STREAM_TOTAL_TIMEOUT_MS/1000}s)`));
      }, STREAM_TOTAL_TIMEOUT_MS);

      _kickIdle(); // mulai hitungan idle dari saat response headers diterima

      function done() {
        if (resolved) return;
        _clearTimers();
        resolved = true;

        if (activeTools && hasToolUse(answerBuf)) {
          const toolCalls = parseToolUse(answerBuf);
          if (toolCalls) {
            emitToolCalls(res, id, modelId, answerBuf);
          } else {
            // Malformed tool block — flush pre-marker text
            const tail = answerBuf.slice(sentUpTo);
            let stop = tail.length;
            for (const m of TOOL_MARKERS) { const i = tail.indexOf(m); if (i >= 0) stop = Math.min(stop, i); }
            if (tail.slice(0, stop)) res.write(sseChunk(id, modelId, tail.slice(0, stop)));
            res.write(sseChunk(id, modelId, "", true));
          }
        } else {
          const remaining = answerBuf.slice(sentUpTo);
          if (remaining) res.write(sseChunk(id, modelId, remaining));
          res.write(sseChunk(id, modelId, "", true));
        }
        res.write("data: [DONE]\n\n");
        resolve();
      }

      const parseChunk = makeFrameParser(event => {
        if (resolved) return;

        // Server-side error (event.error) OR overloaded exception (event.exception.error)
        if (event.error || event.exception) {
          const err    = event.error ?? event.exception?.error ?? {};
          const reason = err.reason || "";
          const msg    = err.localizedMessage?.message || err.message || JSON.stringify(err);
          console.error(`[KimiProxy] server error: ${reason || "unknown"} | ${msg}`);
          if (!resolved) {
            resolved = true;
            _clearTimers();
            if (reason === "REASON_COMPLETION_OVERLOADED") {
              reject(new OverloadedError(msg));
            } else {
              reject(new Error(msg));
            }
          }
          return;
        }

        // Done signal
        if (event.done === true) { done(); return; }

        // Phase detection via multiStage
        const stages = event.block?.multiStage?.stages || [];
        if (stages.length) {
          const s = stages[0];
          if (s.name === "STAGE_NAME_THINKING")
            currentPhase = s.status === "completed" ? "answer" : "thinking";
        }

        // Phase detection via text.flags
        const flags = event.block?.text?.flags;
        if (flags === "thinking")     currentPhase = "thinking";
        else if (flags === "answer")  currentPhase = "answer";

        const mask = event.mask || "";

        // ── Think block ────────────────────────────────────────────────────
        if (mask.includes("block.think")) {
          const tc = event.block?.think?.content;
          if (tc && SHOW_THINKING) {
            if (!reasoningSent) {
              res.write(`data: ${JSON.stringify({
                id, object: "chat.completion.chunk", model: modelId,
                created: Math.floor(Date.now() / 1000),
                choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "" }, finish_reason: null }],
              })}\n\n`);
              reasoningSent = true;
            }
            res.write(sseReasoningChunk(id, modelId, tc));
          }
          return;
        }

        // ── Text block ─────────────────────────────────────────────────────
        const tc = event.block?.text?.content;
        if (tc != null) {
          if (currentPhase === "thinking") {
            if (SHOW_THINKING) {
              if (!reasoningSent) {
                res.write(`data: ${JSON.stringify({
                  id, object: "chat.completion.chunk", model: modelId,
                  created: Math.floor(Date.now() / 1000),
                  choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "" }, finish_reason: null }],
                })}\n\n`);
                reasoningSent = true;
              }
              res.write(sseReasoningChunk(id, modelId, tc));
            }
          } else {
            // Answer phase — accumulate + safe-flush
            answerBuf += tc;

            const safe = safeFlushPoint(answerBuf);
            if (safe > sentUpTo) {
              const toFlush = answerBuf.slice(sentUpTo, safe);
              if (toFlush) res.write(sseChunk(id, modelId, toFlush));
              sentUpTo = safe;
            }

            // Early-finish for tool calls
            // PENTING: cek blok LENGKAP dulu ([/function_calls] atau </tool_use> sudah ada)
            // Jangan fire sebelum blok lengkap — buffer masih parsial → parseToolUse null
            // → emitToolCalls tidak emit finish_reason → Hermes: "empty stream"
            if (activeTools && hasToolUse(answerBuf) && !resolved) {
              const blockComplete = answerBuf.includes("[/function_calls]") ||
                                    answerBuf.includes("</tool_use>");
              if (blockComplete) {
                resolved = true;
                _clearTimers();
                emitToolCalls(res, id, modelId, answerBuf);
                res.write("data: [DONE]\n\n");
                resolve();
              }
              // else: blok belum selesai, terus akumulasi chunk berikutnya
            }
          }
        }
      });

      kimiRes.on("data", chunk => {
        _kickIdle(); // reset idle timer setiap ada data masuk
        try { parseChunk(chunk); } catch (e) {
          console.error("[KimiProxy] frame parse error:", e.message);
        }
      });
      kimiRes.on("end",   () => { _clearTimers(); if (!resolved) done(); });
      kimiRes.on("error", e  => { _clearTimers(); if (!resolved) { resolved = true; reject(e); } });
    });

    req.on("error", reject);
    req.write(frame);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERLOADED RETRY WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wraps streamKimi with exponential-backoff retry on REASON_COMPLETION_OVERLOADED.
 *
 * Retry strategy:
 *   attempt 1 (original) → overloaded → wait 1×DELAY → rotate slot → attempt 2
 *   attempt 2            → overloaded → wait 2×DELAY → rotate slot → attempt 3
 *   attempt N            → overloaded → give up, throw OverloadedError to caller
 *
 * For SSE streaming the connection stays open during the wait; an SSE comment
 * (": retrying…") is written to keep the TCP connection alive.
 *
 * @param {TokenSlot} firstSlot   – slot chosen for the first attempt
 * @param {boolean}   isStreaming – true → write SSE keep-alive comments during wait
 */
async function streamKimiWithRetry(firstSlot, blocks, scenario, thinking, useSearch, res, id, modelId, activeTools = false, isStreaming = false) {
  let curSlot = firstSlot;
  for (let attempt = 0; attempt <= OVERLOADED_RETRY_MAX; attempt++) {
    try {
      await streamKimi(curSlot, blocks, scenario, thinking, useSearch, res, id, modelId, activeTools);
      if (attempt > 0) console.log(`[KimiProxy] ✓ retry berhasil di attempt ${attempt + 1}`);
      return; // ✓ success
    } catch (e) {
      const retryable = (e.isOverloaded || e.isTimeout) && attempt < OVERLOADED_RETRY_MAX;
      if (retryable) {
        if (e.isOverloaded) {
          const delay = OVERLOADED_RETRY_DELAY * (attempt + 1);
          console.warn(`[KimiProxy] ⚠ Overloaded (attempt ${attempt + 1}/${OVERLOADED_RETRY_MAX + 1}) — retry in ${delay}ms...`);
          if (isStreaming) {
            try { res.write(`: kimi overloaded, retrying (${attempt + 1}/${OVERLOADED_RETRY_MAX})...\n\n`); } catch {}
          }
          await sleep(delay);
        } else {
          // isTimeout — langsung retry tanpa delay, slot stuck bukan soal load
          console.warn(`[KimiProxy] ⚠ Stream timeout (attempt ${attempt + 1}/${OVERLOADED_RETRY_MAX + 1}) — ganti slot segera...`);
          if (isStreaming) {
            try { res.write(`: kimi stream timeout, retrying slot lain...\n\n`); } catch {}
          }
        }
        curSlot = nextSlot();
      } else {
        // Error lain atau retry habis → bubble up ke HTTP handler
        if (e.isOverloaded) console.error(`[KimiProxy] ✗ Overloaded after ${OVERLOADED_RETRY_MAX + 1} attempts — giving up.`);
        if (e.isTimeout)    console.error(`[KimiProxy] ✗ Stream timeout after ${OVERLOADED_RETRY_MAX + 1} attempts — giving up.`);
        throw e;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-kimi-search");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── GET /v1/models ─────────────────────────────────────────────────────────
  if (req.method === "GET" && (
      req.url === "/v1" || req.url === "/v1/" || req.url === "/health" ||
      req.url?.startsWith("/v1/models"))) {
    res.writeHead(200, { "Content-Type": "application/json" });
    const allModels = [...new Set([
      ...Object.keys(MODEL_ALIAS),
      ...Object.keys(MODEL_SCENARIO),
      DEFAULT_MODEL,
    ])];
    res.end(JSON.stringify({
      object: "list",
      data: allModels.map(id => ({ id, object: "model", created: 0, owned_by: "kimi-reverse" })),
    }));
    return;
  }

  // ── Not found ──────────────────────────────────────────────────────────────
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

    const rawModel   = parsed.model || DEFAULT_MODEL;
    const messages   = parsed.messages || [];
    const tools      = parsed.tools    || [];
    const toolChoice = parsed.tool_choice ?? "auto";

    // Web search detection:
    //   1. x-kimi-search: true header  → aktifkan Kimi native TOOL_TYPE_SEARCH
    //   2. enable_search param         → aktifkan Kimi native TOOL_TYPE_SEARCH
    //
    // TIDAK diaktifkan hanya karena ada "web_search" di tools[] !
    // Kalau Hermes agent kirim web_search di tools[], biarkan jadi custom tool biasa —
    // Hermes yang akan eksekusi web search-nya sendiri (bukan Kimi native).
    //
    // Alur Hermes:
    //   Kimi output [function_calls][call:web_search]...[/call]
    //   → proxy relay sebagai tool_call → Hermes eksekusi search → kirim tool result
    //
    // PENTING: kalau Kimi native search (TOOL_TYPE_SEARCH) aktif, kosongkan customTools.
    // Keduanya tidak bisa berjalan bersamaan — Kimi akan return [function_calls]
    // yang bentrok dengan native search flow dan menyebabkan hermes "empty stream" error.
    const nativeSearchToolNames = ["web_search", "search", "browser_search", "web_browse", "web_extract"];
    const hasNativeSearchTool = tools.some(t => {
      const n = (t.function?.name || t.name || "").toLowerCase();
      return nativeSearchToolNames.includes(n);
    });

    // Native search HANYA dari explicit signal — bukan dari kehadiran tool web_search
    const useSearch = req.headers["x-kimi-search"] === "true" ||
                      parsed.enable_search === true;

    // Kalau native search aktif: kosongkan customTools (conflict Kimi).
    // Kalau tidak: pakai semua tools apa adanya (termasuk web_search → Hermes eksekusi).
    const customTools = useSearch ? [] : tools;

    const { modelId, thinking: thinkingFromModel, scenario } = mapModel(rawModel);
    const thinking    = thinkingFromModel || (parsed.enable_thinking === true);
    const activeTools = !!(customTools.length && toolChoice !== "none");

    if (useSearch) {
      console.log(`[KimiProxy] Kimi native TOOL_TYPE_SEARCH aktif (explicit)${hasNativeSearchTool ? " | web_search dari Hermes di-strip" : ""}`);
    } else if (hasNativeSearchTool) {
      console.log(`[KimiProxy] web_search detected → relay sebagai custom tool (Hermes yang eksekusi)`);
    }
    console.log(`[KimiProxy] ← model=${rawModel} → ${modelId} | msgs=${messages.length} customTools=${customTools.length} thinking=${thinking} search=${useSearch}`);

    // ── Vision: upload images ────────────────────────────────────────────────
    let imageFileIds = [];
    const rawImages = extractImagesFromMessages(messages);
    if (rawImages.length) {
      console.log(`[Vision] ${rawImages.length} gambar terdeteksi — upload ke Kimi...`);
      const vSlot = alive()[rrIdx % alive().length];
      try {
        for (const img of rawImages) {
          // Check hash cache first — avoid re-uploading the same image
          const cachedId = _imgCacheGet(img.hash);
          if (cachedId) {
            console.log(`[Vision] Cache hit: ${img.filename} → ${cachedId} (reuse ✓)`);
            imageFileIds.push(cachedId);
            continue;
          }
          const { fileId, alreadyReady } = await uploadImageToKimi(vSlot, img.buffer, img.filename, img.mimetype);
          console.log(`[Vision] Uploaded: ${img.filename} → ${fileId}${alreadyReady ? " (ready ✓)" : ""}`);
          if (alreadyReady) {
            imageFileIds.push(fileId);
            _imgCacheStore(img.hash, fileId);
          } else {
            const ready = await waitFileReady(vSlot, fileId);
            if (ready) { imageFileIds.push(fileId); _imgCacheStore(img.hash, fileId); }
            else console.warn(`[Vision] File ${fileId} belum ready, skip.`);
          }
        }
      } catch (e) {
        console.warn(`[Vision] Upload gagal (lanjut tanpa gambar): ${e.message}`);
      }
    }

    // ── Inject recent file IDs (agent context continuity) ───────────────────
    // Hermes dan agent framework lain sering strip base64 dari history setelah
    // beberapa turn untuk hemat token. Kita inject file ID yang diupload dalam
    // window IMAGE_CACHE_TTL_MS agar Kimi tetap bisa lihat gambar tsb.
    {
      const fresh = _recentFileIds().filter(id => !imageFileIds.includes(id));
      if (fresh.length) {
        console.log(`[Vision] Injecting ${fresh.length} cached file ID(s) from recent uploads: ${fresh.join(", ")}`);
        imageFileIds.push(...fresh);
      }
    }

    // ── Suppress vision_analyze saat gambar ada di Kimi file blocks ─────────
    // vision_analyze (dieksekusi Hermes) cari gambar di LOCAL file cache, bukan
    // di Kimi file blocks. Kalau gambar sudah ada di file blocks, hapus tool ini
    // supaya Kimi pakai native vision langsung — bukan relay ke Hermes local cache
    // yang pasti gagal karena base64 sudah di-strip dari conversation history.
    let toolsForBlocks = customTools;
    if (imageFileIds.length > 0) {
      const VISION_TOOL_NAMES = ["vision_analyze", "image_analyze", "analyze_image", "vision"];
      const before = customTools.length;
      toolsForBlocks = customTools.filter(t => {
        const n = (t.function?.name || t.name || "").toLowerCase();
        return !VISION_TOOL_NAMES.includes(n);
      });
      if (toolsForBlocks.length < before) {
        console.log(`[Vision] ✓ vision_analyze di-suppress (gambar ada di file block → Kimi pakai native vision)`);
      }
    }

    const blocks = buildKimiBlocks(messages, toolsForBlocks, toolChoice, imageFileIds);
    const slot   = nextSlot();
    const id     = `chatcmpl-${uuid()}`;
    const isStreaming = parsed.stream === true;

    // ── Streaming response ───────────────────────────────────────────────────
    if (isStreaming) {
      res.writeHead(200, {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Role opener
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: modelId,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`);

      try {
        const t0 = Date.now();
        await streamKimiWithRetry(slot, blocks, scenario, thinking, useSearch, res, id, modelId, activeTools, true);
        console.log(`[KimiProxy] stream done in ${Date.now()-t0}ms`);
      } catch (e) {
        const msg = e.message || "";
        console.error("[KimiProxy] stream error (all retries exhausted):", msg);
        if (/401|403|token_refresh|refresh/i.test(msg)) { slot.dead = true; rotate(msg); }
        try {
          res.write(sseChunk(id, modelId, `\n\n[Proxy error: ${msg.slice(0, 200)}]`));
          res.write(sseChunk(id, modelId, "", true));
          res.write("data: [DONE]\n\n");
        } catch {}
      } finally {
        try { res.end(); } catch {}
      }

    // ── Non-streaming response ───────────────────────────────────────────────
    } else {
      const chunks        = [];
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
        await streamKimiWithRetry(slot, blocks, scenario, thinking, useSearch, fakeRes, id, modelId, activeTools);
      } catch (e) {
        const msg = e.message || "";
        if (/401|403|token/i.test(msg)) { slot.dead = true; rotate(msg); }
        chunks.push(`[Proxy error: ${msg.slice(0, 200)}]`);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      if (toolCallsResult?.length) {
        res.end(JSON.stringify({
          id, object: "chat.completion",
          created: Math.floor(Date.now() / 1000), model: modelId,
          choices: [{
            index: 0,
            message: { role: "assistant", content: null, tool_calls: toolCallsResult },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      } else {
        res.end(JSON.stringify({
          id, object: "chat.completion",
          created: Math.floor(Date.now() / 1000), model: modelId,
          choices: [{
            index: 0,
            message: { role: "assistant", content: chunks.join("") },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`[KimiProxy] ✓ http://127.0.0.1:${PORT}/v1  (${POOL.length} token siap)`);
  console.log(`[KimiProxy] Catatan: web_search dari Hermes di-relay sebagai custom tool (Hermes eksekusi, bukan Kimi native)`);
});
