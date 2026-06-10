#!/usr/bin/env node
import fs from "fs";
import path from "path";
import os from "os";
import { execSync, spawn, spawnSync } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const C = {
  reset:"\x1b[0m", bold:"\x1b[1m",
  green:"\x1b[32m", yellow:"\x1b[33m", cyan:"\x1b[36m",
  red:"\x1b[31m", gray:"\x1b[90m", white:"\x1b[97m",
};
const ok   = m => console.log(`${C.green}✓${C.reset} ${m}`);
const info = m => console.log(`${C.cyan}→${C.reset} ${m}`);
const warn = m => console.log(`${C.yellow}!${C.reset} ${m}`);
const err  = m => console.log(`${C.red}✗${C.reset} ${m}`);
const step = m => console.log(`\n${C.bold}${C.white}${m}${C.reset}`);

const MARKER         = path.join(__dirname, ".setup-done");
const ENV_FILE       = path.join(__dirname, ".env.qwen");
// File kecil untuk menyimpan proxy type terakhir yang dipakai
const PROXY_TYPE_FILE = path.join(__dirname, ".proxy-type");

// Hermes config paths (Windows: %LOCALAPPDATA%\hermes, Unix: ~/.hermes)
const HERMES_HOME = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "hermes")
  : path.join(os.homedir(), ".hermes");
const HERMES_ENV  = path.join(HERMES_HOME, ".env");
const HERMES_CFG  = path.join(HERMES_HOME, "config.yaml");

// Legacy OpenClaw paths (dipakai kalau mode=openclaw)
const CLAW_DIR    = path.join(os.homedir(), ".openclaw");
const CLAW_CFG    = path.join(CLAW_DIR, "openclaw.json");

const PROXY_JS      = path.join(__dirname, "reverse-proxy.js");
const KIMI_PROXY_JS = path.join(__dirname, "kimi-reverse-proxy.js");
const SOUL_MD       = path.join(__dirname, "soul.md");

// Env file untuk Kimi tokens
const ENV_FILE_KIMI = path.join(__dirname, ".env.kimi");

// Agent yang dipakai: "hermes" | "openclaw"
const AGENT = process.env.AGENT || "hermes";

function ask(rl, q) { return new Promise(r => rl.question(q, r)); }

// Simpan proxy type terakhir ke .proxy-type supaya gateway/proxy bisa baca tanpa arg
function saveProxyType(type) {
  fs.writeFileSync(PROXY_TYPE_FILE, type.toLowerCase());
}

// Baca proxy type tersimpan: arg > PROXY env > .proxy-type > default "qwen"
function resolveProxyType(argOverride) {
  if (argOverride) return argOverride.toLowerCase();
  if (process.env.PROXY) return process.env.PROXY.toLowerCase();
  if (fs.existsSync(PROXY_TYPE_FILE)) {
    const saved = fs.readFileSync(PROXY_TYPE_FILE, "utf8").trim();
    if (saved === "kimi" || saved === "qwen") return saved;
  }
  return "qwen";
}

function loadEnv() {
  // Load .env.qwen (qwen tokens)
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
  // Load .env.kimi (kimi tokens) jika ada
  if (fs.existsSync(ENV_FILE_KIMI)) {
    for (const line of fs.readFileSync(ENV_FILE_KIMI, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
}

function cmdExists(cmd) {
  try { execSync(`${cmd} --version`, { stdio: "ignore" }); return true; }
  catch { return false; }
}

function patchConfigHermes(tgToken) {
  // Pastikan dir ~/.hermes ada
  if (!fs.existsSync(HERMES_HOME)) fs.mkdirSync(HERMES_HOME, { recursive: true });

  // --- config.yaml ---
  // Baca yang ada, atau mulai dari kosong
  let yaml = fs.existsSync(HERMES_CFG) ? fs.readFileSync(HERMES_CFG, "utf8") : "";

  // Patch gateway.base_url kalau belum ada
  if (!yaml.includes("base_url:") && !yaml.includes("openai_base_url:")) {
    yaml += `\ngateway:\n  base_url: http://localhost:4891/v1\n  api_key: proxy-key\n`;
  }

  fs.writeFileSync(HERMES_CFG, yaml);

  // --- .env (token Telegram + OPENAI_BASE_URL) ---
  let envContent = fs.existsSync(HERMES_ENV) ? fs.readFileSync(HERMES_ENV, "utf8") : "";

  // Tambah TELEGRAM_BOT_TOKEN kalau belum ada
  if (!envContent.includes("TELEGRAM_BOT_TOKEN=")) {
    envContent += `\nTELEGRAM_BOT_TOKEN=${tgToken}\n`;
  } else {
    envContent = envContent.replace(/TELEGRAM_BOT_TOKEN=.*/g, `TELEGRAM_BOT_TOKEN=${tgToken}`);
  }

  // Arahkan OPENAI_BASE_URL ke proxy lokal
  if (!envContent.includes("OPENAI_BASE_URL=")) {
    envContent += `OPENAI_BASE_URL=http://localhost:4891/v1\n`;
  }
  if (!envContent.includes("OPENAI_API_KEY=")) {
    envContent += `OPENAI_API_KEY=proxy-key\n`;
  }

  fs.writeFileSync(HERMES_ENV, envContent);
}

function patchConfigClaw(tgToken) {
  // Baca config yang sudah ada (hasil onboard), tambahkan/fix fields yang diperlukan
  let config = {};
  if (fs.existsSync(CLAW_CFG)) {
    try { config = JSON.parse(fs.readFileSync(CLAW_CFG, "utf8")); } catch {}
  }

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.mode) config.gateway.mode = "local";

  if (!config.channels) config.channels = {};
  config.channels.telegram = {
    enabled: true,
    botToken: tgToken,
    dmPolicy: "pairing",
  };

  if (config.models && !Array.isArray(config.models)) {
    delete config.models;
  }

  if (!fs.existsSync(CLAW_DIR)) fs.mkdirSync(CLAW_DIR, { recursive: true });
  fs.writeFileSync(CLAW_CFG, JSON.stringify(config, null, 2));
}

function patchConfig(tgToken) {
  if (AGENT === "hermes") patchConfigHermes(tgToken);
  else patchConfigClaw(tgToken);
}

// ─── PYTHON DETECTOR ──────────────────────────────────────────────────────────
// Windows: "python" atau "py" | Unix: "python3" atau "python"
function findPython() {
  const candidates = process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: "ignore" });
      return cmd;
    } catch {}
  }
  return null;
}

// ─── SOUL.MD INJECTOR ─────────────────────────────────────────────────────────
function patchSoulMd() {
  if (!fs.existsSync(SOUL_MD)) {
    warn(`soul.md tidak ditemukan di: ${SOUL_MD}`);
    warn("Buat file soul.md di folder yang sama dengan start.js");
    return;
  }
  if (!fs.existsSync(HERMES_CFG)) {
    warn("config.yaml belum ada, soul.md akan diinject setelah setup selesai.");
    return;
  }

  const pyCmd = findPython();
  if (!pyCmd) {
    warn("Python tidak ditemukan! Install Python dari https://python.org");
    warn("Pastikan centang 'Add Python to PATH' saat install.");
    return;
  }

  const tmpPy = path.join(os.tmpdir(), "hermes_patch_soul.py");
  // Gunakan forward slash untuk path di Python (aman di semua OS)
  const soulPathEsc   = SOUL_MD.replace(/\\/g, "/");
  const configPathEsc = HERMES_CFG.replace(/\\/g, "/");

  fs.writeFileSync(tmpPy, `
import yaml

soul_path   = r"${soulPathEsc}"
config_path = r"${configPathEsc}"

with open(soul_path, encoding="utf-8") as f:
    soul = f.read()

with open(config_path, encoding="utf-8") as f:
    cfg = yaml.safe_load(f) or {}

if "agent" not in cfg:
    cfg["agent"] = {}
if "personalities" not in cfg["agent"]:
    cfg["agent"]["personalities"] = {}

cfg["agent"]["system_prompt"] = soul
cfg["agent"]["personalities"]["superagent"] = soul

with open(config_path, "w", encoding="utf-8") as f:
    yaml.dump(cfg, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

print("OK")
`);

  try {
    const result = execSync(`"${pyCmd}" "${tmpPy}"`, { encoding: "utf8" });
    if (result.trim() === "OK") {
      ok(`soul.md → config.yaml (${fs.statSync(SOUL_MD).size} bytes) via ${pyCmd}`);
    }
  } catch (e) {
    const msg = e.message || "";
    // pyyaml belum install? coba auto-install
    if (msg.includes("No module named 'yaml'") || msg.includes("ModuleNotFoundError")) {
      info("pyyaml belum ada, menginstall...");
      try {
        execSync(`"${pyCmd}" -m pip install pyyaml --quiet`, { stdio: "inherit" });
        const result2 = execSync(`"${pyCmd}" "${tmpPy}"`, { encoding: "utf8" });
        if (result2.trim() === "OK") ok(`soul.md → config.yaml (pyyaml baru diinstall)`);
      } catch (e2) {
        warn(`Gagal inject soul.md: ${e2.message.split("\n")[0]}`);
      }
    } else {
      warn(`Gagal inject soul.md: ${msg.split("\n")[0]}`);
    }
  } finally {
    try { fs.unlinkSync(tmpPy); } catch {}
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Tanya Y/N — default yes */
function askYN(question, defaultYes = true) {
  return new Promise(resolve => {
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    const rl2  = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl2.question(`  ${question} ${hint}: `, ans => {
      rl2.close();
      const a = ans.trim().toLowerCase();
      resolve(defaultYes ? a !== "n" : a === "y");
    });
  });
}

// ─── HERMES CONFIG PATCHER ────────────────────────────────────────────────────
/**
 * Patch ~/.hermes/config.yaml surgically untuk proxyType yang dipilih.
 * Yang diubah:
 *   - model.default + model.base_url
 *   - custom_providers (entry proxy)
 *   - plugins.enabled  (image_gen dimatikan untuk kimi)
 *   - image_gen section
 */
function patchHermesConfig(proxyType = "qwen") {
  if (AGENT !== "hermes") return;
  if (!fs.existsSync(HERMES_CFG)) {
    warn("config.yaml tidak ditemukan, skip patch hermes config");
    return;
  }

  const pyCmd = findPython();
  if (!pyCmd) {
    warn("Python tidak ditemukan! Patch config.yaml dilewati.");
    return;
  }

  const isKimi     = proxyType === "kimi";
  const kimiModel  = (process.env.KIMI_MODEL || "kimi-k2.6").replace(/"/g, "");
  const qwenModel  = (process.env.QWEN_MODEL  || "qwen3.7-max").replace(/"/g, "");
  const cfgPathEsc = HERMES_CFG.replace(/\\/g, "/");

  const tmpPy = path.join(os.tmpdir(), "hermes_patch_proxy_cfg.py");
  fs.writeFileSync(tmpPy, `
import yaml

config_path = r"${cfgPathEsc}"
is_kimi     = ${isKimi ? "True" : "False"}
kimi_model  = "${kimiModel}"
qwen_model  = "${qwenModel}"

with open(config_path, encoding="utf-8") as f:
    cfg = yaml.safe_load(f) or {}

# ── 1. model section ────────────────────────────────────────────────────────
if "model" not in cfg:
    cfg["model"] = {}

cfg["model"]["default"]  = kimi_model if is_kimi else qwen_model
cfg["model"]["base_url"] = "http://localhost:4892/v1" if is_kimi else "http://localhost:4891/v1"
cfg["model"]["provider"] = "custom"
cfg["model"]["api_key"]  = "proxy-key"
cfg["model"]["api_mode"] = "chat_completions"

# ── 2. custom_providers ─────────────────────────────────────────────────────
providers = cfg.get("custom_providers") or []
# Hapus entry lama qwen/kimi proxy
providers = [p for p in providers if isinstance(p, dict)
             and p.get("name") not in ("qwen proxy", "kimi proxy")]

if is_kimi:
    providers.insert(0, {
        "name":     "kimi proxy",
        "base_url": "http://localhost:4892/v1",
        "api_key":  "proxy-key",
        "model":    kimi_model,
        "api_mode": "chat_completions",
    })
else:
    providers.insert(0, {
        "name":     "qwen proxy",
        "base_url": "http://localhost:4891/v1",
        "api_key":  "proxy-key",
        "model":    "qwen3.7-plus",
        "api_mode": "chat_completions",
    })
cfg["custom_providers"] = providers

# ── 3. plugins + image_gen ──────────────────────────────────────────────────
plugins = cfg.get("plugins") or {}
if not isinstance(plugins, dict):
    plugins = {}
enabled = plugins.get("enabled") or []
if not isinstance(enabled, list):
    enabled = []

if is_kimi:
    # Kimi tidak support image gen — nonaktifkan plugin
    enabled = [p for p in enabled if p != "image_gen/qwen-proxy"]
    cfg["image_gen"] = {"provider": "none", "use_gateway": False, "model": ""}
else:
    # Qwen — aktifkan kembali image gen
    if "image_gen/qwen-proxy" not in enabled:
        enabled.append("image_gen/qwen-proxy")
    cfg["image_gen"] = {"provider": "qwen-proxy", "use_gateway": False, "model": "qwen-image"}

plugins["enabled"] = enabled
cfg["plugins"] = plugins

# ── 4. auxiliary.vision ─────────────────────────────────────────────────────
if "auxiliary" not in cfg:
    cfg["auxiliary"] = {}
if not isinstance(cfg["auxiliary"], dict):
    cfg["auxiliary"] = {}
if "vision" not in cfg["auxiliary"] or not isinstance(cfg["auxiliary"]["vision"], dict):
    cfg["auxiliary"]["vision"] = {}

cfg["auxiliary"]["vision"]["base_url"] = "http://localhost:4892/v1" if is_kimi else "http://localhost:4891/v1"
cfg["auxiliary"]["vision"]["model"]    = kimi_model if is_kimi else qwen_model
cfg["auxiliary"]["vision"]["api_key"]  = "proxy-key"

with open(config_path, "w", encoding="utf-8") as f:
    yaml.dump(cfg, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

print("OK")
`);

  function runPatch() {
    return execSync(`"${pyCmd}" "${tmpPy}"`, { encoding: "utf8" }).trim();
  }

  try {
    const r = runPatch();
    if (r === "OK") {
      const label = isKimi ? "Kimi" : "Qwen";
      ok(`config.yaml diperbarui untuk ${label} proxy`);
    }
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("No module named 'yaml'") || msg.includes("ModuleNotFoundError")) {
      info("pyyaml belum ada, menginstall...");
      try {
        execSync(`"${pyCmd}" -m pip install pyyaml --quiet`, { stdio: "inherit" });
        const r2 = runPatch();
        if (r2 === "OK") ok(`config.yaml diperbarui (pyyaml baru diinstall)`);
      } catch (e2) {
        warn(`Gagal patch config.yaml: ${e2.message.split("\n")[0]}`);
      }
    } else {
      warn(`Gagal patch config.yaml: ${msg.split("\n")[0]}`);
    }
  } finally {
    try { fs.unlinkSync(tmpPy); } catch {}
  }
}

// ─── HERMES ENV PATCHER ───────────────────────────────────────────────────────
/**
 * Patch OPENAI_BASE_URL di ~/.hermes/.env sesuai proxy yang dipilih.
 * Hanya baris OPENAI_BASE_URL yang diubah, semua baris lain tetap.
 */
function patchHermesEnv(proxyType = "qwen") {
  if (AGENT !== "hermes") return;
  if (!fs.existsSync(HERMES_HOME)) return;

  const isKimi  = proxyType === "kimi";
  const baseUrl = isKimi ? "http://localhost:4892/v1" : "http://localhost:4891/v1";

  let content = fs.existsSync(HERMES_ENV) ? fs.readFileSync(HERMES_ENV, "utf8") : "";

  if (content.includes("OPENAI_BASE_URL=")) {
    content = content.replace(/^OPENAI_BASE_URL=.*/m, `OPENAI_BASE_URL=${baseUrl}`);
  } else {
    content += `\nOPENAI_BASE_URL=${baseUrl}\n`;
  }
  if (!content.includes("OPENAI_API_KEY=")) {
    content += `OPENAI_API_KEY=proxy-key\n`;
  }

  fs.writeFileSync(HERMES_ENV, content);
  ok(`Hermes .env → OPENAI_BASE_URL=${baseUrl}`);
}

// ─── WEB SEARCH BACKEND PATCHER ───────────────────────────────────────────────
/**
 * Patch web.search_backend & web.extract_backend di config.yaml.
 *  - Kimi  → "kimi"    (proxy sudah handle natively via $web_search tool)
 *  - Qwen  → tetap "tavily" (butuh API key external)
 */
function patchWebSearchBackend(proxyType = "qwen") {
  if (AGENT !== "hermes") return;
  if (!fs.existsSync(HERMES_CFG)) {
    warn("config.yaml tidak ditemukan, skip patch web search backend");
    return;
  }

  const pyCmd = findPython();
  if (!pyCmd) { warn("Python tidak ditemukan, skip patch web search backend."); return; }

  const isKimi     = proxyType === "kimi";
  const cfgPathEsc = HERMES_CFG.replace(/\\/g, "/");

  const tmpPy = path.join(os.tmpdir(), "hermes_patch_websearch.py");
  fs.writeFileSync(tmpPy, `
import yaml

config_path = r"${cfgPathEsc}"
is_kimi     = ${isKimi ? "True" : "False"}

with open(config_path, encoding="utf-8") as f:
    cfg = yaml.safe_load(f) or {}

if "web" not in cfg:
    cfg["web"] = {}

if is_kimi:
    # Kimi proxy sudah support $web_search native — arahkan Hermes web tools ke kimi backend
    # yang akan di-relay lewat kimi-reverse-proxy.js (auto-detect tool "web_search")
    cfg["web"]["backend"]         = ""
    cfg["web"]["search_backend"]  = "kimi"
    cfg["web"]["extract_backend"] = "kimi"
else:
    # Qwen — pakai Tavily (key sudah harus ada di .env)
    cfg["web"]["backend"]         = ""
    cfg["web"]["search_backend"]  = "tavily"
    cfg["web"]["extract_backend"] = "tavily"

with open(config_path, "w", encoding="utf-8") as f:
    yaml.dump(cfg, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

print("OK")
`);

  function run() { return execSync(`"${pyCmd}" "${tmpPy}"`, { encoding: "utf8" }).trim(); }

  try {
    const r = run();
    if (r === "OK") {
      if (isKimi) {
        ok(`web search backend → kimi (native via proxy)`);
      } else {
        ok(`web search backend → tavily (pastikan TAVILY_API_KEY ada di ~/.hermes/.env)`);
      }
    }
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("No module named 'yaml'") || msg.includes("ModuleNotFoundError")) {
      try {
        execSync(`"${pyCmd}" -m pip install pyyaml --quiet`, { stdio: "inherit" });
        const r2 = run();
        if (r2 === "OK") ok(`web search backend diperbarui`);
      } catch (e2) { warn(`Gagal patch web search backend: ${e2.message.split("\n")[0]}`); }
    } else {
      warn(`Gagal patch web search backend: ${msg.split("\n")[0]}`);
    }
  } finally {
    try { fs.unlinkSync(tmpPy); } catch {}
  }
}

// ─── ORCHESTRATOR: TANYA DULU SEBELUM PATCH ──────────────────────────────────
/**
 * Tanya user apakah mau patch config.yaml & .env.
 * Jika NO → tampilkan pesan suruh lihat README.md manual.
 * Jika YES → jalankan semua patch + soul.md.
 * Untuk Qwen: tampilkan info Tavily setelah patch.
 */
async function maybePatchHermes(proxyType = "qwen") {
  if (AGENT !== "hermes") return;

  const isKimi   = proxyType === "kimi";
  const label    = isKimi ? "Kimi" : "Qwen";
  const cfgOk    = fs.existsSync(HERMES_CFG);
  const homeOk   = fs.existsSync(HERMES_HOME);

  // Deteksi path hermes (VPS vs Windows vs lokal)
  const hermesPath = (() => {
    if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "hermes");  // Windows
    const snap   = path.join(os.homedir(), "snap", "hermes");
    const dotHermes = path.join(os.homedir(), ".hermes");
    return fs.existsSync(snap) ? snap : dotHermes;
  })();

  step(`Patch Hermes config (${label} mode)`);
  console.log(`${C.gray}
  Path Hermes terdeteksi:
    config.yaml : ${HERMES_CFG}
    .env        : ${HERMES_ENV}
    Ada?        : config.yaml=${cfgOk ? "✓" : "✗"}  .env=${fs.existsSync(HERMES_ENV) ? "✓" : "✗"}
${C.reset}`);

  const wantPatch = await askYN(
    `Mau otomatis patch config.yaml & .env untuk ${label}?`
  );

  if (!wantPatch) {
    console.log(`
${C.yellow}Manual setup — lihat README.md untuk langkah-langkah berikut:${C.reset}

  ${C.cyan}Di ~/.hermes/config.yaml${C.reset} pastikan bagian ini ada/diubah:
  ${C.gray}─────────────────────────────────────────────────────${C.reset}
${isKimi ? `  model:
    default: kimi-k2.6
    provider: custom
    base_url: http://localhost:4892/v1
    api_key: proxy-key
    api_mode: chat_completions

  auxiliary:
    vision:
      base_url: http://localhost:4892/v1
      model: kimi-k2.6
      api_key: proxy-key

  web:
    backend: ""
    search_backend: kimi
    extract_backend: kimi

  custom_providers:
    - name: kimi proxy
      base_url: http://localhost:4892/v1
      api_key: proxy-key
      model: kimi-k2.6
      api_mode: chat_completions` :
`  model:
    default: qwen3-max
    provider: custom
    base_url: http://localhost:4891/v1
    api_key: proxy-key
    api_mode: chat_completions

  web:
    backend: ""
    search_backend: tavily
    extract_backend: tavily

  custom_providers:
    - name: qwen proxy
      base_url: http://localhost:4891/v1
      api_key: proxy-key
      model: qwen3.7-plus
      api_mode: chat_completions`}
  ${C.gray}─────────────────────────────────────────────────────${C.reset}

  ${C.cyan}Di ~/.hermes/.env${C.reset} pastikan ada:
    OPENAI_BASE_URL=${isKimi ? "http://localhost:4892/v1" : "http://localhost:4891/v1"}
    OPENAI_API_KEY=proxy-key
${!isKimi ? `    TAVILY_API_KEY=tvly-xxxx...   ← ambil di https://app.tavily.com
` : ""}
  Setelah edit manual, jalankan lagi: ${C.cyan}node start.js ${isKimi ? "proxy kimi" : "proxy"}${C.reset}
`);
    return;
  }

  // ── Backup file asli sebelum patch ────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupTargets = [
    [HERMES_CFG, "config.yaml"],
    [HERMES_ENV, ".env"],
  ];

  let anyBackedUp = false;
  for (const [src, label] of backupTargets) {
    if (fs.existsSync(src)) {
      const bak = `${src}.backup-${ts}`;
      try {
        fs.copyFileSync(src, bak);
        ok(`Backup: ${label} → ${path.basename(bak)}`);
        anyBackedUp = true;
      } catch (e) {
        warn(`Gagal backup ${label}: ${e.message} — lanjut tanpa backup`);
      }
    } else {
      info(`${label} belum ada, tidak perlu backup`);
    }
  }

  if (anyBackedUp) {
    info(`Backup tersimpan di: ${HERMES_HOME}`);
    info(`Untuk restore manual: salin file .backup-${ts} kembali ke nama aslinya`);
  }

  // ── Lakukan patch ──────────────────────────────────────────────────────────
  patchHermesConfig(proxyType);
  patchHermesEnv(proxyType);
  patchWebSearchBackend(proxyType);

  // ── Post-patch info ────────────────────────────────────────────────────────
  if (!isKimi) {
    // Qwen: cek apakah TAVILY_API_KEY sudah ada
    const hasTavily = !!(process.env.TAVILY_API_KEY ||
      (fs.existsSync(HERMES_ENV) && fs.readFileSync(HERMES_ENV, "utf8").includes("TAVILY_API_KEY=")));

    if (hasTavily) {
      ok("TAVILY_API_KEY sudah ada di ~/.hermes/.env — web search siap");
    } else {
      console.log(`
${C.yellow}⚠  Web Search untuk Qwen butuh Tavily API key!${C.reset}

  ${C.cyan}Cara setup Tavily di Hermes:${C.reset}
  1. Buka https://app.tavily.com → Register → salin API key (tvly-xxxx...)
  2. Tambahkan ke ${C.cyan}~/.hermes/.env${C.reset}:
       TAVILY_API_KEY=tvly-xxxx...

  Atau lewat CLI hermes:
       ${C.cyan}hermes tools${C.reset}  → pilih "Web Search & Extract" → pilih Tavily → masukkan key

  ${C.gray}Tanpa Tavily, web_search tool akan error.
  Alternatif gratis: DDGS (tidak perlu API key, auto-install).
  Set di config.yaml:  web.search_backend: ddgs${C.reset}
`);
    }
  } else {
    // Kimi: info bahwa web search sudah built-in via proxy
    ok("Kimi web search: sudah built-in via kimi-reverse-proxy.js");
    info("Setiap request yang ada tool 'web_search' otomatis di-relay ke Kimi native search.");
    info("Tidak perlu API key tambahan untuk web search.");
  }

  // Soul.md — ditanya paling terakhir setelah semua patch & info selesai
  if (fs.existsSync(SOUL_MD) && fs.existsSync(HERMES_CFG)) {
    const patchSoul = await askYN(`Patch soul.md → config.yaml? (${fs.statSync(SOUL_MD).size} bytes)`);
    if (patchSoul) patchSoulMd();
    else info("soul.md skip.");
  } else {
    patchSoulMd();
  }
}


async function runSetup() {
  const agentLabel = AGENT === "hermes" ? "Hermes" : "OpenClaw";
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════╗
║  ${agentLabel} × Qwen Reverse API  — Setup   ║
╚══════════════════════════════════════════╝${C.reset}\n`);

  // 1. Cek Node.js
  step("1/5  Cek Node.js");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    err(`Node.js ${process.versions.node} terlalu lama! Butuh ≥ 22.13`);
    err(`Download: https://nodejs.org  (pilih LTS)`);
    process.exit(1);
  }
  ok(`Node.js ${process.versions.node}`);

  // 2. Install agent (hermes atau openclaw)
  step(`2/5  Install ${AGENT}`);
  if (AGENT === "hermes") {
    if (cmdExists("hermes")) {
      ok("hermes: " + execSync("hermes --version", { encoding: "utf8" }).trim());
    } else {
      info("Menginstall hermes-agent secara global...");
      try {
        execSync("pip install hermes-agent --break-system-packages", { stdio: "inherit" });
        ok("hermes: " + execSync("hermes --version", { encoding: "utf8" }).trim());
      } catch {
        err("Install gagal. Coba manual: pip install hermes-agent");
        process.exit(1);
      }
    }
  } else {
    if (cmdExists("openclaw")) {
      ok("openclaw: " + execSync("openclaw --version", { encoding: "utf8" }).trim());
    } else {
      info("Menginstall openclaw secara global...");
      try {
        execSync("npm install -g openclaw", { stdio: "inherit" });
        ok("openclaw: " + execSync("openclaw --version", { encoding: "utf8" }).trim());
      } catch {
        err("Install gagal. Coba manual: npm install -g openclaw");
        process.exit(1);
      }
    }
  }

  // 3. Token Qwen
  step("3/5  Token Qwen");
  console.log(`${C.gray}
  1. Buka https://chat.qwen.ai → login
  2. Tekan F12 → tab Network → kirim pesan apa saja
  3. Cari request: /api/v2/chat/completions
  4. Headers → salin nilai:  Authorization: Bearer eyJ...
${C.reset}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const envLines = [];
  let tokenCount = 0;

  for (let i = 1; i <= 10; i++) {
    const raw = (await ask(rl, `  Token ${i}${i > 1 ? " (Enter = selesai)" : ""}: `)).trim();
    if (!raw) {
      if (i === 1) { warn("Minimal 1 token!"); i--; continue; }
      break;
    }
    const token = raw.replace(/^Bearer\s+/i, "");
    if (!token.startsWith("eyJ")) warn("Token biasanya dimulai eyJ...");
    envLines.push(`QWEN_TOKEN_${i}=${token}`);
    tokenCount++;
  }

  // 4. Token Telegram
  step("4/5  Token bot Telegram");
  console.log(`${C.gray}  Telegram → @BotFather → /newbot → salin token${C.reset}`);
  let tgToken = "";
  while (!tgToken) {
    tgToken = (await ask(rl, "  Bot token (123456:ABC...): ")).trim();
    if (!tgToken) warn("Token wajib diisi!");
  }
  rl.pause(); // jangan close, stdin masih dibutuhkan oleh onboard

  // Simpan .env.qwen
  fs.writeFileSync(ENV_FILE, envLines.join("\n") + "\n");
  ok(`${tokenCount} token Qwen disimpan`);

  // 5. Setup agent config via wizard
  step("5/5  Setup config gateway");

  if (AGENT === "hermes") {
    console.log(`${C.yellow}
  Sekarang hermes gateway setup akan tanya beberapa hal.
  Ikuti langkah berikut:

  ❶  Pilih platform → pilih "Telegram"
  ❷  Masukkan bot token Telegram yang tadi kamu input
  ❸  Masukkan user ID Telegram kamu (cek via @userinfobot)
  ❹  Sisanya Enter saja (default)
${C.reset}`);

    if (!fs.existsSync(HERMES_HOME)) fs.mkdirSync(HERMES_HOME, { recursive: true });

    const proxyEnv = { ...process.env };
    for (const line of envLines) {
      const sep = line.indexOf("=");
      if (sep > 0) proxyEnv[line.slice(0, sep)] = line.slice(sep + 1);
    }
    info("Menyalakan proxy sementara untuk verifikasi setup...");
    const proxyProc = spawn(process.execPath, [PROXY_JS], {
      env: proxyEnv,
      stdio: "pipe",
      detached: false,
    });
    proxyProc.stdout.on("data", d => process.stdout.write(`${C.gray}[PROXY]${C.reset} ${d}`));
    proxyProc.stderr.on("data", d => process.stderr.write(`${C.yellow}[PROXY]${C.reset} ${d}`));
    await new Promise(r => setTimeout(r, 2000));
    ok("Proxy siap di http://127.0.0.1:4891/v1");

    const onboard = spawnSync("hermes", ["gateway", "setup"], {
      stdio: "inherit",
      shell: true,
    });

    proxyProc.kill();
    rl.close();
    if (onboard.status !== 0) {
      warn("gateway setup keluar dengan kode " + onboard.status + ". Mencoba lanjut...");
    }

    patchConfig(tgToken);
    ok(`Config diperbarui → ${HERMES_HOME}`);

  } else {
    // --- OpenClaw onboard flow (tidak berubah) ---
    console.log(`${C.yellow}
  Sekarang openclaw akan tanya beberapa hal.
  Ikuti langkah berikut:
  
  ❶  Pilih provider → cari "Qwen" atau "Model Studio"
  ❷  Pilih metode auth → "API Key"  
  ❸  Masukkan API Key → ketik: proxy-key  (bebas, proxy yang manage token asli)
  ❹  Masukkan Base URL → ketik: http://localhost:4891/v1
  ❺  Sisanya ikuti default saja (Enter terus)
${C.reset}`);

    if (!fs.existsSync(CLAW_DIR)) fs.mkdirSync(CLAW_DIR, { recursive: true });

    const proxyEnv = { ...process.env };
    for (const line of envLines) {
      const sep = line.indexOf("=");
      if (sep > 0) proxyEnv[line.slice(0, sep)] = line.slice(sep + 1);
    }
    info("Menyalakan proxy sementara untuk verifikasi onboard...");
    const proxyProc = spawn(process.execPath, [PROXY_JS], {
      env: proxyEnv,
      stdio: "pipe",
      detached: false,
    });
    proxyProc.stdout.on("data", d => process.stdout.write(`${C.gray}[PROXY]${C.reset} ${d}`));
    proxyProc.stderr.on("data", d => process.stderr.write(`${C.yellow}[PROXY]${C.reset} ${d}`));
    await new Promise(r => setTimeout(r, 2000));
    ok("Proxy siap di http://127.0.0.1:4891/v1");

    const onboard = spawnSync("openclaw", ["onboard", "--mode", "local"], {
      stdio: "inherit",
      shell: true,
    });

    proxyProc.kill();
    rl.close();
    if (onboard.status !== 0) {
      warn("Onboard keluar dengan kode " + onboard.status + ". Mencoba lanjut...");
    }

    patchConfig(tgToken);
    ok(`Config diperbarui → ${CLAW_CFG}`);
  }

  fs.writeFileSync(MARKER, new Date().toISOString());
  console.log(`\n${C.green}${C.bold}Setup selesai!${C.reset}\n`);
}

// ─── RUN HELPERS ─────────────────────────────────────────────────────────────
function ensureConfig(proxyType = "qwen") {
  const isKimi = proxyType === "kimi";

  if (!isKimi && !process.env.QWEN_TOKEN_1) {
    err("QWEN_TOKEN_1 tidak ditemukan. Jalankan: node start.js --reset");
    process.exit(1);
  }

  if (AGENT === "hermes") {
    // Base URL tergantung proxy type
    if (!process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = isKimi ? "http://localhost:4892/v1" : "http://localhost:4891/v1";
    }
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = "proxy-key";
    }
  } else {
    if (fs.existsSync(CLAW_CFG)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(CLAW_CFG, "utf8"));
        if (!cfg.gateway?.mode) {
          cfg.gateway = { ...(cfg.gateway || {}), mode: "local" };
          fs.writeFileSync(CLAW_CFG, JSON.stringify(cfg, null, 2));
          ok("gateway.mode=local ditambahkan ke config");
        }
      } catch {}
    }
  }
}

function startProxy(proxyType) {
  loadEnv();
  // Resolve proxy type: arg > PROXY env > .proxy-type > default "qwen"
  const type = resolveProxyType(proxyType);
  const isKimi = type === "kimi";

  // Simpan pilihan ini supaya gateway & proxy berikutnya bisa baca tanpa arg
  saveProxyType(type);
  info(`Proxy type disimpan: ${type} → gunakan 'node start.js proxy' atau 'node start.js gateway' tanpa arg`);

  if (isKimi) {
    if (!process.env.KIMI_TOKEN_1) {
      err("KIMI_TOKEN_1 tidak ditemukan. Buat .env.kimi dengan KIMI_TOKEN_1=<token>");
      info("Format .env.kimi:\n  KIMI_TOKEN_1=cpmt_xxx...\n  # atau JWT: KIMI_TOKEN_1=eyJ...");
      process.exit(1);
    }
    if (!fs.existsSync(KIMI_PROXY_JS)) {
      err(`kimi-reverse-proxy.js tidak ditemukan di: ${KIMI_PROXY_JS}`);
      process.exit(1);
    }
    console.log(`\n${C.bold}${C.cyan}[ Kimi Reverse Proxy ]${C.reset}\n`);
    info("Memulai Kimi proxy di port 4892...");
    const proxy = spawn(process.execPath, [KIMI_PROXY_JS], {
      env: { ...process.env },
      stdio: "inherit",
    });
    proxy.on("exit", code => { if (code) err(`Kimi proxy berhenti (kode ${code})`); process.exit(code || 0); });
    process.on("SIGINT", () => { proxy.kill("SIGTERM"); setTimeout(() => process.exit(0), 500); });
  } else {
    ensureConfig("qwen");
    console.log(`\n${C.bold}${C.cyan}[ Qwen Reverse Proxy ]${C.reset}\n`);
    info("Memulai Qwen proxy di port 4891...");
    const proxy = spawn(process.execPath, [PROXY_JS], {
      env: { ...process.env },
      stdio: "inherit",
    });
    proxy.on("exit", code => { if (code) err(`Proxy berhenti (kode ${code})`); process.exit(code || 0); });
    process.on("SIGINT", () => { proxy.kill("SIGTERM"); setTimeout(() => process.exit(0), 500); });
  }
}

async function startGateway() {
  loadEnv();
  // Resolve: arg2 (node start.js gateway kimi) > PROXY env > .proxy-type > default "qwen"
  const proxyType = resolveProxyType(arg2);
  const savedFrom = arg2 ? "arg CLI"
    : process.env.PROXY ? "env PROXY"
    : fs.existsSync(PROXY_TYPE_FILE) ? `.proxy-type (${fs.readFileSync(PROXY_TYPE_FILE,"utf8").trim()})`
    : "default";
  info(`Gateway mode: ${proxyType}  [sumber: ${savedFrom}]`);
  ensureConfig(proxyType);

  const agentCmd = AGENT === "hermes" ? "hermes" : "openclaw";
  if (!cmdExists(agentCmd)) {
    err(`${agentCmd} tidak ditemukan. Jalankan: node start.js --reset`);
    process.exit(1);
  }

  // Patch hermes config.yaml + .env untuk proxy yang aktif
  await maybePatchHermes(proxyType);

  const label = AGENT === "hermes" ? "Hermes" : "OpenClaw";
  info(`Memulai ${agentCmd} gateway...`);
  const gwArgs = AGENT === "hermes" ? ["gateway", "run"] : ["gateway"];
  const gw = spawn(agentCmd, gwArgs, {
    env: { ...process.env },
    stdio: "inherit",
    shell: true,
  });
  gw.on("exit", code => process.exit(code || 0));
  process.on("SIGINT", () => { gw.kill("SIGTERM"); setTimeout(() => process.exit(0), 500); });
}

async function runAll() {
  loadEnv();

  // Pilih proxy: PROXY env > .proxy-type > default "qwen"
  const proxyType = resolveProxyType(null);
  const isKimi    = proxyType === "kimi";

  ensureConfig(proxyType);  // sets OPENAI_BASE_URL + validates tokens

  const agentCmd = AGENT === "hermes" ? "hermes" : "openclaw";
  if (!cmdExists(agentCmd)) {
    err(`${agentCmd} tidak ditemukan. Jalankan: node start.js --reset`);
    process.exit(1);
  }

  // Patch hermes config.yaml + .env
  await maybePatchHermes(proxyType);

  const proxyFile = isKimi ? KIMI_PROXY_JS : PROXY_JS;
  const proxyTag  = isKimi ? "KIMI" : "PROXY";

  if (isKimi && !process.env.KIMI_TOKEN_1) {
    err("PROXY=kimi tapi KIMI_TOKEN_1 tidak ditemukan. Cek .env.kimi");
    process.exit(1);
  }

  const agentLabel = AGENT === "hermes" ? "Hermes" : "OpenClaw";
  const proxyLabel = isKimi ? "Kimi" : "Qwen";
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════╗
║  ${agentLabel} × ${proxyLabel} Reverse API — Starting ║
╚══════════════════════════════════════════╝${C.reset}\n`);
  info(`Mode gabung (${proxyLabel} proxy + gateway 1 terminal)`);
  info("Untuk pisah: buka 2 terminal →");
  console.log(`  ${C.cyan}Terminal 1:${C.reset} node start.js proxy ${proxyType}`);
  console.log(`  ${C.cyan}Terminal 2:${C.reset} node start.js gateway\n`);

  const proxy = spawn(process.execPath, [proxyFile], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxy.stdout.on("data", d => process.stdout.write(`${C.gray}[${proxyTag}]${C.reset} ${d}`));
  proxy.stderr.on("data", d => process.stderr.write(`${C.yellow}[${proxyTag}]${C.reset} ${d}`));
  proxy.on("exit", code => { if (code) err(`${proxyLabel} proxy berhenti (kode ${code})`); });

  const gwArgs = AGENT === "hermes" ? ["gateway", "run"] : ["gateway"];
  setTimeout(() => {
    const gw = spawn(agentCmd, gwArgs, {
      env: { ...process.env },
      stdio: ["inherit", "inherit", "inherit"],
      shell: true,
    });
    gw.on("exit", code => { proxy.kill(); process.exit(code || 0); });
    process.on("SIGINT", () => {
      gw.kill("SIGTERM"); proxy.kill("SIGTERM");
      setTimeout(() => process.exit(0), 1000);
    });
  }, 1500);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
const arg  = process.argv[2];
const arg2 = process.argv[3];   // sub-arg: "qwen" | "kimi"

if (arg === "--reset") {
  [MARKER, ENV_FILE, ENV_FILE_KIMI, PROXY_TYPE_FILE].forEach(f => {
    if (fs.existsSync(f)) { fs.unlinkSync(f); info(`Dihapus: ${path.basename(f)}`); }
  });
  // Hapus config sesuai agent aktif
  if (AGENT === "hermes") {
    [HERMES_CFG, HERMES_ENV].forEach(f => {
      if (fs.existsSync(f)) { fs.unlinkSync(f); info(`Dihapus: ${path.basename(f)}`); }
    });
  } else {
    if (fs.existsSync(CLAW_CFG)) { fs.unlinkSync(CLAW_CFG); info("Dihapus: openclaw.json"); }
  }
  console.log("\nReset selesai. Jalankan: node start.js\n");
  process.exit(0);
}

// Mode terpisah — langsung jalankan tanpa setup check
if (arg === "proxy") {
  // node start.js proxy          → PROXY env atau default qwen
  // node start.js proxy qwen     → qwen proxy
  // node start.js proxy kimi     → kimi proxy
  startProxy(arg2);
} else if (arg === "gateway") {
  await startGateway();
} else {
  // Mode normal — setup jika perlu, lalu tanya mau gabung atau pisah
  if (!fs.existsSync(MARKER)) {
    await runSetup();
  } else {
    ok(`Setup sudah ada (${fs.readFileSync(MARKER, "utf8").split("T")[0]})`);

    // Cek apakah kimi tokens tersedia
    loadEnv();
    const hasKimi = !!process.env.KIMI_TOKEN_1;
    const hasQwen = !!process.env.QWEN_TOKEN_1;

    // Cek proxy type tersimpan
    const savedProxy = fs.existsSync(PROXY_TYPE_FILE)
      ? fs.readFileSync(PROXY_TYPE_FILE, "utf8").trim()
      : null;

    console.log(`
${C.bold}Cara jalankan:${C.reset}
  ${C.cyan}node start.js proxy${C.reset}         → proxy (${savedProxy ? `tersimpan: ${savedProxy}` : `default: ${process.env.PROXY || "qwen"}`})
  ${C.cyan}node start.js proxy qwen${C.reset}    → Qwen proxy  (port 4891) + simpan pilihan
  ${C.cyan}node start.js proxy kimi${C.reset}    → Kimi proxy  (port 4892) + simpan pilihan
  ${C.cyan}node start.js gateway${C.reset}       → gateway (baca pilihan tersimpan${savedProxy ? `: ${savedProxy}` : ", default: qwen"})
  ${C.cyan}node start.js gateway qwen${C.reset}  → gateway mode Qwen (override)
  ${C.cyan}node start.js gateway kimi${C.reset}  → gateway mode Kimi (override)
  ${C.cyan}node start.js${C.reset}               → proxy + gateway (mode lama)

  ${C.gray}PROXY=kimi node start.js   → jalankan dengan Kimi proxy${C.reset}
  ${C.gray}node start.js --reset      → setup ulang${C.reset}

${C.bold}Token tersedia:${C.reset}
  Qwen: ${hasQwen ? `${C.green}✓${C.reset}` : `${C.red}✗ (isi QWEN_TOKEN_1 di .env.qwen)${C.reset}`}
  Kimi: ${hasKimi ? `${C.green}✓${C.reset}` : `${C.yellow}belum — buat .env.kimi dengan KIMI_TOKEN_1=<cpmt_xxx atau eyJ...>${C.reset}`}
${savedProxy ? `${C.bold}Proxy tersimpan:${C.reset} ${savedProxy === "kimi" ? C.cyan : C.green}${savedProxy}${C.reset}` : ""}
`);
  }
  await runAll();
}
