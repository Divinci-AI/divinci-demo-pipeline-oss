#!/usr/bin/env python3
"""Rewrite the live counts quoted in the README's Open Web Vectors alt text.

The image is a screenshot of a page whose numbers move every hour, and the
README repeats those numbers in the alt text — which is the only version of
them a screen reader ever gets. Until now the refresh script ended by printing
"Update the counts quoted in README.md to match", i.e. the accessible copy of
the figures was kept in step by remembering to. It was three months and about
14,000 sites out of date.

The six figures are computed here the same way the page computes them, from the
same unauthenticated request:

    GET https://api.divinci.app/api/v1/www-rag-directory

sites/pages/chunks/bytes are the response totals; "live chat endpoints" is the
number of returned sites carrying a releaseId, and the median is over the
returned sites' pageCount. That is `static/js/open-web-vectors.js` on the live
site, reimplemented — including its binary-units-labelled-GB byte format, which
is deliberate there so one corpus is not quoted two different sizes.

⚠️ This reads the API, not the PNG. Run it next to the capture (which is what
refresh.sh does) and the two agree to within the handful of sites indexed in
between. Run it a week later against last week's image and it will confidently
write numbers the picture does not show.

    ./readme-counts.py            # rewrite README.md in place
    ./readme-counts.py --check    # print live vs quoted, exit 1 if they differ
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.request

API_URL = "https://api.divinci.app/api/v1/www-rag-directory"
README = pathlib.Path(__file__).resolve().parents[2] / "README.md"

# The sentence this script owns, inside the alt text. Everything before "Live
# counts:" describes the picture and is written by a human; only the figures
# are derived, so only the figures are rewritten.
# ⚠️ NOT `[^.]*\.` — "4.5 GB" carries a full stop, so that form matched
# "Live counts: 2,588 sites indexed, … 4." and rewrote the README into
# nonsense while reporting success.
SENTENCE = re.compile(r"Live counts: .*? pages for the median site\.")


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def format_count(n) -> str:
    return f"{int(n):,}"


def format_bytes(n) -> str:
    """Binary units carrying decimal labels — matches the live page exactly."""
    value = float(n)
    units = ["B", "KB", "MB", "GB", "TB"]
    unit = 0
    while value >= 1024 and unit < len(units) - 1:
        value /= 1024
        unit += 1
    rounded = round(value) if value >= 10 or unit == 0 else round(value * 10) / 10
    if rounded == int(rounded):
        rounded = int(rounded)
    return f"{rounded:,} {units[unit]}"


def median_pages(sites: list[dict]):
    values = sorted(
        s["pageCount"] for s in sites if isinstance(s.get("pageCount"), (int, float))
    )
    if not values:
        return None
    mid = len(values) // 2
    if len(values) % 2:
        return values[mid]
    # Python rounds .5 to even; JS Math.round rounds .5 up. The two disagree on
    # exactly one corpus size in four, and the disagreement would show as a
    # phantom one-page drift in CI forever.
    return int((values[mid - 1] + values[mid]) / 2 + 0.5)


def sentence_from(data: dict) -> str:
    sites = data.get("sites") or []
    endpoints = sum(1 for s in sites if s.get("releaseId"))
    median = median_pages(sites)
    if not sites or median is None:
        raise SystemExit(
            "the directory API returned no sites — refusing to write a count "
            "sentence with two of its six figures missing"
        )
    return (
        "Live counts: "
        f"{format_count(data['totalSites'])} sites indexed, "
        f"{format_count(data['totalPages'])} pages crawled, "
        f"{format_count(data['totalChunks'])} chunks embedded, "
        f"{format_bytes(data['totalBytes'])} of extracted text, "
        f"{format_count(endpoints)} live chat endpoints, "
        f"{format_count(median)} pages for the median site."
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report drift, write nothing")
    args = ap.parse_args()

    text = README.read_text()
    found = SENTENCE.search(text)
    if not found:
        print("❌ no 'Live counts: …' sentence in README.md — has the alt text "
              "been rewritten? Update SENTENCE in this script.", file=sys.stderr)
        return 1

    live = sentence_from(fetch(API_URL))
    quoted = found.group(0)

    if args.check:
        print(f"quoted: {quoted}\n  live: {live}")
        if quoted == live:
            print("✅ in step")
            return 0
        print("⚠️  drifted — run ./refresh.sh to recapture the image and rewrite this")
        return 1

    if quoted == live:
        print("✅ counts already in step")
        return 0

    README.write_text(text[: found.start()] + live + text[found.end() :])
    print(f"✅ README counts updated\n   {live}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
