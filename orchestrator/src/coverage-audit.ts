/**
 * coverage-audit.ts — did we actually ingest the prospect's site?
 *
 * WHY THIS EXISTS. On 2026-08-15 an A/B on acmerenew.com found the shipped
 * demo corpus held **14 files covering 8 distinct URLs**, while the site's own
 * sitemap listed **29 pages**. `contact-us` had been ingested four times and
 * `privacy-terms` four times; the A2M page, the weight-loss program and eight
 * of nine symptom pages had never been ingested at all. The assistant answered
 * "A2M, or Anti-Aging and Wellness" — a flat invention — because it had never
 * seen the page that defines the term.
 *
 * Nothing in the pipeline noticed. `pagesCrawled` was 28, which looks healthy;
 * it counts pages the crawler VISITED, not distinct URLs that reached the
 * vector. `corpus-audit.ts` measures how much of the corpus is JSON-LD
 * furniture — corpus QUALITY — and is silent about corpus COMPLETENESS. The
 * ScoredQA suite is hazard-shaped: every test rewards REFUSING, so a corpus
 * missing two thirds of the site scores the same as a complete one (measured:
 * 84.3% vs 84.0%, indistinguishable).
 *
 * This audit is the cheap half of the fix: no model call, no judge, no tokens —
 * set arithmetic between the sitemap and the URLs actually in the vector. It
 * would have caught Acme Renew the day it shipped. The expensive half is
 * `coverage-suite.ts`, which asks whether what IS ingested can be recalled.
 *
 * ⚠️ A missing sitemap is NOT under-crawling. Report `no-sitemap` and let a
 * human look; a guard that reports 0% coverage because it could not find a
 * sitemap is the kind of false alarm that gets guards switched off.
 */

/** One URL ingested more than once — wasted spend and top-k redundancy. */
export interface DuplicateIngest { url: string; count: number }

export interface CoverageAudit {
  /** Distinct page URLs advertised by the site. Empty when there is no sitemap. */
  sitemapUrls: string[];
  /** Distinct page URLs that reached the vector. */
  ingestedUrls: string[];
  /** In the sitemap, never ingested. The list that explains a bad answer. */
  missing: string[];
  /** Ingested, but not in the sitemap (redirects, crawl-discovered pages). */
  extra: string[];
  duplicates: DuplicateIngest[];
  /** Total RAG files, including repeats of the same URL. */
  fileCount: number;
  /** distinct ingested ∩ sitemap / sitemap. NaN when there is no sitemap. */
  coverage: number;
  verdict: "ok" | "under-crawled" | "no-sitemap";
  /** One line fit for a run log or a review-board card. */
  summary: string;
}

/** Below this share of the sitemap, a corpus is under-crawled. */
export const DEFAULT_COVERAGE_THRESHOLD = 0.8;

/**
 * Below this share, Gate 2 HALTS the demo pending explicit sign-off.
 *
 * Deliberately lower than DEFAULT_COVERAGE_THRESHOLD: 80% is "tell me", 60% is
 * "stop". Agreed 2026-08-15 with no distribution to calibrate against — the
 * only datapoints are Acme Renew at 28% (shipped, and wrong in the ways this was
 * built to catch) and a rebuild at 100%. Revisit once a handful of real runs
 * have produced a spread; do not defend this number on the grounds that it is
 * written down.
 */
export const COVERAGE_HALT_THRESHOLD = 0.6;

/** True when the document is a <sitemapindex> pointing at child sitemaps. */
export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/** Every <loc> in a sitemap or sitemap index, in document order. */
export function parseSitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

/**
 * Canonical form for set comparison: lowercase scheme+host, no trailing slash,
 * no fragment, no query.
 *
 * Trailing slashes are the whole reason this exists — a sitemap that lists
 * `https://site.com/about` and a RAG title that records
 * `https://site.com/about/` are the same page, and comparing them raw reports a
 * missing page and an extra page for every URL on the site.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    const host = u.host.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol.toLowerCase()}//${host}${path}`;
  } catch {
    return trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Pull the source URL out of a RAG file title.
 *
 * The crawl connector titles files `URL: https://host/path 2026-8-14 12:55` —
 * the URL is followed by a timestamp, so a greedy match swallows it.
 */
export function extractUrlFromTitle(title: string): string | null {
  const m = /(?:^|\s)URL:\s*(\S+)/i.exec(title ?? "");
  if (m) return m[1];
  const bare = /(https?:\/\/\S+)/i.exec(title ?? "");
  return bare ? bare[1] : null;
}

export interface CoverageAuditInput {
  /** Raw <loc> values; pass [] when the site advertises no sitemap. */
  sitemapUrls: readonly string[];
  /** Titles of every RAG file in the vector under test. */
  fileTitles: readonly string[];
  threshold?: number;
}

/**
 * Compare what the site advertises against what reached the vector.
 *
 * Deliberately set arithmetic on URLs, not counts. A count comparison
 * ("28 crawled, 14 files — looks fine") is exactly what let Acme Renew through:
 * the duplicates made the total plausible while two thirds of the site was
 * absent.
 */
export function auditCoverage(input: CoverageAuditInput): CoverageAudit {
  const threshold = input.threshold ?? DEFAULT_COVERAGE_THRESHOLD;

  const sitemap = [...new Set(input.sitemapUrls.map(normalizeUrl).filter(Boolean))];

  const ingestedRaw = input.fileTitles
    .map(extractUrlFromTitle)
    .filter((u): u is string => !!u)
    .map(normalizeUrl)
    .filter(Boolean);

  const counts = new Map<string, number>();
  for (const u of ingestedRaw) counts.set(u, (counts.get(u) ?? 0) + 1);
  const ingested = [...counts.keys()];

  const sitemapSet = new Set(sitemap);
  const ingestedSet = new Set(ingested);

  const missing = sitemap.filter((u) => !ingestedSet.has(u));
  const extra = ingested.filter((u) => !sitemapSet.has(u));
  const duplicates = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count);

  const hit = sitemap.length - missing.length;
  const coverage = sitemap.length === 0 ? Number.NaN : hit / sitemap.length;

  const verdict: CoverageAudit["verdict"] =
    sitemap.length === 0 ? "no-sitemap" : coverage < threshold ? "under-crawled" : "ok";

  const dupNote = duplicates.length
    ? `, ${duplicates.length} url(s) ingested more than once (worst ×${duplicates[0].count})`
    : "";
  const summary =
    verdict === "no-sitemap"
      ? `coverage: NO SITEMAP found — ${ingested.length} distinct url(s) ingested across ` +
        `${input.fileTitles.length} file(s)${dupNote}. Completeness unverified.`
      : `coverage: ${hit}/${sitemap.length} sitemap url(s) ingested ` +
        `(${(coverage * 100).toFixed(0)}%)${dupNote}` +
        (verdict === "under-crawled" ? ` — UNDER-CRAWLED (threshold ${(threshold * 100).toFixed(0)}%)` : "");

  return {
    sitemapUrls: sitemap,
    ingestedUrls: ingested,
    missing,
    extra,
    duplicates,
    fileCount: input.fileTitles.length,
    coverage,
    verdict,
    summary,
  };
}

/**
 * Sitemap URLs declared by a robots.txt, in declaration order.
 *
 * Per RFC 9309 the directive is group-independent — it may appear anywhere in
 * the file, and a site may declare several. Matching is case-insensitive
 * because real files write `sitemap:`, `Sitemap:` and `SITEMAP:` alike.
 */
export function parseRobotsSitemaps(robotsTxt: string): string[] {
  return [...(robotsTxt ?? "").matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)].map((m) => m[1]);
}

/**
 * Resolve a site's sitemap to a flat URL list, following one level of
 * sitemap-index nesting.
 *
 * ⚠️ ASK robots.txt FIRST — the conventional filenames are a guess, and the
 * declaration is authoritative. probed.space (2026-08-16) serves 404 for
 * `/sitemap.xml`, `/sitemap_index.xml` and `/wp-sitemap.xml`, and declares
 * `Sitemap: https://probed.space/sitemap-index` — no `.xml`, non-standard
 * path. Guessing alone reported `no-sitemap` for a site with 2,863 URLs across
 * seven child sitemaps.
 *
 * That failure is quiet in the worst way: `no-sitemap` deliberately does NOT
 * halt Gate 2 (being unable to measure completeness is not evidence of
 * incompleteness), so an under-crawled demo would have shipped with its
 * coverage unmeasured rather than failing loudly.
 *
 * Best-effort by design: a site with no sitemap is a normal case, not an error,
 * and must not abort a run. Returns [] and lets `auditCoverage` report
 * `no-sitemap`.
 */
export async function fetchSitemapUrls(
  origin: string,
  fetchImpl: (url: string) => Promise<string | null> = defaultFetchText,
): Promise<string[]> {
  const base = origin.replace(/\/+$/, "");

  const robots = await fetchImpl(`${base}/robots.txt`);
  const declared = robots ? parseRobotsSitemaps(robots) : [];

  // Declared first, then the conventional guesses. Deduped so a site that
  // declares /sitemap.xml is not fetched twice.
  const candidates = [
    ...declared,
    `${base}/sitemap.xml`,
    `${base}/sitemap_index.xml`,
    `${base}/wp-sitemap.xml`,
  ].filter((url, i, all) => all.indexOf(url) === i);

  for (const candidate of candidates) {
    const xml = await fetchImpl(candidate);
    if (!xml || !/<(urlset|sitemapindex)[\s>]/i.test(xml)) continue;

    const locs = parseSitemapUrls(xml);
    if (!isSitemapIndex(xml)) return locs;

    // One level of nesting is enough for every sitemap shape we have met, and
    // bounds the request count on a hostile or misconfigured site.
    const out: string[] = [];
    for (const child of locs.slice(0, 25)) {
      const childXml = await fetchImpl(child);
      if (childXml) out.push(...parseSitemapUrls(childXml));
    }
    if (out.length) return out;
  }
  return [];
}

async function defaultFetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; DivinciDemoPipeline/1.0)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
