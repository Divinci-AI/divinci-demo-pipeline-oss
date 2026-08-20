#!/usr/bin/env python3
"""Regenerate the acmespineco hero: a single large circular surgical light
filling the frame with Dr. Robin Cole standing in front of it, rendered as the
subtle teal illustration. Uses the original OR source photo (accurate likeness
of Dr. Kim) as the input reference.

GKEY=... python3 regen-hero-kim.py <source.webp> <out.png> [model]
"""
import base64, json, os, sys, urllib.request

src, out = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else "gemini-3-pro-image"
key = os.environ["GKEY"]

PROMPT = (
    "Using the surgeon in this operating-room photo as the accurate likeness "
    "reference for the man, create a NEW composition: ONE single large circular "
    "surgical operating light (the round multi-lens OR lamp) that FILLS the entire "
    "frame as the dominant background element, with that same surgeon — Dr. Choll "
    "Kim, an Asian man in dark surgical scrubs — standing in front of and centered "
    "below the big circular light, facing forward. Render the whole thing as a "
    "SUBTLE, ELEGANT illustration in a refined line-and-light-wash style — NOT a "
    "photograph: delicate fine line work with soft airy washes, low contrast, lots "
    "of light. Use a calm TEAL brand palette — deep teal (#0e3737) line work with "
    "softer teal (#208080, #2cb1b1) washes on a near-white background. Keep his face "
    "recognizable and true to the reference. The single round light's concentric "
    "lens pattern should be a graceful, faint motif filling the frame. Premium, "
    "tasteful, ambient — it reads as a faint background behind page text. No harsh "
    "shadows, no photographic realism, no text, no words, no logos, no watermark, no "
    "brand names. Portrait / vertical framing."
)

with open(src, "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()
mime = "image/webp" if src.endswith(".webp") else "image/png"

body = {
    "contents": [{"parts": [{"text": PROMPT}, {"inlineData": {"mimeType": mime, "data": img_b64}}]}],
    "generationConfig": {"responseModalities": ["IMAGE"]},
}
url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
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
