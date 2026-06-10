# sonnetrade - telegram = @Realsonnet
agents yang pake qwen / kimi,reverse api tanpa bayar API resmi. unlimited token

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

## cara jalankan

```bash

# 2 terminal (disarankan)
node start.js proxy  # terminal 1

node start.js gateway       # terminal 2
```
CONTEXT
Kimi K2.6 = 256k
Qwen3.7-plur/max = 1M
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
