// A small, polite, same-host crawler.
//
// Deliberately plain `fetch` with no headless browser: this target's whole
// point is that it runs on a laptop with nothing installed but Node and Ollama.
// The trade is real and stated rather than hidden — a JS-rendered site yields
// little or nothing here. For those, use the Cloudflare target, which crawls
// through Browser Rendering.
//
// Politeness is not decoration. This reads somebody else's server.

import { URL } from "node:url";

export const DEFAULT_UA =
  "divinci-local-pipeline/0.1 (+https://github.com/Divinci-AI/divinci-demo-pipeline-oss; local crawler)";

/** Strip tags to text. Not a browser; good enough for prose and docs. */
export function htmlToText(html) {
  // Anything whose CONTENT is code or markup must go entirely, not just its
  // tags — otherwise a page's JS ends up embedded as if it were prose.
  return stripNonMarkup(html)
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    // Block-level tags become newlines so the chunker can see structure.
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    // Trim each LINE before collapsing blank runs. Tag removal leaves a space
    // where the opening tag was, so "<p>A</p><p>B</p>" becomes "A\n\n B" — the
    // block still splits, but every paragraph after the first carries a leading
    // space, and a whitespace-only line is not matched by /\n{3,}/ so runs of
    // empty blocks survive as separate empty paragraphs for the chunker to emit.
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? htmlToText(m[1]).slice(0, 200) : "";
}

/** Strip regions whose contents are code, not markup, before scanning them. */
export function stripNonMarkup(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/**
 * Same-host links only. Fragments and query strings are dropped.
 *
 * ⚠️ Two things here are not optional, and both were found by pointing this at
 * a real site that returned 124 anchors and yielded ZERO links:
 *
 *  1. UNQUOTED attribute values. Minified HTML emits `href=/blog/post/` with no
 *     quotes at all, and a pattern requiring `["']` matches none of it. This is
 *     ordinary minifier output, not an edge case — the crawler found exactly
 *     one page of every minified site and reported that as success.
 *  2. Scripts must be stripped FIRST. `<a` occurs constantly inside minified
 *     JS (`for(var b=0;b<a.length;b++)`), and matching there yields garbage
 *     URLs that cost a fetch each.
 */
export function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = new Set();
  // Double-quoted, single-quoted, or bare up to whitespace or `>`.
  const HREF = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (const m of stripNonMarkup(html).matchAll(HREF)) {
    const href = m[1] ?? m[2] ?? m[3];
    if (!href) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (u.host !== base.host) continue;
    // Non-document extensions cost a fetch and yield no text.
    if (/\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|css|js|ico|woff2?)$/i.test(u.pathname)) continue;
    u.hash = ""; u.search = "";
    out.add(u.toString());
  }
  return [...out];
}

/**
 * Parse robots.txt for the paths we may not touch.
 *
 * This is the ACCESS question (may I fetch this path?) and is separate from the
 * AI-rights question (may I index this site at all?), which the Cloudflare
 * target's `ai-rights.js` answers. Both matter; conflating them means answering
 * neither properly.
 */
export function parseDisallows(txt, ua = "*") {
  const lines = (txt || "").split("\n").map((l) => l.split("#")[0].trim());
  const groups = new Map();
  let current = [];
  for (const l of lines) {
    if (!l) { current = []; continue; }
    let m = /^user-agent\s*:\s*(.+)$/i.exec(l);
    if (m) { current = [m[1].trim().toLowerCase()]; for (const g of current) if (!groups.has(g)) groups.set(g, []); continue; }
    m = /^disallow\s*:\s*(.*)$/i.exec(l);
    if (m && current.length) for (const g of current) groups.get(g).push(m[1].trim());
  }

  // ⚠️ Match on the PRODUCT TOKEN, not the full User-Agent string.
  //
  // robots.txt groups name a token — `User-agent: divinci-local-pipeline` —
  // while the header we send is the whole string, version and contact URL
  // included. Looking the full string up in `groups` therefore never matched
  // anything, and every site silently fell through to the `*` rules.
  //
  // The direction of that failure is what makes it worth fixing rather than
  // noting: a site giving THIS crawler a stricter group than `*` would have
  // had its stricter rules ignored.
  //
  // The first test written for this passed the token directly, so it exercised
  // a path the real caller never took and proved the wrong thing.
  const full = String(ua).toLowerCase();
  const token = full.split("/")[0].split(/\s/)[0];
  return groups.get(full) ?? groups.get(token) ?? groups.get("*") ?? [];
}

export const isAllowed = (pathname, disallows) =>
  !disallows.some((d) => d && d !== "" && pathname.startsWith(d));

/**
 * Crawl a host breadth-first.
 *
 * @param {object} opts
 * @param {number} opts.limit     hard page cap — the budget, always enforced
 * @param {number} opts.delayMs   pause between requests (politeness)
 */
export async function crawlSite(startUrl, {
  limit = 100, delayMs = 500, userAgent = DEFAULT_UA, onPage, fetchImpl = fetch,
} = {}) {
  const start = new URL(startUrl);
  const headers = { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml" };

  let disallows = [];
  try {
    const r = await fetchImpl(`${start.origin}/robots.txt`, { headers, signal: AbortSignal.timeout(15_000) });
    if (r.ok) disallows = parseDisallows(await r.text(), userAgent);
  } catch { /* no robots.txt is a real answer: nothing is disallowed */ }

  const queue = [start.toString()];
  const seen = new Set(queue);
  const pages = [];
  const skipped = { disallowed: 0, failed: 0, empty: 0 };

  while (queue.length && pages.length < limit) {
    const url = queue.shift();
    const u = new URL(url);
    if (!isAllowed(u.pathname, disallows)) { skipped.disallowed++; continue; }

    let res, html;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000), redirect: "follow" });
      if (!res.ok) { skipped.failed++; continue; }
      if (!/text\/html/i.test(res.headers.get("content-type") ?? "")) { skipped.failed++; continue; }
      html = await res.text();
    } catch { skipped.failed++; continue; }

    const text = htmlToText(html);
    if (text.length < 200) skipped.empty++;
    else {
      pages.push({ url, title: extractTitle(html), text });
      onPage?.({ url, chars: text.length, found: pages.length, limit });
    }

    for (const link of extractLinks(html, url)) {
      if (seen.size >= limit * 8) break;   // bound the frontier, not just the crawl
      if (!seen.has(link)) { seen.add(link); queue.push(link); }
    }

    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { pages, skipped, discovered: seen.size };
}
