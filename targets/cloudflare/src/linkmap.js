/**
 * The outbound link graph, captured where it is already computed.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The Universe map's hyperlink layer covered 28 of 1,486 sites (1.9%) and was
 * never going to grow, because it is materialized from `RagVectorHTMLPage`
 * documents in Mongo and this pipeline publishes straight to Turso, writing no
 * page documents at all. The layer was not stalled; it was structurally blind
 * to the entire modern corpus.
 *
 * Meanwhile `extractHosts` counts every outbound host on every crawled page,
 * once per crawl, to rank frontier candidates — and then drops the counts.
 * Measured on three sites, the discarded graph held 4, 5 and 13 in-corpus
 * targets each, against 0 shown. This captures that byproduct.
 *
 * ── Two decisions worth not re-litigating ───────────────────────────────────
 * 1. WRITTEN TO R2, NOT PUSHED TO THE REGISTRY. The registry is reachable only
 *    through an HMAC fleet webhook, and that webhook is exactly where a
 *    privilege escalation lived. Giving it a "write arbitrary graph edges" verb
 *    so a visualization can be prettier is not a trade worth making. A local
 *    materializer reads these objects; the crawler gains no new authority.
 *
 * 2. NOT FILTERED TO THE CORPUS HERE. Only in-corpus edges are ever displayed,
 *    but the crawler does not know the corpus and should not have to: a target
 *    that is off-corpus today is in-corpus the moment it gets crawled, and a
 *    filter applied at write time would silently discard the edge forever. The
 *    intersection is a render-time concern and belongs to the materializer.
 */

/**
 * Count outbound links across a crawled bundle.
 *
 * Shared by the crawl-time path and the R2 backfill ON PURPOSE. Two
 * implementations of "what does this site link to" would drift, and the drift
 * would be invisible: both produce a plausible number, and nothing compares
 * them. One function means a backfilled map and a freshly-crawled one are the
 * same artifact.
 *
 * @returns {{seen: Map<string,number>, linkTotals: Map<string,number>}}
 *   seen       target -> how many pages link to it
 *   linkTotals target -> total link occurrences
 */
export function countOutbound(pages, selfHost, extract, opts = {}) {
  const perPageMax = opts.perPageMax ?? 120;
  const seen = new Map();
  const linkTotals = new Map();
  for (const pg of pages) {
    for (const [h, n] of extract(pg?.markdown || "", selfHost, { max: perPageMax, withCounts: true })) {
      seen.set(h, (seen.get(h) ?? 0) + 1);
      linkTotals.set(h, (linkTotals.get(h) ?? 0) + n);
    }
  }
  return { seen, linkTotals };
}

/** Per-site artifact, beside raw.json and chunks.json so withdrawal reaps it. */
export const linkMapKey = (slug) => `sites/${slug}/links.json`;

/** Bumped when the shape changes, so a reader can refuse what it cannot parse. */
export const LINK_MAP_VERSION = 1;

/**
 * Cap on distinct targets recorded per site.
 *
 * A link farm or a docs site with a giant footer can point at thousands of
 * hosts; keeping all of them would make this object unbounded for no gain,
 * since the tail is footer noise ranked below everything useful. `truncated`
 * and `targets` are recorded so a reader can tell a capped map from a complete
 * one — a silent cap is how a measurement turns into a guess.
 */
export const MAX_TARGETS = 1000;

/**
 * @param seen        Map<target, number of OUR pages linking to it>
 * @param linkTotals  Map<target, total link occurrences across those pages>
 *
 * `pagesLinking` leads the sort because it is the more robust weight: one page
 * with a navigation block repeating a link forty times should not outrank forty
 * pages that each reference it once.
 */
export function buildLinkMap(host, pagesScanned, seen, linkTotals, opts = {}) {
  const max = opts.maxTargets ?? MAX_TARGETS;
  const now = opts.now ?? Date.now();
  const outbound = [...seen.entries()]
    .sort((a, b) => (b[1] - a[1]) || ((linkTotals.get(b[0]) ?? 0) - (linkTotals.get(a[0]) ?? 0)) || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([target, pagesLinking]) => [target, pagesLinking, linkTotals.get(target) ?? 0]);
  return {
    v: LINK_MAP_VERSION,
    host,
    pagesScanned,
    targets: seen.size,
    truncated: seen.size > max,
    outbound,
    at: now,
  };
}

/**
 * Never throws and never returns a rejected promise.
 *
 * This runs inside the `expand-frontier` step, which sits AFTER a successful
 * publish. A throw here would fail a workflow step whose work is already done
 * and — worse — retry it, re-seeding the frontier. A visualization's data is
 * not worth risking a publish over, so the failure is reported, not raised.
 */
export async function writeLinkMap(env, slug, host, pagesScanned, seen, linkTotals, opts = {}) {
  try {
    const map = buildLinkMap(host, pagesScanned, seen, linkTotals, opts);
    await env.BUCKET.put(linkMapKey(slug), JSON.stringify(map));
    return { ok: true, targets: map.targets, recorded: map.outbound.length, truncated: map.truncated };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
}
