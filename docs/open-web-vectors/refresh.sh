#!/usr/bin/env bash
# Re-capture the README images from the live pages.
#
# A screenshot goes stale — the corpus grows every day, and the counts in these
# images are the argument for contributing to it. This is here so refreshing
# them is a one-liner rather than an archaeology exercise.
#
# Needs a Cloudflare API token with Browser Rendering, which is the same
# capability targets/cloudflare uses to crawl:
#
#   CF_ACCOUNT_ID=... CF_BROWSER_TOKEN=... ./refresh.sh
set -euo pipefail
cd "$(dirname "$0")"

: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${CF_BROWSER_TOKEN:?set CF_BROWSER_TOKEN (needs Browser Rendering)}"

API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/browser-rendering/screenshot"

shot() {  # <outfile> <json body>
  curl -s -X POST "$API" -H "Authorization: Bearer $CF_BROWSER_TOKEN" \
       -H "Content-Type: application/json" -d "$2" -o "$1.raw.png" \
       -w "  %{http_code}  %{size_download} bytes\n"
  # The API returns JSON on failure and a PNG on success, both with HTTP 200
  # in some error modes — so check the magic bytes rather than the status.
  if ! file "$1.raw.png" | grep -q "PNG image"; then
    echo "❌ $1: not a PNG —" && head -c 300 "$1.raw.png" && echo && rm -f "$1.raw.png" && return 1
  fi
}

echo "── the RAG universe ──"
shot rag-universe '{"url":"https://divinci.ai/www-rag/",
  "viewport":{"width":1600,"height":1000,"deviceScaleFactor":2},
  "gotoOptions":{"waitUntil":"domcontentloaded","timeout":45000},
  "waitForSelector":{"selector":"#www-rag-universe-canvas","timeout":30000},
  "waitForTimeout":20000,
  "selector":"#www-rag-universe-canvas",
  "screenshotOptions":{"type":"png"}}'
sips -Z 1760 rag-universe.raw.png --out rag-universe.png >/dev/null
rm -f rag-universe.raw.png

echo "── Open Web Vectors ──"
# ⚠️ NOT networkidle0. Both pages carry a live chat widget and a status poller,
# so the network never goes idle and navigation times out at 45s every time.
shot open-web-vectors '{"url":"https://divinci.ai/open-web-vectors/",
  "viewport":{"width":1440,"height":1200,"deviceScaleFactor":2},
  "gotoOptions":{"waitUntil":"domcontentloaded","timeout":45000},
  "waitForTimeout":9000,
  "selector":".owv-hero",
  "screenshotOptions":{"type":"png"}}'
# Captured by SELECTOR, not by a pixel crop.
#
# This used to be `sips -c 1240 2880 --cropOffset 300 0`, and that number was
# secretly a function of how many lines the HEADLINE wrapped to. A rewrite on
# 2026-08-20 took it from one line to four and pushed the live stat bar out of
# frame — an image of the initiative with none of its numbers in it, produced by
# a script that reported success. The next rewrite took it back to two lines,
# which would have needed the number tuned a second time.
#
# `.owv-hero` is exactly the region this image should show: eyebrow, headline,
# lead and the stat bar. Letting the element define the bounds means the copy
# can change freely and the capture stays correct with no arithmetic.
sips -Z 1760 open-web-vectors.raw.png --out open-web-vectors.png >/dev/null
rm -f open-web-vectors.raw.png

echo
echo "✅ refreshed:"
for f in rag-universe.png open-web-vectors.png; do
  echo "   $f  $(sips -g pixelWidth -g pixelHeight "$f" | tail -2 | tr -d ' \n')"
done
echo "   Update the counts quoted in README.md to match."
