# sonnetrade - telegram = @Realsonnet
bot telegram yang pakai qwen / kimi sebagai backend, tanpa bayar API resmi. unlimited token

---

## syarat

- node.js ≥ 22.13
- python 3.x
- hermes sudah terinstall: `pip install hermes-agent`
- akun [qwen](https://chat.qwen.ai) atau [kimi](https://www.kimi.com)

---

## setup pertama kali

```bash
node start.js
```

ikutin promptnya — masukin token, bot token telegram, selesai.

---

## TOKEN KIMI (manual)

buat file `.env.kimi`:

```
KIMI_TOKEN_1=cpmt_xxx...
KIMI_TOKEN_2=cpmt_xxx...
KIMI_TOKEN_3=cpmt_xxx...
dst..
```

cara ambil: buka kimi.com → F12 → Application → Local Storage → klik yang kimi → cari `refresh_token` → copy value nya.

---

## TOKEN QWEN (manual)

buat file `.env.qwen`:

```
QWEN_TOKEN_1=eyj..
QWEN_TOKEN_2=eyj..
QWEN_TOKEN_3=eyj..
dst..
```

cara ambil; buka qwen chat → F12 → Application → Local Storage → klik yang qwen → cari 'token' → copy value nya.

## cara jalankan

```bash
# 1 terminal
node start.js

# 2 terminal (disarankan)
node start.js proxy kimi    # terminal 1
atau
node start.js proxy qwen
node start.js gateway       # terminal 2
```

pilihan proxy tersimpan otomatis, jadi cukup `node start.js proxy kimi` sekali.

---

## web search

- **kimi** — built-in, tidak perlu setup tambahan
- **qwen** — butuh Tavily key di `~/.hermes/.env`:
  ```
  TAVILY_API_KEY=tvly-xxxx...
  ```
  atau pakai gratis: ubah `search_backend: ddgs` di `~/.hermes/config.yaml`

---

## troubleshooting

| masalah | solusi |
|---|---|
| proxy mati / error token | token expired, ambil baru dari devtools |
| gateway tetap ke qwen padahal proxy kimi | jalankan `node start.js proxy kimi` dulu |
| soul.md tidak ke-inject | pastiin `soul.md` ada di folder yang sama |
| port sudah dipakai | set `KIMI_PROXY_PORT=4893` atau `QWEN_PROXY_PORT=4893` |

---

## reset

```bash
node start.js --reset
```
