#!/usr/bin/env python3
"""Mechanics of readme-counts.py. No network, no credentials.

This tests the half that fails silently. The script rewrites a sentence in the
README by regex and derives six figures with formulas copied from the live
page's JavaScript — so both failure modes are "produces a plausible sentence
that is wrong", which nothing downstream would catch.

Every case here is a form that has already been got wrong once.
"""
import importlib.util
import pathlib
import re
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("readme_counts", HERE / "readme-counts.py")
rc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rc)


class TheSentencePattern(unittest.TestCase):
    def test_it_matches_the_sentence_in_the_committed_README(self):
        # The script's only anchor into the README. If the alt text is
        # rewritten without updating the pattern, the refresh silently stops
        # updating the counts — so this is the test that has to exist.
        self.assertIsNotNone(rc.SENTENCE.search(rc.README.read_text()))

    def test_it_does_not_stop_at_the_decimal_point_in_a_byte_figure(self):
        # The first version was `Live counts: [^.]*\.`, which matched up to
        # "4." in "4.5 GB" and rewrote the README into a fragment plus the
        # tail of the old sentence — while reporting success.
        text = (
            "…page. Nothing is trained on. Live counts: 2,588 sites indexed, "
            "651,743 pages crawled, 12,332,710 chunks embedded, 4.5 GB of "
            "extracted text, 2,529 live chat endpoints, 249 pages for the "
            "median site.](docs/open-web-vectors/open-web-vectors.png)"
        )
        match = rc.SENTENCE.search(text)
        self.assertTrue(match.group(0).endswith("median site."))
        self.assertIn("4.5 GB", match.group(0))

    def test_a_rewrite_replaces_the_sentence_and_nothing_else(self):
        before = "Nothing is trained on. Live counts: a, b, 1 pages for the median site.](x.png)"
        match = rc.SENTENCE.search(before)
        after = before[: match.start()] + "Live counts: NEW." + before[match.end() :]
        self.assertEqual(after, "Nothing is trained on. Live counts: NEW.](x.png)")

    def test_the_pattern_is_not_greedy_across_two_sentences(self):
        # `.*` rather than `.*?` would swallow everything up to the LAST
        # "pages for the median site." in the file if the phrase ever recurs.
        doubled = (
            "Live counts: 1 pages for the median site. "
            "Elsewhere: 2 pages for the median site."
        )
        self.assertEqual(
            rc.SENTENCE.search(doubled).group(0),
            "Live counts: 1 pages for the median site.",
        )


class TheByteFormat(unittest.TestCase):
    """Binary divisor, decimal label — matches the live page exactly.

    The page quotes the same corpus on two of its own pages and must not give
    two different sizes, so the oddity is deliberate and copied, not a bug to
    tidy up here.
    """

    def test_it_divides_by_1024_and_labels_GB(self):
        self.assertEqual(rc.format_bytes(38_218_148_395), "36 GB")

    def test_it_keeps_one_decimal_below_ten_and_none_above(self):
        self.assertEqual(rc.format_bytes(4_831_838_208), "4.5 GB")
        self.assertEqual(rc.format_bytes(12_884_901_888), "12 GB")

    def test_bytes_are_never_given_a_decimal(self):
        self.assertEqual(rc.format_bytes(0), "0 B")
        self.assertEqual(rc.format_bytes(999), "999 B")

    def test_large_values_carry_a_thousands_separator(self):
        self.assertEqual(rc.format_bytes(1024**4 * 1500), "1,500 TB")


class TheMedian(unittest.TestCase):
    def test_odd_length_takes_the_middle(self):
        sites = [{"pageCount": n} for n in (5, 1, 9)]
        self.assertEqual(rc.median_pages(sites), 5)

    def test_even_length_rounds_half_UP_like_JavaScript(self):
        # Python's round() is banker's rounding: round(2.5) is 2, and
        # Math.round(2.5) is 3. Left alone this would show up as a permanent
        # one-page disagreement between the README and the page it screenshots.
        sites = [{"pageCount": n} for n in (2, 3)]
        self.assertEqual(rc.median_pages(sites), 3)

    def test_it_ignores_sites_with_no_page_count(self):
        sites = [{"pageCount": 4}, {"pageCount": None}, {}, {"pageCount": 6}]
        self.assertEqual(rc.median_pages(sites), 5)

    def test_an_empty_corpus_has_no_median(self):
        self.assertIsNone(rc.median_pages([]))


class TheSentenceItBuilds(unittest.TestCase):
    PAYLOAD = {
        "totalSites": 16934,
        "totalPages": 3826197,
        "totalChunks": 97622943,
        "totalBytes": 38218148395,
        "sites": [
            {"pageCount": 10, "releaseId": "a"},
            {"pageCount": 200, "releaseId": "b"},
            {"pageCount": 3000, "releaseId": None},
        ],
    }

    def test_every_figure_lands_in_the_sentence(self):
        self.assertEqual(
            rc.sentence_from(self.PAYLOAD),
            "Live counts: 16,934 sites indexed, 3,826,197 pages crawled, "
            "97,622,943 chunks embedded, 36 GB of extracted text, "
            "2 live chat endpoints, 200 pages for the median site.",
        )

    def test_what_it_writes_is_what_the_pattern_matches(self):
        # The generator and the matcher have to agree, or the first refresh
        # writes a sentence the second one can no longer find.
        built = rc.sentence_from(self.PAYLOAD)
        self.assertEqual(rc.SENTENCE.search(built).group(0), built)

    def test_endpoints_counts_only_sites_with_a_release(self):
        self.assertIn("2 live chat endpoints", rc.sentence_from(self.PAYLOAD))

    def test_it_refuses_rather_than_quote_a_corpus_it_could_not_read(self):
        # A truncated response would otherwise produce "0 live chat endpoints"
        # on a page whose entire claim is "measured, not projected".
        empty = dict(self.PAYLOAD, sites=[])
        with self.assertRaises(SystemExit):
            rc.sentence_from(empty)


class TheReadmeIsWhereItThinks(unittest.TestCase):
    def test_the_resolved_path_is_the_repo_README(self):
        self.assertTrue(rc.README.is_file())
        self.assertEqual(rc.README.name, "README.md")

    def test_the_committed_counts_parse_as_six_figures(self):
        quoted = rc.SENTENCE.search(rc.README.read_text()).group(0)
        for phrase in (
            "sites indexed",
            "pages crawled",
            "chunks embedded",
            "of extracted text",
            "live chat endpoints",
            "pages for the median site",
        ):
            self.assertIn(phrase, quoted)
        self.assertRegex(quoted, r"\d")


if __name__ == "__main__":
    unittest.main()
