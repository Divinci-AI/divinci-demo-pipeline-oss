#!/usr/bin/env python3
"""Generate an image from a source reference + a prompt (prompt via NANO_PROMPT
env var to avoid shell escaping). NanoBanana / Gemini image.

GKEY=... NANO_PROMPT="..." python3 nano-gen.py <source> <out.png> [model]
"""
import base64, json, os, sys, urllib.request

src, out = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else "gemini-3-pro-image"
key = os.environ["GKEY"]
prompt = os.environ["NANO_PROMPT"]

parts = [{"text": prompt}]
if src and src != "-":
    with open(src, "rb") as f:
        b = base64.b64encode(f.read()).decode()
    mime = "image/webp" if src.endswith(".webp") else "image/png"
    parts.append({"inlineData": {"mimeType": mime, "data": b}})

body = {"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"]}}
url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
try:
    resp = json.load(urllib.request.urlopen(req, timeout=240))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:600]); sys.exit(1)
cands = resp.get("candidates", [])
if not cands:
    print("NO CANDIDATES", json.dumps(resp)[:600]); sys.exit(1)
for p in cands[0]["content"]["parts"]:
    if "inlineData" in p:
        with open(out, "wb") as f:
            f.write(base64.b64decode(p["inlineData"]["data"]))
        print("WROTE", out); sys.exit(0)
print("NO IMAGE PART", json.dumps(resp)[:600]); sys.exit(1)
