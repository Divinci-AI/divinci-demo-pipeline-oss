#!/bin/bash
# Roll translations (+ v4 code refinements already in foundation.html) to all
# non-excelspine demos: translate → register → build → overwrite root → deploy.
# Requires GKEY in env.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNS="$REPO/runs"
TR="$REPO/orchestrator/scripts/translate-locales.mjs"
DEMOS="amymyersmd:2026-06-15-001 backincontrol:2026-06-15-001 caseymeans:2026-06-15-001 centenoschultz:2026-06-15-001 discsportsspine:2026-06-15-001 drchatterjee:2026-06-15-001 drhyman:2026-06-15-001 drvondawright:2026-06-15-001 drwilliamli:2026-06-15-001 mdspinecare:2026-06-10-001 nutritionfacts:2026-06-15-001 peterattiamd:2026-06-15-001 stoneclinic:2026-06-14-001 texasback:2026-06-15-001"

for pr in $DEMOS; do
  p=${pr%%:*}; run=${pr##*:}
  L="$RUNS/$p/$run/landing"; S="$L/site"
  echo "═══════════ $p ═══════════"
  if [ ! -f "$S/src/i18n/ui/en.ts" ]; then echo "  ✗ no en.ts, skip"; continue; fi
  # 1. translate + auto-register
  node "$TR" "$S" </dev/null 2>&1 | grep -E "Translated|Registered|All ok|✗ "
  # 2. build (astro)
  if ( cd "$S" && npm run build </dev/null >/tmp/roll-$p.log 2>&1 ); then echo "  build ✓"; else echo "  build ✗"; tail -6 /tmp/roll-$p.log; continue; fi
  # 3. overwrite root with bespoke foundation
  cp "$L/foundation.html" "$S/dist/index.html"
  # 4. deploy
  if ( cd "$S" && env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_EMAIL -u CLOUDFLARE_ACCOUNT_ID npx --yes wrangler deploy </dev/null 2>&1 | grep -qE "Deployed demo-" ); then echo "  ✓✓ $p DEPLOYED"; else echo "  ✗ $p deploy failed"; fi
done
echo "═══ ROLLOUT COMPLETE ═══"
