#!/usr/bin/env bash
# One Cloud Run Job execution = one loop tick.
set -euo pipefail

RUNS_DIR="${RUNS_DIR:-/app/runs}"

# ── The state directory must be the GCS mount ────────────────────────────────
#
# Every piece of loop state — each run's state.json, the attempt counters, the
# failure ledger — is a file under runs/. A container filesystem is discarded
# when the execution ends, so a job running on the image's own /app/runs would
# start from nothing every tick: it would re-run gate-1 on prospects already
# past it, re-crawl sites already crawled, and re-spend the budget each time,
# reporting success every single run.
#
# That failure is invisible from the outside, which is why this is a hard
# refusal and not a warning.
if ! mountpoint -q "$RUNS_DIR" 2>/dev/null && [ "${ALLOW_EPHEMERAL_STATE:-0}" != "1" ]; then
  echo "❌ $RUNS_DIR is not a mounted volume." >&2
  echo "   Loop state lives there and a container filesystem does not survive the" >&2
  echo "   execution, so every tick would restart from zero and re-spend the budget." >&2
  echo "   Attach the GCS volume (deploy.sh does this), or set" >&2
  echo "   ALLOW_EPHEMERAL_STATE=1 if you genuinely want a stateless one-shot." >&2
  exit 78   # EX_CONFIG
fi

echo "── tick $(date -u +%FT%TZ) ── runs=$RUNS_DIR"
cd /app/orchestrator

# The loop preflights its own authentication and exits 30 when only an
# interactive login can fix it. Surface that distinctly: Cloud Run retries a
# failed execution, and retrying a revoked refresh token just burns retries.
set +e
npm run loop
code=$?
set -e

if [ "$code" -eq 30 ]; then
  echo "❌ the Divinci session cannot be renewed — a human must run \`divinci auth login\`" >&2
  echo "   and refresh the DIVINCI_TOKEN secret. Retrying will not fix this." >&2
fi
exit "$code"
