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

# ⚠️ Strip whitespace. A token that arrives with a trailing newline — from
# `pbpaste > file`, from a copied line, from `gh secret set < file` — produces
# a malformed Authorization header, and Cloudflare answers that with the SAME
# `10000 Authentication error` it uses for a token that lacks the permission.
# One of those is a typo and the other is a dashboard trip; do not let a stray
# byte masquerade as the second.
CF_BROWSER_TOKEN="$(printf '%s' "$CF_BROWSER_TOKEN" | tr -d '[:space:]')"
CF_ACCOUNT_ID="$(printf '%s' "$CF_ACCOUNT_ID" | tr -d '[:space:]')"

# Settle time AFTER `load` has fired, so this is a small top-up rather than a
# guess at the whole page. See the waitUntil note on the capture below.
OWV_SETTLE_MS="${OWV_SETTLE_MS:-6000}"
UNIVERSE_SETTLE_MS="${UNIVERSE_SETTLE_MS:-20000}"

API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/browser-rendering/screenshot"
failed=0
captured_owv=0

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
    echo "❌ need sips (macOS) or ImageMagick to resize —" >&2
    echo "   on a runner: sudo apt-get install -y imagemagick" >&2
    return 1
  fi
}

checksum() {  # <file> — "" when it does not exist yet
  [ -f "$1" ] || return 0
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d" " -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d" " -f1
  else wc -c < "$1"  # weaker, but a resize that fails leaves the size identical
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
#
# `load` IS safe, and better than the `domcontentloaded` + long-guess this used
# to do: it waits for the stylesheets and fonts specifically. A capture from a
# cold runner on 2026-08-29 fell back to system fonts and re-wrapped the
# headline to three lines — a picture of the page that nobody visiting the page
# would recognise. Waiting on the resources costs ~8s total instead of ~16s.
if shot open-web-vectors "{\"url\":\"https://divinci.ai/open-web-vectors/\",
  \"viewport\":{\"width\":1440,\"height\":1200,\"deviceScaleFactor\":2},
  \"gotoOptions\":{\"waitUntil\":\"load\",\"timeout\":45000},
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
  # ⚠️ The gate is "the image on disk changed", NOT "the request returned a
  # PNG". Those came apart on the first green CI run: the capture succeeded,
  # `resize` then failed (ubuntu-latest ships no ImageMagick), its exit status
  # was ignored, the raw was deleted, the OLD png stayed — and the counts were
  # rewritten on top of it. The job exited 0 and opened a PR whose alt text
  # said 17,139 over a picture that said 16,942.
  #
  # Every future variant of that — a resize tool that writes a truncated file,
  # a permissions problem, a tool that silently no-ops — fails here too,
  # because this checks the artifact rather than the steps that produce it.
  # ⚠️ The hero robot is `loading="lazy"` in the page markup, and it is ABOVE
  # THE FOLD, so whether headless Chrome has fetched it by capture time is a
  # coin flip — observed present and absent across identical requests, with the
  # asset itself serving 200/36KB every time. Neither a longer settle nor
  # `scrollPage` fixes it; the durable fix is `loading="eager"` on that <img>,
  # in the site repo. Until then: LOOK at the picture. A hero with an empty
  # right half is a valid PNG, correctly sized, with the right numbers in it —
  # which is exactly the kind of wrong no check here can see.
  before="$(checksum open-web-vectors.png)"
  if resize open-web-vectors.raw.png open-web-vectors.png 1760 &&
     [ -s open-web-vectors.png ] &&
     [ "$(checksum open-web-vectors.png)" != "$before" ]; then
    captured_owv=1
    rm -f open-web-vectors.raw.png
  else
    echo "  ❌ the capture arrived but open-web-vectors.png did not change —"
    echo "     the resize step failed or wrote nothing. The raw capture is kept"
    echo "     at open-web-vectors.raw.png."
    failed=1
  fi
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
#
# ⚠️ Only when the capture landed. The counts come from the API and the image
# comes from the browser, so rewriting them independently is how you get a PR
# whose alt text says 16,942 over a picture that says 2,588 — the exact drift
# this script exists to close, restated as a caption that lies about the image
# directly beneath it. The first CI run did this: a 401 on the screenshot, and
# it went on to update the counts anyway.
if [ "$captured_owv" = "1" ]; then
  ./readme-counts.py || failed=1
else
  echo "  skipped — the capture failed, so the committed image still shows the"
  echo "  committed numbers. Rewriting them now would caption the OLD picture"
  echo "  with TODAY's figures."
fi

echo
# "✅ refreshed" printed unconditionally, under a run where every capture had
# failed. The summary has to report the outcome, not the intention.
if [ "$failed" = "0" ]; then
  echo "✅ refreshed:"
else
  echo "⚠️  finished with failures — the images on disk are:"
fi
for f in open-web-vectors.png rag-universe.png; do
  echo "   $f  $(dimensions "$f")"
done

exit "$failed"
