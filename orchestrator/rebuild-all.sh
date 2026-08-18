#!/bin/bash
# Sequential — parallel landing builds share the template clone cache and the
# same wrangler credentials, and a failed deploy in one must not poison another.
cd "$(dirname "$0")"
for pair in \
  "backincontrol 2026-08-07-001" \
  "drwilliamli 2026-06-15-001" \
  "evonexus 2026-08-05-001" \
  "mdspinecare 2026-08-07-001" \
  "northcountywindowtinting 2026-08-13-001" \
  "orthocarolina 2026-08-07-001" \
  "salesbox 2026-08-14-001" \
  "spaceflight-now 2026-08-07-001" \
  "technicalservicesofhawaii 2026-08-11-001" \
  "terrywahls 2026-08-07-001"
do
  set -- $pair
  echo "=== $1 ($2) $(date +%H:%M:%S)"
  ONLY_STEPS=landing LANDING_FORCE=1 npm run demo -- --prospect "$1" --run "$2" 2>&1 \
    | grep -E "deployed https|lockup \[|Error|error:|✖|did not" || echo "  (no marker — check the run)"
done
echo "=== ALL DONE $(date +%H:%M:%S)"
