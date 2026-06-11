/**
 * deepseek-reverse-proxy.js — DeepSeek Chat → OpenAI-compat local proxy (ESM)
 *
 * Features:
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
 *
 * Env vars:
 *   DEEPSEEK_TOKEN_1..10             – DeepSeek refresh tokens
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
 */

import http   from "http";
import https  from "https";
import crypto from "crypto";
import zlib   from "zlib";
import fs     from "fs";
import path   from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const PORT          = parseInt(process.env.DEEPSEEK_PROXY_PORT  || "4893", 10);
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL                || "deepseek-chat";
const SHOW_THINKING = process.env.DEEPSEEK_SHOW_THINKING       === "true";
const WASM_FILENAME = "sha3.wasm";
const WASM_PATH     = process.env.DEEPSEEK_WASM_PATH            || path.join(__dirname, WASM_FILENAME);

const STREAM_IDLE_TIMEOUT_MS  = parseInt(process.env.DEEPSEEK_STREAM_IDLE_TIMEOUT  || "90000",  10);
const STREAM_TOTAL_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_STREAM_TOTAL_TIMEOUT || "300000", 10);
const IMAGE_CACHE_TTL_MS      = parseInt(process.env.DEEPSEEK_IMAGE_CACHE_TTL      || String(10 * 60 * 1000), 10);
const DOC_CACHE_TTL_MS        = parseInt(process.env.DEEPSEEK_DOC_CACHE_TTL        || String(30 * 60 * 1000), 10);
const OVERLOADED_RETRY_MAX    = parseInt(process.env.DEEPSEEK_OVERLOADED_RETRY     || "3",    10);
const OVERLOADED_RETRY_DELAY  = parseInt(process.env.DEEPSEEK_OVERLOADED_DELAY     || "3000", 10);

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
  "Accept-Language":          "zh-CN,zh;q=0.9,en-US;q=0.8",
  "Cache-Control":            "no-cache",
  "Origin":                   BASE,
  "Referer":                  BASE + "/",
  "Sec-Ch-Ua":                '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "Sec-Ch-Ua-Mobile":         "?0",
  "Sec-Ch-Ua-Platform":       '"Windows"',
  "Sec-Fetch-Dest":           "empty",
  "Sec-Fetch-Mode":           "cors",
  "Sec-Fetch-Site":           "same-origin",
  "User-Agent":               "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0",
  "X-App-Version":            "20241129.1",
  "X-Client-Locale":          "zh_CN",
  "X-Client-Platform":        "web",
  "X-Client-Version":         "1.8.0",
  "X-Client-Timezone-Offset": "28800",
};

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
// IMAGE CACHE (pola sama seperti kimi-reverse-proxy)
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

// ══════════════════════════════════════════════════════════════════════════════
// WASM POW SOLVER — port dari coba.py (DeepSeekHashV1 via sha3_wasm_bg.wasm)
// ══════════════════════════════════════════════════════════════════════════════

let _wasmExports = null;

async function loadWasm() {
  if (_wasmExports) return _wasmExports;
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(
      `[DeepSeekProxy] WASM tidak ditemukan: ${WASM_PATH}\n` +
      `Taruh '${WASM_FILENAME}' di folder yang sama dengan deepseek-reverse-proxy.js`
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

async function buildPowAnswer(challengeObj) {
  const answer = await solvePow(challengeObj);
  if (answer === null) throw new Error("POW challenge solve gagal");
  const payload = {
    algorithm:   challengeObj.algorithm,
    challenge:   challengeObj.challenge,
    salt:        challengeObj.salt,
    answer,
    signature:   challengeObj.signature,
    target_path: "/api/v0/chat/completion",
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

// ══════════════════════════════════════════════════════════════════════════════
// TOKEN SLOT — access token lifecycle + session management
// ══════════════════════════════════════════════════════════════════════════════

class TokenSlot {
  constructor(raw, slotNum) {
    this.slot         = slotNum;
    this.dead         = false;
    this.refreshToken = raw;   // token asli dari user (Bearer dari browser)
    this.accessToken  = null;  // short-lived token dari /api/v0/users/current
    this.accessExpiry = 0;
    this.sessionId    = null;
    this.sessionAt    = 0;
    this._refreshing  = false;
    this._waiters     = [];
  }

  baseHeaders(extra = {}) {
    return { ...FAKE_HEADERS, ...extra };
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
      const req = https.request({
        hostname: "chat.deepseek.com",
        path:     "/api/v0/users/current",
        method:   "GET",
        headers:  this.baseHeaders({
          "Authorization":   `Bearer ${this.refreshToken}`,
          "Accept":          "application/json",
          "Accept-Encoding": "identity",
        }),
        agent: AGENT,
      }, res => {
        collectBody(res).then(buf => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            this.dead = true;
            return reject(new Error(`Token invalid (HTTP ${res.statusCode})`));
          }
          try {
            const d   = JSON.parse(buf.toString("utf8"));
            const biz = d?.data?.biz_data || d?.biz_data || {};
            const tok = biz.token;
            if (!tok) return reject(new Error("No access token in refresh response"));
            this.accessToken  = tok;
            this.accessExpiry = Date.now() + 3_600_000;
            console.log(`[DeepSeekProxy] slot ${this.slot} token refreshed ✓`);
            resolve();
          } catch (e) { reject(new Error(`Token refresh parse: ${e.message}`)); }
        }).catch(reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  async getSession() {
    if (this.sessionId && Date.now() - this.sessionAt < 300_000)
      return this.sessionId;
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
            resolve(sid);
          } catch (e) { reject(new Error(`Session create parse: ${e.message}`)); }
        }).catch(reject);
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  async getChallenge() {
    const tok  = await this.getAccessToken();
    const body = Buffer.from(JSON.stringify({ target_path: "/api/v0/chat/completion" }));
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
for (let i = 1; i <= 10; i++) {
  const t = (process.env[`DEEPSEEK_TOKEN_${i}`] || "").trim();
  if (t) POOL.push(new TokenSlot(t, i));
}
if (!POOL.length) {
  console.error("[DeepSeekProxy] ERROR: Tidak ada token! Set DEEPSEEK_TOKEN_1 dulu.");
  process.exit(1);
}
console.log(`[DeepSeekProxy] ${POOL.length} token dimuat | port=${PORT} | model=${DEFAULT_MODEL} | showThinking=${SHOW_THINKING} | imgCache=${IMAGE_CACHE_TTL_MS/60000}m | docCache=${DOC_CACHE_TTL_MS/60000}m | retry=${OVERLOADED_RETRY_MAX}x${OVERLOADED_RETRY_DELAY}ms`);

let rrIdx = 0;
function alive() {
  let a = POOL.filter(t => !t.dead);
  if (!a.length) { POOL.forEach(t => t.dead = false); a = POOL; }
  return a;
}
function nextSlot() {
  const a = alive();
  const s = a[rrIdx % a.length];
  rrIdx++;
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

function parseToolUse(content) {
  const calls = [];
  const re = /<tool_calling>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]+?)<\/arguments>\s*<\/tool_calling>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1].trim();
    let args   = m[2].trim();

    // ── JSON validation — drop kalau malformed/truncated ─────────────────────
    try {
      JSON.parse(args);
    } catch {
      // Coba repair sederhana: trailing comma, whitespace cleanup
      const repaired = args
        .replace(/,\s*([}\]])/g, "$1")   // trailing commas
        .replace(/\n+/g, " ")            // newlines → spaces
        .trim();
      try {
        JSON.parse(repaired);
        args = repaired;
        console.warn(`[DeepSeekProxy] parseToolUse: args JSON repaired untuk "${name}"`);
      } catch {
        // Tidak bisa direpair — drop
        console.warn(`[DeepSeekProxy] parseToolUse: args invalid JSON untuk "${name}" → drop | ${args.slice(0,100)}`);
        continue;
      }
    }

    calls.push({
      id:   `tool_${calls.length}`,
      type: "function",
      function: { name, arguments: args },
    });
  }
  return calls.length ? calls : null;
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
  const tok      = await slot.getAccessToken();
  const boundary = `----DeepSeekBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const CRLF     = "\r\n";
  const head = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: ${mimetype}${CRLF}${CRLF}`
  );
  const foot = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([head, buffer, foot]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "chat.deepseek.com",
      path:     "/api/v0/file/upload_file",
      method:   "POST",
      headers:  slot.baseHeaders({
        "Authorization":   `Bearer ${tok}`,
        "Content-Type":    `multipart/form-data; boundary=${boundary}`,
        "Content-Length":  String(body.length),
        "Accept":          "application/json",
        "Accept-Encoding": "identity",
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
          if (!fileId) return reject(new Error("No file id in upload response"));
          const isImage = biz.is_image !== undefined ? !!biz.is_image : mimetype.startsWith("image/");
          console.log(`[Vision] Uploaded: ${filename} → ${fileId} isImage=${isImage}`);
          resolve({ fileId, isImage });
        } catch (e) { reject(new Error(`Upload parse: ${e.message}`)); }
      }).catch(reject);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function waitForFile(slot, fileId, maxWait = 90_000) {
  const tok      = await slot.getAccessToken();
  const deadline = Date.now() + maxWait;

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
          .then(buf => { try { resolve(JSON.parse(buf.toString("utf8"))); } catch { resolve({}); } })
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
      if (i === 0) console.log(`[Vision] waitForFile status: ${status}`);
      if (status === "SUCCESS")
        return { ready: true, isImage: !!info.is_image };
      if (status === "FAILED" || status === "ERROR") {
        console.warn(`[Vision] File ${fileId} FAILED`);
        return { ready: false, isImage: false };
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
          if (c) frags.push({ type: currentType || "ANSWER", content: c });
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

    // ── Inject cached file IDs untuk context continuity ───────────────────────
    const freshImgs = _recentFileIds().filter(id => !fileIds.includes(id));
    const freshDocs = _recentDocFileIds().filter(id => !fileIds.includes(id));
    if (freshImgs.length + freshDocs.length > 0) {
      console.log(`[Vision] Injecting cached: ${freshImgs.length} img + ${freshDocs.length} doc`);
      fileIds.push(...freshImgs, ...freshDocs);
    }
    if (fileIds.length > 0 && rawImages.length > 0) hasImages = true;

    // ── Suppress file-analysis tools kalau ada file terlampir ─────────────────
    // (DeepSeek punya vision bawaan, tools ini akan confuse model)
    const FILE_TOOL_NAMES = new Set([
      "vision_analyze", "image_analyze", "document_analyze", "file_analyze",
      "analyze_image", "analyze_document", "analyze_file", "ocr",
    ]);
    const filteredTools = fileIds.length > 0
      ? customTools.filter(t => !FILE_TOOL_NAMES.has((t.function?.name || t.name || "").toLowerCase()))
      : customTools;

    if (filteredTools.length < customTools.length)
      console.log(`[Vision] Suppress ${customTools.length - filteredTools.length} file-analysis tool(s) karena ada lampiran`);

    const finalActiveTools = !!(filteredTools.length && toolChoice !== "none");

    const prompt = buildPrompt(messages, filteredTools, toolChoice);

    let modelType = "default";
    if (hasImages)     modelType = "vision";
    else if (thinking) modelType = "expert";

    const slot = nextSlot();
    let sessionId;
    try {
      sessionId = await slot.getSession();
    } catch (e) {
      console.warn(`[DeepSeekProxy] Session error, retry: ${e.message}`);
      slot.sessionId = null;
      try { sessionId = await slot.getSession(); }
      catch (e2) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Session error: ${e2.message}`, type: "proxy_error" } }));
        return;
      }
    }

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
