#!/usr/bin/env bash
# One container run = one loop tick. Shared by targets/gcp and targets/aws.
set -euo pipefail

STATE_DIR="${STATE_DIR:-/app/state}"

# ── The state directory must be the mounted volume ──────────────────────────
#
# Every piece of loop state — each run's state.json, the attempt counters, the
# failure ledger — is a file. A container filesystem is discarded when the run
# ends, so a job on the image's own directory would start from nothing every
# tick: re-run gate 1 on prospects already past it, re-crawl sites already
# crawled, and re-spend the budget each time, reporting success every run.
#
# That failure is invisible from outside, which is why this is a hard refusal
# rather than a warning.
if ! mountpoint -q "$STATE_DIR" 2>/dev/null && [ "${ALLOW_EPHEMERAL_STATE:-0}" != "1" ]; then
  echo "❌ $STATE_DIR is not a mounted volume." >&2
  echo "   Loop state lives there and a container filesystem does not survive the" >&2
  echo "   run, so every tick would restart from zero and re-spend the budget." >&2
  echo "   Attach the volume (each target's deploy script does this), or set" >&2
  echo "   ALLOW_EPHEMERAL_STATE=1 if you genuinely want a stateless one-shot." >&2
  exit 78   # EX_CONFIG
fi

mkdir -p "$STATE_DIR/runs" "$STATE_DIR/home"

# The orchestrator derives its runs directory from its own location (/app), so
# point /app/runs at the volume rather than trying to configure it. A symlink
# keeps `runs/` free of anything that is not a run — `listen` and `metrics`
# enumerate that directory without filtering dotfiles, so the CLI's config could
# not simply live beside it.
ln -sfn "$STATE_DIR/runs" /app/runs

# ── The CLI session must live on the volume, not in the container ───────────
#
# The `divinci` CLI keeps its OAuth session at $HOME/.config/divinci and
# REWRITES it on every refresh, carrying a rotated refresh token forward. In a
# container that write would land on the ephemeral filesystem and be discarded —
# so the next tick would present the PREVIOUS refresh token, which rotation has
# already invalidated, and the loop would halt on auth within a day of being
# deployed. Putting HOME on the volume is what makes an unattended run possible
# at all.
export HOME="$STATE_DIR/home"
CREDS="$HOME/.config/divinci/credentials.json"

if [ ! -s "$CREDS" ]; then
  mkdir -p "$(dirname "$CREDS")"
  if [ -n "${DIVINCI_CREDENTIALS_JSON:-}" ]; then
    # Seeded ONLY when absent. Re-seeding every tick would overwrite the
    # rotated refresh token with the stale one from the secret, which is the
    # same failure as not persisting it at all.
    printf '%s' "$DIVINCI_CREDENTIALS_JSON" > "$CREDS"
    chmod 600 "$CREDS"
    echo "[auth] seeded the CLI session from DIVINCI_CREDENTIALS_JSON"
  elif [ -n "${DIVINCI_TOKEN:-}" ]; then
    # A bare access token cannot be refreshed. Accepted for a one-shot run, but
    # say so plainly: unattended, this halts the moment the token expires.
    printf '{"version":1,"defaultProfile":"default","profiles":{"default":{"apiUrl":"%s","authType":"oauth","accessToken":"%s"}}}' \
      "${DIVINCI_API_URL:-https://api.divinci.app}" "$DIVINCI_TOKEN" > "$CREDS"
    chmod 600 "$CREDS"
    echo "[auth] ⚠️  seeded from DIVINCI_TOKEN — a bare access token has no refresh" >&2
    echo "[auth] ⚠️  token, so this WILL halt when it expires. Use" >&2
    echo "[auth] ⚠️  DIVINCI_CREDENTIALS_JSON (the whole credentials.json) to run unattended." >&2
  fi
fi

# ── The run lock must not trust a pid from a previous container ─────────────
#
# `runs/.run.lock` records the holder's pid, and pids are namespaced per
# container — so a task killed mid-tick leaves a lock naming a pid the NEXT
# container may well also have (npm, node and tsx take several low numbers).
# Read naively, the new task sees its own unrelated process as the lock holder
# and refuses, forever, while reporting success every tick.
#
# The orchestrator only applies this age-based takeover to locks written by a
# DIFFERENT host, so a genuinely concurrent process is still respected. Keep it
# comfortably ABOVE the longest tick: too short recreates the two-writer
# corruption the lock exists to prevent.
export RUN_LOCK_MAX_AGE_MS="${RUN_LOCK_MAX_AGE_MS:-7200000}"   # 2h

echo "── tick $(date -u +%FT%TZ) ── state=$STATE_DIR"
cd /app/orchestrator

# The loop preflights its own authentication and exits 30 when only an
# interactive login can fix it. Surface that distinctly: the platform retries a
# failed run, and retrying a revoked refresh token just burns retries.
set +e
npm run loop
code=$?
set -e

if [ "$code" -eq 30 ]; then
  echo "❌ the Divinci session cannot be renewed — a human must run \`divinci auth login\`" >&2
  echo "   and refresh the DIVINCI_CREDENTIALS_JSON secret. Retrying will not fix this." >&2
fi
exit "$code"
