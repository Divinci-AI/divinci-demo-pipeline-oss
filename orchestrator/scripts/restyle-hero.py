#!/usr/bin/env python3
"""Restyle a demo hero background image into the subtle, airy two-tone line-art
style used across the Customer Demo landing pages, via NanoBanana (Gemini image).

Usage:
  GKEY=... python3 restyle-hero.py <current-hero.png> <style-ref.png> <out.png> [model]
"""
import base64, json, os, sys, urllib.request

cur, ref, out = sys.argv[1], sys.argv[2], sys.argv[3]
model = sys.argv[4] if len(sys.argv) > 4 else "gemini-3-pro-image"
key = os.environ["GKEY"]

PROMPT = (
    "Recreate the FIRST image (a teal line-art hero background of spine-surgery "
    "instruments and motifs arranged as a wreath framing an open center) so that it "
    "matches the SUBTLE, AIRY, DELICATE illustration style of the SECOND image. "
    "Keep the exact same subject matter and the same teal / dark-teal brand color "
    "family from the first image — do NOT introduce coral, pink, blue, or warm tones. "
    "Make the strokes much THINNER, finer and more delicate; reduce the visual weight "
    "and contrast so it reads as a faint, faded AMBIENT BACKGROUND rather than a bold "
    "graphic. Use two close teal tints (a deeper #0e3737 and a softer #208080 / #2cb1b1) "
    "for gentle two-tone variation. Arrange the fine medical / spine motifs (spines, "
    "vertebrae, scalpels, forceps, endoscopes, screws, surgical tools) as a graceful "
    "elliptical WREATH that frames a LARGE OPEN, EMPTY near-white central space for "
    "headline text. No solid fills, no heavy shading, no human faces, no text, no words, "
    "no logos, no watermark. Light, airy, premium, tasteful. 16:9 landscape, near-white "
    "background clearly tinted in teal."
)

def part_img(path):
    with open(path, "rb") as f:
        return {"inlineData": {"mimeType": "image/png",
                               "data": base64.b64encode(f.read()).decode()}}

body = {
    "contents": [{"parts": [
        {"text": PROMPT},
        part_img(cur),
        part_img(ref),
    ]}],
    "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9"}},
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
        print("WROTE", out)
        sys.exit(0)
print("NO IMAGE PART", json.dumps(resp)[:600]); sys.exit(1)
