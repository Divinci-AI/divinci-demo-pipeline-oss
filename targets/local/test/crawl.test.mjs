// The crawler, and the two bugs that shipped in its first draft. Both were
// found by pointing it at ONE real site, and both reported success while
// producing nothing usable — which is why they are pinned here.
import { extractLinks, htmlToText, parseDisallows, isAllowed, stripNonMarkup, extractTitle } from "../src/crawl.mjs";

let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  ❌ " + m); fail++; } else console.log("  ✅ " + m); };

// ── BUG 1: unquoted attribute values ────────────────────────────────────────
// Minified HTML emits `href=/a/` with no quotes. A pattern requiring ["'] found
// ZERO links in 124 anchors, so the crawler indexed exactly one page of every
// minified site and called it done.
{
  const l = extractLinks(`<a href=/blog/post/>x</a>`, "https://ex.test");
  ok(l.includes("https://ex.test/blog/post/"), "an UNQUOTED href is extracted");
}
{
  const l = extractLinks(`<a href="/a/">1</a><a href='/b/'>2</a><a href=/c/>3</a>`, "https://ex.test");
  ok(l.length === 3, "double-quoted, single-quoted and bare hrefs are all extracted");
}
{
  const l = extractLinks(`<a class=x href=/a/ rel=noopener>x</a>`, "https://ex.test");
  ok(l.includes("https://ex.test/a/"), "a bare href surrounded by other bare attributes is extracted");
}

// ── BUG 2: <a matches inside minified JavaScript ────────────────────────────
{
  const html = `<script>for(var b=0;b<a.length;b++){}</script><a href=/real/>r</a>`;
  const l = extractLinks(html, "https://ex.test");
  ok(l.length === 1 && l[0] === "https://ex.test/real/",
     "script contents are stripped before scanning — `b<a.length` is not a link");
}
{
  ok(!/nope/.test(stripNonMarkup(`<style>.a{content:"nope"}</style>`)), "style contents are stripped too");
  ok(!/nope/.test(stripNonMarkup(`<!-- nope -->`)), "comments are stripped too");
}

// ── link scoping ────────────────────────────────────────────────────────────
{
  const l = extractLinks(`<a href="https://other.test/x">o</a><a href="/y">y</a>`, "https://ex.test");
  ok(l.length === 1 && l[0].includes("ex.test"), "off-host links are dropped");
}
{
  const l = extractLinks(`<a href="/a#frag">a</a><a href="/a?q=1">b</a>`, "https://ex.test");
  ok(l.length === 1, "fragment and query variants collapse to one URL");
}
{
  const l = extractLinks(`<a href="/f.pdf">p</a><a href="/i.png">i</a><a href="/ok">o</a>`, "https://ex.test");
  ok(l.length === 1 && l[0].endsWith("/ok"), "non-document extensions are skipped");
}
{
  const l = extractLinks(`<a href="mailto:a@b.test">m</a><a href="javascript:void(0)">j</a>`, "https://ex.test");
  ok(l.length === 0, "non-http schemes are dropped");
}

// ── text extraction ─────────────────────────────────────────────────────────
{
  const t = htmlToText(`<script>var x="secret"</script><p>Hello</p>`);
  ok(!t.includes("secret"), "script source never becomes indexed text");
  ok(t.includes("Hello"), "…while real prose survives");
}
{
  const t = htmlToText(`<p>A</p><p>B</p>`);
  ok(/A\n\nB/.test(t), "block tags become paragraph breaks the chunker can see");
}
{
  ok(htmlToText(`<p>a &amp; b &lt;c&gt;</p>`).includes("a & b <c>"), "entities are decoded");
}
{
  ok(extractTitle(`<title>My Page</title>`) === "My Page", "the title is extracted");
}

// ── robots.txt: the ACCESS question ─────────────────────────────────────────
{
  const d = parseDisallows("User-agent: *\nDisallow: /admin\nDisallow: /private");
  ok(d.length === 2, "wildcard disallows are read");
  ok(!isAllowed("/admin/x", d), "a disallowed prefix blocks");
  ok(isAllowed("/public/x", d), "everything else is allowed");
}
{
  // A group naming us specifically must win over the wildcard.
  const txt = "User-agent: *\nDisallow: /\n\nUser-agent: divinci-local-pipeline/0.1\nDisallow: /admin";
  const d = parseDisallows(txt, "divinci-local-pipeline/0.1");
  ok(isAllowed("/docs", d), "a group naming this crawler overrides the wildcard");
  ok(!isAllowed("/admin", d), "…and its own rules still apply");
}
{
  ok(isAllowed("/anything", parseDisallows("")), "no robots.txt disallows nothing");
  // `Disallow:` with an EMPTY value means "allow everything" in the standard.
  ok(isAllowed("/x", parseDisallows("User-agent: *\nDisallow:")), "an empty Disallow allows everything");
}

console.log();
if (fail) { console.log(`❌ ${fail} crawl assertion(s) failed`); process.exit(1); }
console.log("✅ crawler: all assertions passed");
