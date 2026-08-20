#!/usr/bin/env bash
# Every test for the Cloudflare target. No network, no credentials, no account.
#
#   ./targets/cloudflare/test/run-all.sh
set -uo pipefail
cd "$(dirname "$0")"
fail=0
run() { echo; echo "── $1 ──"; shift; "$@" || fail=1; }

run "configuration guard (unit)"    node require-env.test.mjs
run "no account defaults (unit)"    node no-account-defaults.test.mjs
run "AI-rights gate (unit)"         node ai-rights.test.mjs
run "directory authority (unit)"    node directory.test.mjs
run "takedown contract (struct)"    node takedown-contract.test.mjs
run "chunker (unit)"                node chunk.test.mjs
run "coalescing (unit)"             node coalesce.test.mjs
run "release body + HMAC (unit)"    node release.test.mjs
run "crawl budget (unit)"           node crawl-budget.test.mjs
run "frontier (unit)"               node frontier.test.mjs
run "activity feed (unit)"          node activity.test.mjs
run "queue submission (unit)"       node submit.test.mjs
run "withdrawal (unit)"             node withdraw.test.mjs

echo
[ $fail -eq 0 ] && echo "✅ all Cloudflare-target tests passed" || { echo "❌ FAILURES"; exit 1; }
