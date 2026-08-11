#!/usr/bin/env python3
"""Tool HISTORY SEARCH buat agent sandbox.

Cara pake (dari agent, via terminal):
    python3 /srv/ubox/scripts/history_search.py "<kata kunci>" <chat_id> [limit]

Contoh:
    python3 /srv/ubox/scripts/history_search.py "drainer" -1002732627985 20

Nyari pesan lama di history chat (di luar rolling window history.md) via
Telethon (endpoint userbot di 127.0.0.1:9101). Output = daftar pesan
yang match + timestamp + pengirim. Kalau hasil kosong → coba kata kunci
lain / lebih pendek.
"""
import json
import sys
import urllib.parse
import urllib.request

API = "http://127.0.0.1:9101/history_search"


def main():
    if len(sys.argv) < 3:
        print("pake: history_search.py '<query>' <chat_id> [limit]")
        print("contoh: history_search.py 'drainer' -1002732627985 20")
        sys.exit(1)
    q = sys.argv[1]
    chat = sys.argv[2]
    limit = sys.argv[3] if len(sys.argv) > 3 else "20"
    url = f"{API}?q={urllib.parse.quote(q)}&chat={urllib.parse.quote(chat)}&limit={limit}"
    try:
        with urllib.request.urlopen(url, timeout=25) as r:
            d = json.loads(r.read().decode())
    except Exception as e:
        print(f"❌ search gagal: {e}")
        sys.exit(1)
    if "error" in d:
        print(f"❌ {d['error']}")
        sys.exit(1)
    ctype = d.get("chat_type", "group")
    cuname = d.get("chat_username", "")
    print(f"🔍 Hasil pencarian '{d['query']}' ({d['count']} pesan) [chat_type={ctype}, username={cuname or '-'}]:")
    print("  LINK FORMAT: group/channel → https://t.me/c/<id>/<msg_id> | user pake username → https://t.me/<username>/<msg_id> | user tanpa username → nggak bisa bikin link")
    for line in d.get("results", []):
        print("  " + line)
    if not d.get("results"):
        print("  (nggak ada yang match — STOP, lapor 'nggak nemu' ke user, jangan cari lagi)")


if __name__ == "__main__":
    main()
