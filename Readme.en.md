# sonnetrade - telegram = @Realsonnet
agents using qwen / kimi / deepseek model,reverse api without paying for the official API. unlimited tokens

> 🇮🇩 [Baca dalam Bahasa Indonesia](Readme.md)

---

## requirements

- node.js ≥ 22.13
- python 3.x
- hermes installed: `pip install hermes-agent`
- [qwen](https://chat.qwen.ai) or [kimi](https://www.kimi.com) account

---

## first time setup fill the token in the .env.qwen - kimi - deepseek

```bash
node start.js proxy qwen
or
node start.js proxy kimi
or
node star.js proxy deepseek
```

---

## KIMI TOKEN (manual)

create a `.env.kimi` file:

```
KIMI_TOKEN_1=cpmt_xxx...
KIMI_TOKEN_2=cpmt_xxx...
KIMI_TOKEN_3=cpmt_xxx...
etc..
```

how to get: open kimi.com → F12 → Application → Local Storage → click kimi → find `refresh_token` → copy the value.

---

## QWEN TOKEN (manual)

create a `.env.qwen` file:

```
QWEN_TOKEN_1=eyj..
QWEN_TOKEN_2=eyj..
QWEN_TOKEN_3=eyj..
etc..
```

how to get: open qwen chat → F12 → Application → Local Storage → click qwen → find `token` → copy the value.

---

## DEEPSEEK TOKEN (manual)

create a `.env.deepseek` file:

```
DEEPSEEK_TOKEN_1=eyj..
DEEPSEEK_HIF_LEIM_1=...
DEEPSEEK_SMIDV2_1=...
DEEPSEEK_DS_SESSION_ID_1=...

DEEPSEEK_TOKEN_2=eyj..
DEEPSEEK_HIF_LEIM_2=...
DEEPSEEK_SMIDV2_2=...
DEEPSEEK_DS_SESSION_ID_2=...

DEEPSEEK_TOKEN_3=eyj..
DEEPSEEK_HIF_LEIM_3=...
DEEPSEEK_SMIDV2_3=...
DEEPSEEK_DS_SESSION_ID_3=...
etc..
```

how to get: open deepseek chat → F12 → Application → Local Storage → click https://chat.deepseek → find `usertoken`,`HIF_LEIM`,`SMIDV2`,`DS_SESSION` → copy the value.

---

## how to run

```bash
# 2 terminals (recommended)
node start.js proxy   # terminal 1
# or
node start.js gateway       # terminal 2
```

---

CONTEXT =
Kimi = 256k |
Deepseek V4 = 1M |
qwen3.7-plus or max = 1M

## web search

built-in

---

## troubleshooting

| problem | solution |
|---|---|
| proxy crashes / token error | token expired, get a new one from devtools |
| gateway still using qwen despite kimi proxy | run `node start.js proxy kimi` first |
| soul.md not injected | make sure `soul.md` is in the same folder |
| port already in use | set `KIMI_PROXY_PORT=4893` or `QWEN_PROXY_PORT=4893` |

---

## reset

```bash
node start.js --reset
```
