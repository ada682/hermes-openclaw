#!/usr/bin/env node
/**
 * analyze_document.js — CLI script untuk analyze_document skill
 *
 * Dipanggil oleh agent via bash:
 *   node analyze_document.js --file <path> --question <text> --provider <qwen|kimi|auto>
 *
 * Output: JSON ke stdout
 */

import fs   from "fs";
import path from "path";

// ── Parse CLI args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const filePath = getArg("--file");
const question = getArg("--question") || "Tolong ringkas isi dokumen ini secara lengkap.";
const provider = (getArg("--provider") || "auto").toLowerCase();

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

if (!filePath) {
  out({ error: "Missing --file argument" });
  process.exit(1);
}

// ── Provider config ───────────────────────────────────────────────────────
const DEFAULT_PROVIDER = (process.env.DOC_PROVIDER || "qwen").toLowerCase();

const PROVIDERS = {
  qwen: {
    url:      process.env.QWEN_PROXY_URL || "http://127.0.0.1:4891",
    model:    process.env.QWEN_MODEL     || "qwen3.7-plus",
    maxBytes: 20 * 1024 * 1024,
    label:    "Qwen",
  },
  kimi: {
    url:      process.env.KIMI_PROXY_URL || "http://127.0.0.1:4892",
    model:    process.env.KIMI_MODEL     || "kimi-k2.6",
    maxBytes: 50 * 1024 * 1024,
    label:    "Kimi",
  },
};

// ── MIME map ──────────────────────────────────────────────────────────────
const MIME_MAP = {
  ".pdf":      "application/pdf",
  ".doc":      "application/msword",
  ".docx":     "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls":      "application/vnd.ms-excel",
  ".xlsx":     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt":      "application/vnd.ms-powerpoint",
  ".pptx":     "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt":      "text/plain",
  ".csv":      "text/csv",
  ".md":       "text/markdown",
  ".markdown": "text/markdown",
};

// ── Main ──────────────────────────────────────────────────────────────────
const providerKey = provider === "auto" ? DEFAULT_PROVIDER : provider;
const cfg = PROVIDERS[providerKey];

if (!cfg) {
  out({ error: `Provider tidak dikenal: "${providerKey}". Gunakan: qwen, kimi, auto` });
  process.exit(1);
}

const absPath = path.resolve(filePath);

if (!fs.existsSync(absPath)) {
  out({ error: `File tidak ditemukan: ${absPath}` });
  process.exit(1);
}

const stat = fs.statSync(absPath);
if (!stat.isFile()) {
  out({ error: `Bukan file biasa: ${absPath}` });
  process.exit(1);
}
if (stat.size === 0) {
  out({ error: `File kosong: ${absPath}` });
  process.exit(1);
}
if (stat.size > cfg.maxBytes) {
  out({ error: `File terlalu besar untuk ${cfg.label} (${(stat.size/1024/1024).toFixed(1)} MB, max ${cfg.maxBytes/1024/1024} MB). Coba provider lain atau kompres file.` });
  process.exit(1);
}

const ext      = path.extname(absPath).toLowerCase();
const mimetype = MIME_MAP[ext];
if (!mimetype) {
  out({ error: `Format tidak didukung: "${ext}". Format yang didukung: ${Object.keys(MIME_MAP).join(", ")}` });
  process.exit(1);
}

const buffer   = fs.readFileSync(absPath);
const b64      = buffer.toString("base64");
const filename = path.basename(absPath);

process.stderr.write(`[analyze_document] "${filename}" (${(stat.size/1024).toFixed(1)} KB, ${mimetype}) → ${cfg.label} (${cfg.url})\n`);

// Kedua proxy (Qwen & Kimi) terima format Anthropic document block yang sama.
// Qwen proxy baca field `title`, Kimi proxy baca field `name` — kirim keduanya.
const body = JSON.stringify({
  model:  cfg.model,
  stream: false,
  messages: [{
    role: "user",
    content: [
      {
        type:   "document",
        source: { type: "base64", media_type: mimetype, data: b64 },
        title:  filename,   // Qwen proxy
        name:   filename,   // Kimi proxy
      },
      { type: "text", text: question },
    ],
  }],
});

const url = new URL(`${cfg.url}/v1/chat/completions`);

import https from "https";
import http  from "http";

const transport = url.protocol === "https:" ? https : http;

const req = transport.request({
  hostname: url.hostname,
  port:     url.port || (url.protocol === "https:" ? 443 : 80),
  path:     url.pathname,
  method:   "POST",
  headers:  {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(body),
  },
}, res => {
  let raw = "";
  res.on("data", c => raw += c);
  res.on("end", () => {
    if (res.statusCode !== 200) {
      out({ error: `${cfg.label} proxy error ${res.statusCode}: ${raw.slice(0, 300)}` });
      process.exit(1);
    }
    try {
      const data   = JSON.parse(raw);
      const result = data.choices?.[0]?.message?.content || data.error || "Tidak ada respons dari model";
      out({
        result,
        file:     filename,
        size_kb:  Math.round(stat.size / 1024),
        provider: cfg.label,
        model:    cfg.model,
      });
    } catch (e) {
      out({ error: `Parse response gagal: ${e.message}. Raw: ${raw.slice(0, 200)}` });
      process.exit(1);
    }
  });
});

req.on("error", e => {
  out({ error: `Gagal koneksi ke ${cfg.label} proxy (${cfg.url}): ${e.message}` });
  process.exit(1);
});

req.write(body);
req.end();