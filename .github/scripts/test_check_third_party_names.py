#!/usr/bin/env python3
"""Mechanics tests for check-third-party-names.py.

These use INVENTED names hashed at runtime, never the real list — a test that
needed the real names in plaintext would reintroduce the leak the guard exists
to close.

What is pinned here is the behaviour the previous plaintext guard got wrong.
Each of the first four cases is a form that guard could not see, and each one
corresponds to real names that sat in a public repository while it passed.
"""
from __future__ import annotations
import hashlib, os, subprocess, sys, tempfile, unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-third-party-names.py"
FAKE = "Zorbatrix"            # 1 word
FAKE2 = "Quinlark Bio Systems"  # 3 words
FAKE4 = "Vellum For Special Cases"  # 4 words — unreachable at shingle width 3


def sha(name: str) -> str:
    norm = "".join(c.lower() for c in name if c.isalnum())
    return hashlib.sha256(norm.encode()).hexdigest()


class GuardCase(unittest.TestCase):
    def run_guard(self, content: str, deny: list[str] | None = None,
                  filename: str | None = "sample.md",
                  consent: list[str] | None = None):
        """Run the guard in a throwaway git repo containing one file."""
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / ".github" / "scripts").mkdir(parents=True)
            # The guard resolves its deny file relative to its own location, so
            # the script must be copied in rather than invoked from source.
            (d / ".github/scripts/check-third-party-names.py").write_text(
                SCRIPT.read_text())
            entries = ["# test fixture"] + (
                [sha(FAKE), sha(FAKE2), sha(FAKE4)] if deny is None else deny)
            (d / ".github/scripts/forbidden-names.sha256").write_text(
                "\n".join(entries) + "\n")
            (d / ".github/scripts/consented-names.sha256").write_text(
                "# test fixture\n"
                + "\n".join(f"2026-01-01  {h}  # consented" for h in (consent or []))
                + "\n")
            if filename is not None:
                (d / filename).write_text(content)
            env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                   "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
            subprocess.run(["git", "init", "-q"], cwd=d, check=True, env=env)
            subprocess.run(["git", "add", "-A"], cwd=d, check=True, env=env)
            return subprocess.run([sys.executable,
                                   ".github/scripts/check-third-party-names.py"],
                                  cwd=d, capture_output=True, text=True, env=env)

    # ── the four forms the plaintext guard could not see ──────────────────
    def test_case_is_irrelevant(self):
        for form in (FAKE.lower(), FAKE.upper(), FAKE, FAKE.swapcase()):
            with self.subTest(form=form):
                self.assertEqual(self.run_guard(f"const x = '{form}'").returncode, 1)

    def test_screaming_snake_constant(self):
        # `\b` does not fire against `_`; this is the form a test fixture takes.
        r = self.run_guard(f"const {FAKE.upper()}_SITE = 1;")
        self.assertEqual(r.returncode, 1)

    def test_camel_case_is_split(self):
        r = self.run_guard(f"const {FAKE[0].lower() + FAKE[1:]}Config = 2;")
        self.assertEqual(r.returncode, 1)

    def test_separators_are_irrelevant(self):
        for form in ("zorba-trix", "zorba_trix", "zorba.trix", "zorba/trix"):
            with self.subTest(form=form):
                # only meaningful if the pieces rejoin to the hashed name
                self.assertEqual(self.run_guard(form).returncode, 1)

    # ── multi-word names ──────────────────────────────────────────────────
    def test_three_word_name_in_prose(self):
        r = self.run_guard(f"// as seen on the {FAKE2} site")
        self.assertEqual(r.returncode, 1)

    def test_four_word_name(self):
        # Regression: at shingle width 3 this was unreachable, so a four-word
        # company name passed unless it happened to appear as one token.
        r = self.run_guard(f"// {FAKE4} said no")
        self.assertEqual(r.returncode, 1)

    # ── it must not fire on innocent text ─────────────────────────────────
    def test_clean_file_passes(self):
        r = self.run_guard("// nothing to see, an ordinary comment about vectors")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    # ── it must never print what it found ─────────────────────────────────
    def test_never_prints_the_name(self):
        r = self.run_guard(f"const x = '{FAKE}'")
        self.assertNotIn(FAKE.lower(), (r.stdout + r.stderr).lower())

    # ── it must fail, not pass, when it cannot do its job ─────────────────
    def test_empty_denylist_fails(self):
        r = self.run_guard("anything", deny=[])
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("vacuous", r.stdout + r.stderr)

    def test_scanning_nothing_fails(self):
        # A guard that is handed no files must not report success. Survived a
        # mutation run until this existed: the vacuity branch was claimed in a
        # commit message and tested by nothing.
        # NOTE: an image is no longer "nothing". Since the guard checks
        # FILENAMES it legitimately considers a .png, so the vacuous case is a
        # tree with no tracked files at all. The original version of this test
        # used a lone logo.png and stopped being about vacuity the moment
        # filename scanning landed.
        r = self.run_guard("", filename=None)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("scanned no files", r.stdout + r.stderr)

    def test_the_denyfile_itself_is_not_scanned(self):
        # else every hash in it would match itself and the guard is always red
        r = self.run_guard("// clean")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class ConsentAndFilenames(unittest.TestCase):
    """A brand featured on purpose must be nameable; nothing else changes."""

    def test_a_consented_shingle_is_allowed(self):
        r = GuardCase.run_guard(GuardCase(), f"we feature {FAKE} here",
                                consent=[sha(FAKE)])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_consent_does_not_leak_to_other_names(self):
        """Consenting one brand must not quietly permit a different one — the
        carve-out is per-shingle, not per-file."""
        r = GuardCase.run_guard(GuardCase(), f"and also {FAKE2}", consent=[sha(FAKE)])
        self.assertEqual(r.returncode, 1)

    def test_a_forbidden_name_in_a_FILENAME_is_caught(self):
        """The realistic image case: the brand is in the file name, and the
        guard cannot read pixels."""
        r = GuardCase.run_guard(GuardCase(), "no names in here",
                                filename=f"{FAKE.lower()}-demo.png")
        self.assertEqual(r.returncode, 1)
        self.assertIn("FILENAME", r.stdout + r.stderr)

    def test_a_consented_FILENAME_is_allowed(self):
        r = GuardCase.run_guard(GuardCase(), "no names in here",
                                filename=f"{FAKE.lower()}-demo.png", consent=[sha(FAKE)])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_a_missing_consent_file_consents_to_nothing(self):
        """Absent file must mean nothing is allowed, not everything."""
        r = GuardCase.run_guard(GuardCase(), f"const x = '{FAKE}'")
        self.assertEqual(r.returncode, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
