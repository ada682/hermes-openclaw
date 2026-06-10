# sonnetrade - telegram = @Realsonnet
agents using qwen / kimi model,reverse api without paying for the official API. unlimited tokens

> 🇮🇩 [Baca dalam Bahasa Indonesia](Readme.md)

---

## requirements

- node.js ≥ 22.13
- python 3.x
- hermes installed: `pip install hermes-agent`
- [qwen](https://chat.qwen.ai) or [kimi](https://www.kimi.com) account

---

## first time setup

```bash
node start.js
```

follow the prompts — enter your token, telegram bot token, done.

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

## how to run

```bash
# 1 terminal
node start.js

# 2 terminals (recommended)
node start.js proxy   # terminal 1
# or
node start.js gateway       # terminal 2
```
Note: First, choose whether you want to use Qwen or Kimi.

To do that, run:
node start.js proxy qwen

or

node start.js proxy kimi

Also, choose whether you want to use OpenClaw or Hermes Agent as the gateway.

To do that, run:
node start.js gateway openclaw

or

node start.js gateway hermes

proxy choice is saved automatically, so you only need to run `node start.js proxy kimi` once.

---

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
