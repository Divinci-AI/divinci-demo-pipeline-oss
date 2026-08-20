#!/usr/bin/env python3
"""Fail the build if a real third party is named anywhere in this repository.

WHY THIS IS HASHED AND NOT A LIST OF NAMES
------------------------------------------
The first version of this guard was a plaintext alternation in the CI workflow.
It named roughly thirty real health companies, two well-known physicians and a
security-research firm — in a PUBLIC repository, in a file whose stated purpose
was to stop this repository naming real companies. The guard was itself the
leak it was written to prevent, and it published the names permanently, in git
history, whether or not anything else in the tree ever mentioned them.

So the forbidden list is stored as sha256 of a NORMALISED name. A hash cannot
be reversed into a prospect list, the check still fails on an exact match, and
a violation is reported as `sha256[:12]` plus a file and line — never as the
name. Whoever fixes it can see the offending line in their own checkout.

WHY IT TOKENISES INSTEAD OF SUBSTRING-MATCHING
-----------------------------------------------
The plaintext guard missed 85 occurrences across 21 files of names it
explicitly listed. Three independent reasons, all of which this design removes:

  * It was case-SENSITIVE. `BIORENEW_A` and `EVONEXUS_SITE` are the natural
    form for a test fixture constant, and neither matched a pattern spelling
    them `BioRenew` and `evonexus`.
  * It used `\\b`, which does not fire against `_`. `EVONEXUS_SITE` has no word
    boundary after the name at all.
  * Its list was assembled from names somebody happened to notice while
    reading, not from the authoritative set. `aurapath` (39 hits) and `mach33`
    (22) were never in it.

Normalising to lowercase alphanumerics and comparing whole shingles makes the
first two structurally impossible. The third is a curation problem, addressed
by generating entries with `--add` from the authoritative source rather than
from memory.

USAGE
  check-third-party-names.py                 # scan tracked files, exit 1 on a hit
  check-third-party-names.py --add "Some Co" # print the hash line to append
"""
from __future__ import annotations
import hashlib, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DENY_FILE = HERE / "forbidden-names.sha256"
MAX_SHINGLE = 3
CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
NONALNUM = re.compile(r"[^A-Za-z0-9]+")


def pieces(text: str) -> list[str]:
    """Split text into lowercase alphanumeric pieces, breaking camelCase too.

    `EVONEXUS_SITE` -> ['evonexus', 'site'];  `BioRenewIM` -> ['bio','renew','im'].
    """
    out: list[str] = []
    for raw in NONALNUM.split(text):
        if not raw:
            continue
        out.extend(p.lower() for p in CAMEL.split(raw) if p)
    return out


def shingles(ps: list[str]) -> set[str]:
    """All runs of 1..MAX_SHINGLE consecutive pieces, concatenated.

    'Applied BioCode' -> pieces [applied, bio, code] -> includes 'appliedbiocode',
    so a two-word company name is caught without listing every spelling of it.
    """
    out: set[str] = set()
    for n in range(1, MAX_SHINGLE + 1):
        for i in range(len(ps) - n + 1):
            out.add("".join(ps[i : i + n]))
    return out


def normalise(name: str) -> str:
    return "".join(pieces(name))


def digest(name: str) -> str:
    return hashlib.sha256(normalise(name).encode()).hexdigest()


def load_deny() -> set[str]:
    if not DENY_FILE.exists():
        sys.exit(f"missing {DENY_FILE}")
    out = set()
    for line in DENY_FILE.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            out.add(line)
    if not out:
        sys.exit(f"{DENY_FILE} lists no hashes — the guard would pass vacuously")
    return out


def tracked_files() -> list[str]:
    r = subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True, check=True)
    return [f for f in r.stdout.split("\0") if f]


SKIP_SUFFIX = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
               ".ttf", ".otf", ".pdf", ".zip", ".mp4", ".sha256")


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--add":
        for n in sys.argv[2:]:
            print(f"{digest(n)}")
        return 0

    deny = load_deny()
    self_rel = str(Path(__file__).resolve())
    hits: list[tuple[str, int, str]] = []
    scanned = 0
    for f in tracked_files():
        if f.endswith(SKIP_SUFFIX) or str(Path(f).resolve()) == self_rel:
            continue
        try:
            text = Path(f).read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        scanned += 1
        for lineno, line in enumerate(text.splitlines(), 1):
            for sh in shingles(pieces(line)):
                h = hashlib.sha256(sh.encode()).hexdigest()
                if h in deny:
                    hits.append((f, lineno, h[:12]))
                    break
    if scanned == 0:
        print("::error::scanned no files — the guard passed without checking anything")
        return 1
    if hits:
        print(f"::error::{len(hits)} line(s) name a real third party. "
              "Rename to an acme-* fixture; the hash identifies which entry matched.")
        for f, lineno, h in hits:
            print(f"  {f}:{lineno}  (forbidden-name {h})")
        return 1
    print(f"ok — {scanned} files, no forbidden name in {len(deny)} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
