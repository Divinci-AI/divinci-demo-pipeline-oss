#!/usr/bin/env python3
"""Restyle a photographic hero background into a subtle, illustrated art-style
background in the brand palette, via NanoBanana (Gemini image).

Usage:
  GKEY=... python3 restyle-photo-hero.py <photo.webp> <out.png> [model]
"""
import base64, json, os, sys, urllib.request

src, out = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else "gemini-3-pro-image"
key = os.environ["GKEY"]

PROMPT = (
    "Transform this photograph of a surgeon in an operating room into a SUBTLE, "
    "ELEGANT illustrated artwork — a refined, hand-drawn line-and-light-wash "
    "illustration in a vintage engraving / editorial-illustration style. Keep the "
    "scene and composition recognizable (the surgeon at center, the dual surgical "
    "lights above, the O-arm imaging ring, monitors, and the tray of instruments in "
    "front) but render it entirely as a delicate ILLUSTRATION, not a photo: fine line "
    "work with soft, airy washes, gentle gradients, lots of light negative space. "
    "Use a calm TEAL brand palette — deep teal (#0e3737) line work with softer teal "
    "(#208080, #2cb1b1) washes on a near-white background. Low contrast, muted, "
    "premium and tasteful, so it reads as a faint AMBIENT BACKGROUND behind page "
    "text. No harsh shadows, no photographic realism, no text, no words, no logos, "
    "no watermark, no brand names on equipment. Soft, light, illustrated. Keep the "
    "original portrait/vertical framing."
)

with open(src, "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

mime = "image/webp" if src.endswith(".webp") else "image/png"
body = {
    "contents": [{"parts": [
        {"text": PROMPT},
        {"inlineData": {"mimeType": mime, "data": img_b64}},
    ]}],
    "generationConfig": {"responseModalities": ["IMAGE"]},
}

url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
req = urllib.request.Request(url, data=json.dumps(body).encode(),
                            headers={"Content-Type": "application/json"})
try:
    resp = json.load(urllib.request.urlopen(req, timeout=180))
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
