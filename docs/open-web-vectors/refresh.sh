#!/usr/bin/env bash
# Re-capture the README images from the live pages, and rewrite the counts the
# README quotes in their alt text.
#
# A screenshot goes stale — the corpus grows every day, and the counts in these
# images are the argument for contributing to it. This is here so refreshing
# them is a one-liner rather than an archaeology exercise, and it runs weekly
# from .github/workflows/refresh-open-web-vectors.yml.
#
# Needs a Cloudflare API token with Browser Rendering, which is the same
# capability targets/cloudflare uses to crawl:
#
#   CF_ACCOUNT_ID=... CF_BROWSER_TOKEN=... ./refresh.sh
#
# Optional: OWV_SETTLE_MS / UNIVERSE_SETTLE_MS override how long each page is
# given after load. See the note on the universe capture below.
set -uo pipefail
cd "$(dirname "$0")"

: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${CF_BROWSER_TOKEN:?set CF_BROWSER_TOKEN (needs Browser Rendering)}"

# 9s was enough for the text and the stat bar but not always for the hero
# illustration, which loads late — two captures on 2026-08-28 came back with
# an empty right half and nothing about them said so.
OWV_SETTLE_MS="${OWV_SETTLE_MS:-12000}"
UNIVERSE_SETTLE_MS="${UNIVERSE_SETTLE_MS:-20000}"

API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/browser-rendering/screenshot"
failed=0

# macOS has sips; a CI runner has ImageMagick. The script used to hardcode sips,
# which is why it could only ever be run from one laptop.
resize() {  # <infile> <outfile> <max-width>
  if command -v sips >/dev/null 2>&1; then
    sips -Z "$3" "$1" --out "$2" >/dev/null
  elif command -v magick >/dev/null 2>&1; then
    magick "$1" -resize "$3x$3>" "$2"
  elif command -v convert >/dev/null 2>&1; then
    convert "$1" -resize "$3x$3>" "$2"
  else
    echo "❌ need sips (macOS) or ImageMagick to resize" >&2
    return 1
  fi
}

dimensions() {  # <file> — best-effort, for the summary line only
  if command -v sips >/dev/null 2>&1; then
    sips -g pixelWidth -g pixelHeight "$1" | tail -2 | tr -d ' \n'
  elif command -v identify >/dev/null 2>&1; then
    identify -format '%wx%h' "$1"
  else
    echo "?"
  fi
}

shot() {  # <name> <json body>
  # Two attempts. The pages are behind a live API whose latency moves with the
  # corpus, so a timeout here is routine and is not evidence of a broken page.
  local attempt
  for attempt in 1 2; do
    curl -s -X POST "$API" -H "Authorization: Bearer $CF_BROWSER_TOKEN" \
         -H "Content-Type: application/json" -d "$2" -o "$1.raw.png" \
         -w "  attempt $attempt: %{http_code}  %{size_download} bytes  %{time_total}s\n"
    # The API returns JSON on failure and a PNG on success, both with HTTP 200
    # in some error modes — so check the magic bytes rather than the status.
    if file "$1.raw.png" | grep -q "PNG image"; then
      return 0
    fi
    echo "     not a PNG — $(head -c 200 "$1.raw.png")"
    rm -f "$1.raw.png"
  done
  return 1
}

# ⚠️ Each capture is attempted even if an earlier one fails, and the script
# exits non-zero at the end. It used to be `set -e` with the universe first, so
# on 2026-08-28 a universe timeout aborted the run BEFORE the Open Web Vectors
# capture — the image that carries the numbers, and the only reason to run this.
# A refresh that skips the thing being refreshed should not be one line of
# ordering away.

echo "── Open Web Vectors ──"
# ⚠️ NOT networkidle0. Both pages carry a live chat widget and a status poller,
# so the network never goes idle and navigation times out at 45s every time.
if shot open-web-vectors "{\"url\":\"https://divinci.ai/open-web-vectors/\",
  \"viewport\":{\"width\":1440,\"height\":1200,\"deviceScaleFactor\":2},
  \"gotoOptions\":{\"waitUntil\":\"domcontentloaded\",\"timeout\":45000},
  \"waitForTimeout\":$OWV_SETTLE_MS,
  \"selector\":\".owv-hero\",
  \"screenshotOptions\":{\"type\":\"png\"}}"; then
  # Captured by SELECTOR, not by a pixel crop.
  #
  # This used to be `sips -c 1240 2880 --cropOffset 300 0`, and that number was
  # secretly a function of how many lines the HEADLINE wrapped to. A rewrite on
  # 2026-08-20 took it from one line to four and pushed the live stat bar out of
  # frame — an image of the initiative with none of its numbers in it, produced
  # by a script that reported success. The next rewrite took it back to two
  # lines, which would have needed the number tuned a second time.
  #
  # `.owv-hero` is exactly the region this image should show: eyebrow, headline,
  # lead and the stat bar. Letting the element define the bounds means the copy
  # can change freely and the capture stays correct with no arithmetic.
  resize open-web-vectors.raw.png open-web-vectors.png 1760
  rm -f open-web-vectors.raw.png
else
  echo "  ❌ open-web-vectors: giving up; the committed image is unchanged"
  failed=1
fi

echo "── the RAG universe ──"
# OFF by default. Not because it is expensive — because a capture that
# SUCCEEDS here can still be worse than the image already committed.
#
# The graph is a force simulation and the wait is the difference between the
# settled map and a ring of un-laid-out dots. Cloudflare cuts the request at
# ~60s wall-clock, and the page's own load time grows with the corpus, so the
# settle budget shrinks as the thing being drawn gets bigger. Measured
# 2026-08-28 at ~16,900 sites: 8s and 20s both return a PNG, and both show an
# unsettled ring; 45s is refused outright. There is no value in this range that
# produces the committed image any more.
#
# So an unattended weekly job must not run it — it would quietly trade a good
# picture for a fresh bad one, which is the same failure as the pixel-crop
# capture that shipped an image of the initiative with none of its numbers in
# it. Run it by hand, LOOK at the result, and keep it only if it settled:
#
#   REFRESH_UNIVERSE=1 ./refresh.sh
if [ "${REFRESH_UNIVERSE:-0}" = "1" ]; then
  if shot rag-universe "{\"url\":\"https://divinci.ai/www-rag/\",
    \"viewport\":{\"width\":1600,\"height\":1000,\"deviceScaleFactor\":2},
    \"gotoOptions\":{\"waitUntil\":\"domcontentloaded\",\"timeout\":45000},
    \"waitForSelector\":{\"selector\":\"#www-rag-universe-canvas\",\"timeout\":30000},
    \"waitForTimeout\":$UNIVERSE_SETTLE_MS,
    \"selector\":\"#www-rag-universe-canvas\",
    \"screenshotOptions\":{\"type\":\"png\"}}"; then
    resize rag-universe.raw.png rag-universe.png 1760
    rm -f rag-universe.raw.png
    echo "  ⚠️  check the result before committing: a ring of evenly-spaced dots"
    echo "     means the simulation had not settled and the old image was better"
  else
    echo "  ❌ rag-universe: giving up; the committed image is unchanged"
    failed=1
  fi
else
  echo "  skipped (REFRESH_UNIVERSE=1 to attempt it — read the note above first)"
fi

echo "── README counts ──"
# The numbers in the alt text are the only version of them a screen reader
# gets. Deriving them removes the "remember to update the README" step that
# left them 14,000 sites out of date.
./readme-counts.py || failed=1

echo
echo "✅ refreshed:"
for f in open-web-vectors.png rag-universe.png; do
  echo "   $f  $(dimensions "$f")"
done

exit "$failed"
