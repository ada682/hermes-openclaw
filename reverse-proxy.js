/**
 * reverse-proxy.js — Qwen reverse API → OpenAI-compat local proxy (ESM)
 *
 * Tool-calling support (v2):
 *  • Custom function calling  – tools[] injected as system-prompt; parsed from model output
 *  • image_gen_tool           – Qwen built-in image gen; forwarded as markdown image links
 *  • thinking_summary phase   – forwarded as `reasoning_content` delta (like OpenAI o1)
 *  • think phase              – raw reasoning tokens; also forwarded as `reasoning_content`
 *  • Multi-turn tool loop     – role:"tool" messages stitched into next user turn
 *  • Live streaming + tools   – text streamed until [function_calls] marker is detected
 *  • Model-suffix thinking    – append -think / -thinking / -fast to any model name
 *  • tool_choice              – "none" suppresses injection; "required" forces call in prompt
 *
 * New env vars:
 *   QWEN_SHOW_THINKING=true   – emit reasoning_content delta for thinking/summary phases
 */
import http   from "http";
import https  from "https";
import crypto from "crypto";
import { URL } from "url";

const PORT          = parseInt(process.env.QWEN_PROXY_PORT   || "4891", 10);
const BASE          = "https://chat.qwen.ai";
const DEFAULT_MODEL = process.env.QWEN_MODEL         || "qwen3.7-max";
// When true: thinking_summary + think phases are forwarded as `reasoning_content` deltas
const SHOW_THINKING = process.env.QWEN_SHOW_THINKING === "true";
// [Option 1] Default thinking mode when not set by model suffix or enable_thinking param.
// "Fast" prevents empty-response failures on tool-heavy multi-turn conversations (36 tools).
// Override with QWEN_DEFAULT_THINKING=Auto or QWEN_DEFAULT_THINKING=Thinking if needed.
const DEFAULT_THINKING = process.env.QWEN_DEFAULT_THINKING || "Fast";

// Stream timeout + retry (port dari kimi-reverse-proxy)
// QWEN_STREAM_IDLE_TIMEOUT  — ms tanpa data sebelum stream dianggap hang (default: 90s)
// QWEN_STREAM_TOTAL_TIMEOUT — hard cap per stream request (default: 5min)
// QWEN_RETRY_MAX            — max retry attempts saat timeout (default: 3)
// QWEN_RETRY_DELAY          — base delay ms × attempt# untuk tiap retry (default: 3000)
const STREAM_IDLE_TIMEOUT_MS  = parseInt(process.env.QWEN_STREAM_IDLE_TIMEOUT  || "90000",  10);
const STREAM_TOTAL_TIMEOUT_MS = parseInt(process.env.QWEN_STREAM_TOTAL_TIMEOUT || "300000", 10);
const RETRY_MAX               = parseInt(process.env.QWEN_RETRY_MAX            || "3",      10);
const RETRY_DELAY             = parseInt(process.env.QWEN_RETRY_DELAY          || "3000",   10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Thrown when the Qwen stream hangs (idle timeout atau total timeout).
 * Ditangkap oleh streamQwenWithRetry untuk trigger retry ke slot lain.
 */
class StreamTimeoutError extends Error {
  constructor(msg) { super(msg); this.name = "StreamTimeoutError"; this.isTimeout = true; }
}

// ── Persistent HTTPS agent ────────────────────────────────────────────────
const AGENT = new https.Agent({
  keepAlive:      true,
  keepAliveMsecs: 30_000,
  maxSockets:     20,
  timeout:        120_000,
});

// ── Model alias map ───────────────────────────────────────────────────────
const MODEL_MAP = {
  "qwen":                "qwen3-max",
  "qwen3":               "qwen3-max",
  "qwen3.5":             "qwen3.5-plus",
  "qwen3-coder":         "qwen3-coder-plus",
  "qwen2.5":             "qwen2.5-max",
  "qwen3.5-plus":        "qwen3.5-plus",
  "qwen3.7-plus":        "qwen3.7-plus",
  "qwen3.7-max":         "qwen3.7-max",
  "qwen3-max":           "qwen3-max",
  "qwen3-coder-plus":    "qwen3-coder-plus",
  "qwen3-coder-next":    "qwen3-coder-next",
  "qwen3-omni":          "qwen3-omni-flash",
  "qwen3.5-max-preview": "qwen3.5-max-2026-03-08",
};

// ── Token pool ────────────────────────────────────────────────────────────
const POOL = [];
for (let i = 1; i <= 10; i++) {
  const t = (process.env[`QWEN_TOKEN_${i}`] || "").trim();
  if (t) POOL.push({ slot: i, token: t, dead: false });
}
if (!POOL.length) {
  console.error("[QwenProxy] ERROR: Tidak ada token! Set QWEN_TOKEN_1 dulu.");
  process.exit(1);
}
console.log(`[QwenProxy] ${POOL.length} token dimuat | port=${PORT} | model=${DEFAULT_MODEL} | showThinking=${SHOW_THINKING} | defaultThinking=${DEFAULT_THINKING} | idleTimeout=${STREAM_IDLE_TIMEOUT_MS/1000}s | totalTimeout=${STREAM_TOTAL_TIMEOUT_MS/1000}s | retryMax=${RETRY_MAX}`);

// ── Chat session pre-warm pool ────────────────────────────────────────────
const SESSION_POOL   = new Map();
const SESSION_BUFFER = 2;

async function preWarmSession(modelId) {
  const slot = current();
  try {
    const chatId = await createChatRaw(slot.token, modelId);
    if (!chatId) return;
    if (!SESSION_POOL.has(modelId)) SESSION_POOL.set(modelId, []);
    SESSION_POOL.get(modelId).push({ token: slot.token, chatId });
  } catch { /* silent — just won't pre-warm */ }
}

function schedulePreWarm(modelId) {
  const pool = SESSION_POOL.get(modelId) || [];
  if (pool.length < SESSION_BUFFER) {
    setTimeout(() => preWarmSession(modelId), 200);
  }
}

async function getSession(token, modelId) {
  const pool = SESSION_POOL.get(modelId) || [];
  const idx  = pool.findIndex(s => s.token === token);
  if (idx !== -1) {
    const [session] = pool.splice(idx, 1);
    schedulePreWarm(modelId);
    return session.chatId;
  }
  return createChatRaw(token, modelId);
}

let rrIdx = 0;
function alive() {
  let a = POOL.filter(t => !t.dead);
  if (!a.length) { POOL.forEach(t => t.dead = false); a = POOL; }
  return a;
}
function current() { const a = alive(); return a[rrIdx % a.length]; }
// Claim the next available slot and advance the index immediately,
// so concurrent requests each get a different bearer token.
function nextSlot() {
  const a    = alive();
  const slot = a[rrIdx % a.length];
  rrIdx++;
  console.log(`[QwenProxy] nextSlot → slot ${slot.slot} (rrIdx now ${rrIdx})`);
  return slot;
}
function rotate(reason) {
  rrIdx++;
  console.log(`[QwenProxy] rotate → slot ${current()?.slot} | ${reason}`);
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

/**
 * Resolve model name → { modelId, thinkingSuffix }
 *
 * Strips thinking-mode suffix BEFORE alias lookup so suffix works on
 * both raw names ("qwen3-think") and already-mapped ones ("qwen3-max-think").
 *
 * Suffix rules:
 *   -thinking / -think  → "Thinking" mode
 *   -fast               → "Fast" mode (no reasoning)
 *   (none)              → null  (caller picks default)
 *
 * Examples:
 *   "qwen3-max-think"    → { modelId:"qwen3-max",       thinkingSuffix:"Thinking" }
 *   "qwen3-coder-fast"   → { modelId:"qwen3-coder-plus", thinkingSuffix:"Fast"     }
 *   "qwen3"              → { modelId:"qwen3-max",       thinkingSuffix: null       }
 */
function mapModel(name) {
  let m             = (name || DEFAULT_MODEL).toLowerCase();
  let thinkingSuffix = null;

  if      (m.endsWith("-thinking")) { thinkingSuffix = "Thinking"; m = m.slice(0, -9); }
  else if (m.endsWith("-think"))    { thinkingSuffix = "Thinking"; m = m.slice(0, -6); }
  else if (m.endsWith("-fast"))     { thinkingSuffix = "Fast";     m = m.slice(0, -5); }

  return { modelId: MODEL_MAP[m] || m, thinkingSuffix };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function makeHeaders(token, chatId) {
  return {
    "Accept":              "application/json",
    "Accept-Language":     "zh-CN,zh;q=0.9",
    "Content-Type":        "application/json",
    "source":              "web",
    "User-Agent":          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "sec-ch-ua":           '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    "sec-ch-ua-mobile":    "?0",
    "sec-ch-ua-platform":  '"macOS"',
    "Sec-Fetch-Dest":      "empty",
    "Sec-Fetch-Mode":      "cors",
    "Sec-Fetch-Site":      "same-origin",
    "bx-v":                "2.5.36",
    "bx-umidtoken":        "T2gAr9z8byN8sNOmfQ3X9j61MNTNmSqDO5L1rs2jMcQCVhOKgZICcBN-UdTuJGig-NM=",
    "bx-ua":               "231!lWD36kmUe5E+joKDK5gBZ48FEl2ZWfPwIPF92lBLek2KxVW/XJ2EwruCiDOX5Px4EXNhmh6EfS9eDwQGRwijIK64A4nPqeLysJcDjUACje/H3J4ZgGZpicG6K8AkiGGaEKC830+QSiSUsLRlL/EyhXTmLcJc/5iDkMuOpUhNz0e0Q/nTqjVJ3ko00Q/oyE+jauHhUHfb1GxGHkE+++3+qCS4+ItkaA6tiItCo+romzElfLFD6RIj7oHt9vffs98nLwpHnaqKjufnLFMejSlAUGiQvTofIiGhIvftAMcoFV4mrUHsqyQ/ncQihmJHkbxXjvM57FCb6b9dEIRZl7jgj0+QLNLRs0NZ4azdZ6rzbGTSO8KA5I3Aq/3gBr87X16Mj0oJtaPKmFGaP2zghfOVhxQht8YjRd50lJa+Ue4PAuPSdu2O69DKLH8VOhrsB+psaBIRxnRi5POUQ6w8s8qlb9vxvExjHNOAKWXV1by1Nz+6FPWdyTeAgcmonjCcV0dCtPj/KyeVDkeSrDkKZjnDzHEqeCdfmJ65kve+Vy3YS0vagzyHfVEnzN0ULUZtkGfJXFNm6+bIa55wmGBhUeXbHL0EdlQXMu1YXxmcwBgTaq7tlQcfv7AefanbfjGE8R1IFnNyg2/jXLbnLg5Z6l1oKqgnxZQg0DE9BJuw6s0XjGwTdSxybWxp+WFD/RsXt76uwvCBk7z+YmSFLtFj2UlTsoq+vl0DTmsVItDKf9SZ94NcuJ7mxJYI02S/2kQBfbbHG0d4hXevDrEC0cb86EvzN2ud+v6bAunNRGNFz/RH0KLusoBVeo+puCFKeeIJWEo0t1UicX5YxJwMAoV7+g0gK93y4W9sMQtso8/wY5wsBzis9dwfLvIwXpaAM1g0MZp/YIRq8T/Qc+U/8x99tam4er0IWizvrkjqhIzCWBKpJ4Y4gj3bOmiS3VCMEaoVfKCwUWENwYKuP3H5VI0n+O2vVVRrekUrwvkm6URRhVhN4eEFTCjB9nSQu++qKyDH8HPpkS3YfwF8/OQtrZo7hQXxvNmP2HcH/K7zcweD00BaoOLiYUtXRItGYbl06sVSbm04soRf1Jqpyo3XiRqBWD9rmJfr4w8NOEGVGUCKXLDLsXy+8JC4Iqf0FsIjWxjMVdraTUtCbwXRbYUownQVm6bt7LYD1SNPoWNPqUJgsLMwP33ugrb1UbHCs24roOch6Go5QHIPA8E15SZE9pkr1SkmqrNs/+KRomFJ9HyFnWUYhZIV9MRLqlOAt6XBBTash3WJnCjhx/PZGhXVvdn2jX4+0Pm55LsiNugA8vaAUJQBxD/8a1u/RvTgbj35+b7I7m8tG0hMhClNZF+tpsOmZZhUGuXH9uVbkJMlMuAmMVCHwn3O31GlLeXXzzep2WS3xN2U+p5J0I7GySnuZUkuGs1ZTVqGUvR2g4q+7ljU55Ak78yPZiQXeUeqS74azszvZvCqWxXn2eePj+gcpliOjrYKpglUP19rQrMt8PqLt8L0ghIqVCmMwl3Hgr/VUcqDpXdpPTR=",
    "Timezone":            new Date().toString(),
    "Version":             "0.2.7",
    "Authorization":       `Bearer ${token}`,
    "Origin":              "https://chat.qwen.ai",
    "x-accel-buffering":   "no",
    "X-Request-Id":        uuid(),
    ...(chatId ? { "Referer": `https://chat.qwen.ai/c/${chatId}` } : {}),
  };
}

function httpsPost(urlPath, body, token, chatId) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(BASE + urlPath);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { ...makeHeaders(token, chatId), "Content-Length": Buffer.byteLength(payload) },
      agent: AGENT,
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on("error", reject);
    req.write(payload); req.end();
  });
}

function httpsDelete(urlPath, token) {
  return new Promise(resolve => {
    const u = new URL(BASE + urlPath);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "DELETE",
      headers: makeHeaders(token), agent: AGENT,
    }, res => { res.resume(); res.on("end", resolve); });
    req.on("error", () => resolve());
    req.end();
  });
}

async function createChatRaw(token, modelId) {
  try {
    const r = await httpsPost("/api/v2/chats/new", {
      title: "OpenClaw", models: [modelId], chat_mode: "normal",
      chat_type: "t2t", timestamp: Date.now(), project_id: "",
    }, token);
    return r?.data?.id || null;
  } catch { return null; }
}

async function createImageChatRaw(token, modelId) {
  try {
    const r = await httpsPost("/api/v2/chats/new", {
      title: "OpenClaw", models: [modelId], chat_mode: "normal",
      chat_type: "t2i", timestamp: Date.now(), project_id: "",
    }, token);
    return r?.data?.id || null;
  } catch { return null; }
}

function delChat(token, chatId) {
  httpsDelete(`/api/v2/chats/${chatId}`, token).catch(() => {});
}

// ═════════════════════════════════════════════════════════════════════════
// ── Vision: OSS Image Upload (image_recognize tool) ───────────────────────
// ═════════════════════════════════════════════════════════════════════════
//
// Porting dari qwen.js: STS token → Alibaba OSS upload → kirim sebagai
// image file di Qwen message payload. Dipakai saat client (Hermes auxiliary
// vision atau tool lain) kirim gambar dalam OpenAI multimodal format:
//   { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
//
// Flow:
//   1. extractImagesFromMessages() — scan messages[], kumpulkan base64 images
//   2. uploadImageToQwen() per image — dapat file_url + file_id dari OSS
//   3. buildImageFileEntry() — format sesuai yang Qwen harapkan di files[]
//   4. streamQwen() dengan imageFiles[] — model qwen3.7-plus baca & analisa gambar

function ossSign(method, contentType, date, bucket, objectKey, secretKey, securityToken) {
  const ossHeaders    = securityToken ? `x-oss-security-token:${securityToken}\n` : "";
  const stringToSign  = `${method}\n\n${contentType}\n${date}\n${ossHeaders}/${bucket}/${objectKey}`;
  return crypto.createHmac("sha1", secretKey).update(stringToSign, "utf8").digest("base64");
}

// Step 1: minta STS credentials dari Qwen untuk OSS upload
// Reuses httpsPost yang sudah ada (sudah auth + JSON.parse)
async function getSTS(token, filename, filesize, mimetype) {
  const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"];
  const filetype    = IMAGE_MIMES.includes(mimetype) ? "image" : "file";
  const result      = await httpsPost("/api/v2/files/getstsToken",
    { filename, filesize: String(filesize), filetype }, token
  );
  // httpsPost sudah JSON.parse; data bisa di result.data atau langsung result
  return result?.data && typeof result.data === "object" ? result.data : result;
}

// Step 2: upload buffer ke Alibaba Cloud OSS pakai STS credentials
function ossUploadBuffer(stsData, buffer, mimetype) {
  const g = (...keys) => { for (const k of keys) if (k in stsData && stsData[k]) return stsData[k]; return null; };
  const keyId     = g("access_key_id",  "accessKeyId");
  const keySecret = g("access_key_secret", "accessKeySecret");
  const stToken   = g("security_token", "securityToken");
  const bucket    = g("bucketname", "bucket", "bucketName");
  const epRaw     = g("endpoint", "region");
  const objectKey = g("file_path", "objectKey", "object_key");

  if (!keyId || !keySecret || !bucket || !epRaw || !objectKey)
    return Promise.reject(new Error(`[Vision] STS data kurang: ${JSON.stringify(Object.keys(stsData))}`));

  const hostname  = `${bucket}.${epRaw.replace(/^https?:\/\//, "")}`;
  const date      = new Date().toUTCString();
  const sig       = ossSign("PUT", mimetype, date, bucket, objectKey, keySecret, stToken);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: `/${objectKey}`, method: "PUT",
      headers: {
        "Content-Type":   mimetype,
        "Content-Length": buffer.length,
        "Date":           date,
        "Authorization":  `OSS ${keyId}:${sig}`,
        ...(stToken ? { "x-oss-security-token": stToken } : {}),
      },
    }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => res.statusCode === 200
        ? resolve()
        : reject(new Error(`[Vision] OSS PUT ${res.statusCode}: ${body.slice(0, 200)}`))
      );
    });
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

// Upload satu gambar ke Qwen OSS, return info untuk files[] payload
async function uploadImageToQwen(token, buffer, filename = "image.jpg", mimetype = "image/jpeg") {
  const stsData = await getSTS(token, filename, buffer.length, mimetype);
  const g       = (...keys) => { for (const k of keys) if (k in stsData && stsData[k]) return stsData[k]; return null; };
  const fileUrl = g("file_url", "fileUrl");
  const fileId  = g("file_id", "fileId", "id") || uuid();

  await ossUploadBuffer(stsData, buffer, mimetype);
  console.log(`[Vision] Uploaded: ${filename} (${buffer.length}b) → fileId=${fileId}`);
  return { file_url: fileUrl, file_id: fileId, filename, mimetype, filesize: buffer.length };
}

// Format image info jadi entry files[] yang dikenali Qwen
function buildImageFileEntry(info) {
  return {
    type:      "image",
    name:      info.filename  || "image.jpg",
    url:       info.file_url  || "",
    size:      info.filesize  || 0,
    fileId:    info.file_id   || "",
    fileClass: "vision",
    file_type: info.mimetype  || "image/jpeg",
  };
}

// Scan messages[], extract semua image_url base64 → array of { buffer, mimetype, filename }
// Hanya handle data: URI (base64) — HTTP URL bisa di-extend kalau perlu
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
      const buffer   = Buffer.from(m[2], "base64");
      const ext      = mimetype.split("/")[1]?.split("+")[0] || "jpg";
      images.push({ buffer, mimetype, filename: `img_${Date.now()}_${images.length}.${ext}` });
    }
  }
  return images;
}

// Vision model untuk auto-switching saat ada gambar
const VISION_MODEL = process.env.QWEN_VISION_MODEL || "qwen3.7-plus";

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter(p => p.type === "text").map(p => p.text || "").join("\n");
  return String(content || "");
}

// ═════════════════════════════════════════════════════════════════════════
// ── Tool-calling support ──────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

/**
 * Convert an OpenAI tools[] list into a Qwen system-prompt.
 * The model is instructed to emit [function_calls] blocks when calling tools.
 *
 * @param {Array}  tools      – OpenAI-format tool definitions
 * @param {*}      toolChoice – "auto" | "none" | "required" | {type:"function",function:{name}}
 * @returns {string} system prompt fragment, or "" when tools disabled
 */
function toolsToSystemPrompt(tools, toolChoice = "auto") {
  if (!tools?.length || toolChoice === "none") return "";

  const defs = tools.map(t => {
    // Support multiple formats: OpenAI {type,function:{…}}, flat {name,…}, Anthropic {name,input_schema}
    const f      = t.function || t;
    const name   = f.name        || t.name        || "";
    const desc   = f.description || t.description || "";
    const params = f.parameters  || f.input_schema || t.parameters || t.input_schema || {};
    return `Tool \`${name}\`: ${desc}.\nArguments JSON schema:\n${JSON.stringify(params, null, 2)}`;
  });

  // Determine forced-call instructions
  const isRequired   = toolChoice === "required" ||
                       (typeof toolChoice === "object" && toolChoice?.type === "function");
  const forcedFnName = typeof toolChoice === "object" ? toolChoice?.function?.name : null;
  const forceNote    = isRequired
    ? `\n\nIMPORTANT: You MUST call ${forcedFnName ? `the \`${forcedFnName}\` tool` : "one of the available tools"} — do NOT answer in plain text.`
    : "";

  const toolNames = tools.map(t => (t.function || t).name || t.name).join(", ");
  console.log(`[QwenProxy] Injecting ${tools.length} tool(s): ${toolNames} | tool_choice=${JSON.stringify(toolChoice)}`);

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

/** Quick check: does content contain any tool-call marker? */
function hasToolUse(content) {
  // Match partial marker too (no closing ]) — handles cases where status:finished
  // arrives before the full [function_calls]...[/function_calls] block is assembled.
  return content.includes("[function_calls") || content.includes("<tool_use>");
}

/**
 * Parse tool calls from model output.
 *
 * Handles two formats emitted by Qwen:
 *   [function_calls][call:name]{…}[/call][/function_calls]    ← primary (bracket)
 *   <tool_use><name>…</name><arguments>…</arguments></tool_use> ← fallback (XML)
 *
 * Arguments are compacted to a single line to recover from accidental line-breaks.
 *
 * @returns {Array|null} [{id, type, function:{name, arguments}}] or null
 */
function parseToolUse(content) {
  const calls = [];

  if (content.includes("[function_calls")) {  // relaxed: no ] required (handles partial/malformed)
    // [\w.\-]+ allows dots and hyphens in tool names (e.g. "my-tool", "ns.method")
    const re = /\[call:([\w.\-]+)\]([\s\S]*?)\[\/call\]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const args = m[2].trim().replace(/\s+/g, " "); // compact multi-line JSON
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

/**
 * Build the Qwen conversation prompt from OpenAI messages[].
 *
 * Qwen special tokens:
 *   <｜User｜>             – separates turns in a multi-turn conversation
 *   <｜Assistant｜>        – marks start of an assistant reply
 *   <｜end of sentence｜>  – marks end of assistant reply
 *
 * Multi-turn tool-loop handling:
 *   role:"assistant" with tool_calls  → reconstructed [function_calls] block
 *   role:"tool"                       → injected as [Tool result: …] into next user turn
 */
function toPrompt(messages, tools = [], toolChoice = "auto") {
  const toolPrompt = toolsToSystemPrompt(tools, toolChoice);
  let systemContent = toolPrompt;
  const parts = [];
  let pendingUser = null;

  for (const msg of messages) {
    const text = extractText(msg.content);

    if (msg.role === "system") {
      systemContent += (systemContent ? "\n\n" : "") + text;

    } else if (msg.role === "user") {
      if (pendingUser !== null) parts.push(pendingUser);
      pendingUser = text;

    } else if (msg.role === "assistant") {
      let assistantText = text;
      // Reconstruct [function_calls] block from tool_calls array (multi-turn tool loop)
      if (!assistantText && msg.tool_calls?.length) {
        const lines = msg.tool_calls
          .map(tc => `[call:${tc.function.name}]${tc.function.arguments}[/call]`)
          .join("\n");
        assistantText = `[function_calls]\n${lines}\n[/function_calls]`;
      }
      if (pendingUser !== null) {
        parts.push(`${pendingUser}<｜Assistant｜>${assistantText}<｜end of sentence｜>`);
        pendingUser = null;
      } else {
        parts.push(`<｜Assistant｜>${assistantText}<｜end of sentence｜>`);
      }

    } else if (msg.role === "tool") {
      // Tool execution result — injected into the pending user turn so Qwen
      // sees it before generating the next reply.
      const label   = msg.name || msg.tool_call_id || "call";
      let rawText   = extractText(msg.content);

      // Hapus marker <<<EXTERNAL_UNTRUSTED_CONTENT>>> yang bikin Qwen echo balik.
      // OpenClaw sengaja membungkus semua konten eksternal dengan marker ini
      // (web search, exec, web_fetch) sebagai prompt injection defense.
      // Strip keduanya: literal newline form DAN escaped \n form (dari JSON values).
      rawText = rawText
        .replace(/\\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, " ") // escaped \n form
        .replace(/\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\n?/gi, " ") // literal newline form
        .replace(/Source:\s*Web Search\s*[-–—]+\s*/gi, "")  // strip "Source: Web Search ---"
        .replace(/"externalContent"\s*:\s*\{[^}]*"untrusted"\s*:\s*true[^}]*\}\s*,?\s*/gi, "") // strip externalContent metadata
        .replace(/,\s*"wrapped"\s*:\s*true/gi, "")           // cleanup leftover wrapped flag
        .replace(/\s{2,}/g, " ")
        .trim();

      // Truncate biar Qwen ga overwhelmed → makin berpotensi echo
      const truncated  = rawText.length > 6000 ? rawText.slice(0, 6000) + "… [truncated]" : rawText;
      const toolResult = `[Tool result for ${label}: ${truncated}]`;
      pendingUser = pendingUser !== null ? `${pendingUser}\n${toolResult}` : toolResult;
    }
  }

  if (pendingUser !== null) {
    // Kalau pending cuma tool results (tanpa user message lanjutan),
    // kasih instruksi eksplisit supaya Qwen tidak echo balik tool result-nya.
    // Instruksi diperkuat agar Qwen langsung jawab tanpa mengulang isi tool result.
    if (pendingUser.startsWith("[Tool result")) {
      pendingUser += "\n\nGunakan informasi dari tool results di atas untuk memberikan jawaban LANGSUNG dan RINGKAS. JANGAN ulangi, tampilkan, atau kutip kembali isi tool result mentah-mentah.";
    }
    parts.push(pendingUser);
  }

  let userContent = parts.length > 1 ? parts.join("<｜User｜>") : (parts[0] || "");
  if (systemContent) userContent = `${systemContent}\n\n${userContent}`;
  return userContent;
}

// ── SSE helpers ───────────────────────────────────────────────────────────

/**
 * Compute the safe flush boundary in buf, accounting for:
 *   1. Full marker already present   → stop at its index
 *   2. buf ends with a PREFIX of a marker (split-chunk case)
 *      → stop before that prefix starts
 *
 * Without case 2, a marker like "[function_calls" can leak if Qwen streams
 * it in pieces (e.g. "[func" then "tion_calls").  Each sub-chunk individually
 * fails indexOf(), so it gets flushed before the full partial marker arrives.
 */
function safeFlushPoint(buf, markers) {
  let safe = buf.length; // default: everything is safe to flush
  for (const marker of markers) {
    // Case 1: full partial marker already in buffer
    const fi = buf.indexOf(marker);
    if (fi !== -1) { safe = Math.min(safe, fi); continue; }
    // Case 2: tail of buffer is a prefix of this marker
    for (let l = Math.min(marker.length - 1, buf.length); l > 0; l--) {
      if (buf.slice(-l) === marker.slice(0, l)) {
        safe = Math.min(safe, buf.length - l);
        break;
      }
    }
  }
  return safe;
}

function sseChunk(id, model, content, done = false) {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: done ? {} : { content }, finish_reason: done ? "stop" : null }],
  })}\n\n`;
}

/** Emit a reasoning_content delta (for thinking phases). */
function sseReasoningChunk(id, model, reasoningContent) {
  return `data: ${JSON.stringify({
    id, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: { reasoning_content: reasoningContent }, finish_reason: null }],
  })}\n\n`;
}

/**
 * Strip Qwen's internal conversation-format special tokens from model output.
 * These tokens are part of the prompt format sent TO Qwen, but occasionally
 * leak back into the model's response — causing them to appear visibly in
 * downstream channels (e.g. Telegram via OpenClaw).
 */
const QWEN_SPECIAL_TOKENS = ["<｜end of sentence｜>", "<｜User｜>", "<｜Assistant｜>"];
function stripQwenTokens(text) {
  let out = text;
  for (const tok of QWEN_SPECIAL_TOKENS) out = out.split(tok).join("");
  return out;
}

/**
 * Strip OpenClaw's EXTERNAL_UNTRUSTED_CONTENT markers from Qwen output.
 * Safety net: kalau marker lolos ke answer phase (Qwen echo-back),
 * dibersihkan di sini sebelum dikirim ke client.
 */
function stripUntrustedMarkers(text) {
  return text
    .replace(/\\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, "")
    .replace(/\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\n?/gi, "")
    .replace(/Source:\s*Web Search\s*[-–—]+\s*/gi, "");
}

// ═════════════════════════════════════════════════════════════════════════
// ── Core streamer ─────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

/**
 * Stream a Qwen chat completion and forward it as OpenAI-compatible SSE.
 *
 * Phase handling mirror of the Python reference (stream_handler.py):
 *
 *  ┌────────────────────┬──────────────────────────────────────────────────┐
 *  │ Qwen phase         │ What we do                                        │
 *  ├────────────────────┼──────────────────────────────────────────────────┤
 *  │ think              │ reasoning_content delta  (if SHOW_THINKING)        │
 *  │ thinking_summary   │ reasoning_content delta  (if SHOW_THINKING)        │
 *  │                    │   reads delta.extra.summary_thought.content        │
 *  │ image_gen_tool     │ markdown ![image](url) text chunks                │
 *  │ answer / null      │ content delta; OR tool_calls when [function_calls] │
 *  │                    │   detected — text is streamed live until marker    │
 *  └────────────────────┴──────────────────────────────────────────────────┘
 *
 * @param {string}  modelId    – already-resolved Qwen model ID
 * @param {string}  thinking   – "Auto" | "Thinking" | "Fast"
 * @param {Array}   tools      – OpenAI tool definitions (injected into prompt)
 * @param {Array}   imageFiles – Qwen-format file objects untuk vision (dari uploadImageToQwen)
 */
function streamQwen(token, chatId, prompt, modelId, thinking, useSearch, res, id, tools = [], toolChoice = "auto", imageFiles = []) {
  const thinkingEnabled = thinking !== "Fast";
  const autoThinking    = thinking === "Auto";
  const activeTools     = !!(tools.length && toolChoice !== "none");
  const fid = uuid(), cid = uuid(), ts = Math.floor(Date.now() / 1000);

  const payload = JSON.stringify({
    stream: true, version: "2.1", incremental_output: true, chat_id: chatId,
    chat_mode: "normal", model: modelId, parent_id: null,
    messages: [{
      fid, parentId: null, childrenIds: [cid], role: "user",
      content: prompt, user_action: "chat", files: imageFiles, timestamp: ts,
      models: [modelId], chat_type: "t2t",
      feature_config: {
        thinking_enabled: thinkingEnabled, output_schema: "phase",
        research_mode: "normal", auto_thinking: autoThinking,
        thinking_mode: thinking, thinking_format: "summary",
        auto_search: useSearch,
      },
      extra: { meta: { subChatType: "t2t" } },
      sub_chat_type: "t2t", parent_id: null,
    }],
    timestamp: ts + 1,
  });

  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE}/api/v2/chat/completions?chat_id=${chatId}`);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { ...makeHeaders(token, chatId), "Content-Length": Buffer.byteLength(payload) },
      agent: AGENT,
    }, qwenRes => {
      if (qwenRes.statusCode !== 200) {
        let body = "";
        qwenRes.on("data", c => body += c);
        qwenRes.on("end", () => reject(new Error(`HTTP ${qwenRes.statusCode}: ${body.slice(0, 200)}`)));
        return;
      }

      let buf           = "";
      let answerBuf     = "";    // accumulated answer-phase content (for tool detection)
      let sentUpTo      = 0;     // chars of answerBuf already flushed to client (safe zone)
      let summaryText   = "";    // accumulated thinking_summary text (diff-tracking like Python)
      let reasoningSent = false; // whether reasoning_content role opener was emitted
      let imageGenDone  = false; // deduplicate image_gen_tool output
      let resolved      = false; // guard against double-emit on status:finished + stream end

      // ── Stream timeouts ───────────────────────────────────────────────────
      // Qwen kadang biarkan koneksi hidup tanpa kirim data / status:finished.
      // Tanpa timer ini proxy nunggu selamanya.
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
          console.error(`[QwenProxy] ✗ stream idle timeout — tidak ada data selama ${STREAM_IDLE_TIMEOUT_MS/1000}s`);
          try { qwenRes.destroy(); } catch {}
          reject(new StreamTimeoutError(`Qwen stream idle timeout (${STREAM_IDLE_TIMEOUT_MS/1000}s)`));
        }, STREAM_IDLE_TIMEOUT_MS);
      }

      _totalTimer = setTimeout(() => {
        if (resolved) return;
        _clearTimers();
        resolved = true;
        console.error(`[QwenProxy] ✗ stream total timeout — melebihi ${STREAM_TOTAL_TIMEOUT_MS/1000}s`);
        try { qwenRes.destroy(); } catch {}
        reject(new StreamTimeoutError(`Qwen stream total timeout (${STREAM_TOTAL_TIMEOUT_MS/1000}s)`));
      }, STREAM_TOTAL_TIMEOUT_MS);

      _kickIdle(); // mulai idle timer dari saat response headers diterima

      qwenRes.on("data", raw => {
        _kickIdle(); // reset idle timer setiap ada data masuk
        buf += raw.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const src = line.startsWith("data: ") ? line.slice(6) : line;
          if (src.trim() === "[DONE]") continue;

          try {
            const d = JSON.parse(src);
            if (!d.choices) continue;
            const delta   = d.choices[0]?.delta || {};
            const phase   = delta.phase;
            const content = delta.content || "";
            const status  = delta.status  || "";
            const extra   = delta.extra   || {};

            // ── Phase: think ──────────────────────────────────────────────
            // Raw internal reasoning tokens. Forwarded as reasoning_content
            // so clients that understand it (e.g. Cline, OpenWebUI) can show it.
            if (phase === "think") {
              if (SHOW_THINKING && content && status !== "finished") {
                if (!reasoningSent) {
                  // Emit role opener for reasoning_content (mirrors Python behaviour)
                  res.write(`data: ${JSON.stringify({
                    id, object: "chat.completion.chunk", model: modelId,
                    created: Math.floor(Date.now() / 1000),
                    choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "" }, finish_reason: null }],
                  })}\n\n`);
                  reasoningSent = true;
                }
                res.write(sseReasoningChunk(id, modelId, content));
              }

            // ── Phase: thinking_summary ───────────────────────────────────
            // A condensed version of the reasoning. Stored in
            //   delta.extra.summary_thought.content  (array of strings)
            // Forwarded incrementally (only the diff vs previous send).
            } else if (phase === "thinking_summary") {
              if (SHOW_THINKING) {
                const summaryThought = extra.summary_thought || {};
                const lines          = summaryThought.content || [];
                const newSummary     = lines.join("\n");
                if (newSummary && newSummary.length > summaryText.length) {
                  const diff = newSummary.slice(summaryText.length);
                  if (diff) {
                    if (!reasoningSent) {
                      res.write(`data: ${JSON.stringify({
                        id, object: "chat.completion.chunk", model: modelId,
                        created: Math.floor(Date.now() / 1000),
                        choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "" }, finish_reason: null }],
                      })}\n\n`);
                      reasoningSent = true;
                    }
                    res.write(sseReasoningChunk(id, modelId, diff));
                    summaryText = newSummary;
                  }
                }
              }

            // ── Phase: image_gen_tool ─────────────────────────────────────
            // Qwen built-in image generation. Image URLs live in:
            //   delta.extra.image_list              (primary — per qwen.js reference)
            //   delta.extra.tool_result.image_list  (fallback)
            // URL field variants: .image | .img_url | .image_url | .url
            } else if (phase === "image_gen_tool") {
              if (!imageGenDone && status === "finished") {
                const toolResult = extra.tool_result || {};
                const imgList    = extra.image_list        ||
                                   toolResult.image_list   ||
                                   toolResult.images       || [];
                const imgs = imgList.map(i => i.image || i.img_url || i.image_url || i.url).filter(Boolean);
                if (imgs.length) {
                  res.write(sseChunk(id, modelId, "\n" + imgs.map(u => `![image](${u})`).join("\n") + "\n"));
                }
                imageGenDone = true;
              }

            // ── Phase: answer (or unphased) ───────────────────────────────────────────────
            // Normal text reply. Streamed live unless a tool-call marker
            // enters the buffer, at which point we stop text streaming and
            // let the end-handler emit tool_calls chunks instead.
            //
            // FIX (partial-marker leak): Old code used .includes("[function_calls]")
            // requiring the FULL closing ]. With token-by-token streaming, the model
            // can emit "[function_calls" first (no "]"), so that partial text was
            // flushed to the client as visible content. Now we detect partial markers
            // and track sentUpTo so only the safe zone (before marker start) is sent.
            } else if (phase === "answer" || phase == null) {
              if (content) {
                answerBuf += content;

                // Flush loop — runs until no more progress is possible for this chunk.
                //
                // Problem A (split-chunk leakage): stripQwenTokens() only strips tokens
                // that arrive COMPLETE in a single slice. A token like <｜end of sentence｜>
                // can arrive split: "<｜end" in chunk N, " of sentence｜>" in chunk N+1 —
                // neither sub-slice matches, both pieces leak.
                //
                // Problem B (cursor stall after token): if we stop at a Qwen token (index
                // k in answerBuf) and advance sentUpTo to k, the content AFTER the token
                // (index k+tokenLen … end) is never flushed because safeFlushPoint keeps
                // returning k (the token is still there in the raw buffer).
                //
                // Fix: work on the TAIL slice (answerBuf from sentUpTo), so safeFlushPoint
                // sees a fresh window. After flushing the safe portion, explicitly skip
                // any complete Qwen token sitting at the cursor and loop — this drains all
                // buffered content, including whatever follows a stripped token.
                const TOOL_MARKERS = activeTools ? ["[function_calls", "<tool_use>"] : [];
                const ALL_MARKERS  = [...TOOL_MARKERS, ...QWEN_SPECIAL_TOKENS];
                let advanced = true;
                while (advanced) {
                  advanced = false;
                  const tail      = answerBuf.slice(sentUpTo);
                  const localSafe = safeFlushPoint(tail, ALL_MARKERS);
                  if (localSafe > 0) {
                    const chunk = stripUntrustedMarkers(stripQwenTokens(tail.slice(0, localSafe)));
                    if (chunk) res.write(sseChunk(id, modelId, chunk));
                    sentUpTo += localSafe;
                    advanced = true;
                  }
                  // Skip a complete Qwen token at the cursor so the next loop
                  // iteration can flush whatever follows it.
                  for (const tok of QWEN_SPECIAL_TOKENS) {
                    if (answerBuf.startsWith(tok, sentUpTo)) {
                      sentUpTo += tok.length;
                      advanced = true;
                      break;
                    }
                  }
                }
              }

              // Early detection on status:finished — guard with resolved flag to prevent
              // double-emit when qwenRes.on("end") fires afterward.
              if (status === "finished" && activeTools && hasToolUse(answerBuf) && !resolved) {
                resolved = true;
                _clearTimers();
                emitToolCalls(res, id, modelId, answerBuf);
                res.write("data: [DONE]\n\n");
                resolve();
                return; // short-circuit — don't process more chunks
              }
            }
            // Note: All other phases (e.g. "search", internal phases) are silently skipped.

          } catch { /* skip malformed JSON lines */ }
        }
      });

      qwenRes.on("end", () => {
        _clearTimers();
        if (resolved) return; // already handled by status:finished early-exit
        resolved = true;

        // At stream end, flush any remaining text content.
        // No partial-prefix protection needed here — the stream is complete,
        // so any surviving partial Qwen token is malformed and should be dropped.
        // Qwen tokens that ARE complete are stripped before writing.
        const endToolMarkers = activeTools ? ["[function_calls", "<tool_use>"] : [];

        if (activeTools && hasToolUse(answerBuf)) {
          // Tool call detected — emit OpenAI-format tool_calls chunks
          const toolCalls = parseToolUse(answerBuf);
          if (toolCalls) {
            emitToolCalls(res, id, modelId, answerBuf);
          } else {
            // hasToolUse fired but parseToolUse found nothing parseable (malformed block).
            // Flush pre-marker text as plain content so response isn't empty.
            const rawRemaining = answerBuf.slice(sentUpTo);
            let hardStop = rawRemaining.length;
            for (const m of endToolMarkers) { const i = rawRemaining.indexOf(m); if (i >= 0) hardStop = Math.min(hardStop, i); }
            const chunk = stripUntrustedMarkers(stripQwenTokens(rawRemaining.slice(0, hardStop)));
            if (chunk) res.write(sseChunk(id, modelId, chunk));
            res.write(sseChunk(id, modelId, "", true));
          }
        } else {
          // Regular text — flush any content still held in the buffer.
          const rawRemaining = answerBuf.slice(sentUpTo);
          let hardStop = rawRemaining.length;
          for (const m of endToolMarkers) { const i = rawRemaining.indexOf(m); if (i >= 0) hardStop = Math.min(hardStop, i); }
          const chunk = stripUntrustedMarkers(stripQwenTokens(rawRemaining.slice(0, hardStop)));
          if (chunk) res.write(sseChunk(id, modelId, chunk));
          res.write(sseChunk(id, modelId, "", true));
        }
        res.write("data: [DONE]\n\n");
        resolve();
      });
      qwenRes.on("error", e => { _clearTimers(); if (!resolved) { resolved = true; reject(e); } });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Stream timeout retry wrapper ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wraps streamQwen dengan retry otomatis saat stream timeout (idle atau total).
 *
 * Retry strategy:
 *   attempt 1 → timeout → ganti slot → attempt 2
 *   attempt 2 → timeout → ganti slot → attempt 3
 *   attempt N → timeout → give up, throw ke HTTP handler
 *
 * Untuk SSE streaming, SSE comment ditulis selama jeda supaya koneksi TCP
 * ke client (Hermes / OpenClaw) tetap hidup.
 *
 * @param {boolean} isStreaming – true → write SSE keep-alive comments saat wait
 */
async function streamQwenWithRetry(token, chatId, prompt, modelId, thinking, useSearch, res, id, tools, toolChoice, imageFiles, isStreaming = false) {
  let curToken  = token;
  let curChatId = chatId;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      await streamQwen(curToken, curChatId, prompt, modelId, thinking, useSearch, res, id, tools, toolChoice, imageFiles);
      if (attempt > 0) console.log(`[QwenProxy] ✓ retry berhasil di attempt ${attempt + 1}`);
      return; // ✓ success
    } catch (e) {
      const retryable = e.isTimeout && attempt < RETRY_MAX;
      if (retryable) {
        console.warn(`[QwenProxy] ⚠ Stream timeout (attempt ${attempt + 1}/${RETRY_MAX + 1}) — ganti slot segera...`);
        if (isStreaming) {
          try { res.write(`: qwen stream timeout, retrying slot lain...\n\n`); } catch {}
        }
        // Rotasi ke slot berikutnya, buat session baru
        rotate("stream timeout retry");
        const newSlot = current();
        curToken  = newSlot.token;
        curChatId = await getSession(curToken, modelId) || curChatId;
      } else {
        if (e.isTimeout) console.error(`[QwenProxy] ✗ Stream timeout after ${RETRY_MAX + 1} attempts — giving up.`);
        throw e;
      }
    }
  }
}

/**
 * Emit OpenAI streaming tool_calls chunks from parsed tool use in `content`.
 * Two chunks per tool: (1) name opener, (2) arguments. Then finish_reason chunk.
 */
function emitToolCalls(res, id, modelId, content) {
  const toolCalls = parseToolUse(content);
  if (!toolCalls) return;
  const now = Math.floor(Date.now() / 1000);

  toolCalls.forEach((tc, i) => {
    // Chunk 1: tool name opener (arguments: "" to open the stream)
    res.write(`data: ${JSON.stringify({
      id, model: modelId, object: "chat.completion.chunk", created: now,
      choices: [{ index: 0, finish_reason: null, delta: {
        tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }],
      }}],
    })}\n\n`);
    // Chunk 2: arguments payload
    res.write(`data: ${JSON.stringify({
      id, model: modelId, object: "chat.completion.chunk", created: now,
      choices: [{ index: 0, finish_reason: null, delta: {
        tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }],
      }}],
    })}\n\n`);
  });

  // Final chunk: finish_reason = "tool_calls"
  res.write(`data: ${JSON.stringify({
    id, model: modelId, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  })}\n\n`);
}

// ═════════════════════════════════════════════════════════════════════════
// ── HTTP Server ───────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-qwen-search");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── GET /v1/models (and health) ─────────────────────────────────────────
  if (req.method === "GET" && (req.url === "/v1" || req.url === "/v1/" ||
      req.url === "/health" || req.url?.startsWith("/v1/models"))) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [...new Set([...Object.keys(MODEL_MAP), DEFAULT_MODEL])].map(id => ({
        id, object: "model", created: 0, owned_by: "qwen-reverse",
      })),
    }));
    return;
  }

  // ── POST /v1/images/generations ─────────────────────────────────────────
  // OpenAI-compatible image gen — langsung parse delta.extra.image_list dari
  // Qwen stream, sesuai referensi qwen.js generateImage().
  // Override model: QWEN_IMAGE_MODEL env (default: "qwen3.7-plus").
  if (req.method === "POST" && req.url === "/v1/images/generations") {
    let imgBody = "";
    req.on("data", c => imgBody += c);
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(imgBody); }
      catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }

      const prompt     = parsed.prompt || "generate an image";
      const n          = Math.min(parsed.n || 1, 4);
      const imageModel = process.env.QWEN_IMAGE_MODEL || "qwen3.7-plus";
      const { modelId } = mapModel(imageModel);
      const slot        = nextSlot();

      const chatId = await createChatRaw(slot.token, modelId);
      if (!chatId) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to create Qwen image session" }));
        return;
      }

      console.log(`[QwenProxy] image gen → model=${modelId} slot=${slot.slot} n=${n} prompt="${prompt.slice(0, 80)}"`);

      const imgPrompt = n > 1
        ? `Generate ${n} images: ${prompt}`
        : `Generate an image: ${prompt}`;

      const fid = uuid(), cid = uuid(), ts = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({
        stream: true, version: "2.1", incremental_output: true,
        chat_id: chatId, chat_mode: "normal", model: modelId, parent_id: null,
        messages: [{
          fid, parentId: null, childrenIds: [cid],
          role: "user", content: imgPrompt,
          user_action: "chat", files: [], timestamp: ts,
          models: [modelId], chat_type: "t2t",
          feature_config: {
            thinking_enabled: false, output_schema: "phase",
            research_mode: "normal", auto_thinking: false,
            thinking_mode: "Fast", thinking_format: "summary",
            auto_search: false,
          },
          extra: { meta: { subChatType: "t2t" } },
          sub_chat_type: "t2t", parent_id: null,
        }],
        timestamp: ts + 1,
      });

      const u = new URL(`${BASE}/api/v2/chat/completions?chat_id=${chatId}`);
      const qwenReq = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: { ...makeHeaders(slot.token, chatId), "Content-Length": Buffer.byteLength(payload) },
        agent: AGENT,
      }, qwenRes => {
        if (qwenRes.statusCode !== 200) {
          let b = ""; qwenRes.on("data", c => b += c);
          qwenRes.on("end", () => {
            delChat(slot.token, chatId);
            const msg = `HTTP ${qwenRes.statusCode}: ${b.slice(0, 200)}`;
            if (/401|502/i.test(msg)) { slot.dead = true; rotate(msg); }
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: msg }));
          });
          return;
        }

        let buf = "", imageUrls = [], fullText = "";

        qwenRes.on("data", chunk => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const src = line.startsWith("data: ") ? line.slice(6) : line;
            if (!src.trim() || src.trim() === "[DONE]") continue;
            try {
              const d     = JSON.parse(src);
              const delta = d.choices?.[0]?.delta || {};

              // ★ Ambil URL langsung dari delta.extra.image_list (per referensi qwen.js)
              if (delta.phase === "image_gen_tool") {
                if (delta.status === "finished") {
                  const extra  = delta.extra || {};
                  const tr     = extra.tool_result || {};
                  const list   = extra.image_list || tr.image_list || tr.images || [];
                  for (const img of list) {
                    const url = img.image || img.img_url || img.image_url || img.url;
                    if (url) imageUrls.push(url);
                  }
                }
              } else if (delta.phase !== "thinking_summary" && delta.content) {
                fullText += delta.content;
              }
            } catch {}
          }
        });

        qwenRes.on("end", () => {
          delChat(slot.token, chatId);
          if (imageUrls.length) {
            console.log(`[QwenProxy] image gen selesai: ${imageUrls.length} gambar`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              created: Math.floor(Date.now() / 1000),
              data: imageUrls.map(url => ({ url })),
            }));
          } else {
            // Fallback: cari URL gambar di teks (jarang tapi jaga-jaga)
            const urlMatch = fullText.match(/https?:\/\/[^\s"')]+\.(png|jpg|jpeg|webp)/i);
            if (urlMatch?.[0]) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ url: urlMatch[0] }] }));
            } else {
              console.warn("[QwenProxy] image gen: tidak ada gambar. raw:", fullText.slice(0, 200));
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Qwen did not return any images", raw: fullText.slice(0, 500) }));
            }
          }
        });
      });

      qwenReq.on("error", e => {
        const msg = e.message || "";
        if (/ECONNRESET|ETIMEDOUT/i.test(msg)) { slot.dead = true; rotate(msg); }
        delChat(slot.token, chatId);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      });
      qwenReq.write(payload);
      qwenReq.end();
    });
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // ── POST /v1/chat/completions ────────────────────────────────────────────
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }

    const rawModel   = parsed.model || DEFAULT_MODEL;
    const messages   = parsed.messages || [];
    const tools      = parsed.tools || [];
    const toolChoice = parsed.tool_choice ?? "auto";
    const useSearch  = req.headers["x-qwen-search"] === "true";

    // ── Resolve model + thinking mode ───────────────────────────────────
    // Priority: model-name suffix > enable_thinking param > "Auto"
    const { modelId, thinkingSuffix } = mapModel(rawModel);
    const thinking = thinkingSuffix
      ?? (parsed.enable_thinking === true  ? "Thinking"
        : parsed.enable_thinking === false ? "Fast"
        : DEFAULT_THINKING);

    console.log(`[QwenProxy] ← model=${rawModel} → ${modelId} | msgs=${messages.length} tools=${tools.length} thinking=${thinking} tool_choice=${JSON.stringify(toolChoice)}`);

    // ── Vision: detect & upload images ──────────────────────────────────
    // Scan messages untuk OpenAI multimodal content (type:"image_url").
    // Kalau ada → upload ke Qwen OSS dulu sebelum stream.
    // Hermes auxiliary vision kirim model=qwen3.7-plus secara otomatis;
    // auto-switch juga berlaku kalau client lain kirim gambar tanpa -vl.
    let activeModelId   = modelId;
    let imageFiles      = [];
    const rawImages     = extractImagesFromMessages(messages);
    if (rawImages.length) {
      console.log(`[Vision] ${rawImages.length} gambar terdeteksi — upload ke Qwen OSS...`);
      // Pakai token dari slot yang sedang aktif (tanpa advance round-robin dua kali)
      const visionToken = (alive()[rrIdx % alive().length])?.token;
      if (visionToken) {
        try {
          const uploaded = await Promise.all(
            rawImages.map(img => uploadImageToQwen(visionToken, img.buffer, img.filename, img.mimetype))
          );
          imageFiles = uploaded.map(buildImageFileEntry);
          // Auto-switch ke vision model kalau model yang diminta bukan -vl
          if (!activeModelId.includes("vl") && !activeModelId.includes("vision")) {
            console.log(`[Vision] Auto-switch: ${activeModelId} → ${VISION_MODEL}`);
            activeModelId = VISION_MODEL;
          }
        } catch (e) {
          console.warn(`[Vision] Upload gagal (lanjut tanpa gambar): ${e.message}`);
        }
      }
    }

    const prompt = toPrompt(messages, tools, toolChoice);
    const slot   = nextSlot();

    const t0 = Date.now();
    const chatId = await getSession(slot.token, activeModelId);
    if (!chatId) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: "Failed to create Qwen session" }));
      return;
    }
    console.log(`[QwenProxy] session ready in ${Date.now()-t0}ms (${activeModelId} slot=${slot.slot})`);

    const id          = `chatcmpl-${uuid()}`;
    const isStreaming = parsed.stream === true;

    // ── Streaming response ─────────────────────────────────────────────
    if (isStreaming) {
      res.writeHead(200, {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Send role opener
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: activeModelId,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`);

      try {
        const t1 = Date.now();
        await streamQwenWithRetry(slot.token, chatId, prompt, activeModelId, thinking, useSearch, res, id, tools, toolChoice, imageFiles, true);
        console.log(`[QwenProxy] stream done in ${Date.now()-t1}ms`);
      } catch (e) {
        const msg = e.message || "";
        console.error("[QwenProxy] stream error (all retries exhausted):", msg);
        // ECONNRESET/ETIMEDOUT = Qwen nutup koneksi paksa → rotate token
        if (/401|502|rate.limit|RateLimit|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
          slot.dead = true; rotate(msg);
        }
        // Wrap writes — kalau koneksi ke Hermes juga sudah rusak, jangan sampai throw lagi
        try {
          res.write(sseChunk(id, modelId, `\n\n[Proxy error: ${msg.slice(0, 200)}]`));
          res.write(sseChunk(id, modelId, "", true));
          res.write("data: [DONE]\n\n");
        } catch (writeErr) {
          console.error("[QwenProxy] res.write gagal saat error handling:", writeErr.message);
        }
      } finally {
        delChat(slot.token, chatId);
        try { res.end(); } catch {}
      }

    // ── Non-streaming response (collect all → return JSON) ─────────────
    } else {
      const chunks        = [];
      let toolCallsResult = null;

      // fakeRes intercepts the SSE writes from streamQwen and accumulates them
      const fakeRes = {
        write(data) {
          if (typeof data !== "string") return;
          const raw = data.startsWith("data: ") ? data.slice(6).trim() : data.trim();
          if (!raw || raw === "[DONE]") return;
          try {
            const d     = JSON.parse(raw);
            const delta = d.choices?.[0]?.delta;
            if (!delta) return;

            if (delta.content) {
              chunks.push(delta.content);
            }
            // reasoning_content accumulates separately (not returned in non-streaming path,
            // but we could add it to the response if needed)
            if (delta.tool_calls) {
              if (!toolCallsResult) toolCallsResult = [];
              delta.tool_calls.forEach(tc => {
                const idx = tc.index ?? 0;
                if (!toolCallsResult[idx])
                  toolCallsResult[idx] = {
                    id:       tc.id || `tool_${idx}`,
                    type:     "function",
                    function: { name: "", arguments: "" },
                  };
                if (tc.function?.name)      toolCallsResult[idx].function.name      += tc.function.name;
                if (tc.function?.arguments) toolCallsResult[idx].function.arguments += tc.function.arguments;
              });
            }
          } catch {}
        },
      };

      try {
        await streamQwenWithRetry(slot.token, chatId, prompt, activeModelId, thinking, useSearch, fakeRes, id, tools, toolChoice, imageFiles, false);
      } catch (e) {
        const msg = e.message || "";
        if (/401|502|rate.limit|RateLimit/i.test(msg)) { slot.dead = true; rotate(msg); }
        chunks.push(`[Proxy error: ${msg.slice(0, 200)}]`);
      } finally {
        delChat(slot.token, chatId);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      if (toolCallsResult?.length) {
        res.end(JSON.stringify({
          id, object: "chat.completion",
          created: Math.floor(Date.now() / 1000), model: activeModelId,
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
          created: Math.floor(Date.now() / 1000), model: activeModelId,
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
  console.log(`[QwenProxy] ✓ http://127.0.0.1:${PORT}/v1  (${POOL.length} token siap)`);
  const { modelId: defaultModelId } = mapModel(DEFAULT_MODEL);
  console.log(`[QwenProxy] Pre-warming ${SESSION_BUFFER} sessions for ${defaultModelId}...`);
  for (let i = 0; i < SESSION_BUFFER; i++) preWarmSession(defaultModelId);
});
