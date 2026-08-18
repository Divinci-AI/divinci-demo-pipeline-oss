#!/usr/bin/env bash
# Roll the bespoke-per-locale design out to every demo run: copy the per-locale
# embed route, translate the foundation into all 36 locales, rebuild, splice,
# and redeploy. Resumable (skips existing locale foundations). Requires GKEY.
#
# Usage: GKEY=... ./rollout-bespoke-locales.sh <demo1> <demo2> ...
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ORCH=$REPO/orchestrator
# The landing template is a SEPARATE repository, cloned per run — it is not
# vendored here. Point LANDING_TEMPLATE_DIR at your checkout of it; the default
# assumes a sibling clone next to this repo.
LANDING_TEMPLATE_DIR="${LANDING_TEMPLATE_DIR:-$(dirname "$REPO")/divinci-landing-template}"
TEMPLATE_EMBED="$LANDING_TEMPLATE_DIR/src/pages/[lang]/embed.astro"
if [[ ! -f "$TEMPLATE_EMBED" ]]; then
  echo "✗ landing template not found at $TEMPLATE_EMBED" >&2
  echo "  set LANDING_TEMPLATE_DIR to your checkout of divinci-landing-template" >&2
  exit 1
fi
: "${GKEY:?need GKEY}"

# 35 non-English locales (code name) — name passed to the translator.
LOCS=(
"es Spanish" "fr French" "de German" "it Italian" "pt Portuguese" "nl Dutch"
"pl Polish" "ru Russian" "uk Ukrainian" "cs Czech" "ro Romanian" "el Greek"
"tr Turkish" "ar Arabic" "he Hebrew" "hi Hindi" "bn Bengali" "ta Tamil"
"te Telugu" "mr Marathi" "gu Gujarati" "pa Punjabi" "ur Urdu" "fa Persian"
"th Thai" "vi Vietnamese" "id Indonesian" "ms Malay" "fil Filipino"
"ja Japanese" "ko Korean" "zh-hans Chinese(Simplified)"
"zh-hant Chinese(Traditional)" "sw Swahili" "zu Zulu"
)

translate_one() { # $1=foundation $2=outdir $3="code name"
  local code name out
  code=${3%% *}; name=${3#* }; out=$2/$code.html
  [ -f "$out" ] && { echo "  skip $code"; return; }
  node "$ORCH/scripts/translate-foundation.mjs" "$1" "$name" "$out" >/dev/null 2>&1 \
    && echo "  ok   $code" || echo "  FAIL $code"
}
export -f translate_one; export ORCH

for demo in "$@"; do
  dir=$(ls -d $REPO/runs/$demo/*/landing 2>/dev/null | head -1)
  [ -z "$dir" ] && { echo "[$demo] NO landing dir — skip"; continue; }
  F=$dir/foundation.html; D=$dir/locale-foundations; SITE=$dir/site
  [ -f "$F" ] || { echo "[$demo] no foundation.html — skip"; continue; }
  echo "=== [$demo] $dir ==="
  mkdir -p "$D"
  cp "$TEMPLATE_EMBED" "$SITE/src/pages/[lang]/embed.astro"

  echo "[$demo] translating 35 locales (parallel)…"
  printf '%s\n' "${LOCS[@]}" | GKEY="$GKEY" xargs -P 5 -I{} bash -c 'translate_one "$0" "$1" "{}"' "$F" "$D"
  have=$(ls "$D"/*.html 2>/dev/null | wc -l | tr -d ' ')
  echo "[$demo] locale foundations: $have/35"

  echo "[$demo] building…"
  ( cd "$SITE" && npm run build >/dev/null 2>&1 ) || { echo "[$demo] BUILD FAILED — skip deploy"; continue; }

  node "$ORCH/scripts/splice-locale-dist.mjs" "$dir" | sed "s/^/[$demo] /"

  echo "[$demo] deploying…"
  ( cd "$SITE" && unset CLOUDFLARE_API_TOKEN CLOUDFLARE_EMAIL CLOUDFLARE_ACCOUNT_ID && \
    npx wrangler deploy </dev/null 2>&1 | grep -E "Current Version ID|Uploaded|error|Error" | sed "s/^/[$demo] /" ) \
    || echo "[$demo] DEPLOY FAILED"
  echo "[$demo] DONE"
done
echo "ALL DEMOS COMPLETE"
