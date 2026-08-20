#!/usr/bin/env bash
# Feed hosts to the pipeline, with the guards a hand-rolled curl does not carry.
#
#   ./run-batch.sh example.com                # dry run: show what WOULD be sent
#   ./run-batch.sh --go example.com other.org # send them
#   ./run-batch.sh --go -n 6 -f hosts.txt     # send 6 from a file
#
# Required:
#   PIPELINE_URL     https://<worker>.<your-subdomain>.workers.dev
#   TRIGGER_TOKEN    the bearer you set with `wrangler secret put TRIGGER_TOKEN`
#
# Both are read from the environment with NO default. A default here would
# point your batch at somebody else's Worker.
set -uo pipefail
cd "$(dirname "$0")"

: "${PIPELINE_URL:?set PIPELINE_URL to the Worker URL, e.g. https://www-rag-pipeline.you.workers.dev}"
: "${TRIGGER_TOKEN:?set TRIGGER_TOKEN to the bearer configured with: wrangler secret put TRIGGER_TOKEN}"

LIMIT="${CRAWL_LIMIT:-100}"
N=4
GO=0
HOSTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;;
    -n) shift; N="$1" ;;
    -f) shift; while IFS= read -r h; do
          h="${h%%#*}"; h="$(echo "$h" | tr -d '[:space:]')"
          [ -n "$h" ] && HOSTS+=("$h")
        done < "$1" ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) HOSTS+=("$1") ;;
  esac
  shift
done

[ ${#HOSTS[@]} -eq 0 ] && { echo "no hosts given — pass them as arguments or with -f <file>"; exit 2; }

# ⚠️ Exclude hosts sent recently. A host that is MID-RUN is not published yet
# (registration is the last step), so any "is it already done?" check happily
# re-offers it — and sending it twice produces two vectors and two releases for
# one site. Caught on the first real batch upstream: archive.org was mid-crawl
# and still showed up as a fresh candidate.
SENTLOG="${SENT_LOG:-.sent-log}"
touch "$SENTLOG"
CUTOFF=$(( $(date +%s) - ${SENT_TTL:-5400} ))
INFLIGHT=$(awk -v c="$CUTOFF" '$1 > c { print $2 }' "$SENTLOG" | sort -u)

SEND=()
for h in "${HOSTS[@]}"; do
  [ ${#SEND[@]} -ge "$N" ] && break
  if echo "$INFLIGHT" | grep -qx "$h"; then
    printf "  ⏭  %-32s %s\n" "$h" "sent recently — may still be in flight"
    continue
  fi
  SEND+=("$h")
  printf "  ✅ %-32s %s\n" "$h" "will send"
done

echo
echo "batch: ${#SEND[@]} host(s), limit=$LIMIT → $PIPELINE_URL"
[ ${#SEND[@]} -eq 0 ] && { echo "nothing to send"; exit 0; }
if [ "$GO" -ne 1 ]; then
  echo "(dry run — pass --go to send)"
  printf '  %s\n' "${SEND[@]}"
  exit 0
fi

# The Worker gates AI rights itself before spending browser-seconds; there is
# no second gate here on purpose, so the two cannot disagree about a host.
BODY=$(python3 -c "
import json,sys
print(json.dumps({'hosts': sys.argv[2:], 'limit': int(sys.argv[1]), 'publish': True}))
" "$LIMIT" "${SEND[@]}")

RESP=$(curl -s -X POST "$PIPELINE_URL/run" \
  -H "Authorization: Bearer $TRIGGER_TOKEN" \
  -H "Content-Type: application/json" -d "$BODY")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"

# Record the send BEFORE trusting anything downstream, so a re-run cannot
# re-offer a host that is still mid-crawl.
NOW=$(date +%s)
for h in "${SEND[@]}"; do echo "$NOW $h" >> "$SENTLOG"; done
