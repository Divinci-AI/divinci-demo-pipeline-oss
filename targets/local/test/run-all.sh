#!/usr/bin/env bash
# Every test for the local target. No network, no Ollama, no credentials.
set -uo pipefail
cd "$(dirname "$0")"
fail=0
run() { echo; echo "── $1 ──"; shift; "$@" || fail=1; }

run "crawler (unit)"                 node crawl.test.mjs
run "chunk + sync + session (unit)"  node pipeline.test.mjs

echo
[ $fail -eq 0 ] && echo "✅ all local-target tests passed" || { echo "❌ FAILURES"; exit 1; }
