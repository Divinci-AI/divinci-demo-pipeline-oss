// The frontier's two load-bearing pure functions. Everything else in the
// scheduler is R2 bookkeeping; these are where a bug silently changes WHAT the
// fleet crawls, which is the expensive kind.
import { extractHosts, isPlausibleHost, isStale, isJunkHost } from "../src/frontier.js";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)})`}`);

// ── Self-exclusion: the crawl already includes subdomains ───────────────────
eq(extractHosts("[a](https://sub.self.com/x) [b](https://self.com/y) [c](https://other.org/z)", "self.com"),
   ["other.org"], "excludes self and its subdomains");
eq(extractHosts("[a](https://docs.self.com/x) [b](https://other.org/z)", "www.self.com"),
   ["other.org"], "self-exclusion ignores a www. prefix on the crawled host");

// ── Ranking: link frequency is the relevance prior ──────────────────────────
eq(extractHosts("https://a.com/1 https://b.com/1 https://a.com/2 https://a.com/3", "s.com", { max: 2 }),
   ["a.com", "b.com"], "ranks by inbound link count");
ok(extractHosts("https://a.com/1 https://b.com/2 https://c.com/3", "s.com", { max: 2 }).length === 2,
   "respects the max cap");

// ── Junk that must never cost us a crawl ────────────────────────────────────
eq(extractHosts("https://1.2.3.4/x https://localhost/y https://ok.com/z", "s.com"),
   ["ok.com"], "drops bare IPs and localhost");
eq(extractHosts("https://user:pw@real.com/x", "s.com"), ["real.com"], "strips credentials");
eq(extractHosts("https://real.com:8443/x", "s.com"), ["real.com"], "strips a port");
eq(extractHosts("https://real.com./x", "s.com"), ["real.com"], "strips a trailing root dot");

ok(!isPlausibleHost("a.local") && !isPlausibleHost("x.test") && !isPlausibleHost("y.invalid"),
   "rejects reserved TLDs");
ok(!isPlausibleHost("nodots") && !isPlausibleHost("a..b.com") && !isPlausibleHost("-bad.com"),
   "rejects malformed hosts");
ok(!isPlausibleHost("EXAMPLE.COM".toLowerCase().replace("example.com", "a.1")), "rejects numeric TLD");
ok(isPlausibleHost("docs.nodejs.org") && isPlausibleHost("a-b.co.uk"), "accepts real hosts");

// ── Markdown link syntax must not leak into the hostname ────────────────────
eq(extractHosts("see [the docs](https://docs.example.org/a/b) here", "s.com"),
   ["docs.example.org"], "markdown link parens do not become part of the host");
eq(extractHosts("<https://auto.example.org/x>", "s.com"),
   ["auto.example.org"], "angle-bracket autolinks parse");

// ── Claim reaping ───────────────────────────────────────────────────────────
const NOW = 1_000_000_000;
ok(isStale({ at: NOW - 100 }, NOW, 50), "a claim past its TTL is stale");
ok(!isStale({ at: NOW - 10 }, NOW, 50), "a fresh claim is not stale");
ok(isStale(null, NOW, 50), "an unreadable claim is stale — never leak a slot on a corrupt record");
ok(isStale({}, NOW, 50), "a claim with no timestamp is stale");


// ── Junk hosts: structurally incapable of yielding a corpus ─────────────────
// Each one that slips through costs a workflow instance and real browser
// seconds, so this is a credit-efficiency guard, not tidiness.
const junk = isJunkHost;
ok(junk("bit.ly") && junk("t.co") && junk("youtu.be"), "shorteners are junk");
ok(junk("discord.gg") && junk("t.me"), "share/invite endpoints are junk");
ok(!junk("apps.apple.com") && !junk("play.google.com"),
   "app stores are NOT junk — apps.apple.com measured 7,012 B/page, above the median");
ok(junk("cdn.rcsb.org") && junk("download.mozilla.org") && junk("donate.wikimedia.org"),
   "functional subdomains are junk");
ok(!junk("archive.org") && !junk("docs.nodejs.org") && !junk("en.wikivoyage.org"),
   "real sites are NOT junk");
ok(!junk("cdnjs.example.org"), "prefix match requires the dot — cdnjs is not cdn.");
eq(extractHosts("[a](https://bit.ly/x) [b](https://real.org/y)", "s.com"),
   ["real.org"], "extractHosts drops junk before it reaches the frontier");
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
