/**
 * furniture-backfill.ts — put an existing corpus back onto the fixed
 * ingestion path, without re-running the demo pipeline.
 *
 * `jsonLdToMarkdown()` appended flattened JSON-LD to every scraped page, and
 * on a Yoast WordPress site that block outweighed the prose. Fixed at
 * ingestion (server-resources process-html.ts, 2026-08-14) — but the fix only
 * applies to pages scraped AFTER it deployed. 16 corpora were built before.
 *
 * The repair is `bulk-rescrape` with `forceRescrape`, which re-fetches every
 * page through the (now fixed) `fetchUrl` → `process-html` path and re-chunks
 * it. Measured on Acme Security's /about/: 2 chunks, both furniture, zero prose →
 * 9 prose chunks carrying the amenities, the location and the founder quote.
 *
 * Three things about this operation that are easy to get wrong:
 *
 *  1. It APPENDS chunks; it does not replace them. The stale furniture chunks
 *     survive. That is tolerable only because `dropBoilerplateChunks` filters
 *     them at retrieval — verified present in the deployed image before this
 *     was run. Without that filter this would need a purge first.
 *  2. A purge is not available anyway: removing a file from a vector that a
 *     published release is using returns "Can't update vector when used".
 *  3. `scraperTool` must be set to "fetch". It does NOT restrict the run to
 *     the plain-fetch path — Cloudflare Browser Rendering is still tried
 *     first — but it does exclude the FireCrawl strategies, which reuse a
 *     previous scrape's markdown and would apply none of the fix while still
 *     reporting success. Both remaining paths produce furniture-free content:
 *     the furniture was OUR emission, added by process-html, so a scraper
 *     that never calls it cannot reintroduce it.
 */

/** A file2 doc as returned by `divinci rag files`. */
export interface RagFileDoc {
  _id: string;
  title?: string;
}

/**
 * Web-page docs record their URL in the title as `URL: <url> <timestamp>`.
 * Non-web docs (uploads, transcripts) have no such prefix and must be left
 * out — bulk-rescrape only knows how to re-fetch a URL.
 */
export function extractPageUrls(files: RagFileDoc[]): string[] {
  const urls = new Set<string>();
  for (const f of files) {
    const m = /(?:^|\s)URL:\s+(https?:\/\/\S+)/.exec(f.title ?? "");
    if (m) urls.add(m[1]);
  }
  return [...urls].sort();
}

/** bulk-rescrape caps its `$in` match; sending more silently drops the tail. */
export const MAX_URLS_PER_REQUEST = 2000;

export interface RescrapeRequest {
  forceRescrape: true;
  scraperTool: "fetch";
  ragVectorIds: string[];
  urls: string[];
}

export function rescrapeRequest(vectorId: string, urls: string[]): RescrapeRequest {
  if (!vectorId) throw new Error("rescrapeRequest: vectorId is required");
  if (urls.length === 0) throw new Error("rescrapeRequest: refusing to send an empty URL list");
  if (urls.length > MAX_URLS_PER_REQUEST) {
    // Truncating here would look like a completed backfill. Make the caller
    // batch instead.
    throw new Error(
      `rescrapeRequest: ${urls.length} urls exceeds the server's ${MAX_URLS_PER_REQUEST} cap — batch the call`,
    );
  }
  return { forceRescrape: true, scraperTool: "fetch", ragVectorIds: [vectorId], urls };
}

export function rescrapePath(whitelabelId: string): string {
  return `/white-label/${whitelabelId}/rag-vector/html-page/bulk-rescrape`;
}

export interface BackfillTarget {
  prospect: string;
  whitelabelId: string;
  vectorId: string;
}

/**
 * Did the backfill actually change anything?
 *
 * The chunk count must GROW: a rescrape that fetched nothing, or that fell
 * through to a scraper we don't control, leaves the corpus byte-identical
 * while the endpoint still answers `{"success": true, "status": "started"}`.
 * Equal counts therefore mean "nothing happened", never "already clean" —
 * an already-clean corpus would not have been on the list.
 */
export function backfillLanded(chunksBefore: number, chunksAfter: number): boolean {
  return chunksAfter > chunksBefore;
}
