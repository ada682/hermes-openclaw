# sonnetrade - telegram = @Realsonnet
agents yang pake qwen / kimi / deepseek,reverse api tanpa bayar API resmi. unlimited token

> 🇬🇧 [Read in English](Readme.en.md)

---

## syarat

- node.js ≥ 22.13
- python 3.x
- hermes sudah terinstall: `pip install hermes-agent`
- akun [qwen](https://chat.qwen.ai) atau [kimi](https://www.kimi.com)

---

## setup pertama kali isi token ke .env.kimi - qwen -deepseek

```bash
node start.js proxy kimi
or
node start.js proxy qwen
or
node start.js proxy deepseek
```

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

cara ambil: buka qwen chat → F12 → Application → Local Storage → klik yang qwen → cari `token` → copy value nya.

---

## TOKEN DEEPSEEK (manual)

buat file `.env.deepseek`. tiap akun butuh 6 nilai:

```
DEEPSEEK_TOKEN_1=eyj..
DEEPSEEK_HIF_LEIM_1=...
DEEPSEEK_SMIDV2_1=...
DEEPSEEK_DS_SESSION_ID_1=...
DEEPSEEK_WEB_ID_1=...
DEEPSEEK_USER_UNIQUE_ID_1=...

DEEPSEEK_TOKEN_2=eyj..
DEEPSEEK_HIF_LEIM_2=...
DEEPSEEK_SMIDV2_2=...
DEEPSEEK_DS_SESSION_ID_2=...
DEEPSEEK_WEB_ID_2=...
DEEPSEEK_USER_UNIQUE_ID_2=...
dst..
```

**Token (usertoken, HIF_LEIM, SMIDV2, DS_SESSION):**
buka deepseek chat → F12 → Application → Local Storage / Cookies → klik `https://chat.deepseek.com` → cari `usertoken`, `HIF_LEIM`, `smidV2`, `ds_session_id` → copy.

**WEB_ID & USER_UNIQUE_ID (untuk telemetry — wajib):**
buka deepseek chat → F12 → tab **Network** → kirim 1 pesan apa aja → cari request ke `gator.volces.com/list` → tab **Payload** → bagian `"user"`:
```json
"user": { "user_unique_id": "xxxx-xxxx-...", "web_id": "76519918..." }
```
copy dua nilai itu. (mau matiin telemetry? set `DEEPSEEK_TELEMETRY_ENABLED=false`, dua nilai ini jadi gak wajib.)


---

## cara jalankan

```bash

# 2 terminal (disarankan)
node start.js proxy  # terminal 1

node start.js gateway       # terminal 2
```
CONTEXT =
Kimi K2.6 = 256k |
Qwen3.7-plus/max = 1M |
Deepseek V4 = 1M
---

## web search

built- in

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
