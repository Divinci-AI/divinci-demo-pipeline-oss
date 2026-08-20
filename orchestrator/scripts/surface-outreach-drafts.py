#!/usr/bin/env python3
"""
Put the outreach EMAIL DRAFT into the review-board card that asks you to send it.

    surface-outreach-drafts.py             # dry run — prints, writes nothing
    surface-outreach-drafts.py --apply
    surface-outreach-drafts.py --apply --include-done

WHY
===
The pipeline writes a finished, ready-to-send email to

    runs/<prospect>/<run>/outreach/email-draft.md

and files a review-board card that says "Send it. Nothing is sent automatically."
The card links the FILE PATH. So the person who has to act sees a path to a
markdown file in a repo, and the copy itself is invisible unless they open a
checkout.

Measured 2026-08-15: 72 finished drafts on disk, 51 cards waiting, and ZERO
emails ever sent — while 35 cards were bulk-closed on a single day without a
send. That is what an invisible handoff looks like. The drafts were not bad;
nobody could see them.

This does not send anything, and deliberately adds no capability that could.
It copies text the pipeline already wrote into the place it is already read.

MATCHING
========
Two strategies, exact only. A draft pasted into the WRONG prospect's card is
worse than no draft at all — it invites sending a personalised email to
somebody it was not written about — so anything ambiguous is skipped and
reported rather than guessed.

  1. The card description already contains `runs/<p>/<run>/outreach/...`.
     Exact, and the primary path.
  2. Older cards have no such reference: match the card's prospect name
     against `manifest.json`'s `prospectName`. That is the SAME string the
     card title was built from (run.ts interpolates it), so this is an
     identity check rather than a resemblance test.
  3. Last resort, an exact slug match on the run directory name.

Strategy 2 exists because slugs are lossy in both directions: the card
"Acmefacts.org (Dr. Dana Reyes)" slugs to `acmefactsorg` while
the directory is `acmenutrition`, and no amount of fuzzing that comparison is
safe when the cost of a wrong answer is a personalised email sent to the wrong
company. Reading the manifest removes the guesswork instead of tuning it.

IDEMPOTENCE
===========
Each write is fenced by a marker. Re-running updates the fenced block in place
rather than appending a second copy — the failure mode of an append-only
script is a card with the same email in it four times, which trains people to
stop reading the card.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys

BEGIN = "<!-- divinci:outreach-draft:begin -->"
END = "<!-- divinci:outreach-draft:end -->"
# No default, and specifically not the instance this pipeline was first built
# against — an unset variable must mean "not configured", never "somebody
# else's board". Same rule as orchestrator/src/require-env.ts.
BOARD = os.environ.get("REVIEW_BOARD_URL", "").strip()
DEFAULT_ROOT = pathlib.Path(__file__).resolve().parents[2]


def token() -> str:
    if os.environ.get("REVIEW_BOARD_TOKEN"):
        return os.environ["REVIEW_BOARD_TOKEN"]
    cfg = pathlib.Path.home() / ".review-board/cli.toml"
    if cfg.exists():
        m = re.search(r'token\s*=\s*"([^"]+)"', cfg.read_text())
        if m:
            return m.group(1)
    sys.exit("no review-board token (set REVIEW_BOARD_TOKEN or ~/.review-board/cli.toml)")


def api(method: str, path: str, body: dict | None = None) -> dict | list:
    # ⚠️ Task updates are PATCH. A PUT to the same URL returns 404 Not Found —
    # not 405 — so the wrong verb reads as "that task does not exist" and sends
    # you looking for a bad id or a permissions problem.
    # curl rather than urllib: macOS system python cannot do TLS 1.3 and
    # Cloudflare answers the default Python-urllib agent with a 403.
    cmd = [
        "curl", "-sS", "--max-time", "60", "-X", method, f"{BOARD}{path}",
        "-H", f"Authorization: Bearer {token()}",
        "-H", "Accept: application/json",
        "-A", "divinci-agent-session/1.0",
    ]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        sys.exit(f"non-JSON from {method} {path}: {out[:300]}")


def slug(name: str) -> str:
    """Prospect name -> the directory slug convention (lowercase alphanumerics)."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    ap.add_argument("--include-done", action="store_true",
                    help="also update DONE cards (default: open cards only)")
    ap.add_argument("--root", type=pathlib.Path, default=DEFAULT_ROOT)
    args = ap.parse_args()

    drafts: dict[tuple[str, str], pathlib.Path] = {}
    for f in args.root.glob("runs/*/*/outreach/email-draft.md"):
        drafts[(f.parts[-4], f.parts[-3])] = f
    by_prospect: dict[str, list[tuple[str, pathlib.Path]]] = {}
    for (p, run), f in drafts.items():
        by_prospect.setdefault(p, []).append((run, f))

    # prospectName (verbatim, as run.ts wrote it into the card title) -> drafts
    by_name: dict[str, list[tuple[str, pathlib.Path]]] = {}
    for (p, run), f in drafts.items():
        mf = f.parent.parent / "manifest.json"
        if not mf.exists():
            continue
        try:
            name = json.loads(mf.read_text()).get("prospectName")
        except Exception:
            continue
        if name:
            by_name.setdefault(name.strip(), []).append((run, f))

    tasks = api("GET", "/api/tasks?limit=300")
    tasks = tasks if isinstance(tasks, list) else tasks.get("tasks") or tasks.get("data") or []
    cards = [t for t in tasks if "[Outreach]" in str(t.get("title", ""))]
    if not args.include_done:
        cards = [t for t in cards if str(t.get("status")) != "DONE"]

    matched, skipped, unchanged, wrote = [], [], 0, 0

    for card in cards:
        desc = str(card.get("description") or "")
        title = str(card.get("title", ""))

        m = re.search(r"runs/([^/\s]+)/([^/\s]+)/outreach/email-draft\.md", desc)
        path = drafts.get((m.group(1), m.group(2))) if m else None

        if path is None:
            nm = re.search(r"\[Outreach\]\s*(.+?)\s*—\s*email \+ deck", title)
            name = nm.group(1).strip() if nm else ""
            # Identity on prospectName first, then the lossy slug. Multiple
            # RUNS for one prospect is fine — ids sort chronologically, so the
            # newest is the current draft — but two different prospects
            # resolving to one key is not, and cannot happen here because both
            # keys are exact.
            cand = by_name.get(name) or by_prospect.get(slug(name), [])
            if cand:
                path = sorted(cand)[-1][1]

        if path is None or not path.exists():
            skipped.append(title)
            continue

        body = path.read_text().strip()
        rel = path.relative_to(args.root)
        block = (
            f"{BEGIN}\n\n"
            f"### ✉️ The draft (from `{rel}`)\n\n"
            f"_Copy, review, send by hand. Nothing here is sent automatically, and nothing\n"
            f"in this pipeline can send. Re-run surface-outreach-drafts.py to refresh._\n\n"
            f"{body}\n\n"
            f"{END}"
        )

        if BEGIN in desc:
            new = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END), block, desc, flags=re.S)
        else:
            new = desc.rstrip() + "\n\n---\n\n" + block

        if new == desc:
            unchanged += 1
            continue

        matched.append((title, str(rel), len(body)))
        if args.apply:
            api("PATCH", f"/api/tasks/{card['id']}", {"description": new})
            wrote += 1

    print(f"drafts on disk: {len(drafts)}   outreach cards considered: {len(cards)}")
    print(f"{'WROTE' if args.apply else 'WOULD WRITE'}: {len(matched)}   "
          f"already current: {unchanged}   no draft found: {len(skipped)}")
    print()
    for t, rel, n in matched[:80]:
        print(f"  ✉️  {t[:62]:62} <- {rel}  ({n} chars)")
    if skipped:
        print("\n  no draft on disk (left alone):")
        for t in skipped[:20]:
            print(f"     - {t[:70]}")
    if not args.apply:
        print("\nDry run. Re-run with --apply to write.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
