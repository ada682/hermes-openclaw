# sonnetrade — Telegram = @Realsonnet - reverse proxy + hermes gateway
it seems that OpenClaw may need a few adjustments, since Kimi hasn't been tested on OpenClaw yet hehe

bikin dlu file .env.qwen dan .env.kimi buat diisi nanti setelah lu paham ,walau padahal lu gaakan paham

bot telegram yang pakai qwen atau kimi sebagai backend, tanpa perlu bayar API resmi.  
semua dijalankan lewat `start.js`.

---

## syarat

- node.js ≥ 22.13 → [nodejs.org](https://nodejs.org) (pilih LTS)
- python 3.x (untuk patch config hermes)
- hermes sudah terinstall (`pip install hermes-agent`)
- akun qwen atau kimi (salah satu, atau keduanya)

---

## struktur file

```
├── start.js                ← script utama
├── reverse-proxy.js        ← proxy qwen (port 4891)
├── kimi-reverse-proxy.js   ← proxy kimi (port 4892)
├── soul.md                 ← system prompt / persona bot
├── .env.qwen               ← token qwen (dibuat pas setup)
├── .env.kimi               ← token kimi (buat manual)
└── .proxy-type             ← nyimpen pilihan proxy terakhir (auto)
```

---

## setup pertama kali

```bash
node start.js
```

ikutin promptnya:
1. masukin token qwen (ambil dari devtools → application → local → qwen → di kolom sebelah kanan , cari yang token → copy value nya)
2. masukin bot token telegram (dari @BotFather)
3. ikutin hermes gateway setup — pilih telegram, masukin user ID-mu
4. script otomatis patch config hermes

kalau udah pernah setup, langsung lanjut ke bagian bawah.

---

## token kimi (manual)

buat file `.env.kimi` di folder yang sama:

```
KIMI_TOKEN_1=cpmt_xxx...
KIMI_TOKEN_2=cpmt_yyy...   ← opsional, bisa sampe 10
```

atau pakai JWT langsung:

```
KIMI_TOKEN_1=eyJhbGci...
```

cara ambil token kimi:
1. buka [kimi.com](https://www.kimi.com) → login
2. F12 → application 
3. pilih local storage → pilih yang refresh token
4. copy value nya masukin .env.kimi

---

## cara jalankan

### pakai 2 terminal (disarankan)

**terminal 1 — proxy:**
```bash
node start.js proxy kimi    ← kimi (port 4892)
node start.js proxy qwen    ← qwen (port 4891)
node start.js proxy         ← pakai pilihan tersimpan
```

**terminal 2 — gateway:**
```bash
node start.js gateway       ← otomatis baca pilihan tersimpan
```

### pakai 1 terminal

```bash
node start.js               ← proxy + gateway sekaligus
```

### override sementara tanpa ganti setting

```bash
PROXY=kimi node start.js
```

---

## sistem simpan pilihan proxy

setiap kali `node start.js proxy kimi` atau `proxy qwen` dijalankan, pilihan otomatis disimpan ke `.proxy-type`.  
jadi `node start.js proxy` dan `node start.js gateway` berikutnya langsung pakai setting itu tanpa perlu ketik ulang.

urutan prioritas:
```
arg CLI  >  env PROXY  >  .proxy-type  >  default: qwen
```

---

## patch config hermes (manual)

kalau mau patch sendiri tanpa script, ini yang perlu diubah:

### mode kimi

**`~/.hermes/config.yaml`**
```yaml
model:
  default: kimi-k2.6
  provider: custom
  base_url: http://localhost:4892/v1
  api_key: proxy-key
  api_mode: chat_completions

web:
  backend: ""
  search_backend: kimi
  extract_backend: kimi

custom_providers:
  - name: kimi proxy
    base_url: http://localhost:4892/v1
    api_key: proxy-key
    model: kimi-k2.6
    api_mode: chat_completions
```

**`~/.hermes/.env`**
```
OPENAI_BASE_URL=http://localhost:4892/v1
OPENAI_API_KEY=proxy-key
```

### mode qwen

**`~/.hermes/config.yaml`**
```yaml
model:
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
    api_mode: chat_completions
```

**`~/.hermes/.env`**
```
OPENAI_BASE_URL=http://localhost:4891/v1
OPENAI_API_KEY=proxy-key
TAVILY_API_KEY=tvly-xxxx...
```

---

## web search

### kimi
web search udah built-in, tidak perlu API key tambahan.  
proxy otomatis detect kalau ada tool `web_search` dan relay ke native `$web_search` kimi.

### qwen
butuh Tavily API key:
1. daftar di [app.tavily.com](https://app.tavily.com)
2. salin key (`tvly-xxxx...`)
3. taruh di `~/.hermes/.env`:
   ```
   TAVILY_API_KEY=tvly-xxxx...
   ```

alternatif gratis (tanpa API key) — edit `~/.hermes/config.yaml`:
```yaml
web:
  search_backend: ddgs
  extract_backend: tavily
```

---

## path hermes

| OS | path |
|---|---|
| windows | `%LOCALAPPDATA%\hermes\` |
| linux / VPS | `~/.hermes/` |
| mac | `~/.hermes/` |

---

## lokasi file di VPS

kalau pakai VPS linux, path lengkap biasanya:
```
/root/.hermes/config.yaml
/root/.hermes/.env
```

atau kalau bukan root:
```
/home/namauser/.hermes/config.yaml
/home/namauser/.hermes/.env
```

cek dengan:
```bash
ls -la ~/.hermes/
```

---

## ganti model

edit di `~/.hermes/config.yaml` bagian `model.default`:

```yaml
model:
  default: kimi-k2.6          ← kimi default
  # default: kimi-k1          ← kimi k1
  # default: qwen3-max        ← qwen default
  # default: qwen3.7-plus     ← qwen plus
```

atau lewat env sebelum jalanin:
```bash
KIMI_MODEL=kimi-k1 node start.js proxy kimi
```

---

## reset setup

```bash
node start.js --reset
```

ini hapus: `.setup-done`, `.env.qwen`, `.env.kimi`, `.proxy-type`, dan config hermes.  
setelah reset, jalankan `node start.js` lagi dari awal.

---

## troubleshooting

**proxy langsung mati / error token**  
→ token expired. ambil token baru dari devtools, update `.env.qwen` atau `.env.kimi`.

**gateway tetap ke qwen padahal proxy kimi**  
→ pastiin `node start.js proxy kimi` dijalanin dulu (ini yang nyimpen `.proxy-type`).  
→ atau jalankan `node start.js gateway kimi` untuk override sekali.

**soul.md tidak ke-inject**  
→ pastiin `soul.md` ada di folder yang sama dengan `start.js`.  
→ pastiin python terinstall (`python --version` atau `python3 --version`).

**hermes tidak ketemu**  
→ jalankan: `pip install hermes-agent --break-system-packages`

**port sudah dipakai**  
→ kimi: set `KIMI_PROXY_PORT=4893` sebelum jalanin  
→ qwen: defaultnya 4891, edit langsung di `reverse-proxy.js`
1
