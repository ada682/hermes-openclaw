# sonnetrade - telegram = @Realsonnet
telegram bot using qwen / kimi as backend, without paying for the official API. unlimited tokens

> 🇮🇩 [Baca dalam Bahasa Indonesia](README.md)

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
node start.js proxy kimi    # terminal 1
# or
node start.js proxy qwen
node start.js gateway       # terminal 2
```

proxy choice is saved automatically, so you only need to run `node start.js proxy kimi` once.

---

## web search

- **kimi** — built-in, no extra setup needed
- **qwen** — requires a Tavily key in `~/.hermes/.env`:
  ```
  TAVILY_API_KEY=tvly-xxxx...
  ```
  or use the free alternative: change `search_backend: ddgs` in `~/.hermes/config.yaml`

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
