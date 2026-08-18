#!/usr/bin/env bash
#
# Install / remove the demo-loop LaunchAgents.
#
#   ./launchd/install.sh install     # load both agents (neither runs immediately)
#   ./launchd/install.sh status      # are they loaded? when did they last run?
#   ./launchd/install.sh test        # force ONE loop tick now and tail the log
#   ./launchd/install.sh uninstall
#
# ⚠️  TCC — read this before granting anything broad.
#
# This repo lives under ~/Documents, which macOS can protect, and a
# launchd-spawned process is NOT covered by the Terminal's own consent. The
# obvious-looking fix is to give /usr/local/bin/node Full Disk Access.
#
# MEASURED 2026-08-05 on this machine: it is NOT needed. A launchd-spawned
# /usr/local/bin/node could read this repo while being DENIED ~/Library/Safari
# (EPERM) and TCC.db (ENOENT) — i.e. it has no Full Disk Access and does not
# require it. Either ~/Documents is not protected against it here, or node
# already holds the narrow Documents-folder grant, which is the correct one.
#
# So: do NOT grant Full Disk Access reflexively. It would give every Node
# process on the machine read access to every protected file, to solve a
# problem this machine does not have. `install.sh test` runs a real tick
# through launchd and is the authority — if that works, TCC is not in the way.
#
# Only if a real tick fails with ENOENT/EPERM on files that plainly exist:
# System Settings → Privacy & Security → Files and Folders → give node the
# Documents folder (narrow), and only then Full Disk Access (broad).
#
# `test -r` is NOT a valid check for any of this: the permission bits allow the
# read while the privacy layer denies it, so it returns true and the later
# open() fails. The preflight below attempts a real read instead.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LABELS=(ai.divinci.demo-loop ai.divinci.demo-teardown)
LOG="$HOME/Library/Logs/divinci-demo-loop.log"

preflight() {
  local fail=0

  for label in "${LABELS[@]}"; do
    if ! plutil -lint "$REPO/launchd/$label.plist" >/dev/null; then
      echo "✗ $label.plist is not valid plist XML"
      fail=1
    fi
  done

  # Every absolute path named in the plists must exist — launchd reports a
  # missing binary as a bare non-zero exit with nothing in the log.
  for bin in /usr/local/bin/node "$REPO/orchestrator/node_modules/.bin/tsx"; do
    if [[ ! -x "$bin" ]]; then
      echo "✗ not executable: $bin"
      [[ "$bin" == *tsx ]] && echo "    run: (cd '$REPO/orchestrator' && npm install)"
      fail=1
    fi
  done

  # The pipeline shells out to these by bare name.
  for bin in claude divinci; do
    if ! PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" command -v "$bin" >/dev/null; then
      echo "✗ '$bin' is not on the PATH the agents use (~/.local/bin:/usr/local/bin:/usr/bin:/bin)"
      fail=1
    fi
  done

  # A REAL read, not `test -r` — see the TCC note above.
  if ! head -c 1 "$REPO/orchestrator/package.json" >/dev/null 2>&1; then
    echo "✗ cannot read the repo. Try the NARROW grant first: System Settings →"
    echo "    Privacy & Security → Files and Folders → node → Documents. See the header."
    fail=1
  fi

  # Deliberately NOT a warning about Full Disk Access — measured as unnecessary
  # here (see the header). A preflight that cries wolf about a broad permission
  # gets that permission granted, which is the outcome worth avoiding.
  if [[ "$REPO" == "$HOME/Documents/"* ]]; then
    echo "ℹ repo is under ~/Documents. A launchd tick was verified able to read it"
    echo "  WITHOUT Full Disk Access; if that ever changes, '$0 test' is what shows it."
  fi

  return $fail
}

case "${1:-}" in
  install)
    preflight || { echo; echo "preflight failed — not installing"; exit 1; }
    mkdir -p "$AGENTS_DIR"
    for label in "${LABELS[@]}"; do
      # COPY, do not symlink.
      #
      # Installed 2026-08-05 23:42 as symlinks into the repo; by 01:34 both
      # agents were gone from launchd — plists still valid, symlinks intact, no
      # reboot, and the one surviving agent on this machine
      # (review-board-credential-sync) is installed as a REAL FILE. launchd has a
      # long history of dropping symlinked plists out of ~/Library/LaunchAgents.
      #
      # That is a hypothesis, not a proven root cause — but a copy costs
      # nothing and removes the suspect. The tradeoff is real and deliberate:
      # editing the plist in the repo no longer takes effect until you re-run
      # `install.sh install`, which is more explicit anyway.
      # rm first: cp -f onto an existing SYMLINK-to-source is a no-op
      # ("are identical"), which would silently leave the symlink in place and
      # defeat the whole point of copying.
      #
      # The plists in the repo carry __REPO__/__HOME__ placeholders rather than
      # absolute paths, so they are checked in as a template that works for any
      # clone location and any user. Substitution happens HERE, on the copy —
      # which is the same reason the copy exists: what launchd loads is a
      # concrete artifact, and the repo keeps the portable source.
      rm -f "$AGENTS_DIR/$label.plist"
      sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
        "$REPO/launchd/$label.plist" > "$AGENTS_DIR/$label.plist"
      # A leftover placeholder means launchd would fail with a bare non-zero
      # exit and nothing in the log — catch it here instead.
      if grep -q "__REPO__\|__HOME__" "$AGENTS_DIR/$label.plist"; then
        echo "✗ $label.plist still contains an unsubstituted placeholder"
        rm -f "$AGENTS_DIR/$label.plist"
        exit 1
      fi
      plutil -lint "$AGENTS_DIR/$label.plist" >/dev/null
      launchctl bootout "gui/$UID/$label" 2>/dev/null || true
      launchctl bootstrap "gui/$UID" "$AGENTS_DIR/$label.plist"
      echo "✓ loaded $label"
    done
    echo
    echo "Neither agent runs at load, on purpose — loading them should not start"
    echo "crawling somebody's website. Run one tick first:  $0 test"
    ;;

  uninstall)
    for label in "${LABELS[@]}"; do
      launchctl bootout "gui/$UID/$label" 2>/dev/null || true
      rm -f "$AGENTS_DIR/$label.plist"
      echo "✓ removed $label"
    done
    ;;

  status)
    for label in "${LABELS[@]}"; do
      if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
        printf '%-28s loaded\n' "$label"
        launchctl print "gui/$UID/$label" | grep -E "last exit code|runs =" | sed 's/^/    /' || true
      else
        printf '%-28s NOT loaded\n' "$label"
      fi
    done
    echo
    if [[ -f "$REPO/runs/.loop-status.json" ]]; then
      echo "last tick:"
      sed 's/^/    /' "$REPO/runs/.loop-status.json"
    else
      echo "no tick has completed yet (runs/.loop-status.json absent)"
    fi
    ;;

  test)
    preflight || { echo; echo "preflight failed"; exit 1; }
    echo "forcing one tick…"
    launchctl kickstart -k "gui/$UID/ai.divinci.demo-loop"
    sleep 5
    echo "--- $LOG ---"
    tail -40 "$LOG" 2>/dev/null || echo "(no log yet — give it a moment and re-check)"
    ;;

  preflight)
    preflight && echo "✓ preflight passed"
    ;;

  *)
    sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
