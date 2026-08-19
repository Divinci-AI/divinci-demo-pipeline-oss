// The public crawl-status feed.
//
// The bug this replaces: the status reporter was a child process of the LAPTOP
// daemon. Retiring the daemon killed the reporter, and divinci.ai/www-rag then
// told the public "Crawler offline" for two days while the Cloudflare pipeline
// was publishing normally (619 sites, most recent 17 minutes earlier).
//
// So these tests care about one thing above all: the feed must not be able to
// say something false about whether we are working.
import {
  eventKey, parseEventKey, buildSnapshot, EVENTS,
} from "../src/activity.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = 1_787_000_000_000;

// ── Key encoding: the whole payload rides in the key, so a single list() with
//    zero get()s reconstructs everything. If this round-trip breaks, the feed
//    silently reports zeros. ──────────────────────────────────────────────────
const rt = (e) => parseEventKey(eventKey(e));
eq(rt({ at: NOW, pages: 471, chunks: 12207, host: "scielo.br" }),
   { at: NOW, pages: 471, chunks: 12207, host: "scielo.br" },
   "round-trips an ordinary event");

eq(rt({ at: NOW, pages: 1, chunks: 0, host: "attic-old-website.staged.apache.org" }),
   { at: NOW, pages: 1, chunks: 0, host: "attic-old-website.staged.apache.org" },
   "round-trips a host with many dots and hyphens");

// host is LAST precisely so a separator inside it cannot shift the other fields
eq(rt({ at: NOW, pages: 2, chunks: 3, host: "we__ird.example.com" }),
   { at: NOW, pages: 2, chunks: 3, host: "we__ird.example.com" },
   "a separator INSIDE the host does not corrupt the numeric fields");

ok(parseEventKey("activity/events/garbage") === null, "rejects a malformed key rather than inventing values");
ok(parseEventKey("some/other/prefix") === null, "ignores keys outside the events prefix");
ok(eventKey({ at: NOW, pages: 1, chunks: 1, host: "x.com" }).startsWith(EVENTS), "keys carry the events prefix");

// ── State: the single most important claim on the page ──────────────────────
const ev = (agoMs, host, pages = 10, chunks = 100) => ({ at: NOW - agoMs, pages, chunks, host });

{
  // A slow site can produce zero publishes for an hour while 40 crawls run.
  // Reporting that as "idle" is the same lie the broken feed told, inverted —
  // and it is exactly what a directory-derived feed would get wrong, since the
  // directory only learns about a site once it PUBLISHES.
  const s = buildSnapshot({ events: [], pending: 2681, done: 1408, inflight: ["a.com", "b.com"], now: NOW });
  eq(s.state, "crawling", "claims crawling from CLAIMS HELD, not from recent publishes");
  eq(s.inFlight, ["a.com", "b.com"], "reports the in-flight hosts while crawling");
}

{
  const s = buildSnapshot({ events: [ev(1 * MIN, "x.com")], pending: 5, done: 5, inflight: [], now: NOW });
  eq(s.state, "idle", "idle when no claims are held, even with a fresh publish");
  eq(s.inFlight, [], "never reports in-flight hosts while idle — that set is meaningless then");
}

// ── The rolling 24h window ──────────────────────────────────────────────────
{
  const events = [
    ev(1 * HOUR, "fresh.com", 100, 1000),
    ev(23 * HOUR, "edge.com", 200, 2000),
    ev(25 * HOUR, "stale.com", 999, 9999),   // outside the window
  ];
  const s = buildSnapshot({ events, pending: 3, done: 7, inflight: ["z.com"], now: NOW });
  eq(s.sitesThisPass, 2, "counts only the last 24h");
  eq(s.pagesThisPass, 300, "sums pages over the window only");
  eq(s.chunksThisPass, 3000, "sums chunks over the window only");
  eq(s.recent.map((r) => r.host), ["fresh.com", "edge.com"], "recent is newest-first and window-bounded");
  eq(s.seeds, 3, "seeds is the pending frontier");
  eq(s.done, 7, "done is the tombstoned set");
}

{
  // A continuous crawler has no pass. Sending passStartedAt would put a
  // fabricated fact on a public page.
  const s = buildSnapshot({ events: [ev(MIN, "a.com")], pending: 1, done: 1, inflight: [], now: NOW });
  ok(!("passStartedAt" in s), "never claims a pass start — this pipeline has no passes");
}

{
  // An event dated in the future (clock skew on any writer) must not be
  // silently dropped by the `now - at <= DAY` test, nor inflate the window.
  const s = buildSnapshot({
    events: [{ at: NOW + 5 * MIN, pages: 1, chunks: 1, host: "skew.com" }],
    pending: 0, done: 0, inflight: [], now: NOW,
  });
  eq(s.sitesThisPass, 1, "a slightly future-dated event is still counted, not discarded");
}

{
  const events = Array.from({ length: 40 }, (_, i) => ev(i * MIN, `h${i}.com`));
  const inflight = Array.from({ length: 42 }, (_, i) => `f${i}.com`);
  const s = buildSnapshot({ events, pending: 1, done: 1, inflight, now: NOW });
  ok(s.recent.length === 12, "caps recent so the page is not handed 40 rows");
  ok(s.inFlight.length === 12, "caps in-flight — 42 live claims is real but unrenderable");
  eq(s.sitesThisPass, 40, "the CAP applies to display, never to the counts");
}

{
  // Malformed rows must not poison arithmetic into NaN, which would render as
  // an empty or broken card rather than an obvious failure.
  const s = buildSnapshot({
    events: [null, { at: NaN, pages: 1, chunks: 1, host: "b.com" }, ev(MIN, "good.com", 5, 50)],
    pending: 0, done: 0, inflight: [], now: NOW,
  });
  eq(s.sitesThisPass, 1, "drops unparseable events");
  eq(s.pagesThisPass, 5, "counts stay finite in the presence of junk");
}

// ── Future-dated events must not persist forever ────────────────────────────
// `now - at <= DAY` alone admits ANY future date, and pruneEvents drops only
// `now - at > retain` — so one clock-skewed or hand-written key would inflate
// the public counters permanently, with nothing ever removing it.
{
  const s = buildSnapshot({
    events: [{ at: NOW + 400 * DAY, pages: 9999, chunks: 99999, host: "skewed.example" }],
    pending: 0, done: 0, inflight: [], now: NOW,
  });
  eq(s.sitesThisPass, 0, "a far-future event is EXCLUDED, not counted forever");
  eq(s.pagesThisPass, 0, "and contributes nothing to the totals");
}
{
  // Real clock skew of a few minutes must still be tolerated, or a legitimate
  // publish vanishes from the feed.
  const s = buildSnapshot({
    events: [{ at: NOW + 5 * MIN, pages: 3, chunks: 30, host: "slightly-ahead.example" }],
    pending: 0, done: 0, inflight: [], now: NOW,
  });
  eq(s.sitesThisPass, 1, "a few minutes of clock skew is still counted");
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
